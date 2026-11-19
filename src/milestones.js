import { entries, settings, once, wasDone, log } from "./store.js";
import { deliver, picturePost } from "./post.js";
import { svgToPng, fonts } from "./render.js";
import { mentions } from "./access.js";
import { isWin, isLoss } from "./cards.js";

/** Streaks, win rates and personal bests, worked out from your trades. They are announced once each; the first run only notes what you already have, so nothing old is announced. */
const C = { bg: "#111112", s1: "#161618", line: "rgba(255,255,255,.08)", text: "#f2f2f3", soft: "#c9c9cd", muted: "#8e8e94", accent: "#8d9bff", up: "#3ccf7a" };
const MARK = ["M16.01 24.58Q14.00 20.00 19.00 20.00L30.85 20.00Q35.85 20.00 37.86 24.58L46.99 45.42Q49.00 50.00 44.00 50.00L32.15 50.00Q27.15 50.00 25.14 45.42Z", "M62.14 15.58Q64.15 11.00 69.15 11.00L81.00 11.00Q86.00 11.00 83.99 15.58L74.86 36.42Q72.85 41.00 67.85 41.00L56.00 41.00Q51.00 41.00 53.01 36.42Z", "M40.00 61.00Q40.00 56.00 45.00 56.00L55.00 56.00Q60.00 56.00 60.00 61.00L60.00 87.00Q60.00 92.00 55.00 92.00L45.00 92.00Q40.00 92.00 40.00 87.00Z"];
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** The right half of a card: a picture of the milestone itself. Streak: that many candles climbing; win rate: a ring; personal best: a climbing line past the old level. Flat shapes, no glow. */
function art({ kind, n, rate }) {
  const X0 = 640, X1 = 1112, BASE = 496, TOP = 150;
  const faint = `<g stroke="${C.line}" stroke-width="2">${[0, 1, 2, 3].map(i => `<line x1="${X0}" y1="${BASE - i * 112}" x2="${X1}" y2="${BASE - i * 112}"/>`).join("")}</g>`;
  if (kind === "streak") {
    const count = Math.max(1, Math.min(12, n)), gap = count > 8 ? 10 : 16, w = Math.min(count < 5 ? 88 : 56, (X1 - X0 - (count - 1) * gap) / count), off = (X1 - X0 - (count * w + (count - 1) * gap)) / 2;
    const wob = [0, 14, -8, 22, -4, 18, -10, 24, 0, 16, -6, 20];
    const bars = Array.from({ length: count }, (_, i) => {
      const x = X0 + off + i * (w + gap), h = 84 + (count > 1 ? i / (count - 1) : 1) * (BASE - TOP - 150) + (i === count - 1 ? 0 : wob[i % 12]), y = BASE - h, last = i === count - 1;
      return { x, y, h, w, cx: x + w / 2, last, i };
    });
    return `${faint}
    <polyline points="${bars.map(b => `${b.cx},${b.y - 26}`).join(" ")}" fill="none" stroke="${C.accent}" stroke-width="3" stroke-dasharray="2 10" stroke-linecap="round"/>
    ${bars.map(b => `<line x1="${b.cx}" y1="${b.y - 22}" x2="${b.cx}" y2="${BASE + 8}" stroke="${C.up}" stroke-opacity="${b.last ? 1 : .45}" stroke-width="3" stroke-linecap="round"/>
    <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="9" fill="${C.up}" fill-opacity="${b.last ? 1 : .32}"/>
    <text x="${b.cx}" y="${BASE + 44}" text-anchor="middle" font-family="'Geist Mono', monospace" font-size="17" fill="${b.last ? C.text : C.muted}">${b.i + 1}</text>`).join("")}
    <circle cx="${bars[count - 1].cx}" cy="${bars[count - 1].y - 26}" r="9" fill="${C.accent}"/>
    <line x1="${X0}" y1="${BASE + 12}" x2="${X1}" y2="${BASE + 12}" stroke="${C.line}" stroke-width="2"/>`;
  }
  if (kind === "rate") {
    const cx = 876, cy = 320, r = 150, circ = 2 * Math.PI * r, p = Math.max(0, Math.min(100, rate)) / 100;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.line}" stroke-width="30"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.up}" stroke-width="30" stroke-linecap="round" stroke-dasharray="${(circ * p).toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>
    ${Array.from({ length: 10 }, (_, i) => { const a = (i / 10) * 2 * Math.PI - Math.PI / 2, x1 = cx + Math.cos(a) * (r + 34), y1 = cy + Math.sin(a) * (r + 34), x2 = cx + Math.cos(a) * (r + 46), y2 = cy + Math.sin(a) * (r + 46); return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${i / 10 <= p ? C.up : C.muted}" stroke-opacity=".6" stroke-width="4" stroke-linecap="round"/>`; }).join("")}
    <text x="${cx}" y="${cy + 18}" text-anchor="middle" font-family="Inter, sans-serif" font-weight="800" font-size="70" fill="${C.text}">${Math.round(rate)}%</text>
    <text x="${cx}" y="${cy + 54}" text-anchor="middle" font-family="'Geist Mono', monospace" font-size="19" letter-spacing="4" fill="${C.muted}">THIS MONTH</text>`;
  }
  // personal best: an equity line climbing past the old level
  const pts = [[0, 410], [58, 380], [110, 392], [170, 338], [226, 352], [290, 286], [346, 300], [410, 214], [472, 168]].map(([x, y]) => [X0 + x, y + 20]);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" "), [lx, ly] = pts[pts.length - 1];
  return `${faint}
  <line x1="${X0}" y1="270" x2="${X1}" y2="270" stroke="${C.accent}" stroke-opacity=".7" stroke-width="3" stroke-dasharray="3 12" stroke-linecap="round"/>
  <text x="${X0}" y="252" font-family="'Geist Mono', monospace" font-size="17" letter-spacing="3" fill="${C.accent}">OLD BEST</text>
  <path d="${d}" fill="none" stroke="${C.up}" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${lx}" cy="${ly}" r="22" fill="none" stroke="${C.up}" stroke-opacity=".4" stroke-width="3"/><circle cx="${lx}" cy="${ly}" r="11" fill="${C.up}"/>`;
}

/** The streak card is the web app's streak monitor, drawn flat: the flame tile and the current run, the ribbon of the latest trades with the run lit, then the best and the worst run. */
const FLAME = "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z";
const DOWN = "#f06b6b";
const day = d => d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
const span = r => !r?.len ? "-" : r.from === r.to ? day(r.from) : `${day(r.from)} \u2013 ${day(r.to)}`;
function streakBadge(m) {
  const n = m.n, recent = (m.recent ?? []).slice(-28), cols = Math.max(recent.length, 1), PX = 88, PW = 1024, gap = 8, bw = Math.min(30, (PW - (cols - 1) * gap) / cols);
  const rx = PX + (PW - (cols * bw + (cols - 1) * gap)) / 2;
  const ribbon = recent.map((r, i) => { const h = r.cur ? 92 : 62, x = rx + i * (bw + gap); return `<rect x="${x.toFixed(1)}" y="${(306 - h / 2).toFixed(1)}" width="${bw.toFixed(1)}" height="${h}" rx="6" fill="${r.win ? C.up : DOWN}" fill-opacity="${r.cur ? 1 : .42}"/>`; }).join("");
  const card = (x, label, tone, run, kind) => `<rect x="${x}" y="420" width="500" height="128" rx="20" fill="#ffffff" fill-opacity=".04"/>
    <circle cx="${x + 30}" cy="456" r="6" fill="${tone}"/><text x="${x + 46}" y="463" font-family="Inter, sans-serif" font-weight="600" font-size="19" letter-spacing="2" fill="${C.muted}">${label}</text>
    <text x="${x + 28}" y="516" font-family="'Geist Mono', monospace" font-weight="600" font-size="44" fill="${tone}">${run?.len ?? 0}</text>
    <text x="${x + 28 + String(run?.len ?? 0).length * 27 + 14}" y="516" font-family="Inter, sans-serif" font-weight="600" font-size="28" fill="${C.text}">${kind}${(run?.len ?? 0) === 1 ? "" : kind === "win" ? "s" : "es"}</text>
    <text x="${x + 472}" y="516" text-anchor="end" font-family="Inter, sans-serif" font-weight="500" font-size="21" fill="#6f6f76">${esc(span(run))}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="${C.bg}"/>
  <rect x="60" y="60" width="1080" height="510" rx="32" fill="#1b1b1e"/>
  <rect x="88" y="96" width="92" height="92" rx="28" fill="${C.up}" fill-opacity=".13" stroke="${C.up}" stroke-opacity=".28" stroke-width="2"/>
  <g transform="translate(106 114) scale(2.2)" fill="none" stroke="${C.up}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${FLAME}"/></g>
  <text x="204" y="126" font-family="Inter, sans-serif" font-weight="600" font-size="21" letter-spacing="3" fill="${C.muted}">CURRENT STREAK</text>
  <text x="202" y="182" font-family="'Geist Mono', monospace" font-weight="600" font-size="62" fill="${C.up}">${n}</text>
  <text x="${202 + String(n).length * 38 + 18}" y="180" font-family="Inter, sans-serif" font-weight="600" font-size="36" fill="${C.text}">${n === 1 ? "win" : "wins"} in a row</text>
  ${ribbon}
  ${card(88, "BEST RUN", C.up, m.bestWin, "win")}
  ${card(612, "WORST RUN", DOWN, m.worstLoss, "loss")}</svg>`;
}

function badge(m) {
  if (m.kind === "streak") return streakBadge(m);
  const { kicker, big, line } = m, bigSize = String(big).length > 6 ? 96 : String(big).length > 3 ? 150 : 190;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="${C.bg}"/>
  <rect x="40" y="40" width="1120" height="550" rx="36" fill="${C.s1}" stroke="${C.up}" stroke-opacity=".55" stroke-width="2"/>
  <g transform="translate(84 84) scale(.5)" fill="${C.text}">${MARK.map(d => `<path d="${d}"/>`).join("")}</g>
  <text x="148" y="116" font-family="Inter, sans-serif" font-weight="800" font-size="24" letter-spacing="3" fill="${C.text}">YSER LAB</text>
  <line x1="590" y1="110" x2="590" y2="520" stroke="${C.line}" stroke-width="2"/>
  ${art(m)}
  <text x="84" y="230" font-family="'Geist Mono', monospace" font-size="24" letter-spacing="5" fill="${C.up}">${esc(kicker)}</text>
  <text x="84" y="400" font-family="Inter, sans-serif" font-weight="800" font-size="${bigSize}" fill="${C.text}">${esc(big)}</text>
  <text x="84" y="486" font-family="'Instrument Serif', serif" font-style="italic" font-size="${String(line).length > 28 ? 36 : 46}" fill="${C.soft}">${esc(line)}</text></svg>`;
}
const order = (a, b) => (a.trade_date + (a.traded_at ?? a.created_at)).localeCompare(b.trade_date + (b.traded_at ?? b.created_at));

/** Decisive trades (a win or a loss) in order, the run you are on, and the best winning and worst losing runs, as the web app's streak monitor counts them. */
function runs(list) {
  const dec = list.filter(e => isWin(e) || isLoss(e)), all = [];
  let cur = null;
  for (const e of dec) { const win = isWin(e); if (cur && cur.win === win) { cur.len++; cur.to = e.trade_date; cur.ids.push(e.id); } else { cur = { win, len: 1, from: e.trade_date, to: e.trade_date, ids: [e.id] }; all.push(cur); } }
  const last = all[all.length - 1], inCur = new Set(last?.ids ?? []);
  const best = (w) => all.filter(r => r.win === w).sort((a, b) => b.len - a.len)[0];
  return { recent: dec.slice(-28).map(e => ({ win: isWin(e), cur: inCur.has(e.id) })), bestWin: best(true), worstLoss: best(false) };
}export { badge };
export function find(rows, config) {
  const list = [...rows].filter(e => e.pnl != null || e.r_multiple != null).sort(order);
  const out = [];
  if (!list.length) return out;
  // Win streak now: the last N trades are all wins.
  let n = 0;
  for (let i = list.length - 1; i >= 0 && isWin(list[i]); i--) n++;
  const startId = list[list.length - n]?.id;
  for (const t of config.milestones.streaks ?? []) if (n >= t && startId) out.push({ key: `ms:streak:${t}:${startId}`, kind: "streak", n, ...runs(list), kicker: "WIN STREAK", big: `${t}`, line: `${t} winning trades in a row`, text: `**${t} wins in a row.** The streak is on.` });
  // This month's win rate (at least 10 trades, so it means something).
  const month = list[list.length - 1].trade_date.slice(0, 7);
  const inMonth = list.filter(e => e.trade_date.startsWith(month));
  if (inMonth.length >= 10) {
    const rate = Math.round(100 * inMonth.filter(isWin).length / inMonth.filter(e => isWin(e) || isLoss(e)).length);
    for (const t of config.milestones.winRates ?? []) if (rate >= t) out.push({ key: `ms:wr:${t}:${month}`, kind: "rate", rate, kicker: "WIN RATE", big: `${t}%`, line: `${rate}% this month over ${inMonth.length} trades`, text: `**Win rate above ${t}%** this month: ${rate}% over ${inMonth.length} trades.` });
  }
  if (config.milestones.personalBests && list.length >= 10) {
    const days = new Map();
    for (const e of list) days.set(e.trade_date, (days.get(e.trade_date) ?? 0) + (e.pnl ?? 0));
    const [bestDay, bestPnl] = [...days.entries()].sort((a, b) => b[1] - a[1])[0];
    const last = list[list.length - 1].trade_date;
    if (days.size >= 5 && bestDay === last && bestPnl > 0) out.push({ key: `ms:pbday:${bestDay}`, kind: "best", kicker: "PERSONAL BEST", big: `+$${Math.round(bestPnl).toLocaleString("en-US")}`, line: "Your best day so far", text: `**New personal best day: +$${Math.round(bestPnl).toLocaleString("en-US")}.**` });
    const bestR = [...list].filter(e => e.r_multiple != null).sort((a, b) => b.r_multiple - a.r_multiple)[0];
    if (bestR && bestR.r_multiple > 0 && list[list.length - 1].id === bestR.id) out.push({ key: `ms:pbr:${bestR.id}`, kind: "best", kind: "best", kicker: "PERSONAL BEST", big: `+${Number(bestR.r_multiple).toFixed(2)}R`, line: `Your best trade so far${bestR.instrument ? ` · ${bestR.instrument}` : ""}`, text: `**New personal best trade: +${Number(bestR.r_multiple).toFixed(2)}R.**` });
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
