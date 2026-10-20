/* The cake designer: six steps, a live cake, a live price and a live pickup calendar.
 * Every word goes through _t() so the page follows the EN/ES switch. */
(function () {
  "use strict";
  const M = window.LC_MENU, CFG = window.LC_CFG, LOC = window.LC_LOCALE || "en-US", ES = window.LC_LANG === "es";
  const _t = window._t;
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = c => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
  const plus = c => c ? `+${money(c)}` : "";
  const by = (group, id) => (M[group] || []).find(o => o.id === id) || {};
  const low = s => ES && s ? s.charAt(0).toLowerCase() + s.slice(1) : (s || "").toLowerCase();
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

  const STEPS = [
    { id: "size", label: _t("Size"), title: _t("How big is the celebration?") },
    { id: "flavor", label: _t("Flavor"), title: _t("What's inside") },
    { id: "finish", label: _t("Finish"), title: _t("The outside") },
    { id: "decor", label: _t("Decorate"), title: _t("The finishing touches") },
    { id: "pickup", label: _t("Pickup"), title: _t("When do you need it?") },
    { id: "review", label: _t("Review"), title: _t("Almost done") },
  ];
  const DEFAULT = { shape: "round", tiers: 1, size: "8", flavors: ["vanilla"], fillings: ["vanillabc"], finish: "smooth", color: "blush",
    drip: "none", border: "pearls", decor: ["berries"], topper: "none", topper_text: "", number: "", message: "", extras: [], notes: "" };
  const tierName = (i, n) => i === 0 ? _t("Bottom") : i === n - 1 ? _t("Top") : _t("Middle");
  const tierTabName = (i, n) => i === 0 ? _t("Bottom tier") : i === n - 1 ? _t("Top tier") : _t("Middle tier");

  // ------------------------------------------------------------------ state
  let d = loadStart();
  let step = 0, maxStep = 0, view = "outside", viewPinned = false, tierTab = 0;
  let quote = null, quoteSeq = 0, shownTotal = 0;
  let cal = { month: null, days: [], key: "", date: "", time: "", slots: [], loading: false };
  let who = { name: "", phone: "", email: "", occasion: "" };
  let photo = null, photoUrl = "";
  try { Object.assign(who, JSON.parse(localStorage.getItem("lc-who") || "{}")); } catch (e) { /* ignore */ }

  function loadStart() {
    const h = location.hash.match(/#d=([^&]+)/);
    if (h) { try { return fix(JSON.parse(decodeURIComponent(escape(atob(h[1]))))); } catch (e) { /* bad link */ } }
    if (window.LC_START) return fix(window.LC_START);
    try { const s = JSON.parse(localStorage.getItem("lc-draft") || "null"); if (s) return fix(s); } catch (e) { /* ignore */ }
    return fix(DEFAULT);
  }
  function fix(x) {
    x = Object.assign({}, DEFAULT, x || {});
    if (x.color === "custom" && x.custom_hex) x.color = x.custom_hex;
    x.decor = [...(x.decor || [])]; x.extras = [...(x.extras || [])];
    x.flavors = [...(x.flavors || [])]; x.fillings = [...(x.fillings || [])];
    syncTiers(x);
    return x;
  }
  function tierCount(x) { return x.shape === "sheet" ? 1 : (x.tiers || 1); }
  function syncTiers(x) {
    const n = tierCount(x);
    while (x.flavors.length < n) x.flavors.push(x.flavors[x.flavors.length - 1] || "vanilla");
    while (x.fillings.length < n) x.fillings.push(x.fillings[x.fillings.length - 1] || "vanillabc");
    x.flavors.length = n; x.fillings.length = n;
    if (x.shape === "sheet") { if (!M.sheets.some(s => s.id === x.size)) x.size = "quarter"; }
    else {
      if (!M.sizes.some(s => s.id === x.size)) x.size = "8";
      const min = 6 + 2 * (n - 1);
      if (+x.size < min) x.size = String(min);
    }
  }
  function save() { try { localStorage.setItem("lc-draft", JSON.stringify(d)); } catch (e) { /* private mode */ } }

  // ------------------------------------------------------------------ cake
  const svg = $("#cake");
  let viewer = null;
  function draw() {
    const opts = { view, stagger: 30, highlight: STEPS[step].id === "flavor" && tierCount(d) > 1 ? tierTab : -1 };
    if (viewer) viewer.update(d, opts); else LCake.render(svg, d, M, opts);
    const n = tierCount(d);
    $("#layers").innerHTML = Array.from({ length: n }, (_, i) => {
      const fl = by("flavors", d.flavors[i]), fi = by("fillings", d.fillings[i]);
      const name = n === 1 ? "" : `<b>${tierName(i, n)}</b> `;
      return `<li><span class="sw" style="background:${fl.color}"></span><span class="sw" style="background:${fi.color}"></span>${name}${esc(_t("{a} with {b}", { a: fl.label, b: low(fi.label) }))}</li>`;
    }).reverse().join("");
    $("#cake-desc").textContent = describe();
  }
  function describe() {
    const color = d.color[0] === "#" ? _t("custom color") : low(by("colors", d.color).label);
    const shape = low(by("shapes", d.shape).label);
    let s = _t(tierCount(d) > 1 ? "{n}-tier {shape} cake, {finish}, {color}" : "1-tier {shape} cake, {finish}, {color}", { n: tierCount(d), shape, finish: low(by("finishes", d.finish).label), color });
    if (d.decor.length) s += ", " + _t("with {x}", { x: d.decor.map(x => low(by("decor", x).label)).join(", ") });
    return s;
  }

  // ----------------------------------------------------------------- price
  let qTimer = null;
  function requote() {
    clearTimeout(qTimer);
    qTimer = setTimeout(async () => {
      const seq = ++quoteSeq;
      const body = Object.assign({}, d);
      if (body.topper === "script" && !body.topper_text) body.topper_text = "Your words";
      if (body.topper === "number" && !body.number) body.number = "1";
      try {
        const r = await fetch("/api/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ design: body }) });
        const j = await r.json();
        if (seq !== quoteSeq || !r.ok) return;
        const prevKey = quote ? `${quote.quote.units}-${quote.quote.lead_days}` : "";
        quote = j;
        paintBar();
        if (prevKey && prevKey !== `${j.quote.units}-${j.quote.lead_days}`) loadCalendar(true);
        if (STEPS[step].id === "review") renderStep();
      } catch (e) { /* offline: keep last price */ }
    }, 160);
  }
  function depositCents() {
    if (!quote) return 0;
    const t = quote.quote.total;
    return Math.max(Math.floor(t * CFG.depositPct / 100), CFG.payments ? Math.min(t, 50) : 0);
  }
  function paintBar() {
    if (!quote) return;
    const q = quote.quote, to = q.total;
    const from = shownTotal, t0 = performance.now();
    const el = $("#bar-total");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !from) { el.textContent = money(to); }
    else {
      (function tick(now) {
        const k = Math.min((now - t0) / 380, 1), e = 1 - Math.pow(1 - k, 3);
        el.textContent = money(Math.round((from + (to - from) * e) / 100) * 100);
        if (k < 1) requestAnimationFrame(tick); else el.textContent = money(to);
      })(t0);
    }
    shownTotal = to;
    let when;
    if (cal.date) when = cal.time ? _t("Pickup {date} at {time}", { date: shortLabel(cal.date), time: fmtTime(cal.time) }) : _t("Pickup {date}", { date: shortLabel(cal.date) });
    else when = quote.next_available ? _t("Ready as soon as {date}", { date: shortLabel(quote.next_available) }) : _t("Call us for the next opening");
    $("#bar-meta").textContent = `${_t("Serves about {n}", { n: q.servings })}. ${when}`;
  }

  // ------------------------------------------------------------- calendar
  function calKey() { return quote ? `${quote.quote.units}-${quote.quote.lead_days}` : "1-0"; }
  async function loadCalendar(revalidate) {
    if (!cal.month) { const t = new Date(); cal.month = new Date(t.getFullYear(), t.getMonth(), 1); }
    const [u, x] = calKey().split("-");
    const start = iso(cal.month);
    cal.loading = true;
    if (STEPS[step].id === "pickup") renderStep();
    try {
      const r = await fetch(`/api/calendar?units=${u}&extra=${x}&start=${start}&days=${daysInMonth(cal.month)}`);
      const j = await r.json();
      cal.days = j.days; cal.today = j.today; cal.earliest = j.earliest; cal.key = calKey();
    } catch (e) { cal.days = []; }
    cal.loading = false;
    if (revalidate && cal.date) {
      const day = cal.days.find(x => x.date === cal.date);
      if (day && !["open", "limited"].includes(day.status)) {
        toast(_t("{date} doesn't fit this design anymore. Pick another day.", { date: cap(fmtDate(cal.date)) }));
        cal.date = ""; cal.time = ""; cal.slots = [];
      } else if (cal.date) { await loadSlots(cal.date); }
    }
    if (STEPS[step].id === "pickup") renderStep();
    paintBar();
  }
  async function loadSlots(date) {
    const [u, x] = calKey().split("-");
    try {
      const r = await fetch(`/api/slots?date=${date}&units=${u}&extra=${x}`);
      const j = await r.json();
      cal.slots = j.slots || [];
      if (cal.time && !cal.slots.some(s => s.time === cal.time && s.open)) cal.time = "";
    } catch (e) { cal.slots = []; }
  }
  // Openings change as other people book; refresh quietly while the pickup step is open.
  setInterval(() => { if (STEPS[step].id === "pickup" && !document.hidden) loadCalendar(true); }, 30000);

  const iso = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  const daysInMonth = dt => new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
  const parseIso = s => { const [y, m, dd] = s.split("-").map(Number); return new Date(y, m - 1, dd); };
  const fmtDate = s => parseIso(s).toLocaleDateString(LOC, { weekday: "long", month: "long", day: "numeric" });
  const shortLabel = s => s ? parseIso(s).toLocaleDateString(LOC, { weekday: "short", month: "short", day: "numeric" }) : "";
  function fmtTime(t) {
    const [h, m] = t.split(":").map(Number);
    const ap = ES ? (h < 12 ? "a. m." : "p. m.") : (h < 12 ? "AM" : "PM");
    return `${(h % 12) || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${ap}`;
  }
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(x => _t(x));

  // ----------------------------------------------------------- UI pieces
  function chip(attrs, on, inner, disabled) {
    return `<button type="button" class="chip${on ? " is-on" : ""}" aria-pressed="${on}" ${attrs}${disabled ? " disabled" : ""}>${inner}</button>`;
  }
  function priceTag(c, unit) { return c ? `<span class="chip-price">${plus(c)}${unit || ""}</span>` : ""; }
  function group(title, hint, body, id) {
    return `<fieldset class="grp"${id ? ` id="${id}"` : ""}><legend>${title}</legend>${hint ? `<p class="grp-hint">${hint}</p>` : ""}${body}</fieldset>`;
  }

  function stepSize() {
    let h = group(_t("Shape"), "", `<div class="cards cards-3">${M.shapes.map(s => `
      <button type="button" class="card${d.shape === s.id ? " is-on" : ""}" aria-pressed="${d.shape === s.id}" data-set="shape" data-v="${s.id}">
        ${shapeIcon(s.id)}<span class="card-t">${esc(s.label)}</span><span class="card-n">${esc(s.note)}</span>
      </button>`).join("")}</div>`);
    if (d.shape !== "sheet") {
      h += group(_t("Tiers"), "", `<div class="seg seg-lg" role="group" aria-label="${_t("Tiers")}">${[1, 2, 3].slice(0, M.max_tiers).map(n =>
        `<button type="button" class="seg-btn${d.tiers === n ? " is-on" : ""}" aria-pressed="${d.tiers === n}" data-set="tiers" data-v="${n}">${n === 1 ? _t("1 tier") : _t("{n} tiers", { n })}</button>`).join("")}</div>`);
      const min = 6 + 2 * (d.tiers - 1);
      h += group(d.tiers > 1 ? _t("Bottom tier size") : _t("Size"), d.tiers > 1 ? _t("Each tier above is 2 inches smaller.") : "", `<div class="chips">${M.sizes.map(s => {
        const n = d.tiers, sizes = Array.from({ length: n }, (_, i) => +s.id - 2 * i);
        const serv = sizes.reduce((a, z) => a + ((by("sizes", String(z)).servings) || 0), 0);
        return chip(`data-set="size" data-v="${s.id}"`, d.size === s.id, `<span class="chip-big">${esc(s.label)}</span><span class="chip-sub">${_t("Serves {n}", { n: serv })}</span>`, +s.id < min || sizes.some(z => !by("sizes", String(z)).id));
      }).join("")}</div>`);
    } else {
      h += group(_t("Size"), "", `<div class="chips">${M.sheets.map(s => chip(`data-set="size" data-v="${s.id}"`, d.size === s.id,
        `<span class="chip-big">${esc(s.label)}</span><span class="chip-sub">${_t("Serves {n}", { n: s.servings })}</span>`)).join("")}</div>`);
    }
    return h;
  }
  function shapeIcon(id) {
    const p = { round: '<ellipse cx="24" cy="14" rx="16" ry="5"/><path d="M8 14v16c0 3 7 6 16 6s16-3 16-6V14"/>',
      square: '<path d="M10 14h28l-4-6H14z"/><path d="M10 14v20h28V14"/>', sheet: '<path d="M4 20h40l-6-7H10z"/><path d="M4 20v10h40V20"/>' }[id];
    return `<svg class="card-ico" viewBox="0 0 48 40" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6">${p}</svg>`;
  }

  function stepFlavor() {
    const n = tierCount(d);
    if (tierTab >= n) tierTab = 0;
    let h = "";
    if (n > 1) {
      h += `<div class="tabs" role="tablist" aria-label="${_t("Tier")}">${Array.from({ length: n }, (_, i) =>
        `<button type="button" role="tab" class="tab${tierTab === i ? " is-on" : ""}" aria-selected="${tierTab === i}" data-tier="${i}">${tierTabName(i, n)}</button>`).join("")}
        <button type="button" class="tab-link" data-act="same-all">${_t("Use for all tiers")}</button></div>`;
    }
    h += group(_t("Sponge"), "", `<div class="chips">${M.flavors.map(f => chip(`data-flavor="${f.id}"`, d.flavors[tierTab] === f.id,
      `<span class="dot-sw" style="background:${f.color}"></span>${esc(f.label)}${priceTag(f.price)}`)).join("")}</div>`);
    h += group(_t("Filling"), "", `<div class="chips">${M.fillings.map(f => chip(`data-filling="${f.id}"`, d.fillings[tierTab] === f.id,
      `<span class="dot-sw" style="background:${f.color}"></span>${esc(f.label)}${priceTag(f.price)}`)).join("")}</div>`);
    return h;
  }

  function stepFinish() {
    const n = tierCount(d), per = n > 1 ? " " + _t("per tier") : "";
    let h = group(_t("Finish"), "", `<div class="cards cards-2">${M.finishes.map(f => `
      <button type="button" class="card card-row${d.finish === f.id ? " is-on" : ""}" aria-pressed="${d.finish === f.id}" data-set="finish" data-v="${f.id}">
        <span class="card-t">${esc(f.label)}</span><span class="card-n">${esc(f.note)}</span>${f.price ? `<span class="card-p">${plus(f.price)}${per}</span>` : ""}
      </button>`).join("")}</div>`);
    const custom = d.color[0] === "#";
    h += group(d.finish === "naked" ? _t("Accent color") : _t("Color"), d.finish === "naked" ? _t("Used for borders and piping.") : "", `<div class="swatches">${M.colors.map(c =>
      `<button type="button" class="swatch${d.color === c.id ? " is-on" : ""}" aria-pressed="${d.color === c.id}" data-set="color" data-v="${c.id}" style="--c:${c.hex}"><span class="swatch-dot"></span><span class="swatch-l">${esc(c.label)}</span></button>`).join("")}
      <label class="swatch swatch-custom${custom ? " is-on" : ""}" style="--c:${custom ? d.color : "#ffffff"}"><span class="swatch-dot"><input type="color" id="color-pick" value="${custom ? d.color : "#E6A4B4"}" aria-label="${_t("Pick any color")}"></span><span class="swatch-l">${_t("Any color")}${M.custom_color_price ? ` ${plus(M.custom_color_price)}` : ""}</span></label></div>`);
    h += group(_t("Drip"), "", `<div class="chips">${M.drips.map(x => chip(`data-set="drip" data-v="${x.id}"`, d.drip === x.id,
      `${x.hex ? `<span class="dot-sw" style="background:${x.hex}"></span>` : ""}${esc(x.label)}${priceTag(x.price, x.price ? per : "")}`)).join("")}</div>`);
    h += group(_t("Border"), "", `<div class="chips">${M.borders.map(x => chip(`data-set="border" data-v="${x.id}"`, d.border === x.id,
      `${esc(x.label)}${priceTag(x.price, x.price ? per : "")}`)).join("")}</div>`);
    return h;
  }

  function stepDecor() {
    const n = tierCount(d), per = n > 1 ? " " + _t("per tier") : "";
    let h = group(_t("Toppings"), _t("Pick as many as you like."), `<div class="chips">${M.decor.map(x => chip(`data-decor="${x.id}"`, d.decor.includes(x.id),
      `<span class="chk" aria-hidden="true"></span>${esc(x.label)}${priceTag(x.price)}`)).join("")}</div>`);
    h += group(_t("On top"), "", `<div class="cards cards-3">${M.toppers.map(t => `
      <button type="button" class="card card-row${d.topper === t.id ? " is-on" : ""}" aria-pressed="${d.topper === t.id}" data-set="topper" data-v="${t.id}">
        <span class="card-t">${esc(t.label)}</span>${t.note ? `<span class="card-n">${esc(t.note)}</span>` : ""}${t.price ? `<span class="card-p">${plus(t.price)}</span>` : ""}
      </button>`).join("")}</div>
      ${d.topper === "script" ? `<label class="field"><span>${_t("Topper words")}</span><input id="f-topper" maxlength="40" value="${esc(d.topper_text)}" placeholder="${_t("Happy 30th, Ana")}" autocomplete="off"></label>` : ""}
      ${d.topper === "number" ? `<label class="field field-sm"><span>${_t("Number")}</span><input id="f-number" inputmode="numeric" maxlength="3" value="${esc(d.number)}" placeholder="7"></label>` : ""}`);
    h += group(_t("Message on the cake"), _t("Piped by hand on the front. Free."), `<label class="field"><span class="visually-hidden">${_t("Message")}</span><input id="f-message" maxlength="40" value="${esc(d.message)}" placeholder="${_t("Happy birthday, Sofia")}" autocomplete="off"><span class="field-count" id="msg-count">${d.message.length}/40</span></label>`);
    h += group(_t("Dietary"), "", `<div class="chips">${M.extras.map(x => chip(`data-extra="${x.id}"`, d.extras.includes(x.id),
      `<span class="chk" aria-hidden="true"></span>${esc(x.label)}${priceTag(x.price, per)}`)).join("")}</div>`);
    h += group(_t("Anything else?"), _t("Allergies, a theme, a color to match. We read every note."), `<label class="field"><span class="visually-hidden">${_t("Notes")}</span><textarea id="f-notes" rows="3" maxlength="600" placeholder="${_t("It's a garden party, keep it soft and natural")}">${esc(d.notes)}</textarea></label>`);
    h += group(_t("Inspiration photo"), _t("Optional. Share a picture and we'll match the feeling."), `
      <label class="drop${photo ? " has-photo" : ""}" id="drop">
        <input type="file" id="f-photo" accept="image/jpeg,image/png,image/webp" class="visually-hidden">
        ${photo ? `<img src="${photoUrl}" alt="${_t("Your inspiration photo")}"><span class="drop-t">${esc(photo.name)}</span><button type="button" class="tab-link" data-act="photo-remove">${_t("Remove")}</button>`
        : `<span class="drop-t">${_t("Add a photo")}</span><span class="drop-n">${_t("JPG, PNG or WebP, up to 10 MB")}</span>`}
      </label>`);
    return h;
  }

  function stepPickup() {
    if (!cal.month || cal.key !== calKey()) { if (!cal.loading) loadCalendar(); }
    const m = cal.month || new Date();
    const title = cap(m.toLocaleDateString(LOC, { month: "long", year: "numeric" }));
    const now = new Date(), thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lead = quote ? quote.quote.lead_days : 0;
    let note = quote && quote.next_available ? _t("This design can be ready as soon as {date}.", { date: `<b>${esc(cap(fmtDate(quote.next_available)))}</b>` }) : _t("Looking for openings…");
    if (lead) note += " " + (lead > 1 ? _t("Larger or custom designs need {n} extra days of notice.", { n: lead }) : _t("Larger or custom designs need 1 extra day of notice."));
    const WORD = { open: _t("open"), limited: _t("few spots left"), full: _t("fully booked"), closed: _t("closed"), soon: _t("not enough notice") };
    let h = `<p class="lead-note">${note}</p>`;
    h += `<div class="cal${cal.loading ? " is-loading" : ""}">
      <div class="cal-head">
        <button type="button" class="cal-nav" data-act="prev-month" aria-label="${_t("Previous month")}"${m <= thisMonth ? " disabled" : ""}>‹</button>
        <h3 class="cal-title" aria-live="polite">${title}</h3>
        <button type="button" class="cal-nav" data-act="next-month" aria-label="${_t("Next month")}">›</button>
      </div>
      <div class="cal-grid" role="grid" aria-label="${title}">
        ${DOW.map(x => `<span class="cal-dow" role="columnheader">${x}</span>`).join("")}
        ${Array.from({ length: (m.getDay() + 6) % 7 }, () => `<span></span>`).join("")}
        ${cal.days.map(day => {
          const n = +day.date.slice(8), ok = ["open", "limited"].includes(day.status);
          return `<button type="button" class="cal-day st-${day.status}${cal.date === day.date ? " is-on" : ""}" data-date="${day.date}" ${ok ? "" : "disabled"} aria-label="${cap(fmtDate(day.date))}, ${WORD[day.status]}" aria-pressed="${cal.date === day.date}">${n}</button>`;
        }).join("")}
      </div>
      <ul class="legend"><li><i class="st-open"></i>${_t("Open")}</li><li><i class="st-limited"></i>${_t("Few spots left")}</li><li><i class="st-full"></i>${_t("Booked")}</li><li><i class="st-closed"></i>${_t("Closed")}</li></ul>
    </div>`;
    if (cal.date) {
      h += group(_t("Pickup time on {date}", { date: fmtDate(cal.date) }), "", cal.slots.length ? `<div class="chips chips-time">${cal.slots.map(s =>
        chip(`data-time="${s.time}"`, cal.time === s.time, fmtTime(s.time), !s.open)).join("")}</div>` : `<p class="grp-hint">${_t("Loading times…")}</p>`, "slots");
      if (CFG.pickup) h += `<p class="grp-hint pickup-at">${_t("Pickup at {place}", { place: esc(CFG.pickup) })}</p>`;
    }
    return h;
  }

  function stepReview() {
    if (!quote) return `<p class="grp-hint">${_t("Adding it up…")}</p>`;
    const q = quote.quote, dep = depositCents();
    const lines = q.lines.map(l => `<li><span>${esc(l.label)}${l.qty > 1 ? ` <small>× ${l.qty}</small>` : ""}</span><span>${money(l.cents)}</span></li>`).join("");
    let h = `<div class="receipt">
      <div class="receipt-when">${cal.date && cal.time ? `<span><b>${esc(cap(fmtDate(cal.date)))}</b> ${_t("at")} ${fmtTime(cal.time)}</span>` : `<button type="button" class="tab-link" data-goto="4">${_t("Choose a pickup time")}</button>`}<span>${_t("Serves about {n}", { n: q.servings })}</span></div>
      <ul class="receipt-lines">${lines}</ul>
      <div class="receipt-total"><span>${_t("Total")}</span><span>${money(q.total)}</span></div>
      ${CFG.payments ? `<div class="receipt-split"><div><span>${_t("Today")}</span><b>${money(dep)}</b><small>${_t("Reserves your date")}</small></div><div><span>${_t("At pickup")}</span><b>${money(q.total - dep)}</b><small>${_t("Pay online or in person")}</small></div></div>`
        : `<p class="grp-hint">${_t("We'll call you to confirm everything.")}</p>`}
    </div>`;
    h += group(_t("Your details"), _t("We'll text you when it's ready."), `
      <div class="fields">
        <label class="field"><span>${_t("Name")}</span><input id="w-name" autocomplete="name" value="${esc(who.name)}" required></label>
        <label class="field"><span>${_t("Mobile")}</span><input id="w-phone" type="tel" autocomplete="tel" inputmode="tel" value="${esc(who.phone)}" placeholder="(555) 555-5555" required></label>
        <label class="field"><span>${_t("Email")} <small>${_t("for your receipt")}</small></span><input id="w-email" type="email" autocomplete="email" value="${esc(who.email)}"></label>
        <label class="field"><span>${_t("Occasion")} <small>${_t("optional")}</small></span><input id="w-occasion" value="${esc(who.occasion)}" placeholder="${_t("Birthday, wedding, just because")}"></label>
      </div>`);
    h += `<p class="fine">${esc(_t("The amount you pay today holds your date and our kitchen time and isn't refundable within 72 hours of pickup. Need a change? Call or text {phone}.", { phone: CFG.phone }))}</p>`;
    return h;
  }

  // ------------------------------------------------------------ rendering
  const RENDER = { size: stepSize, flavor: stepFlavor, finish: stepFinish, decor: stepDecor, pickup: stepPickup, review: stepReview };
  function renderNav() {
    $("#step-nav").innerHTML = STEPS.map((s, i) => `<li><button type="button" class="step-btn${i === step ? " is-on" : ""}${i < step || i <= maxStep ? " is-done" : ""}" data-goto="${i}" ${i > maxStep + 1 ? "disabled" : ""} aria-current="${i === step ? "step" : "false"}"><span class="step-n">${i + 1}</span><span class="step-l">${s.label}</span></button></li>`).join("");
  }
  function renderStep() {
    const focusId = document.activeElement && document.activeElement.id;
    const s = STEPS[step];
    $("#steps").innerHTML = `<div class="step-body" data-step="${s.id}"><h1 class="step-h">${s.title}</h1>${RENDER[s.id]()}</div>`;
    if (focusId && document.getElementById(focusId)) {
      const el = document.getElementById(focusId); el.focus();
      if (el.setSelectionRange && el.value != null && el.type !== "email" && el.type !== "color") el.setSelectionRange(el.value.length, el.value.length);
    }
    const next = $("#next-btn"), back = $("#back-btn");
    back.hidden = step === 0;
    if (s.id === "review") {
      next.textContent = CFG.payments && quote ? _t("Reserve for {amount}", { amount: money(depositCents()) }) : _t("Send my order");
      next.classList.add("btn-gilt"); next.classList.remove("btn-wine");
    } else {
      next.textContent = _t("Next: {step}", { step: STEPS[step + 1].label.toLowerCase() });
      next.classList.remove("btn-gilt"); next.classList.add("btn-wine");
    }
  }
  function go(i) {
    if (i > step && !validate()) return;
    step = Math.max(0, Math.min(i, STEPS.length - 1));
    maxStep = Math.max(maxStep, step);
    if (!viewPinned) setView(STEPS[step].id === "flavor" ? "inside" : "outside", false);
    renderNav(); renderStep();
    if (STEPS[step].id === "pickup") loadCalendar(true);
    const panel = $(".panel");
    if (window.innerWidth < 900) window.scrollTo({ top: 0, behavior: "smooth" }); else panel.scrollTop = 0;
    $(".step-h").setAttribute("tabindex", "-1"); $(".step-h").focus({ preventScroll: true });
  }
  function validate() {
    const s = STEPS[step].id;
    if (s === "decor") {
      if (d.topper === "script" && !d.topper_text.trim()) return bad(_t("Add the words for your topper, or pick a different topper."), "#f-topper");
      if (d.topper === "number" && !d.number) return bad(_t("Add the number for the candles."), "#f-number");
    }
    if (s === "pickup" && (!cal.date || !cal.time)) return bad(cal.date ? _t("Pick a pickup time.") : _t("Pick a pickup day."), cal.date ? "#slots" : ".cal");
    return true;
  }
  function bad(msg, sel) {
    toast(msg);
    const el = sel && $(sel);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); if (el.focus) el.focus({ preventScroll: true }); el.classList.add("shake"); setTimeout(() => el.classList.remove("shake"), 500); }
    return false;
  }
  function setView(v, pinned) {
    view = v; if (pinned) viewPinned = true;
    document.querySelectorAll("[data-view]").forEach(b => { const on = b.dataset.view === v; b.classList.toggle("is-on", on); b.setAttribute("aria-pressed", on); });
    draw();
  }
  function changed(redraw) {
    syncTiers(d); save();
    if (redraw !== false) draw();
    requote();
  }
  let toastT;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("is-on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("is-on"), 3400); }

  // --------------------------------------------------------------- events
  document.addEventListener("click", async e => {
    const b = e.target.closest("button, [data-act]");
    if (!b || b.disabled) return;
    if (b.dataset.view) return setView(b.dataset.view, true);
    if (b.dataset.goto != null) return go(+b.dataset.goto);
    if (b.dataset.set) {
      const k = b.dataset.set, v = b.dataset.v;
      d[k] = k === "tiers" ? +v : v;
      if (k === "shape") d.size = v === "sheet" ? "quarter" : (d.size in { quarter: 1, half: 1, full: 1 } ? "8" : d.size);
      if (k === "topper" && v === "number" && !d.number) d.number = "";
      changed(); renderStep(); return;
    }
    if (b.dataset.flavor) { d.flavors[tierTab] = b.dataset.flavor; changed(); renderStep(); return; }
    if (b.dataset.filling) { d.fillings[tierTab] = b.dataset.filling; changed(); renderStep(); return; }
    if (b.dataset.tier != null) { tierTab = +b.dataset.tier; renderStep(); draw(); return; }
    if (b.dataset.decor) { toggle(d.decor, b.dataset.decor); changed(); renderStep(); return; }
    if (b.dataset.extra) { toggle(d.extras, b.dataset.extra); changed(false); renderStep(); return; }
    if (b.dataset.date) {
      cal.date = b.dataset.date; cal.time = ""; cal.slots = [];
      renderStep(); paintBar(); await loadSlots(cal.date); renderStep();
      const sl = $("#slots"); if (sl && window.innerWidth < 900) sl.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (b.dataset.time) { cal.time = b.dataset.time; renderStep(); paintBar(); return; }
    const act = b.dataset.act;
    if (act === "same-all") { d.flavors = d.flavors.map(() => d.flavors[tierTab]); d.fillings = d.fillings.map(() => d.fillings[tierTab]); changed(); renderStep(); toast(_t("Every tier matches now.")); }
    if (act === "prev-month" || act === "next-month") {
      cal.month = new Date(cal.month.getFullYear(), cal.month.getMonth() + (act === "next-month" ? 1 : -1), 1);
      loadCalendar();
    }
    if (act === "photo-remove") { e.preventDefault(); photo = null; if (photoUrl) URL.revokeObjectURL(photoUrl); photoUrl = ""; renderStep(); }
  });
  function toggle(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); }

  document.addEventListener("input", e => {
    const t = e.target;
    if (t.id === "f-topper") { d.topper_text = t.value; changed(); }
    else if (t.id === "f-number") { t.value = t.value.replace(/\D/g, ""); d.number = t.value; changed(); }
    else if (t.id === "f-message") { d.message = t.value; $("#msg-count").textContent = `${t.value.length}/40`; changed(); }
    else if (t.id === "f-notes") { d.notes = t.value; save(); }
    else if (t.id === "color-pick") { d.color = t.value.toUpperCase(); changed(); const sw = t.closest(".swatch"); sw.style.setProperty("--c", t.value); document.querySelectorAll(".swatch").forEach(x => x.classList.toggle("is-on", x === sw)); }
    else if (t.id && t.id.startsWith("w-")) { who[t.id.slice(2)] = t.value; try { localStorage.setItem("lc-who", JSON.stringify(who)); } catch (er) { /* ignore */ } }
  });
  document.addEventListener("change", e => {
    if (e.target.id === "f-photo") {
      const f = e.target.files[0];
      if (!f) return;
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) return toast(_t("Please choose a JPG, PNG or WebP photo."));
      if (f.size > 10 * 1024 * 1024) return toast(_t("That photo is over 10 MB. Try a smaller one."));
      photo = f; if (photoUrl) URL.revokeObjectURL(photoUrl); photoUrl = URL.createObjectURL(f); renderStep();
    }
  });

  $("#back-btn").addEventListener("click", () => go(step - 1));
  $("#next-btn").addEventListener("click", () => STEPS[step].id === "review" ? submit() : go(step + 1));

  $("#share-btn").addEventListener("click", async () => {
    const url = `${location.origin}/build#d=${btoa(unescape(encodeURIComponent(JSON.stringify(d))))}`;
    try {
      if (navigator.share) await navigator.share({ title: _t("My cake design"), text: _t("Here's the cake I designed at {shop}", { shop: CFG.shop }), url });
      else { await navigator.clipboard.writeText(url); toast(_t("Link copied. Anyone with it can open this design.")); }
    } catch (e) { /* cancelled */ }
  });

  let sending = false;
  async function submit() {
    if (sending) return;
    if (!cal.date || !cal.time) return go(4);
    if (who.name.trim().length < 2) return bad(_t("Add your name."), "#w-name");
    if (who.phone.replace(/\D/g, "").length < 10) return bad(_t("Add a mobile number so we can text you."), "#w-phone");
    if (who.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(who.email)) return bad(_t("That email doesn't look right."), "#w-email");
    sending = true;
    const btn = $("#next-btn"), label = btn.textContent;
    btn.disabled = true; btn.textContent = CFG.payments ? _t("Opening secure checkout…") : _t("Sending…");
    const fd = new FormData();
    fd.append("design", JSON.stringify(d));
    Object.entries(who).forEach(([k, v]) => fd.append(k, v));
    fd.append("date", cal.date); fd.append("time", cal.time);
    if (photo) fd.append("photo", photo);
    try {
      const r = await fetch("/api/order", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (j.redirect) { localStorage.removeItem("lc-draft"); location.href = j.redirect; return; }
      toast(j.error || _t("Something went wrong. Please try again."));
      if (j.refresh) { cal.time = ""; await loadCalendar(true); go(4); }
      if (j.field) bad(j.error, "#w-" + j.field);
    } catch (e) { toast(_t("You seem to be offline. Check your connection and try again.")); }
    sending = false; btn.disabled = false; btn.textContent = label;
  }

  // Real 3D cake once WebGL is ready; the drawing stays as the fallback.
  function start3D() {
    if (viewer || !window.LCake3D) return;
    try { viewer = LCake3D.create($("#cake3d"), M, {}); } catch (e) { viewer = null; return; }
    $(".stage-art").classList.add("has-3d");
    draw();
    const hint = $("#spin-hint");
    hint.classList.add("is-on");
    $("#cake3d").addEventListener("cake:spun", () => hint.classList.remove("is-on"), { once: true });
    setTimeout(() => hint.classList.remove("is-on"), 6000);
  }
  window.addEventListener("lcake3d:ready", start3D);
  start3D();

  // ------------------------------------------------------------------ go
  if (location.hash.startsWith("#d=")) history.replaceState(null, "", location.pathname);
  renderNav(); renderStep(); draw(); requote(); loadCalendar();
  svg.querySelectorAll("[data-k]").forEach((n, i) => { n.classList.add("lc-in"); n.style.animationDelay = `${i * 45}ms`; });
})();
