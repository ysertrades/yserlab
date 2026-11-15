// src/journal/stats.ts
function rFromLevels({ entry: e, stop, exit }, direction) {
  if (e == null || stop == null || exit == null || e === stop) return null;
  const short = direction ? direction === "short" : stop > e;
  return Math.round((short ? e - exit : exit - e) / Math.abs(e - stop) * 100) / 100;
}
var rOf = (entry) => entry.r_multiple ?? rFromLevels(entry.levels, entry.direction);

// src/journal/shareCards.ts
var CARD_W = 1600;
var DEFAULT_SHARE = { kind: "month", brand: true, pattern: true, pill: true, equity: true, stats: true, beads: true, best: true, weekdays: true, rings: "gradient", amounts: "usd", clear: false, title: "" };
var C = { bg: "#111112", s1: "#161618", s2: "#1b1b1d", line: "rgba(255,255,255,.08)", line2: "rgba(255,255,255,.14)", text: "#f2f2f3", soft: "#c9c9cd", muted: "#8e8e94", faint: "#5d5d63", accent: "#8d9bff", cobalt: "#3d5afe", up: "#3ccf7a", down: "#f06b6b", be: "#f5b544" };
var MONO = "'Geist Mono', monospace";
var SANS = "Inter, sans-serif";
var SERIF = "'Instrument Serif', serif";
var PAD = 72;
var MARK = [
  "M16.01 24.58Q14.00 20.00 19.00 20.00L30.85 20.00Q35.85 20.00 37.86 24.58L46.99 45.42Q49.00 50.00 44.00 50.00L32.15 50.00Q27.15 50.00 25.14 45.42Z",
  "M62.14 15.58Q64.15 11.00 69.15 11.00L81.00 11.00Q86.00 11.00 83.99 15.58L74.86 36.42Q72.85 41.00 67.85 41.00L56.00 41.00Q51.00 41.00 53.01 36.42Z",
  "M40.00 61.00Q40.00 56.00 45.00 56.00L55.00 56.00Q60.00 56.00 60.00 61.00L60.00 87.00Q60.00 92.00 55.00 92.00L45.00 92.00Q40.00 92.00 40.00 87.00Z"
];
var pad = (n) => String(n).padStart(2, "0");
var keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
var mondayOf = (d) => {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - (m.getDay() + 6) % 7);
  return m;
};
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
}
function dayOf(date, entries) {
  let pnl = 0, wins = 0, losses = 0, be = 0, r = 0, hasR = false;
  for (const e of entries) {
    pnl += e.pnl ?? 0;
    if (e.pnl != null) {
      if (e.pnl > 0) wins++;
      else if (e.pnl < 0) losses++;
      else be++;
    }
    const v = rOf(e);
    if (v != null) {
      r += v;
      hasR = true;
    }
  }
  return { key: keyOf(date), date, pnl, r: hasR ? r : null, trades: entries.length, wins, losses, be };
}
function totalsOf(days, entries) {
  const traded = days.filter((d) => d.trades);
  const instruments = [...new Set(entries.map((e) => (e.instrument ?? "").toUpperCase()).filter(Boolean))].slice(0, 4);
  return {
    days,
    instruments,
    pnl: traded.reduce((s, d) => s + d.pnl, 0),
    r: traded.some((d) => d.r != null) ? traded.reduce((s, d) => s + (d.r ?? 0), 0) : null,
    trades: traded.reduce((s, d) => s + d.trades, 0),
    wins: traded.reduce((s, d) => s + d.wins, 0),
    losses: traded.reduce((s, d) => s + d.losses, 0),
    be: traded.reduce((s, d) => s + d.be, 0)
  };
}
var byDay = (entries) => {
  const map = /* @__PURE__ */ new Map();
  for (const e of entries) {
    if (e.deleted_at) continue;
    const list = map.get(e.trade_date) ?? [];
    list.push(e);
    map.set(e.trade_date, list);
  }
  return map;
};
function weekData(entries, anchor) {
  const start = mondayOf(anchor), map = byDay(entries), days = [], used = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i), list = map.get(keyOf(d)) ?? [];
    days.push(dayOf(d, list));
    used.push(...list);
  }
  const weekend = days.slice(5).some((d) => d.trades);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + (weekend ? 6 : 4)), fmt = (d, o) => d.toLocaleDateString("en-US", o);
  const label = start.getMonth() === end.getMonth() ? `${fmt(start, { month: "short" }).toUpperCase()} ${start.getDate()} \u2013 ${end.getDate()}, ${end.getFullYear()}` : `${fmt(start, { month: "short" }).toUpperCase()} ${start.getDate()} \u2013 ${fmt(end, { month: "short" }).toUpperCase()} ${end.getDate()}, ${end.getFullYear()}`;
  return { ...totalsOf(days, used), start, no: isoWeek(start), label, weekend, days: days.slice(0, weekend ? 7 : 5) };
}
function monthData(entries, year, month) {
  const map = byDay(entries), last = new Date(year, month + 1, 0).getDate(), days = [], used = [];
  for (let d = 1; d <= last; d++) {
    const date = new Date(year, month, d), list = map.get(keyOf(date)) ?? [];
    days.push(dayOf(date, list));
    used.push(...list);
  }
  return { ...totalsOf(days, used), year, month, name: new Date(year, month, 1).toLocaleDateString("en-US", { month: "long" }) };
}
var esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
var tone = (v) => v > 0 ? C.up : v < 0 ? C.down : C.muted;
var usd = (v) => `${v > 0 ? "+" : v < 0 ? "\u2212" : ""}$${Math.abs(Math.round(v)).toLocaleString("en-US")}`;
var rFmt = (v) => v == null ? "\u2014" : `${v > 0 ? "+" : v < 0 ? "\u2212" : ""}${Math.abs(v).toFixed(1)}R`;
var amount = (o, pnl, r) => o.amounts === "usd" ? usd(pnl) : o.amounts === "r" ? rFmt(r) : "\u2022\u2022\u2022";
var mark = (x, y, s, fill) => `<g transform="translate(${x} ${y}) scale(${s / 100})" fill="${fill}">${MARK.map((d) => `<path d="${d}"/>`).join("")}</g>`;
var markOutline = (x, y, w, o) => `<g transform="translate(${x} ${y}) scale(${w / 76}) translate(-12 -9)" fill="none" stroke="#fff" stroke-opacity="${o.toFixed(3)}" stroke-width="3.2" stroke-linejoin="round">${MARK.map((d) => `<path d="${d}"/>`).join("")}</g>`;
var measuring = null;
var measure = (font, text) => {
  measuring ??= document.createElement("canvas").getContext("2d");
  if (!measuring) return text.length * 20;
  measuring.font = font;
  return measuring.measureText(text).width;
};
function lattice(h) {
  let out = "";
  const step = 76;
  for (let row = 0, y = 20; y < h + step; row++, y += step * 0.9) for (let x = row % 2 * step / 2 - 20; x < CARD_W + step; x += step) {
    const wave = (0.5 + 0.5 * Math.sin(x / 210 + y / 300)) * (0.5 + 0.5 * Math.cos(y / 240 - x / 420)), o = 0.06 * Math.max(0, wave * 1.5 - 0.3);
    if (o > 4e-3) out += markOutline(x, y, 30, o);
  }
  return out;
}
var wordmark = (x, y) => `${mark(x, y, 52, C.text)}<text x="${x + 62}" y="${y + 38}"><tspan font-family="${SANS}" font-weight="800" font-size="30" letter-spacing="-.4" fill="${C.text}">YSER</tspan><tspan dx="9" font-family="${SERIF}" font-style="italic" font-size="36" fill="${C.accent}">trades</tspan></text>`;
function subline(title, word, color, y, pill) {
  const tw = measure("800 54px Inter", title) - 1.6 * title.length;
  let out = `<text x="${PAD}" y="${y}" font-family="${SANS}" font-weight="800" font-size="54" letter-spacing="-1.6" fill="${C.text}">${esc(title)}</text>`;
  if (!pill) return out;
  const ww = measure("600 17px 'Geist Mono'", word.toUpperCase()) + 4 * word.length, pw = ww + 62, px = PAD + tw + 26;
  out += `<rect x="${px}" y="${y - 38}" width="${pw}" height="44" rx="22" fill="${color}" fill-opacity=".1" stroke="${color}" stroke-opacity=".55" stroke-width="2"/><circle cx="${px + 25}" cy="${y - 16}" r="6" fill="${color}"/>
    <text x="${px + 42}" y="${y - 10}" font-family="${MONO}" font-weight="600" font-size="17" letter-spacing="4" fill="${color}">${esc(word.toUpperCase())}</text>`;
  return out;
}
function ring(o, id, x, y, w, h, r, color, loss, a0, a1) {
  if (o.rings === "off") return `<rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${h - 2}" rx="${r}" fill="none" stroke="${C.line}" stroke-width="2"/>`;
  if (o.rings === "flat") return `<rect x="${x + 1.25}" y="${y + 1.25}" width="${w - 2.5}" height="${h - 2.5}" rx="${r - 1}" fill="none" stroke="${color}" stroke-opacity="${(0.35 + a0 * 0.35).toFixed(2)}" stroke-width="2.5"/>`;
  return `<linearGradient id="r${id}" x1="0" y1="${loss ? 1 : 0}" x2=".35" y2="${loss ? 0 : 1}"><stop offset="0" stop-color="${color}" stop-opacity="${a0.toFixed(2)}"/><stop offset=".55" stop-color="${color}" stop-opacity="${a1.toFixed(2)}"/><stop offset="1" stop-color="#fff" stop-opacity=".08"/></linearGradient>
    <rect x="${x + 1.25}" y="${y + 1.25}" width="${w - 2.5}" height="${h - 2.5}" rx="${r - 1}" fill="none" stroke="url(#r${id})" stroke-width="2.5"/>`;
}
var tag = (x, y, text, w) => `<rect x="${x}" y="${y - 24}" width="${w}" height="48" rx="24" fill="${C.cobalt}"/><text x="${x + w / 2}" y="${y + 8}" text-anchor="middle" font-family="${MONO}" font-weight="600" font-size="23" fill="#fff">${esc(text)}</text>`;
var foot = (y, instruments) => `<line x1="${PAD}" x2="${CARD_W - PAD}" y1="${y}" y2="${y}" stroke="${C.line}" stroke-width="2"/>
  <text x="${PAD}" y="${y + 46}" font-family="${MONO}" font-weight="500" font-size="17" letter-spacing="3" fill="${C.faint}">${esc(instruments.length ? instruments.join(" \xB7 ") : "YOUR JOURNAL")}</text>
  <text x="${CARD_W - PAD}" y="${y + 46}" text-anchor="end" font-family="${MONO}" font-weight="500" font-size="17" letter-spacing="3" fill="${C.faint}">SELF-REPORTED, NOT FINANCIAL ADVICE</text>`;
var outcome = (pnl, trades) => !trades ? "none" : pnl > 0 ? "in the green" : pnl < 0 ? "in the red" : "breakeven";
var frame = (o, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_W} ${h}" width="${CARD_W}" height="${h}">${o.clear ? "" : `<rect width="${CARD_W}" height="${h}" fill="${C.bg}"/>`}${o.pattern ? lattice(h) : ""}${body}</svg>`;
function weekSvg(w, o) {
  const cols = w.days.length, hasTrades = w.trades > 0, H = o.stats ? 1210 : 1080;
  const title = o.title.trim() || `Week ${w.no}`, big = amount(o, w.pnl, w.r);
  let run = 0;
  const steps = w.days.map((d) => {
    const open = run;
    run += o.amounts === "r" ? d.r ?? 0 : d.pnl;
    return { d, open, close: run };
  });
  const pick = (d) => o.amounts === "r" ? d.r ?? 0 : d.pnl;
  const traded = w.days.filter((d) => d.trades), best = traded.length ? traded.reduce((a, b) => pick(b) > pick(a) ? b : a) : null, worst = traded.length ? traded.reduce((a, b) => pick(b) < pick(a) ? b : a) : null;
  const lo = Math.min(0, ...steps.flatMap((s) => [s.open, s.close])), hi = Math.max(0, ...steps.flatMap((s) => [s.open, s.close]));
  const top = 470, bot = 756, Y = (v) => bot - (v - lo) / (hi - lo || 1) * (bot - top);
  const x0 = PAD + 20, x1 = CARD_W - PAD - (o.equity ? 190 : 20), colW = (x1 - x0) / cols, bw = cols > 5 ? 64 : 84;
  let g = `<line x1="${PAD}" x2="${CARD_W - PAD}" y1="${Y(0)}" y2="${Y(0)}" stroke="${C.line2}" stroke-width="2" stroke-dasharray="3 12" stroke-linecap="round"/>
    <text x="${PAD}" y="${Y(0) - 14}" font-family="${MONO}" font-weight="500" font-size="16" letter-spacing="3" fill="${C.faint}">${o.amounts === "r" ? "0R" : "$0"}</text>
    <text x="${PAD}" y="424" font-family="${MONO}" font-weight="500" font-size="16" letter-spacing="4" fill="${C.muted}">THE WEEK, DAY BY DAY</text>`;
  steps.forEach((s, i) => {
    const cx = x0 + (i + 0.5) * colW, did = s.d.trades > 0, val = pick(s.d), up = val >= 0, c = tone(val);
    const yA = Y(s.open), yB = Y(s.close), yT = Math.min(yA, yB), h = Math.max(6, Math.abs(yA - yB));
    if (o.equity && i < cols - 1) g += `<line x1="${cx + bw / 2}" x2="${x0 + (i + 1.5) * colW - bw / 2}" y1="${yB}" y2="${yB}" stroke="${C.line2}" stroke-width="2" stroke-dasharray="2 8" stroke-linecap="round"/>`;
    if (did) {
      g += `<rect x="${cx - bw / 2}" y="${yT}" width="${bw}" height="${h}" rx="14" fill="${c}"/>`;
      if (o.best && s.d === best && val > 0 && traded.length > 1) g += `<rect x="${cx - bw / 2 - 7}" y="${yT - 7}" width="${bw + 14}" height="${h + 14}" rx="19" fill="none" stroke="${C.cobalt}" stroke-width="3"/>`;
      g += `<text x="${cx}" y="${up ? yT - 24 : yT + h + 40}" text-anchor="middle" font-family="${SANS}" font-weight="800" font-size="30" letter-spacing="-.8" fill="${c}">${amount(o, s.d.pnl, s.d.r)}</text>`;
    } else g += `<line x1="${cx - 22}" x2="${cx + 22}" y1="${yB}" y2="${yB}" stroke="${C.faint}" stroke-width="5" stroke-linecap="round"/><text x="${cx}" y="${yB - 22}" text-anchor="middle" font-family="${MONO}" font-weight="500" font-size="18" fill="${C.faint}">no trades</text>`;
    g += `<text x="${cx}" y="862" text-anchor="middle" font-family="${MONO}" font-weight="600" font-size="20" letter-spacing="5" fill="${did ? C.soft : C.faint}">${s.d.date.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase()}</text>
      <text x="${cx}" y="890" text-anchor="middle" font-family="${MONO}" font-weight="500" font-size="16" fill="${C.faint}">${s.d.date.toLocaleDateString("en-US", { month: "short" }).toUpperCase()} ${s.d.date.getDate()}</text>`;
    if (o.beads) {
      const beads = [...Array(s.d.wins).fill(C.up), ...Array(s.d.losses).fill(C.down), ...Array(s.d.be).fill(C.be)].slice(0, 8), bx0 = cx - (beads.length - 1) * 14;
      beads.forEach((b, k) => {
        g += `<circle cx="${bx0 + k * 28}" cy="924" r="7" fill="${b}"/>`;
      });
    }
  });
  if (o.equity && steps.length) {
    const last = steps[steps.length - 1];
    g += `<line x1="${x0 + (cols - 0.5) * colW + bw / 2}" x2="${x1 + 20}" y1="${Y(last.close)}" y2="${Y(last.close)}" stroke="${C.cobalt}" stroke-width="2" stroke-dasharray="2 8" stroke-linecap="round"/>${tag(x1 + 20, Y(last.close), big, 168)}`;
  }
  let tiles = "";
  if (o.stats) {
    const decided = w.wins + w.losses, tw = (CARD_W - PAD * 2 - 4 * 18) / 5, ty = 980;
    const list = [
      ["WIN RATE", decided ? `${Math.round(w.wins / decided * 100)}%` : "\u2014", C.text, decided ? `${w.wins} of ${decided}` : ""],
      ["TRADES", String(w.trades), C.text, `${traded.length} ${traded.length === 1 ? "day" : "days"}`],
      ["W \xB7 L \xB7 BE", `${w.wins} \xB7 ${w.losses} \xB7 ${w.be}`, C.text, ""],
      ["BEST DAY", best ? amount(o, best.pnl, best.r) : "\u2014", best ? tone(best.pnl) : C.text, best ? best.date.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase() : ""],
      ["WORST DAY", worst ? amount(o, worst.pnl, worst.r) : "\u2014", worst ? tone(worst.pnl) : C.text, worst ? worst.date.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase() : ""]
    ];
    tiles = list.map(([label, value, color, note], i) => {
      const x = PAD + i * (tw + 18);
      return `<rect x="${x}" y="${ty}" width="${tw}" height="118" rx="24" fill="${C.s1}" stroke="${C.line}" stroke-width="2"/><text x="${x + 28}" y="${ty + 38}" font-family="${MONO}" font-weight="500" font-size="16" letter-spacing="3.5" fill="${C.muted}">${label}</text>
        <text x="${x + 28}" y="${ty + 90}" font-family="${SANS}" font-weight="800" font-size="46" letter-spacing="-1.4" fill="${color}">${esc(value)}</text>${note ? `<text x="${x + tw - 28}" y="${ty + 90}" text-anchor="end" font-family="${MONO}" font-weight="500" font-size="17" fill="${C.faint}">${esc(note)}</text>` : ""}`;
    }).join("");
  }
  const head = `${o.brand ? wordmark(PAD, 56) : ""}
    <text x="${CARD_W - PAD}" y="86" text-anchor="end" font-family="${MONO}" font-weight="600" font-size="20" letter-spacing="4" fill="${C.soft}">WEEKLY PNL \xB7 WEEK ${w.no}</text>
    <text x="${CARD_W - PAD}" y="120" text-anchor="end" font-family="${MONO}" font-weight="500" font-size="17" letter-spacing="4" fill="${C.muted}">WEEK TOTAL \xB7 ${esc(w.label)}</text>
    <text x="${PAD - 6}" y="282" font-family="${SANS}" font-weight="800" font-size="156" letter-spacing="-6.5" fill="${hasTrades ? tone(w.pnl) : C.faint}">${hasTrades ? big : "\u2014"}</text>
    ${subline(title, hasTrades ? outcome(w.pnl, w.trades) : "no trades", hasTrades ? tone(w.pnl) : C.muted, 372, o.pill)}`;
  return { w: CARD_W, h: H, svg: frame(o, H, `${head}${g}${tiles}${foot(o.stats ? 1140 : 1010, w.instruments)}`) };
}
function monthSvg(m, o) {
  const H = 1040, first = new Date(m.year, m.month, 1), lead = (first.getDay() + 6) % 7, days = m.days.length;
  const rows = Math.ceil((lead + days) / 7), GAP = 10, calL = PAD, calR = 1030, wkW = 150, cw = (calR - calL - wkW - 7 * GAP) / 7;
  const gTop = 292, gBot = o.weekdays ? 880 : 940, CH = Math.min(118, (gBot - gTop - (rows - 1) * GAP) / rows);
  const pick = (d) => o.amounts === "r" ? d.r ?? 0 : d.pnl;
  const traded = m.days.filter((d) => d.trades), hasTrades = traded.length > 0, total = m.pnl;
  const maxAbs = Math.max(1, ...m.days.map((d) => Math.abs(d.pnl)));
  const best = traded.length ? traded.reduce((a, b) => b.pnl > a.pnl ? b : a) : null, worst = traded.length ? traded.reduce((a, b) => b.pnl < a.pnl ? b : a) : null;
  const X = (c) => calL + c * (cw + GAP);
  const weeks = [];
  for (let r = 0; r < rows; r++) {
    let s = 0, rr = 0, hasR = false, n = 0;
    for (let c = 0; c < 7; c++) {
      const d = m.days[r * 7 + c - lead];
      if (d && d.trades) {
        s += d.pnl;
        n++;
        if (d.r != null) {
          rr += d.r;
          hasR = true;
        }
      }
    }
    weeks.push({ pnl: s, r: hasR ? rr : null, n });
  }
  const maxWk = Math.max(1, ...weeks.map((x) => Math.abs(x.pnl)));
  let g = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((n, i) => `<text x="${X(i) + cw / 2 + 2}" y="${gTop - 16}" text-anchor="middle" font-family="${MONO}" font-weight="500" font-size="14" letter-spacing="4" fill="${i > 4 ? C.faint : C.muted}">${n}</text>`).join("") + `<text x="${calR - wkW / 2 + 2}" y="${gTop - 16}" text-anchor="middle" font-family="${MONO}" font-weight="600" font-size="14" letter-spacing="4" fill="${C.text}">WEEK</text>`;
  const vSize = (txt, wide) => {
    const n = txt.length;
    return n * 11.8 > wide ? Math.max(15, Math.floor(wide / (n * 0.56))) : cw < 112 ? 20 : 22;
  };
  for (let r = 0; r < rows; r++) {
    const y = gTop + r * (CH + GAP);
    for (let c = 0; c < 7; c++) {
      const x = X(c), idx = r * 7 + c - lead, d = m.days[idx], inM = idx >= 0 && idx < days, wkend = c > 4;
      if (!inM) {
        const n = idx < 0 ? new Date(m.year, m.month, 1 + idx).getDate() : idx - days + 1;
        g += `<rect x="${x + 1}" y="${y + 1}" width="${cw - 2}" height="${CH - 2}" rx="16" fill="none" stroke="${C.line}" stroke-width="2" stroke-dasharray="4 8"/><text x="${x + 12}" y="${y + 25}" font-family="${MONO}" font-weight="500" font-size="14" fill="${C.faint}" opacity=".6">${n}</text>`;
        continue;
      }
      const did = !!d && d.trades > 0;
      g += `<rect x="${x}" y="${y}" width="${cw}" height="${CH}" rx="16" fill="${wkend && !did ? "#131315" : C.s1}" ${did ? "" : `stroke="${C.line}" stroke-width="2"`}/>`;
      if (did) {
        const v = d.pnl, isBE = v === 0, c2 = isBE ? C.be : tone(v), mag = Math.sqrt(Math.abs(v) / maxAbs), txt = isBE ? "BE" : amount(o, d.pnl, d.r);
        g += ring(o, `d${idx}`, x, y, cw, CH, 16, c2, v < 0, isBE ? 0.75 : 0.5 + 0.45 * mag, 0.12 + 0.2 * mag);
        if (o.best && best && d === best && best.pnl > 0 && traded.length > 1) g += `<rect x="${x - 4}" y="${y - 4}" width="${cw + 8}" height="${CH + 8}" rx="20" fill="none" stroke="${C.cobalt}" stroke-width="3"/>`;
        g += `<text x="${x + 12}" y="${y + 25}" font-family="${MONO}" font-weight="500" font-size="14" fill="${C.muted}">${idx + 1}</text><text x="${x + cw / 2}" y="${y + CH * 0.68}" text-anchor="middle" font-family="${SANS}" font-weight="800" font-size="${vSize(txt, cw - 16)}" letter-spacing="-.6" fill="${c2}">${esc(txt)}</text>`;
        if (o.beads) [...Array(d.wins).fill(C.up), ...Array(d.losses).fill(C.down), ...Array(d.be).fill(C.be)].slice(0, 4).forEach((b, k) => {
          g += `<circle cx="${x + cw - 14 - k * 11}" cy="${y + 20}" r="3.6" fill="${b}"/>`;
        });
      } else g += `<text x="${x + 12}" y="${y + 25}" font-family="${MONO}" font-weight="500" font-size="14" fill="${C.faint}">${idx + 1}</text>${wkend ? "" : `<text x="${x + cw / 2}" y="${y + CH * 0.66}" text-anchor="middle" font-family="${MONO}" font-weight="500" font-size="17" fill="${C.faint}">\u2014</text>`}`;
    }
    const wk = weeks[r], wx = calR - wkW, wc = wk.n ? tone(wk.pnl) : C.faint, wtxt = wk.n ? amount(o, wk.pnl, wk.r) : "\u2014";
    g += `<rect x="${wx}" y="${y}" width="${wkW}" height="${CH}" rx="20" fill="${C.s2}" ${wk.n ? "" : `stroke="${C.line2}" stroke-width="2"`}/>${wk.n ? ring(o, `w${r}`, wx, y, wkW, CH, 20, wc, wk.pnl < 0, 0.9, 0.3) : ""}
      <text x="${wx + 18}" y="${y + 28}" font-family="${MONO}" font-weight="600" font-size="12" letter-spacing="3" fill="${C.muted}">WEEK ${r + 1}</text><text x="${wx + wkW - 16}" y="${y + 28}" text-anchor="end" font-family="${MONO}" font-weight="500" font-size="12" fill="${C.faint}">${wk.n}d</text>
      <text x="${wx + 18}" y="${y + CH * 0.62}" font-family="${SANS}" font-weight="800" font-size="${vSize(wtxt, wkW - 30) + 4}" letter-spacing="-.8" fill="${wc}">${esc(wtxt)}</text>
      <rect x="${wx + 18}" y="${y + CH - 22}" width="${wkW - 36}" height="6" rx="3" fill="${C.line}"/>${wk.n ? `<rect x="${wx + 18}" y="${y + CH - 22}" width="${(wkW - 36) * Math.max(0.06, Math.abs(wk.pnl) / maxWk)}" height="6" rx="3" fill="${wc}"/>` : ""}`;
  }
  if (o.weekdays) {
    const ty = gTop + rows * CH + (rows - 1) * GAP + 22;
    for (let c = 0; c < 7; c++) {
      let s = 0, rs = 0, n = 0, hasR = false;
      m.days.forEach((d, i) => {
        if ((lead + i) % 7 === c && d.trades) {
          s += d.pnl;
          n++;
          if (d.r != null) {
            rs += d.r;
            hasR = true;
          }
        }
      });
      g += `<rect x="${X(c)}" y="${ty}" width="${cw}" height="40" rx="20" fill="none" stroke="${C.line}" stroke-width="2"/><text x="${X(c) + cw / 2}" y="${ty + 26}" text-anchor="middle" font-family="${MONO}" font-weight="600" font-size="16" fill="${n ? tone(s) : C.faint}">${n ? esc(amount(o, s, hasR ? rs : null)) : "\u2014"}</text>`;
    }
    g += `<text x="${calR - wkW / 2}" y="${ty + 26}" text-anchor="middle" font-family="${MONO}" font-weight="500" font-size="12" letter-spacing="3" fill="${C.muted}">BY WEEKDAY</text>`;
  }
  const rx0 = 1090, rx1 = CARD_W - PAD, big = amount(o, total, m.r), title = o.title.trim() || m.name;
  let right = `<text x="${rx0}" y="150" font-family="${MONO}" font-weight="500" font-size="16" letter-spacing="4" fill="${C.muted}">MONTH TOTAL</text>
    <text x="${rx0 - 4}" y="246" font-family="${SANS}" font-weight="800" font-size="${big.length > 8 ? 76 : 92}" letter-spacing="-4" fill="${hasTrades ? tone(total) : C.faint}">${hasTrades ? esc(big) : "\u2014"}</text>`;
  let sTop = 360;
  if (o.equity) {
    let acc = 0;
    const pts = [[0, 0]];
    m.days.forEach((d, i) => {
      if (d.trades) {
        acc += pick(d);
        pts.push([i + 1, acc]);
      }
    });
    const eLo = Math.min(...pts.map((p) => p[1]), 0), eHi = Math.max(...pts.map((p) => p[1]), 0), ex1 = rx1 - 150, cTop = 360, cBot = o.stats ? 580 : 880;
    const PX = (k) => rx0 + k / days * (ex1 - rx0), EY = (v) => cBot - (v - eLo) / (eHi - eLo || 1) * (cBot - cTop);
    const path = pts.map((p, i) => `${i ? "L" : "M"}${PX(p[0])} ${EY(p[1])}`).join(" "), lastP = pts[pts.length - 1];
    right += `<text x="${rx0}" y="332" font-family="${MONO}" font-weight="500" font-size="14" letter-spacing="4" fill="${C.muted}">EQUITY, DAY BY DAY</text>
      <line x1="${rx0}" x2="${ex1 + 30}" y1="${EY(0)}" y2="${EY(0)}" stroke="${C.line2}" stroke-width="2" stroke-dasharray="3 10" stroke-linecap="round"/>
      <path d="${path} L${PX(lastP[0])} ${EY(0)} L${PX(0)} ${EY(0)}Z" fill="${tone(acc)}" fill-opacity=".08"/><path d="${path}" fill="none" stroke="#fff" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${pts.slice(1).map((p, i) => `<circle cx="${PX(p[0])}" cy="${EY(p[1])}" r="4.5" fill="${C.bg}" stroke="${tone(p[1] - pts[i][1])}" stroke-width="3"/>`).join("")}
      <line x1="${PX(lastP[0]) + 8}" x2="${ex1 + 10}" y1="${EY(lastP[1])}" y2="${EY(lastP[1])}" stroke="${C.cobalt}" stroke-width="2" stroke-dasharray="2 7" stroke-linecap="round"/>${tag(ex1 + 10, EY(lastP[1]), big, 140)}`;
    sTop = 626;
  }
  if (o.stats) {
    const decided = m.wins + m.losses, gd = traded.filter((d) => d.pnl > 0).length, rd = traded.filter((d) => d.pnl < 0).length, bed = traded.filter((d) => d.pnl === 0).length;
    const list = [
      ["WIN RATE", decided ? `${Math.round(m.wins / decided * 100)}%` : "\u2014", C.text],
      ["G \xB7 R \xB7 BE", `${gd} \xB7 ${rd} \xB7 ${bed}`, C.text],
      ["BEST DAY", best ? amount(o, best.pnl, best.r) : "\u2014", best ? tone(best.pnl) : C.text],
      ["WORST DAY", worst ? amount(o, worst.pnl, worst.r) : "\u2014", worst ? tone(worst.pnl) : C.text],
      ["AVG / DAY", traded.length ? amount(o, total / traded.length, m.r == null ? null : m.r / traded.length) : "\u2014", traded.length ? tone(total) : C.text],
      ["TOTAL R", o.amounts === "hide" ? "\u2022\u2022\u2022" : rFmt(m.r), m.r == null ? C.text : tone(m.r)]
    ];
    const sw = (rx1 - rx0 - 14) / 2, sh = o.equity ? 96 : 120, top = o.equity ? 626 : 360;
    list.forEach(([l, v, col], i) => {
      const sx = rx0 + i % 2 * (sw + 14), sy = top + Math.floor(i / 2) * (sh + 12);
      right += `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="22" fill="${C.s1}" stroke="${C.line}" stroke-width="2"/><text x="${sx + 22}" y="${sy + 34}" font-family="${MONO}" font-weight="500" font-size="13" letter-spacing="3" fill="${C.muted}">${l}</text><text x="${sx + 22}" y="${sy + sh - 22}" font-family="${SANS}" font-weight="800" font-size="36" letter-spacing="-1" fill="${col}">${esc(v)}</text>`;
    });
  }
  void sTop;
  const head = `${o.brand ? wordmark(PAD, 44) : ""}
    <text x="${CARD_W - PAD}" y="82" text-anchor="end" font-family="${MONO}" font-weight="600" font-size="19" letter-spacing="4" fill="${C.soft}">MONTHLY PNL</text>
    <text x="${CARD_W - PAD}" y="112" text-anchor="end" font-family="${MONO}" font-weight="500" font-size="15" letter-spacing="4" fill="${C.muted}">${m.name.toUpperCase()} ${m.year}</text>
    ${subline(title, hasTrades ? outcome(total, m.trades) : "no trades", hasTrades ? tone(total) : C.muted, 222, o.pill)}`;
  return { w: CARD_W, h: H, svg: frame(o, H, `${head}${g}${right}${foot(970, m.instruments)}`) };
}
var shareSvg = (kind, week, month, o) => kind === "week" ? weekSvg(week, o) : monthSvg(month, o);
export {
  CARD_W,
  DEFAULT_SHARE,
  isoWeek,
  keyOf,
  mondayOf,
  monthData,
  monthSvg,
  shareSvg,
  weekData,
  weekSvg
};
