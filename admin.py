"""The bakery's back office at /admin: orders, calendar, menu prices and payments.

Sign in with ADMIN_PASSWORD (Railway variable). Without it the admin stays switched off.
"""
import hmac
import json
import os
import re
import time
from collections import defaultdict, deque
from datetime import date, timedelta
from urllib.parse import urlparse

from flask import Blueprint, abort, jsonify, redirect, render_template, request, session, url_for

import catalog
import mailer
import payments
import schedule
import store
from i18n import STATUS, _

bp = Blueprint("admin", __name__, url_prefix="/admin")
_ctx = {}
_fails = defaultdict(deque)
FLOW = ["requested", "pending", "confirmed", "baking", "decorating", "ready", "picked_up", "cancelled", "expired"]


def configure(app, **ctx):
    _ctx.update(ctx)
    app.register_blueprint(bp)


def _password():
    return os.environ.get("ADMIN_PASSWORD", "").strip()


def signed_in():
    return bool(_password()) and session.get("admin") == _sig()


def _sig():
    return hmac.new(_password().encode(), b"lecreme-admin", "sha256").hexdigest()[:24]


@bp.before_request
def guard():
    if not _password():
        abort(404)
    if request.method != "GET":
        origin = request.headers.get("Origin")
        if origin and urlparse(origin).netloc != request.host:
            abort(403)
    if request.endpoint not in ("admin.login",) and not signed_in():
        if request.path.startswith("/admin/api/"):
            return jsonify({"error": _("Signed out. Refresh to sign in again.")}), 401
        return redirect(url_for("admin.login"))


@bp.route("/login", methods=["GET", "POST"])
def login():
    error = ""
    if request.method == "POST":
        ip = request.access_route[0] if request.access_route else request.remote_addr
        q = _fails[ip]
        while q and time.time() - q[0] > 900:
            q.popleft()
        if len(q) >= 8:
            error = _("Too many tries. Wait 15 minutes.")
        elif hmac.compare_digest(request.form.get("password", "").strip(), _password()):
            session.clear()
            session["admin"] = _sig()
            session.permanent = True
            return redirect(url_for("admin.home"))
        else:
            q.append(time.time())
            error = _("That password didn't match.")
    return render_template("admin_login.html", error=error)


@bp.get("/logout")
def logout():
    session.clear()
    return redirect(url_for("home"))


@bp.get("")
@bp.get("/")
def home():
    return render_template("admin.html", menu_json=json.dumps(catalog.menu(include_hidden=True)),
                           fee_pct=payments.fee_pct(), test_mode=payments.test_mode(),
                           stripe_on=payments.enabled(), mail=mailer.status())


# ---------------------------------------------------------------------- orders
def _row(o):
    paid = payments.paid_cents(o["id"])
    st = o["status"]
    if st == "pending" and o["hold_until"] < store.now_iso():
        st = "expired"
    return {"id": o["id"], "token": o["token"], "status": st, "status_label": _(STATUS.get(st, (st,))[0]),
            "name": o["name"], "phone": o["phone"], "email": o["email"], "occasion": o["occasion"],
            "date": o["pickup_date"], "time": o["pickup_time"], "when": schedule.label(o["pickup_date"], o["pickup_time"], long=False),
            "total": o["total_cents"], "paid": paid, "due": max(o["total_cents"] - paid, 0), "units": o["units"],
            "design": o["design"], "summary": catalog.describe(o["design"]), "servings": o["quote"]["servings"],
            "photo": o["photo"], "note": o["kitchen_note"], "created": o["created_at"]}


@bp.get("/api/orders")
def orders():
    scope = request.args.get("scope", "upcoming")
    today = schedule.today().isoformat()
    if scope == "past":
        rows = store.list_orders("pickup_date < ?", (today,))[::-1][:300]
    elif scope == "all":
        rows = store.list_orders()
    else:
        rows = store.list_orders("pickup_date >= ? AND status NOT IN ('cancelled', 'picked_up')", (today,))
    out = [_row(o) for o in rows]
    if scope == "upcoming":
        out = [r for r in out if r["status"] != "expired"]
    return jsonify({"orders": out, "today": today})


@bp.post("/api/orders/<int:oid>/status")
def set_status(oid):
    o = store.get_order(oid)
    st = (request.get_json(silent=True) or {}).get("status")
    if not o or st not in FLOW:
        return jsonify({"error": _("Unknown order or status.")}), 400
    store.update_order(oid, status=st, hold_until="")
    store.add_event(oid, st, f"{STATUS[st][0]}. {STATUS[st][1]}")      # saved in English, shown in each reader's language
    if st == "ready":
        _ctx["notify"](oid, "ready")
    return jsonify(_row(store.get_order(oid)))


@bp.post("/api/orders/<int:oid>/note")
def set_note(oid):
    note = str((request.get_json(silent=True) or {}).get("note", ""))[:1000]
    store.update_order(oid, kitchen_note=note)
    return jsonify({"ok": True})


@bp.post("/api/orders/<int:oid>/paid")
def in_person(oid):
    o = store.get_order(oid)
    body = request.get_json(silent=True) or {}
    try:
        cents = int(round(float(body.get("amount", 0)) * 100))
    except (TypeError, ValueError):
        cents = 0
    method = body.get("method") if body.get("method") in ("cash", "card", "zelle", "other") else "other"
    if not o or cents <= 0:
        return jsonify({"error": _("Enter the amount received.")}), 400
    payments.record_in_person(o, cents, method)
    return jsonify(_row(store.get_order(oid)))


@bp.get("/api/orders/<int:oid>/events")
def events(oid):
    return jsonify(store.get_events(oid, public_only=False))


# --------------------------------------------------------------------- calendar
@bp.get("/api/month")
def month():
    try:
        first = date.fromisoformat((request.args.get("m") or schedule.today().isoformat()[:7]) + "-01")
    except ValueError:
        first = schedule.today().replace(day=1)
    nxt = (first + timedelta(days=32)).replace(day=1)
    rows = store.list_orders("pickup_date >= ? AND pickup_date < ? AND status IN ({})".format(",".join("?" * len(schedule.BOOKED))),
                             (first.isoformat(), nxt.isoformat(), *schedule.BOOKED))
    hrs = schedule.hours()
    blk = schedule.blackouts()
    days = []
    d = first
    while d < nxt:
        iso = d.isoformat()
        mine = [r for r in rows if r["pickup_date"] == iso]
        days.append({"date": iso, "open": hrs[schedule.DAYS[d.weekday()]]["on"] and iso not in blk,
                     "blackout": iso in blk, "cap": schedule.capacity(d),
                     "used": sum(r["units"] for r in mine), "orders": len(mine),
                     "custom_cap": iso in store.setting_json("day_caps", {})})
        d += timedelta(days=1)
    return jsonify({"month": first.isoformat()[:7], "days": days, "today": schedule.today().isoformat()})


@bp.post("/api/day")
def day():
    b = request.get_json(silent=True) or {}
    d = schedule.parse_date(b.get("date", ""))
    if not d:
        return jsonify({"error": _("Pick a date.")}), 400
    iso = d.isoformat()
    if "blackout" in b:
        blk = schedule.blackouts()
        (blk.add if b["blackout"] else blk.discard)(iso)
        store.set_setting("blackouts", json.dumps(sorted(x for x in blk if x >= schedule.today().isoformat())))
    if "cap" in b:
        caps = store.setting_json("day_caps", {})
        if b["cap"] in (None, ""):
            caps.pop(iso, None)
        else:
            caps[iso] = max(0, min(int(b["cap"]), 500))
        store.set_setting("day_caps", json.dumps({k: v for k, v in caps.items() if k >= schedule.today().isoformat()}))
    return jsonify({"ok": True})


# --------------------------------------------------------------------- settings
SETTING_INTS = {"deposit_pct": (0, 100), "base_lead_days": (0, 60), "daily_capacity": (0, 500),
                "slot_minutes": (10, 240), "slot_capacity": (1, 50), "booking_days": (7, 365)}


@bp.get("/api/settings")
def get_settings():
    s = store.get_settings()
    return jsonify({**{k: int(s.get(k, 0)) for k in SETTING_INTS}, "hours": schedule.hours(),
                    "pickup_address": s.get("pickup_address", ""), "pickup_note": s.get("pickup_note", "")})


@bp.post("/api/settings")
def save_settings():
    b = request.get_json(silent=True) or {}
    for k, (lo, hi) in SETTING_INTS.items():
        if k in b:
            try:
                store.set_setting(k, min(max(int(b[k]), lo), hi))
            except (TypeError, ValueError):
                return jsonify({"error": _("Every number field needs a number.")}), 400
    if isinstance(b.get("hours"), dict):
        clean = {}
        for d in schedule.DAYS:
            v = b["hours"].get(d) or {}
            clean[d] = {"on": bool(v.get("on")), "start": schedule._hhmm(v.get("start"), "09:00"),
                        "end": schedule._hhmm(v.get("end"), "18:00")}
            if clean[d]["end"] <= clean[d]["start"]:
                return jsonify({"error": _("Closing time must be after opening time.")}), 400
        store.set_setting("hours", json.dumps(clean))
    for k in ("pickup_address", "pickup_note"):
        if k in b:
            store.set_setting(k, str(b[k])[:300])
    return get_settings()


@bp.post("/api/menu")
def save_menu():
    b = request.get_json(silent=True) or {}
    valid = {f"{g}.{o['id']}" for g in catalog.PRICED for o in catalog.GROUPS[g]}
    prices = {}
    for k, v in (b.get("prices") or {}).items():
        if k in valid or k == "custom_color":
            try:
                prices[k] = max(0, int(round(float(v) * 100)))
            except (TypeError, ValueError):
                return jsonify({"error": _("Every price needs a number.")}), 400
    allk = {f"{g}.{o['id']}" for g in catalog.GROUPS for o in catalog.GROUPS[g]}
    hidden = sorted(k for k in (b.get("hidden") or []) if k in allk)
    store.set_setting("prices", json.dumps(prices))
    store.set_setting("hidden", json.dumps(hidden))
    return jsonify(catalog.menu(include_hidden=True))


# --------------------------------------------------------------------- payments
@bp.get("/api/payments")
def pay_report():
    m = request.args.get("m") or None
    if m and not re.match(r"^\d{4}-\d{2}$", m):
        m = None
    r = payments.report(m)
    st = payments.refresh_connect() if payments.connect_account() else {"account": "", "charges": False}
    return jsonify({**r, "connect": st, "stripe_on": payments.enabled(), "test_mode": payments.test_mode()})


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@bp.route("/stripe/connect", methods=["GET", "POST"])
def stripe_connect():
    """Stripe needs a contact email for the bakery's new account, so ask for it once before starting."""
    error = ""
    if request.method == "POST":
        email = (request.form.get("email") or "").strip()[:200]
        if EMAIL_RE.match(email):
            store.set_setting("connect_email", email)
        else:
            error = _("Enter a valid email address.")
    if not payments.connect_account() and (error or not store.setting("connect_email")):
        return render_template("admin_connect.html", error=error,
                               email=request.form.get("email") or os.environ.get("ORDERS_INBOX", ""))
    url, err = payments.start_onboarding(_ctx["base_url"]())
    if err:
        return render_template("admin_msg.html", title=_("Stripe couldn't start"), message=err), 502
    return redirect(url)


@bp.get("/stripe/return")
def stripe_return():
    payments.refresh_connect()
    return redirect(url_for("admin.home") + "#payments")


@bp.get("/stripe/dashboard")
def stripe_dashboard():
    url, err = payments.dashboard_link()
    if not url:
        return render_template("admin_msg.html", title=_("Stripe dashboard"), message=err or _("Finish connecting first.")), 400
    return redirect(url)
