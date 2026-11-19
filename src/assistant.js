import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";
import { db, settings } from "./store.js";
import { ask, called, TOOLS } from "./ai.js";
import { SMT_RULES } from "./smtLesson.js";

/**
 * The bot's side of the unified assistant (the Supabase Edge Function "assistant", see charts/supabase/functions/assistant):
 *  - askUnified: sends a Discord message to the same brain the app uses, so memory, conversations and the journal tools are shared. The
 *    Discord-only actions (drawing, moderation, sending, PnL cards, trade charts, scheduling) stay here: the bot hands their declarations
 *    to the function, and when the model picks one the function returns it for the bot to run, exactly like before.
 *  - If the function is unreachable, not deployed or errors, the bot's own answer path (ai.js, Groq then Gemini) answers as it always did.
 *  - ensureLink: maps the owner's Discord id to the owner's account (the function only trusts this table for the bot's calls).
 *  - publishKnowledge: puts the education center's search index in a private bucket so the app can use it too.
 */
const FUNCTION = () => `${env.supabaseUrl}/functions/v1/assistant`;
const clientTools = TOOLS[0].functionDeclarations;
let lastError = null;

export async function askUnified({ owner, channelId, discordId, text, context }) {
  if (env.unifiedAi !== false && env.supabaseKey && discordId) {
    try {
      const res = await fetch(FUNCTION(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.supabaseKey}`, apikey: env.supabaseKey },
        body: JSON.stringify({ task: "chat", discord_id: discordId, message: text, channel: channelId, client_tools: clientTools, context }),
        signal: AbortSignal.timeout(65_000),
      });
      const out = await res.json().catch(() => ({}));
      if (res.ok && (out.answer || out.client_call)) {
        lastError = null;
        if (out.client_call) { const mapped = called(out.client_call.name, out.client_call.args); if (mapped) return mapped; }
        if (out.answer) return { text: out.answer, via: "assistant", tools: out.tools, model: out.model };
      }
      const why = out.error ?? `status ${res.status}`;
      if (why !== lastError) console.warn("assistant:", why);
      lastError = why;
    } catch (e) {
      if (e.message !== lastError) console.warn("assistant:", e.message);
      lastError = e.message;
    }
  }
  return ask({ owner, channelId, text }); // the bot's own answer, as before
}
export const assistantError = () => lastError;

/** Tells the assistant what the bot just did for the owner (a moderation result, a card, a reminder), so the conversation remembers the outcome. */
export async function noteResult(discordId, text) {
  if (env.unifiedAi === false || !env.supabaseKey || !discordId || !text) return;
  try {
    await fetch(FUNCTION(), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.supabaseKey}`, apikey: env.supabaseKey }, body: JSON.stringify({ task: "note", discord_id: discordId, text: String(text).slice(0, 1500) }), signal: AbortSignal.timeout(15_000) });
  } catch { /* the note is a courtesy; the answer already went out */ }
}

/** The last messages in the channel, and the one being replied to, as plain lines: what "that" and "it" refer to when the owner follows up. */
export async function channelContext(message) {
  try {
    const lines = [];
    const name = m => m.author?.id === message.client.user.id ? "You (YSER Lab)" : (m.member?.displayName ?? m.author?.username ?? "someone");
    // A Components V2 message has no content: its words live in its text displays, so they are collected from there (otherwise an embed the bot just posted is invisible to what follows).
    const inside = c => [typeof c?.content === "string" ? c.content : "", ...(c?.components ?? []).map(inside)].filter(Boolean).join(" ");
    const text = m => String(m.content || (m.components?.length ? (m.components.map(inside).join(" ") ? "[embed] " + m.components.map(inside).join(" ") : "") : "") || (m.embeds?.[0]?.description ?? m.embeds?.[0]?.title ?? "") || (m.attachments?.size ? "[attachment]" : "")).replace(/\s+/g, " ").slice(0, 420);
    const batch = await message.channel.messages.fetch({ limit: 12, before: message.id });
    for (const m of [...batch.values()].reverse()) { const t = text(m); if (t) lines.push(`${name(m)}: ${t}`); }
    if (message.reference?.messageId) {
      const ref = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
      if (ref) lines.push(`(They are replying to this message from ${name(ref)}: ${text(ref)})`);
    }
    return "[How to answer: do what was asked right away. Ask a question only if something essential is truly missing, never about something already said. Use only facts the owner gave; never invent amounts, prizes, times, links or names. When they say \"it\" or \"that\", it is the latest thing above.]\n" + lines.join("\n");
  } catch { return ""; }
}

/** The owner's Discord id, tied to the owner's account, so the function can tell whose data a Discord message is about. */
export async function ensureLink() {
  if (!db || !env.owners.length) return;
  try {
    const { owner } = await settings(true);
    if (!owner) return;
    const { error } = await db.from("discord_links").upsert({ discord_id: env.owners[0], user_id: owner }, { onConflict: "discord_id" });
    if (error && !/does not exist|schema cache/i.test(error.message)) console.warn("link:", error.message);
  } catch (e) { console.warn("link:", e.message); }
}

/** Uploads knowledge/ttrades/kb.json (and the SMT rules) to the private "knowledge" bucket when it changed (the function reads it from there). */
export async function publishKnowledge() {
  if (!db) return;
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../knowledge/ttrades/kb.json");
    if (!fs.existsSync(file)) return;
    const bytes = fs.readFileSync(file);
    const hash = createHash("sha1").update(bytes).update(SMT_RULES).digest("hex");
    const meta = await db.storage.from("knowledge").download("ttrades/kb.hash").then(r => (r.data ? r.data.text() : "")).catch(() => "");
    if (meta.trim() === hash) return;
    const up = await db.storage.from("knowledge").upload("ttrades/kb.json", bytes, { upsert: true, contentType: "application/json", cacheControl: "0" });
    if (up.error) throw new Error(up.error.message);
    // The owner's own rules for SMT, 2S/3S, the strength switch and PSP: authoritative, so the assistant reads them too.
    await db.storage.from("knowledge").upload("owner/smt.txt", Buffer.from(SMT_RULES), { upsert: true, contentType: "text/plain", cacheControl: "0" });
    await db.storage.from("knowledge").upload("ttrades/kb.hash", Buffer.from(hash), { upsert: true, contentType: "text/plain", cacheControl: "0" });
    console.log(`education center published for the assistant (${Math.round(bytes.length / 1024)} KB)`);
  } catch (e) { console.warn("knowledge:", e.message); }
}
