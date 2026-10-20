"""LeCreme Bakery: design a cake, watch it come together, pick a pickup time and reserve it.

Run locally:   python app.py            (http://localhost:5000)
On Railway:    gunicorn app:app  (see Procfile). Mount a volume at /data and set DATA_DIR=/data.
Every page is in English and Spanish (see i18n.py); the visitor switches with the EN/ES button.
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
import i18n
import mailer
import payments
import schedule
import store
from i18n import STATUS, _

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

TIMELINE = ["confirmed", "baking", "decorating", "ready", "picked_up"]
IMG_SIG = {b"\xff\xd8\xff": ".jpg", b"\x89PNG": ".png", b"RIFF": ".webp"}
ASSET_V = str(int(time.time()))


@app.context_processor
def inject():
    lang = i18n.current()
    here = request.full_path.rstrip("?") if request else "/"
    return {"brand": BRAND, "year": datetime.now().year, "money": money, "asset_v": ASSET_V, "_": _,
            "lang": lang, "other_lang": "es" if lang == "en" else "en", "here": here,
            "js_strings": i18n.browser_table()}


@app.template_filter("dparts")
def dparts(iso):
    d = schedule.parse_date(iso)
    return i18n.day_parts(d) if d else {}


def money(cents):
    cents = int(cents or 0)
    return f"${cents / 100:,.2f}".replace(".00", "")


def base_url():
    return os.environ.get("PUBLIC_URL", "").rstrip("/") or request.host_url.rstrip("/")


admin.configure(app, money=money, base_url=base_url, notify=lambda *a, **k: notify(*a, **k))


# --------------------------------------------------------------------- language
@app.get("/lang/<code>")
def set_lang(code):
    code = code if code in i18n.LANGS else "en"
    nxt = request.args.get("next", "/")
    if not nxt.startswith("/") or nxt.startswith("//") or "\\" in nxt:
        nxt = "/"
    resp = redirect(nxt)
    resp.set_cookie("lang", code, max_age=60 * 60 * 24 * 365, samesite="Lax",
                    secure=os.environ.get("RAILWAY_ENVIRONMENT") is not None)
    if admin.signed_in():
        store.set_setting("admin_lang", code)          # kitchen emails follow the admin's language
    return resp


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
        "status": st, "title": _(title), "blurb": _(blurb),
        "timeline": [{"id": s, "label": _(STATUS[s][0]),
                      "done": st in TIMELINE and TIMELINE.index(s) <= TIMELINE.index(st)} for s in TIMELINE],
        "when": schedule.label(o["pickup_date"], o["pickup_time"]),
        "summary": catalog.describe(o["design"]),
        "lines": [dict(l, label=catalog.line_label(l)) for l in q["lines"]], "servings": q["servings"],
        "total": o["total_cents"], "paid": paid, "due": max(o["total_cents"] - paid, 0),
        "deposit": o["deposit_cents"],
        "can_pay_deposit": payments.enabled() and st in ("pending", "expired"),
        "can_pay_balance": payments.enabled() and st in TIMELINE[:-1] and o["total_cents"] - paid >= 50,
        "events": [dict(e, message=i18n.event_text(e["message"])) for e in store.get_events(o["id"])],
        "pickup_address": store.setting("pickup_address"), "pickup_note": _(store.setting("pickup_note")),
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
        return render_template("order.html", o=o, view=_order_view(o), error=_("Too many tries. Please wait a few minutes.")), 429
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
            return err + " " + _("Call us and we'll find you a time.")
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
        "SUMMARY:" + _("Pick up cake at {shop}", shop=BRAND["name"]), f"LOCATION:{loc}",
        "DESCRIPTION:" + _("Order #{n}", n=o["id"]) + f". {base_url()}/order/{o['token']}",
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
        return jsonify({"error": _("Pick a date.")}), 400
    info, times = schedule.slots(d, request.args.get("units", type=int) or 1, request.args.get("extra", type=int) or 0)
    for t in times:
        t["label"] = schedule.time_label(t["time"])
    return jsonify({"day": info, "label": schedule.label(d.isoformat()), "slots": times})


@app.post("/api/order")
def api_order():
    if limited("order", 8, 600):
        return jsonify({"error": _("Too many orders from this connection. Please wait a few minutes or call us.")}), 429
    f = request.form
    try:
        design = catalog.clean(json.loads(f.get("design") or "{}"))
    except (ValueError, json.JSONDecodeError) as e:
        return jsonify({"error": str(e) or _("The design didn't come through. Please try again.")}), 400
    name = re.sub(r"\s+", " ", f.get("name", "")).strip()[:80]
    phone = re.sub(r"[^\d+()\- ]", "", f.get("phone", "")).strip()[:24]
    email = f.get("email", "").strip()[:120]
    if len(name) < 2:
        return jsonify({"error": _("Please add your name."), "field": "name"}), 400
    if len(re.sub(r"\D", "", phone)) < 10:
        return jsonify({"error": _("Please add a phone number we can text about pickup."), "field": "phone"}), 400
    if email and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        return jsonify({"error": _("That email doesn't look right."), "field": "email"}), 400
    d = schedule.parse_date(f.get("date", ""))
    t = f.get("time", "")[:5]
    if not d or not t:
        return jsonify({"error": _("Please pick a pickup date and time.")}), 400
    photo = _save_photo(request.files.get("photo"))
    if photo is None:
        return jsonify({"error": _("The inspiration photo needs to be a JPG, PNG or WebP under 10 MB.")}), 400
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
                                 units=q["units"], hold_until=hold if online else "", photo=photo, lang=i18n.current())
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
    """Customer emails go out in the language they ordered in; kitchen emails in the admin's."""
    o = store.get_order(order_id)
    if not o:
        return
    cl = o.get("lang") or "en"
    kl = store.setting("admin_lang") or "en"
    link = f"{base_url()}/order/{o['token']}"
    first = o["name"].split()[0]
    if what in ("deposit", "requested"):
        if o["email"]:
            lines = "\n".join("  " + x for x in catalog.describe(o["design"], cl))
            subject = (_("Your {shop} cake is confirmed", cl, shop=BRAND["name"]) if what == "deposit"
                       else _("We got your {shop} cake request", cl, shop=BRAND["name"]))
            body = "\n\n".join([
                _("Hi {name},", cl, name=first),
                (_("Your cake is confirmed. Pickup: {when}.", cl, when=schedule.label(o["pickup_date"], o["pickup_time"], lang=cl))
                 if what == "deposit" else
                 _("We got your cake request for {when}. We'll call you soon to confirm.", cl, when=schedule.label(o["pickup_date"], o["pickup_time"], lang=cl))),
                lines,
                _("Total {total}. Follow your cake any time: {link}", cl, total=money(o["total_cents"]), link=link),
                _("Questions? Call or text {phone}.", cl, phone=BRAND["phone"]),
                BRAND["name"]])
            mailer.send_async(o["email"], subject, body)
        when_k = schedule.label(o["pickup_date"], o["pickup_time"], lang=kl)
        lines_k = "\n".join("  " + x for x in catalog.describe(o["design"], kl))
        mailer.send_async(mailer.bakery_inbox(), _("New cake order #{n} for {when}", kl, n=o["id"], when=when_k),
                          f"{o['name']} ({o['phone']}{', ' + o['email'] if o['email'] else ''})\n"
                          + _("Pickup {when}", kl, when=when_k) + f"\n\n{lines_k}\n\n"
                          + _("Total {total}. Admin: {link}", kl, total=money(o["total_cents"]), link=f"{base_url()}/admin"),
                          reply_to=o["email"])
    elif what == "ready" and o["email"]:
        mailer.send_async(o["email"], _("Your cake is ready at {shop}", cl, shop=BRAND["name"]),
                          "\n\n".join([_("Hi {name},", cl, name=first),
                                       _("Your cake is ready for pickup ({when}).", cl, when=schedule.label(o["pickup_date"], o["pickup_time"], lang=cl)),
                                       store.setting("pickup_address"), _("Your order: {link}", cl, link=link), BRAND["name"]]))


@app.errorhandler(404)
def not_found(e):
    return render_template("404.html"), 404


@app.errorhandler(413)
def too_big(e):
    return jsonify({"error": _("That photo is too large. Please use one under 10 MB.")}), 413


@app.get("/healthz")
def health():
    return "ok"


if __name__ == "__main__":
    app.run(debug=True, port=int(os.environ.get("PORT", 5000)))
