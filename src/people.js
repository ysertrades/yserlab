import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Who is who. The bot remembers every name it has seen a person use (username, display name, nickname, and the names in the messages it
 * reads), so "tag Ahmed" or "@ahmed" in anything it posts becomes a real tag of the right person, with no member list or special permission.
 */
const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/people.json");
let people = {}; // id -> [names]
try { people = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { /* first run */ }
let timer = null;
const save = () => { clearTimeout(timer); timer = setTimeout(() => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(people)); } catch { /* read-only disk: memory only */ } }, 5000); };
const norm = s => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");

function add(id, names) {
  const list = (people[id] ??= []);
  let changed = false;
  for (const n of names) { const clean = String(n ?? "").trim(); if (clean && !list.includes(clean)) { list.push(clean); changed = true; } }
  if (list.length > 8) list.splice(0, list.length - 8);
  if (changed) save();
}
/** Learn from a message: its author, and anyone it mentions. */
export function remember(message) {
  const a = message.author;
  if (a && !a.bot) add(a.id, [a.username, a.globalName, message.member?.displayName, message.member?.nickname]);
  for (const u of message.mentions?.users?.values?.() ?? []) if (!u.bot) add(u.id, [u.username, u.globalName, message.guild?.members?.cache?.get(u.id)?.displayName]);
}
/** The id of the person a name means (exact name first, then the closest), or null. */
export function findPerson(name) {
  const q = norm(name);
  if (!q) return null;
  let best = null, score = 0;
  for (const [id, names] of Object.entries(people)) for (const n of names) {
    const k = norm(n);
    const s = k === q ? 100 : k.startsWith(q) ? 60 + q.length : k.includes(q) && q.length >= 3 ? 30 + q.length : 0;
    if (s > score) { best = id; score = s; }
  }
  return best;
}
export const nameOf = id => people[id]?.[0] ?? null;

/** "@ahmed said hi" -> "<@123> said hi". `@me` is the owner. Names that aren't known stay as written. */
export function tagText(text, { me } = {}) {
  return String(text ?? "").replace(/@([\p{L}\p{N}_.\-]+)(?: ([\p{L}\p{N}_.\-]+))?/gu, (whole, first, second) => {
    if (/^me$/i.test(first) && me) return `<@${me}>` + (second ? " " + second : "");
    if (/^(everyone|here)$/i.test(first)) return whole;
    if (second) { const both = findPerson(`${first} ${second}`); if (both) return `<@${both}>`; }
    const one = findPerson(first);
    return one ? `<@${one}>` + (second ? " " + second : "") : whole;
  });
}
