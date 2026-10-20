/* LeCreme cake renderer: draws a design as an SVG cake on a stand.
 *
 *   LCake.render(svg, design, menu, {view: "outside" | "inside"})
 *
 * Colors that change often (frosting, drip) are CSS custom properties on the <svg>, registered
 * with @property in styles.css, so a color change glides instead of snapping. Every drawn piece
 * is a <g data-k="..."> group; pieces whose key is new since the last render get the "lc-in"
 * class and pop in, so the customer sees exactly what their tap added.
 */
(function () {
  "use strict";
  const W = 420, H = 470, CX = 210, PLATE_Y = 400, VIEW_Y = 64;
  const BOTTOM_W = { 6: 196, 8: 232, 10: 262, 12: 292 };
  const SHEET_W = { quarter: 286, half: 322, full: 352 };

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

  // ---------------------------------------------------------------- geometry
  function layout(d) {
    const tiers = [];
    if (d.shape === "sheet") {
      const w = SHEET_W[d.size] || 286, h = 66;
      tiers.push(tier(0, "sheet", w, h, PLATE_Y));
      return tiers;
    }
    const n = d.tiers || 1, bottom = parseInt(d.size, 10) || 8;
    const bw = BOTTOM_W[bottom] || 232;
    const h = n === 1 ? 108 : n === 2 ? 86 : 70;
    let base = PLATE_Y;
    for (let i = 0; i < n; i++) {
      const size = bottom - 2 * i;
      const w = bw * (size / bottom) + (i ? 8 : 0);
      const t = tier(i, d.shape, w, h, base);
      t.size = size;
      tiers.push(t);
      base = d.shape === "square" ? t.top - t.d * 0.42 : t.top;
    }
    return tiers;
  }
  function tier(i, shape, w, h, base) {
    const x0 = CX - w / 2, x1 = CX + w / 2;
    const sq = shape !== "round";
    const ry = sq ? 0 : w * 0.2;
    const d = sq ? w * (shape === "sheet" ? 0.32 : 0.24) : 0;
    return { i, shape, sq, w, h, x0, x1, cx: CX, rx: w / 2, ry, d, bot: base, top: base - h };
  }
  // A horizontal band of the side of the cake, between heights yA (upper) and yB (lower).
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
    return `M${f1(t.x0 + inset)} ${f1(t.top)}A${f1(t.rx - inset)} ${f1(t.ry - inset * .2)} 0 1 0 ${f1(t.x1 - inset)} ${f1(t.top)}A${f1(t.rx - inset)} ${f1(t.ry - inset * .2)} 0 1 0 ${f1(t.x0 + inset)} ${f1(t.top)}Z`;
  }
  // Point on the front edge at fraction u (0 left .. 1 right), at height y.
  function front(t, u, y) {
    if (t.sq) return [t.x0 + t.w * u, y, 1];
    const a = Math.PI * u;
    return [t.cx - t.rx * Math.cos(a), y + t.ry * Math.sin(a), 0.55 + 0.45 * Math.sin(a)];
  }
  // Point on the top surface: u, v in -1..1 (v = -1 back, +1 front).
  function onTop(t, u, v) {
    if (t.sq) {
      const depth = (1 - v) / 2;
      const k = t.w * 0.07 * depth;
      return [t.cx + u * (t.w / 2 - k - 14), t.top - t.d * depth];
    }
    return [t.cx + u * t.rx * 0.82, t.top + v * t.ry * 0.78];
  }

  // ----------------------------------------------------------------- pieces
  function g(k, body, extra) { return `<g data-k="${esc(k)}" ${extra || ""}>${body}</g>`; }

  function plate(view) {
    return g("plate", `
      <ellipse cx="${CX}" cy="${PLATE_Y + 52}" rx="130" ry="12" fill="#2a0612" opacity=".18"/>
      <path d="M${CX - 34} ${PLATE_Y + 18}h68l14 30h-96z" fill="url(#lc-stand)"/>
      <ellipse cx="${CX}" cy="${PLATE_Y + 48}" rx="62" ry="9" fill="url(#lc-stand)"/>
      <ellipse cx="${CX}" cy="${PLATE_Y + 8}" rx="186" ry="${view === "inside" ? 14 : 34}" fill="url(#lc-plate)"/>
      <ellipse cx="${CX}" cy="${PLATE_Y + 4}" rx="176" ry="${view === "inside" ? 10 : 30}" fill="#fffdfd"/>`);
  }

  function sidePiece(t, d, m, flavor, filling) {
    const out = [];
    const naked = d.finish === "naked", semi = d.finish === "seminaked";
    if (naked || semi) {
      // sponge / filling stripes, drawn bottom up so each sits on the last
      const layers = [["s", .3], ["f", .06], ["s", .3], ["f", .06], ["s", .28]];
      let y = t.bot;
      const spongeC = flavor.color || "#F3DDA8", fillC = filling.color || "#FFF4DD";
      layers.forEach(([kind, frac], idx) => {
        const hh = t.h * frac, y2 = y - hh;
        out.push(`<path d="${band(t, y2, y)}" fill="${kind === "s" ? spongeC : fillC}"/>`);
        if (kind === "s") out.push(`<path d="${band(t, y2, y2 + 2)}" fill="${mix(spongeC, "#3a1a10", .18)}" opacity=".5"/>`);
        y = y2;
      });
      if (flavor.speckle) {
        const r = rng("speck" + t.i);
        for (let i = 0; i < 26; i++) {
          const [x, yy] = front(t, .05 + r() * .9, t.top + 6 + r() * (t.h - 14));
          out.push(`<rect x="${f1(x)}" y="${f1(yy)}" width="4" height="1.6" rx=".8" fill="${["#E9548A", "#5BB7E5", "#F4C94A", "#8FD18B"][i % 4]}" transform="rotate(${Math.round(r() * 180)} ${f1(x)} ${f1(yy)})"/>`);
        }
      }
      if (semi) {
        out.push(`<path d="${band(t, t.top, t.bot)}" style="fill:var(--frost)" opacity=".72"/>`);
        const r = rng("semi" + t.i);
        for (let i = 0; i < 9; i++) {
          const u = .06 + r() * .88, [x, y1] = front(t, u, t.top + 8 + r() * (t.h - 20));
          out.push(`<ellipse cx="${f1(x)}" cy="${f1(y1)}" rx="${f1(6 + r() * 14)}" ry="${f1(2 + r() * 3)}" fill="${spongeC}" opacity=".55"/>`);
        }
      }
    } else {
      out.push(`<path d="${band(t, t.top, t.bot)}" style="fill:var(--frost)"/>`);
      if (d.finish === "textured") {
        for (let y = t.top + 8; y < t.bot - 4; y += 7) {
          out.push(t.sq ? `<path d="M${f1(t.x0)} ${f1(y)}H${f1(t.x1)}" style="stroke:var(--frost-dk)" stroke-width="1.6" opacity=".55"/>`
            : `<path d="M${f1(t.x0)} ${f1(y)}A${f1(t.rx)} ${f1(t.ry)} 0 0 0 ${f1(t.x1)} ${f1(y)}" fill="none" style="stroke:var(--frost-dk)" stroke-width="1.6" opacity=".55"/>`);
        }
      }
    }
    out.push(`<path d="${band(t, t.top, t.bot)}" fill="url(#lc-shade)"/>`);
    if (d.finish === "fondant" || d.finish === "smooth") {
      const x = t.x0 + t.w * .3;
      out.push(`<path d="${t.sq ? `M${f1(x)} ${f1(t.top)}h${f1(t.w * .06)}v${f1(t.h)}h${f1(-t.w * .06)}z` : `M${f1(x)} ${f1(t.top + t.ry * .6)}h${f1(t.w * .06)}v${f1(t.h)}h${f1(-t.w * .06)}z`}" fill="#fff" opacity="${d.finish === "fondant" ? .22 : .1}"/>`);
    }
    if (t.sq) out.push(`<path d="M${f1(t.x1)} ${f1(t.top)}L${f1(t.x1 - t.w * .07)} ${f1(t.top - t.d)}" stroke="#000" stroke-opacity=".06"/>`);
    return out.join("");
  }

  function topSurface(t, d, flavor) {
    const naked = d.finish === "naked";
    const fill = naked ? `fill="${mix(flavor.color || "#F3DDA8", "#ffffff", .1)}"` : `style="fill:var(--frost-lt)"`;
    let s = `<path d="${topPath(t)}" ${fill}/>`;
    if (!naked) s += `<path d="${topPath(t)}" fill="url(#lc-gloss)"/>`;
    return s;
  }

  function drip(t, d, m) {
    const dc = byId(m.drips, d.drip);
    if (!dc.hex) return "";
    const r = rng("drip" + t.i + d.shape + t.w);
    const pts = [], n = Math.max(9, Math.round(t.w / 18));
    // run along the front edge, dropping a rounded drip at irregular spots
    const edge = u => front(t, u, t.top);
    let path = "";
    const [sx, sy] = edge(0);
    path += `M${f1(sx)} ${f1(sy - 2)}`;
    for (let i = 0; i < n; i++) {
      const u0 = i / n, u1 = (i + 1) / n;
      const [ax, ay, sc] = edge(u0 + (u1 - u0) * .3), [bx, by] = edge(u0 + (u1 - u0) * .7), [ex, ey] = edge(u1);
      const len = (8 + r() * (t.h * .42)) * sc;
      const wdt = (bx - ax);
      path += `L${f1(ax)} ${f1(ay + 5)}`;
      path += `C${f1(ax + wdt * .1)} ${f1(ay + 5 + len * .6)} ${f1(ax)} ${f1(ay + 5 + len)} ${f1(ax + wdt / 2)} ${f1(ay + 5 + len)}`;
      path += `C${f1(bx)} ${f1(by + 5 + len)} ${f1(bx - wdt * .1)} ${f1(by + 5 + len * .6)} ${f1(bx)} ${f1(by + 5)}`;
      path += `L${f1(ex)} ${f1(ey + 5)}`;
      pts.push(len);
    }
    const [lx, ly] = edge(1);
    path += `L${f1(lx)} ${f1(ly - 2)}Z`;
    const hl = mix(dc.hex, "#ffffff", .35);
    return `<path d="${topPath(t)}" style="fill:var(--drip)"/><path d="${path}" style="fill:var(--drip)"/>
      <path d="${topPath(t, t.w * .18)}" fill="${hl}" opacity=".18"/>
      ${d.drip === "gold" ? `<path d="${path}" fill="url(#lc-gold)" opacity=".85"/><path d="${topPath(t)}" fill="url(#lc-gold)" opacity=".85"/>` : ""}`;
  }

  function border(t, d, where) {
    if (d.border === "none") return "";
    const y = where === "bottom" ? t.bot : t.top;
    const n = Math.round(t.w / (d.border === "rosettes" ? 17 : 11));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const [x, yy, sc] = front(t, i / n, y);
      const yb = where === "bottom" ? yy - 3 * sc : yy;
      if (d.border === "pearls") {
        out.push(`<circle cx="${f1(x)}" cy="${f1(yb)}" r="${f1(4.4 * sc)}" fill="url(#lc-pearl)"/>`);
      } else if (d.border === "shells") {
        out.push(`<path d="M${f1(x - 6 * sc)} ${f1(yb + 2)}q${f1(6 * sc)} ${f1(-12 * sc)} ${f1(13 * sc)} ${f1(-1)}q${f1(-6 * sc)} ${f1(4 * sc)} ${f1(-13 * sc)} ${f1(1)}z" style="fill:var(--frost-lt);stroke:var(--frost-dk)" stroke-width=".8" stroke-opacity=".5"/>`);
      } else if (d.border === "rosettes") {
        const rr = 7.5 * sc;
        out.push(`<circle cx="${f1(x)}" cy="${f1(yb)}" r="${f1(rr)}" style="fill:var(--frost-lt)"/><path d="M${f1(x)} ${f1(yb)}m${f1(-rr * .6)} 0a${f1(rr * .6)} ${f1(rr * .6)} 0 1 1 ${f1(rr * .9)} ${f1(rr * .3)}a${f1(rr * .35)} ${f1(rr * .35)} 0 1 1 ${f1(-rr * .4)} ${f1(-rr * .4)}" fill="none" style="stroke:var(--frost-dk)" stroke-width="1" opacity=".55"/>`);
      }
    }
    return out.join("");
  }

  // Decorations on the side of a tier.
  function sideDecor(t, d, key) {
    const out = [];
    const r = rng(key + t.i);
    if (key === "goldleaf") {
      for (let i = 0; i < Math.round(t.w / 22); i++) {
        const [x, y] = front(t, .08 + r() * .84, t.top + 10 + r() * (t.h - 22));
        const s = 4 + r() * 9;
        out.push(`<path d="M${f1(x)} ${f1(y)}l${f1(s)} ${f1(-s * .3)}l${f1(s * .2)} ${f1(s * .7)}l${f1(-s * .8)} ${f1(s * .5)}z" fill="url(#lc-gold)"/>`);
      }
    } else if (key === "pearls") {
      for (let i = 0; i < Math.round(t.w / 9); i++) {
        const [x, y, sc] = front(t, .04 + r() * .92, t.top + 8 + r() * (t.h - 16));
        out.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1((1.5 + r() * 2) * sc)}" fill="url(#lc-pearl)"/>`);
      }
    } else if (key === "sprinkles") {
      const cols = ["#E9548A", "#5BB7E5", "#F4C94A", "#8FD18B", "#ffffff", "#B47EDB"];
      for (let i = 0; i < Math.round(t.w / 5); i++) {
        const [x, y] = front(t, .04 + r() * .92, t.top + 6 + r() * (t.h * .45));
        out.push(`<rect x="${f1(x)}" y="${f1(y)}" width="5" height="1.8" rx=".9" fill="${cols[i % cols.length]}" transform="rotate(${Math.round(r() * 180)} ${f1(x)} ${f1(y)})"/>`);
      }
    }
    return out.join("");
  }

  function bow(t) {
    const yA = t.bot - 26, yB = t.bot - 12;
    const [bx, by] = front(t, .5, yA);
    return `<path d="${band(t, yA, yB)}" fill="url(#lc-ribbon)"/>
      <path d="M${f1(bx)} ${f1(by + 7)}c-22 -18 -40 -10 -34 4c4 10 22 6 34 -4z" fill="#8C1D3C"/>
      <path d="M${f1(bx)} ${f1(by + 7)}c22 -18 40 -10 34 4c-4 10 -22 6 -34 -4z" fill="#7A1A35"/>
      <path d="M${f1(bx - 4)} ${f1(by + 9)}l-10 26l8 -4l4 7l6 -27z M${f1(bx + 4)} ${f1(by + 9)}l10 26l-8 -4l-4 7l-6 -27z" fill="#6b1530"/>
      <ellipse cx="${f1(bx)}" cy="${f1(by + 8)}" rx="6" ry="7" fill="#9e2447"/>`;
  }

  function message(t, d, text) {
    if (!text) return "";
    const y = t.top + t.h * (d.border !== "none" ? .5 : .56);
    const [, yy] = front(t, .5, y);
    const size = Math.min(30, (t.w * .82) / Math.max(text.length * .42, 4));
    return `<text x="${CX}" y="${f1(yy)}" text-anchor="middle" font-family="Pinyon Script, cursive" font-size="${f1(size)}" style="fill:var(--ink)">${esc(text)}</text>`;
  }

  // Toppings sitting on a surface, sorted back to front.
  function cluster(t, items, seed, area) {
    const r = rng(seed);
    const out = [];
    const spots = [];
    items.forEach(kind => {
      const count = { berries: 9, flowers: 5, macarons: 5, shards: 6, candles: 5 }[kind] || 0;
      for (let i = 0; i < count; i++) {
        let u, v;
        if (area === "ledge") { u = -.98 + r() * .5; v = .1 + r() * .7; }
        else if (kind === "candles") { u = -0.55 + (i / (count - 1)) * 1.1; v = -.2 + (i % 2) * .35; }
        else if (kind === "shards") { u = -.7 + r() * 1.4; v = -.8 + r() * .6; }
        else if (kind === "macarons") { const a = (i / count) * Math.PI * 2 + .3; u = Math.cos(a) * .72; v = Math.sin(a) * .72; }
        else { u = -.8 + r() * 1.0; v = -.5 + r() * 1.1; }
        const [x, y] = onTop(t, u, v);
        spots.push({ kind, x, y, s: .8 + r() * .45, rot: r() * 360, c: r(), i });
      }
    });
    spots.sort((a, b) => a.y - b.y);
    spots.forEach(p => out.push(piece(p)));
    return out.join("");
  }

  function piece(p) {
    const { x, y, s } = p;
    switch (p.kind) {
      case "berries": {
        if (p.i % 3 === 0) return `<g transform="translate(${f1(x)} ${f1(y)}) scale(${f1(s)}) rotate(${Math.round(p.rot % 40 - 20)})"><path d="M0 -12c-9 0 -12 7 -9 13c3 6 9 9 9 9s6 -3 9 -9c3 -6 0 -13 -9 -13z" fill="#C8243A"/><path d="M-6 -12l6 3l6 -3l-3 -3l-3 2l-3 -2z" fill="#4E8A3A"/><g fill="#F6D27A"><circle cx="-4" cy="-4" r=".8"/><circle cx="3" cy="-3" r=".8"/><circle cx="-1" cy="2" r=".8"/><circle cx="4" cy="3" r=".8"/></g></g>`;
        if (p.i % 3 === 1) return `<g transform="translate(${f1(x)} ${f1(y)}) scale(${f1(s)})"><circle cy="-5" r="6" fill="#2E3A75"/><circle cx="-2" cy="-7" r="1.6" fill="#7C88C5"/><path d="M-1.5 -11h3l-1.5 2z" fill="#1c2450"/></g>`;
        return `<g transform="translate(${f1(x)} ${f1(y)}) scale(${f1(s)})"><g fill="#B5213F"><circle cx="-3" cy="-5" r="3.4"/><circle cx="3" cy="-5" r="3.4"/><circle cx="0" cy="-9" r="3.4"/><circle cx="0" cy="-2" r="3.4"/></g><g fill="#E25A75"><circle cx="-2" cy="-7" r="1"/><circle cx="2" cy="-4" r="1"/></g></g>`;
      }
      case "flowers": {
        const pal = [["#F4C7CF", "#E59AA8"], ["#FFFFFF", "#EDE3E5"], ["#7A1A35", "#5E0F25"], ["#F7C9A6", "#E8A57B"]][p.i % 4];
        const R = 13 * s;
        return `<g transform="translate(${f1(x)} ${f1(y - R * .6)})">
          <ellipse cx="${f1(-R * 1.1)}" cy="${f1(R * .5)}" rx="${f1(R * .75)}" ry="${f1(R * .28)}" fill="#7E9A6A" transform="rotate(-20 ${f1(-R * 1.1)} ${f1(R * .5)})"/>
          <ellipse cx="${f1(R * 1.05)}" cy="${f1(R * .55)}" rx="${f1(R * .7)}" ry="${f1(R * .26)}" fill="#93AE7E" transform="rotate(25 ${f1(R * 1.05)} ${f1(R * .55)})"/>
          <circle r="${f1(R)}" fill="${pal[0]}"/>
          <path d="M${f1(-R * .7)} 0a${f1(R * .7)} ${f1(R * .7)} 0 1 1 ${f1(R * 1.2)} ${f1(R * .35)}a${f1(R * .45)} ${f1(R * .45)} 0 1 1 ${f1(-R * .6)} ${f1(-R * .55)}a${f1(R * .2)} ${f1(R * .2)} 0 1 1 ${f1(R * .25)} ${f1(R * .2)}" fill="none" stroke="${pal[1]}" stroke-width="${f1(R * .14)}" stroke-linecap="round"/>
        </g>`;
      }
      case "macarons": {
        const c = ["#F4C7CF", "#C9DDB5", "#D3C2EA", "#F8E3A0", "#BFD9EE"][p.i % 5];
        return `<g transform="translate(${f1(x)} ${f1(y)}) scale(${f1(s)})"><ellipse cy="-4" rx="11" ry="5" fill="${mix(c, "#000", .08)}"/><rect x="-10" y="-9" width="20" height="4" rx="2" fill="#FFF6EA"/><ellipse cy="-12" rx="11" ry="5" fill="${c}"/><ellipse cy="-13.5" rx="7" ry="2" fill="#fff" opacity=".35"/></g>`;
      }
      case "shards": {
        const c = p.i % 2 ? "#3B1E15" : "#5A3020";
        return `<g transform="translate(${f1(x)} ${f1(y)}) rotate(${Math.round(p.rot % 50 - 25)})"><path d="M-7 2L-3 ${f1(-30 * s)}L9 ${f1(-18 * s)}L6 2z" fill="${c}"/><path d="M-3 ${f1(-30 * s)}L9 ${f1(-18 * s)}L4 ${f1(-16 * s)}z" fill="#fff" opacity=".12"/></g>`;
      }
      case "candles": {
        const c = ["#F4C7CF", "#BFD9EE", "#F8E3A0", "#D3C2EA", "#C9DDB5"][p.i % 5];
        return `<g transform="translate(${f1(x)} ${f1(y)})"><rect x="-2.6" y="-34" width="5.2" height="34" rx="1.4" fill="${c}"/><path d="M-2.6 -28l5.2 -4M-2.6 -18l5.2 -4M-2.6 -8l5.2 -4" stroke="#fff" stroke-width="1.6"/><path d="M0 -35v-4" stroke="#333" stroke-width="1"/><path class="lc-flame" d="M0 -50c4 6 4 10 0 11c-4 -1 -4 -5 0 -11z" fill="#FFB938"/><path class="lc-flame" d="M0 -45c2 3 2 5 0 6c-2 -1 -2 -3 0 -6z" fill="#FFF3C4"/></g>`;
      }
    }
    return "";
  }

  function topper(t, d) {
    if (d.topper === "script" && d.topper_text) {
      const y = t.top - (t.sq ? t.d * .5 : 0) - 70;
      const size = Math.min(48, 330 / Math.max(d.topper_text.length * .5, 3));
      return `<path d="M${CX - 30} ${f1(y + 22)}V${f1(y + 74)}M${CX + 30} ${f1(y + 22)}V${f1(y + 74)}" stroke="url(#lc-gold)" stroke-width="2.4"/>
        <text x="${CX}" y="${f1(y + 14)}" text-anchor="middle" font-family="Pinyon Script, cursive" font-size="${f1(size)}" fill="url(#lc-gold)" stroke="#8a6a1e" stroke-width=".4">${esc(d.topper_text)}</text>`;
    }
    if (d.topper === "number" && d.number) {
      const y = t.top - (t.sq ? t.d * .5 : 0) - 4;
      const digits = d.number.split("");
      const wEach = 40;
      return digits.map((ch, i) => {
        const x = CX + (i - (digits.length - 1) / 2) * wEach;
        return `<g><text x="${f1(x)}" y="${f1(y)}" text-anchor="middle" font-family="Bodoni Moda, serif" font-weight="700" font-size="68" fill="url(#lc-gold)" stroke="#8a6a1e" stroke-width=".6">${esc(ch)}</text>
          <path d="M${f1(x)} ${f1(y - 52)}v-5" stroke="#333"/><path class="lc-flame" d="M${f1(x)} ${f1(y - 72)}c4 6 4 10 0 11c-4 -1 -4 -5 0 -11z" fill="#FFB938"/></g>`;
      }).join("");
    }
    return "";
  }

  // ---------------------------------------------------------- inside view
  function inside(d, m, hl) {
    const n = d.shape === "sheet" ? 1 : (d.tiers || 1);
    const tiers = layout(d);
    const out = [];
    const naked = d.finish === "naked";
    tiers.forEach((t, i) => {
      const fl = byId(m.flavors, d.flavors[i]), fi = byId(m.fillings, d.fillings[i]);
      const shell = naked ? 0 : d.finish === "seminaked" ? 2 : 6;
      const x = t.x0, w = t.w, top = t.bot - t.h;
      let s = `<rect x="${f1(x)}" y="${f1(top)}" width="${f1(w)}" height="${f1(t.h)}" rx="3" ${naked ? `fill="${fl.color}"` : `style="fill:var(--frost)"`}/>`;
      const ix = x + shell, iw = w - shell * 2, ih = t.h - shell - 2;
      const layers = [["s", .3], ["f", .065], ["s", .3], ["f", .065], ["s", .27]];
      let y = t.bot - 2;
      layers.forEach(([k, frac]) => {
        const hh = ih * frac;
        s += `<rect x="${f1(ix)}" y="${f1(y - hh)}" width="${f1(iw)}" height="${f1(hh + .4)}" fill="${k === "s" ? fl.color : fi.color}"/>`;
        if (k === "s") {
          const r = rng("crumb" + i + y);
          for (let c = 0; c < iw / 9; c++) s += `<circle cx="${f1(ix + r() * iw)}" cy="${f1(y - r() * hh)}" r="${f1(.6 + r() * 1.2)}" fill="${fl.speckle ? ["#E9548A", "#5BB7E5", "#F4C94A", "#8FD18B"][c % 4] : mix(fl.color, "#3a1a10", .25)}" opacity="${fl.speckle ? .9 : .35}"/>`;
        }
        y -= hh;
      });
      if (d.drip !== "none") s += `<rect x="${f1(x)}" y="${f1(top - 2)}" width="${f1(w)}" height="5" rx="2" style="fill:var(--drip)"/>`;
      if (n > 1 && i < n - 1) s += `<g fill="#E9DCCB"><rect x="${f1(CX - w * .22)}" y="${f1(top - t.h + 4)}" width="3" height="${f1(t.h)}"/><rect x="${f1(CX + w * .22)}" y="${f1(top - t.h + 4)}" width="3" height="${f1(t.h)}"/></g>`;
      if (hl === i) s += `<rect x="${f1(x - 5)}" y="${f1(top - 5)}" width="${f1(w + 10)}" height="${f1(t.h + 8)}" rx="8" fill="none" stroke="#C9A24A" stroke-width="2.5" stroke-dasharray="6 5"/>`;
      out.push(g(`in-tier-${i}-${d.shape}-${t.w}`, s));
    });
    return out.join("");
  }

  // ------------------------------------------------------------------- render
  function defs() {
    return `<defs>
      <linearGradient id="lc-shade" x1="0" x2="1"><stop offset="0" stop-color="#2a0612" stop-opacity=".22"/><stop offset=".3" stop-color="#fff" stop-opacity=".1"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#2a0612" stop-opacity=".3"/></linearGradient>
      <radialGradient id="lc-gloss" cx=".4" cy=".35" r=".7"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <linearGradient id="lc-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F6E3A1"/><stop offset=".45" stop-color="#C9A24A"/><stop offset=".7" stop-color="#F2D88A"/><stop offset="1" stop-color="#A9822F"/></linearGradient>
      <radialGradient id="lc-pearl" cx=".35" cy=".35" r=".7"><stop offset="0" stop-color="#fff"/><stop offset=".7" stop-color="#F3ECEA"/><stop offset="1" stop-color="#CDBFC2"/></radialGradient>
      <linearGradient id="lc-plate" x1="0" x2="1"><stop offset="0" stop-color="#D9CDD0"/><stop offset=".5" stop-color="#fff"/><stop offset="1" stop-color="#CBBDC1"/></linearGradient>
      <linearGradient id="lc-stand" x1="0" x2="1"><stop offset="0" stop-color="#CFC1C5"/><stop offset=".5" stop-color="#fff"/><stop offset="1" stop-color="#BFAFB4"/></linearGradient>
      <linearGradient id="lc-ribbon" x1="0" x2="1"><stop offset="0" stop-color="#5E0F25"/><stop offset=".4" stop-color="#9e2447"/><stop offset="1" stop-color="#4A0B1D"/></linearGradient>
    </defs>`;
  }

  function colors(svg, d, m) {
    const base = d.color === "custom" && d.custom_hex ? d.custom_hex : (byId(m.colors, d.color).hex || "#FBF3E4");
    const dc = byId(m.drips, d.drip).hex || base;
    svg.style.setProperty("--frost", base);
    svg.style.setProperty("--frost-lt", mix(base, "#ffffff", .12));
    svg.style.setProperty("--frost-dk", mix(base, "#2a0612", .28));
    svg.style.setProperty("--drip", dc);
    const naked = d.finish === "naked";
    svg.style.setProperty("--ink", lum(naked ? (byId(m.flavors, d.flavors[0]).color || "#F3DDA8") : base) > .38 ? "#5E0F25" : "#FFF7F8");
  }

  function build(d, m, view, hl) {
    const parts = [defs(), plate(view)];
    if (view === "inside") { parts.push(inside(d, m, hl)); return parts.join(""); }
    const tiers = layout(d);
    tiers.forEach((t, i) => {
      const fl = byId(m.flavors, d.flavors[i]), fi = byId(m.fillings, d.fillings[i]);
      const k = `tier-${i}-${d.shape}-${Math.round(t.w)}`;
      parts.push(g(k, sidePiece(t, d, m, fl, fi)));
      ["goldleaf", "pearls", "sprinkles"].forEach(x => { if (d.decor.includes(x)) parts.push(g(`${x}-${k}`, sideDecor(t, d, x))); });
      if (d.decor.includes("bow") && i === 0) parts.push(g(`bow-${k}`, bow(t)));
      if (i === 0 && d.message) parts.push(g(`msg-${d.message}-${k}`, message(t, d, d.message)));
      if (d.border !== "none") parts.push(g(`border-${d.border}-${k}`, border(t, d, "bottom")));
      parts.push(g(`top-${k}`, topSurface(t, d, fl)));
      if (d.drip !== "none") parts.push(g(`drip-${d.drip === "gold" ? "g" : "c"}-${k}`, drip(t, d, m)));
      if (d.border === "pearls" && d.finish === "fondant") parts.push(g(`bt-${k}`, border(t, d, "top")));
      // little arrangements on the ledge of each lower tier
      if (i < tiers.length - 1) {
        const ledge = d.decor.filter(x => ["flowers", "berries", "macarons"].includes(x)).slice(0, 2);
        if (ledge.length) parts.push(g(`ledge-${ledge.join("")}-${k}`, cluster(t, ledge, "ledge" + i, "ledge")));
      }
    });
    const topT = tiers[tiers.length - 1];
    const tk = `top-${tiers.length}-${d.shape}-${Math.round(topT.w)}`;
    if (d.decor.includes("sprinkles")) parts.push(g(`sprtop-${tk}`, sprinkleTop(topT)));
    if (d.decor.includes("goldleaf")) parts.push(g(`goldtop-${tk}`, goldTop(topT)));
    const onTopItems = ["shards", "macarons", "berries", "flowers", "candles"].filter(x => d.decor.includes(x));
    onTopItems.forEach(x => parts.push(g(`${x}-${tk}`, cluster(topT, [x], x + tk, "top"))));
    if (d.topper !== "none") parts.push(g(`topper-${d.topper}-${d.topper_text || d.number}-${tk}`, topper(topT, d)));
    return parts.join("");
  }
  function sprinkleTop(t) {
    const r = rng("spt"), out = [];
    const cols = ["#E9548A", "#5BB7E5", "#F4C94A", "#8FD18B", "#ffffff", "#B47EDB"];
    for (let i = 0; i < 60; i++) {
      const [x, y] = onTop(t, -1 + r() * 2, -1 + r() * 2);
      const a = Math.atan2(y - t.top, (x - t.cx) / 2.5);
      if (!t.sq && ((x - t.cx) ** 2 / (t.rx * .82) ** 2 + (y - t.top) ** 2 / (t.ry * .78) ** 2) > 1) continue;
      out.push(`<rect x="${f1(x)}" y="${f1(y)}" width="4.5" height="1.6" rx=".8" fill="${cols[i % cols.length]}" transform="rotate(${Math.round(r() * 180)} ${f1(x)} ${f1(y)})"/>`);
    }
    return out.join("");
  }
  function goldTop(t) {
    const r = rng("gt"), out = [];
    for (let i = 0; i < 7; i++) {
      const [x, y] = onTop(t, -.8 + r() * 1.6, -.6 + r() * 1.2);
      const s = 5 + r() * 8;
      out.push(`<path d="M${f1(x)} ${f1(y)}l${f1(s)} ${f1(-s * .2)}l${f1(-s * .3)} ${f1(s * .35)}z" fill="url(#lc-gold)"/>`);
    }
    return out.join("");
  }

  function normalize(d) {
    d = Object.assign({ shape: "round", tiers: 1, size: "8", flavors: [], fillings: [], finish: "smooth", color: "cream", custom_hex: "",
      drip: "none", border: "none", decor: [], topper: "none", topper_text: "", number: "", message: "" }, d || {});
    if (d.color && d.color[0] === "#") { d.custom_hex = d.color; d.color = "custom"; }
    return d;
  }

  function render(svg, design, menu, opts) {
    opts = opts || {};
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
