// Stage 1: read the whole TTrades Trading Education Center.
//   node scripts/education/crawl.js
// Pulls every post (through the site's own WordPress API), the four course pages (to keep their order), and each lesson's page
// (for its PDF and video). Writes knowledge/ttrades/raw/<slug>.json and knowledge/ttrades/structure.json. Safe to run again.
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";

const SITE = "https://ttrades.com";
const OUT = path.resolve("knowledge/ttrades");
const RAW = path.join(OUT, "raw");
fs.mkdirSync(RAW, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, json = false, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (education-reader)" }, signal: AbortSignal.timeout(45_000) });
      if (r.ok) return json ? await r.json() : await r.text();
      if (r.status === 404) return null;
    } catch { /* retry */ }
    await sleep(800 * (i + 1));
  }
  throw new Error("could not load " + url);
}
const clean = t => t.replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
const slugOf = href => { try { return new URL(href, SITE).pathname.replace(/^\/|\/$/g, ""); } catch { return ""; } };

/** The lesson's body as ordered blocks: headings, paragraphs, list items, tables, images (with their alt/caption). */
function blocks(html) {
  const $ = cheerio.load(`<div id="root">${html}</div>`);
  const out = [];
  const seenImg = new Set();
  const walk = el => {
    $(el).contents().each((_, node) => {
      if (node.type !== "tag") return;
      const tag = node.name;
      const $n = $(node);
      if (/^h[1-6]$/.test(tag)) { const t = clean($n.text()); if (t) out.push({ t: "h", level: +tag[1], text: t }); return; }
      if (tag === "p") { const t = clean($n.text()); if (t) out.push({ t: "p", text: t }); $n.find("img").each((_, i) => img($(i))); return; }
      if (tag === "ul" || tag === "ol") { $n.children("li").each((i, li) => { const t = clean($(li).text()); if (t) out.push({ t: "li", text: (tag === "ol" ? `${i + 1}. ` : "- ") + t }); }); return; }
      if (tag === "blockquote") { const t = clean($n.text()); if (t) out.push({ t: "p", text: "> " + t }); return; }
      if (tag === "table") { const rows = $n.find("tr").map((_, tr) => $(tr).children("th,td").map((_, c) => clean($(c).text())).get().join(" | ")).get(); if (rows.length) out.push({ t: "table", text: rows.join("\n") }); return; }
      if (tag === "img") { img($n); return; }
      if (tag === "figure") { img($n.find("img").first(), clean($n.find("figcaption").text())); return; }
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "svg" || tag === "button" || tag === "form") return;
      walk(node);
    });
  };
  function img($i, caption = "") {
    const src = $i.attr("data-src") || $i.attr("data-lazy-src") || $i.attr("src");
    if (!src || src.startsWith("data:") || seenImg.has(src)) return;
    seenImg.add(src);
    out.push({ t: "img", src: new URL(src, SITE).href, alt: clean($i.attr("alt") || ""), caption });
  }
  walk($("#root")[0]);
  return out;
}

/** The page itself carries what the post body doesn't: the PDF handout, the YouTube video and the video's own description. */
function extras(page) {
  const $ = cheerio.load(page);
  const pdfs = [...new Set($("a[href$='.pdf'], a[href*='.pdf?']").map((_, a) => new URL($(a).attr("href"), SITE).href).get())];
  const ids = new Set();
  for (const m of page.matchAll(/(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([A-Za-z0-9_-]{11})/g)) ids.add(m[1]);
  const ld = (() => { try { return JSON.parse($("script[type='application/ld+json']").first().html() || "{}"); } catch { return {}; } })();
  const article = (ld["@graph"] || []).find(g => g["@type"] === "Article") || {};
  return { pdfs, videos: [...ids], description: $("meta[name='description']").attr("content") || "", keywords: article.keywords || [], section: article.articleSection || [] };
}

async function posts() {
  const all = [];
  for (let page = 1; ; page++) {
    const r = await fetch(`${SITE}/wp-json/wp/v2/posts?per_page=100&page=${page}&_fields=id,slug,link,title,date,modified,categories,content`, { headers: { "User-Agent": "Mozilla/5.0 (education-reader)" } });
    if (r.status === 400) break;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) break;
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

const cats = Object.fromEntries((await get(`${SITE}/wp-json/wp/v2/categories?per_page=100&_fields=id,name,slug`, true) ?? []).map(c => [c.id, c.name]));
console.log("categories:", Object.values(cats).join(", "));

// The four course pages, in the order the site lists their lessons.
const COURSES = [
  ["free-course", "Free Fractal Model Course"],
  ["ict-core-concepts", "ICT Core Concepts"],
  ["ict-advanced-concepts", "ICT Advanced Concepts"],
  ["ttfm", "Fractal Model (TTFM)"],
];
const structure = { source: `${SITE}/trading-education-center/`, fetched: new Date().toISOString(), courses: [], other: [] };
const order = new Map(); // slug -> [{ course, n }]
for (const [slug, name] of COURSES) {
  const html = await get(`${SITE}/trading-education-center/${slug}/`);
  const $ = cheerio.load(html);
  const intro = clean($(".elementor-widget-theme-post-content, main").first().text()).slice(0, 600);
  const seen = new Set(), lessons = [];
  $("a[href]").each((_, a) => {
    const href = new URL($(a).attr("href"), SITE);
    if (href.host !== "ttrades.com") return;
    const s = slugOf(href.href);
    if (!s || s.includes("/") || seen.has(s) || ["", "legal-center", "mentorship", "prop-firms", "fractal-model-indicator", "cart", "shop", "contact", "about", "login", "blog", "privacy-policy", "terms"].includes(s)) return;
    seen.add(s); lessons.push(s);
  });
  structure.courses.push({ slug, name, url: `${SITE}/trading-education-center/${slug}/`, intro, lessons });
  lessons.forEach((l, n) => { if (!order.has(l)) order.set(l, []); order.get(l).push({ course: name, n: n + 1 }); });
  console.log(`${name}: ${lessons.length} links`);
}

const rows = await posts();
console.log("posts from the API:", rows.length);
const bySlug = new Map(rows.map(r => [r.slug, r]));

// Course links that aren't posts (pages such as the indicator or prop-firm pages) are read as pages.
const wanted = new Set([...rows.map(r => r.slug), ...order.keys()]);
let n = 0;
for (const slug of wanted) {
  const file = path.join(RAW, slug + ".json");
  if (fs.existsSync(file)) { n++; continue; }
  const row = bySlug.get(slug) ?? (await get(`${SITE}/wp-json/wp/v2/pages?slug=${slug}&_fields=id,slug,link,title,date,modified,content`, true))?.[0];
  if (!row) { console.log("no content for", slug); continue; }
  const page = await get(row.link);
  const body = blocks(row.content.rendered);
  const lesson = {
    slug, id: row.id, url: row.link, title: cheerio.load(`<b>${row.title.rendered}</b>`)("b").text().trim(), date: row.date, modified: row.modified,
    categories: (row.categories ?? []).map(c => cats[c]).filter(Boolean),
    courses: order.get(slug) ?? [],
    ...(page ? extras(page) : { pdfs: [], videos: [] }),
    body,
  };
  fs.writeFileSync(file, JSON.stringify(lesson, null, 1));
  n++;
  if (n % 10 === 0) console.log(`  ${n}/${wanted.size} lessons`);
  await sleep(250);
}
for (const slug of wanted) if (!order.has(slug)) structure.other.push(slug);
fs.writeFileSync(path.join(OUT, "structure.json"), JSON.stringify(structure, null, 1));
const files = fs.readdirSync(RAW).filter(f => f.endsWith(".json"));
const stats = files.map(f => JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8")));
const words = stats.reduce((s, l) => s + l.body.filter(b => b.t !== "img").reduce((x, b) => x + b.text.split(/\s+/).length, 0), 0);
console.log(`done: ${files.length} lessons, ${stats.reduce((s, l) => s + l.body.filter(b => b.t === "img").length, 0)} images, ${stats.filter(l => l.pdfs.length).length} with a PDF, ${stats.filter(l => l.videos.length).length} with a video, ~${words} words`);
