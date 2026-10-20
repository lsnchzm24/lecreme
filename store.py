"""SQLite storage for orders, payments, the order timeline and owner settings.

Everything lives in one file under DATA_DIR. On Railway mount a volume at /data and set
DATA_DIR=/data, otherwise orders are lost on every deploy.
"""
import json
import os
import secrets
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", str(BASE / "data")))
DB_PATH = DATA_DIR / "lecreme.db"
UPLOADS = DATA_DIR / "uploads"

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    occasion TEXT NOT NULL DEFAULT '',
    design TEXT NOT NULL,
    quote TEXT NOT NULL,
    total_cents INTEGER NOT NULL,
    deposit_cents INTEGER NOT NULL,
    pickup_date TEXT NOT NULL,
    pickup_time TEXT NOT NULL,
    units INTEGER NOT NULL DEFAULT 1,
    hold_until TEXT NOT NULL DEFAULT '',
    photo TEXT NOT NULL DEFAULT '',
    kitchen_note TEXT NOT NULL DEFAULT '',
    lang TEXT NOT NULL DEFAULT 'en'
);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(pickup_date);
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    fee_cents INTEGER NOT NULL DEFAULT 0,
    method TEXT NOT NULL DEFAULT 'card',
    status TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    destination TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    paid_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pay_order ON payments(order_id);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    public INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_events_order ON events(order_id);
"""

DEFAULTS = {
    "deposit_pct": "50",
    "base_lead_days": "2",
    "daily_capacity": "8",
    "slot_minutes": "30",
    "slot_capacity": "2",
    "booking_days": "75",
    "hours": json.dumps({
        "mon": {"on": False, "start": "09:00", "end": "18:00"},
        "tue": {"on": True, "start": "09:00", "end": "18:00"},
        "wed": {"on": True, "start": "09:00", "end": "18:00"},
        "thu": {"on": True, "start": "09:00", "end": "18:00"},
        "fri": {"on": True, "start": "09:00", "end": "19:00"},
        "sat": {"on": True, "start": "08:00", "end": "19:00"},
        "sun": {"on": True, "start": "10:00", "end": "15:00"},
    }),
    "blackouts": "[]",
    "day_caps": "{}",
    "pickup_address": "",
    "pickup_note": "Bring your order link or name. Cakes travel best flat on a car floor, kept cool.",
    "connect_account": "",
    "connect_ready": "0",
    "admin_lang": "en",
    "prices": "{}",
    "hidden": "[]",
}

_ready = False


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_token():
    return secrets.token_urlsafe(12)


def db():
    global _ready
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    if not _ready:
        conn.executescript(SCHEMA)
        conn.execute("PRAGMA journal_mode=WAL")
        if "lang" not in {r["name"] for r in conn.execute("PRAGMA table_info(orders)")}:
            conn.execute("ALTER TABLE orders ADD COLUMN lang TEXT NOT NULL DEFAULT 'en'")
        for k, v in DEFAULTS.items():
            conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (k, v))
        conn.commit()
        UPLOADS.mkdir(parents=True, exist_ok=True)
        _ready = True
    return conn


# ------------------------------------------------------------------- settings
def get_settings():
    conn = db()
    try:
        return {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")}
    finally:
        conn.close()


def setting(key, default=""):
    return get_settings().get(key, default)


def set_setting(key, value):
    conn = db()
    try:
        with conn:
            conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                         (key, str(value)))
    finally:
        conn.close()


def setting_json(key, default):
    try:
        v = json.loads(setting(key) or "null")
    except ValueError:
        return default
    return v if isinstance(v, type(default)) else default


def setting_int(key, default, lo=0, hi=10 ** 6):
    try:
        return min(max(int(setting(key, str(default))), lo), hi)
    except ValueError:
        return default


# --------------------------------------------------------------------- orders
def _order(row):
    if not row:
        return None
    o = dict(row)
    o["design"] = json.loads(o["design"])
    o["quote"] = json.loads(o["quote"])
    return o


def create_order(conn, **f):
    cur = conn.execute(
        "INSERT INTO orders (token, created_at, status, name, phone, email, occasion, design, quote, total_cents, "
        "deposit_cents, pickup_date, pickup_time, units, hold_until, photo, lang) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (new_token(), now_iso(), f["status"], f["name"], f["phone"], f.get("email", ""), f.get("occasion", ""),
         json.dumps(f["design"]), json.dumps(f["quote"]), f["total_cents"], f["deposit_cents"], f["pickup_date"],
         f["pickup_time"], f["units"], f.get("hold_until", ""), f.get("photo", ""), f.get("lang", "en")))
    return cur.lastrowid


def get_order(order_id=None, token=None):
    conn = db()
    try:
        if token is not None:
            row = conn.execute("SELECT * FROM orders WHERE token = ?", (token,)).fetchone()
        else:
            row = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
        return _order(row)
    finally:
        conn.close()


def list_orders(where="1=1", args=(), limit=1000):
    conn = db()
    try:
        return [_order(r) for r in conn.execute(
            f"SELECT * FROM orders WHERE {where} ORDER BY pickup_date, pickup_time, id LIMIT ?", (*args, limit))]
    finally:
        conn.close()


def update_order(order_id, **fields):
    if not fields:
        return
    cols = ", ".join(f"{k} = ?" for k in fields)
    conn = db()
    try:
        with conn:
            conn.execute(f"UPDATE orders SET {cols} WHERE id = ?", (*fields.values(), order_id))
    finally:
        conn.close()


# --------------------------------------------------------------------- events
def add_event(order_id, kind, message, public=True, conn=None):
    own = conn is None
    conn = conn or db()
    try:
        conn.execute("INSERT INTO events (order_id, at, kind, message, public) VALUES (?,?,?,?,?)",
                     (order_id, now_iso(), kind, message, 1 if public else 0))
        if own:
            conn.commit()
    finally:
        if own:
            conn.close()


def get_events(order_id, public_only=True):
    conn = db()
    try:
        q = "SELECT at, kind, message, public FROM events WHERE order_id = ?" + (" AND public = 1" if public_only else "") + " ORDER BY id"
        return [dict(r) for r in conn.execute(q, (order_id,))]
    finally:
        conn.close()
