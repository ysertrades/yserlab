import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The education center, searchable. knowledge/ttrades/kb.json is built by scripts/education/build.js from every lesson of the TTrades
 * Trading Education Center (article text, what each diagram teaches, the PDF handouts, the video transcripts, and a study note per lesson).
 * Groq only takes ~8000 tokens per request, so the bot never sends the whole thing: it finds the passages that answer the question
 * (BM25 over the chunks, with the acronyms of this trading world expanded) and sends those, plus the course map when asked about structure.
 */
const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../knowledge/ttrades/kb.json");

const STOP = new Set("a an and are as at be but by can do does for from has have how i if in is it its me my of on or so that the their them then there these they this to was we what when where which who why will with would you your about into than too very just also not no yes tell explain please give show".split(" "));
/** The shorthand of this trading world, spelled out so a question using "fvg" finds the lesson that says "fair value gap" (and the other way round). */
const ALIASES = {
  fvg: "fair value gap", ifvg: "inversion fair value gap", bpr: "balanced price range", ob: "order block", obs: "order blocks", eq: "equilibrium", ce: "consequent encroachment",
  erl: "external range liquidity", irl: "internal range liquidity", ote: "optimal trade entry", amd: "accumulation manipulation distribution", po3: "power of three",
  pd: "premium discount", htf: "higher timeframe", ltf: "lower timeframe", ttfm: "fractal model", cisd: "change state delivery", iccisd: "intracandle cisd",
  smt: "smt divergence", psp: "precision swing point", mss: "market structure shift", bos: "break structure", pdh: "previous day high", pdl: "previous day low",
  adr: "average daily range", dol: "draw on liquidity", sibi: "sellside imbalance buyside inefficiency", bisi: "buyside imbalance sellside inefficiency", vi: "volume imbalance",
  kz: "kill zone", mmxm: "market maker model", c1: "candle 1", c2: "candle 2", c3: "candle 3", c4: "candle 4", ny: "new york", nq: "nasdaq", es: "s&p", ym: "dow",
  rr: "risk reward", sl: "stop loss", tp: "take profit", hod: "high of day", lod: "low of day", ohlc: "open high low close", ict: "inner circle trader",
  bsl: "buyside liquidity", ssl: "sellside liquidity", ndog: "new day opening gap", nwog: "new week opening gap", fx: "forex",
};
const stem = w => w.length > 4 ? w.replace(/(ing|edly|ed|es|ly|s)$/, "") : w;
export function tokens(text, { expand = true } = {}) {
  const out = [];
  for (const raw of String(text).toLowerCase().replace(/ic-cisd/g, "iccisd").replace(/[^a-z0-9&]+/g, " ").split(" ")) {
    if (!raw) continue;
    if (expand && ALIASES[raw]) for (const w of ALIASES[raw].split(" ")) if (!STOP.has(w)) out.push(stem(w));
    if (STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** A small BM25 index over { text, head?, title?, weight? } chunks. */
export class Index {
  constructor(chunks) {
    this.chunks = chunks;
    this.tf = []; this.len = []; this.df = new Map();
    let total = 0;
    chunks.forEach((c, i) => {
      const heading = c.h ?? c.head ?? "";
      const toks = tokens(`${c.title ?? ""} ${c.title ?? ""} ${heading} ${heading} ${c.x ?? c.t ?? c.text}`, { expand: false });
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.tf[i] = tf; this.len[i] = toks.length; total += toks.length;
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    });
    this.avg = total / Math.max(1, chunks.length);
    // The words of each title, once: a question that names a lesson ("how do I trade candle 3") should find that lesson's passages first.
    const seen = new Map();
    this.title = chunks.map(c => {
      if (!c.title) return null;
      if (!seen.has(c.title)) seen.set(c.title, [...new Set(tokens(c.title, { expand: false }))]);
      return seen.get(c.title);
    });
  }
  /** Chunks ranked for a question: [{ chunk, score }]. */
  search(query, limit = 10) {
    const q = [...new Set(tokens(query))];
    if (!q.length) return [];
    const N = this.chunks.length, k1 = 1.4, b = .75, scored = [];
    for (let i = 0; i < N; i++) {
      const tf = this.tf[i];
      let s = 0, hit = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        hit++;
        const df = this.df.get(t) ?? 0;
        s += Math.log(1 + (N - df + .5) / (df + .5)) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * this.len[i] / this.avg));
      }
      if (!s) continue;
      s *= 1 + .35 * (hit / q.length) ** 2 * q.length / (q.length + 2); // covering more of the question's words beats repeating one
      const tt = this.title[i];
      if (tt?.length) s *= 1 + 2.2 * (tt.filter(t => q.includes(t)).length / tt.length) ** 1.5;
      scored.push({ chunk: this.chunks[i], score: s * (this.chunks[i].weight ?? 1) });
    }
    return scored.sort((x, y) => y.score - x.score).slice(0, limit);
  }
}

let kb = null, index = null;
export function knowledge() {
  if (kb !== null) return kb || null;
  try {
    kb = JSON.parse(fs.readFileSync(FILE, "utf8"));
    // The lesson's own words rank above what was written about them: article text, then diagrams, then the notes made from them.
    const w = { text: 1.5, note: 1.25, glossary: 1.1, overview: 1.2, diagram: 1.05, pdf: .9, video: .55 };
    kb.chunks.forEach(c => { c.title = kb.lessons[c.l]?.title ?? c.title; c.weight = w[c.k] ?? 1; });
    index = new Index(kb.chunks);
  } catch { kb = false; }
  return kb || null;
}
export const hasKnowledge = () => !!knowledge();

const KIND = { note: "study note", text: "lesson", diagram: "diagram", pdf: "PDF handout", video: "video", glossary: "definition", overview: "course overview" };
/**
 * Passages for a question, best first, within `chars`. A lesson gives at most `perLesson` passages so one long lesson can't crowd out the
 * others; a study note is always allowed first, because it holds that lesson's rules whole.
 */
export function recall(query, { chars = 9000, perLesson = 3, limit = 40 } = {}) {
  const k = knowledge();
  if (!k) return { text: "", lessons: [] };
  const hits = index.search(query, limit);
  const used = new Map(), picked = [];
  let size = 0;
  for (const { chunk: c } of hits) {
    const n = used.get(c.l) ?? 0;
    if (n >= perLesson) continue;
    const lesson = k.lessons[c.l];
    const block = `[${lesson ? `${lesson.title} · ${KIND[c.k] ?? c.k}${c.h ? " · " + c.h : ""}` : KIND[c.k] ?? c.k}]\n${c.t}`;
    if (size + block.length > chars) { if (size > chars * .8) break; continue; }
    used.set(c.l, n + 1); size += block.length + 2; picked.push({ block, lesson });
  }
  const lessons = [...new Map(picked.filter(p => p.lesson).map(p => [p.lesson.slug, p.lesson])).values()];
  return { text: picked.map(p => p.block).join("\n\n"), lessons };
}

/** The shape of the education center: its courses in teaching order, each lesson numbered. */
export function structureText({ overview = false, titles = true } = {}) {
  const k = knowledge();
  if (!k) return "";
  return k.courses.map(c => {
    const head = `${c.name} (${c.lessons.length} lessons)`;
    const list = titles ? "\n" + c.lessons.map((s, i) => `${i + 1}. ${k.lessons.find(l => l.slug === s)?.title ?? s}`).join("\n") : "";
    return head + (overview && c.overview ? "\n" + c.overview : "") + list;
  }).join("\n\n");
}
export const asksForStructure = q => /\b(structure|curriculum|syllabus|courses?|lessons?|modules?|education cent|what (do you|did you) (know|learn)|what('s| is) (in|covered)|list (of )?(all )?(the )?(lessons|topics|courses)|topics|in order|path|where (do|should) i (start|begin))\b/i.test(q);
export const stats = () => { const k = knowledge(); return k ? { lessons: k.lessons.length, chunks: k.chunks.length, built: k.built } : null; };
