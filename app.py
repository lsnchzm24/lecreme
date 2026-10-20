"""LeCreme Bakery: design a cake, see it come together, pick a pickup time and pay a deposit.

Run locally:   python app.py            (http://localhost:5000)
On Railway:    gunicorn app:app  (see Procfile). Mount a volume at /data and set DATA_DIR=/data.
"""
import json
import logging
import os
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from flask import (Flask, Response, abort, jsonify, redirect, render_template, request,
                   send_from_directory, url_for)
from werkzeug.middleware.proxy_fix import ProxyFix

import admin
import catalog
import mailer
import payments
import schedule
import store

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("lecreme")

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.secret_key = os.environ.get("SECRET_KEY") or os.environ.get("ADMIN_PASSWORD") or secrets.token_hex(32)
app.config.update(MAX_CONTENT_LENGTH=12 * 1024 * 1024, SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                  SESSION_COOKIE_SECURE=os.environ.get("RAILWAY_ENVIRONMENT") is not None, TEMPLATES_AUTO_RELOAD=True)

BRAND = {
    "name": os.environ.get("BUSINESS_NAME", "LeCreme Bakery"),
    "phone": os.environ.get("BAKERY_PHONE", "786-484-6746"),
    "instagram": os.environ.get("BAKERY_INSTAGRAM", ""),
}
BRAND["phone_href"] = "+1" + re.sub(r"\D", "", BRAND["phone"])[-10:]

STATUS = {
    "requested": ("Request received", "We'll call to confirm your order and take the deposit."),
    "pending": ("Waiting for deposit", "Your pickup time is held while you finish paying."),
    "expired": ("Hold released", "The deposit wasn't completed, so the time was released. You can try again below."),
    "confirmed": ("Confirmed", "Your date is locked in. We'll start a day or two before pickup."),
    "baking": ("In the oven", "Your layers are baking right now."),
    "decorating": ("Being decorated", "Frosting, finishing and the details you picked."),
    "ready": ("Ready for pickup", "Your cake is boxed and chilled. Come on by."),
    "picked_up": ("Picked up", "Thank you for celebrating with us."),
    "cancelled": ("Cancelled", "This order was cancelled. Call us with any questions."),
}
TIMELINE = ["confirmed", "baking", "decorating", "ready", "picked_up"]
IMG_SIG = {b"\xff\xd8\xff": ".jpg", b"\x89PNG": ".png", b"RIFF": ".webp"}


@app.context_processor
def inject():
    return {"brand": BRAND, "year": datetime.now().year, "money": money, "asset_v": ASSET_V}


ASSET_V = str(int(time.time()))


@app.template_filter("dparts")
def dparts(iso):
    d = schedule.parse_date(iso)
    return {"dow": d.strftime("%a"), "day": d.day, "mon": d.strftime("%b")} if d else {}


def money(cents):
    cents = int(cents or 0)
    return f"${cents / 100:,.2f}".replace(".00", "")


def base_url():
    return os.environ.get("PUBLIC_URL", "").rstrip("/") or request.host_url.rstrip("/")


admin.configure(app, STATUS=STATUS, money=money, base_url=base_url, notify=lambda *a, **k: notify(*a, **k))

# ------------------------------------------------------------------ rate limit
_hits = defaultdict(deque)


def limited(bucket, n, window):
    ip = (request.access_route[0] if request.access_route else request.remote_addr) or "?"
    q = _hits[(bucket, ip)]
    now = time.time()
    while q and now - q[0] > window:
        q.popleft()
    if len(q) >= n:
        return True
    q.append(now)
    return False


# ---------------------------------------------------------------------- pages
@app.get("/")
def home():
    m = catalog.menu()
    nxt = schedule.next_available(1, 0)
    sigs = []
    for s in m["signatures"]:
        try:
            d = catalog.clean(s["design"])
        except ValueError:
            continue
        q = catalog.quote(d)
        sigs.append(dict(s, design=d, price=q["total"], servings=q["servings"]))
    return render_template("index.html", signatures=sigs, menu_json=json.dumps(m),
                           next_label=schedule.label(nxt) if nxt else "", week=schedule.calendar(1, 0, days=14))


@app.get("/build")
def build():
    m = catalog.menu()
    sig = next((s for s in m["signatures"] if s["id"] == request.args.get("sig")), None)
    return render_template("build.html", menu_json=json.dumps(m), start_json=json.dumps(sig["design"] if sig else None),
                           deposit_pct=store.setting_int("deposit_pct", 50, 0, 100), payments_on=payments.enabled(),
                           settings_pickup=store.setting("pickup_address"))


@app.get("/order/<token>")
def order_page(token):
    o = store.get_order(token=token)
    if not o:
        abort(404)
    if request.args.get("paid") and o["status"] not in ("cancelled",):
        res = payments.confirm_pending(o)
        if res:
            notify(res[0], res[1])
        o = store.get_order(token=token)
    return render_template("order.html", o=o, view=_order_view(o))


def _order_view(o):
    paid = payments.paid_cents(o["id"])
    st = o["status"]
    if st == "pending" and o["hold_until"] and o["hold_until"] < store.now_iso():
        st = "expired"
    title, blurb = STATUS.get(st, (st, ""))
    q = o["quote"]
    return {
        "status": st, "title": title, "blurb": blurb,
        "timeline": [{"id": s, "label": STATUS[s][0],
                      "done": st in TIMELINE and TIMELINE.index(s) <= TIMELINE.index(st)} for s in TIMELINE],
        "when": schedule.label(o["pickup_date"], o["pickup_time"]),
        "summary": catalog.describe(o["design"]),
        "lines": q["lines"], "servings": q["servings"],
        "total": o["total_cents"], "paid": paid, "due": max(o["total_cents"] - paid, 0),
        "deposit": o["deposit_cents"],
        "can_pay_deposit": payments.enabled() and st in ("pending", "expired"),
        "can_pay_balance": payments.enabled() and st in TIMELINE[:-1] and o["total_cents"] - paid >= 50,
        "events": store.get_events(o["id"]),
        "pickup_address": store.setting("pickup_address"), "pickup_note": store.setting("pickup_note"),
        "hold_until": o["hold_until"] if st == "pending" else "",
        "design_json": json.dumps(o["design"]),
    }


@app.get("/api/order/<token>")
def order_status(token):
    o = store.get_order(token=token)
    if not o:
        abort(404)
    v = _order_view(o)
    return jsonify({k: v[k] for k in ("status", "title", "blurb", "timeline", "paid", "due", "events")})


@app.post("/order/<token>/pay")
def order_pay(token):
    o = store.get_order(token=token)
    if not o:
        abort(404)
    if limited("pay", 12, 600):
        return render_template("order.html", o=o, view=_order_view(o), error="Too many tries. Please wait a few minutes."), 429
    v = _order_view(o)
    if v["can_pay_deposit"]:
        if v["status"] == "expired":
            err = _rehold(o)
            if err:
                return render_template("order.html", o=o, view=v, error=err), 409
            o = store.get_order(token=token)
        url, err = payments.create_checkout(o, "deposit", base_url())
    elif v["can_pay_balance"]:
        url, err = payments.create_checkout(o, "balance", base_url())
    else:
        return redirect(url_for("order_page", token=token))
    if err:
        return render_template("order.html", o=o, view=v, error=err), 502
    return redirect(url, code=303)


def _rehold(o):
    d = schedule.parse_date(o["pickup_date"])
    conn = store.db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        err = schedule.can_book(conn, d, o["pickup_time"], o["units"], o["quote"].get("lead_days", 0))
        if err:
            conn.rollback()
            return err + " Call us and we'll find you a time."
        hold = (datetime.now(timezone.utc) + timedelta(minutes=schedule.HOLD_MINUTES)).isoformat(timespec="seconds")
        conn.execute("UPDATE orders SET status = 'pending', hold_until = ? WHERE id = ?", (hold, o["id"]))
        conn.commit()
        return ""
    finally:
        conn.close()


@app.get("/order/<token>/pickup.ics")
def order_ics(token):
    o = store.get_order(token=token)
    if not o:
        abort(404)
    start = datetime.fromisoformat(f'{o["pickup_date"]}T{o["pickup_time"]}').replace(tzinfo=schedule.TZ).astimezone(timezone.utc)
    end = start + timedelta(minutes=30)
    fmt = "%Y%m%dT%H%M%SZ"
    loc = store.setting("pickup_address").replace(",", "\\,")
    body = "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//LeCreme Bakery//Orders//EN", "BEGIN:VEVENT",
        f"UID:order-{o['id']}@lecreme", f"DTSTAMP:{datetime.now(timezone.utc).strftime(fmt)}",
        f"DTSTART:{start.strftime(fmt)}", f"DTEND:{end.strftime(fmt)}",
        f"SUMMARY:Pick up cake at {BRAND['name']}", f"LOCATION:{loc}",
        f"DESCRIPTION:Order #{o['id']}. {base_url()}/order/{o['token']}",
        "END:VEVENT", "END:VCALENDAR", ""])
    return Response(body, mimetype="text/calendar", headers={"Content-Disposition": "attachment; filename=lecreme-pickup.ics"})


# ------------------------------------------------------------------------ API
@app.get("/api/menu")
def api_menu():
    return jsonify(catalog.menu())


@app.post("/api/quote")
def api_quote():
    try:
        d = catalog.clean((request.get_json(silent=True) or {}).get("design"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    q = catalog.quote(d)
    nxt = schedule.next_available(q["units"], q["lead_days"])
    return jsonify({"design": d, "quote": q, "next_available": nxt, "next_label": schedule.label(nxt) if nxt else "",
                    "deposit": q["total"] * store.setting_int("deposit_pct", 50, 0, 100) // 100})


@app.get("/api/calendar")
def api_calendar():
    units = request.args.get("units", type=int) or 1
    extra = request.args.get("extra", type=int) or 0
    start = schedule.parse_date(request.args.get("start", "")) or schedule.today()
    days = min(request.args.get("days", type=int) or 42, 120)
    return jsonify({"today": schedule.today().isoformat(), "days": schedule.calendar(units, extra, start, days),
                    "earliest": schedule.earliest(extra).isoformat()})


@app.get("/api/slots")
def api_slots():
    d = schedule.parse_date(request.args.get("date", ""))
    if not d:
        return jsonify({"error": "Pick a date."}), 400
    info, times = schedule.slots(d, request.args.get("units", type=int) or 1, request.args.get("extra", type=int) or 0)
    for t in times:
        t["label"] = schedule.time_label(t["time"])
    return jsonify({"day": info, "label": schedule.label(d.isoformat()), "slots": times})


@app.post("/api/order")
def api_order():
    if limited("order", 8, 600):
        return jsonify({"error": "Too many orders from this connection. Please wait a few minutes or call us."}), 429
    f = request.form
    try:
        design = catalog.clean(json.loads(f.get("design") or "{}"))
    except (ValueError, json.JSONDecodeError) as e:
        return jsonify({"error": str(e) or "The design didn't come through."}), 400
    name = re.sub(r"\s+", " ", f.get("name", "")).strip()[:80]
    phone = re.sub(r"[^\d+()\- ]", "", f.get("phone", "")).strip()[:24]
    email = f.get("email", "").strip()[:120]
    if len(name) < 2:
        return jsonify({"error": "Please add your name.", "field": "name"}), 400
    if len(re.sub(r"\D", "", phone)) < 10:
        return jsonify({"error": "Please add a phone number we can text about pickup.", "field": "phone"}), 400
    if email and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        return jsonify({"error": "That email doesn't look right.", "field": "email"}), 400
    d = schedule.parse_date(f.get("date", ""))
    t = f.get("time", "")[:5]
    if not d or not t:
        return jsonify({"error": "Please pick a pickup date and time."}), 400
    photo = _save_photo(request.files.get("photo"))
    if photo is None:
        return jsonify({"error": "The inspiration photo needs to be a JPG, PNG or WebP under 10 MB."}), 400
    q = catalog.quote(design)
    dep_pct = store.setting_int("deposit_pct", 50, 0, 100)
    online = payments.enabled()
    deposit = q["total"] * dep_pct // 100
    if online and deposit < 50:
        deposit = min(q["total"], 50)
    conn = store.db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        err = schedule.can_book(conn, d, t, q["units"], q["lead_days"])
        if err:
            conn.rollback()
            return jsonify({"error": err, "refresh": True}), 409
        hold = (datetime.now(timezone.utc) + timedelta(minutes=schedule.HOLD_MINUTES)).isoformat(timespec="seconds")
        oid = store.create_order(conn, status="pending" if online else "requested", name=name, phone=phone, email=email,
                                 occasion=f.get("occasion", "").strip()[:60], design=design, quote=q,
                                 total_cents=q["total"], deposit_cents=deposit, pickup_date=d.isoformat(), pickup_time=t,
                                 units=q["units"], hold_until=hold if online else "", photo=photo)
        store.add_event(oid, "created", "Order placed. Thank you!", conn=conn)
        conn.commit()
    finally:
        conn.close()
    o = store.get_order(oid)
    if not online:
        notify(oid, "requested")
        return jsonify({"redirect": url_for("order_page", token=o["token"])})
    url, err = payments.create_checkout(o, "deposit", base_url())
    if err:
        return jsonify({"redirect": url_for("order_page", token=o["token"]), "error": err})
    return jsonify({"redirect": url})


def _save_photo(fs):
    """'' when no photo, None when the file isn't an acceptable image, else the stored name."""
    if not fs or not fs.filename:
        return ""
    head = fs.stream.read(12)
    fs.stream.seek(0)
    ext = next((e for sig, e in IMG_SIG.items() if head.startswith(sig)), None)
    if ext == ".webp" and head[8:12] != b"WEBP":
        ext = None
    if not ext:
        return None
    name = secrets.token_urlsafe(10) + ext
    fs.save(store.UPLOADS / name)
    return name


@app.get("/uploads/<name>")
def upload(name):
    if not admin.signed_in():
        abort(404)
    return send_from_directory(store.UPLOADS, name)


@app.post("/stripe/webhook")
def stripe_webhook():
    payload = request.get_data()
    if not payments.verify_webhook(payload, request.headers.get("Stripe-Signature", "")):
        return "bad signature", 400
    try:
        event = json.loads(payload)
    except ValueError:
        return "bad payload", 400
    res = payments.handle_event(event)
    if res:
        notify(*res)
    return "ok"


# ------------------------------------------------------------------- emails
def notify(order_id, what):
    o = store.get_order(order_id)
    if not o:
        return
    link = f"{base_url()}/order/{o['token']}"
    when = schedule.label(o["pickup_date"], o["pickup_time"])
    lines = "\n".join("  " + x for x in catalog.describe(o["design"]))
    if what in ("deposit", "requested"):
        verb = "is confirmed" if what == "deposit" else "request is in"
        if o["email"]:
            mailer.send_async(o["email"], f"Your {BRAND['name']} cake {verb}",
                              f"Hi {o['name'].split()[0]},\n\nYour cake {verb}. Pickup: {when}.\n\n{lines}\n\n"
                              f"Total {money(o['total_cents'])}. Track it any time: {link}\n\n"
                              f"Questions? Call or text {BRAND['phone']}.\n\n{BRAND['name']}")
        mailer.send_async(mailer.bakery_inbox(), f"New cake order #{o['id']} for {when}",
                          f"{o['name']} ({o['phone']}{', ' + o['email'] if o['email'] else ''})\nPickup {when}\n\n{lines}\n\n"
                          f"Total {money(o['total_cents'])}. Admin: {base_url()}/admin", reply_to=o["email"])
    elif what == "ready" and o["email"]:
        mailer.send_async(o["email"], f"Your cake is ready at {BRAND['name']}",
                          f"Hi {o['name'].split()[0]},\n\nYour cake is ready for pickup ({when}).\n"
                          f"{store.setting('pickup_address')}\n\nOrder: {link}\n\n{BRAND['name']}")


@app.errorhandler(404)
def not_found(e):
    return render_template("404.html"), 404


@app.errorhandler(413)
def too_big(e):
    return jsonify({"error": "That photo is too large. Please use one under 10 MB."}), 413


@app.get("/healthz")
def health():
    return "ok"


if __name__ == "__main__":
    app.run(debug=True, port=int(os.environ.get("PORT", 5000)))
