"""Live availability: which days can take a cake this size, and which pickup times are open.

Each day has a kitchen capacity in "units" (roughly one per tier, see catalog.units) and each
pickup time slot takes a limited number of handoffs. A customer at checkout holds their spot
for HOLD_MINUTES while they pay; an unpaid hold then frees itself.

Same weekly-hours shape as the Fix Pro technician availability:
    {"mon": {"on": bool, "start": "HH:MM", "end": "HH:MM"}, ...}
"""
import os
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import store
from i18n import _
import i18n

TZ = ZoneInfo(os.environ.get("BAKERY_TZ", "America/New_York"))
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
HOLD_MINUTES = 36       # Stripe keeps the deposit page open 31 minutes; the hold outlasts it
# Orders that use kitchen capacity on their pickup day ("requested" = taken without online payment).
BOOKED = ("requested", "confirmed", "baking", "decorating", "ready", "picked_up")


def today():
    return datetime.now(TZ).date()


def hours():
    raw = store.setting_json("hours", {})
    out = {}
    for d in DAYS:
        v = raw.get(d) if isinstance(raw.get(d), dict) else {}
        out[d] = {"on": bool(v.get("on", d != "mon")),
                  "start": _hhmm(v.get("start"), "09:00"), "end": _hhmm(v.get("end"), "18:00")}
    return out


def _hhmm(v, default):
    s = str(v or "")[:5]
    try:
        datetime.strptime(s, "%H:%M")
        return s
    except ValueError:
        return default


def blackouts():
    return set(x for x in store.setting_json("blackouts", []) if isinstance(x, str))


def capacity(d):
    caps = store.setting_json("day_caps", {})
    try:
        return max(0, int(caps.get(d.isoformat())))
    except (TypeError, ValueError):
        return store.setting_int("daily_capacity", 8, 0, 500)


def earliest(extra_days=0):
    return today() + timedelta(days=store.setting_int("base_lead_days", 2, 0, 60) + int(extra_days or 0))


def _usage(start, end, conn=None):
    """{date: {"units": n, "slots": {time: n}}} for booked orders and live holds in [start, end]."""
    own = conn is None
    conn = conn or store.db()
    try:
        rows = conn.execute(
            f"SELECT pickup_date, pickup_time, units FROM orders WHERE pickup_date BETWEEN ? AND ? AND "
            f"(status IN ({','.join('?' * len(BOOKED))}) OR (status = 'pending' AND hold_until > ?))",
            (start.isoformat(), end.isoformat(), *BOOKED, store.now_iso())).fetchall()
    finally:
        if own:
            conn.close()
    out = {}
    for r in rows:
        u = out.setdefault(r["pickup_date"], {"units": 0, "slots": {}})
        u["units"] += r["units"]
        u["slots"][r["pickup_time"]] = u["slots"].get(r["pickup_time"], 0) + 1
    return out


def _slot_times(d):
    h = hours()[DAYS[d.weekday()]]
    step = store.setting_int("slot_minutes", 30, 10, 240)
    t = datetime.combine(d, datetime.strptime(h["start"], "%H:%M").time())
    end = datetime.combine(d, datetime.strptime(h["end"], "%H:%M").time())
    out = []
    while t + timedelta(minutes=step) <= end + timedelta(seconds=1):
        out.append(t.strftime("%H:%M"))
        t += timedelta(minutes=step)
    return out


def _day(d, units, extra_days, usage):
    h = hours()[DAYS[d.weekday()]]
    if d.isoformat() in blackouts() or not h["on"]:
        return {"date": d.isoformat(), "status": "closed", "left": 0}
    if d < earliest(extra_days):
        return {"date": d.isoformat(), "status": "soon", "left": 0}
    cap = capacity(d)
    used = usage.get(d.isoformat(), {"units": 0, "slots": {}})
    left = cap - used["units"]
    slot_cap = store.setting_int("slot_capacity", 2, 1, 50)
    open_slots = [t for t in _slot_times(d) if used["slots"].get(t, 0) < slot_cap]
    if left < units or not open_slots:
        return {"date": d.isoformat(), "status": "full", "left": max(left, 0)}
    status = "limited" if left - units < max(2, cap // 4) else "open"
    return {"date": d.isoformat(), "status": status, "left": left}


def calendar(units=1, extra_days=0, start=None, days=None):
    """Day-by-day status from start for the booking window."""
    start = start or today()
    days = days or store.setting_int("booking_days", 75, 7, 365)
    end = today() + timedelta(days=store.setting_int("booking_days", 75, 7, 365))
    last = min(start + timedelta(days=days - 1), end)
    usage = _usage(start, last)
    out = []
    d = start
    while d <= last:
        out.append(_day(d, units, extra_days, usage))
        d += timedelta(days=1)
    return out


def next_available(units=1, extra_days=0):
    for day in calendar(units, extra_days):
        if day["status"] in ("open", "limited"):
            return day["date"]
    return None


def slots(d, units=1, extra_days=0, conn=None):
    """Pickup times for one day: [{"time": "HH:MM", "open": bool}]."""
    usage = _usage(d, d, conn)
    info = _day(d, units, extra_days, usage)
    if info["status"] not in ("open", "limited"):
        return info, []
    slot_cap = store.setting_int("slot_capacity", 2, 1, 50)
    used = usage.get(d.isoformat(), {"slots": {}})["slots"]
    return info, [{"time": t, "open": used.get(t, 0) < slot_cap} for t in _slot_times(d)]


def parse_date(s):
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def can_book(conn, d, time, units, extra_days):
    """Checked inside the write transaction that saves the order. Returns an error or ""."""
    end = today() + timedelta(days=store.setting_int("booking_days", 75, 7, 365))
    if d > end:
        return _("That date is past our booking window. Please pick an earlier date or call us.")
    info, times = slots(d, units, extra_days, conn)
    if info["status"] == "soon":
        return _("This design needs a little more notice. Please pick a later date.")
    if info["status"] == "closed":
        return _("We're closed that day. Please pick another date.")
    if info["status"] == "full":
        return _("That day just filled up. Please pick another date.")
    match = next((t for t in times if t["time"] == time), None)
    if not match:
        return _("Please pick a pickup time.")
    if not match["open"]:
        return _("Someone just took that pickup time. Please pick another.")
    return ""


def label(d_iso, t="", long=True, lang=None):
    d = parse_date(d_iso)
    if not d:
        return d_iso
    s = i18n.date_label(d, lang, long)
    if t:
        s += i18n.at(lang) + time_label(t, lang)
    return s


def time_label(t, lang=None):
    return i18n.time_label(t, lang)
