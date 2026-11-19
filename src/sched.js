import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { ZONE } from "./calendar/feed.js";
import { textPost } from "./post.js";

/**
 * Things to do later, on the owner's word: "in 30 seconds", "in 10 minutes", "at 5 pm", "every weekday at 9". Each job is saved to disk so a
 * restart never loses one. A job is { id, kind: "mod" | "send" | "countdown", args, runAt, repeat, channelId, guildId, ownerId }.
 */
const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/jobs.json");
let jobs = [];
try { jobs = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { /* none yet */ }
const save = () => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(jobs)); } catch { /* memory only */ } };
const short = () => Math.random().toString(36).slice(2, 6);

/** When a request says it runs: a delay in seconds/minutes/hours, or a New York clock time ("17:00", "5pm", "2026-11-20 09:30"). Returns ms or null. */
export function whenOf(args) {
  const delay = Number(args.delay_seconds) || (Number(args.delay_minutes) * 60) || (Number(args.delay_hours) * 3600) || 0;
  if (delay > 0) return Date.now() + delay * 1000;
  const at = String(args.at ?? "").trim();
  if (!at) return null;
  const m = /^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(at);
  if (!m) { const iso = DateTime.fromISO(at, { zone: ZONE }); return iso.isValid ? iso.toMillis() : null; }
  let h = Number(m[2]); const min = Number(m[3] ?? 0);
  if (m[4]) { h = h % 12 + (/pm/i.test(m[4]) ? 12 : 0); }
  const now = DateTime.now().setZone(ZONE);
  let when = (m[1] ? DateTime.fromISO(m[1], { zone: ZONE }) : now).set({ hour: h, minute: min, second: 0, millisecond: 0 });
  if (!m[1] && when <= now) when = when.plus({ days: 1 }); // a time already gone today means tomorrow
  return when.toMillis();
}
const REPEATS = ["daily", "weekdays", "weekly"];
const nextRun = job => {
  const t = DateTime.fromMillis(job.runAt, { zone: ZONE });
  let n = t.plus({ days: job.repeat === "weekly" ? 7 : 1 });
  if (job.repeat === "weekdays") while (n.weekday > 5) n = n.plus({ days: 1 });
  while (n.toMillis() <= Date.now()) n = n.plus({ days: job.repeat === "weekly" ? 7 : 1 });
  return n.toMillis();
};
const describe = job => {
  const t = DateTime.fromMillis(job.runAt, { zone: ZONE });
  const what = job.kind === "countdown" ? `countdown "${job.args.text ?? ""}"` : job.kind === "mod" ? `${job.args.action}${job.args.user ? ` ${job.args.user}` : ""}` : `send ${job.args.what ?? "text"}${job.args.channel ? ` to ${job.args.channel}` : ""}`;
  return `**${job.id}** · ${what} · ${t.toFormat("ccc d LLL, h:mm:ss a")} ${t.toFormat("ZZZZ")}${job.repeat ? ` · ${job.repeat}` : ""}`;
};

/** Saves a job for the moment the request names; returns the post that confirms it, or null if the request names no moment (run it now). */
export function schedule(message, kind, args) {
  const runAt = whenOf(args);
  if (!runAt) return null;
  const repeat = REPEATS.includes(String(args.repeat ?? "").toLowerCase()) ? String(args.repeat).toLowerCase() : null;
  const clean = { ...args }; for (const k of ["delay_seconds", "delay_minutes", "delay_hours", "at", "repeat"]) delete clean[k];
  // Who is meant is fixed now, from the tags in this message, so it still holds when the job runs.
  const tagged = [...message.mentions.users.values()].find(u => u.id !== message.client.user.id);
  if (tagged && !/\d{15,}/.test(String(clean.user ?? ""))) clean.user = tagged.id;
  const chan = message.mentions.channels?.first?.();
  if (chan && !clean.channel) clean.channel = chan.id;
  const job = { id: short(), kind, args: clean, runAt, repeat, channelId: message.channelId, guildId: message.guildId, ownerId: message.author.id };
  jobs.push(job); save();
  return textPost({ text: `⏰ Scheduled · ${describe(job)}\n-# Say "cancel ${job.id}" to stop it, or "what's scheduled" to list.` });
}
export const list = () => jobs.map(describe);
export function cancel(id) {
  const before = jobs.length;
  jobs = id === "all" ? [] : jobs.filter(j => j.id !== String(id).toLowerCase().replace(/^#/, ""));
  save();
  return before - jobs.length;
}
/** Saves a job built elsewhere (a temporary ban's unban, a workflow's later step). */
export function addJob(job) { const j = { id: short(), repeat: null, ...job }; jobs.push(j); save(); return j; }
export const addCountdown = (job) => { jobs.push({ id: short(), kind: "countdown", repeat: null, ...job }); save(); };

/** Called every second: runs what is due. `run(job)` does the work and returns a post to show in the channel the job was asked in (or null). */
export async function tick(client, run) {
  const now = Date.now();
  for (const job of [...jobs]) {
    if (job.kind === "countdown") {
      if (now < job.nextAt) continue;
      try {
        const channel = await client.channels.fetch(job.channelId), msg = await channel.messages.fetch(job.messageId);
        const left = Math.max(0, Math.round((job.runAt - now) / 1000));
        if (left <= 0) { await msg.edit({ content: `✅ **${job.args.text}** · now` }); jobs = jobs.filter(j => j !== job); save(); continue; }
        const m = Math.floor(left / 60), h = Math.floor(m / 60);
        await msg.edit({ content: `⏳ **${job.args.text}** · ${h ? `${h}h ${m % 60}m` : m ? `${m}m ${left % 60}s` : `${left}s`}` });
        job.nextAt = now + (left > 90 ? 15_000 : 5_000);
      } catch { jobs = jobs.filter(j => j !== job); save(); }
      continue;
    }
    if (now < job.runAt) continue;
    if (job.repeat) { job.runAt = nextRun(job); } else jobs = jobs.filter(j => j !== job);
    save();
    try {
      const post = await run(job);
      if (post) { const channel = await client.channels.fetch(job.channelId).catch(() => null); await channel?.send?.(post).catch(() => {}); }
    } catch { /* one bad job never stops the others */ }
  }
}
