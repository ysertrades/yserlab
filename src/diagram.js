import { env } from "./env.js";
import { fonts, svgToPng } from "./render.js";
import { Index, recall } from "./knowledge.js";
import { modelFor } from "./ai.js";
import { TEMPLATES, fromTemplate, mirror, stepsFromTemplate, templateList, toLtf } from "./diagramTemplates.js";
import { cisdMarks, ltfFromHtf } from "./compose.js";
import { SMT_RULES, asksAboutSmt } from "./smtLesson.js";
import { matchDrawings, namesWholePdf, pagesOf, pdfNamedIn, specFromDrawing } from "./pdfDrawings.js";

/**
 * Diagrams in the slides editor's own look. The editor's renderer is bundled in vendor/slides.mjs (scripts/slides/build.mjs), so a
 * diagram is a real editor page: the same candles, levels, zones, arrows, tags and footer, drawn by the same code.
 *
 * The AI never places pixels. It writes a small spec (candles by pattern or by numbers, then marks anchored to candles such as
 * "2:high"), and `compile` turns that into editor objects. A bad spec drops the bad part and still draws the rest.
 */
let lib = null;
const slides = async () => (lib ??= await import("../vendor/slides.mjs"));

const NAMED = { ss: "#2196f3", switch: "#2196f3", bull: "#84b884", bear: "#3d3d3d", blue: "#2f6bff", teal: "#0f9d80", red: "#ef3b4b", amber: "#f4b73e", ink: "#3d3d3d", muted: "#8a8f98", zone: "#fbecb8", tp: "#cfe8e1", sl: "#e2e3e6", green: "#0f9d80", gray: "#8a8a8f", grey: "#8a8a8f", yellow: "#f4b73e", black: "#000000", white: "#ffffff" };
const colour = (c, fallback) => NAMED[String(c ?? "").toLowerCase()] ?? (/^#[0-9a-f]{6}$/i.test(c ?? "") ? c : fallback);
const num = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Every string in a spec with plain spaces (a non-breaking space draws as a missing-glyph box). */
const clean = v => typeof v === "string" ? v.replace(/[\u00a0\u2007\u202f\u200b]/g, " ").replace(/\s+/g, " ").trim() : Array.isArray(v) ? v.map(clean) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) : v;

/** The pattern library, for the AI to pick from. */
export async function patternNames() { return Object.keys((await slides()).PATTERNS); }

/** One panel's candles as 0 to 1 bars (1 = top), from a library pattern or from [open, high, low, close] rows. */
function barsOf(L, panel) {
  let bars;
  if (Array.isArray(panel.bars) && panel.bars.length >= 1) {
    const rows = panel.bars.slice(0, 40).map(r => (Array.isArray(r) ? r : [r?.o, r?.h, r?.l, r?.c]).map(Number)).filter(r => r.length === 4 && r.every(Number.isFinite))
      .map(([o, h, l, c]) => [o, Math.max(h, o, c), Math.min(l, o, c), c]);
    if (rows.length) {
      const [rlo, rhi] = Array.isArray(panel.range) && panel.range.length === 2 ? panel.range.map(Number) : [NaN, NaN]; // `range`: panels that share one price scale
      const lo = Number.isFinite(rlo) ? rlo : Math.min(...rows.map(r => r[2])), hi = Number.isFinite(rhi) ? rhi : Math.max(...rows.map(r => r[1])), k = 1 / (hi - lo || 1);
      bars = rows.map(([o, h, l, c]) => ({ o: (o - lo) * k, h: (h - lo) * k, l: (l - lo) * k, c: (c - lo) * k }));
      if (panel.flip) bars = bars.map(b => ({ o: 1 - b.o, c: 1 - b.c, h: 1 - b.l, l: 1 - b.h }));
    }
  }
  if (!bars && panel.pattern) {
    const key = String(panel.pattern).toLowerCase().replace(/[\s_]+/g, "-");
    if (L.PATTERNS[key]) bars = L.makeBars(key, 0, 1, !!panel.flip);
    else if (["uptrend", "downtrend", "range", "consolidation", "breakout", "sweep", "vshape", "london-reversal", "ny-reversal", "london-expansion"].includes(key)) bars = L.makeBars(key, clamp(num(panel.count, 14), 4, 30), 7, !!panel.flip);
  }
  return bars ?? null;
}

/** "3:high", "2.5:close", "1:mid": where on which candle. Returns { bar, field } or null. */
function parseAnchor(a, n) {
  const s = String(a ?? "");
  const at = /^\s*(-?\d+(?:\.\d+)?)\s*:\s*@\s*(\d(?:\.\d+)?)\s*$/.exec(s); // "3:@0.5": half way up the panel
  if (at) return { bar: clamp(Number(at[1]), 1, n), field: "level", level: clamp(Number(at[2]), 0, 1) };
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*:\s*(high|low|open|close|mid|top|bottom)\s*$/i.exec(s);
  if (!m) return null;
  return { bar: clamp(Number(m[1]), 1, n), field: m[2].toLowerCase() };
}

/**
 * The spec as an editor page. Panels sit side by side (one or two), each: a run of candles and the marks around it. Everything is
 * placed from the candles, never from raw coordinates.
 */
export async function compile(spec) {
  const L = await slides();
  spec = clean(spec);
  const panels = (Array.isArray(spec?.panels) ? spec.panels : spec?.pattern || spec?.bars ? [spec] : []).slice(0, 3);
  const page = L.makePage("lesson", "YSER Trades");
  page.objects = [];
  const add = o => { page.objects.push(o); return o; };
  const title = String(spec?.title ?? "").trim().slice(0, 70);
  if (title) add(L.create("text", 160, 100, 1500, undefined, { text: title, style: { ...L.titleStyle(60) }, auto: false }));
  const sub = String(spec?.subtitle ?? "").trim().slice(0, 120);
  if (sub) add(L.create("text", 160, 180, 1500, undefined, { text: sub, style: { ...L.bodyStyle(32), color: NAMED.muted }, auto: false }));
  const caption = String(spec?.caption ?? "").trim().slice(0, 90), assumed = String(spec?.assumed ?? "").trim().slice(0, 90);
  const chips = panels.some(p => p?.chip), compact = panels.some(p => (p?.bars?.length ?? 9) <= 4); // a few candles: roomy bodies with their number inside
  const top = (title ? (sub ? 285 : 245) : 150) + (chips ? 55 : 0);
  const bottom = caption ? 850 : 880;
  const outerTop = top - (spec?.stack ? 45 : 0), outerBottom = bottom;
  const hasTwin = panels.some(p => (p?.marks ?? []).some(m => (m?.type === "psp" && m?.twin) || m?.type === "bracket")); // a PSP needs its two-asset strip below it; brackets need rows
  const twinAbove = panels.some(p => (p?.marks ?? []).some(m => m?.type === "psp" && m?.twin && /:(high|top)$/.test(String(m.at)))); // bearish: the star and its strip sit above the highs
  let drawn = 0;
  // A stacked spec (`stack`): panel 1 is the higher timeframe, panel 2 the lower one; every higher-timeframe candle is drawn as wide as the lower-timeframe candles
  // under it, body to body, so the eye reads straight down from the candle to its detail.
  const stack = !!spec?.stack && panels.length === 2;
  const stackN = stack ? (barsOf(L, panels[1])?.length ?? 0) : 0, stackStep = stackN ? clamp(1480 / stackN, 26, 64) : 0, stackW = stackN * stackStep, stackX = 200 + (1520 - stackW) / 2;
  const stackBand = stack ? (bottom - top + 45) : 0, stackGap = 14, stackH1 = Math.round(stackBand * .47);
  const stackInfo = { edges: [], ltfBottom: 0 };
  // Labels never sit on each other or on a candle: each is tried where it belongs, then nudged to the nearest free spot.
  const taken = [];
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const free = r => r.x >= 20 && r.x + r.w <= 1900 && r.y >= top - 20 && r.y + r.h <= bottom + 60 && !taken.some(t => hit(r, t));
  const spot = r => {
    for (const d of [0, -1, 1, -2, 2, -3, 3]) for (const dx of [0, 1, -1, 2, -2]) { const c = { ...r, x: r.x + dx * (r.w * .55 + 10), y: r.y + d * (r.h + 8) }; if (free(c)) return c; }
    return r;
  };
  const reserve = r => (taken.push({ x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6 }), r);

  panels.forEach((panel, pi) => {
    const bars = barsOf(L, panel);
    if (!bars) return;
    drawn++;
    const n = bars.length, two = panels.length === 2 && !stack;
    const top = stack ? (pi === 0 ? outerTop : outerTop + stackH1 + stackGap) : outerTop, bottom = stack ? (pi === 0 ? outerTop + stackH1 : outerBottom) : outerBottom;
    const k = stack ? 1 : panels.length, areaW = k === 1 ? 1520 : k === 2 ? 820 : 560, areaX = k === 1 ? 200 : k === 2 ? (pi === 0 ? 100 : 1000) : 80 + pi * 600;
    // Candles the size they are on the QuantLab cards: a body about 40 px wide on a 50 px step, however few candles there are.
    const roomy = false; // never wide, never flat: every chart uses the owner's ideal candle (below)
    let w = n * 60, x = areaX + (areaW - w) / 2;
    const labelH = panel.label ? 70 : 0, pad = stack ? (pi === 0 ? 62 : 44) : 55; // room above and below the candles for tags, circles and arrowheads
    const below = stack ? (pi === 0 ? 26 : 86) : twinAbove ? 60 : hasTwin ? 135 : 90; // below the candles: SMT labels, the star and its twin strip, or the candle numbers
    let y = top + pad + (twinAbove ? 125 : 0), h = bottom - labelH - below - y;
    // A chart traced from a PDF keeps the PDF's own proportions: its step is a fixed share of its price range, so candles are as tall and as wide as there.
    // Anything not traced uses the owner's ideal candle (the QuantLab cards): a step of about 60 px and a body of about 48, however few or many candles.
    let traceGap = null;
    {
      const traced = Number(panel.aspect) > 0, step0 = traced ? Number(panel.aspect) * h : k === 1 ? 64 : k === 2 ? 56 : 48; w = n * step0;
      if (w > areaW) { const f = areaW / w; y += h * (1 - f) / 2; h *= f; w = areaW; }
      x = areaX + (areaW - w) / 2; traceGap = traced ? clamp(num(panel.gap, .3), .1, .7) : .24;
    }
    // Stacked: both rows share one left edge and one width, so a higher-timeframe candle sits exactly over its lower-timeframe candles.
    let groups = null, gStart = null;
    if (stack) {
      w = stackW; x = stackX; traceGap = .24;
      if (pi === 0) { // the lower-timeframe candles under each higher-timeframe candle (equal by default)
        const given = Array.isArray(panel.groups) && panel.groups.length === n && panel.groups.every(g => Number(g) >= 1) ? panel.groups.map(Number) : null;
        groups = given && given.reduce((a, b) => a + b, 0) === stackN ? given : Array.from({ length: n }, (_, i) => Math.floor(stackN / n) + (i < stackN % n ? 1 : 0));
        gStart = groups.reduce((acc, g, i) => (acc.push((acc[i] ?? 0) + g), acc), [0]);
      }
    }
    if (panel.tf) add(L.create("text", 40, y + h / 2 - 20, 150, undefined, { text: String(panel.tf).slice(0, 8), style: { ...L.bodyStyle(30), weight: 700, color: NAMED.muted }, auto: false }));
    if (panel.chip) add(L.create("card", x + w / 2 - 110, top - 55, 220, 46, { style: "soft", text: String(panel.chip).slice(0, 24), icon: null, color: NAMED.ink, radius: 23, textStyle: { ...L.bodyStyle(24), font: "inter", weight: 600, color: NAMED.ink, align: "center" } }));
    if (panel.label) reserve({ x: areaX + 10, y: bottom - labelH + 24, w: areaW - 20, h: 45 });
    const step = w / n, Y = v => y + (1 - v) * h;
    const centre = j => x + (gStart[j] + groups[j] / 2) * stackStep; // the middle of the lower-timeframe candles under higher-timeframe candle j
    const X = groups ? (i => { const j = clamp(Math.floor(i) - 1, 0, n - 1), j2 = Math.min(n - 1, j + 1), f = clamp(i - Math.floor(i), 0, 1); return centre(j) * (1 - f) + centre(j2) * f; }) : (i => x + (i - .5) * step);
    const point = a => {
      const p = parseAnchor(a, n);
      if (!p) return null;
      const lo = Math.floor(p.bar), hi = Math.min(n, lo + 1), f = p.bar - lo;
      const pick = (b, field) => {
        const bar = bars[b - 1];
        return field === "high" ? bar.h : field === "low" ? bar.l : field === "open" ? bar.o : field === "close" ? bar.c : field === "top" ? Math.max(bar.o, bar.c) : field === "bottom" ? Math.min(bar.o, bar.c) : (bar.h + bar.l) / 2;
      };
      const v = p.field === "level" ? p.level : pick(lo, p.field) * (1 - f) + pick(hi, p.field) * f;
      return { x: X(p.bar), y: Y(v), field: p.field };
    };
    const marks = (Array.isArray(panel.marks) ? panel.marks : []).slice(0, 14);

    // Under the candles: zones.
    for (const m of marks.filter(m => m?.type === "zone")) {
      const a = point(m.from), b = point(m.to);
      if (!a || !b) continue;
      const fromBar = clamp(num(m.fromBar, parseAnchor(m.from, n)?.bar ?? 1), 1, n), toBar = clamp(num(m.toBar, n), 1, n);
      const x1 = X(Math.min(fromBar, toBar)) - step * .5 - 24, x2 = X(Math.max(fromBar, toBar)) + step * .5 + 24;
      add(L.create("zone", x1, Math.min(a.y, b.y), x2 - x1, Math.max(14, Math.abs(b.y - a.y)), { fill: colour(m.color, NAMED.zone) }));
      // The zone's name sits just outside its right edge, clear of the candles.
      if (m.label) {
        const text = String(m.label).slice(0, 40), r = reserve(spot({ x: x2 + 14, y: (a.y + b.y) / 2 - 18, w: Math.min(220, text.length * 15 + 12), h: 36 }));
        add(L.create("text", r.x, r.y, 220, undefined, { text, style: { ...L.bodyStyle(26), color: NAMED.muted }, auto: false }));
      }
    }

    // The candles.
    // The house look of the QuantLab cards: slim bodies, thin wicks, light grey up candles and dark grey down candles.
    const look = { preset: "custom", labels: "none", bull: "#dcdcdc", bear: "#666666", outline: true, border: "#8a8a8a" };
    const edge = stackStep * .12; // the gap each lower-timeframe candle keeps from its neighbour, so the higher candle's body ends exactly where the last one's does
    if (groups) bars.forEach((b, i) => add(L.create("series", x + gStart[i] * stackStep + edge, y, groups[i] * stackStep - 2 * edge, h, { ...look, bars: [b], count: 1, future: 0, gap: 0 })));
    else add(L.create("series", x, y, w, h, { ...look, bars, count: n, future: clamp(Math.round(num(panel.future, 0)), 0, n - 1), gap: traceGap ?? (roomy ? .5 : .24) }));
    // Nothing else is placed on a candle: its body and wick are taken space.
    const bw = step * (1 - (traceGap ?? (roomy ? .5 : .24)));
    bars.forEach((b, i) => { const cw = groups ? groups[i] * stackStep - 2 * edge : bw; reserve({ x: X(i + 1) - cw / 2, y: Y(Math.max(b.o, b.c)), w: cw, h: Math.max(4, Math.abs(Y(b.o) - Y(b.c))) }); reserve({ x: X(i + 1) - 4, y: Y(b.h), w: 8, h: Math.max(4, Y(b.l) - Y(b.h)) }); });
    if (groups) stackInfo.edges = bars.map((b, i) => ({ l: x + gStart[i] * stackStep + edge, r: x + (gStart[i] + groups[i]) * stackStep - edge, y: Y(Math.min(b.o, b.c)) }));
    else if (stack) stackInfo.ltfBottom = y + h;
    const numbersAbove = !!groups || (hasTwin && !twinAbove) || marks.some(m => m?.type === "bracket"); // under the candles sit the star, its strip and the brackets, so the numbers go above
    const numY = numbersAbove ? y - 40 : y + h + 58;
    if (panel.numbers) bars.forEach((_, i) => add(L.create("text", X(i + 1) - 30, numY, 60, undefined, { text: panel.numbers === "days" ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i % 7] : String(i + 1), style: { ...L.bodyStyle(26), align: "center", color: NAMED.muted }, auto: false })));
    if (panel.numbers) reserve({ x: x - 10, y: numY - 4, w: w + 20, h: 40 });
    // A PSP's star (and its two-asset strip) is taken space before any label is placed.
    for (const m of marks.filter(m => m?.type === "psp")) { const p = point(m.at); if (p) reserve({ x: p.x - 70, y: p.y + (p.field === "high" || p.field === "top" ? -150 : 8), w: 140, h: m.twin ? 142 : 46 }); }

    // Levels and lines.
    for (const m of marks.filter(m => m?.type === "level")) {
      const p = point(m.at);
      if (!p) continue;
      const from = clamp(num(m.from, 1), 1, n), to = clamp(num(m.to, n), 1, n);
      const lx = X(Math.min(from, to)) - step * .5 - 40, lw = Math.max(step, X(Math.max(from, to)) - lx + step * .5 + 40 + (m.label ? 120 : 0));
      add(L.create("level", lx, p.y - 20, lw, 40, { color: colour(m.color, NAMED.blue), label: String(m.label ?? "").slice(0, 24), tag: m.label ? "right" : "none", chip: null, dash: m.dash === "dashed" ? "dashed" : "solid" }));
      if (m.label) { const tagW = Math.max(110, Math.min(24, String(m.label).length) * 12 + 44); reserve({ x: lx + lw - tagW - 4, y: p.y - 18, w: tagW + 8, h: 36 }); }
    }
    for (const m of marks.filter(m => m?.type === "arrow" || m?.type === "line")) {
      const a = point(m.from), b = point(m.to);
      if (!a || !b || Math.hypot(a.x - b.x, a.y - b.y) < 90) continue; // an arrow from a candle to itself says nothing
      const arrow = m.type === "arrow";
      add(L.withBox(L.create(arrow ? "arrow" : "line", a.x, a.y, 0, 0, { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: colour(m.color, NAMED.ink), strokeWidth: 3, dash: m.dash === "dashed" ? "dashed" : "solid", curve: clamp(num(m.curve, 0), -.8, .8), end: arrow ? "arrow" : "none" })));
      // The label sits past the arrowhead (above it for an arrow that climbs, below it for one that falls), where nothing else is.
      if (m.label) {
        const up = b.y <= a.y, text = String(m.label).slice(0, 30), tw = Math.min(300, text.length * 17 + 20);
        const r = reserve(spot({ x: b.x - tw / 2, y: up ? b.y - 62 : b.y + 20, w: tw, h: 40 }));
        add(L.create("text", r.x + tw / 2 - 150, r.y, 300, undefined, { text, style: { ...L.bodyStyle(28), weight: 600, align: "center", color: colour(m.color, NAMED.ink) }, auto: false }));
      }
    }
    // SMT lines join two swing points of the chart asset; PSP is a four-point star on a candle. #2196f3 ("ss") is the strength switch.
    for (const m of marks.filter(m => m?.type === "smt")) {
      const a = point(m.from), b = point(m.to);
      if (!a || !b || Math.hypot(a.x - b.x, a.y - b.y) < 60) continue;
      const c = colour(m.color, NAMED.muted), lowSide = a.field === "low" || a.field === "bottom";
      add(L.withBox(L.create("line", a.x, a.y, 0, 0, { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: c, strokeWidth: 3, dash: m.style === "solid" ? "solid" : "dashed", curve: 0, end: "dot", start: "dot" })));
      if (m.label) {
        const text = String(m.label).slice(0, 30), tw = Math.min(360, text.length * 17 + 20), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const r = reserve(spot({ x: mx - tw / 2, y: lowSide ? my + 50 : my - 92, w: tw, h: 40 }));
        add(L.create("text", r.x + tw / 2 - 180, r.y, 360, undefined, { text, style: { ...L.bodyStyle(28), weight: 600, align: "center", color: c === NAMED.muted ? NAMED.ink : c }, auto: false }));
      }
    }
    for (const m of marks.filter(m => m?.type === "psp")) {
      const p = point(m.at);
      if (!p) continue;
      const size = 36, below = p.field === "low" || p.field === "bottom";
      const sy = below ? p.y + 12 : p.y - 12 - size; // right on its candle, under a low and over a high
      add(L.create("polygon", p.x - size / 2, sy, size, size, { sides: 4, star: .62, fill: colour(m.color, NAMED.muted), stroke: "transparent" }));
      if (Array.isArray(m.twin) && m.twin.length === 2) { // the evidence: the chart asset and the correlated asset closed in opposite colours
        const dir = below ? 1 : -1, cy = below ? sy + size + 10 : sy - 10 - 44;
        m.twin.forEach((side, k) => {
          const up = side === "bull", cx = p.x + (k ? 24 : -52);
          add(L.create("candle", cx, cy, 28, 44, { open: up ? .75 : .2, close: up ? .2 : .75, body: .8, bull: "#dcdcdc", bear: "#666666", outline: true, border: "#8a8a8a" }));
          add(L.create("text", cx + 14 - 36, cy + (below ? 48 : -26), 72, undefined, { text: k ? "corr." : "chart", style: { ...L.bodyStyle(18), align: "center", color: NAMED.muted }, auto: false }));
        });
        void dir;
      }
    }
    for (const m of marks.filter(m => m?.type === "bracket")) { // "neighbouring pairs": a bracket under bars from..to, on its own row
      const from = clamp(num(m.from, 1), 1, n), to = clamp(num(m.to, 2), 1, n), row = clamp(num(m.row, 0), 0, 3), by = y + h + 22 + row * 30;
      const style = { stroke: NAMED.muted, strokeWidth: 2, dash: "solid", curve: 0, start: "none", end: "none" };
      add(L.withBox(L.create("line", X(from), by, 0, 0, { x1: X(from), y1: by, x2: X(to), y2: by, ...style })));
      add(L.withBox(L.create("line", X(from), by - 10, 0, 0, { x1: X(from), y1: by - 10, x2: X(from), y2: by, ...style })));
      add(L.withBox(L.create("line", X(to), by - 10, 0, 0, { x1: X(to), y1: by - 10, x2: X(to), y2: by, ...style })));
      if (m.label) add(L.create("text", (X(from) + X(to)) / 2 - 80, by + 2, 160, undefined, { text: String(m.label).slice(0, 20), style: { ...L.bodyStyle(20), align: "center", color: NAMED.muted }, auto: false }));
    }
    for (const m of marks.filter(m => m?.type === "circle" || m?.type === "dot")) {
      const p = point(m.at);
      if (!p) continue;
      const r = m.type === "dot" ? 11 : clamp(num(m.r, 46), 16, 140);
      add(L.create("ellipse", p.x - r, p.y - r, r * 2, r * 2, m.type === "dot" ? { fill: colour(m.color, NAMED.red), stroke: "transparent" } : { fill: "transparent", stroke: colour(m.color, NAMED.red), strokeWidth: 3, dash: m.dash === "dashed" ? "dashed" : "solid" }));
    }
    for (const m of marks.filter(m => m?.type === "note")) {
      const p = point(m.at);
      const text = String(m.text ?? "").slice(0, 60);
      if (!p || !text) continue;
      const size = clamp(num(m.size, 28), 20, 44), tw = clamp(text.length * size * .56 + 56, 120, 560);
      const above = p.field === "high" || p.field === "top", below = p.field === "low" || p.field === "bottom";
      const spotted = reserve(spot({ x: p.x + num(m.dx, above || below ? 0 : 70) - (above || below ? tw / 2 : 0), y: p.y + num(m.dy, above ? -78 : below ? 30 : -34), w: tw, h: size + 36 }));
      const nx = spotted.x, ny = spotted.y;
      add(L.create("card", nx, ny, tw, size + 36, { style: "soft", text, icon: null, color: colour(m.color, NAMED.ink), radius: 18, textStyle: { ...L.bodyStyle(size), font: "inter", weight: 600, color: NAMED.ink, align: "center" } }));
    }
    if (panel.label) add(L.create("text", areaX + 10, bottom - labelH + 24, areaW - 20, undefined, { text: String(panel.label).slice(0, 80), style: { ...L.bodyStyle(two ? 25 : 32), weight: 600, align: "center" }, auto: false }));
  });

  if (stack && drawn === 2) { // faint guides from each higher-timeframe body edge down through its lower-timeframe candles
    for (const e of stackInfo.edges) for (const gx of [e.l, e.r]) add(L.withBox(L.create("line", gx, e.y, 0, 0, { x1: gx, y1: e.y, x2: gx, y2: stackInfo.ltfBottom, stroke: "#d9d9d9", strokeWidth: 2, dash: "dashed", curve: 0, end: "none" })));
  }
  if (!drawn && Array.isArray(spec?.lines) && spec.lines.length) { // a concept with no picture to draw: its steps as a clean list, in the deck's own type
    drawn++;
    spec.lines.slice(0, 7).forEach((line, i) => add(L.create("text", 160, 345 + i * 86, 1600, undefined, { text: String(line).slice(0, 150), style: { ...L.bodyStyle(32), color: i === 0 && spec.firstBold ? "#3a3a3a" : "#3a3a3a" }, auto: false })));
  }
  if (drawn && panels.length === 2 && spec?.divider) add(L.create("line", 960, top - 60, 0, 0, { x1: 960, y1: top - 60, x2: 960, y2: bottom - 10, stroke: "#e4e4e4", strokeWidth: 2, dash: "solid", curve: 0, end: "none" }));
  if (drawn && caption) add(L.create("text", 160, 872, 1600, undefined, { text: caption, style: { ...L.bodyStyle(30), weight: 600, align: "center", color: "#3a3a3a" }, auto: false }));
  if (drawn && assumed) add(L.create("text", 160, 925, 1600, undefined, { text: assumed, style: { ...L.bodyStyle(24), align: "center", color: NAMED.muted }, auto: false }));
  return drawn ? { page, deck: { brand: "YSER Trades", numbering: false, footer: { ...L.DEFAULT_FOOTER } } } : null;
}

/** The spec as a 1920 x 1080 PNG, or null if there was nothing to draw. */
export async function drawDiagram(spec, width = 1920) {
  const built = await compile(spec);
  if (!built) return null;
  fonts();
  const L = await slides();
  return svgToPng(L.pageSvg(built.page, built.deck, 1), width);
}

/* ── The designer: turns "show me X" into a spec ── */
const PATTERN_HELP = `Library patterns (bullish, "flip": true draws the bearish twin): swing-2, swing-3, swing-4 (swing formations); c2-closure, c2-closure-run, c3-closure, c3-closure-run (closures); ideal, ideal-run (ideal formation); wick-eq, wick-eq-run; opposing, opposing-series; sweep-low (liquidity sweep then reversal); fvg, fvg-return (fair value gap, and price returning into it); eq-continuation, eq-reversal; cisd; projection; week-tuesday-low, week-wednesday, week-thursday, week-consolidation, week-monday-low (weekly profiles, 5 daily candles); htf-3, htf-2 (higher timeframe candles); osok-entry. Generated: uptrend, downtrend, range, consolidation, breakout, sweep, vshape, london-reversal, ny-reversal, london-expansion (with "count" 6 to 20).`;
const DESIGNER = `You design a trading diagram for the YSER slides editor, then reply with ONE JSON object and nothing else.
USE A TEMPLATE. These are ready-made, hand-drawn diagrams in the owner's style, and one of them fits almost every request: choose the CLOSEST one, even when it only covers the main idea of a longer request (a CISD after a sweep -> cisd; candle 2 and candle 3 of the fractal model -> fractal; an entry into a gap -> fvg). Reply {"template":"<id>","direction":"bullish" or "bearish"} (the direction the idea is traded; optionally "title" and "subtitle" to reword the headline, at most 6 and 12 words). When the request joins TWO ideas (a sweep, then a CISD), show them side by side: {"templates":[{"template":"<id>","direction":"..."},{"template":"<id>","direction":"..."}],"title":"...","subtitle":"..."}. Templates:
${templateList()}
When the request is an idea ON THE HIGHER TIMEFRAME with its ENTRY ON THE LOWER ONE (a candle 2 closure with a CISD entry; "the fractal model and how I enter it"), it is ONE picture, never several: reply {"compose":{"htf":"c2-closure" or "c3-closure" or "fractal","entry":"cisd","direction":"bullish" or "bearish"}} and the bot draws the higher-timeframe candles with the lower-timeframe candles under them, body to body. To design such a picture yourself, use {"stack":true,"title":..,"panels":[HTF panel with "groups":[how many lower candles sit under each higher candle], LTF panel]} with the SAME number of lower candles as the groups add up to; each higher candle is then as wide as its lower candles.
Design your own with the spec below ONLY for an idea that none of these covers (a session, a time window, a particular pattern they are not). Use what the owner said: if they name details (the leg directions, where a PSP sits, which stage), draw exactly those details, adding a PSP star or SMT lines of their own with the marks below. If you cannot tell what they mean, or you cannot draw it faithfully, do NOT guess: reply {"ask":"one short question that names the 2 or 3 nearest things you can draw"}.
Spec for your own design:
{"title":"short headline (max 6 words)","subtitle":"optional one line","panels":[ONE or TWO panels, each:
 {"label":"caption under the panel (optional)",
  "pattern":"a library pattern name" OR "bars":[[open,high,low,close],...] (your own candles, any consistent price scale, up = bullish, at most 14 candles; use this when no pattern fits),
  "flip":false,"future":0 (the last N candles drawn pale = the move still to come),"numbers":true (number the candles 1,2,3...),
  "marks":[ up to 10 of:
   {"type":"zone","from":"1:high","to":"3:low","fromBar":2,"toBar":5,"color":"amber","label":"FVG"}   a box between two price points, across candles fromBar..toBar
   {"type":"level","at":"2:high","label":"PDH","color":"blue","dash":"solid|dashed","from":1,"to":6}   a horizontal line with a tag
   {"type":"arrow","from":"2:close","to":"5:high","color":"teal","curve":0.3,"dash":"solid|dashed","label":"expansion"}
   {"type":"circle","at":"3:low","color":"red"} or {"type":"dot","at":"3:low"}
   {"type":"note","at":"3:high","text":"CISD","color":"ink"}   a small tag; sits above a high, below a low
   {"type":"smt","from":"3:low","to":"9:low","style":"dashed|solid","color":"muted|ss","label":"6H • 2S"}   an SMT line between two swing points (pivot A to pivot B)
   {"type":"psp","at":"9:low","color":"muted|ss"}   a PSP star on a candle (muted = ordinary, ss = strength switch blue)
 ]}]}
Anchors are "N:field": N is the candle number (1 = first; decimals like 2.5 sit between candles) and field is high, low, open, close, top (body top), bottom (body bottom) or mid.
${PATTERN_HELP}
Example (a fair value gap that price returns to, then expands from):
{"title":"Bullish Fair Value Gap","subtitle":"The gap between candle 1's high and candle 3's low","panels":[{"label":"Price returns to the gap, then expands","pattern":"fvg-return","numbers":true,"marks":[{"type":"zone","from":"1:high","to":"3:low","fromBar":2,"toBar":5,"color":"amber","label":"FVG"},{"type":"level","at":"3:high","label":"C3 high","color":"blue","from":3,"to":6},{"type":"arrow","from":"5:low","to":"6:high","color":"teal","curve":0.25,"label":"expansion"}]}]}
Second example (a bearish idea: library patterns are all drawn BULLISH, so a bearish idea needs "flip":true):
{"title":"Bearish CISD","subtitle":"Price closes back through the open of the run","panels":[{"label":"Candle 5 closes below candle 1's open","pattern":"cisd","flip":true,"numbers":true,"marks":[{"type":"level","at":"1:open","label":"CISD level","color":"blue","from":1,"to":6},{"type":"circle","at":"5:close","color":"red"},{"type":"arrow","from":"4:high","to":"6:low","color":"red","curve":0.2,"label":"delivery lower"}]}]}
How the cisd pattern reads: candles 1 to 3 run one way, candle 4 is a small pause, candle 5 closes back through candle 1's open (that close is the CISD), candle 6 continues. sweep-low: candles 1-4 drift, candle 5 sweeps below the low, then price reverses up (flip it for a sweep of a high). fvg: candle 2 is the big displacement, the gap is between candle 1's high and candle 3's low. A bullish idea uses the pattern as is; a BEARISH idea always gets "flip":true.
Rules: pick the pattern that already contains the whole story (e.g. fvg-return when price comes back to the gap); an arrow must connect two DIFFERENT candles; never draw a mark that says nothing; check every anchor number is a candle that exists in the pattern (fvg has 3 candles, fvg-return 6, cisd 6, sweep-low 8, ideal 3, ideal-run 4, swing-3 3, projection 8, week profiles 5, htf-3 3, osok-entry 7).
Taste (the owner's house style, follow it): clean and minimal, white page, nothing decorative. Teach ONE idea per diagram. Few marks, each earning its place: zones for gaps and ranges, levels for liquidity and key prices, arrows for the move, numbers on candles when the lesson talks about candle 1, 2, 3. Labels are 1 to 3 words. Colors: bull/teal for the idea or target, red for invalid or the stop, blue for levels and entry, amber for zones, ink for neutral. Use two panels only for a before/after or bullish/bearish comparison. Draw it exactly as the lesson and the owner's model describe it; if unsure of a detail, keep the diagram simpler instead of inventing.`;

async function viaJson(system, user, max = 1800) {
  const tries = [];
  if (env.groqKey) for (const model of ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"]) tries.push(["groq", model]);
  if (env.geminiKey) for (const model of ["gemini-flash-lite-latest", "gemini-flash-latest"]) tries.push(["gemini", model]);
  let last = "no model answered";
  for (const [who, model] of tries) {
    try {
      let text = "";
      if (who === "groq") {
        const body = { model, temperature: 0.3, max_completion_tokens: max, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
        if (model.startsWith("openai/gpt-oss")) body.reasoning_effort = "low";
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.groqKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
        if (!r.ok) { last = `AI error ${r.status}`; continue; }
        text = String((await r.json()).choices?.[0]?.message?.content ?? "");
      } else {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.geminiKey },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { temperature: 0.3, maxOutputTokens: Math.max(2500, max), responseMimeType: "application/json" } }), signal: AbortSignal.timeout(20_000) });
        if (!r.ok) { last = `AI error ${r.status}`; continue; }
        text = ((await r.json()).candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join("");
      }
      const json = JSON.parse(text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^```(?:json)?|```$/gm, "").trim().replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
      if (json && typeof json === "object") return json;
      last = "not JSON";
    } catch (e) { last = e.message; }
  }
  throw new Error(last);
}


/** The AI's reply as a drawable spec: a template (in a direction, with its own headline if given), two templates side by side, or its own spec. */
function resolve(reply) {
  let spec = reply;
  if (spec?.template) {
    const base = fromTemplate(String(spec.template), spec.direction);
    if (base) spec = { ...base, ...(spec.title ? { title: spec.title } : {}), ...(spec.subtitle ? { subtitle: spec.subtitle } : {}) };
  } else if (Array.isArray(spec?.templates)) {
    const parts = spec.templates.slice(0, 2).map(t => fromTemplate(String(t?.template), t?.direction)).filter(Boolean);
    if (parts.length) spec = { title: spec.title || parts.map(p => p.title).join(" + ").slice(0, 70), subtitle: spec.subtitle || "", panels: parts.map(p => p.panels[0]) };
  }
  return spec;
}

const conceptIndexes = new WeakMap();
const asList = v => (Array.isArray(v) ? v.filter(Boolean) : []);
/** The concept of the owner's PDFs (their model) that a request is about, or null: matched by name, what to look for and the picture descriptions. */
export function matchConcept(request, doc) {
  const concepts = asList(doc?.concepts);
  if (!concepts.length) return null;
  let idx = conceptIndexes.get(doc);
  if (!idx) { idx = new Index(concepts.map(c => ({ title: c.name, h: c.name, t: [c.name, c.look_for, c.visual, ...asList(c.steps), ...asList(c.must)].join(" ") }))); conceptIndexes.set(doc, idx); }
  const hit = idx.search(request, 1)[0];
  if (!hit || hit.score < 6) return null;
  return concepts.find(c => c.name === hit.chunk.title) ?? null;
}
const conceptBrief = c => [`${c.name}${asList(c.timeframes).length ? ` [${c.timeframes.join(", ")}]` : ""}`, c.look_for && `Look for: ${c.look_for}`, c.visual && `How the PDF's own picture draws it (draw exactly this, candle by candle): ${c.visual}`,
  asList(c.steps).length && `Steps: ${c.steps.join(" ")}`, asList(c.must).length && `Must hold: ${c.must.join("; ")}`, asList(c.not).length && `Doesn't count: ${c.not.join("; ")}`, asList(c.rules).length && `Rules: ${c.rules.join("; ")}`].filter(Boolean).join("\n");

/** A concept from the owner's PDFs as a slide of words: what to look for, then its steps. */
export function conceptSlide(c) {
  const steps = asList(c.steps).map(s => String(s).replace(/^\s*\d+[.)]\s*/, "")).slice(0, 6).map((s, i) => `${i + 1}. ${s}`);
  return { title: String(c.name).slice(0, 60), subtitle: String(c.look_for ?? "").slice(0, 105), lines: steps.length ? steps : asList(c.must).slice(0, 6), assumed: "From your PDFs." };
}

function systemFor(request, doc, lessons, concept = null) {
  return [DESIGNER, concept ? `THE CONCEPT FROM THE OWNER'S OWN PDFs THAT THIS REQUEST IS ABOUT (the source of truth; draw it faithfully with candles, levels, boxes and labels; never ask what it is, it is defined here):\n${conceptBrief(concept)}` : "", asksAboutSmt(request) ? `THE OWNER'S SMT / PSP / STRENGTH SWITCH RULES (authoritative; they decide every colour and label; below 15M draw no PSP star):\n${SMT_RULES}` : "", doc ? `THE OWNER'S MODEL (their vocabulary comes first):\n${modelFor(doc, request, 2200)}` : "", lessons.text ? `LESSON MATERIAL ON THIS:\n${lessons.text}` : ""].filter(Boolean).join("\n\n");
}

/** "Show me X" -> a PNG. `request` is what the user wants drawn; the lessons and the user's model that match it guide the drawing. */
export async function designDiagram(brief, { doc, said } = {}) {
  // `said` is what the owner typed; `brief` is the AI's rewording of it, which can drift ("ideal profile" became "ideal swing formation"). Matching uses their own words.
  const request = said && said.trim().length >= 3 ? said : brief;
  const lessons = recall(request, { chars: 3600, perLesson: 2 });
  if (isGenericSs(request)) { // "show me an SS": the owner's default slide, both kinds side by side, at once and without a question
    let spec = fromTemplate("ss", /bear|short|sell|down/i.test(request) ? "bearish" : "bullish"); if (wantsLtf(request)) spec = toLtf(spec);
    return { png: await drawDiagram(spec), spec, lessons: lessons.lessons };
  }
  // Two ideas where one is the entry of the other ("a c2 closure with a CISD entry"): one picture, the higher timeframe over the lower, body to body.
  const combo = compoundOf(request);
  if (combo) {
    const spec = await composeEntry(combo.htf, /bear|short|sell|down/i.test(request) ? "bearish" : "bullish", { entry: combo.entry }).catch(() => null);
    const png = spec ? await drawDiagram(spec).catch(() => null) : null;
    if (png) return { png, spec, lessons: lessons.lessons };
  }
  // An SMT / SS / PSP concept named exactly: the owner's own method slides.
  if (/consecutive|\b(2|3|two|three)[ -]?(s|stages?)\b|psp (first|last)|strong.*then.*weak|no switch|double confirm|below 15|\bon s[12]\b|\b(ltf|lower[- ]?time ?frame)\b.*\b(smt|ss|psp)\b|\b(smt|ss|psp)\b.*\b(ltf|lower[- ]?time ?frame)\b/i.test(request)) {
    let spec = quickTemplate(request); if (spec && wantsLtf(request)) spec = toLtf(spec);
    const png = spec ? await drawDiagram(spec).catch(() => null) : null;
    if (png) return { png, spec, lessons: lessons.lessons };
  }
  // The owner's PDFs: the page whose chart is asked for, drawn from the traced candles at the PDF's own proportions.
  const named = pdfNamedIn(request); // a PDF whose whole name is in the request wins over a looser text match: "ideal profile" is the Ideal Profile PDF, never the Ideal Formation
  const hit = named ? { drawing: pagesOf(named)[0], score: 99 } : matchDrawings(request, 3)[0];
  if (hit?.drawing && (hit.score >= 24 || namesWholePdf(request, hit.drawing.pdf))) {
    const pages = namesWholePdf(request, hit.drawing.pdf) ? pagesOf(hit.drawing.pdf).slice(0, 4) : [hit.drawing];
    const specs = pages.map(specFromDrawing), drawn = [];
    for (const spec of specs) { const png = await drawDiagram(spec).catch(() => null); if (png) drawn.push({ png, spec }); }
    if (drawn.length) return { png: drawn[0].png, spec: drawn[0].spec, lessons: lessons.lessons, more: drawn.slice(1) };
  }
  // No PDF page for it, but a diagram of the owner's own: the ideal profiles and the closures.
  if (/ideal (profile|london|new york|ny)|(london|new york|ny) reversal|(c[23]|candle [23])\s*closure/i.test(request)) {
    const spec = quickTemplate(request), png = spec ? await drawDiagram(spec).catch(() => null) : null;
    if (png) return { png, spec, lessons: lessons.lessons };
  }
  const concept = matchConcept(request, doc);
  const system = systemFor(request, doc, lessons, concept);
  let note = "", failure = null;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await viaJson(system, `Draw: ${brief}${note}\n(The owner's own words: "${request}")`);
      if (reply.ask && !reply.template && !reply.panels) throw new Clarify(String(reply.ask).slice(0, 500));
      const spec = reply.compose ? await composeEntry(String(reply.compose.htf), reply.compose.direction ?? reply.direction, { entry: String(reply.compose.entry ?? "cisd") }).catch(() => null) : resolve(reply);
      const png = spec ? await drawDiagram(spec).catch(() => null) : null;
      if (png) return { png, spec, lessons: lessons.lessons };
      note = "\n(Your last reply had nothing that could be drawn. Reply with a template id from the list, or a spec with real panels and a pattern or bars.)";
    }
  } catch (e) { if (e instanceof Clarify) throw e; failure = e; }
  // The AI is rate limited or too slow: the hand-drawn template that matches the words still comes out.
  const spec = quickTemplate(request);
  const png = spec ? await drawDiagram(spec).catch(() => null) : null;
  if (png) return { png, spec, lessons: lessons.lessons };
  if (concept) { // it IS one of their concepts: never ask what it is; if the AI could not draw it, show what their PDF says, as a clean slide
    const spec = conceptSlide(concept), png = await drawDiagram(spec).catch(() => null);
    if (png) return { png, spec, lessons: lessons.lessons };
    throw failure ?? new Error("nothing to draw");
  }
  throw new Clarify(clarifyText(request)); // nothing matched: ask what was meant, with the nearest options
}

/**
 * An idea on the higher timeframe with its entry on the lower one, as ONE picture: the template's candles on top and, under them, the lower-timeframe
 * candles that make them up, body to body, with the entry model (a CISD) drawn on those. `htf` is a template id; the candle whose low is taken
 * (SWEPT, 1-based) is the one the lower candles zoom into.
 */
const SWEPT = { "c2-closure": 2, "c3-closure": 3, fractal: 2 };
const HTF_NAMES = [[/(c3|candle 3)\s*closure/i, "c3-closure"], [/(c2|candle 2)\s*closure/i, "c2-closure"], [/fractal|\bc2 (sweep|takes)/i, "fractal"]];
/** "a c2 closure with a CISD entry": two ideas where one is the entry of the other. */
export function compoundOf(request) {
  const q = String(request);
  const htf = HTF_NAMES.find(([re]) => re.test(q))?.[1];
  return htf && /\bcisd\b|change in (the )?state/i.test(q) ? { htf, entry: "cisd" } : null;
}
export async function composeEntry(htfId, direction = "bullish", { entry = "cisd" } = {}) {
  const L = await slides(), base = fromTemplate(htfId, "bullish"), t = TEMPLATES.find(x => x.id === htfId);
  const p0 = base?.panels?.[0];
  if (!p0 || !SWEPT[htfId] || entry !== "cisd") return null;
  let rows = Array.isArray(p0.bars) ? p0.bars.map(r => [...r]) : (L.makeBars(String(p0.pattern), 0, 1, false) ?? []).map(b => [b.o, b.h, b.l, b.c]);
  if (p0.flip) rows = rows.map(([o, h, l, c]) => [1 - o, 1 - l, 1 - h, 1 - c]);
  const g = rows.length <= 4 ? 5 : 4, sweep = SWEPT[htfId] - 1;
  const ltf = ltfFromHtf(rows, { g, sweep });
  const entryBar = (sweep + 1) * g + 1 <= ltf.rows.length ? (sweep + 1) * g + 1 : 0;
  const marks = (p0.marks ?? []).filter(m => !(m.type === "note" && /entry/i.test(m.text ?? ""))).map(m => (m.type === "arrow" ? { ...m, label: "" } : m)); // the entry is named on the lower candles, where the CISD is
  const spec = {
    title: `${base.title} With a CISD Entry`.slice(0, 70), subtitle: `${String(base.title).replace(/^(Bullish|Bearish)\s+/i, "")} on the HTF, its entry on the LTF`, stack: true,
    caption: "The CISD inside the swept candle is the entry; the candles sit body to body.", assumed: `Assumed: bullish, ${rows.length} HTF candles with ${g} LTF candles under each.`,
    panels: [{ tf: "HTF", numbers: true, bars: rows, groups: rows.map(() => g), marks }, { tf: "LTF", numbers: false, bars: ltf.rows, marks: cisdMarks(ltf.info, entryBar) }],
  };
  void t;
  return /bear|short|sell|down/i.test(direction) ? mirror(spec) : spec;
}

/** The template a request names by its keywords, without any AI (a fallback, and what keeps the common pictures instant). */
/** "on the LTF", "lower timeframe", "on the 5m": the same picture drawn with more candles. */
const LTF = /\bltf\b|lower[- ]?time ?frame|\blow(er)? tf\b|\b(1|3|5|15|30)\s?(m|min|minutes?)\b/i;
export const wantsLtf = q => LTF.test(String(q));
export function quickTemplate(request) {
  const q = String(request).toLowerCase();
  const dir = /bear|short|sell|down/.test(q) ? "bearish" : "bullish";
  const smtWord = /\b(smt|psp|ss|strength switch|2s|3s|stage)\b/.test(q);
  const id = /ideal\s*(new york|ny)|ny reversal|new york reversal/.test(q) ? "ideal-ny" : /ideal\s*london|london reversal/.test(q) ? "ideal-london" : /ideal\s*profile|\bideal\b/.test(q) ? "ideal-profile" : /(c3|candle 3)\s*closure/.test(q) ? "c3-closure" : /(c2|candle 2)\s*closure/.test(q) ? "c2-closure"
    : /consecutive|neighbouring|neighboring|pairs? share/.test(q) ? "consecutive" : /below 15|5m|1m|3m/.test(q) && smtWord ? "below-15m"
    : /\b(3|three)[ -]?(s|stages?)\b/.test(q) ? "stage-3s" : /strong.*then.*weak|order matters/.test(q) ? "stage-2s-order" : /\b(2|two)[ -]?(s|stages?)\b/.test(q) ? "stage-2s"
    : /psp (on|at) (s2|the second|c3)|psp.*\bs2\b/.test(q) ? "ss-psp-s2" : /double confirm|psp (on|at) (s1|the shared)|psp.*\bs1\b/.test(q) ? "ss-psp-s1"
    : /psp first|pivot a|line (turns|goes) blue/.test(q) ? "psp-first" : /no switch|wrong (close|way)|not (a )?switch|doesn.?t switch|neutral star/.test(q) ? "no-switch"
    : /(two|2) smts?|no psp|without (a )?psp|leg flip|weak.*then.*strong/.test(q) && smtWord ? "ss-two-smt" : /psp last|smt (and|with|\+) (a )?psp|with (a )?psp/.test(q) && smtWord ? "ss-psp"
    : /\b(ss|strength switch)\b/.test(q) || (LTF.test(q) && smtWord) ? "ss"
    : /inversion|ifvg/.test(q) ? "ifvg" : /fair value|\bfvg\b|imbalance/.test(q) ? "fvg"
    : /cisd|change in (the )?state/.test(q) ? "cisd" : /order block|\bob\b/.test(q) ? "ob"
    : /fractal|candle (2|3|4)\b|\bc[234]\b/.test(q) ? "fractal" : /premium|discount|equilibrium/.test(q) ? "pd"
    : /precision swing|\bpsp\b/.test(q) ? "psp" : /smt|divergence/.test(q) ? "smt" : /sweep|liquidity|raid/.test(q) ? "sweep" : null;
  return id ? fromTemplate(id, dir) : null;
}

const SLIDES = n => `\nThe owner wants ${n} separate images that together explain this, like slides of a lesson, in teaching order (the foundation first, then each step building on the last). Each image teaches ONE idea. Reply {"slides":[ ${n} items ]}; each item is a template reply ({"template":"<id>","direction":"..."}), or a spec of your own, with its own short title and subtitle. If a template has steps (marked "has N steps" in the list), you may instead reply {"template":"<id>","steps":true,"direction":"..."} to get its whole step-by-step set.`;

/** "Make me 4 images explaining X" -> several PNGs, in order. Slides that can't be drawn are skipped; none drawable is an error. */
export async function designSlides(request, { doc, count = 4 } = {}) {
  count = clamp(Math.round(num(count, 4)), 2, 6);
  const lessons = recall(request, { chars: 4200, perLesson: 3 });
  // The fractal model always comes as its clean build-up, C1 then C2 then C3 then C4, with no AI in the loop (so no rate limits either).
  if (/fractal/i.test(request) && !asksAboutSmt(request) && count <= 4) {
    const specs = stepsFromTemplate("fractal", /bear|short|sell|down/i.test(request) ? "bearish" : "bullish").slice(0, count);
    const images = [];
    for (const spec of specs) images.push({ png: await drawDiagram(spec), spec });
    return { images, lessons: lessons.lessons };
  }
  const system = systemFor(request, doc, lessons);
  let note = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await viaJson(system, `Draw: ${request}${SLIDES(count)}${note}`, 3800);
    let specs = [];
    if (reply.template && reply.steps) specs = stepsFromTemplate(String(reply.template), reply.direction);
    else if (Array.isArray(reply.slides)) for (const s of reply.slides.slice(0, 6)) specs.push(...(s?.template && s?.steps ? stepsFromTemplate(String(s.template), s.direction) : [resolve(s)]));
    else specs = [resolve(reply)];
    const out = [];
    for (const spec of specs.slice(0, 6)) { const png = await drawDiagram(spec).catch(() => null); if (png) out.push({ png, spec }); }
    if (out.length) return { images: out, lessons: lessons.lessons };
    note = "\n(Your last reply had nothing that could be drawn. Use template ids from the list, or specs with real panels and a pattern or bars.)";
  }
  throw new Error("nothing to draw");
}






/** Not understood: the question to put back to the owner (instead of a guess or a silent failure). */
export class Clarify extends Error {}

let templateIndex = null;
/** The hand-drawn diagrams closest to what was asked, best first. */
export function nearest(request, n = 3) {
  templateIndex ??= new Index(TEMPLATES.map(t => ({ h: t.name, t: `${t.name}. ${t.about}`, id: t.id, name: t.name })));
  const names = templateIndex.search(request, n).map(h => h.chunk.name);
  for (const m of matchDrawings(request, 6)) if (!names.includes(m.drawing.pdf) && names.length < n + 2) names.push(m.drawing.pdf + " (your PDF)");
  return names;
}
const clarifyText = request => {
  const near = nearest(request);
  return `I'm not sure I understood which drawing you mean.${near.length ? ` The closest I can draw well: ${near.map(n => `**${n}**`).join("; ")}.` : ""} Tell me which one, or describe the candles, lines and what should be highlighted, and I'll draw it.`;
};

/** A strength switch asked for with no detail: always the two ways it happens, as two images (two SMTs, and a PSP), each with the correlated asset beside it. */
export const isGenericSs = q => /\b(ss|strength switch)\b/i.test(q) && !/(psp (first|last)|\b[23]s\b|stages?\b|wrong|no switch|not (a )?switch|double|not linked|opposite|chain|strong.*then.*weak|consecutive|below 15|\bon s[12]\b|only (the )?(two|psp)|pair)/i.test(q);

