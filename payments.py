"""Payments: Stripe Checkout with Stripe Connect, so every sale splits automatically.

How the money moves
    The customer pays the menu price on Stripe's page (cards, Apple Pay, Google Pay).
    The charge is a destination charge to the bakery's connected Stripe account, with an
    application fee of PLATFORM_FEE_PCT (default 5%) that Stripe routes to the platform account
    (the account that owns STRIPE_SECRET_KEY). The customer only ever sees the cake total;
    the bakery's admin shows the fee on every sale in the Payments tab.

    Deposits and balances are separate charges, each with its own 5% fee. Payments the bakery
    takes in person (cash, card at the counter) are recorded in the admin with the 5% marked as
    owed rather than collected, so the report covers all sales.

    Until the bakery finishes Stripe onboarding, charges land in the platform account and the
    report shows the 95% as owed to the bakery.

Environment variables
    STRIPE_SECRET_KEY        sk_live_... / sk_test_...   (the platform account: yours)
    STRIPE_WEBHOOK_SECRET    whsec_... for https://YOUR-DOMAIN/stripe/webhook
                             events: checkout.session.completed,
                                     checkout.session.async_payment_succeeded,
                                     checkout.session.expired
    PLATFORM_FEE_PCT         default 5
    STRIPE_CONNECT_ACCOUNT   optional acct_... to use an existing connected account
"""
import hashlib
import hmac
import os
import time

import requests

import catalog
import schedule
import store

API = "https://api.stripe.com/v1"
BUSINESS = os.environ.get("BUSINESS_NAME", "LeCreme Bakery")


def enabled():
    return bool(_key())


def _key():
    return os.environ.get("STRIPE_SECRET_KEY", "").strip()


def test_mode():
    return _key().startswith("sk_test_")


def fee_pct():
    try:
        return min(max(float(os.environ.get("PLATFORM_FEE_PCT", "5")), 0.0), 30.0)
    except ValueError:
        return 5.0


def fee_for(cents):
    return int(round(cents * fee_pct() / 100))


def connect_account():
    return os.environ.get("STRIPE_CONNECT_ACCOUNT", "").strip() or store.setting("connect_account")


def connect_ready():
    return bool(connect_account()) and store.setting("connect_ready") == "1"


def _stripe(method, path, data=None):
    try:
        r = requests.request(method, API + path, data=data, auth=(_key(), ""), timeout=20)
        body = r.json()
    except Exception as e:  # network or bad JSON
        return None, f"Couldn't reach Stripe ({e.__class__.__name__})."
    if r.status_code >= 400:
        return None, (body.get("error") or {}).get("message", f"Stripe said {r.status_code}.")
    return body, ""


# ---------------------------------------------------------------- order money
def payments_for(order_id):
    conn = store.db()
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM payments WHERE order_id = ? ORDER BY id", (order_id,))]
    finally:
        conn.close()


def paid_cents(order_id):
    return sum(p["amount_cents"] for p in payments_for(order_id) if p["status"] == "paid")


def balance_due(order):
    return max(order["total_cents"] - paid_cents(order["id"]), 0)


def deposit_paid(order_id):
    return any(p["status"] == "paid" and p["kind"] == "deposit" for p in payments_for(order_id))


# ------------------------------------------------------------------- checkout
def create_checkout(order, kind, base_url):
    """Start a Checkout session for the deposit or the balance. Returns (url, error)."""
    if not enabled():
        return None, "Online payment isn't switched on yet. Please call us to finish your order."
    if kind == "deposit":
        amount = order["deposit_cents"]
    else:
        amount = balance_due(order)
    if amount < 50:
        return None, "There's nothing left to pay on this order."
    head = catalog.describe(order["design"])[0]
    when = schedule.label(order["pickup_date"], long=False)
    item = f"{BUSINESS}: {head}, pickup {when}"
    item += " (deposit)" if kind == "deposit" else " (balance)"
    track = f"{base_url}/order/{order['token']}"
    fee = fee_for(amount)
    data = {
        "mode": "payment",
        "success_url": f"{track}?paid={kind}",
        "cancel_url": f"{track}?canceled={kind}",
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": str(amount),
        "line_items[0][price_data][product_data][name]": item[:250],
        "client_reference_id": str(order["id"]),
        "metadata[order_id]": str(order["id"]),
        "metadata[kind]": kind,
        "payment_intent_data[description]": f"Order #{order['id']} {kind}",
        "payment_intent_data[metadata][order_id]": str(order["id"]),
        "payment_intent_data[metadata][kind]": kind,
    }
    if kind == "deposit":
        data["expires_at"] = str(int(time.time()) + 31 * 60)
    if order.get("email"):
        data["customer_email"] = order["email"]
    acct = connect_account()
    destination = ""
    if acct and connect_ready():
        destination = acct
        data["payment_intent_data[application_fee_amount]"] = str(fee)
        data["payment_intent_data[transfer_data][destination]"] = acct
        data["payment_intent_data[on_behalf_of]"] = acct
    body, err = _stripe("POST", "/checkout/sessions", data)
    if err or not body.get("url"):
        return None, "We couldn't open the payment page. Please try again in a moment."
    conn = store.db()
    try:
        with conn:
            conn.execute("INSERT INTO payments (order_id, kind, amount_cents, fee_cents, method, status, session_id, destination, created_at) "
                         "VALUES (?,?,?,?,?,?,?,?,?)",
                         (order["id"], kind, amount, fee, "card", "pending", body["id"], destination, store.now_iso()))
    finally:
        conn.close()
    return body["url"], ""


def _apply_session(s):
    """Record a paid session once. Returns (order_id, kind) if newly recorded."""
    if s.get("payment_status") != "paid":
        return None
    sid = s.get("id", "")
    conn = store.db()
    try:
        with conn:
            row = conn.execute("SELECT * FROM payments WHERE session_id = ?", (sid,)).fetchone()
            if not row or row["status"] == "paid":
                return None
            paid = int(s.get("amount_total") or 0)
            if paid != row["amount_cents"]:
                store.add_event(row["order_id"], "note", f"Stripe session {sid} paid ${paid / 100:,.2f}, expected "
                                f"${row['amount_cents'] / 100:,.2f}. Check Stripe.", public=False, conn=conn)
                return None
            conn.execute("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ?", (store.now_iso(), row["id"]))
            # A paid deposit any newer than an older pending checkout supersedes it.
            conn.execute("UPDATE payments SET status = 'void' WHERE order_id = ? AND kind = ? AND status = 'pending'",
                         (row["order_id"], row["kind"]))
            order = conn.execute("SELECT status FROM orders WHERE id = ?", (row["order_id"],)).fetchone()
            if row["kind"] == "deposit":
                if order["status"] in ("pending", "expired"):
                    if order["status"] == "expired":
                        store.add_event(row["order_id"], "note", "Deposit arrived after the hold ran out. Check the day's capacity.",
                                        public=False, conn=conn)
                    conn.execute("UPDATE orders SET status = 'confirmed', hold_until = '' WHERE id = ?", (row["order_id"],))
                store.add_event(row["order_id"], "confirmed",
                                f"Deposit of ${paid / 100:,.2f} received. Your date is locked in.", conn=conn)
            else:
                store.add_event(row["order_id"], "payment", f"Balance of ${paid / 100:,.2f} received. You're all paid up.", conn=conn)
            return row["order_id"], row["kind"]
    finally:
        conn.close()


def confirm_pending(order):
    """When the customer lands back from Stripe, ask Stripe directly instead of waiting for the webhook."""
    if not enabled():
        return None
    for p in reversed(payments_for(order["id"])):
        if p["status"] == "pending" and p["session_id"]:
            s, err = _stripe("GET", f"/checkout/sessions/{p['session_id']}")
            if s:
                res = _apply_session(s)
                if res:
                    return res
    return None


def _expire_session(s):
    conn = store.db()
    try:
        with conn:
            row = conn.execute("SELECT * FROM payments WHERE session_id = ? AND status = 'pending'", (s.get("id", ""),)).fetchone()
            if not row:
                return
            conn.execute("UPDATE payments SET status = 'expired' WHERE id = ?", (row["id"],))
            if row["kind"] == "deposit":
                conn.execute("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'", (row["order_id"],))
    finally:
        conn.close()


def verify_webhook(payload, header, tolerance=300):
    secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "").strip()
    if not secret or not header:
        return False
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    sigs = [p.split("=", 1)[1] for p in header.split(",") if p.startswith("v1=")]
    try:
        ts = int(parts.get("t", "0"))
    except ValueError:
        return False
    if abs(time.time() - ts) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{ts}.".encode() + payload, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, s) for s in sigs)


def handle_event(event):
    t = event.get("type")
    obj = (event.get("data") or {}).get("object") or {}
    if t in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
        return _apply_session(obj)
    if t == "checkout.session.expired":
        _expire_session(obj)
    return None


# ----------------------------------------------------------- in-person payments
def record_in_person(order, amount_cents, method):
    """The bakery took money at the counter. 5% is noted as owed to the platform."""
    conn = store.db()
    try:
        with conn:
            conn.execute("INSERT INTO payments (order_id, kind, amount_cents, fee_cents, method, status, created_at, paid_at) "
                         "VALUES (?,?,?,?,?,?,?,?)",
                         (order["id"], "in_person", amount_cents, fee_for(amount_cents), method, "paid", store.now_iso(), store.now_iso()))
            if order["status"] in ("pending", "expired"):
                conn.execute("UPDATE orders SET status = 'confirmed', hold_until = '' WHERE id = ?", (order["id"],))
            store.add_event(order["id"], "payment", f"${amount_cents / 100:,.2f} paid in person. Thank you!", conn=conn)
    finally:
        conn.close()


# --------------------------------------------------------------------- report
def report(month=None):
    """Every paid payment with its fee split, newest first, plus totals."""
    conn = store.db()
    try:
        q = ("SELECT p.*, o.name, o.token, o.pickup_date FROM payments p JOIN orders o ON o.id = p.order_id "
             "WHERE p.status = 'paid'")
        args = ()
        if month:
            q += " AND substr(p.paid_at, 1, 7) = ?"
            args = (month,)
        rows = [dict(r) for r in conn.execute(q + " ORDER BY p.paid_at DESC, p.id DESC", args)]
        months = [r[0] for r in conn.execute(
            "SELECT DISTINCT substr(paid_at, 1, 7) FROM payments WHERE status = 'paid' ORDER BY 1 DESC")]
    finally:
        conn.close()
    t = {"gross": 0, "fee": 0, "fee_collected": 0, "fee_owed": 0, "net": 0, "owed_to_bakery": 0}
    for r in rows:
        if r["kind"] == "in_person":
            r["route"] = "In person"
            t["fee_owed"] += r["fee_cents"]
        elif r["destination"]:
            r["route"] = "Stripe, split automatically"
            t["fee_collected"] += r["fee_cents"]
        else:
            r["route"] = "Stripe, before payouts were connected"
            t["fee_collected"] += r["fee_cents"]
            t["owed_to_bakery"] += r["amount_cents"] - r["fee_cents"]
        r["net_cents"] = r["amount_cents"] - r["fee_cents"]
        t["gross"] += r["amount_cents"]
        t["fee"] += r["fee_cents"]
        t["net"] += r["net_cents"]
    return {"rows": rows, "totals": t, "months": months, "pct": fee_pct()}


# ----------------------------------------------------------- Connect onboarding
def start_onboarding(base_url):
    """Create the bakery's Express account if needed and return a Stripe onboarding link."""
    if not enabled():
        return None, "Add STRIPE_SECRET_KEY on Railway first."
    acct = connect_account()
    if not acct:
        body, err = _stripe("POST", "/accounts", {
            "type": "express", "country": "US",
            "capabilities[card_payments][requested]": "true",
            "capabilities[transfers][requested]": "true",
            "business_profile[name]": BUSINESS,
            "business_profile[mcc]": "5462",          # bakeries
            "business_profile[url]": base_url,
        })
        if err:
            return None, err
        acct = body["id"]
        store.set_setting("connect_account", acct)
    body, err = _stripe("POST", "/account_links", {
        "account": acct, "type": "account_onboarding",
        "refresh_url": f"{base_url}/admin/stripe/connect",
        "return_url": f"{base_url}/admin/stripe/return",
    })
    if err:
        return None, err
    return body["url"], ""


def refresh_connect():
    """Ask Stripe whether the bakery can take charges yet. Returns a status dict."""
    acct = connect_account()
    st = {"account": acct, "charges": False, "payouts": False, "details": False, "error": ""}
    if not acct or not enabled():
        return st
    body, err = _stripe("GET", f"/accounts/{acct}")
    if err:
        st["error"] = err
        return st
    st.update(charges=bool(body.get("charges_enabled")), payouts=bool(body.get("payouts_enabled")),
              details=bool(body.get("details_submitted")))
    store.set_setting("connect_ready", "1" if st["charges"] else "0")
    return st


def dashboard_link():
    acct = connect_account()
    if not acct:
        return None, "Connect Stripe first."
    body, err = _stripe("POST", f"/accounts/{acct}/login_links")
    return (body or {}).get("url"), err
