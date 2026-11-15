import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";
import { DEFAULTS, merge } from "./config.js";

/** The bot's side of Supabase: it reads the control panel's settings, your trades and charts, and writes its status and log. */
export const db = env.supabaseKey ? createClient(env.supabaseUrl, env.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } }) : null;

let current = { config: merge(DEFAULTS, {}), owner: null, at: 0 };
/** The current settings (re-read at most every 10 seconds). `owner` is your account's user id in the app. */
export async function settings(force = false) {
  if (!db) return current;
  if (!force && Date.now() - current.at < 10_000) return current;
  try {
    const { data, error } = await db.from("bot_config").select("owner_user,data").eq("id", "main").maybeSingle();
    if (error) throw error;
    current = { config: merge(DEFAULTS, data?.data ?? {}), owner: data?.owner_user ?? current.owner, at: Date.now() };
  } catch (e) {
    current = { ...current, at: Date.now() - 5_000 }; // keep what we had, try again soon
    if (!/does not exist|schema cache/i.test(String(e?.message))) console.warn("settings:", e?.message ?? e);
  }
  return current;
}

/** Marks a one-time thing as done (a post for one release, one day's card...). False when it was already done, so nothing posts twice. */
export async function once(key) {
  if (!db) return true;
  const { error } = await db.from("bot_sent").insert({ key });
  if (!error) return true;
  if (error.code === "23505") return false;
  console.warn("once:", error.message);
  return false;
}
export async function wasDone(key) {
  if (!db) return false;
  const { data } = await db.from("bot_sent").select("key").eq("key", key).maybeSingle();
  return !!data;
}

/** One line of the log shown in the app: what was posted (or why not). */
export async function log(kind, detail = {}, ok = true) {
  console.log(`[${ok ? "ok" : "fail"}] ${kind}`, detail.note ?? detail.error ?? "");
  if (!db) return;
  const { error } = await db.from("bot_log").insert({ kind, ok, detail });
  if (error && !/does not exist|schema cache/i.test(error.message)) console.warn("log:", error.message);
}

export async function writeStatus(data) {
  if (!db) return;
  const { error } = await db.from("bot_status").upsert({ id: "main", data, updated_at: new Date().toISOString() });
  if (error && !/does not exist|schema cache/i.test(error.message)) console.warn("status:", error.message);
}

/** Your trades, newest first. */
export async function entries(owner) {
  if (!db || !owner) return [];
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("entries").select("*").eq("user_id", owner).is("deleted_at", null).order("trade_date", { ascending: false }).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) break;
  }
  return rows;
}
export async function tags(owner) {
  if (!db || !owner) return [];
  const { data } = await db.from("tags").select("id,name,kind").eq("user_id", owner).is("deleted_at", null);
  return data ?? [];
}
export async function chartRow(id) {
  const { data } = await db.from("charts").select("*").eq("id", id).maybeSingle();
  return data;
}
/** A picture from the charts bucket, as bytes. */
export async function chartBytes(path) {
  const { data, error } = await db.storage.from("charts").download(path);
  if (error || !data) throw new Error(error?.message ?? "chart not found");
  return Buffer.from(await data.arrayBuffer());
}
/** The trading model you uploaded (read from your PDFs in the app), or null. */
export async function model(owner) {
  if (!db || !owner) return null;
  try {
    const { data } = await db.storage.from("charts").download(`${owner}/models/model.json`);
    return data ? JSON.parse(await data.text()) : null;
  } catch { return null; }
}
