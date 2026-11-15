import { entries, settings, once, wasDone, log } from "./store.js";
import { deliver, picturePost } from "./post.js";
import { svgToPng, fonts } from "./render.js";
import { mentions } from "./access.js";
import { isWin, isLoss } from "./cards.js";

/** Streaks, win rates and personal bests, worked out from your trades. They are announced once each; the first run only notes what you already have, so nothing old is announced. */
const C = { bg: "#111112", s1: "#161618", line: "rgba(255,255,255,.08)", text: "#f2f2f3", soft: "#c9c9cd", muted: "#8e8e94", accent: "#8d9bff", up: "#3ccf7a" };
const MARK = ["M16.01 24.58Q14.00 20.00 19.00 20.00L30.85 20.00Q35.85 20.00 37.86 24.58L46.99 45.42Q49.00 50.00 44.00 50.00L32.15 50.00Q27.15 50.00 25.14 45.42Z", "M62.14 15.58Q64.15 11.00 69.15 11.00L81.00 11.00Q86.00 11.00 83.99 15.58L74.86 36.42Q72.85 41.00 67.85 41.00L56.00 41.00Q51.00 41.00 53.01 36.42Z", "M40.00 61.00Q40.00 56.00 45.00 56.00L55.00 56.00Q60.00 56.00 60.00 61.00L60.00 87.00Q60.00 92.00 55.00 92.00L45.00 92.00Q40.00 92.00 40.00 87.00Z"];
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

function badge({ kicker, big, line }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="${C.bg}"/>
  <rect x="40" y="40" width="1120" height="550" rx="36" fill="${C.s1}" stroke="${C.up}" stroke-opacity=".55" stroke-width="2"/>
  <g transform="translate(84 84) scale(.5)" fill="${C.text}">${MARK.map(d => `<path d="${d}"/>`).join("")}</g>
  <text x="148" y="116" font-family="Inter, sans-serif" font-weight="800" font-size="24" letter-spacing="3" fill="${C.text}">YSER LAB</text>
  <text x="84" y="230" font-family="'Geist Mono', monospace" font-size="24" letter-spacing="5" fill="${C.up}">${esc(kicker)}</text>
  <text x="84" y="400" font-family="Inter, sans-serif" font-weight="800" font-size="190" fill="${C.text}">${esc(big)}</text>
  <text x="84" y="486" font-family="'Instrument Serif', serif" font-style="italic" font-size="46" fill="${C.soft}">${esc(line)}</text></svg>`;
}

const order = (a, b) => (a.trade_date + (a.traded_at ?? a.created_at)).localeCompare(b.trade_date + (b.traded_at ?? b.created_at));

export function find(rows, config) {
  const list = [...rows].filter(e => e.pnl != null || e.r_multiple != null).sort(order);
  const out = [];
  if (!list.length) return out;
  // Win streak now: the last N trades are all wins.
  let n = 0;
  for (let i = list.length - 1; i >= 0 && isWin(list[i]); i--) n++;
  const startId = list[list.length - n]?.id;
  for (const t of config.milestones.streaks ?? []) if (n >= t && startId) out.push({ key: `ms:streak:${t}:${startId}`, kicker: "WIN STREAK", big: `${t}`, line: `${t} winning trades in a row`, text: `**${t} wins in a row.** The streak is on.` });
  // This month's win rate (at least 10 trades, so it means something).
  const month = list[list.length - 1].trade_date.slice(0, 7);
  const inMonth = list.filter(e => e.trade_date.startsWith(month));
  if (inMonth.length >= 10) {
    const rate = Math.round(100 * inMonth.filter(isWin).length / inMonth.filter(e => isWin(e) || isLoss(e)).length);
    for (const t of config.milestones.winRates ?? []) if (rate >= t) out.push({ key: `ms:wr:${t}:${month}`, kicker: "WIN RATE", big: `${t}%`, line: `${rate}% this month over ${inMonth.length} trades`, text: `**Win rate above ${t}%** this month: ${rate}% over ${inMonth.length} trades.` });
  }
  if (config.milestones.personalBests && list.length >= 10) {
    const days = new Map();
    for (const e of list) days.set(e.trade_date, (days.get(e.trade_date) ?? 0) + (e.pnl ?? 0));
    const [bestDay, bestPnl] = [...days.entries()].sort((a, b) => b[1] - a[1])[0];
    const last = list[list.length - 1].trade_date;
    if (days.size >= 5 && bestDay === last && bestPnl > 0) out.push({ key: `ms:pbday:${bestDay}`, kicker: "PERSONAL BEST", big: `+$${Math.round(bestPnl).toLocaleString("en-US")}`, line: "Your best day so far", text: `**New personal best day: +$${Math.round(bestPnl).toLocaleString("en-US")}.**` });
    const bestR = [...list].filter(e => e.r_multiple != null).sort((a, b) => b.r_multiple - a.r_multiple)[0];
    if (bestR && bestR.r_multiple > 0 && list[list.length - 1].id === bestR.id) out.push({ key: `ms:pbr:${bestR.id}`, kicker: "PERSONAL BEST", big: `+${Number(bestR.r_multiple).toFixed(2)}R`, line: `Your best trade so far${bestR.instrument ? ` · ${bestR.instrument}` : ""}`, text: `**New personal best trade: +${Number(bestR.r_multiple).toFixed(2)}R.**` });
  }
  return out;
}

export async function checkMilestones(client) {
  const { config, owner } = await settings();
  if (!config.milestones.on || !owner) return;
  const found = find(await entries(owner), config);
  const first = !(await wasDone("ms:init"));
  for (const m of found) {
    if (first) { await once(m.key); continue; } // what you already had: noted silently
    if (!(await once(m.key))) continue;
    fonts();
    const png = svgToPng(badge(m), 1200);
    await deliver(client, config.milestones.channels, () => picturePost({ text: `${mentions(config, true)} ${m.text}`, png, name: "milestone.png", accent: "up" }), "milestone");
  }
  if (first) { await once("ms:init"); await log("milestone", { note: `started: ${found.length} existing milestone(s) noted, only new ones will be posted` }); }
}
