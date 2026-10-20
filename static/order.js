(function () {
  "use strict";
  const O = window.LC_ORDER;
  fetch("/api/menu").then(r => r.json()).then(m => {
    LCake.render(document.getElementById("order-cake"), O.design, m, { animateFirst: true, stagger: 50 });
  });

  function stamp(root) {
    root.querySelectorAll("time[datetime]").forEach(t => {
      const d = new Date(t.getAttribute("datetime"));
      if (!isNaN(d)) t.textContent = d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    });
  }
  stamp(document);

  const hold = document.querySelector(".hold");
  if (hold) {
    const until = new Date(hold.dataset.until);
    const el = document.getElementById("hold-left");
    const tick = () => {
      const s = Math.max(0, Math.round((until - Date.now()) / 1000));
      el.textContent = s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "no longer";
      if (s) setTimeout(tick, 1000); else setTimeout(() => location.replace(location.pathname), 1500);
    };
    tick();
  }

  let last = O.status, tries = 0;
  async function poll() {
    try {
      const r = await fetch(`/api/order/${O.token}`, { cache: "no-store" });
      const j = await r.json();
      if (j.status !== last) { location.replace(location.pathname); return; }
    } catch (e) { /* try again later */ }
    tries += 1;
    const fast = O.paidFlag && ["pending", "expired"].includes(last) && tries < 12;
    setTimeout(poll, fast ? 2500 : 20000);
  }
  setTimeout(poll, O.paidFlag ? 2000 : 20000);
})();
