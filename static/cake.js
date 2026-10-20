/* LeCreme cake renderer: draws a design as a lit, textured cake on a ceramic stand.
 *
 *   LCake.render(svg, design, menu, {view: "outside" | "inside", highlight: tierIndex})
 *
 * Realism comes from layers, not detail for its own sake:
 *   - cylinder lighting (soft key light from the upper left, dark falloff at the edges)
 *   - a procedural surface (feTurbulence + diffuse lighting) multiplied over buttercream,
 *     fondant, combed ridges and sponge crumb, each at its own grain
 *   - contact and occlusion shadows where tiers sit on each other and on the plate
 *   - glossy drips with their own shadow and specular highlights
 *   - fruit, roses, macarons and candles built from shaded parts
 *
 * Colors that change often (frosting, drip) are CSS custom properties on the <svg>, registered
 * with @property in styles.css, so a color change glides. Every drawn piece is a <g data-k>;
 * pieces whose key is new since the last render get "lc-in" and settle into place.
 * Every gradient and filter id is prefixed per <svg>, so many cakes can share a page.
 */
(function () {
  "use strict";
  const W = 420, H = 470, CX = 210, PLATE_Y = 400, VIEW_Y = 64;
  const BOTTOM_W = { 6: 196, 8: 232, 10: 262, 12: 292 };
  const SHEET_W = { quarter: 286, half: 322, full: 352 };
  const DARK = "#1d0309";
  let P = "lc";
  let uid = 0;
  const U = n => `url(#${P}-${n})`;
  const ID = n => `${P}-${n}`;

  // ------------------------------------------------------------ small helpers
  function rng(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
      return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
  }
  function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function rgbToHex(r, g, b) { return "#" + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join(""); }
  function mix(hex, to, amt) { const a = hexToRgb(hex), b = hexToRgb(to); return rgbToHex(a[0] + (b[0] - a[0]) * amt, a[1] + (b[1] - a[1]) * amt, a[2] + (b[2] - a[2]) * amt); }
  function lum(hex) { const [r, g, b] = hexToRgb(hex).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return .2126 * r + .7152 * g + .0722 * b; }
  const f1 = n => Math.round(n * 10) / 10;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function byId(list, id) { return (list || []).find(o => o.id === id) || {}; }
  const stop = (o, c, a) => `<stop offset="${o}" stop-color="${c}"${a == null ? "" : ` stop-opacity="${a}"`}/>`;

  // ---------------------------------------------------------------- geometry
  function layout(d) {
    const tiers = [];
    if (d.shape === "sheet") {
      tiers.push(tier(0, "sheet", SHEET_W[d.size] || 286, 66, PLATE_Y));
      return tiers;
    }
    const n = d.tiers || 1, bottom = parseInt(d.size, 10) || 8;
    const bw = BOTTOM_W[bottom] || 232;
    const h = n === 1 ? 108 : n === 2 ? 86 : 70;
    let base = PLATE_Y;
    for (let i = 0; i < n; i++) {
      const size = bottom - 2 * i;
      const t = tier(i, d.shape, bw * (size / bottom) + (i ? 8 : 0), h, base);
      t.size = size;
      tiers.push(t);
      base = d.shape === "square" ? t.top - t.d * 0.42 : t.top;
    }
    return tiers;
  }
  function tier(i, shape, w, h, base) {
    const sq = shape !== "round";
    return { i, shape, sq, w, h, x0: CX - w / 2, x1: CX + w / 2, cx: CX, rx: w / 2, ry: sq ? 0 : w * 0.2,
      d: sq ? w * (shape === "sheet" ? 0.32 : 0.24) : 0, bot: base, top: base - h };
  }
  function band(t, yA, yB) {
    if (t.sq) return `M${f1(t.x0)} ${f1(yA)}H${f1(t.x1)}V${f1(yB)}H${f1(t.x0)}Z`;
    return `M${f1(t.x0)} ${f1(yA)}V${f1(yB)}A${f1(t.rx)} ${f1(t.ry)} 0 0 0 ${f1(t.x1)} ${f1(yB)}V${f1(yA)}A${f1(t.rx)} ${f1(t.ry)} 0 0 1 ${f1(t.x0)} ${f1(yA)}Z`;
  }
  function topPath(t, inset) {
    inset = inset || 0;
    if (t.sq) {
      const k = t.w * 0.07;
      return `M${f1(t.x0 + inset)} ${f1(t.top)}H${f1(t.x1 - inset)}L${f1(t.x1 - k - inset)} ${f1(t.top - t.d)}H${f1(t.x0 + k + inset)}Z`;
    }
    const rx = t.rx - inset, ry = Math.max(t.ry - inset * .2, 1);
    return `M${f1(t.cx - rx)} ${f1(t.top)}A${f1(rx)} ${f1(ry)} 0 1 0 ${f1(t.cx + rx)} ${f1(t.top)}A${f1(rx)} ${f1(ry)} 0 1 0 ${f1(t.cx - rx)} ${f1(t.top)}Z`;
  }
  function frontArc(t, y) {
    return t.sq ? `M${f1(t.x0)} ${f1(y)}H${f1(t.x1)}` : `M${f1(t.x0)} ${f1(y)}A${f1(t.rx)} ${f1(t.ry)} 0 0 0 ${f1(t.x1)} ${f1(y)}`;
  }
  function front(t, u, y) {
    if (t.sq) return [t.x0 + t.w * u, y, 1];
    const a = Math.PI * u;
    return [t.cx - t.rx * Math.cos(a), y + t.ry * Math.sin(a), 0.55 + 0.45 * Math.sin(a)];
  }
  function onTop(t, u, v) {
    if (t.sq) {
      const depth = (1 - v) / 2, k = t.w * 0.07 * depth;
      return [t.cx + u * (t.w / 2 - k - 14), t.top - t.d * depth];
    }
    return [t.cx + u * t.rx * 0.8, t.top + v * t.ry * 0.74];
  }
  const g = (k, body) => `<g data-k="${esc(k)}">${body}</g>`;

  // ------------------------------------------------------------------- defs
  const ROSES = { blush: ["#C9667D", "#EFA9B8", "#FFE3EA"], white: ["#D9C9CB", "#FBF5F4", "#FFFFFF"],
    wine: ["#3E0614", "#7E1734", "#B4405F"], peach: ["#D9814F", "#F5B98F", "#FFE4CF"] };
  const MACS = ["#F2B6C3", "#BFD8A8", "#CDB8EA", "#F6DC8A", "#B5D3EE"];

  function defs() {
    const grain = (id, freq, oct, scale, elev, seed) => `
      <filter id="${ID(id)}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${oct}" seed="${seed || 3}" result="n"/>
        <feDiffuseLighting in="n" surfaceScale="${scale}" lighting-color="#fffaf5" result="l"><feDistantLight azimuth="225" elevation="${elev}"/></feDiffuseLighting>
        <feComposite in="l" in2="SourceAlpha" operator="in"/>
      </filter>`;
    // sponge crumb: sparse pores picked out of the noise peaks, in a baked-brown tone
    const pores = (id, freq, r, gg, b, seed) => `
      <filter id="${ID(id)}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="2" seed="${seed}" result="n"/>
        <feColorMatrix in="n" type="matrix" values="0 0 0 0 ${r}  0 0 0 0 ${gg}  0 0 0 0 ${b}  9 0 0 0 -5.1" result="p"/>
        <feComposite in="p" in2="SourceAlpha" operator="in"/>
      </filter>`;
    const blur = (id, s) => `<filter id="${ID(id)}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${s}"/></filter>`;
    const rad = (id, stops, cx, cy, r) => `<radialGradient id="${ID(id)}" cx="${cx || .5}" cy="${cy || .5}" r="${r || .5}">${stops}</radialGradient>`;
    const lin = (id, stops, x2, y2) => `<linearGradient id="${ID(id)}" x1="0" y1="0" x2="${x2 == null ? 1 : x2}" y2="${y2 || 0}">${stops}</linearGradient>`;
    return `<defs>
      ${lin("shadeH", stop(0, DARK, .5) + stop(.06, DARK, .26) + stop(.2, "#fff", .02) + stop(.33, "#fff", .26) + stop(.42, "#fff", .14) + stop(.58, "#fff", 0) + stop(.78, DARK, .1) + stop(.92, DARK, .32) + stop(1, DARK, .55))}
      ${lin("shadeV", stop(0, "#fff", .18) + stop(.07, "#fff", 0) + stop(.78, DARK, 0) + stop(1, DARK, .24), 0, 1)}
      ${lin("spec", stop(0, "#fff", 0) + stop(.25, "#fff", 0) + stop(.3, "#fff", .55) + stop(.34, "#fff", 0) + stop(1, "#fff", 0))}
      ${rad("topL", stop(0, "#fff", .5) + stop(.45, "#fff", .12) + stop(.8, DARK, .04) + stop(1, DARK, .16), .36, .25, .85)}
      ${rad("pool", stop(0, "#fff", .55) + stop(.3, "#fff", .12) + stop(1, "#fff", 0), .32, .3, .55)}
      ${lin("gold", stop(0, "#FFF4C8") + stop(.18, "#E9C76B") + stop(.36, "#A9792A") + stop(.52, "#F7DE90") + stop(.7, "#B48631") + stop(.86, "#7E5A18") + stop(1, "#E3C171"), 1, 1)}
      ${rad("goldPool", stop(0, "#FBEBB4") + stop(.45, "#DDB65C") + stop(.85, "#A97E2C") + stop(1, "#8A6420"), .4, .35, .7)}
      ${lin("goldDrip", stop(0, "#E9C46A") + stop(.35, "#F8E3A2") + stop(.7, "#C08F36") + stop(1, "#8F6A22"), 0, 1)}
      ${rad("pearl", stop(0, "#fff") + stop(.55, "#F5EFEE") + stop(.85, "#D8CBCD") + stop(1, "#B9A9AD"), .35, .3, .65)}
      ${rad("plate", stop(0, "#fff") + stop(.65, "#F8F4F5") + stop(.92, "#E4DADD") + stop(1, "#CFC3C7"), .45, .3, .62)}
      ${lin("rim", stop(0, "#A8979C") + stop(.25, "#E9E1E3") + stop(.45, "#fff") + stop(.75, "#D2C6CA") + stop(1, "#9C8A90"))}
      ${lin("stem", stop(0, "#B6A6AB") + stop(.3, "#F4EEF0") + stop(.45, "#fff") + stop(.8, "#C9BBC0") + stop(1, "#A3929A"))}
      ${lin("satin", stop(0, "#3A0614") + stop(.25, "#8E1F3F") + stop(.45, "#D0607D") + stop(.55, "#A42E50") + stop(.85, "#5C0E25") + stop(1, "#3A0614"), 0, 1)}
      ${rad("straw", stop(0, "#FF7183") + stop(.4, "#DC2340") + stop(.85, "#930F26") + stop(1, "#6E0A1C"), .35, .3, .75)}
      ${rad("strawIn", stop(0, "#FFF6F2") + stop(.45, "#F9C2C6") + stop(.8, "#E5566C") + stop(1, "#C21C36"), .5, .55, .6)}
      ${rad("blue", stop(0, "#6878BB") + stop(.45, "#2E3B80") + stop(1, "#121844"), .35, .3, .7)}
      ${rad("bloom", stop(0, "#C9D1F0", .55) + stop(1, "#C9D1F0", 0), .4, .3, .6)}
      ${rad("rasp", stop(0, "#FF8DA2") + stop(.5, "#D8264B") + stop(1, "#7E0C27"), .35, .3, .7)}
      ${lin("leaf", stop(0, "#B9D29C") + stop(.5, "#7A9D5F") + stop(1, "#4D6C3A"), 1, 1)}
      ${Object.entries(ROSES).map(([k, c]) => rad("rose-" + k, stop(0, c[0]) + stop(.55, c[1]) + stop(1, c[2]), .5, .55, .6)).join("")}
      ${MACS.map((c, i) => rad("mac" + i, stop(0, mix(c, "#fff", .45)) + stop(.6, c) + stop(1, mix(c, DARK, .25)), .4, .3, .7)).join("")}
      ${lin("choc", stop(0, "#5E3424") + stop(.45, "#2E140C") + stop(1, "#170704"), 1, 1)}
      ${rad("flame", stop(0, "#FFFDF0") + stop(.3, "#FFE58A") + stop(.7, "#FF9A2E") + stop(1, "#FF6A00", .6), .5, .75, .6)}
      ${rad("glow", stop(0, "#FFC861", .55) + stop(1, "#FFC861", 0))}
      ${grain("tex", "0.006 0.09", 2, 2.4, 62, 7)}
      ${grain("comb", "0.012 0.42", 1, 4, 48, 2)}
      ${grain("fond", "0.004 0.012", 1, 1.4, 66, 5)}
      ${pores("crumb", "0.9", .35, .18, .08, 9)}
      ${pores("crumbHi", "0.75", 1, .96, .9, 4)}
      ${blur("b2", 1.6)}${blur("b4", 4)}${blur("b8", 8)}
    </defs>`;
  }

  // ------------------------------------------------------------------ stand
  function plate(view) {
    const ry = view === "inside" ? 12 : 32;
    return g("plate", `
      <ellipse cx="${CX}" cy="${PLATE_Y + 58}" rx="150" ry="13" fill="${DARK}" opacity=".3" filter="${U("b8")}"/>
      <ellipse cx="${CX}" cy="${PLATE_Y + 52}" rx="66" ry="10" fill="${U("rim")}"/>
      <ellipse cx="${CX}" cy="${PLATE_Y + 49}" rx="61" ry="7" fill="#fff" opacity=".7"/>
      <path d="M${CX - 22} ${PLATE_Y + 14}C${CX - 22} ${PLATE_Y + 32} ${CX - 38} ${PLATE_Y + 42} ${CX - 44} ${PLATE_Y + 50}H${CX + 44}C${CX + 38} ${PLATE_Y + 42} ${CX + 22} ${PLATE_Y + 32} ${CX + 22} ${PLATE_Y + 14}Z" fill="${U("stem")}"/>
      <ellipse cx="${CX}" cy="${PLATE_Y + 12}" rx="190" ry="${ry + 4}" fill="${U("rim")}"/>
      <ellipse cx="${CX}" cy="${PLATE_Y + 6}" rx="187" ry="${ry}" fill="${U("plate")}"/>
      <ellipse cx="${CX}" cy="${PLATE_Y + 6}" rx="178" ry="${ry - 3}" fill="none" stroke="#fff" stroke-width="1.6" opacity=".9"/>`);
  }
  function contactShadow(t) {
    return t.sq
      ? `<rect x="${f1(t.x0 - 6)}" y="${f1(t.bot - 6)}" width="${f1(t.w + 12)}" height="14" rx="6" fill="${DARK}" opacity=".38" filter="${U("b4")}"/>`
      : `<ellipse cx="${CX}" cy="${f1(t.bot + 2)}" rx="${f1(t.rx * 1.04)}" ry="${f1(t.ry * 1.06 + 3)}" fill="${DARK}" opacity=".36" filter="${U("b4")}"/>`;
  }
  function occlusion(upper) {
    // the upper tier's weight pressing into the lower tier's top
    return upper.sq
      ? `<rect x="${f1(upper.x0 - 4)}" y="${f1(upper.bot - 6)}" width="${f1(upper.w + 8)}" height="12" rx="5" fill="${DARK}" opacity=".3" filter="${U("b4")}"/>`
      : `<ellipse cx="${CX}" cy="${f1(upper.bot + 1)}" rx="${f1(upper.rx * 1.05)}" ry="${f1(upper.ry * 1.12 + 2)}" fill="${DARK}" opacity=".3" filter="${U("b4")}"/>`;
  }

  // ------------------------------------------------------------------- body
  const texture = (path, filter, op) => filter === "crumb"
    ? `<path d="${path}" fill="#fff" filter="${U("crumb")}" opacity="${op}"/><path d="${path}" fill="#fff" filter="${U("crumbHi")}" opacity="${f1(op * .5)}"/>`
    : `<path d="${path}" fill="#fff" filter="${U(filter)}" style="mix-blend-mode:multiply" opacity="${op}"/>`;

  function sidePiece(t, d, flavor, filling) {
    const out = [];
    const naked = d.finish === "naked", semi = d.finish === "seminaked";
    const body = band(t, t.top, t.bot);
    if (naked || semi) {
      const spongeC = flavor.color || "#F3DDA8", fillC = filling.color || "#FFF4DD";
      const layers = [["s", .3], ["f", .065], ["s", .3], ["f", .065], ["s", .27]];
      let y = t.bot;
      layers.forEach(([kind, frac]) => {
        const y2 = y - t.h * frac;
        if (kind === "s") {
          out.push(`<path d="${band(t, y2, y)}" fill="${spongeC}"/>`);
          out.push(`<path d="${band(t, y2, y2 + 3)}" fill="${mix(spongeC, "#5a2c14", .3)}" opacity=".45"/>`);
        } else {
          out.push(`<path d="${band(t, y2 - .8, y + .8)}" fill="${fillC}"/>`);
          out.push(`<path d="${frontArc(t, y2 + .6)}" fill="none" stroke="#fff" stroke-width="1" opacity=".45"/>`);
          out.push(`<path d="${frontArc(t, y + .4)}" fill="none" stroke="${mix(fillC, DARK, .3)}" stroke-width=".8" opacity=".3"/>`);
        }
        y = y2;
      });
      out.push(texture(body, "crumb", .55));
      if (flavor.speckle) {
        const rs = rng("speck" + t.i);
        for (let i = 0; i < 30; i++) {
          const [x, yy] = front(t, .05 + rs() * .9, t.top + 6 + rs() * (t.h - 14));
          out.push(`<rect x="${f1(x)}" y="${f1(yy)}" width="4" height="1.6" rx=".8" fill="${["#E9548A", "#5BB7E5", "#F4C94A", "#8FD18B"][i % 4]}" transform="rotate(${Math.round(rs() * 180)} ${f1(x)} ${f1(yy)})"/>`);
        }
      }
      if (semi) {
        out.push(`<path d="${body}" style="fill:var(--frost)" opacity=".74"/>`);
        const rs = rng("semi" + t.i);
        let patches = "";
        [.15, .48, .82].forEach(c => {
          for (let i = 0; i < 6; i++) {
            const [x, y1] = front(t, rs(), t.bot - t.h * (c + (rs() - .5) * .14));
            patches += `<ellipse cx="${f1(x)}" cy="${f1(y1)}" rx="${f1(14 + rs() * 30)}" ry="${f1(2 + rs() * 4)}" fill="${spongeC}" opacity="${f1(.3 + rs() * .35)}"/>`;
          }
        });
        out.push(`<clipPath id="${ID("clip" + t.i)}"><path d="${body}"/></clipPath><g clip-path="${U("clip" + t.i)}">${patches}</g>`);
        out.push(texture(body, "tex", .3));
      }
    } else {
      out.push(`<path d="${body}" style="fill:var(--frost)"/>`);
      if (d.finish === "textured") {
        out.push(texture(body, "comb", .38));
        for (let y = t.top + 9; y < t.bot - 4; y += 7.5) {
          out.push(`<path d="${frontArc(t, y)}" fill="none" style="stroke:var(--frost-dk)" stroke-width="2" opacity=".22"/>`);
          out.push(`<path d="${frontArc(t, y + 1.8)}" fill="none" stroke="#fff" stroke-width="1" opacity=".4"/>`);
        }
      } else if (d.finish === "fondant") {
        out.push(texture(body, "fond", .22));
      } else {
        out.push(texture(body, "tex", .32));
      }
    }
    out.push(`<path d="${body}" fill="${U("shadeH")}"/>`);
    out.push(`<path d="${body}" fill="${U("shadeV")}"/>`);
    if (!naked) out.push(`<path d="${body}" fill="${U("spec")}" opacity="${d.finish === "fondant" ? .9 : d.finish === "smooth" ? .45 : .25}"/>`);
    return out.join("");
  }

  function topSurface(t, d, flavor) {
    const naked = d.finish === "naked";
    const p = topPath(t);
    let s = naked
      ? `<path d="${p}" fill="${mix(flavor.color || "#F3DDA8", "#ffffff", .08)}"/>${texture(p, "crumb", .45)}`
      : `<path d="${p}" style="fill:var(--frost-lt)"/>${texture(p, d.finish === "fondant" ? "fond" : "tex", d.finish === "fondant" ? .25 : .35)}`;
    s += `<path d="${p}" fill="${U("topL")}"/>`;
    if (!naked) {
      s += `<path d="${frontArc(t, t.top + 2.2)}" fill="none" stroke="${DARK}" stroke-width="2" opacity=".1"/>`;
      s += `<path d="${frontArc(t, t.top)}" fill="none" stroke="#fff" stroke-width="1.8" opacity=".65"/>`;
    }
    return s;
  }

  // ------------------------------------------------------------------- drip
  function drip(t, d, m) {
    const dc = byId(m.drips, d.drip);
    if (!dc.hex) return "";
    const r = rng("drip" + t.i + d.shape + Math.round(t.w));
    const n = Math.max(10, Math.round(t.w / 16));
    const edge = u => front(t, u, t.top);
    const [sx, sy] = edge(0);
    let path = `M${f1(sx)} ${f1(sy - 2)}`;
    const bulbs = [];
    for (let i = 0; i < n; i++) {
      const u0 = i / n, u1 = (i + 1) / n;
      const [ax, ay, sc] = edge(u0 + (u1 - u0) * .28), [bx, by] = edge(u0 + (u1 - u0) * .72), [ex, ey] = edge(u1);
      const long = r() > .35;
      const len = (long ? 14 + r() * t.h * .45 : 6 + r() * 6) * sc;
      const wd = bx - ax;
      path += `L${f1(ax)} ${f1(ay + 4)}C${f1(ax + wd * .15)} ${f1(ay + 4 + len * .5)} ${f1(ax - wd * .05)} ${f1(ay + 4 + len)} ${f1(ax + wd / 2)} ${f1(ay + 4 + len + wd * .18)}`;
      path += `C${f1(bx + wd * .05)} ${f1(by + 4 + len)} ${f1(bx - wd * .15)} ${f1(by + 4 + len * .5)} ${f1(bx)} ${f1(by + 4)}`;
      path += `Q${f1((bx + ex) / 2)} ${f1((by + ey) / 2 + 6)} ${f1(ex)} ${f1(ey + 4)}`;
      if (long) bulbs.push([ax + wd / 2, ay + 4 + len, wd, len]);
    }
    const [lx, ly] = edge(1);
    path += `L${f1(lx)} ${f1(ly - 2)}Z`;
    const hi = bulbs.map(([x, y, wd, len]) =>
      `<ellipse cx="${f1(x - wd * .18)}" cy="${f1(y - 1)}" rx="${f1(wd * .14)}" ry="${f1(wd * .2)}" fill="#fff" opacity=".7"/>` +
      `<path d="M${f1(x - wd * .2)} ${f1(y - len * .8)}V${f1(y - 4)}" stroke="#fff" stroke-width="${f1(Math.max(wd * .12, .8))}" stroke-linecap="round" opacity=".18"/>`).join("");
    return `<path d="${path}" fill="${DARK}" opacity=".35" transform="translate(1.5 3)" filter="${U("b2")}"/>
      <path d="${topPath(t)}" style="fill:var(--drip)"/>
      <path d="${path}" style="fill:var(--drip)"/>
      ${d.drip === "gold" ? `<path d="${path}" fill="${U("goldDrip")}"/><path d="${topPath(t)}" fill="${U("goldPool")}"/>` : ""}
      <path d="${path}" fill="${U("shadeH")}" opacity=".5"/>
      <path d="${topPath(t)}" fill="${U("pool")}"/>
      <path d="${frontArc(t, t.top + 1)}" fill="none" stroke="#fff" stroke-width="1.6" opacity=".5"/>
      ${hi}`;
  }

  // ---------------------------------------------------------------- borders
  function border(t, d, where) {
    if (d.border === "none") return "";
    const y = where === "bottom" ? t.bot : t.top;
    const n = Math.round(t.w / (d.border === "rosettes" ? 16 : d.border === "shells" ? 12 : 10));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const [x, yy, sc] = front(t, i / n, y);
      const yb = where === "bottom" ? yy - 4 * sc : yy;
      if (d.border === "pearls") {
        const r = 4.6 * sc;
        out.push(`<ellipse cx="${f1(x + .8)}" cy="${f1(yb + r * .8)}" rx="${f1(r)}" ry="${f1(r * .45)}" fill="${DARK}" opacity=".18"/><circle cx="${f1(x)}" cy="${f1(yb)}" r="${f1(r)}" fill="${U("pearl")}"/>`);
      } else if (d.border === "shells") {
        out.push(`<g transform="translate(${f1(x)} ${f1(yb + 2)}) scale(${f1(sc * 1.1)})">
          <path d="M-7 3C-6 -6 3 -9 8 -2C6 2 -1 4 -7 3Z" style="fill:var(--frost-lt)"/>
          <path d="M-7 3C-6 -6 3 -9 8 -2C6 2 -1 4 -7 3Z" fill="${U("shadeH")}" opacity=".6"/>
          <path d="M-5 1C-3 -4 2 -6 6 -2M-4 2C-1 -2 3 -3 5 0" fill="none" style="stroke:var(--frost-dk)" stroke-width=".8" opacity=".55"/>
          <path d="M-5 -1C-3 -5 1 -6 4 -5" fill="none" stroke="#fff" stroke-width=".9" opacity=".8"/></g>`);
      } else if (d.border === "rosettes") {
        const rr = 7.6 * sc;
        out.push(`<g transform="translate(${f1(x)} ${f1(yb)})">
          <ellipse cx="1" cy="${f1(rr * .75)}" rx="${f1(rr)}" ry="${f1(rr * .35)}" fill="${DARK}" opacity=".18"/>
          <circle r="${f1(rr)}" style="fill:var(--frost-lt)"/><circle r="${f1(rr)}" fill="${U("shadeH")}" opacity=".55"/>
          <path d="M${f1(-rr * .7)} 0a${f1(rr * .7)} ${f1(rr * .7)} 0 1 1 ${f1(rr * 1.1)} ${f1(rr * .45)}a${f1(rr * .45)} ${f1(rr * .45)} 0 1 1 ${f1(-rr * .5)} ${f1(-rr * .55)}a${f1(rr * .22)} ${f1(rr * .22)} 0 1 1 ${f1(rr * .3)} ${f1(rr * .22)}" fill="none" style="stroke:var(--frost-dk)" stroke-width="${f1(rr * .16)}" stroke-linecap="round" opacity=".5"/>
          <path d="M${f1(-rr * .6)} ${f1(-rr * .4)}a${f1(rr * .75)} ${f1(rr * .75)} 0 0 1 ${f1(rr * .8)} ${f1(-rr * .4)}" fill="none" stroke="#fff" stroke-width="${f1(rr * .14)}" stroke-linecap="round" opacity=".8"/></g>`);
      }
    }
    return out.join("");
  }

  // ------------------------------------------------------------ side decor
  function sideDecor(t, d, key) {
    const out = [];
    const r = rng(key + t.i);
    if (key === "goldleaf") {
      for (let i = 0; i < Math.round(t.w / 20); i++) {
        const [x, y] = front(t, .1 + r() * .8, t.top + 10 + r() * (t.h - 22));
        const s = 5 + r() * 10, pts = [];
        for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2 + r() * .5, rr = s * (.5 + r() * .6); pts.push(`${f1(x + Math.cos(a) * rr)} ${f1(y + Math.sin(a) * rr * .7)}`); }
        out.push(`<path d="M${pts.join("L")}Z" fill="${U("gold")}" stroke="#7E5A18" stroke-width=".4" stroke-opacity=".6"/><path d="M${pts[0]}L${pts[3]}" stroke="#FFF4C8" stroke-width=".6" opacity=".7"/>`);
      }
    } else if (key === "pearls") {
      for (let i = 0; i < Math.round(t.w / 8); i++) {
        const [x, y, sc] = front(t, .04 + r() * .92, t.top + 8 + r() * (t.h - 16));
        const rr = (1.5 + r() * 2.2) * sc;
        out.push(`<circle cx="${f1(x + .6)}" cy="${f1(y + .9)}" r="${f1(rr)}" fill="${DARK}" opacity=".15"/><circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(rr)}" fill="${U("pearl")}"/>`);
      }
    } else if (key === "sprinkles") {
      const cols = ["#E9548A", "#4FB0E2", "#F4C94A", "#86CC82", "#ffffff", "#B47EDB"];
      for (let i = 0; i < Math.round(t.w / 4.5); i++) {
        const [x, y] = front(t, .04 + r() * .92, t.top + 6 + r() * (t.h * .5));
        out.push(`<g transform="rotate(${Math.round(r() * 180)} ${f1(x)} ${f1(y)})"><rect x="${f1(x)}" y="${f1(y)}" width="5.2" height="1.9" rx=".95" fill="${cols[i % cols.length]}"/><rect x="${f1(x + .8)}" y="${f1(y + .3)}" width="3.4" height=".5" rx=".25" fill="#fff" opacity=".6"/></g>`);
      }
    }
    return out.join("");
  }

  function bow(t) {
    const yA = t.bot - 28, yB = t.bot - 13;
    const [bx, by] = front(t, .5, yA);
    return `<path d="${band(t, yA, yB)}" fill="${U("satin")}"/><path d="${band(t, yA, yB)}" fill="${U("shadeH")}" opacity=".8"/>
      <path d="${frontArc(t, yA + 3)}" fill="none" stroke="#fff" stroke-width="1" opacity=".35"/>
      <g transform="translate(${f1(bx)} ${f1(by + 7)})">
        <path d="M-3 2L-15 30L-7 26L-3 34L3 3Z" fill="#5C0E25"/><path d="M3 2L15 30L7 26L3 34L-3 3Z" fill="#6E1530"/>
        <path d="M0 0C-12 -20 -38 -16 -36 -2C-34 10 -14 8 0 0Z" fill="${U("satin")}"/>
        <path d="M0 0C12 -20 38 -16 36 -2C34 10 14 8 0 0Z" fill="${U("satin")}"/>
        <path d="M-6 -2C-14 -10 -26 -12 -30 -5M6 -2C14 -10 26 -12 30 -5" fill="none" stroke="#3A0614" stroke-width="1.2" opacity=".5"/>
        <path d="M-30 -8C-26 -14 -16 -14 -9 -8M30 -8C26 -14 16 -14 9 -8" fill="none" stroke="#F3A9BB" stroke-width="1.2" opacity=".55"/>
        <ellipse rx="7" ry="8" fill="${U("satin")}"/><ellipse cx="-2" cy="-3" rx="2.5" ry="3" fill="#fff" opacity=".3"/></g>`;
  }

  function message(t, d, text) {
    if (!text) return "";
    const [, yy] = front(t, .5, t.top + t.h * (d.border !== "none" ? .52 : .58));
    const size = Math.min(32, (t.w * .82) / Math.max(text.length * .42, 4));
    const a = `x="${CX}" text-anchor="middle" font-family="Pinyon, 'Pinyon Script', cursive" font-size="${f1(size)}"`;
    return `<text ${a} y="${f1(yy + 1.6)}" fill="${DARK}" opacity=".22" filter="${U("b2")}">${esc(text)}</text>
      <text ${a} y="${f1(yy)}" style="fill:var(--ink)">${esc(text)}</text>
      <text ${a} y="${f1(yy - .5)}" fill="none" stroke="#fff" stroke-width=".35" opacity=".5">${esc(text)}</text>`;
  }

  // ---------------------------------------------------------------- toppings
  function cluster(t, items, seed, area) {
    const r = rng(seed), spots = [];
    items.forEach(kind => {
      const count = { berries: 11, flowers: 5, macarons: 5, shards: 6, candles: 5 }[kind] || 0;
      for (let i = 0; i < count; i++) {
        let u, v;
        if (area === "ledge") { u = -.98 + r() * .45; v = .15 + r() * .7; }
        else if (kind === "candles") { u = -.55 + (i / (count - 1)) * 1.1; v = -.25 + (i % 2) * .35; }
        else if (kind === "shards") { u = -.7 + r() * 1.4; v = -.85 + r() * .6; }
        else if (kind === "macarons") { const a = (i / count) * Math.PI * 2 + .3; u = Math.cos(a) * .74; v = Math.sin(a) * .74; }
        else if (kind === "flowers") { u = -.75 + r() * .85; v = -.55 + r() * .9; }
        else { u = -.85 + r() * 1.1; v = -.5 + r() * 1.15; }
        const [x, y] = onTop(t, u, v);
        spots.push({ kind, x, y, s: .85 + r() * .4, rot: r() * 360, i, r: rng(seed + kind + i) });
      }
    });
    spots.sort((a, b) => a.y - b.y);
    return spots.map(p => (p.kind === "candles" ? "" : `<ellipse cx="${f1(p.x + 1)}" cy="${f1(p.y + 1)}" rx="${f1(9 * p.s)}" ry="${f1(3 * p.s)}" fill="${DARK}" opacity=".2" filter="${U("b2")}"/>`) + piece(p)).join("");
  }

  function strawberry(half) {
    const shape = "M0 -15C-9 -15 -11.5 -7 -9.5 -2C-7.5 4 -2 8.5 0 9.5C2 8.5 7.5 4 9.5 -2C11.5 -7 9 -15 0 -15Z";
    let s = `<path d="${shape}" fill="${U("straw")}"/>`;
    if (half) {
      return s + `<path d="M0 -12.5C-7 -12.5 -8.6 -6 -7.2 -2C-5.6 3 -1.6 6.6 0 7.4C1.6 6.6 5.6 3 7.2 -2C8.6 -6 7 -12.5 0 -12.5Z" fill="${U("strawIn")}"/>
        <path d="M0 -11C-1.2 -6 -1.5 -1 0 5.5C1.5 -1 1.2 -6 0 -11Z" fill="#fff" opacity=".7"/>
        <path d="M-6 -8C-4 -4 -3 0 -1.5 3M6 -8C4 -4 3 0 1.5 3" fill="none" stroke="#fff" stroke-width=".7" opacity=".55"/>
        <path d="M-9 -14.5Q0 -12 9 -14.5" fill="none" stroke="#4E8A3A" stroke-width="2"/>`;
    }
    for (let row = 0, yy = -11; yy <= 5; yy += 3.4, row++) {
      for (let xx = -7; xx <= 7; xx += 3.6) {
        const ox = xx + (row % 2 ? 1.8 : 0);
        if ((ox * ox) / 70 + ((yy + 3) * (yy + 3)) / 120 > 1) continue;
        s += `<ellipse cx="${f1(ox)}" cy="${f1(yy)}" rx=".75" ry="1" fill="#F7D774"/><ellipse cx="${f1(ox + .3)}" cy="${f1(yy + .6)}" rx=".6" ry=".35" fill="#6E0A1C" opacity=".5"/>`;
      }
    }
    return s + `<ellipse cx="-4" cy="-8" rx="2.4" ry="4.2" fill="#fff" opacity=".38" transform="rotate(20 -4 -8)"/>
      <g fill="${U("leaf")}"><path d="M0 -15L-8 -18L-3 -14Z"/><path d="M0 -15L8 -18L3 -14Z"/><path d="M0 -15L-4 -21L1 -15Z"/><path d="M0 -15L5 -20L1 -14Z"/><path d="M0 -15L-10 -14L-2 -13Z"/></g>`;
  }
  function blueberry() {
    return `<circle cy="-6" r="6.6" fill="${U("blue")}"/><circle cy="-6" r="6.6" fill="${U("bloom")}"/>
      <path d="M0 -12.6l1 1.6l1.8 -.3l-.8 1.6l1 1.4l-1.8 .1l-.6 1.6l-.6 -1.6l-1.8 -.1l1 -1.4l-.8 -1.6l1.8 .3z" fill="#151a3a" opacity=".85"/>`;
  }
  function raspberry(r) {
    const pts = [];
    for (let row = 0; row < 4; row++) for (let k = 0; k < 5 - row; k++) pts.push([(k - (4 - row) / 2) * 4.2, -2 - row * 3.8]);
    return pts.sort((a, b) => a[1] - b[1]).map(([x, y]) =>
      `<circle cx="${f1(x + r() * .6)}" cy="${f1(y)}" r="2.7" fill="${U("rasp")}"/><circle cx="${f1(x - .8)}" cy="${f1(y - .9)}" r=".7" fill="#fff" opacity=".55"/>`).join("");
  }
  function rose(R, pal, r) {
    const grad = U("rose-" + pal), edge = ROSES[pal][0];
    const petal = (len, wid) => `M0 0C${f1(-wid)} ${f1(-len * .2)} ${f1(-wid * 1.05)} ${f1(-len * .95)} 0 ${f1(-len)}C${f1(wid * 1.05)} ${f1(-len * .95)} ${f1(wid)} ${f1(-len * .2)} 0 0Z`;
    const rot0 = r() * 60;
    let s = `<g transform="scale(1 .8)">`;
    for (let k = 0; k < 7; k++) s += `<path d="${petal(R, R * .62)}" fill="${grad}" stroke="${edge}" stroke-width=".5" stroke-opacity=".35" transform="rotate(${f1(rot0 + k * 51.4)})"/>`;
    for (let k = 0; k < 5; k++) s += `<path d="${petal(R * .72, R * .5)}" fill="${grad}" stroke="${edge}" stroke-width=".5" stroke-opacity=".4" transform="rotate(${f1(rot0 + 25 + k * 72)})"/>`;
    s += `<circle r="${f1(R * .38)}" fill="${edge}" opacity=".85"/>`;
    s += `<path d="M${f1(-R * .3)} 0a${f1(R * .3)} ${f1(R * .3)} 0 1 1 ${f1(R * .5)} ${f1(R * .16)}a${f1(R * .2)} ${f1(R * .2)} 0 1 1 ${f1(-R * .28)} ${f1(-R * .26)}" fill="none" stroke="${ROSES[pal][2]}" stroke-width="${f1(R * .09)}" stroke-linecap="round" opacity=".75"/>`;
    s += `<ellipse cx="${f1(-R * .35)}" cy="${f1(-R * .45)}" rx="${f1(R * .22)}" ry="${f1(R * .12)}" fill="#fff" opacity=".35"/>`;
    return s + "</g>";
  }
  function leaf(L, rot) {
    return `<g transform="rotate(${f1(rot)})"><path d="M0 0C${f1(L * .3)} ${f1(-L * .34)} ${f1(L * .78)} ${f1(-L * .28)} ${f1(L)} 0C${f1(L * .78)} ${f1(L * .28)} ${f1(L * .3)} ${f1(L * .34)} 0 0Z" fill="${U("leaf")}"/>
      <path d="M1 0H${f1(L * .9)}" stroke="#3E5A2E" stroke-width=".7" opacity=".6"/></g>`;
  }
  function macaron(gi) {
    const gm = U("mac" + gi), foot = mix(MACS[gi], "#fff", .3);
    let lower = "", upper = "";
    for (let k = -4; k <= 4; k++) {
      lower += `<circle cx="${k * 2.3}" cy="-7.2" r="1.25" fill="${foot}"/>`;
      upper += `<circle cx="${k * 2.3}" cy="-11.8" r="1.25" fill="${foot}"/>`;
    }
    return `<ellipse cy="-3.5" rx="11.5" ry="5" fill="${gm}"/>${lower}
      <rect x="-10.5" y="-11" width="21" height="4.4" rx="2.2" fill="#FFF3E2"/><rect x="-10.5" y="-8" width="21" height="1.2" fill="${DARK}" opacity=".08"/>${upper}
      <ellipse cy="-14.5" rx="11.5" ry="5.4" fill="${gm}"/><ellipse cx="-3" cy="-16.5" rx="5" ry="1.8" fill="#fff" opacity=".45"/>`;
  }

  function piece(p) {
    const { x, y, s, r } = p;
    const at = (inner, sc) => `<g transform="translate(${f1(x)} ${f1(y)}) scale(${f1(sc == null ? s : sc)})">${inner}</g>`;
    switch (p.kind) {
      case "berries": {
        const k = p.i % 4;
        if (k === 0) return at(`<g transform="rotate(${Math.round(p.rot % 40 - 20)})">${strawberry(false)}</g>`);
        if (k === 2) return at(`<g transform="rotate(${Math.round(p.rot % 30 - 15)})">${strawberry(true)}</g>`);
        return at(k === 1 ? blueberry() : raspberry(r));
      }
      case "flowers": {
        const pal = ["blush", "white", "wine", "peach", "blush"][p.i % 5];
        const R = 13 * s;
        let filler = "";
        for (let k = 0; k < 7; k++) filler += `<circle cx="${f1((r() - .5) * R * 3.4)}" cy="${f1((r() - .5) * R * 1.2 - R * .3)}" r="${f1(1 + r() * 1.3)}" fill="#fff" stroke="#E7DEDF" stroke-width=".4"/>`;
        return `<g transform="translate(${f1(x)} ${f1(y - R * .55)})">${leaf(R * 1.5, 160 + r() * 30)}${leaf(R * 1.4, -10 - r() * 30)}${rose(R, pal, r)}${filler}</g>`;
      }
      case "macarons": return at(macaron(p.i % 5));
      case "shards": {
        const hgt = 26 + r() * 14;
        return at(`<g transform="rotate(${Math.round(p.rot % 50 - 25)})"><path d="M-7 2L-4 ${f1(-hgt)}L8 ${f1(-hgt * .6)}L6 2Z" fill="${U("choc")}"/>
          <path d="M-4 ${f1(-hgt)}L8 ${f1(-hgt * .6)}" stroke="#A0705A" stroke-width="1" opacity=".7"/>
          <path d="M-3 ${f1(-hgt * .8)}L-1 -4" stroke="#fff" stroke-width="1.2" opacity=".18"/></g>`, 1);
      }
      case "candles": {
        const c = ["#F4C7CF", "#BFD9EE", "#F8E3A0", "#D3C2EA", "#C9DDB5"][p.i % 5];
        return at(`<circle cy="-48" r="14" fill="${U("glow")}"/>
          <rect x="-3" y="-36" width="6" height="36" rx="1.6" fill="${c}"/><rect x="-3" y="-36" width="6" height="36" rx="1.6" fill="${U("shadeH")}" opacity=".7"/>
          <path d="M-3 -29l6 -4M-3 -19l6 -4M-3 -9l6 -4" stroke="#fff" stroke-width="1.8" opacity=".85"/>
          <path d="M0 -36v-5" stroke="#2a2a2a" stroke-width="1.1"/>
          <g class="lc-flame"><path d="M0 -55c4.5 7 5 11 0 13c-5 -2 -4.5 -6 0 -13z" fill="${U("flame")}"/><ellipse cy="-42.6" rx="1.6" ry="1.2" fill="#6FA8FF" opacity=".6"/></g>`, 1);
      }
    }
    return "";
  }

  function topper(t, d) {
    if (d.topper === "script" && d.topper_text) {
      const y = t.top - (t.sq ? t.d * .5 : 0) - 70;
      const size = Math.min(50, 330 / Math.max(d.topper_text.length * .5, 3));
      const a = `x="${CX}" text-anchor="middle" font-family="Pinyon, 'Pinyon Script', cursive" font-size="${f1(size)}"`;
      return `<path d="M${CX - 30} ${f1(y + 22)}V${f1(y + 74)}M${CX + 30} ${f1(y + 22)}V${f1(y + 74)}" stroke="${U("gold")}" stroke-width="2.6"/>
        <text ${a} y="${f1(y + 18)}" fill="${DARK}" opacity=".3" filter="${U("b2")}">${esc(d.topper_text)}</text>
        <text ${a} y="${f1(y + 14)}" fill="${U("gold")}" stroke="#6E4E12" stroke-width=".7">${esc(d.topper_text)}</text>
        <text ${a} y="${f1(y + 13.2)}" fill="none" stroke="#FFF6D0" stroke-width=".4" opacity=".8">${esc(d.topper_text)}</text>`;
    }
    if (d.topper === "number" && d.number) {
      const y = t.top - (t.sq ? t.d * .5 : 0) - 4;
      const digits = d.number.split("");
      return digits.map((ch, i) => {
        const x = CX + (i - (digits.length - 1) / 2) * 44;
        const a = `x="${f1(x)}" text-anchor="middle" font-family="Bricolage, sans-serif" font-weight="800" font-stretch="80%" font-size="76"`;
        return `<g><text ${a} y="${f1(y + 3)}" fill="${DARK}" opacity=".3" filter="${U("b2")}">${esc(ch)}</text>
          <text ${a} y="${f1(y)}" fill="${U("gold")}" stroke="#6E4E12" stroke-width=".8">${esc(ch)}</text>
          <path d="M${f1(x)} ${f1(y - 58)}v-5" stroke="#2a2a2a"/><circle cx="${f1(x)}" cy="${f1(y - 72)}" r="12" fill="${U("glow")}"/>
          <g class="lc-flame"><path d="M${f1(x)} ${f1(y - 80)}c4.5 7 5 11 0 13c-5 -2 -4.5 -6 0 -13z" fill="${U("flame")}"/></g></g>`;
      }).join("");
    }
    return "";
  }

  function sprinkleTop(t) {
    const r = rng("spt"), out = [];
    const cols = ["#E9548A", "#4FB0E2", "#F4C94A", "#86CC82", "#ffffff", "#B47EDB"];
    for (let i = 0; i < 80; i++) {
      const [x, y] = onTop(t, -1.1 + r() * 2.2, -1.1 + r() * 2.2);
      if (!t.sq && ((x - t.cx) ** 2 / (t.rx * .9) ** 2 + (y - t.top) ** 2 / (t.ry * .86) ** 2) > 1) continue;
      out.push(`<rect x="${f1(x)}" y="${f1(y)}" width="4.6" height="1.7" rx=".85" fill="${cols[i % cols.length]}" transform="rotate(${Math.round(r() * 180)} ${f1(x)} ${f1(y)})"/>`);
    }
    return out.join("");
  }
  function goldTop(t) {
    const r = rng("gt"), out = [];
    for (let i = 0; i < 8; i++) {
      const [x, y] = onTop(t, -.8 + r() * 1.6, -.6 + r() * 1.2);
      const s = 5 + r() * 9;
      out.push(`<path d="M${f1(x)} ${f1(y)}l${f1(s)} ${f1(-s * .25)}l${f1(-s * .2)} ${f1(s * .3)}l${f1(-s * .5)} ${f1(s * .15)}z" fill="${U("gold")}" stroke="#7E5A18" stroke-width=".3"/>`);
    }
    return out.join("");
  }

  // ---------------------------------------------------------- inside view
  function inside(d, m, hl) {
    const n = d.shape === "sheet" ? 1 : (d.tiers || 1);
    const naked = d.finish === "naked";
    return layout(d).map((t, i) => {
      const fl = byId(m.flavors, d.flavors[i]), fi = byId(m.fillings, d.fillings[i]);
      const shell = naked ? 0 : d.finish === "seminaked" ? 2 : 6;
      const x = t.x0, w = t.w, top = t.bot - t.h;
      const rect = `M${f1(x)} ${f1(top + 3)}Q${f1(x)} ${f1(top)} ${f1(x + 3)} ${f1(top)}H${f1(x + w - 3)}Q${f1(x + w)} ${f1(top)} ${f1(x + w)} ${f1(top + 3)}V${f1(t.bot)}H${f1(x)}Z`;
      let s = `<rect x="${f1(x - 4)}" y="${f1(t.bot - 5)}" width="${f1(w + 8)}" height="9" rx="4" fill="${DARK}" opacity=".3" filter="${U("b4")}"/>`;
      s += `<path d="${rect}" ${naked ? `fill="${fl.color}"` : `style="fill:var(--frost)"`}/>`;
      if (!naked) s += texture(rect, "tex", .35);
      const ix = x + shell, iw = w - shell * 2, ih = t.h - shell - 2;
      const r = rng("in" + i);
      const wave = (yy, amp) => { let p = `M${f1(ix)} ${f1(yy)}`; for (let k = 1; k <= 12; k++) p += `L${f1(ix + iw * k / 12)} ${f1(yy + (r() - .5) * amp)}`; return p; };
      let y = t.bot - 2;
      [["s", .3], ["f", .07], ["s", .3], ["f", .07], ["s", .26]].forEach(([k, frac]) => {
        const hh = ih * frac;
        if (k === "s") {
          s += `<rect x="${f1(ix)}" y="${f1(y - hh)}" width="${f1(iw)}" height="${f1(hh + .4)}" fill="${fl.color}"/>`;
          if (fl.speckle) for (let c = 0; c < iw / 6; c++) s += `<rect x="${f1(ix + r() * (iw - 4))}" y="${f1(y - r() * hh)}" width="3.4" height="1.3" rx=".6" fill="${["#E9548A", "#4FB0E2", "#F4C94A", "#86CC82"][c % 4]}"/>`;
        } else {
          s += `<path d="${wave(y - hh, 2.4)}V${f1(y + 1)}H${f1(ix)}Z" fill="${fi.color}"/>`;
          s += `<path d="${wave(y - hh + .6, 1.4)}" fill="none" stroke="#fff" stroke-width=".9" opacity=".5"/>`;
        }
        y -= hh;
      });
      s += texture(`M${f1(ix)} ${f1(top + shell)}h${f1(iw)}v${f1(ih)}h${f1(-iw)}z`, "crumb", .55);
      s += `<path d="${rect}" fill="${U("shadeH")}" opacity=".55"/>`;
      if (d.drip !== "none") s += `<rect x="${f1(x - 1)}" y="${f1(top - 3)}" width="${f1(w + 2)}" height="6" rx="3" style="fill:var(--drip)"/><rect x="${f1(x + 4)}" y="${f1(top - 2)}" width="${f1(w * .5)}" height="1.4" rx=".7" fill="#fff" opacity=".45"/>`;
      if (n > 1 && i < n - 1) s += `<g fill="#EDE2D3"><rect x="${f1(CX - w * .22)}" y="${f1(top - t.h + 4)}" width="3" height="${f1(t.h)}"/><rect x="${f1(CX + w * .22)}" y="${f1(top - t.h + 4)}" width="3" height="${f1(t.h)}"/></g>`;
      if (hl === i) s += `<rect x="${f1(x - 6)}" y="${f1(top - 6)}" width="${f1(w + 12)}" height="${f1(t.h + 10)}" rx="9" fill="none" stroke="#C9A24A" stroke-width="2.5" stroke-dasharray="6 5"/>`;
      return g(`in-tier-${i}-${d.shape}-${Math.round(t.w)}`, s);
    }).join("");
  }

  // ------------------------------------------------------------------- build
  function colors(svg, d, m) {
    const base = d.color === "custom" && d.custom_hex ? d.custom_hex : (byId(m.colors, d.color).hex || "#FBF3E4");
    svg.style.setProperty("--frost", base);
    svg.style.setProperty("--frost-lt", mix(base, "#ffffff", .1));
    svg.style.setProperty("--frost-dk", mix(base, "#2a0612", .32));
    svg.style.setProperty("--drip", byId(m.drips, d.drip).hex || base);
    const naked = d.finish === "naked";
    svg.style.setProperty("--ink", lum(naked ? (byId(m.flavors, d.flavors[0]).color || "#F3DDA8") : base) > .38 ? "#5E0F25" : "#FFF7F8");
  }

  function build(d, m, view, hl) {
    const parts = [defs(), plate(view)];
    if (view === "inside") return parts.join("") + inside(d, m, hl);
    const tiers = layout(d);
    const ledges = [];
    tiers.forEach((t, i) => {
      const fl = byId(m.flavors, d.flavors[i]), fi = byId(m.fillings, d.fillings[i]);
      const k = `tier-${i}-${d.shape}-${Math.round(t.w)}`;
      parts.push(g(k, (i === 0 ? contactShadow(t) : occlusion(t)) + sidePiece(t, d, fl, fi)));
      ["goldleaf", "pearls", "sprinkles"].forEach(x => { if (d.decor.includes(x)) parts.push(g(`${x}-${k}`, sideDecor(t, d, x))); });
      if (d.decor.includes("bow") && i === 0) parts.push(g(`bow-${k}`, bow(t)));
      if (i === 0 && d.message) parts.push(g(`msg-${d.message}-${k}`, message(t, d, d.message)));
      if (d.border !== "none") parts.push(g(`border-${d.border}-${k}`, border(t, d, "bottom")));
      parts.push(g(`top-${k}`, topSurface(t, d, fl)));
      if (d.drip !== "none") parts.push(g(`drip-${d.drip === "gold" ? "g" : "c"}-${k}`, drip(t, d, m)));
      if (d.border === "pearls" && d.finish === "fondant") parts.push(g(`bt-${k}`, border(t, d, "top")));
      if (i < tiers.length - 1) {
        const ledge = d.decor.filter(x => ["flowers", "berries", "macarons"].includes(x)).slice(0, 2);
        if (ledge.length) ledges.push(g(`ledge-${ledge.join("")}-${k}`, cluster(t, ledge, "ledge" + i, "ledge")));
      }
    });
    parts.push(...ledges);
    const topT = tiers[tiers.length - 1];
    const tk = `top-${tiers.length}-${d.shape}-${Math.round(topT.w)}`;
    if (d.decor.includes("sprinkles")) parts.push(g(`sprtop-${tk}`, sprinkleTop(topT)));
    if (d.decor.includes("goldleaf")) parts.push(g(`goldtop-${tk}`, goldTop(topT)));
    ["shards", "macarons", "berries", "flowers", "candles"].filter(x => d.decor.includes(x))
      .forEach(x => parts.push(g(`${x}-${tk}`, cluster(topT, [x], x + tk, "top"))));
    if (d.topper !== "none") parts.push(g(`topper-${d.topper}-${d.topper_text || d.number}-${tk}`, topper(topT, d)));
    return parts.join("");
  }

  function normalize(d) {
    d = Object.assign({ shape: "round", tiers: 1, size: "8", flavors: [], fillings: [], finish: "smooth", color: "cream", custom_hex: "",
      drip: "none", border: "none", decor: [], topper: "none", topper_text: "", number: "", message: "" }, d || {});
    if (d.color && d.color[0] === "#") { d.custom_hex = d.color; d.color = "custom"; }
    return d;
  }

  function render(svg, design, menu, opts) {
    opts = opts || {};
    if (!svg.dataset.lcid) svg.dataset.lcid = "lc" + (++uid);
    P = svg.dataset.lcid;
    const d = normalize(design), view = opts.view || "outside";
    svg.setAttribute("viewBox", `0 ${VIEW_Y} ${W} ${H - VIEW_Y}`);
    colors(svg, d, menu);
    const before = new Set([...svg.querySelectorAll("[data-k]")].map(n => n.getAttribute("data-k")));
    const first = !svg.dataset.drawn;
    svg.innerHTML = build(d, menu, view, opts.highlight == null ? -1 : opts.highlight);
    svg.dataset.drawn = "1";
    if (first && !opts.animateFirst) return;
    let delay = 0;
    svg.querySelectorAll("[data-k]").forEach(n => {
      if (!before.has(n.getAttribute("data-k"))) {
        n.classList.add("lc-in");
        n.style.animationDelay = `${delay}ms`;
        delay += opts.stagger || 0;
      }
    });
  }

  window.LCake = { render, normalize, mix, lum };
})();
