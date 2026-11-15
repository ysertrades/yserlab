import { DateTime } from "luxon";

/**
 * The economic calendar. The feed gives every release with an exact moment (a timestamp carrying its own UTC offset), so the time
 * on a visual is worked out from that instant in New York time with the zone's own rules: when the US or Canada moves the clocks, the
 * times follow by themselves and are labelled EST or EDT to match. Nothing here is a fixed offset.
 */
export const ZONE = "America/New_York";
const URLS = ["https://nfs.faireconomy.media/ff_calendar_thisweek.json", "https://nfs.faireconomy.media/ff_calendar_nextweek.json"];
const REFRESH = 20 * 60_000;

let cache = { events: [], at: 0, ok: false, error: null };

const norm = raw => {
  const at = DateTime.fromISO(raw.date, { setZone: true });
  if (!at.isValid) return null;
  const when = at.setZone(ZONE);
  const impact = String(raw.impact ?? "").trim();
  return {
    id: `${raw.country}|${raw.title}|${at.toUTC().toISO()}`,
    title: String(raw.title ?? "").trim(),
    currency: String(raw.country ?? "").trim().toUpperCase(),
    impact: ["High", "Medium", "Low"].includes(impact) ? impact : impact === "Holiday" ? "Holiday" : "Low",
    forecast: raw.forecast || "", previous: raw.previous || "",
    at: when,
    /** A release with no set time (all-day, tentative) sits at midnight and is shown as such. */
    allDay: /all day|tentative/i.test(String(raw.time ?? "")) || (when.hour === 0 && when.minute === 0 && raw.impact === "Holiday"),
  };
};

async function fetchOne(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (yserlab)" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${response.status}`);
  const data = await response.json();
  return Array.isArray(data) ? data.map(norm).filter(Boolean) : [];
}

/** All known releases. Re-fetched at most every 20 minutes; if the feed is down the last good copy is kept. */
export async function events(force = false) {
  if (!force && Date.now() - cache.at < REFRESH && cache.events.length) return cache.events;
  const results = await Promise.allSettled(URLS.map(fetchOne));
  const got = results.filter(r => r.status === "fulfilled").flatMap(r => r.value);
  if (got.length) {
    const seen = new Map(got.map(e => [e.id, e]));
    cache = { events: [...seen.values()].sort((a, b) => a.at.toMillis() - b.at.toMillis()), at: Date.now(), ok: true, error: null };
  } else {
    cache = { ...cache, at: Date.now() - REFRESH + 2 * 60_000, ok: false, error: results.find(r => r.status === "rejected")?.reason?.message ?? "no data" }; // try again in 2 minutes
  }
  return cache.events;
}
export const feedState = () => ({ ok: cache.ok, error: cache.error, at: cache.at, count: cache.events.length });

export function pick(list, config) {
  const impacts = new Set(config.impact?.length ? config.impact : ["High", "Medium"]);
  const currencies = new Set((config.currencies ?? []).map(c => c.toUpperCase()));
  return list.filter(e => e.impact !== "Holiday" ? impacts.has(e.impact) : false).filter(e => !currencies.size || currencies.has(e.currency));
}
export const onDay = (list, day) => list.filter(e => e.at.hasSame(day, "day"));
export const zoneName = at => at.toFormat("ZZZZ"); // EST or EDT
