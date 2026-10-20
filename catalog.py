"""Everything a customer can choose, what it costs and how long it takes.

The browser gets this as JSON to draw the cake and show a live price, but the price that is
charged is always recomputed here from the saved design (quote()), never taken from the browser.
The owner can change any price or hide any option from the admin; those edits live in the
settings table ("prices" and "hidden") and are applied on top of the defaults below.
"""
import json
import re

import store

# --------------------------------------------------------------------------- the menu
# Every option has an id, a label, a price in cents and (where it matters) colors for the drawing.

SHAPES = [
    {"id": "round", "label": "Round", "note": "The classic, stacks beautifully", "price": 0},
    {"id": "square", "label": "Square", "note": "Clean, modern edges", "price": 0, "pct": 15},
    {"id": "sheet", "label": "Sheet", "note": "One layer, feeds a crowd", "price": 0},
]

# Round/square tier sizes. Price is for one tier of that size.
SIZES = [
    {"id": "6", "label": '6"', "servings": 12, "price": 4500},
    {"id": "8", "label": '8"', "servings": 24, "price": 6500},
    {"id": "10", "label": '10"', "servings": 38, "price": 9500},
    {"id": "12", "label": '12"', "servings": 56, "price": 13000},
]

SHEETS = [
    {"id": "quarter", "label": "Quarter sheet", "servings": 24, "price": 6000},
    {"id": "half", "label": "Half sheet", "servings": 48, "price": 11000},
    {"id": "full", "label": "Full sheet", "servings": 96, "price": 19500},
]

FLAVORS = [   # sponge, per tier
    {"id": "vanilla", "label": "Vanilla bean", "price": 0, "color": "#F3DDA8"},
    {"id": "chocolate", "label": "Dark chocolate", "price": 0, "color": "#5B3426"},
    {"id": "redvelvet", "label": "Red velvet", "price": 500, "color": "#A3243B"},
    {"id": "lemon", "label": "Lemon chiffon", "price": 0, "color": "#F7E07D"},
    {"id": "almond", "label": "Almond", "price": 300, "color": "#EED6B0"},
    {"id": "funfetti", "label": "Confetti", "price": 300, "color": "#F6E7C3", "speckle": True},
    {"id": "carrot", "label": "Spiced carrot", "price": 500, "color": "#C58A4B"},
    {"id": "pistachio", "label": "Pistachio", "price": 800, "color": "#B9C98A"},
    {"id": "tres", "label": "Tres leches", "price": 800, "color": "#FAEBC8"},
]

FILLINGS = [  # per tier
    {"id": "vanillabc", "label": "Vanilla buttercream", "price": 0, "color": "#FFF4DD"},
    {"id": "ganache", "label": "Chocolate ganache", "price": 300, "color": "#3E2017"},
    {"id": "strawberry", "label": "Strawberry preserves", "price": 300, "color": "#D2334B"},
    {"id": "lemoncurd", "label": "Lemon curd", "price": 300, "color": "#F5D23F"},
    {"id": "caramel", "label": "Salted caramel", "price": 400, "color": "#C9822F"},
    {"id": "creamcheese", "label": "Cream cheese", "price": 300, "color": "#FCF6EA"},
    {"id": "guava", "label": "Guava & cream cheese", "price": 500, "color": "#E8667A"},
    {"id": "dulce", "label": "Dulce de leche", "price": 500, "color": "#B9752F"},
    {"id": "nutella", "label": "Hazelnut chocolate", "price": 500, "color": "#5A3020"},
]

FINISHES = [  # outside of the cake, per tier
    {"id": "smooth", "label": "Smooth buttercream", "note": "Satin finish, sharp edges", "price": 0},
    {"id": "textured", "label": "Combed buttercream", "note": "Hand-combed ridges", "price": 800},
    {"id": "seminaked", "label": "Semi-naked", "note": "A thin veil, sponge peeks through", "price": 0},
    {"id": "naked", "label": "Naked", "note": "Every layer on show", "price": 0},
    {"id": "fondant", "label": "Fondant", "note": "Porcelain-smooth, holds any color", "price": 2500},
]

COLORS = [
    {"id": "cream", "label": "Vanilla cream", "hex": "#FBF3E4"},
    {"id": "white", "label": "Snow", "hex": "#FFFFFF"},
    {"id": "blush", "label": "Blush", "hex": "#F4C7CF"},
    {"id": "bordeaux", "label": "Bordeaux", "hex": "#7A1A35"},
    {"id": "lilac", "label": "Lilac", "hex": "#D3C2EA"},
    {"id": "sky", "label": "Powder blue", "hex": "#BFD9EE"},
    {"id": "sage", "label": "Sage", "hex": "#C3D3B6"},
    {"id": "butter", "label": "Butter", "hex": "#F8E3A0"},
    {"id": "peach", "label": "Peach", "hex": "#F7C9A6"},
    {"id": "mocha", "label": "Mocha", "hex": "#9C6B50"},
    {"id": "noir", "label": "Noir", "hex": "#2B1A1F"},
]
CUSTOM_COLOR_PRICE = 500   # any other color from the picker

DRIPS = [
    {"id": "none", "label": "No drip", "price": 0},
    {"id": "chocolate", "label": "Dark chocolate", "price": 1200, "hex": "#3B1E15"},
    {"id": "caramel", "label": "Caramel", "price": 1200, "hex": "#C27A2C"},
    {"id": "white", "label": "White chocolate", "price": 1200, "hex": "#FFF8EC"},
    {"id": "pink", "label": "Strawberry", "price": 1200, "hex": "#E77C93"},
    {"id": "gold", "label": "Gold", "price": 2000, "hex": "#D4AF37"},
]

BORDERS = [
    {"id": "none", "label": "None", "price": 0},
    {"id": "pearls", "label": "Pearl beads", "price": 600},
    {"id": "shells", "label": "Piped shells", "price": 600},
    {"id": "rosettes", "label": "Rosettes", "price": 900},
]

DECOR = [    # toppings, any number
    {"id": "berries", "label": "Fresh berries", "price": 1800},
    {"id": "flowers", "label": "Fresh flowers", "price": 2800},
    {"id": "macarons", "label": "Macarons", "price": 2200},
    {"id": "goldleaf", "label": "Gold leaf", "price": 1500},
    {"id": "sprinkles", "label": "Sprinkles", "price": 600},
    {"id": "shards", "label": "Chocolate shards", "price": 1200},
    {"id": "pearls", "label": "Sugar pearls", "price": 800},
    {"id": "candles", "label": "Candles", "price": 400},
    {"id": "bow", "label": "Satin bow", "price": 1000},
]

TOPPERS = [
    {"id": "none", "label": "No topper", "price": 0},
    {"id": "script", "label": "Script topper", "note": "Your words in gold acrylic", "price": 1800},
    {"id": "number", "label": "Number candles", "note": "Gold numerals for the age", "price": 600},
]

EXTRAS = [   # dietary, per tier
    {"id": "glutenfree", "label": "Gluten-friendly sponge", "note": "Per tier", "price": 1500},
    {"id": "eggless", "label": "Eggless sponge", "note": "Per tier", "price": 1000},
]

# Signature designs open the builder pre-filled.
SIGNATURES = [
    {"id": "lecreme", "name": "La Rose", "blurb": "Blush buttercream, fresh flowers and pearl beads.",
     "design": {"shape": "round", "tiers": 2, "size": "8", "flavors": ["vanilla", "redvelvet"], "fillings": ["strawberry", "creamcheese"],
                "finish": "smooth", "color": "blush", "drip": "none", "border": "pearls", "decor": ["flowers", "pearls"], "topper": "none"}},
    {"id": "noir", "name": "Noir", "blurb": "Dark chocolate, ganache, gold drip and gold leaf.",
     "design": {"shape": "round", "tiers": 1, "size": "8", "flavors": ["chocolate"], "fillings": ["ganache"],
                "finish": "smooth", "color": "noir", "drip": "gold", "border": "none", "decor": ["goldleaf", "shards"], "topper": "none"}},
    {"id": "jardin", "name": "Jardin", "blurb": "Semi-naked lemon, berries and wild flowers.",
     "design": {"shape": "round", "tiers": 2, "size": "8", "flavors": ["lemon", "lemon"], "fillings": ["lemoncurd", "vanillabc"],
                "finish": "seminaked", "color": "cream", "drip": "none", "border": "none", "decor": ["berries", "flowers"], "topper": "none"}},
    {"id": "fiesta", "name": "Fiesta", "blurb": "Confetti sponge, strawberry drip, sprinkles and candles.",
     "design": {"shape": "round", "tiers": 1, "size": "6", "flavors": ["funfetti"], "fillings": ["vanillabc"],
                "finish": "smooth", "color": "sky", "drip": "pink", "border": "shells", "decor": ["sprinkles", "candles"], "topper": "number", "number": "7"}},
    {"id": "grand", "name": "Le Grand", "blurb": "Three tiers of fondant with rosettes and a satin bow.",
     "design": {"shape": "round", "tiers": 3, "size": "10", "flavors": ["vanilla", "almond", "vanilla"], "fillings": ["vanillabc", "strawberry", "vanillabc"],
                "finish": "fondant", "color": "white", "drip": "none", "border": "rosettes", "decor": ["bow", "flowers"], "topper": "script", "topper_text": "Forever"}},
    {"id": "dulce", "name": "Dulce", "blurb": "Tres leches, dulce de leche and a caramel drip.",
     "design": {"shape": "square", "tiers": 1, "size": "8", "flavors": ["tres"], "fillings": ["dulce"],
                "finish": "textured", "color": "butter", "drip": "caramel", "border": "pearls", "decor": ["macarons"], "topper": "none"}},
]

GROUPS = {"shapes": SHAPES, "sizes": SIZES, "sheets": SHEETS, "flavors": FLAVORS, "fillings": FILLINGS,
          "finishes": FINISHES, "colors": COLORS, "drips": DRIPS, "borders": BORDERS, "decor": DECOR,
          "toppers": TOPPERS, "extras": EXTRAS}
PRICED = ("sizes", "sheets", "flavors", "fillings", "finishes", "drips", "borders", "decor", "toppers", "extras")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
MAX_TIERS = 3
TEXT_MAX = 40


# --------------------------------------------------------------------- owner overrides
def _overrides():
    s = store.get_settings()
    try:
        prices = json.loads(s.get("prices") or "{}")
    except ValueError:
        prices = {}
    try:
        hidden = set(json.loads(s.get("hidden") or "[]"))
    except ValueError:
        hidden = set()
    return prices, hidden


def menu(include_hidden=False):
    """The menu with the owner's prices applied (and hidden options removed unless asked)."""
    prices, hidden = _overrides()
    out = {}
    for group, items in GROUPS.items():
        rows = []
        for it in items:
            key = f"{group}.{it['id']}"
            row = dict(it, key=key, hidden=key in hidden)
            if group in PRICED and key in prices:
                try:
                    row["price"] = max(0, int(prices[key]))
                except (TypeError, ValueError):
                    pass
            if include_hidden or not row["hidden"]:
                rows.append(row)
        out[group] = rows
    out["custom_color_price"] = int(prices.get("custom_color", CUSTOM_COLOR_PRICE)) if str(prices.get("custom_color", "")).isdigit() else CUSTOM_COLOR_PRICE
    out["signatures"] = SIGNATURES
    out["max_tiers"] = MAX_TIERS
    return out


def tier_sizes(bottom, tiers):
    """Sizes from the bottom up: an 10" base with 3 tiers is 10, 8, 6."""
    b = int(bottom)
    return [str(b - 2 * i) for i in range(tiers)]


# --------------------------------------------------------------------------- cleaning
def clean(raw):
    """Turn whatever the browser sent into a valid design, or raise ValueError with a reason."""
    if not isinstance(raw, dict):
        raise ValueError("The design didn't come through. Please try again.")
    m = menu()
    ids = {g: {o["id"]: o for o in m[g]} for g in GROUPS}

    def pick(group, value, default=None):
        v = str(value or "")
        if v in ids[group]:
            return v
        if default is not None:
            return default
        raise ValueError(f"Please choose a {group[:-1]}.")

    d = {"shape": pick("shapes", raw.get("shape"), "round")}
    if d["shape"] == "sheet":
        d["tiers"] = 1
        d["size"] = pick("sheets", raw.get("size"), "quarter")
        sizes = [d["size"]]
    else:
        try:
            tiers = int(raw.get("tiers") or 1)
        except (TypeError, ValueError):
            tiers = 1
        d["tiers"] = min(max(tiers, 1), MAX_TIERS)
        d["size"] = pick("sizes", raw.get("size"), "8")
        sizes = tier_sizes(d["size"], d["tiers"])
        if any(s not in ids["sizes"] for s in sizes):
            raise ValueError(f'A {d["tiers"]}-tier cake needs a bigger base. Pick a larger bottom tier.')
    d["sizes"] = sizes
    fl = list(raw.get("flavors") or [])
    fi = list(raw.get("fillings") or [])
    d["flavors"] = [pick("flavors", fl[i] if i < len(fl) else "", "vanilla") for i in range(d["tiers"])]
    d["fillings"] = [pick("fillings", fi[i] if i < len(fi) else "", "vanillabc") for i in range(d["tiers"])]
    d["finish"] = pick("finishes", raw.get("finish"), "smooth")
    color = str(raw.get("color") or "cream")
    if color in ids["colors"]:
        d["color"], d["custom_hex"] = color, ""
    elif HEX_RE.match(color):
        d["color"], d["custom_hex"] = "custom", color.upper()
    else:
        d["color"], d["custom_hex"] = "cream", ""
    d["drip"] = pick("drips", raw.get("drip"), "none")
    d["border"] = pick("borders", raw.get("border"), "none")
    d["decor"] = sorted({x for x in (raw.get("decor") or []) if str(x) in ids["decor"]})
    d["topper"] = pick("toppers", raw.get("topper"), "none")
    d["topper_text"] = _text(raw.get("topper_text")) if d["topper"] == "script" else ""
    num = re.sub(r"[^0-9]", "", str(raw.get("number") or ""))[:3]
    d["number"] = num if d["topper"] == "number" else ""
    if d["topper"] == "number" and not num:
        raise ValueError("Add the number for the candles, or choose a different topper.")
    if d["topper"] == "script" and not d["topper_text"]:
        raise ValueError("Write the words for the topper, or choose a different topper.")
    d["message"] = _text(raw.get("message"))
    d["extras"] = sorted({x for x in (raw.get("extras") or []) if str(x) in ids["extras"]})
    d["notes"] = str(raw.get("notes") or "").strip()[:600]
    return d


def _text(v):
    return re.sub(r"\s+", " ", str(v or "")).strip()[:TEXT_MAX]


# --------------------------------------------------------------------------- pricing
def quote(d):
    """Line items and total for a cleaned design. Returns dict with cents."""
    m = menu(include_hidden=True)
    by = {g: {o["id"]: o for o in m[g]} for g in GROUPS}
    lines = []

    def add(label, cents, qty=1):
        if cents:
            lines.append({"label": label, "cents": cents * qty, "qty": qty})

    if d["shape"] == "sheet":
        s = by["sheets"][d["size"]]
        add(s["label"], s["price"])
        servings = s["servings"]
    else:
        servings = 0
        pct = by["shapes"][d["shape"]].get("pct", 0)
        for i, size in enumerate(d["sizes"]):
            s = by["sizes"][size]
            servings += s["servings"]
            base = s["price"] + s["price"] * pct // 100
            add(f'{"Tier " + str(i + 1) + ", " if d["tiers"] > 1 else ""}{s["label"]} {d["shape"]}', base)
    for i in range(d["tiers"]):
        tier = f" (tier {i + 1})" if d["tiers"] > 1 else ""
        f = by["flavors"][d["flavors"][i]]
        add(f["label"] + tier, f["price"])
        fi = by["fillings"][d["fillings"][i]]
        add(fi["label"] + tier, fi["price"])
    fin = by["finishes"][d["finish"]]
    add(fin["label"], fin["price"], d["tiers"])
    if d["color"] == "custom":
        add("Custom color match", m["custom_color_price"])
    dr = by["drips"][d["drip"]]
    add(f'{dr["label"]} drip', dr["price"], d["tiers"] if d["drip"] != "none" else 1)
    bo = by["borders"][d["border"]]
    add(f'{bo["label"]} border', bo["price"], d["tiers"])
    for x in d["decor"]:
        add(by["decor"][x]["label"], by["decor"][x]["price"])
    tp = by["toppers"][d["topper"]]
    add(tp["label"], tp["price"])
    for x in d["extras"]:
        add(by["extras"][x]["label"], by["extras"][x]["price"], d["tiers"])
    total = sum(l["cents"] for l in lines)
    return {"lines": lines, "total": total, "servings": servings, "units": units(d), "lead_days": lead_days(d)}


def units(d):
    """How much of a day's kitchen capacity this cake uses (one per tier, two for a full sheet)."""
    if d["shape"] == "sheet":
        return 2 if d["size"] == "full" else 1
    return d["tiers"] + (1 if d["finish"] == "fondant" else 0)


def lead_days(d):
    """Extra days on top of the bakery's base notice."""
    extra = 0
    if d["tiers"] == 2:
        extra += 1
    elif d["tiers"] >= 3:
        extra += 2
    if d["finish"] == "fondant":
        extra += 1
    if d["color"] == "custom":
        extra += 1
    return extra


def describe(d):
    """A plain-language summary for emails and the kitchen ticket."""
    m = menu(include_hidden=True)
    by = {g: {o["id"]: o for o in m[g]} for g in GROUPS}
    if d["shape"] == "sheet":
        head = by["sheets"][d["size"]]["label"]
    else:
        head = f'{d["tiers"]}-tier {d["shape"]} ({" / ".join(s + chr(34) for s in d["sizes"])})'
    rows = [head]
    for i in range(d["tiers"]):
        rows.append(f'{"Tier " + str(i + 1) + ": " if d["tiers"] > 1 else ""}{by["flavors"][d["flavors"][i]]["label"]} with {by["fillings"][d["fillings"][i]]["label"].lower()}')
    color = d["custom_hex"] if d["color"] == "custom" else by["colors"][d["color"]]["label"]
    rows.append(f'{by["finishes"][d["finish"]]["label"]}, {color}')
    if d["drip"] != "none":
        rows.append(f'{by["drips"][d["drip"]]["label"]} drip')
    if d["border"] != "none":
        rows.append(f'{by["borders"][d["border"]]["label"]} border')
    if d["decor"]:
        rows.append("Decor: " + ", ".join(by["decor"][x]["label"].lower() for x in d["decor"]))
    if d["topper"] == "script":
        rows.append(f'Script topper: "{d["topper_text"]}"')
    elif d["topper"] == "number":
        rows.append(f'Number candles: {d["number"]}')
    if d["message"]:
        rows.append(f'Piped message: "{d["message"]}"')
    if d["extras"]:
        rows.append(", ".join(by["extras"][x]["label"] for x in d["extras"]))
    if d.get("notes"):
        rows.append(f'Notes: {d["notes"]}')
    return rows
