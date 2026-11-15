// src/journal/mediaCard.ts
var MW = 1080;
var MH = 1350;
var LOOP = 7;
var MAX_CLIP = 60;
var clipOf = (seconds) => Math.min(MAX_CLIP, Math.max(1, seconds));
var SANS = "Inter";
var MONO = '"Geist Mono"';
var SERIF = '"Instrument Serif"';
var UP = "#3ccf7a";
var DOWN = "#f06b6b";
var FLAT = "#8e8e94";
var SOFT = "#c9c9cd";
var ACCENT = "#8d9bff";
var MARK = [
  "M16.01 24.58Q14.00 20.00 19.00 20.00L30.85 20.00Q35.85 20.00 37.86 24.58L46.99 45.42Q49.00 50.00 44.00 50.00L32.15 50.00Q27.15 50.00 25.14 45.42Z",
  "M62.14 15.58Q64.15 11.00 69.15 11.00L81.00 11.00Q86.00 11.00 83.99 15.58L74.86 36.42Q72.85 41.00 67.85 41.00L56.00 41.00Q51.00 41.00 53.01 36.42Z",
  "M40.00 61.00Q40.00 56.00 45.00 56.00L55.00 56.00Q60.00 56.00 60.00 61.00L60.00 87.00Q60.00 92.00 55.00 92.00L45.00 92.00Q40.00 92.00 40.00 87.00Z"
];
var MARK_PATHS = typeof Path2D !== "undefined" ? MARK.map((d) => new Path2D(d)) : [];
var mediaFonts = () => Promise.all(["800 92px Inter", "500 92px Inter", '600 58px "Geist Mono"', '500 28px "Geist Mono"', 'italic 400 38px "Instrument Serif"'].map((f) => document.fonts.load(f))).then(() => document.fonts.ready);
var clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
var lerp = (a, b, k) => a + (b - a) * k;
var prog = (t, a, b) => clamp((t - a) / (b - a));
var inOut = (k) => {
  k = clamp(k);
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
};
var outCubic = (k) => 1 - Math.pow(1 - clamp(k), 3);
var outQuart = (k) => 1 - Math.pow(1 - clamp(k), 4);
var playOf = (t) => {
  if (t < 0.7) return 1;
  if (t < 1.3) return 1 - inOut(prog(t, 0.7, 1.3));
  if (t < 2.6) return 0;
  const k = prog(t, 2.6, 4.1) - 1;
  return 1 + 1.6 * k * k * k + 0.6 * k * k;
};
function warp(t, dur) {
  const OUT = 0.9, outAt = Math.max(0, dur - OUT);
  if (t >= outAt) return 0.7 + 0.6 * clamp((t - outAt) / OUT);
  const speed = clamp((dur - 1.1) / 3.6, 0.4, 1);
  return 1.3 + t / speed;
}
var val = (t, a, b, ease = outCubic) => t < 0.7 ? 1 : t < 1.3 ? 1 - inOut(prog(t, 0.7, 1.3)) : ease(prog(t, a, b));
function text(c, s, x, y, font, fill, ls = 0, align = "left", alpha = 1) {
  const was = c.globalAlpha;
  c.font = font;
  c.fillStyle = fill;
  c.textBaseline = "alphabetic";
  c.textAlign = "left";
  c.globalAlpha = was * alpha;
  if (!ls) c.fillText(s, align === "right" ? x - c.measureText(s).width : x, y);
  else {
    const chars = [...s], widths = chars.map((ch) => c.measureText(ch).width + ls);
    let cx = align === "right" ? x - widths.reduce((a, b) => a + b, 0) + ls : x;
    chars.forEach((ch, i) => {
      c.fillText(ch, cx, y);
      cx += widths[i];
    });
  }
  c.globalAlpha = was;
}
var money = (v) => `${v < 0 ? "\u2212" : "+"}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
var px = (v) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function ruleOf(e) {
  const lv = e.levels ?? {}, r = e.r_multiple;
  if (lv.entry != null && lv.stop != null && lv.stop !== lv.entry) {
    const sign = lv.stop < lv.entry ? 1 : -1, risk = Math.abs(lv.entry - lv.stop);
    const target = lv.target ?? lv.entry + sign * risk * Math.max(2, Math.ceil(Math.abs(r ?? 0)) + 1);
    return { kind: "price", stop: lv.stop, entry: lv.entry, target, exit: lv.exit ?? (r != null ? lv.entry + sign * risk * r : null), showTarget: lv.target != null, sign };
  }
  if (r != null) return { kind: "r", stop: -1, entry: 0, target: Math.max(2, Math.ceil(Math.abs(r)) + 1), exit: r, showTarget: false, sign: 1 };
  return null;
}
var rFmt = (v) => `${v > 0 ? "+" : v < 0 ? "\u2212" : ""}${Math.abs(v)}R`;
function odometer(c, final, p, sign, tone, x0, base) {
  const f = "800 92px Inter", ls = -3.5;
  const digits = [...Math.abs(final).toFixed(1)].filter((ch) => ch !== ".").map(Number);
  const nInt = digits.length - 1;
  const widths = widthsOf(c, f);
  const widthAt = (pos) => {
    const i = Math.floor(pos), k = pos - i;
    return lerp(widths[i % 10], widths[(i + 1) % 10], k);
  };
  let x = x0;
  text(c, sign, x, base, f, tone, ls);
  x += c.measureText(sign).width + ls;
  const col = (pp, cx, w) => {
    c.save();
    c.beginPath();
    c.rect(cx - 4, base - 80, w + 8, 90);
    c.clip();
    const row = Math.floor(pp);
    for (let i = row; i <= row + 1; i++) text(c, String(i % 10), cx, base + (i - pp) * 100, f, tone, ls);
    c.restore();
  };
  const target = Math.round(Math.abs(final) * 10), u = clamp(target * Math.max(0, p), 0, target);
  const step = Math.floor(u + 1e-9), e = outCubic(u - step);
  digits.forEach((_, i) => {
    if (i === nInt) {
      text(c, ".", x, base, f, tone, ls);
      x += c.measureText(".").width + ls;
    }
    const k = digits.length - 1 - i, unit = Math.pow(10, k);
    const pp = Math.floor(step / unit) % 10 + (k === 0 || step % unit === unit - 1 ? e : 0), w = widthAt(pp);
    col(pp, x, w);
    x += w + ls;
  });
  text(c, "R", x, base, f, tone, ls);
}
var widthCache = /* @__PURE__ */ new Map();
function widthsOf(c, font) {
  let w = widthCache.get(font);
  if (!w || w.some((v) => !v)) {
    c.font = font;
    w = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => c.measureText(String(d)).width);
    widthCache.set(font, w);
  }
  return w;
}
var sprites = /* @__PURE__ */ new Map();
function markSprite(color) {
  let s = sprites.get(color);
  if (!s) {
    s = document.createElement("canvas");
    s.width = 128;
    s.height = 144;
    const g = s.getContext("2d"), k = 128 / 76;
    g.scale(k, k);
    g.translate(-12, -9);
    g.strokeStyle = color;
    g.lineWidth = 3.4;
    g.lineJoin = "round";
    MARK_PATHS.forEach((path) => g.stroke(path));
    sprites.set(color, s);
  }
  return s;
}
function drawLattice(c, t) {
  c.fillStyle = "#111112";
  c.fillRect(0, 0, MW, MH);
  const ph = 2 * Math.PI * t / LOOP, white = markSprite("#ffffff"), blue = markSprite("#4d7dff"), step = 76;
  for (let row = 0, y = 20; y < MH + step; row++, y += step * 0.9) for (let x = row % 2 * step / 2 - 20; x < MW + step; x += step) {
    const wave = (0.5 + 0.5 * Math.sin(x / 170 + y / 260 - ph)) * (0.5 + 0.5 * Math.cos(y / 210 - x / 390 + ph));
    const o = 0.17 * Math.max(0, wave * 1.5 - 0.25);
    if (o < 0.01) continue;
    if (wave > 0.8) {
      c.globalAlpha = Math.min(1, (wave - 0.8) * 5) * 0.17;
      c.drawImage(blue, x, y, 30, 34);
    }
    c.globalAlpha = o * 0.75;
    c.drawImage(white, x, y, 30, 34);
  }
  c.globalAlpha = 1;
}
function drawGround(c, media, dim) {
  c.fillStyle = "#111112";
  c.fillRect(0, 0, MW, MH);
  const k = Math.max(MW / media.w, MH / media.h), w = media.w * k, h = media.h * k;
  c.drawImage(media.el, (MW - w) / 2, (MH - h) / 2, w, h);
  c.fillStyle = `rgba(7,7,10,${dim})`;
  c.fillRect(0, 0, MW, MH);
}
function drawMediaCard(c, spec, media, tIn, ground, dur) {
  const t = dur ? warp(clamp(tIn, 0, dur), dur) : (tIn % LOOP + LOOP) % LOOP, e = spec.entry;
  const r = e.r_multiple, pnlV = e.pnl, lead = r ?? pnlV ?? 0;
  const tone = lead > 0 ? UP : lead < 0 ? DOWN : FLAT, sgn = lead < 0 ? "\u2212" : "+";
  c.save();
  c.clearRect(0, 0, MW, MH);
  if (ground) c.drawImage(ground, 0, 0, MW, MH);
  else if (media) drawGround(c, media, spec.dim);
  else drawLattice(c, t);
  if (spec.brand) {
    const k = val(t, 1.5, 2.1);
    c.save();
    c.globalAlpha = k;
    c.translate(52, 56);
    c.scale(0.58, 0.58);
    c.fillStyle = "#fff";
    MARK_PATHS.forEach((p2) => c.fill(p2));
    c.restore();
    c.save();
    c.globalAlpha = k;
    text(c, "YSER", 116, 97, `800 32px ${SANS}`, "#f2f2f3", -0.4);
    c.font = `800 32px ${SANS}`;
    const w = c.measureText("YSER").width - 0.4 * 4;
    text(c, "trades", 116 + w + 9, 97, `italic 400 38px ${SERIF}`, ACCENT);
    c.restore();
  }
  const rule = spec.ruler ? ruleOf(e) : null;
  const top = 236, bot = 820, ax = 1010;
  let yX = 0, travel = 1;
  if (rule) {
    const hi = Math.max(rule.target, rule.stop), lo = Math.min(rule.target, rule.stop);
    const Y = (v) => top + (hi - v) / (hi - lo || 1) * (bot - top);
    const yS = Y(rule.stop), yE = Y(rule.entry);
    yX = rule.exit != null ? Y(rule.exit) : yE;
    const yEnd = Math.abs(yE - yS) >= Math.abs(yX - yS) ? yE : yX, span = Math.abs(yEnd - yS) || 1, lo2 = Math.min(yS, yEnd) - 0.5, hi2 = Math.max(yS, yEnd) + 0.5;
    travel = playOf(t);
    const axis = val(t, 1.4, 2.3, inOut);
    c.strokeStyle = "rgba(255,255,255,.5)";
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(ax, yS);
    c.lineTo(ax, lerp(yS, yEnd, axis));
    c.stroke();
    for (let i = 0; i <= 26; i++) {
      const y = top + (bot - top) * i / 26, big = i % 5 === 0, order = Math.abs(y - yS) / span;
      if (y < lo2 || y > hi2) continue;
      const k = t < 1.3 ? val(t, 0, 1) : val(t, 1.4 + order * 0.8, 1.7 + order * 0.8);
      c.strokeStyle = `rgba(255,255,255,${(big ? 0.7 : 0.38) * k})`;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(ax - (big ? 22 : 11) * k, y);
      c.lineTo(ax, y);
      c.stroke();
    }
    const yD = lerp(yE, yX, travel), a = Math.min(yE, yD), b = Math.max(yE, yD);
    if (rule.exit != null && b > a) {
      c.fillStyle = tone;
      c.beginPath();
      c.roundRect(ax - 6, a, 12, b - a, 6);
      c.fill();
    }
    const entryK = val(t, 2.2, 2.55);
    c.strokeStyle = "#fff";
    c.lineWidth = 4;
    c.globalAlpha = entryK;
    c.beginPath();
    c.moveTo(ax + 6 - 40 * entryK, yE);
    c.lineTo(ax + 6, yE);
    c.stroke();
    c.globalAlpha = 1;
    const label = (y, name, value, tint, k) => {
      c.save();
      c.globalAlpha = k;
      c.translate(24 * (1 - k), 0);
      text(c, name, ax - 40, y - 5, `500 16px ${MONO}`, tint, 3, "right");
      text(c, value, ax - 40, y + 20, `600 23px ${MONO}`, "#fff", 0, "right");
      c.restore();
    };
    const f = rule.kind === "price" ? px : rFmt;
    label(yS, "STOP", f(rule.stop), "#f4c4c4", val(t, 1.6, 2.1));
    label(yE, "ENTRY", f(rule.entry), "#d6d6dc", val(t, 2, 2.5));
    const near = [yS, yE].some((y) => Math.abs(y - yX) < 50);
    const dotK = val(t, 2.3, 2.6);
    if (rule.exit != null) {
      if (!near && rule.kind === "price") label(yD, "EXIT", f(lerp(rule.entry, rule.exit, travel)), tone, dotK);
      c.fillStyle = tone;
      c.strokeStyle = "#0c0c0d";
      c.lineWidth = 4;
      c.beginPath();
      c.arc(ax, yD, 19 * dotK, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      const ring = prog(t, 4, 4.8);
      if (ring > 0 && ring < 1) {
        const k = outCubic(ring);
        c.strokeStyle = tone;
        c.lineWidth = 1 + 3 * (1 - k);
        c.globalAlpha = 1 - k;
        c.beginPath();
        c.arc(ax, yX, 19 + 62 * k, 0, Math.PI * 2);
        c.stroke();
        c.globalAlpha = 1;
      }
    }
  }
  const p = rule && rule.exit != null ? travel : playOf(t);
  if (r != null) {
    const k = val(t, 2.4, 2.8);
    c.save();
    c.globalAlpha = k;
    odometer(c, Math.abs(r), Math.min(p, 1), sgn, tone, 68, 1092);
    c.restore();
  }
  const nameK = val(t, 3.6, 4.3, outQuart), lineK = val(t, 3.8, 4.5);
  const sym = (e.instrument ?? "Trade").toUpperCase();
  c.save();
  c.beginPath();
  c.rect(66, 1112, 700, 100);
  c.clip();
  text(c, sym, 72, 1190 + 110 * (1 - nameK), `800 84px ${SANS}`, "#fff", -3);
  c.restore();
  const date = (/* @__PURE__ */ new Date(`${e.trade_date}T12:00:00`)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const dir = e.direction ? e.direction[0].toUpperCase() + e.direction.slice(1) : null;
  c.save();
  c.translate(0, 18 * (1 - lineK));
  text(c, [dir, e.session, date].filter(Boolean).join(" \xB7 "), 72, 1246, `500 30px ${SANS}`, SOFT, 0, "left", lineK);
  c.restore();
  if (spec.pnl && pnlV != null) {
    const k = val(t, 2.6, 3);
    c.save();
    c.globalAlpha = k;
    text(c, money(pnlV * p), MW - 72, 1186, `600 58px ${MONO}`, "#fff", -2, "right");
    if (rule && rule.kind === "price" && rule.exit != null) {
      const pts = (rule.exit - rule.entry) * rule.sign * p;
      text(c, `${pts < 0 ? "\u2212" : "+"}${Math.abs(pts).toFixed(2)} pts`, MW - 72, 1240, `500 28px ${MONO}`, SOFT, 0, "right");
    }
    c.restore();
  }
  c.restore();
}
var DIMS = { light: 0.22, medium: 0.4, heavy: 0.58 };
export {
  DIMS,
  LOOP,
  MAX_CLIP,
  MH,
  MW,
  clipOf,
  drawGround,
  drawMediaCard,
  mediaFonts
};
