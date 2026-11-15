import { DateTime } from "luxon";
import { ZONE } from "./calendar/feed.js";
import { entries, settings, once, log } from "./store.js";
import { deliver, picturePost } from "./post.js";
import { svgToPng, fonts } from "./render.js";

/**
 * The daily, weekly and monthly cards. The weekly and monthly ones are drawn by the app's own card code (the calendar's share panel),
 * so they match it exactly, with the style chosen in the control panel. The daily card is the day's trades on one flat card.
 */
const C = { bg: "#111112", s1: "#161618", s2: "#1b1b1d", line: "rgba(255,255,255,.08)", text: "#f2f2f3", soft: "#c9c9cd", muted: "#8e8e94", faint: "#5d5d63", accent: "#8d9bff", up: "#3ccf7a", down: "#f06b6b" };
const SANS = "Inter, sans-serif", MONO = "'Geist Mono', monospace", SERIF = "'Instrument Serif', serif";
const MARK = ["M16.01 24.58Q14.00 20.00 19.00 20.00L30.85 20.00Q35.85 20.00 37.86 24.58L46.99 45.42Q49.00 50.00 44.00 50.00L32.15 50.00Q27.15 50.00 25.14 45.42Z", "M62.14 15.58Q64.15 11.00 69.15 11.00L81.00 11.00Q86.00 11.00 83.99 15.58L74.86 36.42Q72.85 41.00 67.85 41.00L56.00 41.00Q51.00 41.00 53.01 36.42Z", "M40.00 61.00Q40.00 56.00 45.00 56.00L55.00 56.00Q60.00 56.00 60.00 61.00L60.00 87.00Q60.00 92.00 55.00 92.00L45.00 92.00Q40.00 92.00 40.00 87.00Z"];
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = n => `${n < 0 ? "−" : n > 0 ? "+" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const nowNY = () => DateTime.now().setZone(ZONE);

const result = e => e.pnl ?? (e.r_multiple ?? 0);
export const isWin = e => (e.pnl ?? e.r_multiple ?? 0) > 0;
export const isLoss = e => (e.pnl ?? e.r_multiple ?? 0) < 0;

export function dailySvg(list, day) {
  const w = 1200, rowH = 78, shown = list.slice(0, 8), top = 380, h = top + shown.length * rowH + 150;
  const pnl = list.reduce((s, e) => s + (e.pnl ?? 0), 0), r = list.reduce((s, e) => s + (e.r_multiple ?? 0), 0);
  const wins = list.filter(isWin).length, losses = list.filter(isLoss).length;
  const tone = pnl > 0 ? C.up : pnl < 0 ? C.down : C.muted;
  let rows = "";
  shown.forEach((e, i) => {
    const y = top + i * rowH, v = result(e), c = v > 0 ? C.up : v < 0 ? C.down : C.muted;
    rows += `<rect x="64" y="${y}" width="${w - 128}" height="${rowH - 10}" rx="16" fill="${C.s1}" stroke="${C.line}"/>
      <rect x="64" y="${y}" width="6" height="${rowH - 10}" rx="3" fill="${c}"/>
      <text x="100" y="${y + 44}" font-family="${SANS}" font-weight="700" font-size="28" fill="${C.text}">${esc((e.instrument ?? "—") + (e.direction ? "  " + e.direction.toUpperCase() : ""))}</text>
      <text x="${w - 100}" y="${y + 44}" text-anchor="end" font-family="${MONO}" font-size="28" fill="${c}">${e.pnl != null ? money(e.pnl) : ""}${e.r_multiple != null ? `   ${e.r_multiple > 0 ? "+" : ""}${Number(e.r_multiple).toFixed(2)}R` : ""}</text>`;
  });
  const more = list.length - shown.length;
  return { w, h, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${C.bg}"/>
    <g transform="translate(64 56) scale(.54)" fill="${C.text}">${MARK.map(d => `<path d="${d}"/>`).join("")}</g>
    <text x="132" y="86" font-family="${SANS}" font-weight="800" font-size="26" letter-spacing="3" fill="${C.text}">YSER TRADES</text>
    <text x="${w - 64}" y="86" text-anchor="end" font-family="${MONO}" font-size="22" fill="${C.muted}">${esc(day.toFormat("cccc d LLL yyyy"))}</text>
    <text x="64" y="190" font-family="${MONO}" font-size="22" letter-spacing="4" fill="${C.accent}">DAILY CARD</text>
    <text x="64" y="300" font-family="${SANS}" font-weight="800" font-size="104" fill="${tone}">${esc(money(pnl))}</text>
    <text x="64" y="352" font-family="${SERIF}" font-style="italic" font-size="38" fill="${C.soft}">${list.length} trade${list.length === 1 ? "" : "s"} · ${wins} win${wins === 1 ? "" : "s"} · ${losses} loss${losses === 1 ? "" : "es"}${r ? ` · ${r > 0 ? "+" : ""}${r.toFixed(2)}R` : ""}</text>
    ${rows}${more > 0 ? `<text x="${w / 2}" y="${top + shown.length * rowH + 40}" text-anchor="middle" font-family="${MONO}" font-size="22" fill="${C.muted}">+ ${more} more</text>` : ""}
  </svg>` };
}

export async function cardSvg(kind, rows, config, anchor = nowNY()) {
  const { weekData, monthData, shareSvg, DEFAULT_SHARE, keyOf } = await import("../vendor/shareCards.mjs");
  const when = new Date(anchor.year, anchor.month - 1, anchor.day);
  if (kind === "daily") return dailySvg(rows.filter(e => e.trade_date === anchor.toISODate()), anchor);
  const style = { ...DEFAULT_SHARE, ...(config.cards.style?.[kind === "weekly" ? "week" : "month"] ?? {}), kind: kind === "weekly" ? "week" : "month" };
  const week = weekData(rows, when), month = monthData(rows, when.getFullYear(), when.getMonth());
  void keyOf;
  return shareSvg(style.kind, week, month, style);
}

const lastWeekdayOfMonth = d => { let x = d.endOf("month").startOf("day"); while (x.weekday > 5) x = x.minus({ days: 1 }); return x; };

async function post(client, kind, { force = false } = {}) {
  fonts();
  const { config, owner } = await settings();
  const spec = config.cards[kind];
  const rows = await entries(owner);
  const day = nowNY();
  if (kind === "daily" && !rows.some(e => e.trade_date === day.toISODate())) { if (force) await log(`cards.${kind}`, { note: "no trades today: nothing posted" }); return 0; }
  const card = await cardSvg(kind, rows, config, day);
  const png = svgToPng(card.svg, kind === "daily" ? 1200 : 1600);
  const name = { daily: "daily-card", weekly: "weekly-card", monthly: "monthly-card" }[kind];
  return deliver(client, spec.channels, () => picturePost({ png, name: `${name}.png`, accent: "accent" }), `cards.${kind}`);
}
export const postCard = post;

/** Called every few seconds: sends the card whose time has come, once. */
export async function checkCards(client) {
  const { config } = await settings();
  const now = nowNY(), c = config.cards;
  const due = hhmm => { const [h, m] = String(hhmm).split(":").map(Number); const d = now.diff(now.set({ hour: h, minute: m, second: 0, millisecond: 0 }), "minutes").minutes; return d >= 0 && d < 10; };
  const key = n => `${n}:${now.toISODate()}`;
  if (c.daily.on && now.weekday <= 5 && due(c.daily.time) && await once(key("card-daily"))) await post(client, "daily");
  if (c.weekly.on && now.weekday === Number(c.weekly.day) && due(c.weekly.time) && await once(key("card-weekly"))) await post(client, "weekly");
  if (c.monthly.on && now.hasSame(lastWeekdayOfMonth(now), "day") && due(c.monthly.time) && await once(key("card-monthly"))) await post(client, "monthly");
}
