import { DateTime } from "luxon";

/**
 * Dates and times from plain words, in New York time (the trading day's clock): "tomorrow at 6pm", "Friday 9:30", "November 20 at 17:00",
 * "2026-11-20 18:00". A date can also be taken from a hint (the announcement the event is for says "Friday, November 20"). Never guesses a
 * time of day: when only a date is known it says the time is missing.
 */
const ZONE = "America/New_York";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export function timeOf(t) {
  const s = String(t ?? "").toLowerCase();
  let m = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/.exec(s);
  if (m) { let h = Number(m[1]) % 12; if (m[3].startsWith("p")) h += 12; if (Number(m[1]) > 12 || Number(m[1]) < 1) return null; return { h, min: Number(m[2] ?? 0) }; }
  m = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(s);
  if (m) return { h: Number(m[1]), min: Number(m[2]) };
  m = /\bat\s+(\d{1,2})\b(?!\s*(?:st|nd|rd|th|\/|-))/.exec(s); // "at 6": taken as 24-hour only when unambiguous
  if (m && Number(m[1]) >= 13 && Number(m[1]) <= 23) return { h: Number(m[1]), min: 0 };
  return null;
}

export function dateOf(t, now = DateTime.now().setZone(ZONE)) {
  const s = String(t ?? "").toLowerCase(), today = now.startOf("day");
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (m) { const d = DateTime.fromObject({ year: +m[1], month: +m[2], day: +m[3] }, { zone: ZONE }); return d.isValid ? d : null; }
  m = new RegExp(`\\b(${MONTHS.map(x => x + "[a-z]*").join("|")})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(s) ?? new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.map(x => x + "[a-z]*").join("|")})\\b`).exec(s);
  if (m) {
    const monthWord = /^\d/.test(m[1]) ? m[2] : m[1], day = Number(/^\d/.test(m[1]) ? m[1] : m[2]), month = MONTHS.findIndex(x => monthWord.startsWith(x)) + 1;
    let d = DateTime.fromObject({ year: today.year, month, day }, { zone: ZONE });
    if (d.isValid && d < today) d = d.plus({ years: 1 });
    return d.isValid ? d : null;
  }
  if (/\btomorrow\b/.test(s)) return today.plus({ days: 1 });
  if (/\b(today|tonight)\b/.test(s)) return today;
  const w = DAYS.findIndex(x => new RegExp(`\\b${x}\\b`).test(s));
  if (w >= 0) { const diff = (w + 1 - today.weekday + 7) % 7 || 7; return today.plus({ days: diff }); }
  return null;
}

/** { at: "YYYY-MM-DD HH:mm" } when both a date and a time are known, { needTime } when only the date is, { problem } otherwise. */
export function parseWhen(text, { hint, now = DateTime.now().setZone(ZONE) } = {}) {
  const tm = timeOf(text), d = dateOf(text, now) ?? (hint ? dateOf(hint, now) : null);
  if (!tm) return d ? { needTime: true, date: d.toFormat("yyyy-MM-dd") } : { problem: "I need a day and a time for that." };
  let when = d ?? now.startOf("day");
  when = when.set({ hour: tm.h, minute: tm.min });
  if (!d && when <= now) when = when.plus({ days: 1 }); // only a time was given and it has passed today: the next one
  return { at: when.toFormat("yyyy-MM-dd HH:mm"), dt: when };
}
