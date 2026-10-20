"""Order emails: a confirmation to the customer and a heads-up to the bakery.

Resend over HTTPS first (Railway blocks outbound SMTP on many plans), SMTP as a fallback.
Nothing configured means nothing is sent; the order is still safe in the database.

Environment variables
    ORDERS_INBOX     where new-order alerts go (the bakery's email)
    RESEND_API_KEY   from resend.com
    RESEND_FROM      e.g.  LeCreme Bakery <orders@yourdomain.com>
    SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD   (fallback)
"""
import logging
import os
import smtplib
import threading
from email.message import EmailMessage

import requests

log = logging.getLogger("mailer")


def _cfg():
    return {
        "inbox": os.environ.get("ORDERS_INBOX", "").strip(),
        "resend_key": os.environ.get("RESEND_API_KEY", "").strip(),
        "resend_from": os.environ.get("RESEND_FROM", "").strip(),
        "smtp_host": os.environ.get("SMTP_HOST", "smtp.gmail.com").strip(),
        "smtp_port": int(os.environ.get("SMTP_PORT", "587") or 587),
        "smtp_user": os.environ.get("SMTP_USER", "").strip(),
        "smtp_password": os.environ.get("SMTP_PASSWORD", ""),
    }


def status():
    c = _cfg()
    if c["resend_key"] and c["resend_from"]:
        provider = "Resend"
    elif c["smtp_user"] and c["smtp_password"]:
        provider = "SMTP"
    else:
        provider = ""
    return {"provider": provider, "inbox": c["inbox"]}


def _send(to, subject, body, reply_to=""):
    c = _cfg()
    if not to:
        return
    try:
        if c["resend_key"] and c["resend_from"]:
            payload = {"from": c["resend_from"], "to": [to], "subject": subject, "text": body}
            if reply_to:
                payload["reply_to"] = reply_to
            r = requests.post("https://api.resend.com/emails", json=payload, timeout=15,
                              headers={"Authorization": f"Bearer {c['resend_key']}"})
            if r.status_code >= 400:
                raise RuntimeError(f"Resend {r.status_code}: {r.text[:200]}")
        elif c["smtp_user"] and c["smtp_password"]:
            msg = EmailMessage()
            msg["From"], msg["To"], msg["Subject"] = c["smtp_user"], to, subject
            if reply_to:
                msg["Reply-To"] = reply_to
            msg.set_content(body)
            with smtplib.SMTP(c["smtp_host"], c["smtp_port"], timeout=20) as s:
                s.starttls()
                s.login(c["smtp_user"], c["smtp_password"])
                s.send_message(msg)
    except Exception:
        log.exception("email to %s failed", to)


def send_async(to, subject, body, reply_to=""):
    threading.Thread(target=_send, args=(to, subject, body, reply_to), daemon=True).start()


def bakery_inbox():
    return _cfg()["inbox"]
