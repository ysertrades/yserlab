// Traces the candle charts out of the owner's model PDFs, so the bot can draw them at the PDF's own proportions.
//   node scripts/model/trace.mjs [name-fragment]        reads knowledge/model/ymodel-*.pdf, writes knowledge/model/drawings.json
// Each PDF page holds a chart picture (grey candles: white bodies up, dark bodies down). The picture is read pixel by pixel: dark solid
// bodies by erosion, white bodies as enclosed white rectangles, wicks by following the centre line, levels as blue horizontal lines.
import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { extractText, getDocumentProxy, getResolvedPDFJS } from "unpdf";

const DIR = path.resolve("knowledge/model");
const only = process.argv[2] ?? "";

async function pageImages(pdf, pdfjs, p) {
  const page = await pdf.getPage(p), ops = await page.getOperatorList(), out = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn !== pdfjs.OPS.paintImageXObject && fn !== pdfjs.OPS.paintJpegXObject) continue;
    const id = ops.argsArray[i]?.[0];
    try { out.push(await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout")), 5000); page.objs.get(id, v => { clearTimeout(t); res(v); }); })); } catch { /* skip */ }
  }
  return out.filter(im => im?.data && im.width >= 300 && im.height >= 300);
}

/** The page's picture box (PDF coordinates, y up) from the drawing operators, so text can be told apart as above or below it. */
async function imageBox(page, pdfjs) {
  const ops = await page.getOperatorList(), O = pdfjs.OPS, stack = [];
  let m = [1, 0, 0, 1, 0, 0], best = null;
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  ops.fnArray.forEach((fn, i) => {
    if (fn === O.save) stack.push(m);
    else if (fn === O.restore) m = stack.pop() ?? m;
    else if (fn === O.transform) m = mul(m, ops.argsArray[i]);
    else if (fn === O.paintImageXObject || fn === O.paintJpegXObject) { const y0 = m[5], y1 = m[5] + m[3], h = Math.abs(y1 - y0); if (!best || h > best.h) best = { top: Math.max(y0, y1), bottom: Math.min(y0, y1), h }; }
  });
  return best;
}

/** The page's words as lines, then paragraphs: a heading (a short first line), what comes above the picture and what comes below it. */
async function pageWords(page, pdfjs) {
  const box = await imageBox(page, pdfjs), content = await page.getTextContent();
  const items = content.items.filter(i => i.str?.trim()).map(i => ({ s: i.str, x: i.transform[4], y: i.transform[5], h: Math.abs(i.transform[3]) || 10 }));
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of items) { const l = lines.find(l => Math.abs(l.y - it.y) < 2.5); if (l) { l.s += (l.s.endsWith(" ") || it.s.startsWith(" ") ? "" : " ") + it.s; l.h = Math.max(l.h, it.h); } else lines.push({ y: it.y, s: it.s, h: it.h }); }
  lines.sort((a, b) => b.y - a.y);
  let heading = null;
  { const first = lines[0]; // a heading: a short first line with no full stop, above more text
    if (first && lines.length > 1 && first.s.trim().split(/\s+/).length <= 6 && !/[.!?,;:]$/.test(first.s.trim()) && (!box || first.y > box.top)) heading = first.s.replace(/\s+/g, " ").trim(); }
  if (heading) lines.shift();
  const gaps = lines.slice(1).map((l, i) => lines[i].y - l.y).filter(g => g > 0).sort((a, b) => a - b), line = gaps[0] ?? 14;
  const paras = []; let cur = null;
  for (const l of lines) { if (cur && cur.last - l.y <= line * 1.6) { cur.s += " " + l.s; cur.last = l.y; } else { cur = { s: l.s, y: l.y, last: l.y }; paras.push(cur); } }
  const clean = s => s.replace(/\s+/g, " ").trim();
  return { heading, before: paras.filter(p => !box || p.y > box.top).map(p => clean(p.s)), after: paras.filter(p => box && p.y <= box.top).map(p => clean(p.s)) };
}

/** RGBA or RGB pixels to classes: 0 light, 1 dark, 2 blue, 3 red. */
function classify(im) {
  const { width: W, height: H, data } = im, step = data.length / (W * H), cls = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < W * H; i++, j += step) {
    const r = data[j], g = data[j + 1], b = data[j + 2], gray = (r + g + b) / 3;
    cls[i] = b > r + 50 && b > 110 ? 2 : r > g + 60 && r > b + 60 ? 3 : gray < 150 ? 1 : gray < 205 ? 4 : 0; // 4: the soft grey of a thin outline
  }
  return { W, H, cls };
}

/** Connected components of the pixels where `want(cls)` is true. Returns [{ x0, y0, x1, y1, area, touches }]. */
function components(W, H, mask, four) {
  const seen = new Uint8Array(W * H), out = [], stack = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || seen[s]) continue;
    let sp = 0, x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0, touches = false;
    stack[sp++] = s; seen[s] = 1;
    while (sp) {
      const p = stack[--sp], x = p % W, y = (p / W) | 0;
      area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touches = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || (four && dx && dy)) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (mask[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
      }
    }
    out.push({ x0, y0, x1, y1, area, touches });
  }
  return out;
}

/** The binary mask eroded by a (2r+1) square, so only solid areas survive. */
function erode(W, H, mask, r) {
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { let run = 0; for (let x = 0; x < W; x++) { run = mask[y * W + x] ? run + 1 : 0; tmp[y * W + x] = run >= 2 * r + 1 ? 1 : 0; } }
  // `tmp` marks the right end of a horizontal run of 2r+1; spread it back to the run's centre
  const h = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (tmp[y * W + x]) h[y * W + x - r] = 1;
  for (let x = 0; x < W; x++) { let run = 0; for (let y = 0; y < H; y++) { run = h[y * W + x] ? run + 1 : 0; if (run >= 2 * r + 1) out[(y - r) * W + x] = 1; } }
  return out;
}

function traceImage(im) {
  const { W, H, cls } = classify(im);
  const dark = new Uint8Array(W * H), light = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) { dark[i] = cls[i] === 1 ? 1 : 0; light[i] = cls[i] === 0 || cls[i] === 2 || cls[i] === 3 ? 1 : 0; } // a blue level drawn across a body does not split it
  const bodies = [];
  // white bodies: enclosed light rectangles
  for (const c of components(W, H, light, true)) {
    const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
    if (c.touches || w < 9 || h < 4 || w > W * .3 || h > H * .8 || c.area / (w * h) < .92) continue;
    bodies.push({ x0: c.x0 - 1, x1: c.x1 + 1, y0: c.y0 - 1, y1: c.y1 + 1, dark: false });
  }
  // dark bodies: what survives eroding the dark mask, grown back
  const core = erode(W, H, dark, 2);
  for (const c of components(W, H, core, false)) {
    const w = c.x1 - c.x0 + 5, h = c.y1 - c.y0 + 5;
    if (w < 9 || h < 4 || w > W * .3 || c.area / ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)) < .9) continue;
    bodies.push({ x0: c.x0 - 2, x1: c.x1 + 2, y0: c.y0 - 2, y1: c.y1 + 2, dark: true });
  }
  // wicks: follow the centre line above and below each body
  const ink = i => cls[i] === 1 || cls[i] === 4;
  const isDark = (x, y) => y >= 0 && y < H && (ink(y * W + x) || ink(y * W + x - 1) || ink(y * W + x + 1));
  const candles = bodies.map(b => {
    const cx = Math.round((b.x0 + b.x1) / 2);
    let hi = b.y0, lo = b.y1, gap = 0;
    for (let y = b.y0 - 1; y >= 0; y--) { if (isDark(cx, y)) { hi = y; gap = 0; } else if (++gap > 2) break; }
    gap = 0;
    for (let y = b.y1 + 1; y < H; y++) { if (isDark(cx, y)) { lo = y; gap = 0; } else if (++gap > 2) break; }
    return { cx, w: b.x1 - b.x0 + 1, top: b.y0, bottom: b.y1, hi, lo, dark: b.dark };
  });
  // the same candle can be found twice (outline and fill): keep one per centre
  candles.sort((a, b) => a.cx - b.cx);
  const uniq = [];
  for (const c of candles) { const last = uniq[uniq.length - 1]; if (last && Math.abs(last.cx - c.cx) < Math.min(last.w, c.w) * .6 && Math.abs(last.top - c.top) < 6) { if (c.hi < last.hi) last.hi = c.hi; if (c.lo > last.lo) last.lo = c.lo; continue; } uniq.push(c); }
  // a line drawn across a white body (a dotted level, a blue level) splits it, so such a candle is missing: look for it where the spacing says it should be
  {
    const ordered = uniq.slice(), found = [];
    const gaps = ordered.slice(1).map((c, i) => c.cx - ordered[i].cx).filter(v => v > 0).sort((a, b) => a - b), step = gaps.length ? gaps[0] : 0;
    const longRuns = x => { const runs = []; let s = -1, off = 0; for (let y = 0; y <= H; y++) { const on = y < H && (ink(y * W + x) || cls[y * W + x] === 2 || cls[y * W + x] === 3); if (on) { if (s < 0) s = y; off = 0; } else if (s >= 0 && ++off > 4) { if (y - off - s >= 8) runs.push([s, y - off]); s = -1; off = 0; } } return runs; }; // a coloured level crossing the outline does not end it
    if (step > 0) for (let i = 0; i + 1 < ordered.length; i++) {
      const a = ordered[i], b = ordered[i + 1], n = Math.round((b.cx - a.cx) / step);
      if (n > 3 || Math.max(a.w, b.w) / Math.min(a.w, b.w) > 1.5) continue; // only a candle or two between neighbours of the same size
      for (let k = 1; k < n; k++) {
        const cx = Math.round(a.cx + (b.cx - a.cx) * k / n), hw = Math.round((a.w + b.w) / 4);
        let best = null;
        for (let dl = -2; dl <= 2; dl++) for (let dr = -2; dr <= 2; dr++) for (const l of longRuns(cx - hw + dl)) for (const r of longRuns(cx + hw + dr)) {
          const y0 = Math.max(l[0], r[0]), y1 = Math.min(l[1], r[1]);
          if (y1 - y0 >= 8 && (!best || y1 - y0 > best.y1 - best.y0)) best = { y0, y1 };
        }
        if (!best) continue;
        const dk = cls[((best.y0 + best.y1) >> 1) * W + cx] === 1;
        let hi = best.y0, lo = best.y1, gap = 0;
        for (let y = best.y0 - 1; y >= 0; y--) { if (isDark(cx, y)) { hi = y; gap = 0; } else if (++gap > 2) break; }
        gap = 0;
        for (let y = best.y1 + 1; y < H; y++) { if (isDark(cx, y)) { lo = y; gap = 0; } else if (++gap > 2) break; }
        found.push({ cx, w: Math.round((a.w + b.w) / 2), top: best.y0, bottom: best.y1, hi, lo, dark: dk });
      }
    }
    uniq.push(...found); uniq.sort((p, q) => p.cx - q.cx);
  }
  // blue levels: horizontal blue runs
  const levels = [];
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (cls[y * W + x] !== 2) { x++; continue; }
      let e = x; while (e < W && cls[y * W + e] === 2) e++;
      if (e - x >= 20) { const l = levels.find(v => Math.abs(v.y - y) <= 3 && Math.abs(v.x0 - x) <= 8); if (l) { l.x1 = Math.max(l.x1, e); } else levels.push({ y, x0: x, x1: e }); }
      x = e;
    }
  }
  return { W, H, candles: uniq, levels };
}

/** Candles into charts: a new chart where the spacing or the candle size jumps (the daily candle beside its 1H/4H candles). */
function groupCharts(candles) {
  if (candles.length < 1) return [];
  const groups = [[candles[0]]];
  const steps = candles.slice(1).map((c, i) => c.cx - candles[i].cx).sort((a, b) => a - b), med = steps.length ? steps[(steps.length / 2) | 0] : 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1], g = groups[groups.length - 1];
    const gap = c.cx - prev.cx, wideJump = Math.max(c.w, prev.w) / Math.min(c.w, prev.w) > 2;
    if (wideJump || (med && gap > med * 2.6)) groups.push([c]); else g.push(c);
  }
  return groups;
}

const files = fs.readdirSync(DIR).filter(f => f.startsWith("ymodel-") && f.endsWith(".pdf") && f.toLowerCase().includes(only.toLowerCase()));
const pdfjs = await getResolvedPDFJS();
const drawings = [];
for (const f of files) {
  const name = f.replace(/^ymodel-/, "").replace(/\.pdf$/, "").replace(/-/g, " ").trim();
  const buf = new Uint8Array(fs.readFileSync(path.join(DIR, f)));
  const pdf = await getDocumentProxy(buf.slice());
  const { text } = await extractText(await getDocumentProxy(buf.slice()), { mergePages: false });
  for (let p = 1; p <= pdf.numPages; p++) {
    const imgs = await pageImages(pdf, pdfjs, p);
    const pageText = String(text[p - 1] ?? "").replace(/\s+/g, " ").trim();
    const words = await pageWords(await pdf.getPage(p), pdfjs);
    for (const im of imgs) {
      const t = traceImage(im);
      const groups = groupCharts(t.candles);
      if (!t.candles.length) continue;
      const ymax = Math.max(...t.candles.map(c => c.lo)), ymin = Math.min(...t.candles.map(c => c.hi));
      const price = y => +(ymax - y).toFixed(1);
      const charts = groups.map(g => {
        const steps = g.slice(1).map((c, i) => c.cx - g[i].cx), step = steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : g[0].w * 1.4;
        const w = g.reduce((a, c) => a + c.w, 0) / g.length;
        return {
          step: +step.toFixed(1), bodyW: +w.toFixed(1), x0: g[0].cx - step / 2, x1: g[g.length - 1].cx + step / 2,
          candles: g.map(c => ({ o: price(c.dark ? c.top : c.bottom), h: price(c.hi), l: price(c.lo), c: price(c.dark ? c.bottom : c.top), x: c.cx })),
        };
      });
      const levels = t.levels.map(l => ({ price: price(l.y), x0: l.x0, x1: l.x1 }));
      if (process.env.DEBUG) { // an overlay of what was found, to check by eye
        const cv = createCanvas(t.W, t.H), g = cv.getContext("2d"), id = g.createImageData(t.W, t.H), step = im.data.length / (t.W * t.H);
        for (let i = 0; i < t.W * t.H; i++) { id.data[i * 4] = im.data[i * step]; id.data[i * 4 + 1] = im.data[i * step + 1]; id.data[i * 4 + 2] = im.data[i * step + 2]; id.data[i * 4 + 3] = 255; }
        g.putImageData(id, 0, 0); g.lineWidth = 3;
        for (const c of t.candles) { g.strokeStyle = c.dark ? "#f0a" : "#0b0"; g.strokeRect(c.cx - c.w / 2, c.top, c.w, c.bottom - c.top); g.strokeStyle = "#f60"; g.beginPath(); g.moveTo(c.cx, c.hi); g.lineTo(c.cx, c.lo); g.stroke(); }
        fs.mkdirSync("scratch/trace", { recursive: true }); fs.writeFileSync(`scratch/trace/${name.replace(/\W+/g, "-")}-${p}.png`, cv.toBuffer("image/png"));
      }
      drawings.push({ pdf: name, page: p, text: pageText, heading: words.heading, before: words.before, after: words.after, height: ymax - ymin, charts, levels });
      console.log(`${name} p${p}: ${t.candles.length} candles in ${charts.length} chart(s), ${levels.length} level(s)`);
    }
  }
}
const out = path.join(DIR, "drawings" + (only ? "-" + only.toLowerCase() : "") + ".json");
fs.writeFileSync(out, JSON.stringify(drawings));
console.log("wrote", out, drawings.length, "drawings");
