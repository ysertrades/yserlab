// Renders sample pictures to a folder so they can be looked at: node scripts/preview.js <outdir>
import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { events, ZONE } from "../src/calendar/feed.js";
import { dayCard, alertCard, weekCard } from "../src/calendar/visuals.js";
import { svgToPng, fonts, tradeCardPng } from "../src/render.js";
import { cardSvg, dailySvg } from "../src/cards.js";
import { DEFAULTS } from "../src/config.js";

const out = process.argv[2] ?? "preview";
fs.mkdirSync(out, { recursive: true });
fonts();
const all = await events(true);
console.log("feed events:", all.length);
const mk = (t, cur, impact, f, p) => ({ id: t + cur, title: t, currency: cur, impact, forecast: f, previous: p, at: DateTime.now().setZone(ZONE).startOf("day").plus({ hours: 8, minutes: 30 }), allDay: false });
const sample = [mk("Non-Farm Employment Change", "USD", "High", "185K", "254K"), mk("Unemployment Rate", "USD", "High", "4.1%", "4.1%"), mk("Average Hourly Earnings m/m", "USD", "Medium", "0.3%", "0.4%"), mk("Employment Change", "CAD", "Medium", "20.1K", "14.5K")];
sample.push({ ...mk("ISM Services PMI", "USD", "Medium", "53.5", "52.1"), at: sample[0].at.plus({ hours: 1, minutes: 30 }) });
const real = all.filter(e => e.impact === "High" || e.impact === "Medium");
const day = real.length ? real[0].at.startOf("day") : DateTime.now().setZone(ZONE);
const dayList = real.filter(e => e.at.hasSame(day, "day")).slice(0, 12);
const use = dayList.length ? dayList : sample;
fs.writeFileSync(path.join(out, "news-day.png"), svgToPng(dayCard(use, day, { title: "Today," }).svg, 1400));
fs.writeFileSync(path.join(out, "news-alert-15.png"), svgToPng(alertCard(use.slice(0, 3), { minutes: 15 }).svg, 1400));
fs.writeFileSync(path.join(out, "news-alert-now.png"), svgToPng(alertCard(use.slice(0, 2), { now: true }).svg, 1400));
const monday = DateTime.now().setZone(ZONE).startOf("week").plus({ days: DateTime.now().setZone(ZONE).weekday === 7 ? 7 : 0 });
fs.writeFileSync(path.join(out, "news-week.png"), svgToPng(weekCard(real.length ? real : sample, monday).svg, 1800));

// Fake trades for the cards.
const rows = [];
const base = DateTime.now().setZone(ZONE).startOf("month");
for (let i = 0; i < 24; i++) {
  const d = base.plus({ days: Math.floor(i * 1.2) });
  if (d.weekday > 5 || d > DateTime.now()) continue;
  const win = i % 3 !== 0;
  rows.push({ id: `t${i}`, trade_date: d.toISODate(), traded_at: d.toISO(), created_at: d.toISO(), instrument: ["NQ", "ES", "YM"][i % 3], direction: i % 2 ? "long" : "short", pnl: win ? 400 + i * 20 : -250, r_multiple: win ? 2.1 : -1, levels: { entry: 100, stop: 95, target: 110, exit: win ? 110 : 95 }, session: "NY", title: "Sample trade", blocks: [], tag_ids: [] });
}
const cfg = DEFAULTS;
const today = DateTime.now().setZone(ZONE);
for (const k of ["weekly", "monthly"]) { const c = await cardSvg(k, rows, cfg, today); fs.writeFileSync(path.join(out, `card-${k}.png`), svgToPng(c.svg, 1600)); }
const dayRows = rows.length ? rows.filter(e => e.trade_date === rows[rows.length - 1].trade_date) : [];
fs.writeFileSync(path.join(out, "card-daily.png"), svgToPng(dailySvg(dayRows, DateTime.fromISO(rows[rows.length - 1].trade_date)).svg, 1200));
fs.writeFileSync(path.join(out, "trade-card.png"), await tradeCardPng(rows[rows.length - 1], null, {}));
console.log("done", fs.readdirSync(out));
