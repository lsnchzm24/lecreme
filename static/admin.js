(function () {
  "use strict";
  const M = window.LC_MENU;
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = c => "$" + ((c || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const NEXT = { requested: ["confirmed", "Confirm order"], confirmed: ["baking", "Start baking"], baking: ["decorating", "Start decorating"],
    decorating: ["ready", "Mark ready"], ready: ["picked_up", "Picked up"] };
  const parseIso = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

  async function api(path, body) {
    const r = await fetch("/admin/api/" + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { location.reload(); throw new Error("signed out"); }
    if (!r.ok) { toast(j.error || "That didn't save."); throw new Error(j.error); }
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
    if (!orders.length) { el.innerHTML = `<p class="empty-note">No ${scope === "upcoming" ? "upcoming " : ""}orders yet. New orders appear here the moment the deposit is paid.</p>`; return; }
    const groups = {};
    orders.forEach(o => (groups[o.date] = groups[o.date] || []).push(o));
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    el.innerHTML = Object.keys(groups).sort(scope === "past" ? (a, b) => b.localeCompare(a) : undefined).map(date => {
      const dd = parseIso(date);
      let label = dd.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
      if (date === j.today) label = "Today, " + label;
      else if (dd.toDateString() === tomorrow.toDateString()) label = "Tomorrow, " + label;
      return `<h2 class="day-h">${label}<span>${groups[date].length} order${groups[date].length > 1 ? "s" : ""}</span></h2>
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
      ${o.photo ? `<a class="ord-photo" href="/uploads/${esc(o.photo)}" target="_blank" rel="noopener"><img src="/uploads/${esc(o.photo)}" alt="Inspiration photo" loading="lazy"></a>` : ""}
      <div class="ord-money"><span>Total <b>${money(o.total)}</b></span><span>Paid <b>${money(o.paid)}</b></span><span class="${o.due ? "due" : ""}">Due <b>${money(o.due)}</b></span></div>
      <label class="field"><span>Kitchen note</span><textarea rows="2" data-note="${o.id}" placeholder="Only the kitchen sees this">${esc(o.note)}</textarea></label>
      <div class="ord-actions">
        ${nx ? `<button class="btn btn-wine btn-sm" data-status="${nx[0]}">${nx[1]}</button>` : ""}
        ${o.due ? `<button class="btn btn-quiet btn-sm" data-paid="${(o.due / 100).toFixed(2)}">Record payment</button>` : ""}
        <a class="btn btn-quiet btn-sm" href="/order/${esc(o.token)}" target="_blank" rel="noopener">Customer page</a>
        ${!["cancelled", "picked_up"].includes(o.status) ? `<button class="btn btn-text btn-sm" data-status="cancelled">Cancel</button>` : ""}
      </div>
    </article>`;
  }
  $("#orders").addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    const id = b.closest("[data-id]").dataset.id;
    if (b.dataset.status) {
      if (b.dataset.status === "cancelled" && !confirm("Cancel this order? The customer's page will show it as cancelled. Refunds are done in Stripe.")) return;
      await api(`orders/${id}/status`, { status: b.dataset.status }); toast("Updated. The customer's page shows it now."); loadOrders();
    }
    if (b.dataset.paid) {
      const amt = prompt("Amount received (dollars)", b.dataset.paid); if (!amt) return;
      const method = (prompt("How was it paid? cash, card, zelle or other", "cash") || "other").toLowerCase().trim();
      await api(`orders/${id}/paid`, { amount: amt, method }); toast("Payment recorded."); loadOrders();
    }
  });
  let noteT;
  $("#orders").addEventListener("input", e => {
    const t = e.target.closest("[data-note]"); if (!t) return;
    clearTimeout(noteT); noteT = setTimeout(() => api(`orders/${t.dataset.note}/note`, { note: t.value }).then(() => toast("Note saved.")), 700);
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
    $("#m-title").textContent = month.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    $("#acal").innerHTML = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(x => `<span class="cal-dow">${x}</span>`).join("") +
      Array.from({ length: (month.getDay() + 6) % 7 }, () => "<span></span>").join("") +
      mdays.map(d => {
        const pct = d.cap ? Math.min(100, Math.round(d.used / d.cap * 100)) : 100;
        return `<button class="acal-day${d.open ? "" : " is-closed"}${d.date === j.today ? " is-today" : ""}" data-day="${d.date}">
          <span class="acal-n">${+d.date.slice(8)}</span>
          ${d.open ? `<span class="acal-bar"><i style="width:${pct}%"></i></span><span class="acal-t">${d.used}/${d.cap}${d.custom_cap ? "*" : ""}</span>${d.orders ? `<span class="acal-o">${d.orders} order${d.orders > 1 ? "s" : ""}</span>` : ""}`
          : `<span class="acal-t">${d.blackout ? "Closed" : "Off"}</span>`}
        </button>`;
      }).join("");
  }
  $("#acal").addEventListener("click", e => {
    const b = e.target.closest("[data-day]"); if (!b) return;
    const d = mdays.find(x => x.date === b.dataset.day);
    const label = parseIso(d.date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    $("#day-panel").innerHTML = `<div class="o-card day-edit"><h2>${label}</h2>
      <p>${d.orders} order${d.orders === 1 ? "" : "s"}, ${d.used} of ${d.cap} capacity used.</p>
      <label class="switch"><input type="checkbox" id="dp-black" ${d.blackout ? "checked" : ""}><span>Closed this day (holiday, day off)</span></label>
      <label class="field field-sm"><span>Capacity this day</span><input id="dp-cap" type="number" min="0" max="500" value="${d.custom_cap ? d.cap : ""}" placeholder="${d.cap}"></label>
      <button class="btn btn-wine btn-sm" id="dp-save" data-d="${d.date}">Save day</button></div>`;
    $("#day-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  $("#day-panel").addEventListener("click", async e => {
    if (e.target.id !== "dp-save") return;
    const v = $("#dp-cap").value;
    await api("day", { date: e.target.dataset.d, blackout: $("#dp-black").checked, cap: v === "" ? null : +v });
    toast("Day saved. The designer's calendar updates right away."); $("#day-panel").innerHTML = ""; loadMonth();
  });

  // -------------------------------------------------------------------- menu
  const GROUPS = [["sizes", "Tier sizes (price per tier)"], ["sheets", "Sheet cakes"], ["flavors", "Sponges (per tier)"], ["fillings", "Fillings (per tier)"],
    ["finishes", "Finishes (per tier)"], ["drips", "Drips (per tier)"], ["borders", "Borders (per tier)"], ["decor", "Toppings"], ["toppers", "Toppers"],
    ["extras", "Dietary (per tier)"], ["colors", "Colors"], ["shapes", "Shapes"]];
  function renderMenu() {
    $("#menu-edit").innerHTML = GROUPS.map(([g, title]) => `<div class="o-card menu-g"><h2>${title}</h2><table class="mt"><tbody>
      ${M[g].map(o => `<tr><td>${o.hex ? `<span class="dot-sw" style="background:${o.hex}"></span>` : ""}${esc(o.label)}</td>
        <td>${"price" in o && g !== "shapes" ? `<label class="money-in"><span>$</span><input type="number" min="0" step="0.5" data-price="${o.key}" value="${(o.price / 100).toFixed(2)}" aria-label="${esc(o.label)} price"></label>` : ""}</td>
        <td><label class="switch"><input type="checkbox" data-show="${o.key}" ${o.hidden ? "" : "checked"}><span>Show</span></label></td></tr>`).join("")}
      </tbody></table>${g === "colors" ? `<p class="muted">Custom color match: <label class="money-in"><span>$</span><input type="number" min="0" step="0.5" data-price="custom_color" value="${(M.custom_color_price / 100).toFixed(2)}"></label></p>` : ""}</div>`).join("");
  }
  $("#save-menu").addEventListener("click", async () => {
    const prices = {}, hidden = [];
    document.querySelectorAll("[data-price]").forEach(i => { prices[i.dataset.price] = i.value; });
    document.querySelectorAll("[data-show]").forEach(i => { if (!i.checked) hidden.push(i.dataset.show); });
    const m = await api("menu", { prices, hidden });
    Object.assign(M, m); renderMenu(); toast("Menu saved. New prices show in the designer now.");
  });

  // ---------------------------------------------------------------- payments
  async function loadPay() {
    const sel = $("#pay-month");
    const j = await api("payments" + (sel.value ? "?m=" + sel.value : ""));
    if (!sel.options.length || sel.dataset.n !== String(j.months.length)) {
      const cur = sel.value;
      sel.innerHTML = `<option value="">All time</option>` + j.months.map(m => `<option value="${m}">${new Date(m + "-02").toLocaleDateString("en-US", { month: "long", year: "numeric" })}</option>`).join("");
      sel.value = cur; sel.dataset.n = j.months.length;
    }
    const t = j.totals, c = j.connect;
    const connect = !j.stripe_on ? `<p>Add STRIPE_SECRET_KEY on Railway to take payments online.</p>`
      : c.charges ? `<p class="ok">Payouts connected. Every online sale splits automatically: ${100 - j.pct}% to the bakery's Stripe account, ${j.pct}% platform fee.</p>
          <a class="btn btn-quiet btn-sm" href="/admin/stripe/dashboard" target="_blank" rel="noopener">Open bakery Stripe dashboard</a>`
      : `<p>${c.account ? "Stripe needs a few more details before payouts can start." : "Connect the bakery's bank account through Stripe so each sale pays out automatically."}${c.error ? ` <span class="muted">(${esc(c.error)})</span>` : ""}</p>
          <a class="btn btn-gilt btn-sm" href="/admin/stripe/connect">${c.account ? "Finish Stripe setup" : "Connect payouts with Stripe"}</a>`;
    $("#pay").innerHTML = `
      <div class="o-card connect">${connect}</div>
      <div class="tiles">
        <div class="tile"><span>Sales</span><b>${money(t.gross)}</b></div>
        <div class="tile"><span>Platform fee (${j.pct}%)</span><b>${money(t.fee)}</b></div>
        <div class="tile tile-main"><span>Bakery earnings</span><b>${money(t.net)}</b></div>
      </div>
      ${t.fee_owed ? `<p class="note">Platform fee on in-person payments, not yet settled: <b>${money(t.fee_owed)}</b></p>` : ""}
      ${t.owed_to_bakery ? `<p class="note">Online sales taken before payouts were connected, owed to the bakery: <b>${money(t.owed_to_bakery)}</b></p>` : ""}
      <div class="o-card"><table class="pt"><thead><tr><th>Date</th><th>Order</th><th>Type</th><th>Sale</th><th>Fee</th><th>Bakery</th><th>How</th></tr></thead><tbody>
      ${j.rows.length ? j.rows.map(r => `<tr><td>${new Date(r.paid_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td>
        <td><a href="/order/${esc(r.token)}" target="_blank" rel="noopener">#${r.order_id} ${esc(r.name)}</a></td>
        <td>${r.kind === "deposit" ? "Deposit" : r.kind === "balance" ? "Balance" : "In person (" + esc(r.method) + ")"}</td>
        <td>${money(r.amount_cents)}</td><td>${money(r.fee_cents)}</td><td><b>${money(r.net_cents)}</b></td><td class="muted">${esc(r.route)}</td></tr>`).join("")
        : `<tr><td colspan="7" class="muted">No payments yet.</td></tr>`}
      </tbody></table></div>`;
  }
  $("#pay-month").addEventListener("change", loadPay);

  // ---------------------------------------------------------------- settings
  const DAYS = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];
  async function loadSettings() {
    const s = await api("settings");
    const num = (k, label, hint, suffix) => `<label class="field field-sm"><span>${label}</span><span class="with-suffix"><input type="number" data-s="${k}" value="${s[k]}">${suffix ? `<i>${suffix}</i>` : ""}</span>${hint ? `<small>${hint}</small>` : ""}</label>`;
    $("#settings").innerHTML = `
      <div class="o-card"><h2>Ordering</h2><div class="fields fields-3">
        ${num("deposit_pct", "Deposit", "Charged at checkout", "%")}
        ${num("base_lead_days", "Notice needed", "Bigger designs add more", "days")}
        ${num("booking_days", "Booking window", "How far ahead people can order", "days")}
      </div></div>
      <div class="o-card"><h2>Kitchen capacity</h2><div class="fields fields-3">
        ${num("daily_capacity", "Per day", "One per tier, plus one for fondant", "units")}
        ${num("slot_minutes", "Pickup slot length", "", "min")}
        ${num("slot_capacity", "Pickups per slot", "", "")}
      </div></div>
      <div class="o-card"><h2>Pickup hours</h2><div class="hours">${DAYS.map(([k, n]) => `<div class="hours-row">
        <label class="switch"><input type="checkbox" data-h="${k}.on" ${s.hours[k].on ? "checked" : ""}><span>${n}</span></label>
        <input type="time" data-h="${k}.start" value="${s.hours[k].start}" aria-label="${n} opens"><span>to</span><input type="time" data-h="${k}.end" value="${s.hours[k].end}" aria-label="${n} closes"></div>`).join("")}</div></div>
      <div class="o-card"><h2>Pickup place</h2>
        <label class="field"><span>Address</span><input data-t="pickup_address" value="${esc(s.pickup_address)}" placeholder="Street, city"></label>
        <label class="field"><span>Pickup instructions</span><textarea data-t="pickup_note" rows="2">${esc(s.pickup_note)}</textarea></label>
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
    await api("settings", b); toast("Settings saved."); loadSettings();
  });

  const start = (location.hash || "").slice(1);
  show(["orders", "calendar", "menu", "payments", "settings"].includes(start) ? start : "orders");
})();
