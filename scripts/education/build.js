// Stage 4: assemble everything into the one file the bot searches: knowledge/ttrades/kb.json
//   node scripts/education/build.js
// Every lesson becomes passages of several kinds: its study note, its article sections, what each diagram teaches, its PDF handout pages,
// its video transcript, and its definitions; plus the course overviews and the course structure.
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("knowledge/ttrades");
const RAW = path.join(OUT, "raw"), ENR = path.join(OUT, "enrich");
const load = name => { try { return JSON.parse(fs.readFileSync(path.join(ENR, name), "utf8")); } catch { return {}; } };
const images = load("images.json"), videos = load("videos.json"), pdfs = load("pdfs.json"), notes = load("summaries.json"), overviews = load("overviews.json");
const structure = JSON.parse(fs.readFileSync(path.join(OUT, "structure.json"), "utf8"));

const taught = d => (d.split(/\n\s*(?:\*\*)?\s*(?:2\.|WHAT IT SHOWS)/i)[1] ?? d).replace(/\*\*/g, "").replace(/\n{2,}/g, "\n").trim();
const lessonsRaw = fs.readdirSync(RAW).filter(f => f.endsWith(".json")).map(f => JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8")));
// Lessons in the order of the courses (a lesson in two courses appears once), then any the courses don't list.
const order = [...new Set([...structure.courses.flatMap(c => c.lessons), ...lessonsRaw.map(l => l.slug)])];
const bySlug = new Map(lessonsRaw.map(l => [l.slug, l]));
const HUB = "trading-education-center"; // the education center's own front page, not a lesson
const lessons = order.filter(s => s !== HUB && bySlug.has(s)).map(s => bySlug.get(s));

const chunks = [];
const add = (l, k, h, t, x) => { t = t.trim(); if (t.length < 25) return; chunks.push(x ? { l, k, h, t, x } : { l, k, h, t }); };

/** Cut text at paragraph/bullet boundaries into pieces of about `size` characters. */
function pieces(text, size) {
  const out = []; let cur = "";
  for (const para of text.split(/\n+/)) {
    if (cur && cur.length + para.length > size) { out.push(cur); cur = ""; }
    cur += (cur ? "\n" : "") + para;
    while (cur.length > size * 1.6) { const cut = cur.lastIndexOf(". ", size * 1.3); const at = cut > size * .5 ? cut + 1 : size; out.push(cur.slice(0, at)); cur = cur.slice(at).trim(); }
  }
  if (cur) out.push(cur);
  return out;
}

lessons.forEach((lesson, l) => {
  const lessonWords = new Set((lesson.body.filter(b => b.t !== "img").map(b => b.text).join(" ") + " " + lesson.pdfs.map(u => pdfs[u] ?? "").join(" ") + " " + lesson.body.filter(b => b.t === "img").map(b => images[b.src] ?? "").join(" ")).toLowerCase().match(/[a-z]{4,}/g) ?? []);
  // The article, section by section; diagrams hang off the section they sit in.
  let head = "Introduction", buf = [];
  const flush = () => { if (buf.length) for (const p of pieces(buf.join("\n"), 1100)) add(l, "text", head, p); buf = []; };
  for (const b of lesson.body) {
    if (b.t === "h") { flush(); head = b.text; }
    else if (b.t === "img") {
      const d = images[b.src];
      if (d) add(l, "diagram", head, taught(d).slice(0, 900), d);
      else if (b.alt) buf.push(`[Picture: ${b.alt}]`);
    } else buf.push(b.text);
  }
  flush();
  // The handouts, a few pages at a time.
  for (const url of lesson.pdfs) {
    const d = pdfs[url];
    if (!d) continue;
    const pages = d.split(/\n?\s*\**\s*PAGE\s+\d+\s*:?\s*\**\s*/i).map(p => p.trim()).filter(Boolean);
    let cur = "", from = 1;
    pages.forEach((p, i) => { if (cur && cur.length + p.length > 1300) { add(l, "pdf", `handout, pages ${from}-${i}`, cur); cur = ""; from = i + 1; } cur += (cur ? "\n" : "") + p; });
    add(l, "pdf", `handout, pages ${from}-${pages.length}`, cur);
  }
  // The video, in overlapping windows (auto-captions, so it is searched but ranked lower).
  for (const v of lesson.videos) {
    const t = videos[v];
    if (!t) continue;
    for (let at = 0, n = 1; at < t.length; at += 900, n++) add(l, "video", `video part ${n}`, t.slice(at, at + 1050));
  }
  // The study note, and every definition on its own so a "what is X" finds it directly.
  const note = notes[lesson.slug];
  if (note) {
    const parts = note.split(/^\s*(?=(?:SUMMARY|KEY RULES|DEFINITIONS|MISTAKES(?: \/ INVALIDATION)?|DIAGRAMS):)/m).map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
      const name = part.match(/^([A-Z /]+):/)?.[1] ?? "note";
      const body = part.replace(/^[A-Z /]+:\s*/, "");
      for (const p of pieces(body, 1300)) add(l, "note", name.toLowerCase(), `${name}: ${p}`);
      // A definition becomes its own passage only if the lesson itself backs it: most of its words must appear in the lesson's own text.
      if (name === "DEFINITIONS") for (const line of body.split("\n")) {
        const m = line.replace(/^[-*â€¢]\s*/, "").replace(/\*\*/g, "").match(/^([^:â€“â€”-]{2,60})\s*[:â€“â€”-]+\s*(.{12,})$/);
        if (!m) continue;
        const words = [...new Set(m[2].toLowerCase().match(/[a-z]{4,}/g) ?? [])];
        const known = words.filter(w => lessonWords.has(w)).length;
        if (words.length && known / words.length >= .7) add(l, "glossary", m[1].trim(), `${m[1].trim()}: ${m[2].trim()} (${lesson.title})`);
      }
    }
  }
});
for (const c of structure.courses) if (overviews[c.slug]) chunks.push({ l: -1, k: "overview", h: c.name, title: c.name + " (course)", t: overviews[c.slug] });

const kb = {
  built: new Date().toISOString(), source: structure.source,
  lessons: lessons.map(l => ({ slug: l.slug, title: l.title, url: l.url, courses: l.courses, video: l.videos[0] ?? null })),
  courses: structure.courses.map(c => ({ name: c.name, url: c.url, overview: overviews[c.slug] ?? "", lessons: c.lessons.filter(s => s !== HUB && bySlug.has(s)) })),
  chunks,
};
fs.writeFileSync(path.join(OUT, "kb.json"), JSON.stringify(kb));
const by = {}; for (const c of chunks) by[c.k] = (by[c.k] ?? 0) + 1;
console.log(`kb.json: ${lessons.length} lessons, ${chunks.length} passages`, by, (fs.statSync(path.join(OUT, "kb.json")).size / 1e6).toFixed(1) + " MB");

