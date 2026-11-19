import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../store.js";

/**
 * The administrator's record of itself. Every operation the AI runs on the server is written here (who asked, in which server, what, on whom,
 * whether the permission check passed, whether it was confirmed, the outcome and how long it took), to a file that survives restarts and to
 * the bot's log in the app. Warnings given to members are kept here too, so a member's moderation history can be shown later.
 */
const DIR = process.env.YSER_DATA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data");
const AUDIT = path.join(DIR, "audit.jsonl"), WARNS = path.join(DIR, "warnings.json");
const MAX_LINES = 3000;
const ensure = () => { try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* memory only */ } };

export function audit(entry) {
  const row = { at: new Date().toISOString(), ...entry };
  try { ensure(); fs.appendFileSync(AUDIT, JSON.stringify(row) + "\n"); } catch { /* the app log below still has it */ }
  void log("admin", { note: `${row.action}${row.target ? " " + row.target : ""} ${row.ok ? "ok" : "failed"}${row.error ? ": " + String(row.error).slice(0, 120) : ""}`, ...row }, !!row.ok).catch?.(() => {});
  return row;
}
export function recentAudit(n = 15, filter = () => true) {
  try {
    const lines = fs.readFileSync(AUDIT, "utf8").trim().split("\n");
    if (lines.length > MAX_LINES * 1.5) { ensure(); fs.writeFileSync(AUDIT, lines.slice(-MAX_LINES).join("\n") + "\n"); }
    return lines.slice(-MAX_LINES).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter(filter).slice(-n).reverse();
  } catch { return []; }
}

const readWarns = () => { try { return JSON.parse(fs.readFileSync(WARNS, "utf8")); } catch { return []; } };
export function addWarning({ guild, user, by, reason }) {
  const all = readWarns(); const row = { id: Math.random().toString(36).slice(2, 7), at: new Date().toISOString(), guild, user, by, reason: String(reason ?? "").slice(0, 300) };
  all.push(row);
  try { ensure(); fs.writeFileSync(WARNS, JSON.stringify(all.slice(-5000))); } catch { /* memory only */ }
  return row;
}
export const warningsOf = (guild, user) => readWarns().filter(w => w.guild === guild && w.user === user);
export const allWarnings = guild => readWarns().filter(w => w.guild === guild);