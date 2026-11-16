// Stage 2: read everything that isn't plain text, so nothing in the education center is skipped.
//   node scripts/education/enrich.js [images|videos|pdfs]      (no argument = all three)
//  - images: every diagram/chart in the lessons is read by Gemini's vision: all text on it, then what it teaches
//  - videos: each lesson's YouTube transcript
//  - pdfs:   each lesson's PDF handout (slides) read by Gemini
// Results go to knowledge/ttrades/enrich/*.json and are saved as it goes, so an interrupted run carries on where it stopped.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const OUT = path.resolve("knowledge/ttrades");
const RAW = path.join(OUT, "raw");
const ENR = path.join(OUT, "enrich");
const CACHE = path.resolve("knowledge/cache");
fs.mkdirSync(ENR, { recursive: true }); fs.mkdirSync(CACHE, { recursive: true });
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) throw new Error("GEMINI_API_KEY is not set");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lessons = () => fs.readdirSync(RAW).filter(f => f.endsWith(".json")).map(f => JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8")));
const load = name => { try { return JSON.parse(fs.readFileSync(path.join(ENR, name), "utf8")); } catch { return {}; } };
const save = (name, data) => fs.writeFileSync(path.join(ENR, name), JSON.stringify(data, null, 1));
const MODELS = ["gemini-flash-lite-latest", "gemini-3.5-flash", "gemini-flash-latest"];

// Gemini's free allowance is a few requests a minute: one global gate spaces every request (a 429 also backs the gate off for everyone).
let gate = 0;
const GAP = Number(process.env.GEMINI_GAP_MS ?? 4500);
async function slot() { const at = Math.max(Date.now(), gate); gate = at + GAP; if (at > Date.now()) await sleep(at - Date.now()); }
async function gemini(parts, { max = 2500 } = {}) {
  let last = "";
  for (let attempt = 0; attempt < 7; attempt++) {
    await slot();
    const model = MODELS[Math.min(attempt >> 1, MODELS.length - 1)];
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.1, maxOutputTokens: max } }), signal: AbortSignal.timeout(120_000),
      });
      if (r.ok) {
        const text = ((await r.json()).candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join("").trim();
        if (text) return text;
        last = "empty";
      } else { last = `HTTP ${r.status}`; if (r.status === 429) gate = Math.max(gate, Date.now() + 15000 * (attempt + 1)); }
    } catch (e) { last = e.message; }
    await sleep(1500 * (attempt + 1));
  }
  throw new Error(last);
}

/** Run `items` through `work` with a few at once, saving after every batch. */
async function pool(items, size, work, flush) {
  let i = 0, done = 0;
  const run = async () => { while (i < items.length) { const item = items[i++]; try { await work(item); } catch (e) { console.log("  failed:", String(item).slice(-70), e.message); } if (++done % 10 === 0) { flush(); console.log(`  ${done}/${items.length}`); } } };
  await Promise.all(Array.from({ length: size }, run));
  flush();
}

async function download(url, ext) {
  const file = path.join(CACHE, createHash("sha1").update(url).digest("hex").slice(0, 16) + ext);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  for (let t = 0; t < 4; t++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(60_000) }); if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(file, b); return b; } } catch { /* retry */ }
    await sleep(1000 * (t + 1));
  }
  throw new Error("download failed " + url);
}

const SHORT_PROMPT = `TTrades trading-education picture. Reply in at most 170 words, no preamble: first "TEXT:" every word printed on it, then "WHAT IT SHOWS:" the candles, levels, zones, arrows and order of events, then "WHAT IT TEACHES:" the rule in one sentence.`;
const IMAGE_PROMPT = `This picture is from the TTrades trading education material (the TTrades Fractal Model and ICT concepts). Work like a careful note-taker who must leave nothing out.
1. TEXT: write every word printed on the picture exactly as shown (titles, labels, annotations, bullet points, captions).
2. WHAT IT SHOWS: describe the diagram precisely: the candles and their colours, the levels and zones drawn (and what each is called), arrows, numbered steps, the order in which things happen, which side is bullish or bearish.
3. WHAT IT TEACHES: state the rule or idea the picture is demonstrating, in plain words, as a trading student would need it.
No introduction, no closing remarks. Be complete and concrete.`;

/** The same reading through Groq's Qwen (VISION=groq): used when Gemini's free daily allowance runs out. Images are shrunk to ~1100 px wide. */
let groqGate = 0;
async function groqVision(file, prompt) {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(file);
  const w = Math.min(960, img.width), h = Math.round(img.height * w / img.width);
  const canvas = createCanvas(w, h);
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  const url = "data:image/jpeg;base64," + canvas.toBuffer("image/jpeg", 82).toString("base64");
  let last = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const at = Math.max(Date.now(), groqGate); groqGate = at + 14000; if (at > Date.now()) await sleep(at - Date.now());
    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.GROQ_API_KEY },
        body: JSON.stringify({ model: "qwen/qwen3.8-27b", temperature: 0.1, max_completion_tokens: 420, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }, { type: "text", text: prompt }] }] }),
        signal: AbortSignal.timeout(90_000),
      });
      if (r.ok) { const t = String((await r.json()).choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim(); if (t) return t; last = "empty"; }
      else { last = "HTTP " + r.status; if (r.status === 429) groqGate = Math.max(groqGate, Date.now() + 20000); }
    } catch (e) { last = e.message; }
  }
  throw new Error(last);
}

async function images() {
  const done = load("images.json");
  const todo = [...new Set(lessons().flatMap(l => l.body.filter(b => b.t === "img").map(b => b.src)))].filter(u => !done[u]);
  console.log(`images: ${Object.keys(done).length} done, ${todo.length} to read`);
  await pool(todo, 5, async url => {
    if (url.endsWith(".svg")) {
      const svg = (await download(url, ".svg")).toString("utf8");
      done[url] = "Vector graphic. Text in it: " + ([...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map(m => m[1].replace(/<[^>]+>/g, "")).join(" ") || "(none)");
      return;
    }
    const ext = (url.split("?")[0].match(/\.(png|jpe?g|webp|gif)$/i)?.[1] ?? "png").toLowerCase();
    const mime = ext === "jpg" ? "image/jpeg" : "image/" + ext;
    const bytes = await download(url, "." + ext);
    done[url] = process.env.VISION === "groq"
      ? await groqVision(bytes, SHORT_PROMPT)
      : await gemini([{ inlineData: { mimeType: mime, data: bytes.toString("base64") } }, { text: IMAGE_PROMPT }]);
  }, () => save("images.json", done));
}

async function videos() {
  const { YoutubeTranscript } = await import("youtube-transcript");
  const done = load("videos.json");
  const todo = [...new Set(lessons().flatMap(l => l.videos))].filter(v => !(v in done));
  console.log(`videos: ${Object.keys(done).length} done, ${todo.length} to read`);
  await pool(todo, 3, async id => {
    for (let t = 0; t < 4; t++) {
      try { const segs = await YoutubeTranscript.fetchTranscript(id); done[id] = segs.map(s => s.text.replace(/\s+/g, " ")).join(" ").replace(/\[(Music|Applause)\]/gi, "").replace(/&amp;#39;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(); return; }
      catch (e) { if (t === 3) { done[id] = null; throw e; } await sleep(1500 * (t + 1)); }
    }
  }, () => save("videos.json", done));
}

const PDF_PROMPT = `This PDF is a TTrades trading education handout (slides). Transcribe it page by page without leaving anything out. For each page write "PAGE n:", then every word on the page exactly as printed, then (for pages with charts or diagrams) a precise description of what the drawing shows: candles, levels, zones, arrows, the order of events, bullish vs bearish, and the rule it teaches. No introduction or closing remarks.`;
async function pdfs() {
  const done = load("pdfs.json");
  const todo = [...new Set(lessons().flatMap(l => l.pdfs))].filter(u => !done[u]);
  console.log(`pdfs: ${Object.keys(done).length} done, ${todo.length} to read`);
  await pool(todo, 3, async url => {
    const data = (await download(url, ".pdf")).toString("base64");
    done[url] = await gemini([{ inlineData: { mimeType: "application/pdf", data } }, { text: PDF_PROMPT }], { max: 8000 });
  }, () => save("pdfs.json", done));
}

const which = process.argv[2];
if (!which || which === "videos") await videos();
if (!which || which === "images") await images();
if (!which || which === "pdfs") await pdfs();
console.log("finished");


