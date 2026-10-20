"""English / Spanish for every word on the site.

English is the source text and the default. `_("English text", name=value)` returns the Spanish
from es.ES when the visitor picked Spanish, with {name} placeholders filled in. The same table is
sent to the browser so the JavaScript uses the same words (window._t).

The visitor's choice lives in the "lang" cookie, set by /lang/<code>. Orders remember the language
they were placed in, so emails, Stripe checkout and the order page follow the customer.
"""
import re
from datetime import date

from flask import g, has_request_context, request

from es import ES

LANGS = ("en", "es")
DAYS = {"en": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
        "es": ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]}
DAYS_SHORT = {"en": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
              "es": ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]}
MONTHS = {"en": ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
          "es": ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]}
MONTHS_SHORT = {"en": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
                "es": ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]}


def current():
    if not has_request_context():
        return "en"
    lang = getattr(g, "lang", None)
    if lang is None:
        lang = request.cookies.get("lang", "en")
        g.lang = lang if lang in LANGS else "en"
    return g.lang


def _(text, lang=None, **values):
    lang = lang or current()
    out = ES.get(text, text) if lang == "es" else text
    for k, v in values.items():
        out = out.replace("{" + k + "}", str(v))
    return out


def lowfirst(s, lang=None):
    """Names dropped mid-sentence read lower case in Spanish ("Goteo de caramelo")."""
    if (lang or current()) == "es" and s and not s[:2].isupper():
        return s[0].lower() + s[1:]
    return s


def browser_table():
    return ES if current() == "es" else {}


# ------------------------------------------------------------------ dates
def date_label(d, lang=None, long=True):
    lang = lang or current()
    if lang == "es":
        if long:
            return f"{DAYS[lang][d.weekday()]} {d.day} de {MONTHS[lang][d.month - 1]}"
        return f"{DAYS_SHORT[lang][d.weekday()]} {d.day} {MONTHS_SHORT[lang][d.month - 1]}"
    if long:
        return f"{DAYS[lang][d.weekday()]}, {MONTHS[lang][d.month - 1]} {d.day}"
    return f"{DAYS_SHORT[lang][d.weekday()]} {MONTHS_SHORT[lang][d.month - 1]} {d.day}"


def time_label(hhmm, lang=None):
    lang = lang or current()
    try:
        h, m = (int(x) for x in hhmm.split(":"))
    except ValueError:
        return hhmm
    hh = (h % 12) or 12
    mm = f":{m:02d}" if m else ""
    if lang == "es":
        return f"{hh}{mm} {'a. m.' if h < 12 else 'p. m.'}"
    return f"{hh}{mm} {'AM' if h < 12 else 'PM'}"


def at(lang=None):
    return " a las " if (lang or current()) == "es" else " at "


def day_parts(d: date, lang=None):
    lang = lang or current()
    return {"dow": DAYS_SHORT[lang][d.weekday()].capitalize(), "day": d.day, "mon": MONTHS_SHORT[lang][d.month - 1]}


# ---------------------------------------------------------- order updates
# Updates on an order are saved in English; they are shown in the reader's language.
STATUS = {
    "requested": ("Request received", "We'll call you soon to confirm your order."),
    "pending": ("Almost there", "Your pickup time is held while you finish checking out."),
    "expired": ("Time released", "Checkout wasn't finished, so we released the time. You can try again below."),
    "confirmed": ("Confirmed", "Your date is locked in. We'll start baking a day or two before pickup."),
    "baking": ("In the oven", "Your layers are baking right now."),
    "decorating": ("Being decorated", "Frosting, finishing and the details you picked."),
    "ready": ("Ready for pickup", "Your cake is boxed and chilled. Come on by!"),
    "picked_up": ("Picked up", "Thank you for celebrating with us."),
    "cancelled": ("Cancelled", "This order was cancelled. Call us with any questions."),
}

_PATTERNS = [
    (re.compile(r"^Deposit of (\$[\d,.]+) received\. Your date is locked in\.$"), "Deposit of {x} received. Your date is locked in."),
    (re.compile(r"^Balance of (\$[\d,.]+) received\. You're all paid up\.$"), "Balance of {x} received. You're all paid up."),
    (re.compile(r"^(\$[\d,.]+) paid in person\. Thank you!$"), "{x} paid in person. Thank you!"),
]


def event_text(msg, lang=None):
    lang = lang or current()
    if lang != "es":
        return msg
    if msg in ES:
        return ES[msg]
    for key, (title, blurb) in STATUS.items():
        if msg == f"{title}. {blurb}":
            return f"{_(title, lang)}. {_(blurb, lang)}"
    for rx, tpl in _PATTERNS:
        m = rx.match(msg)
        if m:
            return _(tpl, lang, x=m.group(1))
    return msg
