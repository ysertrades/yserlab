import { env } from "./env.js";
import { fonts, svgToPng } from "./render.js";
import { Index, recall } from "./knowledge.js";
import { modelFor } from "./ai.js";
import { TEMPLATES, fromTemplate, stepsFromTemplate, templateList } from "./diagramTemplates.js";
import { SMT_RULES, asksAboutSmt } from "./smtLesson.js";

/**
 * Diagrams in the slides editor's own look. The editor's renderer is bundled in vendor/slides.mjs (scripts/slides/build.mjs), so a
 * diagram is a real editor page: the same candles, levels, zones, arrows, tags and footer, drawn by the same code.
 *
 * The AI never places pixels. It writes a small spec (candles by pattern or by numbers, then marks anchored to candles such as
 * "2:high"), and `compile` turns that into editor objects. A bad spec drops the bad part and still draws the rest.
 */
let lib = null;
const slides = async () => (lib ??= await import("../vendor/slides.mjs"));

const NAMED = { ss: "#2196f3", switch: "#2196f3", bull: "#84b884", bear: "#3d3d3d", blue: "#2f6bff", teal: "#0f9d80", red: "#ef3b4b", amber: "#f4b73e", ink: "#3d3d3d", muted: "#8a8a8f", zone: "#fbecb8", tp: "#cfe8e1", sl: "#e2e3e6", green: "#0f9d80", gray: "#8a8a8f", grey: "#8a8a8f", yellow: "#f4b73e", black: "#000000", white: "#ffffff" };
const colour = (c, fallback) => NAMED[String(c ?? "").toLowerCase()] ?? (/^#[0-9a-f]{6}$/i.test(c ?? "") ? c : fallback);
const num = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Every string in a spec with plain spaces (a non-breaking space draws as a missing-glyph box). */
const clean = v => typeof v === "string" ? v.replace(/[Â â€‡â€¯â€‹]/g, " ").replace(/\s+/g, " ").trim() : Array.isArray(v) ? v.map(clean) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) : v;

/** The pattern library, for the AI to pick from. */
export async function patternNames() { return Object.keys((await slides()).PATTERNS); }

/** One panel's candles as 0 to 1 bars (1 = top), from a library pattern or from [open, high, low, close] rows. */
function barsOf(L, panel) {
  let bars;
  if (Array.isArray(panel.bars) && panel.bars.length >= 1) {
    const rows = panel.bars.slice(0, 40).map(r => (Array.isArray(r) ? r : [r?.o, r?.h, r?.l, r?.c]).map(Number)).filter(r => r.length === 4 && r.every(Number.isFinite))
      .map(([o, h, l, c]) => [o, Math.max(h, o, c), Math.min(l, o, c), c]);
    if (rows.length) {
      const lo = Math.min(...rows.map(r => r[2])), hi = Math.max(...rows.map(r => r[1])), k = 1 / (hi - lo || 1);
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
  const panels = (Array.isArray(spec?.panels) ? spec.panels : spec?.pattern || spec?.bars ? [spec] : []).slice(0, 2);
  const page = L.makePage("lesson", "YSER Trades");
  page.objects = [];
  const add = o => { page.objects.push(o); return o; };
  const title = String(spec?.title ?? "").trim().slice(0, 70);
  if (title) add(L.create("text", 160, 100, 1500, undefined, { text: title, style: { ...L.titleStyle(60) }, auto: false }));
  const sub = String(spec?.subtitle ?? "").trim().slice(0, 120);
  if (sub) add(L.create("text", 160, 180, 1500, undefined, { text: sub, style: { ...L.bodyStyle(32), color: NAMED.muted }, auto: false }));
  const top = title ? (sub ? 285 : 245) : 150;
  const bottom = 880;
  let drawn = 0;
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
    const n = bars.length, two = panels.length === 2;
    const areaX = two ? (pi === 0 ? 100 : 1000) : 200, areaW = two ? 820 : 1520;
    // Candles the size they are on the QuantLab cards: a body about 40 px wide on a 50 px step, however few candles there are.
    const w = n * (two ? 56 : 64), x = areaX + (areaW - w) / 2;
    const labelH = panel.label ? 70 : 0, pad = 55; // room above and below the candles for tags, circles and arrowheads
    const h = bottom - top - labelH - pad - 90, y = top + pad; // more room below: SMT lines, their labels and the candle numbers live there
    if (panel.label) reserve({ x: x + w / 2 - (two ? 400 : 600), y: bottom - labelH + 24, w: two ? 800 : 1200, h: 45 });
    const step = w / n, X = i => x + (i - .5) * step, Y = v => y + (1 - v) * h;
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
    const series = L.create("series", x, y, w, h, { preset: "custom", bars, count: n, future: clamp(Math.round(num(panel.future, 0)), 0, n - 1), labels: "none", gap: .24, bull: "#dcdcdc", bear: "#646464", outline: true, border: "#8e8e8e" });
    add(series);
    // Nothing else is placed on a candle: its body and wick are taken space.
    const bw = step * (1 - .24);
    bars.forEach((b, i) => { reserve({ x: X(i + 1) - bw / 2, y: Y(Math.max(b.o, b.c)), w: bw, h: Math.max(4, Math.abs(Y(b.o) - Y(b.c))) }); reserve({ x: X(i + 1) - 4, y: Y(b.h), w: 8, h: Math.max(4, Y(b.l) - Y(b.h)) }); });
    if (panel.numbers) bars.forEach((_, i) => add(L.create("text", X(i + 1) - 30, y + h + 58, 60, undefined, { text: panel.numbers === "days" ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i % 7] : String(i + 1), style: { ...L.bodyStyle(26), align: "center", color: NAMED.muted }, auto: false })));
    if (panel.numbers) reserve({ x: x - 10, y: y + h + 54, w: w + 20, h: 40 });

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
      const size = 40, below = p.field === "low" || p.field === "bottom";
      const r = reserve({ x: p.x - size / 2, y: below ? p.y + 14 : p.y - 14 - size, w: size, h: size }); // right on its candle, never nudged away
      add(L.create("polygon", r.x, r.y, size, size, { sides: 4, star: .62, fill: colour(m.color, NAMED.muted), stroke: "transparent" }));
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
    if (panel.label) add(L.create("text", x + w / 2 - (two ? 400 : 600), bottom - labelH + 24, two ? 800 : 1200, undefined, { text: String(panel.label).slice(0, 50), style: { ...L.bodyStyle(32), weight: 600, align: "center" }, auto: false }));
  });

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

/* â”€â”€ The designer: turns "show me X" into a spec â”€â”€ */
const PATTERN_HELP = `Library patterns (bullish, "flip": true draws the bearish twin): swing-2, swing-3, swing-4 (swing formations); c2-closure, c2-closure-run, c3-closure, c3-closure-run (closures); ideal, ideal-run (ideal formation); wick-eq, wick-eq-run; opposing, opposing-series; sweep-low (liquidity sweep then reversal); fvg, fvg-return (fair value gap, and price returning into it); eq-continuation, eq-reversal; cisd; projection; week-tuesday-low, week-wednesday, week-thursday, week-consolidation, week-monday-low (weekly profiles, 5 daily candles); htf-3, htf-2 (higher timeframe candles); osok-entry. Generated: uptrend, downtrend, range, consolidation, breakout, sweep, vshape, london-reversal, ny-reversal, london-expansion (with "count" 6 to 20).`;
const DESIGNER = `You design a trading diagram for the YSER slides editor, then reply with ONE JSON object and nothing else.
USE A TEMPLATE. These are ready-made, hand-drawn diagrams in the owner's style, and one of them fits almost every request: choose the CLOSEST one, even when it only covers the main idea of a longer request (a CISD after a sweep -> cisd; candle 2 and candle 3 of the fractal model -> fractal; an entry into a gap -> fvg). Reply {"template":"<id>","direction":"bullish" or "bearish"} (the direction the idea is traded; optionally "title" and "subtitle" to reword the headline, at most 6 and 12 words). When the request joins TWO ideas (a sweep, then a CISD), show them side by side: {"templates":[{"template":"<id>","direction":"..."},{"template":"<id>","direction":"..."}],"title":"...","subtitle":"..."}. Templates:
${templateList()}
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
   {"type":"smt","from":"3:low","to":"9:low","style":"dashed|solid","color":"muted|ss","label":"6H â€¢ 2S"}   an SMT line between two swing points (pivot A to pivot B)
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

function systemFor(request, doc, lessons) {
  return [DESIGNER, asksAboutSmt(request) ? `THE OWNER'S SMT / PSP / STRENGTH SWITCH RULES (authoritative; they decide every colour and label; below 15M draw no PSP star):\n${SMT_RULES}` : "", doc ? `THE OWNER'S MODEL (their vocabulary comes first):\n${modelFor(doc, request, 2200)}` : "", lessons.text ? `LESSON MATERIAL ON THIS:\n${lessons.text}` : ""].filter(Boolean).join("\n\n");
}

/** "Show me X" -> a PNG. `request` is what the user wants drawn; the lessons and the user's model that match it guide the drawing. */
export async function designDiagram(request, { doc } = {}) {
  const lessons = recall(request, { chars: 3600, perLesson: 2 });
  const system = systemFor(request, doc, lessons);
  let note = "", failure = null;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await viaJson(system, `Draw: ${request}${note}`);
      if (reply.ask && !reply.template && !reply.panels) throw new Clarify(String(reply.ask).slice(0, 500));
      const spec = resolve(reply);
      const png = await drawDiagram(spec).catch(() => null);
      if (png) return { png, spec, lessons: lessons.lessons };
      note = "\n(Your last reply had nothing that could be drawn. Reply with a template id from the list, or a spec with real panels and a pattern or bars.)";
    }
  } catch (e) { if (e instanceof Clarify) throw e; failure = e; }
  // The AI is rate limited or too slow: the hand-drawn template that matches the words still comes out.
  const spec = quickTemplate(request);
  const png = spec ? await drawDiagram(spec).catch(() => null) : null;
  if (png) return { png, spec, lessons: lessons.lessons };
  throw new Clarify(clarifyText(request)); // nothing matched: ask what was meant, with the nearest options
}

/** The template a request names by its keywords, without any AI (a fallback, and what keeps the common pictures instant). */
export function quickTemplate(request) {
  const q = String(request).toLowerCase();
  const dir = /bear|short|sell|down/.test(q) ? "bearish" : "bullish";
  const id = /double confirm/.test(q) ? "ss-double" : /not linked|unlinked|too late|no stage/.test(q) ? "not-linked" : /opposite direction/.test(q) ? "opposite"
    : /(chain|three).*(flip|weak.*strong)/.test(q) ? "chain-flip" : /strong.*then.*weak|strong.*to.*weak|order matters|reversed order/.test(q) ? "stage-2s-order"
    : /psp.*(s2|second)|s2.*psp/.test(q) && /ss|switch/.test(q) ? "ss-s2-psp" : /two smt|pair|leg flip|flip|no psp|without (a )?psp/.test(q) && /ss|switch|stage/.test(q) ? "stage-ss"
    : /\b3s\b|three.stage/.test(q) ? "stage-3s" : /\b2s\b|two.stage/.test(q) ? "stage-2s"
    : /\bss\b.*stage|stage.*\bss\b|weak (htf|higher).*strong/.test(q) ? "stage-ss"
    : /psp first|pivot a|line (turns|goes) blue/.test(q) ? "ss-first"
    : /no switch|wrong (close|way)|not (a )?switch|doesn.?t switch|neutral star/.test(q) ? "ss-last-no"
    : /strength switch|\bswitch\b|psp last|\bss\b/.test(q) ? "ss-last"
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
  if (isGenericSs(request)) { // "a strength switch": the two ways it happens, two images
    const dir = /bear|short|sell|down/i.test(request) ? "bearish" : "bullish";
    const images = [];
    for (const id of ["ss-pair", "ss-psp"]) { const spec = fromTemplate(id, dir); images.push({ png: await drawDiagram(spec), spec }); }
    return { images, lessons: lessons.lessons };
  }
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
  return templateIndex.search(request, n).map(h => h.chunk.name);
}
const clarifyText = request => {
  const near = nearest(request);
  return `I'm not sure I understood which drawing you mean.${near.length ? ` The closest I can draw well: ${near.map(n => `**${n}**`).join("; ")}.` : ""} Tell me which one, or describe the candles, lines and what should be highlighted, and I'll draw it.`;
};

/** A strength switch asked for with no detail: always the two ways it happens, as two images (two SMTs, and a PSP), each with the correlated asset beside it. */
export const isGenericSs = q => /\b(ss|strength switch)\b/i.test(q) && !/(psp (first|last)|\b[23]s\b|stage|wrong|no switch|not (a )?switch|double|not linked|opposite|chain|strong.*then.*weak|first prompt)/i.test(q);
