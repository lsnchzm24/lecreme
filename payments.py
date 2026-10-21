"""Payments: Stripe Checkout with Stripe Connect, so every sale splits automatically.

Who is who
    Platform account   Yours. Its secret key is STRIPE_SECRET_KEY on Railway. It runs the checkout
                       and receives the platform fee.
    Bakery account     A Stripe Express account the bakery creates from Admin > Payments >
                       "Connect payouts with Stripe". The bakery never handles API keys.

How each payment splits (destination charge with on_behalf_of)
    The bakery is the merchant of record: Stripe Checkout shows the bakery's name and branding,
    and the customer's card statement shows the bakery's statement descriptor.

        platform fee  =  PLATFORM_FEE_PCT (5%) of the payment  +  Stripe's real processing fee
        bakery gets   =  payment  -  platform fee

    Stripe charges its processing fee to the platform, so the fee passed through here makes the
    platform whole and leaves exactly 5% with the platform.

    Stripe's real fee is only known after the charge (international cards, for example, cost
    more), so checkout starts with an estimate (STRIPE_PCT + STRIPE_FIXED_CENTS, the standard
    US card rate) and settle() corrects it to the exact fee right after payment:
        estimate too high  ->  the difference goes back to the bakery (application fee refund)
        estimate too low   ->  the difference comes back from the bakery (transfer reversal)

    Deposits and balances are separate charges, each split the same way. Payments taken in person
    have no Stripe fee; 5% is recorded as owed to the platform so the report covers every sale.
    Until the bakery finishes Stripe onboarding, charges land in the platform account and the
    report shows what is owed to the bakery.

Environment variables
    STRIPE_SECRET_KEY        sk_live_... / sk_test_...   (the platform account: yours)
    STRIPE_WEBHOOK_SECRET    whsec_... for https://YOUR-DOMAIN/stripe/webhook
                             events: checkout.session.completed,
                                     checkout.session.async_payment_succeeded,
                                     checkout.session.expired
    PLATFORM_FEE_PCT         default 5
    STRIPE_PCT               default 2.9   (only for the first estimate)
    STRIPE_FIXED_CENTS       default 30    (only for the first estimate)
    STRIPE_CONNECT_ACCOUNT   optional acct_... to use an existing connected account
"""
import hashlib
import hmac
import logging
import os
import time
from pathlib import Path

import requests

import catalog
import schedule
import store
from i18n import _

log = logging.getLogger("payments")
API = "https://api.stripe.com/v1"
BUSINESS = os.environ.get("BUSINESS_NAME", "LeCreme Bakery")
DESCRIPTOR = os.environ.get("STATEMENT_DESCRIPTOR", "LECREME BAKERY")[:22]
ICON = Path(__file__).resolve().parent / "static" / "img" / "icon.png"


def enabled():
    return bool(_key())


def _key():
    return os.environ.get("STRIPE_SECRET_KEY", "").strip()


def test_mode():
    return _key().startswith("sk_test_")


def _num(name, default, lo, hi):
    try:
        return min(max(float(os.environ.get(name, default)), lo), hi)
    except ValueError:
        return float(default)


def fee_pct():
    return _num("PLATFORM_FEE_PCT", 5, 0, 30)


def platform_cut(cents):
    """The platform's own share: 5% of the payment."""
    return int(round(cents * fee_pct() / 100))


def stripe_fee_estimate(cents):
    return int(round(cents * _num("STRIPE_PCT", 2.9, 0, 10) / 100)) + int(_num("STRIPE_FIXED_CENTS", 30, 0, 500))


def application_fee(cents):
    """What checkout asks Stripe to route to the platform: 5% + estimated Stripe fee."""
    return min(platform_cut(cents) + stripe_fee_estimate(cents), cents)


def key_mode():
    return "live" if "_live_" in _key() else "test"


def connect_account():
    """The bakery's connected account for the current key's mode (test and live accounts never mix)."""
    env = os.environ.get("STRIPE_CONNECT_ACCOUNT", "").strip()
    if env:
        return env
    acct = store.setting("connect_account")
    mode = store.setting("connect_mode")
    if acct and mode and mode != key_mode():
        return ""                     # saved account belongs to the other mode
    return acct


def forget_connect():
    for k in ("connect_account", "connect_mode", "connect_branded"):
        store.set_setting(k, "")
    store.set_setting("connect_ready", "0")


def _no_access(err):
    e = (err or "").lower()
    return "does not have access" in e or "no such account" in e or "not_found" in e or "does not exist" in e


def connect_ready():
    return bool(connect_account()) and store.setting("connect_ready") == "1"


def _stripe(method, path, data=None, idem=None, files=None, base=API):
    headers = {"Idempotency-Key": idem} if idem else {}
    try:
        if method == "GET":
            r = requests.get(base + path, params=data, auth=(_key(), ""), timeout=20)
        else:
            r = requests.request(method, base + path, data=data, files=files, headers=headers, auth=(_key(), ""), timeout=30)
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
        return None, _("Online payment isn't switched on yet. Please call us to finish your order.")
    amount = order["deposit_cents"] if kind == "deposit" else balance_due(order)
    if amount < 50:
        return None, _("There's nothing left to pay on this order.")
    lang = order.get("lang") or "en"
    head = catalog.describe(order["design"], lang)[0]
    when = schedule.label(order["pickup_date"], long=False, lang=lang)
    item = _("{shop}: {cake}, pickup {when}", lang, shop=BUSINESS, cake=head, when=when)
    item += " " + (_("(deposit)", lang) if kind == "deposit" else _("(balance)", lang))
    track = f"{base_url}/order/{order['token']}"
    data = {
        "mode": "payment",
        "success_url": f"{track}?paid={kind}",
        "cancel_url": f"{track}?canceled={kind}",
        "locale": "es" if lang == "es" else "en",
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
    fee = 0
    if acct and connect_ready():
        destination = acct
        fee = application_fee(amount)
        data["payment_intent_data[application_fee_amount]"] = str(fee)
        data["payment_intent_data[transfer_data][destination]"] = acct
        data["payment_intent_data[on_behalf_of]"] = acct        # bakery is the merchant: their name on Checkout and statements
    body, err = _stripe("POST", "/checkout/sessions", data)
    if err or not body.get("url"):
        log.warning("checkout session failed: %s", err)
        return None, _("We couldn't open the payment page. Please try again in a moment.")
    conn = store.db()
    try:
        with conn:
            conn.execute("INSERT INTO payments (order_id, kind, amount_cents, fee_cents, platform_cents, stripe_fee_cents, method, status, "
                         "session_id, destination, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                         (order["id"], kind, amount, fee, platform_cut(amount), stripe_fee_estimate(amount), "card", "pending",
                          body["id"], destination, store.now_iso()))
    finally:
        conn.close()
    return body["url"], ""


def _apply_session(s):
    """Record a paid session once, then settle its fees. Returns (order_id, kind) if newly recorded."""
    if s.get("payment_status") != "paid":
        return None
    sid = s.get("id", "")
    pi = s.get("payment_intent") or ""
    if isinstance(pi, dict):
        pi = pi.get("id", "")
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
            conn.execute("UPDATE payments SET status = 'paid', paid_at = ?, payment_intent = ? WHERE id = ?",
                         (store.now_iso(), pi, row["id"]))
            # A paid checkout supersedes any older pending one of the same kind.
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
            result = (row["order_id"], row["kind"])
            pid = row["id"]
    finally:
        conn.close()
    settle(pid)
    return result


# ------------------------------------------------------------- exact fee split
def settle(payment_id):
    """Correct the platform fee to exactly 5% + Stripe's real fee for one paid payment.

    Safe to call more than once: each payment is claimed before any money moves, and refunds and
    reversals carry an idempotency key, so a retry can never move money twice."""
    if not enabled():
        return False
    conn = store.db()
    try:
        with conn:
            claimed = conn.execute("UPDATE payments SET settled = 2 WHERE id = ? AND settled = 0 AND status = 'paid' "
                                   "AND payment_intent != ''", (payment_id,)).rowcount
            row = conn.execute("SELECT * FROM payments WHERE id = ?", (payment_id,)).fetchone()
    finally:
        conn.close()
    if not claimed:
        return False

    def release(note=""):
        c = store.db()
        try:
            with c:
                c.execute("UPDATE payments SET settled = 0 WHERE id = ?", (payment_id,))
                if note:
                    store.add_event(row["order_id"], "note", note, public=False, conn=c)
        finally:
            c.close()
        return False

    pi, err = _stripe("GET", f"/payment_intents/{row['payment_intent']}", {"expand[]": "latest_charge.balance_transaction"})
    charge = (pi or {}).get("latest_charge")
    bt = charge.get("balance_transaction") if isinstance(charge, dict) else None
    if not isinstance(bt, dict):
        return release()                                  # Stripe hasn't posted the fee yet; try again later
    real_fee = sum(f.get("amount", 0) for f in bt.get("fee_details") or [] if f.get("type") == "stripe_fee") or int(bt.get("fee") or 0)
    platform = row["platform_cents"]
    target = min(platform + real_fee, row["amount_cents"])
    if row["destination"]:
        charged = int(charge.get("application_fee_amount") or 0)
        diff = charged - target
        if diff > 0 and charge.get("application_fee"):
            _r, err = _stripe("POST", f"/application_fees/{charge['application_fee']}/refunds", {"amount": str(diff)},
                              idem=f"lecreme-settle-{payment_id}")
        elif diff < 0 and charge.get("transfer"):
            _r, err = _stripe("POST", f"/transfers/{charge['transfer']}/reversals", {"amount": str(-diff)},
                              idem=f"lecreme-settle-{payment_id}")
        else:
            err = ""
        if err:
            return release(f"Fee correction for payment {payment_id} didn't go through yet: {err}")
    conn = store.db()
    try:
        with conn:
            conn.execute("UPDATE payments SET stripe_fee_cents = ?, fee_cents = ?, settled = 1 WHERE id = ?",
                         (real_fee, target, payment_id))
    finally:
        conn.close()
    return True


def settle_pending(limit=20):
    """Retry any paid online payments whose exact fee couldn't be read yet."""
    if not enabled():
        return
    conn = store.db()
    try:
        ids = [r[0] for r in conn.execute("SELECT id FROM payments WHERE status = 'paid' AND settled = 0 AND payment_intent != '' "
                                          "ORDER BY id DESC LIMIT ?", (limit,))]
    finally:
        conn.close()
    for pid in ids:
        settle(pid)


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
    """The bakery took money at the counter: no Stripe fee, 5% recorded as owed to the platform."""
    conn = store.db()
    try:
        with conn:
            cut = platform_cut(amount_cents)
            conn.execute("INSERT INTO payments (order_id, kind, amount_cents, fee_cents, platform_cents, stripe_fee_cents, method, status, "
                         "created_at, paid_at, settled) VALUES (?,?,?,?,?,?,?,?,?,?,1)",
                         (order["id"], "in_person", amount_cents, cut, cut, 0, method, "paid", store.now_iso(), store.now_iso()))
            if order["status"] in ("pending", "expired"):
                conn.execute("UPDATE orders SET status = 'confirmed', hold_until = '' WHERE id = ?", (order["id"],))
            store.add_event(order["id"], "payment", f"${amount_cents / 100:,.2f} paid in person. Thank you!", conn=conn)
    finally:
        conn.close()


# --------------------------------------------------------------------- report
def report(month=None):
    """Every paid payment with its split, newest first, plus totals."""
    settle_pending()
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
    t = {"gross": 0, "stripe": 0, "platform": 0, "net": 0, "platform_owed": 0, "owed_to_bakery": 0, "estimated": 0}
    for r in rows:
        r["estimated"] = r["kind"] != "in_person" and r["settled"] != 1
        r["net_cents"] = r["amount_cents"] - r["stripe_fee_cents"] - r["platform_cents"]
        if r["kind"] == "in_person":
            r["route"] = _("In person")
            t["platform_owed"] += r["platform_cents"]
        elif r["destination"]:
            r["route"] = _("Stripe, split automatically")
        else:
            r["route"] = _("Stripe, before payouts were connected")
            t["owed_to_bakery"] += r["net_cents"]
        t["gross"] += r["amount_cents"]
        t["stripe"] += r["stripe_fee_cents"]
        t["platform"] += r["platform_cents"]
        t["net"] += r["net_cents"]
        t["estimated"] += 1 if r["estimated"] else 0
    return {"rows": rows, "totals": t, "months": months, "pct": fee_pct()}


# ----------------------------------------------------------- Connect onboarding
STRIPE_V2_VERSION = os.environ.get("STRIPE_V2_VERSION", "2026-09-30.endive")


def _v2(method, path, body=None, params=None):
    """Stripe API v2 (JSON). Accounts are created here; v1 endpoints accept the same acct_ IDs."""
    headers = {"Authorization": f"Bearer {_key()}", "Stripe-Version": STRIPE_V2_VERSION}
    try:
        r = requests.request(method, "https://api.stripe.com" + path, json=body, params=params, headers=headers, timeout=30)
        data = r.json()
    except Exception as e:
        return None, f"Couldn't reach Stripe ({e.__class__.__name__})."
    if r.status_code >= 400:
        err = data.get("error") or {}
        return None, err.get("message") or err.get("code") or f"Stripe said {r.status_code}."
    return data, ""


def _upload_icon():
    if not ICON.exists():
        return ""
    with open(ICON, "rb") as fh:
        f, err = _stripe("POST", "/files", {"purpose": "business_icon"}, files={"file": ("icon.png", fh, "image/png")},
                         base="https://files.stripe.com/v1")
    if err:
        log.warning("icon upload failed: %s", err)
        return ""
    return f["id"]


def start_onboarding(base_url):
    """Create the bakery's connected account (Accounts v2) if needed and return a Stripe onboarding link.

    merchant  -> takes card payments as the merchant of record (destination charges with on_behalf_of)
    recipient -> receives the transfer of its share (stripe_transfers, required for destination charges)
    The platform pays Stripe's fees and covers losses (required for the Express dashboard)."""
    if not enabled():
        return None, _("Add STRIPE_SECRET_KEY on Railway first.")
    acct = connect_account()
    if not acct:
        branding = {"primary_color": "#5E0F25", "secondary_color": "#C9A24A"}
        icon = _upload_icon()
        if icon:
            branding["icon"] = icon
        email = (store.setting("connect_email") or "").strip()
        if not email:
            return None, _("Enter the bakery owner's email first.")
        body = {
            "display_name": BUSINESS,
            "contact_email": email,
            "dashboard": "express",
            "identity": {"country": "us"},
            "configuration": {
                "merchant": {
                    "capabilities": {"card_payments": {"requested": True}},
                    "mcc": "5462",                                   # bakeries
                    "statement_descriptor": {"descriptor": DESCRIPTOR},
                    "branding": branding,
                },
                "recipient": {"capabilities": {"stripe_balance": {"stripe_transfers": {"requested": True}}}},
            },
            "defaults": {"currency": "usd",
                         "responsibilities": {"fees_collector": "application", "losses_collector": "application"}},
            "include": ["configuration.merchant", "configuration.recipient"],
        }
        if base_url.startswith("https://"):
            body["defaults"]["profile"] = {"business_url": base_url}
        made, err = _v2("POST", "/v2/core/accounts", body)
        if err and "profile" in body["defaults"] and "url" in err.lower():
            body["defaults"].pop("profile")
            made, err = _v2("POST", "/v2/core/accounts", body)
        if err:
            return None, err
        acct = made["id"]
        store.set_setting("connect_account", acct)
        store.set_setting("connect_mode", key_mode())
        store.set_setting("connect_ready", "0")
        store.set_setting("connect_branded", acct if icon else "")
    onboarding = {"return_url": f"{base_url}/admin/stripe/return", "refresh_url": f"{base_url}/admin/stripe/connect",
                  "configurations": ["merchant", "recipient"]}
    link, err = _v2("POST", "/v2/core/account_links", {"account": acct, "use_case": {"type": "account_onboarding",
                                                                                   "account_onboarding": onboarding}})
    if err and "configurations" in err.lower():
        onboarding.pop("configurations")
        link, err = _v2("POST", "/v2/core/account_links", {"account": acct, "use_case": {"type": "account_onboarding",
                                                                                       "account_onboarding": onboarding}})
    if err and _no_access(err) and not os.environ.get("STRIPE_CONNECT_ACCOUNT"):
        forget_connect()                                   # stale account from another mode: start fresh
        return start_onboarding(base_url)
    if err:
        return None, err
    return link["url"], ""


def brand_account(acct):
    """Make sure the bakery's Stripe account carries its icon and colors (Checkout and receipts)."""
    if store.setting("connect_branded") == acct:
        return
    icon = _upload_icon()
    if not icon:
        return
    _b, err = _v2("POST", f"/v2/core/accounts/{acct}", {"configuration": {"merchant": {"branding": {
        "icon": icon, "primary_color": "#5E0F25", "secondary_color": "#C9A24A"}}}})
    if err:
        log.warning("branding failed: %s", err)
    else:
        store.set_setting("connect_branded", acct)


def refresh_connect():
    """Ask Stripe whether the bakery can take charges yet. Returns a status dict."""
    acct = connect_account()
    st = {"account": acct, "charges": False, "payouts": False, "details": False, "error": ""}
    if not acct or not enabled():
        return st
    body, err = _stripe("GET", f"/accounts/{acct}")
    if err and _no_access(err) and not os.environ.get("STRIPE_CONNECT_ACCOUNT"):
        forget_connect()                                   # account from another mode or removed: not connected
        return {"account": "", "charges": False, "payouts": False, "details": False, "error": ""}
    if err:
        st["error"] = err
        return st
    if not store.setting("connect_mode"):
        store.set_setting("connect_mode", key_mode())
    st.update(charges=bool(body.get("charges_enabled")), payouts=bool(body.get("payouts_enabled")),
              details=bool(body.get("details_submitted")))
    store.set_setting("connect_ready", "1" if st["charges"] else "0")
    brand_account(acct)
    return st


def dashboard_link():
    acct = connect_account()
    if not acct:
        return None, _("Connect Stripe first.")
    body, err = _stripe("POST", f"/accounts/{acct}/login_links")
    return (body or {}).get("url"), err
