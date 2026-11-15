import { events } from "./feed.js";
import { db } from "../store.js";

/**
 * The economic calendar for the app. The app is a static site and the feed has no CORS, so the bot, which already keeps the feed, copies it into
 * the table `economic_events` (public to read, written only with the bot's service key) and the app's Economic calendar page reads that.
 * Runs from the bot's schedule tick; it does real work at most every 20 minutes, and never throws.
 */
const EVERY = 20 * 60_000;
let last = 0, busy = false, lastError = null;

export async function publishCalendar({ force = false } = {}) {
  if (!db || busy || (!force && Date.now() - last < EVERY)) return 0;
  busy = true;
  try {
    const list = (await events()).filter(e => e.impact !== "Holiday");
    if (!list.length) return 0;
    const rows = list.map(e => ({ id: e.id, title: e.title, currency: e.currency, impact: e.impact, forecast: e.forecast || null, previous: e.previous || null, at: e.at.toUTC().toISO(), all_day: !!e.allDay, updated_at: new Date().toISOString() }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await db.from("economic_events").upsert(rows.slice(i, i + 200), { onConflict: "id" });
      if (error) throw new Error(error.message);
    }
    // Anything older than two weeks is of no use to the page.
    await db.from("economic_events").delete().lt("at", new Date(Date.now() - 14 * 86400_000).toISOString());
    last = Date.now(); lastError = null;
    return rows.length;
  } catch (e) {
    lastError = e.message; last = Date.now() - EVERY + 2 * 60_000; // try again in two minutes
    return 0;
  } finally { busy = false; }
}
export const publishState = () => ({ at: last, error: lastError });
