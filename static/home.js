(function () {
  "use strict";
  const M = window.LC_MENU;
  document.querySelectorAll(".sig-svg").forEach(svg => {
    try { LCake.render(svg, JSON.parse(svg.dataset.design), M); } catch (e) { /* leave blank */ }
  });

  const svg = document.getElementById("hero-cake"), cap = document.getElementById("hero-caption");
  if (!svg) return;
  const base = { shape: "round", tiers: 1, size: "10", flavors: ["vanilla", "redvelvet"], fillings: ["strawberry", "creamcheese"],
    finish: "naked", color: "cream", drip: "none", border: "none", decor: [], topper: "none" };
  const steps = [
    [{}, "Vanilla bean sponge, strawberry preserves"],
    [{ tiers: 2 }, "A red velvet tier on top"],
    [{ finish: "smooth" }, "Satin buttercream"],
    [{ color: "blush" }, "Tinted blush"],
    [{ drip: "gold" }, "A gold drip"],
    [{ border: "pearls" }, "Pearl beads"],
    [{ decor: ["flowers", "berries"] }, "Fresh flowers and berries"],
    [{ topper: "script", topper_text: "Celebrate" }, "Your words on top"],
  ];
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let d = Object.assign({}, base);
  if (reduce) {
    steps.forEach(s => Object.assign(d, s[0]));
    LCake.render(svg, d, M);
    cap.textContent = "Every detail, your choice";
    return;
  }
  let i = 0;
  LCake.render(svg, d, M, { animateFirst: true, stagger: 60 });
  function next() {
    i += 1;
    if (i >= steps.length) { setTimeout(() => { cap.textContent = "Every detail, your choice"; }, 1400); return; }
    Object.assign(d, steps[i][0]);
    LCake.render(svg, d, M, { stagger: 40 });
    cap.textContent = steps[i][1];
    setTimeout(next, 1250);
  }
  setTimeout(next, 1300);
})();
