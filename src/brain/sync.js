import { db, settings } from "../store.js";
import { env } from "../env.js";
import * as mem from "./memory.js";

/**
 * Mirrors what the owner tells the assistant (saved preferences and the statements it noted) to the shared store, the same table the app's
 * assistant reads (assistant_memories, source "discord"), and loads them back on start. Best effort: a failure never blocks an answer, and
 * the local file stays the first copy. Only the owner's notes are mirrored, and only text that already passed the secret / permission filter.
 */
const SOURCE = "discord";
const owner = () => env.owners[0];
async function account() { const s = await settings().catch(() => null); return s?.owner ?? null; }

export async function push(text, kind = "preference") {
  if (!db) return;
  const uid = await account(); if (!uid) return;
  const { data } = await db.from("assistant_memories").select("id").eq("user_id", uid).eq("source", SOURCE).eq("text", text).maybeSingle();
  if (data) return;
  const { error } = await db.from("assistant_memories").insert({ user_id: uid, kind: kind === "fact" ? "fact" : "preference", text: text.slice(0, 600), source: SOURCE });
  if (error && !/does not exist|schema cache/i.test(error.message)) console.warn("memory sync:", error.message);
}
export async function drop(text) {
  if (!db) return;
  const uid = await account(); if (!uid) return;
  await db.from("assistant_memories").delete().eq("user_id", uid).eq("source", SOURCE).eq("text", text);
}
/** Loads the owner's mirrored notes into the local memory (anything not already there). */
export async function hydrate() {
  if (!db || !owner()) return 0;
  const uid = await account(); if (!uid) return 0;
  const { data, error } = await db.from("assistant_memories").select("kind,text").eq("user_id", uid).eq("source", SOURCE).order("created_at", { ascending: true }).limit(200);
  if (error) { if (!/does not exist|schema cache/i.test(error.message)) console.warn("memory sync:", error.message); return 0; }
  let n = 0; for (const r of data ?? []) if (mem.addPrefRaw(owner(), r.text, { auto: r.kind === "fact" })) n++;
  if (n) console.log(`memory: loaded ${n} saved note${n === 1 ? "" : "s"} from the shared store`);
  return n;
}
let started = false;
export async function start() {
  if (started) return; started = true;
  mem.onChange(e => { if (e.user !== owner()) return; void (e.type === "add" ? push(e.text, e.kind) : drop(e.text)).catch(() => {}); });
  await hydrate().catch(() => {});
  setInterval(() => void hydrate().catch(() => {}), 15 * 60_000).unref?.();
}
