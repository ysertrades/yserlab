import * as mem from "./memory.js";

/**
 * Artifact memory: the exact content the assistant generated (an explanation, an example, a lesson, an embed, an announcement), kept whole
 * and addressable, with its versions, whether it was approved, and where it was really delivered (the Discord channel and message ids that
 * Discord returned). A conversation is a sequence of turns; an artifact is a thing. "Make an embed for this", "make it shorter", "send it",
 * "pin it" all act on an artifact, so the content is never reconstructed from a summary.
 *
 * Scope: an artifact belongs to ONE owner in ONE server and remembers the channel it was made in; nothing here ever returns another person's
 * artifacts. Artifacts outlive conversations (30 days, longer when saved), so a restart or a new conversation can still find them. Stored text
 * is data: whatever it says, it is never treated as an instruction (see scrub()).
 */
export const LIMIT = { perOwner: 150, content: 12_000, versions: 12, days: 30 };
const uid = () => "a_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
const all = () => mem.getStore().artifacts;
let listener = null;
/** Lets the sync layer mirror artifacts to the shared store without this file knowing about it. */
export const onArtifact = fn => { listener = fn; };
const changed = a => { mem.saveSoon(); try { listener?.(a); } catch { /* a mirror failing never blocks memory */ } return a; };

export const TYPES = ["explanation", "example", "lesson", "quiz", "slides", "bullets", "summary", "guide", "announcement", "embed", "draft", "message"];
export const isContent = a => !!a && a.type !== "message" && a.status !== "deleted";

/** Makes an artifact. `sources` are the ids of the artifacts it was made from (kept both ways). */
export function create({ owner, guild, channelId, convoKey, sourceMessageId, type = "explanation", subject = "", subjectKey = null, aspect = null, title = "", content, sources = [], group = null, origin = "discord", status = "generated", meta = {}, at = null }) {
  const text = String(content ?? "").slice(0, LIMIT.content);
  const now = at ?? Date.now();
  const a = { id: uid(), owner, guild, channelId: channelId ?? null, convoKey: convoKey ?? null, sourceMessageId: sourceMessageId ?? null, type, subject, subjectKey: subjectKey ?? (subject ? String(subject).toLowerCase() : null), aspect, title, original: text, content: text,
    versions: [{ content: text, at: now, note: "created" }], status, approvedVersion: null, deliveries: [], sources: [...sources], derived: [], group, origin, meta, createdAt: now, updatedAt: now };
  all().unshift(a);
  for (const sid of sources) { const s = get(sid); if (s && !s.derived.includes(a.id)) s.derived.push(a.id); }
  prune(owner, guild);
  return changed(a);
}
export const get = id => all().find(a => a.id === id) ?? null;
/** Oldest-first order that is exact even when two artifacts were made in the same millisecond: the store is newest first, so a larger index is older. */
export const chronological = (x, y) => all().indexOf(y) - all().indexOf(x);
/** Artifacts a person may use: theirs, in this server, newest first. Never anyone else's. */
/** `guild: "*"` marks content that came from the app: it belongs to the person, not to one server, so it is usable in all of their servers. */
export const visible = (owner, guild, { types, subjectKey, channelId, includeDeleted = false } = {}) =>
  all().filter(a => a.owner === owner && (a.guild === guild || a.guild === "*") && (includeDeleted || a.status !== "deleted") && (!types || types.includes(a.type)) && (!subjectKey || a.subjectKey === subjectKey) && (!channelId || a.channelId === channelId));
export const latest = (owner, guild, opts) => visible(owner, guild, opts)[0] ?? null;

/** A new version of the content (an edit, a shorter version). The earlier versions stay, and an edited artifact is no longer an approved one. */
export function revise(a, content, note = "edited") {
  const text = String(content ?? "").slice(0, LIMIT.content);
  a.versions.push({ content: text, at: Date.now(), note }); if (a.versions.length > LIMIT.versions) a.versions.splice(1, 1); // the original always stays
  a.content = text; a.updatedAt = Date.now();
  if (a.status === "approved" || a.status === "sent") a.status = a.status === "sent" ? "edited" : "draft";
  return changed(a);
}
export function setStatus(a, status) { a.status = status; a.updatedAt = Date.now(); if (status === "approved") a.approvedVersion = a.versions.length; return changed(a); }
/** A real delivery: the Discord channel and message ids Discord gave back. Nothing is recorded as sent without them. */
export function addDelivery(a, { channelId, messageId, url = null, channelName = null }) {
  if (!channelId || !messageId) return a;
  if (!a.deliveries.some(d => d.messageId === messageId)) a.deliveries.push({ channelId, channelName, messageId, url, version: a.versions.length, at: Date.now() });
  a.status = "sent"; a.updatedAt = Date.now(); return changed(a);
}
export const lastDelivery = a => a?.deliveries.at(-1) ?? null;
export function remove(a, why = "deleted") { a.status = "deleted"; a.updatedAt = Date.now(); a.meta = { ...a.meta, removed: why }; return changed(a); }
export function link(sourceIds, derived) { for (const sid of sourceIds) { const s = get(sid); if (s) { if (!s.derived.includes(derived.id)) s.derived.push(derived.id); if (!derived.sources.includes(sid)) derived.sources.push(sid); } } return changed(derived); }

/** Keeps each person's newest artifacts, always the saved and approved ones, and nothing older than the limit. */
export function prune(owner, guild) {
  const list = all(), now = Date.now(), keep = a => a.status === "approved" || a.meta?.saved;
  for (let i = list.length - 1; i >= 0; i--) if (!keep(list[i]) && now - list[i].updatedAt > LIMIT.days * 86_400_000) list.splice(i, 1);
  const mine = list.filter(a => a.owner === owner && a.guild === guild);
  for (const a of mine.slice(LIMIT.perOwner).filter(x => !keep(x))) list.splice(list.indexOf(a), 1);
}

/** Text from stored content, made safe to hand to a model as DATA: lines that read like instructions to it are dropped, mentions made harmless. */
const INSTRUCTION = /\b(ignore|disregard|forget|override|bypass)\b.{0,60}\b(instructions?|rules?|previous|above|prompt|system)\b|\bsystem (prompt|override|message)\b|\byou (must|are now|will now)\b|\bnew instructions?\b|\b(ban|kick|delete|purge|remove) (everyone|everything|all|every)\b/i;
export function scrub(text) {
  return String(text ?? "").replace(/[​-‏⁠﻿­]/g, "").split("\n").map(l => l.split(/(?<=[.!?])\s+/).filter(s => !INSTRUCTION.test(s.normalize("NFKC"))).join(" ")) // a sentence that talks to the model is dropped, the rest of the line stays
    .join("\n").replace(/@(everyone|here)/gi, "@​$1").replace(/<@&?\d+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
/** Whether stored content carried something that read like an instruction (the caller can mention that it was left out). */
export const hadInstructions = text => String(text ?? "").split(/\n|(?<=[.!?])\s+/).some(l => INSTRUCTION.test(l.normalize("NFKC")));

/** A short, honest label for an artifact in lists and questions. */
export const label = a => `${a.subject || a.title || a.type}${a.aspect && a.aspect !== "definition" ? ` (${a.aspect})` : ""}`;

export const ownedBy = owner => all().filter(a => a.owner === owner);
/** A short fingerprint of a text, to tell whether the same content was already imported. */
export const hash = text => { let h = 5381; for (const ch of String(text ?? "")) h = ((h << 5) + h + ch.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
/** Merges rows that came back from the shared store (another place's artifacts of the same owner) without touching what is already here. */
export function mergeRows(rows, { owner }) {
  let n = 0;
  for (const r of rows ?? []) {
    if (!r?.id || !r.content || get(r.id)) continue;
    const created = Date.parse(r.created_at ?? r.createdAt ?? "") || Date.now();
    all().push({ id: r.id, owner, guild: r.guild_id || "*", channelId: r.channel_id ?? null, convoKey: null, sourceMessageId: null, type: r.type ?? "explanation", subject: r.subject ?? "", subjectKey: r.subject_key ?? (r.subject ? String(r.subject).toLowerCase() : null), aspect: r.aspect ?? null,
      title: r.title ?? "", original: r.content, content: r.content, versions: [{ content: r.content, at: created, note: "imported" }], status: r.status === "sent" ? "sent" : "generated", approvedVersion: null, deliveries: Array.isArray(r.deliveries) ? r.deliveries : [], sources: [], derived: [], group: null, origin: r.origin ?? "app", meta: { imported: true }, createdAt: created, updatedAt: created });
    n++;
  }
  if (n) { all().sort((x, y) => y.createdAt - x.createdAt); mem.saveSoon(); }
  return n;
}
