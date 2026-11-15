// Stage 3: distil every lesson (its text, its diagrams, its PDF and its video) into one dense study note, then each course into an overview.
//   node scripts/education/summarize.js
// Writes knowledge/ttrades/enrich/summaries.json (resumable). The notes are what the bot reads first; the full text stays searchable behind them.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("knowledge/ttrades");
const RAW = path.join(OUT, "raw");
const ENR = path.join(OUT, "enrich");
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) throw new Error("GEMINI_API_KEY is not set");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const load = name => { try { return JSON.parse(fs.readFileSync(path.join(ENR, name), "utf8")); } catch { return {}; } };
const images = load("images.json"), videos = load("videos.json"), pdfs = load("pdfs.json");
const structure = JSON.parse(fs.readFileSync(path.join(OUT, "structure.json"), "utf8"));
const MODELS = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-flash-lite-latest"];

// LLM=groq runs this on Groq's gpt-oss models (each takes ~8000 tokens a minute, so each gets its own token bucket); otherwise Gemini.
const buckets = { "openai/gpt-oss-120b": [], "openai/gpt-oss-20b": [] };
const used = list => list.filter(x => Date.now() - x.t < 60_000).reduce((s, x) => s + x.n, 0);
async function groq(prompt, max = 1400) {
  const est = Math.ceil(prompt.length / 3.2) + max;
  let last = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    // the model with the most room in its last minute (the big one preferred)
    const [model] = Object.entries(buckets).sort((a, b) => used(a[1]) - used(b[1]) + (a[0].includes("120") ? -400 : 0))[0];
    const bucket = buckets[model];
    while (used(bucket) + est > 7300) await sleep(2500);
    bucket.push({ t: Date.now(), n: est });
    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.GROQ_API_KEY },
        body: JSON.stringify({ model, temperature: 0.2, max_completion_tokens: max, reasoning_effort: "low", messages: [{ role: "user", content: prompt }] }), signal: AbortSignal.timeout(90_000),
      });
      if (r.ok) { const j = await r.json(); bucket[bucket.length - 1].n = j.usage?.total_tokens ?? est; const t = String(j.choices?.[0]?.message?.content ?? "").trim(); if (t) return t; last = "empty"; }
      else { last = "HTTP " + r.status + " " + (await r.text()).slice(0, 260); if (r.status === 429) bucket.push({ t: Date.now(), n: 7300 }); }
    } catch (e) { last = e.message; }
    await sleep(1500);
  }
  throw new Error(last);
}
async function gemini(prompt, max = 1800) {
  if (process.env.LLM === "groq") return groq(prompt, Math.min(max, 1500));
  let last = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const model = MODELS[Math.min(attempt >> 1, MODELS.length - 1)];
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: max } }), signal: AbortSignal.timeout(120_000),
      });
      if (r.ok) { const t = ((await r.json()).candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join("").trim(); if (t) return t; last = "empty"; }
      else { last = "HTTP " + r.status; if (r.status === 429) await sleep(8000 * (attempt + 1)); }
    } catch (e) { last = e.message; }
    await sleep(1500 * (attempt + 1));
  }
  throw new Error(last);
}

/** The part of a diagram note that matters for studying: what it shows and what it teaches. */
export const taught = d => (d.split(/\n\s*(?:\*\*)?\s*(?:2\.|WHAT IT SHOWS)/i)[1] ?? d).replace(/\*\*/g, "").trim();

const lessons = fs.readdirSync(RAW).filter(f => f.endsWith(".json")).map(f => JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8")));
const done = load("summaries.json");
const todo = lessons.filter(l => !done[l.slug]);
console.log(`lessons: ${Object.keys(done).length} summarised, ${todo.length} to do`);

const PROMPT = `You are building the study notes of a trading assistant that must know the TTrades Trading Education Center perfectly. Below is ONE lesson in full: its article, what its diagrams show, its PDF handout and its video transcript (auto-captions, so spelling can be off). Write a dense study note in exactly this format and nothing else:

SUMMARY: 3-5 sentences: what the lesson teaches and why it matters.
KEY RULES:
- every rule, condition, step, level, timeframe, number and entry/stop/target instruction the lesson gives, as short precise bullets (as many as the lesson holds, none left out)
DEFINITIONS:
- Term: its exact meaning in this lesson (every term the lesson defines or uses specially)
MISTAKES / INVALIDATION:
- what makes the idea fail or invalid, what not to do (only if the lesson says)
DIAGRAMS:
- one bullet per diagram: what it shows and the point it makes (only if there are diagrams)
Use the lesson's own words and numbers. Never invent anything that is not in the material.`;

let n = 0, idx = 0;
async function work() {
  while (idx < todo.length) {
    const l = todo[idx++];
    const small = process.env.LLM === "groq"; // Groq's per-request room is small: the article and diagrams first, a little of the handout, no transcript
    const text = l.body.map(b => b.t === "img" ? `[DIAGRAM: ${taught(images[b.src] ?? b.alt ?? "").slice(0, small ? 380 : 900)}]` : b.t === "h" ? `\n## ${b.text}` : b.text).join("\n");
    const pdf = l.pdfs.map(u => pdfs[u]).filter(Boolean).join("\n").slice(0, small ? 2200 : 7000);
    const video = small ? "" : l.videos.map(v => videos[v]).filter(Boolean).join("\n").slice(0, 9000);
    const prompt = `${PROMPT}\n\n=== LESSON: ${l.title} (${l.courses.map(c => `${c.course} #${c.n}`).join("; ") || "no course"}) ===\nARTICLE AND DIAGRAMS:\n${text.slice(0, small ? 9500 : 24000)}\n\nPDF HANDOUT:\n${pdf || "(none)"}\n\nVIDEO TRANSCRIPT:\n${video || "(none)"}`;
    try { done[l.slug] = await gemini(prompt); } catch (e) { console.log("  failed:", l.slug, e.message); }
    if (++n % 5 === 0) { fs.writeFileSync(path.join(ENR, "summaries.json"), JSON.stringify(done, null, 1)); console.log(`  ${n}/${todo.length}`); }
  }
}
await Promise.all(Array.from({ length: 3 }, work));
fs.writeFileSync(path.join(ENR, "summaries.json"), JSON.stringify(done, null, 1));

// One overview per course, from its lessons' notes in the order the site teaches them.
const overviews = load("overviews.json");
for (const c of structure.courses) {
  if (overviews[c.slug]) continue;
  const bySlug = new Map(lessons.map(l => [l.slug, l]));
  const list = c.lessons.filter(s => s !== "trading-education-center" && bySlug.has(s)).map((s, i) => `${i + 1}. ${bySlug.get(s).title}: ${(done[s] ?? "").split("\n")[0].replace(/^SUMMARY:\s*/, "").slice(0, process.env.LLM === "groq" ? 130 : 400)}`).join("\n");
  overviews[c.slug] = await gemini(`Here is the "${c.name}" course of the TTrades Trading Education Center, lesson by lesson, in the order the site happens to list them (newest first; that is NOT a teaching order, so do not present the numbers as a sequence to follow).\n\n${list}\n\nWrite the course overview a student needs: (1) what the course is and who it is for, (2) the lessons grouped by topic (name them by title), and how those topics fit together as a path from basics to advanced, which you infer from the titles and notes, (3) the core ideas that run through the whole course. 350-500 words, plain text, no preamble. Use only what the lessons say.`, 2200);
  fs.writeFileSync(path.join(ENR, "overviews.json"), JSON.stringify(overviews, null, 1));
  console.log("overview:", c.name);
}
fs.writeFileSync(path.join(ENR, "overviews.json"), JSON.stringify(overviews, null, 1));
console.log("finished");




