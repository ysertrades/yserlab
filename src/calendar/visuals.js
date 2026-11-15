import { zoneName } from "./feed.js";

/* Economic calendar pictures: flat dark grounds, crisp strokes, the app's colours, the Y mark. Every time is New York time, labelled EST or EDT as it really is. */
const C = { bg: "#111112", s1: "#161618", s2: "#1b1b1d", line: "rgba(255,255,255,.08)", line2: "rgba(255,255,255,.16)", text: "#f2f2f3", soft: "#c9c9cd", muted: "#8e8e94", faint: "#5d5d63", accent: "#8d9bff", high: "#f06b6b", med: "#f5b544", low: "#8e8e94", up: "#3ccf7a" };
const MARK = [
  "M16.01 24.58Q14.00 20.00 19.00 20.00L30.85 20.00Q35.85 20.00 37.86 24.58L46.99 45.42Q49.00 50.00 44.00 50.00L32.15 50.00Q27.15 50.00 25.14 45.42Z",
  "M62.14 15.58Q64.15 11.00 69.15 11.00L81.00 11.00Q86.00 11.00 83.99 15.58L74.86 36.42Q72.85 41.00 67.85 41.00L56.00 41.00Q51.00 41.00 53.01 36.42Z",
  "M40.00 61.00Q40.00 56.00 45.00 56.00L55.00 56.00Q60.00 56.00 60.00 61.00L60.00 87.00Q60.00 92.00 55.00 92.00L45.00 92.00Q40.00 92.00 40.00 87.00Z",
];
const SANS = "Inter, sans-serif", MONO = "'Geist Mono', monospace", SERIF = "'Instrument Serif', serif";
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const tone = impact => impact === "High" ? C.high : impact === "Medium" ? C.med : C.low;
const bars = (x, y, impact) => {
  const n = impact === "High" ? 3 : impact === "Medium" ? 2 : 1;
  return [0, 1, 2].map(i => `<rect x="${x + i * 11}" y="${y - 9 - i * 5}" width="7" height="${9 + i * 5}" rx="2" fill="${i < n ? tone(impact) : "rgba(255,255,255,.12)"}"/>`).join("");
};
const mark = (x, y, size, fill = C.text) => `<g transform="translate(${x} ${y}) scale(${size / 100})" fill="${fill}">${MARK.map(d => `<path d="${d}"/>`).join("")}</g>`;
const clock = e => e.allDay ? "All day" : e.at.toFormat("h:mm a");
const frame = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${C.bg}"/>${body}</svg>`;
/** The faint lattice of the brand mark behind everything, quiet enough to be texture. */
const lattice = (w, h) => {
  let out = "";
  for (let y = 0, r = 0; y < h; y += 150, r++) for (let x = (r % 2) * 75; x < w; x += 150) out += `<g opacity=".035">${mark(x, y, 52)}</g>`;
  return out;
};
const header = (w, kicker, title, italic, right) => `
  ${mark(64, 56, 54, C.text)}
  <text x="132" y="86" font-family="${SANS}" font-weight="800" font-size="26" letter-spacing="3" fill="${C.text}">YSER LAB</text>
  <text x="${w - 64}" y="86" text-anchor="end" font-family="${MONO}" font-size="22" fill="${C.muted}">${esc(right)}</text>
  <text x="64" y="${190}" font-family="${MONO}" font-size="22" letter-spacing="4" fill="${C.accent}">${esc(kicker)}</text>
  <text x="64" y="${268}" font-family="${SANS}" font-weight="800" font-size="76" fill="${C.text}">${esc(title)} <tspan font-family="${SERIF}" font-style="italic" font-weight="400" fill="${C.accent}">${esc(italic)}</tspan></text>`;

/** One day's releases as a table. `events` are already filtered and sorted. */
export function dayCard(events, day, { kicker = "ECONOMIC CALENDAR", title = "Today", italic = "" } = {}) {
  const w = 1400, rowH = 92, top = 330, shown = events.slice(0, 11), more = events.length - shown.length;
  const h = top + shown.length * rowH + (more > 0 ? 70 : 0) + 130;
  const zone = events[0] ? zoneName(events[0].at) : zoneName(day);
  const high = events.filter(e => e.impact === "High").length;
  let rows = "";
  shown.forEach((e, i) => {
    const y = top + i * rowH, mid = y + 56;
    rows += `<g>
      <rect x="64" y="${y}" width="${w - 128}" height="${rowH - 10}" rx="18" fill="${C.s1}" stroke="${C.line}"/>
      <rect x="64" y="${y}" width="6" height="${rowH - 10}" rx="3" fill="${tone(e.impact)}"/>
      <text x="104" y="${mid}" font-family="${MONO}" font-size="30" fill="${C.text}">${esc(clock(e))}</text>
      <rect x="290" y="${mid - 31}" width="86" height="42" rx="21" fill="${C.s2}" stroke="${C.line2}"/>
      <text x="333" y="${mid - 2}" text-anchor="middle" font-family="${MONO}" font-size="22" fill="${C.soft}">${esc(e.currency)}</text>
      ${bars(404, mid + 2, e.impact)}
      <text x="468" y="${mid}" font-family="${SANS}" font-weight="600" font-size="30" fill="${C.text}">${esc(clip(e.title, 40))}</text>
      ${e.forecast || e.previous ? `<text x="${w - 100}" y="${mid - 6}" text-anchor="end" font-family="${MONO}" font-size="21" fill="${C.muted}">${e.forecast ? `F  <tspan fill="${C.text}">${esc(e.forecast)}</tspan>` : ""}${e.forecast && e.previous ? "     " : ""}${e.previous ? `P  <tspan fill="${C.soft}">${esc(e.previous)}</tspan>` : ""}</text>` : ""}
    </g>`;
  });
  if (more > 0) rows += `<text x="${w / 2}" y="${top + shown.length * rowH + 42}" text-anchor="middle" font-family="${MONO}" font-size="24" fill="${C.muted}">+ ${more} more</text>`;
  const foot = h - 56;
  return { w, h, svg: frame(w, h, `${lattice(w, h)}${header(w, kicker, title, italic || day.toFormat("EEE d LLL"), `${events.length} release${events.length === 1 ? "" : "s"}${high ? `  ·  ${high} high impact` : ""}`)}${rows}
    <text x="64" y="${foot}" font-family="${MONO}" font-size="21" fill="${C.faint}">All times ${esc(zone)} (New York)</text>
    <g transform="translate(${w - 64} ${foot})" text-anchor="end" font-family="${MONO}" font-size="21" fill="${C.muted}"><text>F forecast   P previous</text></g>`) };
}

/** A heads-up or the release itself: big and quick to read. */
export function alertCard(group, { minutes = 15, now = false } = {}) {
  const w = 1400, h = 700, first = group[0], accent = tone(group.some(e => e.impact === "High") ? "High" : "Medium");
  const list = group.slice(0, 4);
  const big = now ? "NOW" : String(minutes);
  const unit = now ? "RELEASING" : minutes === 1 ? "MINUTE" : "MINUTES";
  let items = "";
  list.forEach((e, i) => {
    const y = 296 + i * 84;
    items += `<g>${bars(600, y + 4, e.impact)}
      <rect x="664" y="${y - 30}" width="78" height="38" rx="19" fill="${C.s2}" stroke="${C.line2}"/>
      <text x="703" y="${y - 3}" text-anchor="middle" font-family="${MONO}" font-size="20" fill="${C.soft}">${esc(e.currency)}</text>
      <text x="764" y="${y}" font-family="${SANS}" font-weight="700" font-size="32" fill="${C.text}">${esc(clip(e.title, 30))}</text>
      <text x="764" y="${y + 32}" font-family="${MONO}" font-size="20" fill="${C.muted}">forecast <tspan fill="${C.text}">${esc(e.forecast || "–")}</tspan>   previous <tspan fill="${C.soft}">${esc(e.previous || "–")}</tspan></text></g>`;
  });
  const extra = group.length - list.length;
  return { w, h, svg: frame(w, h, `${lattice(w, h)}
    ${mark(64, 56, 54)}
    <text x="132" y="86" font-family="${SANS}" font-weight="800" font-size="26" letter-spacing="3" fill="${C.text}">YSER LAB</text>
    <rect x="64" y="180" width="480" height="440" rx="40" fill="${C.s1}" stroke="${accent}" stroke-width="3"/>
    <text x="304" y="${now ? 400 : 430}" text-anchor="middle" font-family="${SANS}" font-weight="800" font-size="${now ? 150 : 230}" fill="${C.text}">${big}</text>
    <text x="304" y="${now ? 470 : 500}" text-anchor="middle" font-family="${MONO}" font-size="30" letter-spacing="8" fill="${accent}">${unit}</text>
    <text x="304" y="570" text-anchor="middle" font-family="${SERIF}" font-style="italic" font-size="40" fill="${C.soft}">${esc(clock(first))} ${esc(zoneName(first.at))}</text>
    <text x="600" y="214" font-family="${MONO}" font-size="22" letter-spacing="4" fill="${accent}">${now ? "RELEASING NOW" : "HEADS-UP"}</text>
    ${items}
    ${extra > 0 ? `<text x="600" y="${296 + list.length * 84}" font-family="${MONO}" font-size="22" fill="${C.muted}">+ ${extra} more at this time</text>` : ""}
    <text x="${w - 64}" y="${h - 40}" text-anchor="end" font-family="${MONO}" font-size="20" fill="${C.faint}">${esc(first.at.toFormat("cccc d LLL"))}  ·  ${esc(zoneName(first.at))}</text>`) };
}

/** The week ahead: one column per weekday. */
export function weekCard(events, monday) {
  const w = 1800, gap = 14, left = 64, colW = (w - left * 2 - gap * 4) / 5, top = 340, rowH = 78, max = 9;
  const days = [0, 1, 2, 3, 4].map(i => monday.plus({ days: i }));
  const cols = days.map(d => events.filter(e => e.at.hasSame(d, "day")));
  const tall = Math.min(max, Math.max(1, ...cols.map(c => c.length)));
  const h = top + 90 + tall * rowH + 140;
  const zone = zoneName(monday);
  let body = "";
  days.forEach((d, i) => {
    const x = left + i * (colW + gap), list = cols[i], shown = list.slice(0, max), more = list.length - shown.length;
    const high = list.filter(e => e.impact === "High").length;
    body += `<rect x="${x}" y="${top - 10}" width="${colW}" height="${90 + tall * rowH + 30}" rx="24" fill="${C.s1}" stroke="${C.line}"/>
      <text x="${x + 28}" y="${top + 38}" font-family="${SANS}" font-weight="800" font-size="34" fill="${C.text}">${esc(d.toFormat("ccc"))} <tspan font-family="${SERIF}" font-style="italic" font-weight="400" fill="${C.accent}">${esc(d.toFormat("d LLL"))}</tspan></text>
      <text x="${x + colW - 28}" y="${top + 38}" text-anchor="end" font-family="${MONO}" font-size="20" fill="${high ? C.high : C.faint}">${high ? `${high} high` : list.length ? `${list.length}` : "quiet"}</text>
      <line x1="${x + 28}" x2="${x + colW - 28}" y1="${top + 62}" y2="${top + 62}" stroke="${C.line}"/>`;
    shown.forEach((e, j) => {
      const y = top + 110 + j * rowH;
      body += `<rect x="${x + 28}" y="${y - 22}" width="5" height="48" rx="2.5" fill="${tone(e.impact)}"/>
        <text x="${x + 46}" y="${y}" font-family="${MONO}" font-size="19" fill="${C.muted}">${esc(clock(e))}  <tspan fill="${C.soft}">${esc(e.currency)}</tspan></text>
        <text x="${x + 46}" y="${y + 28}" font-family="${SANS}" font-weight="600" font-size="22" fill="${C.text}">${esc(clip(e.title, 26))}</text>`;
    });
    if (more > 0) body += `<text x="${x + 28}" y="${top + 110 + shown.length * rowH}" font-family="${MONO}" font-size="19" fill="${C.muted}">+ ${more} more</text>`;
  });
  const total = events.length, high = events.filter(e => e.impact === "High").length;
  const end = monday.plus({ days: 4 });
  return { w, h, svg: frame(w, h, `${lattice(w, h)}${header(w, "THE WEEK AHEAD", "News,", `${monday.toFormat("d LLL")} – ${end.toFormat("d LLL")}`, `${total} release${total === 1 ? "" : "s"}${high ? `  ·  ${high} high impact` : ""}`)}${body}
    <text x="64" y="${h - 56}" font-family="${MONO}" font-size="21" fill="${C.faint}">All times ${esc(zone)} (New York)  ·  red high, amber medium</text>`) };
}
