import { db, settings } from "../store.js";
import { env } from "../env.js";
import * as mem from "./memory.js";
import * as art from "./artifacts.js";
import * as conv from "./converse.js";

/**
 * Mirrors what the owner tells the assistant (saved preferences and the statements it noted) to the shared store, the same table the app's
 * assistant reads (assistant_memories, source "discord"), and loads them back on start. The same goes for artifacts: the exact content the
 * assistant made is mirrored to assistant_artifacts (so the app can read it), and the explanations the app's assistant gave (assistant_messages,
 * source "app") are read back as artifacts here, so "make an embed for what we talked about in the app" has something exact to work from.
 * Best effort: a failure never blocks an answer, and the local file stays the first copy. Only the owner's content is mirrored, and only text
 * that already passed the secret / permission filter.
 */
const SOURCE = "discord";
const owner = () => env.owners[0];
async function account() { const s = await settings().catch(() => null); return s?.owner ?? null; }
const missing = e => /does not exist|schema cache|relation/i.test(e?.message ?? "");

export async function push(text, kind = "preference") {
  if (!db) return;
  const uid = await account(); if (!uid) return;
  const { data } = await db.from("assistant_memories").select("id").eq("user_id", uid).eq("source", SOURCE).eq("text", text).maybeSingle();
  if (data) return;
  const { error } = await db.from("assistant_memories").insert({ user_id: uid, kind: kind === "fact" ? "fact" : "preference", text: text.slice(0, 600), source: SOURCE });
  if (error && !missing(error)) console.warn("memory sync:", error.message);
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
  if (error) { if (!missing(error)) console.warn("memory sync:", error.message); return 0; }
  let n = 0; for (const r of data ?? []) if (mem.addPrefRaw(owner(), r.text, { auto: r.kind === "fact" })) n++;
  if (n) console.log(`memory: loaded ${n} saved note${n === 1 ? "" : "s"} from the shared store`);
  return n;
}

/* ── artifacts ── */
const rowOf = (a, uid) => ({ id: a.id, user_id: uid, guild_id: a.guild === "*" ? null : a.guild, channel_id: a.channelId, type: a.type, subject: a.subject, subject_key: a.subjectKey, aspect: a.aspect, title: a.title, content: a.content, status: a.status, deliveries: a.deliveries, sources: a.sources, origin: a.origin, created_at: new Date(a.createdAt).toISOString(), updated_at: new Date(a.updatedAt).toISOString() });
const pending = new Map();
/** Mirrors one artifact (debounced, so an edit sequence is one write). Nothing that looks like a secret is ever copied. */
export function pushArtifact(a) {
  if (!db || a.owner !== owner() || a.origin === "app" || mem.looksSecret(a.content)) return;
  clearTimeout(pending.get(a.id));
  const t = setTimeout(async () => {
    pending.delete(a.id);
    try {
      const uid = await account(); if (!uid) return;
      const { error } = await db.from("assistant_artifacts").upsert(rowOf(a, uid), { onConflict: "id" });
      if (error && !missing(error)) console.warn("artifact sync:", error.message);
    } catch (e) { console.warn("artifact sync:", e?.message ?? e); }
  }, 1500);
  t.unref?.(); pending.set(a.id, t);
}
/** Loads the owner's artifacts that this process does not have (made in another session or place). */
export async function hydrateArtifacts() {
  if (!db || !owner()) return 0;
  const uid = await account(); if (!uid) return 0;
  const { data, error } = await db.from("assistant_artifacts").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(120);
  if (error) { if (!missing(error)) console.warn("artifact sync:", error.message); return 0; }
  const n = art.mergeRows(data, { owner: owner() });
  if (n) console.log(`memory: loaded ${n} artifact${n === 1 ? "" : "s"} from the shared store`);
  return n;
}
/** Reads the explanations the app's assistant gave (a question and its answer) and keeps them as artifacts here. */
export async function ingestAppTurns() {
  if (!db || !owner()) return 0;
  const uid = await account(); if (!uid) return 0;
  const { data, error } = await db.from("assistant_messages").select("thread_id,role,content,source,created_at").eq("user_id", uid).eq("source", "app").order("created_at", { ascending: false }).limit(80);
  if (error) { if (!missing(error)) console.warn("app turns:", error.message); return 0; }
  const rows = (data ?? []).reverse(), pairs = [];
  for (let i = 0; i < rows.length; i++) if (rows[i].role === "assistant" && rows[i - 1]?.role === "user" && rows[i - 1].thread_id === rows[i].thread_id) pairs.push({ q: rows[i - 1].content, a: rows[i].content, at: Date.parse(rows[i].created_at) || undefined });
  const n = conv.ingestExternal(owner(), pairs, { origin: "app" });
  if (n) console.log(`memory: kept ${n} explanation${n === 1 ? "" : "s"} from the app's assistant`);
  return n;
}

let started = false;
export async function start() {
  if (started) return; started = true;
  mem.onChange(e => { if (e.user !== owner()) return; void (e.type === "add" ? push(e.text, e.kind) : drop(e.text)).catch(() => {}); });
  art.onArtifact(pushArtifact);
  const all = () => Promise.all([hydrate(), hydrateArtifacts(), ingestAppTurns()]).catch(() => {});
  await all();
  setInterval(() => void all(), 15 * 60_000).unref?.();
}
