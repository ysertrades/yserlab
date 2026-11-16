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
    <text x="64" y="${foot}" font-family="${MONO}" font-size="21" fill="${C.faint}"></text>
    <g transform="translate(${w - 64} ${foot})" text-anchor="end" font-family="${MONO}" font-size="21" fill="${C.muted}"><text>F forecast   P previous</text></g>`) };
}

/** Words wrapped to at most `lines` lines of about `n` characters (the last line ends with an ellipsis if it had to be cut). */
const wrap = (text, n, lines = 2) => {
  const words = String(text ?? "").split(/\s+/).filter(Boolean), out = [];
  let line = "";
  for (const w of words) { if ((line + " " + w).trim().length > n && line) { out.push(line); line = w; } else line = (line + " " + w).trim(); }
  if (line) out.push(line);
  if (out.length > lines) { const kept = out.slice(0, lines); kept[lines - 1] = clip(out.slice(lines - 1).join(" "), n); return kept; }
  return out;
};

/**
 * A heads-up or the release itself. A ring of one segment per minute of the lead time, all lit, around the number; each release is a row with
 * its forecast and previous as chips; under them a countdown rail from the heads-up to the release with you at the start of it.
 */
export function alertCard(group, { minutes = 15, now = false } = {}) {
  if (now) return releasingCard(group);
  const w = 1400, h = 700, first = group[0], hot = group.some(e => e.impact === "High"), accent = tone(hot ? "High" : "Medium");
  const list = group.slice(0, 3), extra = group.length - list.length;
  const cx = 290, cy = 352, r = 152, C2 = 2 * Math.PI * r, n = Math.max(5, Math.min(20, Math.round(minutes))), seg = C2 / n;
  const ring = now
    ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${accent}" stroke-width="14"/><circle cx="${cx}" cy="${cy}" r="${r + 26}" fill="none" stroke="${accent}" stroke-opacity=".35" stroke-width="3"/><circle cx="${cx}" cy="${cy}" r="${r + 52}" fill="none" stroke="${accent}" stroke-opacity=".15" stroke-width="3"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${accent}" stroke-width="14" stroke-dasharray="${(seg - 9).toFixed(2)} 9" transform="rotate(-90 ${cx} ${cy})"/><circle cx="${cx}" cy="${cy}" r="${r - 30}" fill="${C.s1}" stroke="${C.line}"/>`;
  let rows = "";
  const rowH = 108, top = 236;
  list.forEach((e, i) => {
    const y = top + i * (rowH + 14), t = tone(e.impact);
    const lines = wrap(e.title, 26, 2), chips = [["FORECAST", e.forecast || "–"], ["PREVIOUS", e.previous || "–"]];
    rows += `<g>
      <rect x="600" y="${y}" width="736" height="${rowH}" rx="22" fill="${C.s1}" stroke="${C.line}"/>
      <rect x="600" y="${y}" width="7" height="${rowH}" rx="3.5" fill="${t}"/>
      ${bars(634, y + 40, e.impact)}
      <rect x="690" y="${y + 22}" width="80" height="38" rx="19" fill="${C.s2}" stroke="${C.line2}"/>
      <text x="730" y="${y + 48}" text-anchor="middle" font-family="${MONO}" font-size="20" fill="${C.soft}">${esc(e.currency)}</text>
      ${lines.map((l, k) => `<text x="792" y="${y + 50 + k * 34 - (lines.length > 1 ? 14 : 0)}" font-family="${SANS}" font-weight="700" font-size="32" fill="${C.text}">${esc(l)}</text>`).join("")}
      ${chips.map(([k, v], c) => `<g transform="translate(${1328 - (c === 0 ? 392 : 190)} ${y + rowH - 40})"><rect width="${c === 0 ? 184 : 178}" height="30" rx="15" fill="${C.s2}" stroke="${C.line}"/><text x="14" y="21" font-family="${MONO}" font-size="15" letter-spacing="2" fill="${C.faint}">${k}</text><text x="${c === 0 ? 170 : 164}" y="21" text-anchor="end" font-family="${MONO}" font-size="18" fill="${c === 0 ? C.text : C.soft}">${esc(v)}</text></g>`).join("")}
    </g>`;
  });
  // the rail: heads-up on the left, the release on the right; you are at the start of it (or at the end, once it is out)
  const rx1 = 640, rx2 = 1296, ry = 646, marks = [0, 1 / 3, 2 / 3, 1].map(f => rx1 + f * (rx2 - rx1));
  const left = now ? "0" : String(minutes), dot = now ? rx2 : rx1;
  const rail = `<line x1="${rx1}" y1="${ry}" x2="${rx2}" y2="${ry}" stroke="${C.line2}" stroke-width="3" stroke-linecap="round"/>
    <line x1="${rx1}" y1="${ry}" x2="${dot}" y2="${ry}" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
    ${marks.map((x, i) => `<circle cx="${x}" cy="${ry}" r="5" fill="${i === 3 ? accent : C.bg}" stroke="${i === 3 ? accent : C.line2}" stroke-width="2"/>`).join("")}
    <circle cx="${dot}" cy="${ry}" r="11" fill="${accent}"/><circle cx="${dot}" cy="${ry}" r="20" fill="none" stroke="${accent}" stroke-opacity=".4" stroke-width="3"/>
    <text x="${rx1}" y="${ry + 40}" font-family="${MONO}" font-size="17" letter-spacing="2" fill="${C.muted}">${now ? "HEADS-UP SENT" : "NOW"}</text>
    <text x="${rx2}" y="${ry + 40}" text-anchor="end" font-family="${MONO}" font-size="17" letter-spacing="2" fill="${accent}">RELEASE ${esc(clock(first).toUpperCase())}</text>`;
  return { w, h, svg: frame(w, h, `${lattice(w, h)}
    ${mark(64, 56, 54)}
    <text x="132" y="86" font-family="${SANS}" font-weight="800" font-size="26" letter-spacing="3" fill="${C.text}">YSER LAB</text>
    <text x="${w - 64}" y="86" text-anchor="end" font-family="${MONO}" font-size="22" fill="${C.muted}">${esc(first.at.toFormat("cccc d LLL"))}  ·  ${esc(zoneName(first.at))}</text>
    ${ring}
    <text x="${cx}" y="${cy + 46}" text-anchor="middle" font-family="${SANS}" font-weight="800" font-size="150" letter-spacing="-4" fill="${C.text}">${minutes}</text>
    <text x="${cx}" y="${cy + 96}" text-anchor="middle" font-family="${MONO}" font-size="22" letter-spacing="7" fill="${accent}">${minutes === 1 ? "MINUTE" : "MINUTES"}</text>
    ${timePill(cx, 556, first, accent)}
    <text x="600" y="196" font-family="${MONO}" font-size="22" letter-spacing="5" fill="${accent}">${now ? "RELEASING NOW" : "HEADS-UP"}</text>
    ${extra > 0 ? `<text x="1336" y="196" text-anchor="end" font-family="${MONO}" font-size="20" fill="${C.muted}">+ ${extra} more at this time</text>` : ""}
    ${rows}${rail}`) };
}

/** The time of a release as a pill: a small clock, the time in the sans, the zone beside it. Never the serif. */
function timePill(cx, y, e, accent, w = 300) {
  const x = cx - w / 2;
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="58" rx="29" fill="${C.s1}" stroke="${C.line2}"/>
    <circle cx="${x + 36}" cy="${y + 29}" r="12" fill="none" stroke="${accent}" stroke-width="3"/><path d="M${x + 36} ${y + 22}v7l5 3" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="${x + 62}" y="${y + 40}" font-family="${SANS}" font-weight="800" font-size="30" letter-spacing="-.5" fill="${C.text}">${esc(clock(e))}</text>
    <text x="${x + w - 24}" y="${y + 37}" text-anchor="end" font-family="${MONO}" font-size="19" letter-spacing="3" fill="${C.muted}">${esc(zoneName(e.at))}</text>
  </g>`;
}

/** The release itself: a live banner (not the heads-up's ring). The release's name large, and forecast, previous and the actual to come as three tiles. */
function releasingCard(group) {
  const w = 1400, h = 700, first = group[0], accent = tone(group.some(e => e.impact === "High") ? "High" : "Medium");
  const lines = wrap(first.title, 30, 2), t = tone(first.impact);
  const tiles = [["FORECAST", first.forecast || "–", C.text, false], ["PREVIOUS", first.previous || "–", C.soft, false], ["ACTUAL", "", accent, true]];
  const tw = 412, gap = 18, tx = 64, ty = 376, th = 150;
  const boxes = tiles.map(([k, v, col, live], i) => {
    const x = tx + i * (tw + gap);
    return `<g><rect x="${x}" y="${ty}" width="${tw}" height="${th}" rx="26" fill="${C.s1}" stroke="${live ? accent : C.line}" stroke-width="${live ? 3 : 1}"/>
      <text x="${x + 30}" y="${ty + 46}" font-family="${MONO}" font-size="20" letter-spacing="5" fill="${live ? accent : C.faint}">${k}</text>
      ${live ? [0, 1, 2].map(d => `<circle cx="${x + 40 + d * 34}" cy="${ty + 100}" r="${10 - d * 2}" fill="${accent}" fill-opacity="${1 - d * .3}"/>`).join("") + `<text x="${x + 150}" y="${ty + 112}" font-family="${SANS}" font-weight="700" font-size="34" fill="${C.soft}">coming in</text>` : `<text x="${x + 30}" y="${ty + 112}" font-family="${SANS}" font-weight="800" font-size="${String(v).length > 8 ? 44 : 62}" letter-spacing="-1" fill="${col}">${esc(v)}</text>`}</g>`;
  }).join("");
  const others = group.slice(1, 4);
  return { w, h, svg: frame(w, h, `${lattice(w, h)}
    ${mark(64, 56, 54)}
    <text x="132" y="86" font-family="${SANS}" font-weight="800" font-size="26" letter-spacing="3" fill="${C.text}">YSER LAB</text>
    <text x="${w - 64}" y="86" text-anchor="end" font-family="${MONO}" font-size="22" fill="${C.muted}">${esc(first.at.toFormat("cccc d LLL"))}</text>
    <circle cx="80" cy="176" r="11" fill="${accent}"/><circle cx="80" cy="176" r="22" fill="none" stroke="${accent}" stroke-opacity=".4" stroke-width="3"/><circle cx="80" cy="176" r="33" fill="none" stroke="${accent}" stroke-opacity=".15" stroke-width="3"/>
    <text x="132" y="185" font-family="${MONO}" font-size="24" letter-spacing="7" fill="${accent}">RELEASING NOW</text>
    ${timePill(w - 64 - 150, 142, first, accent)}
    <rect x="64" y="226" width="7" height="${lines.length * 70 - 6}" rx="3.5" fill="${t}"/>
    ${lines.map((l, i) => `<text x="96" y="${278 + i * 70}" font-family="${SANS}" font-weight="800" font-size="62" letter-spacing="-1.5" fill="${C.text}">${esc(l)}</text>`).join("")}
    <rect x="${96 + 0}" y="${lines.length * 70 + 238}" width="80" height="36" rx="18" fill="${C.s2}" stroke="${C.line2}" opacity="0"/>
    ${boxes}
    <g transform="translate(64 576)">
      ${bars(14, 28, first.impact)}
      <rect x="62" y="2" width="82" height="38" rx="19" fill="${C.s2}" stroke="${C.line2}"/><text x="103" y="29" text-anchor="middle" font-family="${MONO}" font-size="20" fill="${C.soft}">${esc(first.currency)}</text>
      <text x="164" y="30" font-family="${MONO}" font-size="20" letter-spacing="3" fill="${C.muted}">${first.impact.toUpperCase()} IMPACT</text>
      ${others.length ? `<text x="1272" y="30" text-anchor="end" font-family="${MONO}" font-size="20" fill="${C.muted}">+ ${others.map(e => esc(clip(e.title, 22))).join("  ·  ")}${group.length - 1 > others.length ? "  ·  …" : ""}</text>` : ""}
    </g>`) };
}

/** The week ahead: one column per weekday. */
export function weekCard(events, monday) {
  const w = 1800, gap = 14, left = 64, colW = (w - left * 2 - gap * 4) / 5, top = 340, rowH = 98, max = 8;
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
      body += `<rect x="${x + 28}" y="${y - 22}" width="5" height="${wrap(e.title, 20, 2).length > 1 ? 74 : 48}" rx="2.5" fill="${tone(e.impact)}"/>
        <text x="${x + 46}" y="${y}" font-family="${MONO}" font-size="19" fill="${C.muted}">${esc(clock(e))}  <tspan fill="${C.soft}">${esc(e.currency)}</tspan></text>
        ${wrap(e.title, 20, 2).map((l, k) => `<text x="${x + 46}" y="${y + 28 + k * 26}" font-family="${SANS}" font-weight="600" font-size="22" fill="${C.text}">${esc(l)}</text>`).join("")}`;
    });
    if (more > 0) body += `<text x="${x + 28}" y="${top + 110 + shown.length * rowH}" font-family="${MONO}" font-size="19" fill="${C.muted}">+ ${more} more</text>`;
  });
  const total = events.length, high = events.filter(e => e.impact === "High").length;
  const end = monday.plus({ days: 4 });
  return { w, h, svg: frame(w, h, `${lattice(w, h)}${header(w, "THE WEEK AHEAD", "News,", `${monday.toFormat("d LLL")} – ${end.toFormat("d LLL")}`, `${total} release${total === 1 ? "" : "s"}${high ? `  ·  ${high} high impact` : ""}`)}${body}
    <text x="64" y="${h - 56}" font-family="${MONO}" font-size="21" fill="${C.faint}">red high, amber medium</text>`) };
}
