/* Kitchen admin: orders, calendar, menu, payments, settings. Every word goes through _t(). */
(function () {
  "use strict";
  const M = window.LC_MENU, LOC = window.LC_LOCALE || "en-US", _t = window._t;
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = c => "$" + ((c || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const NEXT = { requested: ["confirmed", _t("Confirm order")], confirmed: ["baking", _t("Start baking")], baking: ["decorating", _t("Start decorating")],
    decorating: ["ready", _t("Mark ready")], ready: ["picked_up", _t("Picked up")] };
  const parseIso = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const longDate = dt => cap(dt.toLocaleDateString(LOC, { weekday: "long", month: "long", day: "numeric" }));
  const nOrders = n => n === 1 ? _t("1 order") : _t("{n} orders", { n });

  async function api(path, body) {
    const r = await fetch("/admin/api/" + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { location.reload(); throw new Error("signed out"); }
    if (!r.ok) { toast(j.error || _t("That didn't save.")); throw new Error(j.error); }
    return j;
  }
  let tt;
  function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("is-on"); clearTimeout(tt); tt = setTimeout(() => t.classList.remove("is-on"), 3000); }

  // ------------------------------------------------------------------- tabs
  function show(tab) {
    document.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("is-on", b.dataset.tab === tab));
    document.querySelectorAll("[data-pane]").forEach(p => { p.hidden = p.dataset.pane !== tab; });
    history.replaceState(null, "", "#" + tab);
    ({ orders: loadOrders, calendar: loadMonth, menu: renderMenu, payments: loadPay, settings: loadSettings })[tab]();
  }
  document.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => show(b.dataset.tab)));

  // ----------------------------------------------------------------- orders
  let scope = "upcoming", orders = [];
  document.querySelectorAll("[data-scope]").forEach(b => b.addEventListener("click", () => {
    scope = b.dataset.scope;
    document.querySelectorAll("[data-scope]").forEach(x => x.classList.toggle("is-on", x === b));
    loadOrders();
  }));
  async function loadOrders() {
    const j = await api("orders?scope=" + scope);
    orders = j.orders;
    const el = $("#orders");
    if (!orders.length) {
      el.innerHTML = `<p class="empty-note">${scope === "upcoming" ? _t("No upcoming orders yet. New orders show up here as soon as they're placed.") : _t("No orders here yet.")}</p>`;
      return;
    }
    const groups = {};
    orders.forEach(o => (groups[o.date] = groups[o.date] || []).push(o));
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    el.innerHTML = Object.keys(groups).sort(scope === "past" ? (a, b) => b.localeCompare(a) : undefined).map(date => {
      const dd = parseIso(date);
      let label = longDate(dd);
      if (date === j.today) label = _t("Today, {date}", { date: label });
      else if (dd.toDateString() === tomorrow.toDateString()) label = _t("Tomorrow, {date}", { date: label });
      return `<h2 class="day-h">${label}<span>${nOrders(groups[date].length)}</span></h2>
        <div class="o-cards">${groups[date].map(card).join("")}</div>`;
    }).join("");
    el.querySelectorAll("svg[data-i]").forEach(s => LCake.render(s, orders[+s.dataset.i].design, M));
    photoThumbs();
  }
  // Real 3D thumbnails once WebGL is ready (the drawings stay if it isn't).
  function photoThumbs() {
    if (!window.LCake3D) return;
    document.querySelectorAll("svg.ord-svg[data-i]").forEach(async s => {
      const o = orders[+s.dataset.i]; if (!o) return;
      const url = await LCake3D.snapshot(o.design, M, 200, 224);
      if (!s.isConnected) return;
      const img = new Image(); img.src = url; img.alt = ""; img.className = "ord-svg"; s.replaceWith(img);
    });
  }
  window.addEventListener("lcake3d:ready", photoThumbs);

  function card(o) {
    const i = orders.indexOf(o), nx = NEXT[o.status];
    return `<article class="o-card ord st-${o.status}" data-id="${o.id}">
      <div class="ord-top">
        <svg class="cake-svg ord-svg" data-i="${i}" aria-hidden="true"></svg>
        <div class="ord-who">
          <p class="ord-time">${esc(o.when)}</p>
          <h3>${esc(o.name)} <small>#${o.id}</small></h3>
          <p class="ord-contact"><a href="tel:${esc(o.phone)}">${esc(o.phone)}</a>${o.email ? ` <a href="mailto:${esc(o.email)}">${esc(o.email)}</a>` : ""}</p>
          ${o.occasion ? `<p class="muted">${esc(o.occasion)}</p>` : ""}
          <span class="pill pill-${o.status}">${esc(o.status_label)}</span>
        </div>
      </div>
      <ul class="o-list">${o.summary.map(l => `<li>${esc(l)}</li>`).join("")}</ul>
      ${o.photo ? `<a class="ord-photo" href="/uploads/${esc(o.photo)}" target="_blank" rel="noopener"><img src="/uploads/${esc(o.photo)}" alt="${_t("Inspiration photo")}" loading="lazy"></a>` : ""}
      <div class="ord-money"><span>${_t("Total")} <b>${money(o.total)}</b></span><span>${_t("Paid")} <b>${money(o.paid)}</b></span><span class="${o.due ? "due" : ""}">${_t("Due")} <b>${money(o.due)}</b></span></div>
      <label class="field"><span>${_t("Kitchen note")}</span><textarea rows="2" data-note="${o.id}" placeholder="${_t("Only the kitchen sees this")}">${esc(o.note)}</textarea></label>
      <div class="ord-actions">
        ${nx ? `<button class="btn btn-wine btn-sm" data-status="${nx[0]}">${nx[1]}</button>` : ""}
        ${o.due ? `<button class="btn btn-quiet btn-sm" data-paid="${(o.due / 100).toFixed(2)}">${_t("Record payment")}</button>` : ""}
        <a class="btn btn-quiet btn-sm" href="/order/${esc(o.token)}" target="_blank" rel="noopener">${_t("Customer page")}</a>
        ${!["cancelled", "picked_up"].includes(o.status) ? `<button class="btn btn-text btn-sm" data-status="cancelled">${_t("Cancel")}</button>` : ""}
      </div>
    </article>`;
  }
  $("#orders").addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    const id = b.closest("[data-id]").dataset.id;
    if (b.dataset.status) {
      if (b.dataset.status === "cancelled" && !confirm(_t("Cancel this order? The customer's page will show it as cancelled. Refunds are done in Stripe."))) return;
      await api(`orders/${id}/status`, { status: b.dataset.status }); toast(_t("Updated. The customer's page shows it now.")); loadOrders();
    }
    if (b.dataset.paid) {
      const amt = prompt(_t("Amount received (dollars)"), b.dataset.paid); if (!amt) return;
      const answer = (prompt(_t("How was it paid? cash, card, zelle or other"), _t("cash")) || "").toLowerCase().trim();
      const method = { [_t("cash")]: "cash", [_t("card")]: "card", zelle: "zelle", cash: "cash", card: "card" }[answer] || "other";
      await api(`orders/${id}/paid`, { amount: amt, method }); toast(_t("Payment recorded.")); loadOrders();
    }
  });
  let noteT;
  $("#orders").addEventListener("input", e => {
    const t = e.target.closest("[data-note]"); if (!t) return;
    clearTimeout(noteT); noteT = setTimeout(() => api(`orders/${t.dataset.note}/note`, { note: t.value }).then(() => toast(_t("Note saved."))), 700);
  });
  setInterval(() => { if (!$('[data-pane="orders"]').hidden && !document.hidden && !document.activeElement.matches("textarea")) loadOrders(); }, 45000);

  // --------------------------------------------------------------- calendar
  let month = new Date(); month = new Date(month.getFullYear(), month.getMonth(), 1);
  let mdays = [];
  document.querySelectorAll("[data-month]").forEach(b => b.addEventListener("click", () => {
    month = new Date(month.getFullYear(), month.getMonth() + (+b.dataset.month), 1); loadMonth();
  }));
  async function loadMonth() {
    const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
    const j = await api("month?m=" + key);
    mdays = j.days;
    $("#m-title").textContent = cap(month.toLocaleDateString(LOC, { month: "long", year: "numeric" }));
    $("#acal").innerHTML = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(x => `<span class="cal-dow">${_t(x)}</span>`).join("") +
      Array.from({ length: (month.getDay() + 6) % 7 }, () => "<span></span>").join("") +
      mdays.map(d => {
        const pct = d.cap ? Math.min(100, Math.round(d.used / d.cap * 100)) : 100;
        return `<button class="acal-day${d.open ? "" : " is-closed"}${d.date === j.today ? " is-today" : ""}" data-day="${d.date}">
          <span class="acal-n">${+d.date.slice(8)}</span>
          ${d.open ? `<span class="acal-bar"><i style="width:${pct}%"></i></span><span class="acal-t">${d.used}/${d.cap}${d.custom_cap ? "*" : ""}</span>${d.orders ? `<span class="acal-o">${nOrders(d.orders)}</span>` : ""}`
          : `<span class="acal-t">${d.blackout ? _t("Closed") : _t("Off")}</span>`}
        </button>`;
      }).join("");
  }
  $("#acal").addEventListener("click", e => {
    const b = e.target.closest("[data-day]"); if (!b) return;
    const d = mdays.find(x => x.date === b.dataset.day);
    $("#day-panel").innerHTML = `<div class="o-card day-edit"><h2>${longDate(parseIso(d.date))}</h2>
      <p>${_t("{orders}, {used} of {cap} capacity used.", { orders: nOrders(d.orders), used: d.used, cap: d.cap })}</p>
      <label class="switch"><input type="checkbox" id="dp-black" ${d.blackout ? "checked" : ""}><span>${_t("Closed this day (holiday, day off)")}</span></label>
      <label class="field field-sm"><span>${_t("Capacity this day")}</span><input id="dp-cap" type="number" min="0" max="500" value="${d.custom_cap ? d.cap : ""}" placeholder="${d.cap}"></label>
      <button class="btn btn-wine btn-sm" id="dp-save" data-d="${d.date}">${_t("Save day")}</button></div>`;
    $("#day-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  $("#day-panel").addEventListener("click", async e => {
    if (e.target.id !== "dp-save") return;
    const v = $("#dp-cap").value;
    await api("day", { date: e.target.dataset.d, blackout: $("#dp-black").checked, cap: v === "" ? null : +v });
    toast(_t("Day saved. The designer's calendar updates right away.")); $("#day-panel").innerHTML = ""; loadMonth();
  });

  // -------------------------------------------------------------------- menu
  const GROUPS = [["sizes", _t("Tier sizes (price per tier)")], ["sheets", _t("Sheet cakes")], ["flavors", _t("Sponges (per tier)")], ["fillings", _t("Fillings (per tier)")],
    ["finishes", _t("Finishes (per tier)")], ["drips", _t("Drips (per tier)")], ["borders", _t("Borders (per tier)")], ["decor", _t("Toppings")], ["toppers", _t("Toppers")],
    ["extras", _t("Dietary (per tier)")], ["colors", _t("Colors")], ["shapes", _t("Shapes")]];
  function renderMenu() {
    $("#menu-edit").innerHTML = GROUPS.map(([g, title]) => `<div class="o-card menu-g"><h2>${title}</h2><table class="mt"><tbody>
      ${M[g].map(o => `<tr><td>${o.hex ? `<span class="dot-sw" style="background:${o.hex}"></span>` : ""}${esc(o.label)}</td>
        <td>${"price" in o && g !== "shapes" ? `<label class="money-in"><span>$</span><input type="number" min="0" step="0.5" data-price="${o.key}" value="${(o.price / 100).toFixed(2)}" aria-label="${esc(_t("{x} price", { x: o.label }))}"></label>` : ""}</td>
        <td><label class="switch"><input type="checkbox" data-show="${o.key}" ${o.hidden ? "" : "checked"}><span>${_t("Show")}</span></label></td></tr>`).join("")}
      </tbody></table>${g === "colors" ? `<p class="muted">${_t("Custom color match")}: <label class="money-in"><span>$</span><input type="number" min="0" step="0.5" data-price="custom_color" value="${(M.custom_color_price / 100).toFixed(2)}"></label></p>` : ""}</div>`).join("");
  }
  $("#save-menu").addEventListener("click", async () => {
    const prices = {}, hidden = [];
    document.querySelectorAll("[data-price]").forEach(i => { prices[i.dataset.price] = i.value; });
    document.querySelectorAll("[data-show]").forEach(i => { if (!i.checked) hidden.push(i.dataset.show); });
    const m = await api("menu", { prices, hidden });
    Object.assign(M, m); renderMenu(); toast(_t("Menu saved. New prices show in the designer now."));
  });

  // ---------------------------------------------------------------- payments
  async function loadPay() {
    const sel = $("#pay-month");
    const j = await api("payments" + (sel.value ? "?m=" + sel.value : ""));
    if (!sel.options.length || sel.dataset.n !== String(j.months.length)) {
      const cur = sel.value;
      sel.innerHTML = `<option value="">${_t("All time")}</option>` + j.months.map(m => `<option value="${m}">${cap(new Date(m + "-02").toLocaleDateString(LOC, { month: "long", year: "numeric" }))}</option>`).join("");
      sel.value = cur; sel.dataset.n = j.months.length;
    }
    const t = j.totals, c = j.connect;
    const how = `<p class="muted split-how">${_t("How each online payment splits: the platform receives {pct}% of the payment plus Stripe's exact card fee, so Stripe's fee never comes out of the {pct}%. The bakery receives everything else, straight to its own Stripe account. Customers only see the cake price and the bakery's name.", { pct: j.pct })}</p>`;
    const connect = !j.stripe_on ? `<p>${_t("Add STRIPE_SECRET_KEY on Railway to take payments online.")}</p>`
      : c.charges ? `<p class="ok">${_t("Payouts connected. Every online payment splits automatically.")}</p>${how}
          <a class="btn btn-quiet btn-sm" href="/admin/stripe/dashboard" target="_blank" rel="noopener">${_t("Open bakery Stripe dashboard")}</a>`
      : `<p>${c.account ? _t("Stripe needs a few more details before payouts can start.") : _t("Connect the bakery's bank account through Stripe so each sale pays out automatically.")}${c.error ? ` <span class="muted">(${esc(c.error)})</span>` : ""}</p>${how}
          <a class="btn btn-gilt btn-sm" href="/admin/stripe/connect">${c.account ? _t("Finish Stripe setup") : _t("Connect payouts with Stripe")}</a>`;
    const kind = r => r.kind === "deposit" ? _t("Deposit") : r.kind === "balance" ? _t("Balance") : _t("In person ({method})", { method: _t(r.method) });
    const est = r => r.estimated ? ` <span class="muted" title="${esc(_t("Estimated until Stripe posts the exact fee"))}">*</span>` : "";
    $("#pay").innerHTML = `
      <div class="o-card connect">${connect}</div>
      <div class="tiles tiles-4">
        <div class="tile"><span>${_t("Sales")}</span><b>${money(t.gross)}</b></div>
        <div class="tile"><span>${_t("Stripe card fees")}</span><b>${money(t.stripe)}</b></div>
        <div class="tile"><span>${_t("Platform fee ({pct}%)", { pct: j.pct })}</span><b>${money(t.platform)}</b></div>
        <div class="tile tile-main"><span>${_t("Bakery earnings")}</span><b>${money(t.net)}</b></div>
      </div>
      ${t.platform_owed ? `<p class="note">${_t("Platform fee on in-person payments, not yet settled:")} <b>${money(t.platform_owed)}</b></p>` : ""}
      ${t.owed_to_bakery ? `<p class="note">${_t("Online sales taken before payouts were connected, owed to the bakery:")} <b>${money(t.owed_to_bakery)}</b></p>` : ""}
      ${t.estimated ? `<p class="note">${_t("* Estimated until Stripe posts the exact fee, usually within a minute.")}</p>` : ""}
      <div class="o-card"><table class="pt"><thead><tr><th>${_t("Date")}</th><th>${_t("Order")}</th><th>${_t("Type")}</th><th>${_t("Sale")}</th><th>${_t("Stripe fee")}</th><th>${_t("Platform ({pct}%)", { pct: j.pct })}</th><th>${_t("Bakery")}</th><th>${_t("How")}</th></tr></thead><tbody>
      ${j.rows.length ? j.rows.map(r => `<tr><td>${new Date(r.paid_at).toLocaleDateString(LOC, { month: "short", day: "numeric" })}</td>
        <td><a href="/order/${esc(r.token)}" target="_blank" rel="noopener">#${r.order_id} ${esc(r.name)}</a></td>
        <td>${esc(kind(r))}</td>
        <td>${money(r.amount_cents)}</td><td>${money(r.stripe_fee_cents)}${est(r)}</td><td>${money(r.platform_cents)}</td><td><b>${money(r.net_cents)}</b>${est(r)}</td><td class="muted">${esc(r.route)}</td></tr>`).join("")
        : `<tr><td colspan="8" class="muted">${_t("No payments yet.")}</td></tr>`}
      </tbody></table></div>`;
  }
  $("#pay-month").addEventListener("change", loadPay);

  // ---------------------------------------------------------------- settings
  const DAYS = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]].map(([k, n]) => [k, _t(n)]);
  async function loadSettings() {
    const s = await api("settings");
    const num = (k, label, hint, suffix) => `<label class="field field-sm"><span>${label}</span><span class="with-suffix"><input type="number" data-s="${k}" value="${s[k]}">${suffix ? `<i>${suffix}</i>` : ""}</span>${hint ? `<small>${hint}</small>` : ""}</label>`;
    $("#settings").innerHTML = `
      <div class="o-card"><h2>${_t("Ordering")}</h2><div class="fields fields-3">
        ${num("deposit_pct", _t("Deposit"), _t("Charged at checkout"), "%")}
        ${num("base_lead_days", _t("Notice needed"), _t("Bigger designs add more"), _t("days"))}
        ${num("booking_days", _t("Booking window"), _t("How far ahead people can order"), _t("days"))}
      </div></div>
      <div class="o-card"><h2>${_t("Kitchen capacity")}</h2><div class="fields fields-3">
        ${num("daily_capacity", _t("Per day"), _t("One per tier, plus one for fondant"), _t("units"))}
        ${num("slot_minutes", _t("Pickup slot length"), "", "min")}
        ${num("slot_capacity", _t("Pickups per slot"), "", "")}
      </div></div>
      <div class="o-card"><h2>${_t("Pickup hours")}</h2><div class="hours">${DAYS.map(([k, n]) => `<div class="hours-row">
        <label class="switch"><input type="checkbox" data-h="${k}.on" ${s.hours[k].on ? "checked" : ""}><span>${cap(n)}</span></label>
        <input type="time" data-h="${k}.start" value="${s.hours[k].start}" aria-label="${esc(_t("{day} opens", { day: n }))}"><span>${_t("to")}</span><input type="time" data-h="${k}.end" value="${s.hours[k].end}" aria-label="${esc(_t("{day} closes", { day: n }))}"></div>`).join("")}</div></div>
      <div class="o-card"><h2>${_t("Pickup place")}</h2>
        <label class="field"><span>${_t("Address")}</span><input data-t="pickup_address" value="${esc(s.pickup_address)}" placeholder="${_t("Street, city")}"></label>
        <label class="field"><span>${_t("Pickup instructions")}</span><textarea data-t="pickup_note" rows="2">${esc(s.pickup_note)}</textarea></label>
      </div>`;
  }
  $("#save-settings").addEventListener("click", async () => {
    const b = { hours: {} };
    document.querySelectorAll("[data-s]").forEach(i => { b[i.dataset.s] = i.value; });
    document.querySelectorAll("[data-t]").forEach(i => { b[i.dataset.t] = i.value; });
    document.querySelectorAll("[data-h]").forEach(i => {
      const [d, k] = i.dataset.h.split("."); b.hours[d] = b.hours[d] || {};
      b.hours[d][k] = i.type === "checkbox" ? i.checked : i.value;
    });
    await api("settings", b); toast(_t("Settings saved.")); loadSettings();
  });

  const start = (location.hash || "").slice(1);
  show(["orders", "calendar", "menu", "payments", "settings"].includes(start) ? start : "orders");
})();
