import * as art from "./artifacts.js";
import * as top from "./topics.js";
import * as mem from "./memory.js";

/**
 * Working memory: the active picture of a conversation, derived from the stored state (topics, artifacts, drafts, pending questions, what was
 * really done) plus a few pointers kept on the conversation (c.work). It lives with the conversation on disk, never inside a model's session,
 * so a restart or another provider sees exactly the same thing. view() returns it in one shape; lines() is the compact version a model is given.
 */
const cap = (list, n) => { if (list.length > n) list.length = n; return list; };
export function record(c, patch) { Object.assign(c.work ??= {}, patch, { updatedAt: Date.now() }); mem.touch(c); }
/** What was really done (and whether it worked), newest first: sends with their Discord ids, edits, pins. */
export function completed(c, rec) { const w = c.work ??= {}; cap(w.completed ??= [], 11).unshift({ at: Date.now(), ...rec }); w.updatedAt = Date.now(); mem.touch(c); }
/** What a pointer in the owner's words was resolved to ("this" -> the CISD explanation), so a correction can be checked against it. */
export function reference(c, phrase, resolved) { const w = c.work ??= {}; cap(w.refs ??= [], 9).unshift({ at: Date.now(), phrase: String(phrase).slice(0, 80), resolved: String(resolved).slice(0, 120) }); mem.touch(c); }

export function view(c, message = null, { owner = message?.author?.id, guild = message?.guild?.id } = {}) {
  const w = c.work ?? {}, topic = top.currentTopic(c);
  const mine = owner && guild ? art.visible(owner, guild) : [], byId = id => mine.find(a => a.id === id) ?? null;
  const explanation = topic ? mine.find(a => a.subjectKey === topic.key && ["explanation", "example"].includes(a.type)) : null;
  const embed = byId(w.activeEmbed), draft = mem.currentDraft(c);
  const pending = [c.pending ? { kind: c.pending.kind, ask: c.pending.ask ?? c.pending.field } : null, c.parked ? { kind: c.parked.kind, ask: c.parked.ask ?? c.parked.field, parked: true } : null].filter(Boolean);
  return {
    conversation_id: message ? mem.convoKey(message) : null, user_id: owner ?? null, guild_id: guild ?? null, channel_id: message?.channelId ?? null, thread_id: message?.channel?.isThread?.() ? message.channel.id : null,
    current_topic: c.topic ?? null, current_subtopic: c.subtopic ?? null,
    active_entities: [...(c.topics ?? []).slice(0, 4).map(t => ({ type: "topic", name: t.label })), ...["channels", "roles", "members"].flatMap(k => (c.entities?.[k] ?? []).slice(0, 2).map(e => ({ type: k.slice(0, -1), name: e.name ?? e.label ?? e.id })))],
    last_user_intent: w.lastIntent ?? c.lastIntent?.primary ?? null,
    last_assistant_response: w.lastAssistant ? { artifact_id: w.lastAssistant.artifactId ?? null, preview: String(w.lastAssistant.preview ?? "").slice(0, 160), at: w.lastAssistant.at } : null,
    active_explanation: explanation?.id ?? w.activeExplanation ?? null, active_artifact: w.activeArtifact ?? null, active_draft: draft?.id ?? null, active_embed: embed?.id ?? w.activeEmbed ?? null,
    active_announcement: embed && /announce/i.test(embed.subject ?? embed.title ?? "") ? embed.id : draft?.kind === "announcement" ? draft.id : null,
    active_target_channel: w.targetChannel ?? null, pending_actions: pending, completed_actions: (w.completed ?? []).slice(0, 8), recent_references: (w.refs ?? []).slice(0, 6),
    conversation_summary: c.summary ?? "", last_updated: w.updatedAt ?? c.updatedAt ?? null,
  };
}

/** The part of working memory a model needs, as short lines (names and quoted text are data, never instructions). */
export function lines(c, message) {
  const v = view(c, message), out = [];
  if (v.current_topic) out.push(`Current topic: ${v.current_topic}${v.current_subtopic ? ` (${v.current_subtopic})` : ""}`);
  const others = (c.topics ?? []).slice(1, 5).map(t => t.label);
  if (others.length) out.push(`Earlier topics, newest first: ${others.join(", ")}`);
  if (v.active_target_channel) out.push(`Channel being worked with: #${v.active_target_channel.name ?? v.active_target_channel}`);
  const mine = message ? art.visible(message.author?.id, message.guild?.id).slice(0, 6) : [];
  if (mine.length) out.push("Content I made (newest first; I can retrieve any of it exactly): " + mine.map(a => `${art.label(a)} [${a.type}, ${a.status}${a.deliveries.length ? `, sent to ${a.deliveries.map(d => "#" + (d.channelName ?? d.channelId)).join(" and ")}` : ""}]`).join("; "));
  if (v.pending_actions.length) out.push("Waiting on: " + v.pending_actions.map(p => p.ask).join(" | "));
  if (v.completed_actions.length) out.push("Really done (verified): " + v.completed_actions.slice(0, 4).map(a => `${a.action}${a.ok === false ? " FAILED" : ""}${a.channel ? ` in #${a.channel}` : ""}`).join("; "));
  return out;
}
