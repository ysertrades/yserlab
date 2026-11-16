import { db } from "./store.js";

/**
 * Two live feeds for the app's Economic calendar page. The app is a static site and neither source allows browsers to read it, so the bot
 * copies them into public-read tables (written with the service key) and the app listens to those with Supabase Realtime:
 *  - `headlines`: FinancialJuice's public RSS, checked every few seconds; a new headline reaches the page a moment after it is published.
 *  - `trump_schedule`: Roll Call Factba.se's public White House schedule, checked every few minutes.
 * Neither ever throws; a failed round is simply tried again.
 */
const UA = { "User-Agent": "Mozilla/5.0 (compatible; YSERLab/1.0)" };
const decode = s => String(s ?? "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
const text = html => decode(html).replace(/<\/li>/gi, " · ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/( · )+$/, "").trim();

/* ── FinancialJuice ── */
const seen = new Set();
let juiceErr = null, juiceTrim = 0;
export async function pollJuice() {
  if (!db) return 0;
  try {
    const res = await fetch("https://www.financialjuice.com/feed.ashx?xy=rss", { headers: UA, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error("feed " + res.status);
    const xml = await res.text();
    const fresh = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const item = m[1];
      const pick = tag => item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "";
      const id = decode(pick("guid")).trim();
      if (!id || seen.has(id)) continue;
      const at = new Date(decode(pick("pubDate")));
      if (Number.isNaN(+at)) continue;
      const title = decode(pick("title")).replace(/^FinancialJuice:\s*/i, "").trim();
      if (!title) continue;
      fresh.push({ id, title, body: text(pick("description")).slice(0, 900) || null, at: at.toISOString() });
    }
    if (!fresh.length) return 0;
    const { error } = await db.from("headlines").upsert(fresh, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    for (const r of fresh) seen.add(r.id);
    if (Date.now() - juiceTrim > 3_600_000) { // keep two days
      juiceTrim = Date.now();
      await db.from("headlines").delete().lt("at", new Date(Date.now() - 2 * 86_400_000).toISOString());
    }
    juiceErr = null;
    return fresh.length;
  } catch (e) {
    if (e.message !== juiceErr) console.warn("headlines:", e.message);
    juiceErr = e.message;
    return 0;
  }
}

/* ── White House schedule ── */
const NY = "America/New_York";
const dayOf = ms => new Intl.DateTimeFormat("en-CA", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
/** The UTC moment of a New York wall-clock time on a date ("2026-11-16", "9:50 AM"); null when there is no clock time. */
function atNY(date, clock) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(clock ?? "");
  if (!m) return null;
  let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12;
  const [y, mo, d] = date.split("-").map(Number);
  // New York is 4 or 5 hours behind UTC; try both and keep the one that reads back as the same wall-clock time.
  for (const off of [4, 5]) {
    const t = Date.UTC(y, mo - 1, d, h + off, Number(m[2]));
    const back = new Intl.DateTimeFormat("en-GB", { timeZone: NY, hour: "2-digit", minute: "2-digit", hour12: false }).format(t);
    if (back === `${String(h).padStart(2, "0")}:${m[2]}`) return new Date(t).toISOString();
  }
  return null;
}
/** What kind of moment it is, from its words. */
export function kindOf(e) {
  const d = String(e.details ?? "").toLowerCase();
  if (e.tags?.golf || /golf/.test(d)) return "golf";
  if (e.tags?.political_rally || /rally/.test(d)) return "rally";
  if (e.type === "Briefing Schedule" || /briefing|press conference|press gaggle/.test(d)) return "briefing";
  if (/depart|arrive|en route|motorcade|lands|wheels/.test(d)) return "travel";
  if (/pool call|call time|lid\b/.test(d)) return "pool";
  if (/executive time|private|no public/.test(d)) return "private";
  if (/remarks|speaks|address|signs|signing|interview|delivers|participates in a (swearing|ceremony)|press|reporters|sprays?|attends|hosts|welcomes/.test(d)) return "public";
  if (/meeting|lunch|dinner|meets|call with|phone call|briefed|receives/.test(d)) return "meeting";
  return "other";
}
let trumpErr = null, trumpAt = 0;
export async function publishTrump({ force = false } = {}) {
  if (!db || (!force && Date.now() - trumpAt < 4 * 60_000)) return 0;
  trumpAt = Date.now();
  try {
    const res = await fetch("https://media-cdn.factba.se/rss/json/trump/calendar-full.json", { headers: UA, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error("schedule " + res.status);
    const all = await res.json();
    const days = [0, 1].map(i => dayOf(Date.now() + i * 86_400_000));
    const rows = [];
    const count = new Map();
    for (const e of all) {
      if (!days.includes(e.date)) continue;
      const base = `${e.date}|${e.time_formatted ?? ""}|${e.details}`;
      const n = (count.get(base) ?? 0) + 1; count.set(base, n);
      rows.push({
        id: `${e.date}-${Buffer.from(base).toString("base64url").slice(-24)}-${n}`, day: e.date,
        clock: e.time_formatted || null, at: atNY(e.date, e.time_formatted), kind: kindOf(e),
        details: String(e.details ?? "").slice(0, 400), place: e.location || null, source: e.type || null, coverage: e.coverage || null,
        updated_at: new Date().toISOString(),
      });
    }
    if (rows.length) {
      const { error } = await db.from("trump_schedule").upsert(rows, { onConflict: "id" });
      if (error) throw new Error(error.message);
    }
    // Anything the schedule dropped for these days goes too, and old days are cleared.
    const keep = new Set(rows.map(r => r.id));
    const { data: have } = await db.from("trump_schedule").select("id,day").gte("day", days[0]);
    const gone = (have ?? []).filter(r => days.includes(r.day) && !keep.has(r.id)).map(r => r.id);
    if (gone.length) await db.from("trump_schedule").delete().in("id", gone);
    await db.from("trump_schedule").delete().lt("day", dayOf(Date.now() - 86_400_000));
    trumpErr = null;
    return rows.length;
  } catch (e) {
    if (e.message !== trumpErr) console.warn("trump:", e.message);
    trumpErr = e.message; trumpAt = Date.now() - 4 * 60_000 + 60_000; // again in a minute
    return 0;
  }
}
