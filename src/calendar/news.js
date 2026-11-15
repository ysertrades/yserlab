import { DateTime } from "luxon";
import { events, pick, onDay, zoneName, ZONE } from "./feed.js";
import { dayCard, alertCard, weekCard } from "./visuals.js";
import { publishCalendar } from "./publish.js";
import { svgToPng, fonts } from "../render.js";
import { deliver, picturePost } from "../post.js";
import { mentions } from "../access.js";
import { once, settings, log } from "../store.js";

const nowNY = () => DateTime.now().setZone(ZONE);
const at = (day, hhmm) => { const [h, m] = String(hhmm || "00:00").split(":").map(Number); return day.set({ hour: h || 0, minute: m || 0, second: 0, millisecond: 0 }); };

/** Today's news, posted in the morning. Nothing is posted when the day has none. */
export async function postToday(client, config, { force = false } = {}) {
  fonts();
  const list = onDay(pick(await events(), config.news), nowNY());
  if (!list.length) { if (force) await log("news.today", { note: "no news today: nothing posted" }); return 0; }
  const card = dayCard(list, nowNY(), { kicker: "ECONOMIC CALENDAR", title: "Today," });
  const png = svgToPng(card.svg, 1400);
  const high = list.filter(e => e.impact === "High").length;
  return deliver(client, config.news.today.channels, () => picturePost({ text: `**Today's news** · ${list.length} release${list.length === 1 ? "" : "s"}${high ? `, ${high} high impact` : ""}`, png, name: "news-today.png", footer: `Times in ${zoneName(nowNY())}` }), "news.today");
}

/** Tomorrow's news at the market open (Mon-Thu). Skipped when there are none. */
export async function postTomorrow(client, config, { force = false } = {}) {
  fonts();
  const day = nowNY().plus({ days: 1 });
  const list = onDay(pick(await events(), config.news), day);
  if (!list.length) { if (force) await log("news.open", { note: "no news tomorrow: nothing posted" }); return 0; }
  const card = dayCard(list, day, { kicker: "MARKET OPEN  ·  NEXT DAY", title: "Tomorrow," });
  const png = svgToPng(card.svg, 1400);
  const high = list.filter(e => e.impact === "High").length;
  return deliver(client, config.news.open.channels, () => picturePost({ text: `**Tomorrow, ${day.toFormat("cccc d LLL")}** · ${list.length} release${list.length === 1 ? "" : "s"}${high ? `, ${high} high impact` : ""}`, png, name: "news-tomorrow.png", footer: `Times in ${zoneName(day)}` }), "news.open");
}

/** The week ahead, every Sunday. */
export async function postWeek(client, config, { force = false } = {}) {
  fonts();
  const today = nowNY();
  const monday = today.startOf("week").plus({ days: today.weekday === 7 ? 7 : 0 }); // Luxon weeks start on Monday; Sunday looks ahead
  const list = pick(await events(), config.news).filter(e => e.at >= monday.startOf("day") && e.at < monday.plus({ days: 5 }).startOf("day"));
  if (!list.length) { if (force) await log("news.weekly", { note: "no news for the week: nothing posted" }); return 0; }
  const card = weekCard(list, monday);
  const png = svgToPng(card.svg, 1800);
  return deliver(client, config.news.weekly.channels, () => picturePost({ text: `${mentions(config, config.news.alerts.tag)} **The week ahead** · ${monday.toFormat("d LLL")} – ${monday.plus({ days: 4 }).toFormat("d LLL")}`, png, name: "news-week.png", footer: `Times in ${zoneName(monday)}` }), "news.weekly");
}

/**
 * Heads-ups and release posts. Releases that happen at the same moment are grouped into one picture. The schedule is computed from the
 * freshest copy of the feed each time, so if a release is moved the alert moves with it.
 */
export async function checkAlerts(client, config) {
  const a = config.news.alerts;
  if (!a.on) return;
  const list = pick(await events(), config.news);
  const now = nowNY();
  const groups = new Map();
  for (const e of list) { if (e.allDay) continue; const k = e.at.toUTC().toISO(); (groups.get(k) ?? groups.set(k, []).get(k)).push(e); }
  for (const [k, group] of groups) {
    const t = DateTime.fromISO(k).setZone(ZONE);
    const ahead = t.diff(now, "seconds").seconds;
    const before = Math.max(1, Number(a.before) || 15) * 60;
    if (ahead <= before && ahead > before - 180 && ahead > 60) {
      if (!(await once(`alert-before:${k}:${before}`))) continue;
      fonts();
      const png = svgToPng(alertCard(group, { minutes: before / 60 }).svg, 1400);
      await deliver(client, a.channels, () => picturePost({ text: `${mentions(config, a.tag)} **${group[0].title}${group.length > 1 ? ` and ${group.length - 1} more` : ""}** in ${before / 60} minutes`, png, name: "news-soon.png", accent: "amber" }), "news.alert");
    }
    if (a.atRelease && ahead <= 0 && ahead > -120) {
      if (!(await once(`alert-now:${k}`))) continue;
      fonts();
      const png = svgToPng(alertCard(group, { now: true }).svg, 1400);
      await deliver(client, a.channels, () => picturePost({ text: `${mentions(config, a.tag)} **${group[0].title}${group.length > 1 ? ` and ${group.length - 1} more` : ""}** is out now · ${t.toFormat("h:mm:ss a")} ${zoneName(t)}`, png, name: "news-now.png", accent: "down" }), "news.release");
    }
  }
}

/** Scheduled posts: each fires once, within ten minutes after its time (so a restart doesn't lose it). */
export async function checkSchedule(client) {
  void publishCalendar(); // the app's Economic calendar page reads the same feed from a table; this refreshes it (at most every 20 minutes)
  const { config } = await settings();
  const now = nowNY(), n = config.news;
  const due = (hhmm) => { const d = now.diff(at(now, hhmm), "minutes").minutes; return d >= 0 && d < 10; };
  const key = name => `${name}:${now.toISODate()}`;
  if (n.today.on && now.weekday <= 5 && due(n.today.time) && await once(key("news-today"))) await postToday(client, config);
  if (n.open.on && now.weekday <= 4 && due(n.open.time) && await once(key("news-open"))) await postTomorrow(client, config);
  if (n.weekly.on && now.weekday === 7 && due(n.weekly.time) && await once(key("news-week"))) await postWeek(client, config);
}
