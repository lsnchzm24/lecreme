(function () {
  "use strict";
  const M = window.LC_MENU;
  const sigSvgs = [...document.querySelectorAll(".sig-svg")];
  sigSvgs.forEach(svg => {
    try { LCake.render(svg, JSON.parse(svg.dataset.design), M); } catch (e) { /* leave blank */ }
  });

  const svg = document.getElementById("hero-cake"), cap = document.getElementById("hero-caption");
  if (!svg) return;
  const base = { shape: "round", tiers: 1, size: "10", flavors: ["vanilla", "redvelvet"], fillings: ["strawberry", "creamcheese"],
    finish: "naked", color: "cream", drip: "none", border: "none", decor: [], topper: "none" };
  const _t = window._t;
  const steps = [
    [{}, _t("Vanilla bean sponge, strawberry preserves")],
    [{ tiers: 2 }, _t("A red velvet tier on top")],
    [{ finish: "smooth" }, _t("Satin buttercream")],
    [{ color: "blush" }, _t("Tinted blush")],
    [{ drip: "gold" }, _t("A gold drip")],
    [{ border: "pearls" }, _t("Pearl beads")],
    [{ decor: ["flowers", "berries"] }, _t("Fresh flowers and berries")],
    [{ topper: "script", topper_text: _t("Celebrate") }, _t("Your words on top")],
  ];
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let d = Object.assign({}, base), viewer = null;
  const show = (opts) => viewer ? viewer.update(d) : LCake.render(svg, d, M, opts || { stagger: 40 });

  // Swap the drawings for real 3D renders once WebGL is ready.
  function start3D() {
    if (viewer || !window.LCake3D) return;
    try { viewer = LCake3D.create(document.getElementById("hero3d"), M, { autoRotate: true, interactive: true }); } catch (e) { return; }
    document.querySelector(".hero-art").classList.add("has-3d");
    show();
    sigSvgs.forEach(async s => {
      const url = await LCake3D.snapshot(JSON.parse(s.dataset.design), M, 520, 560);
      const img = new Image();
      img.src = url; img.alt = ""; img.className = "sig-img";
      img.onload = () => s.replaceWith(img);
    });
  }
  window.addEventListener("lcake3d:ready", start3D);
  start3D();

  if (reduce) {
    steps.forEach(s => Object.assign(d, s[0]));
    show();
    cap.textContent = _t("Every detail, your choice");
    return;
  }
  let i = 0;
  if (!viewer) LCake.render(svg, d, M, { animateFirst: true, stagger: 60 });
  function next() {
    i += 1;
    if (i >= steps.length) { setTimeout(() => { cap.textContent = _t("Every detail, your choice"); }, 1400); return; }
    Object.assign(d, steps[i][0]);
    show();
    cap.textContent = steps[i][1];
    setTimeout(next, 1350);
  }
  setTimeout(next, 1400);
})();
