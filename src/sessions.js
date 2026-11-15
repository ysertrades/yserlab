import { DateTime } from "luxon";
import { ZONE, events, pick, onDay, zoneName } from "./calendar/feed.js";
import { settings, once } from "./store.js";
import { deliver, textPost } from "./post.js";
import { mentions } from "./access.js";

/**
 * Session alerts: "New York open in 15 minutes", with the day's high-impact news attached so you know what you're walking into.
 * Each item has a time in New York time (the clock follows daylight saving by itself), the days it runs, and a note of your own
 * (your levels or bias).
 */
export async function checkSessions(client) {
  const { config } = await settings();
  const s = config.sessions;
  if (!s.on) return;
  const now = DateTime.now().setZone(ZONE);
  for (const item of s.items ?? []) {
    if (!(item.days ?? [1, 2, 3, 4, 5]).includes(now.weekday)) continue;
    const [h, m] = String(item.time || "09:30").split(":").map(Number);
    const start = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
    const ahead = start.diff(now, "seconds").seconds, lead = Math.max(0, Number(item.before ?? 15)) * 60;
    if (!(ahead <= lead && ahead > lead - 180 && ahead > 0)) continue;
    if (!(await once(`session:${item.name}:${now.toISODate()}:${item.time}`))) continue;
    const news = onDay(pick(await events(), { ...config.news, impact: ["High"] }), now).filter(e => !e.allDay && e.at >= start.minus({ hours: 1 }) && e.at <= start.plus({ hours: 4 }));
    const lines = [`${mentions(config, s.tag)} **${item.name}** in ${Math.round(lead / 60)} minute${lead === 60 ? "" : "s"} · ${start.toFormat("h:mm a")} ${zoneName(start)}`];
    if (item.note) lines.push(`> ${String(item.note).replace(/\n/g, "\n> ")}`);
    if (news.length) lines.push(`High-impact news around it:\n${news.slice(0, 5).map(e => `• ${e.at.toFormat("h:mm a")} ${e.currency} ${e.title}`).join("\n")}`);
    await deliver(client, s.channels, () => textPost({ text: lines.join("\n"), accent: "amber" }), "session");
  }
}
