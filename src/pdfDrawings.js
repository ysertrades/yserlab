import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Index, tokens } from "./knowledge.js";

/**
 * The charts of the owner's own PDFs, traced (scripts/model/trace.mjs) into candles with the PDF's own proportions, and matched to a
 * request by the PDF's name and the text of its page. `specFromDrawing` turns one into a slide: same candles, same size, same levels.
 */
const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../knowledge/model/drawings.json");

let all = null, index = null;
export function pdfDrawings() {
  if (all) return all;
  try { all = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { all = []; }
  index = new Index(all.map((d, i) => ({ i, title: d.pdf, h: d.pdf, t: `${d.pdf}. ${d.text}`.slice(0, 1500) })));
  return all;
}

/** The pages of the PDFs that best answer a request: [{ drawing, score }], best first. */
export function matchDrawings(request, limit = 3) {
  const drawings = pdfDrawings();
  if (!drawings.length) return [];
  return index.search(request, limit).map(h => ({ drawing: drawings[h.chunk.i], score: h.score }));
}

/** Does the request name the whole PDF (all of its words)? Then every page of it is wanted. */
export function namesWholePdf(request, pdfName) {
  const q = new Set(tokens(request)), t = [...new Set(tokens(pdfName, { expand: false }))];
  return t.length > 0 && t.every(w => q.has(w));
}
export const pagesOf = pdf => pdfDrawings().filter(d => d.pdf === pdf && !/this is the end of/i.test(d.text)).sort((a, b) => a.page - b.page);

const sentences = text => String(text).replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);

/** One traced page as a drawing spec (panels of candles on one shared price scale, plus the blue levels). */
export function specFromDrawing(d) {
  let charts = d.charts.filter(c => c.candles.length);
  if (charts.length > 4) charts = [{ ...charts[0], candles: charts.flatMap(c => c.candles), step: charts[0].step, bodyW: charts[0].bodyW }]; // many tiny charts: one run of candles
  const lo = Math.min(...charts.flatMap(c => c.candles.map(k => k.l))), hi = Math.max(...charts.flatMap(c => c.candles.map(k => k.h))), span = hi - lo || 1;
  const panels = charts.map(c => {
    const idx = x => c.candles.findIndex(k => k.x >= x - c.step / 2);
    const marks = [];
    for (const lv of d.levels) {
      if (lv.x1 < c.x0 - c.step || lv.x0 > c.x1 + c.step) continue;
      const from = Math.max(0, idx(lv.x0)), toRaw = c.candles.length - 1 - [...c.candles].reverse().findIndex(k => k.x <= lv.x1 + c.step / 2);
      const to = Math.min(c.candles.length - 1, toRaw);
      const f = Math.min(1, Math.max(0, (lv.price - lo) / span));
      marks.push({ type: "level", at: `${from + 1}:@${f.toFixed(3)}`, label: "", color: "blue", dash: "solid", from: from + 1, to: Math.max(from + 1, to + 1) });
    }
    return { bars: c.candles.map(k => [k.o, k.h, k.l, k.c]), range: [lo, hi], aspect: c.step / span, gap: 1 - c.bodyW / c.step, numbers: c.candles.length <= 8, marks };
  });
  const fit = (x, n) => !x ? "" : x.length <= n ? x : x.slice(0, Math.max(0, x.lastIndexOf(" ", n - 1))) + "…";
  const firstSentence = x => (sentences(x ?? "")[0] ?? "");
  if (d.heading !== undefined) { // read with the page's own structure: its heading, the words above the picture, the words below it
    const title = String(d.heading ?? String(d.pdf).replace(/^the\s+/i, "")).slice(0, 60);
    const above = d.before ?? [], below = d.after ?? [];
    const subtitle = fit(firstSentence(above[0]) || above[0], 125);
    const second = sentences(above[0] ?? "")[1] ?? "";
    const caption = fit(below[0] ?? (above.length > 1 ? above[above.length - 1] : second), 110);
    return { title, subtitle, caption, assumed: `From your PDF: ${d.pdf}, page ${d.page}.`, panels, divider: panels.length === 2 };
  }
  const title = String(d.pdf).slice(0, 60);
  const body = String(d.text).replace(new RegExp("^\\s*" + title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "").trim();
  const s = sentences(body);
  return { title, subtitle: fit(s[0], 105), caption: fit(s[1], 85), assumed: `From your PDF: ${d.pdf}, page ${d.page}.`, panels, divider: panels.length === 2 };
}

/** The PDF whose entire name is in the request (the longest name when several are), or null. */
export function pdfNamedIn(request) {
  const names = [...new Set(pdfDrawings().map(d => d.pdf))].filter(n => namesWholePdf(request, n));
  const q = new Set(tokens(request));
  const overlap = n => { const text = pdfDrawings().filter(d => d.pdf === n).map(d => d.text).join(" "); return new Set(tokens(text, { expand: false }).filter(w => q.has(w))).size; }; // ties: the PDF whose own text uses more of the owner's words
  names.sort((a, b) => tokens(b, { expand: false }).length - tokens(a, { expand: false }).length || overlap(b) - overlap(a));
  return names[0] ?? null;
}
