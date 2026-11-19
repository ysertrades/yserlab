import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The assistant's structured memory, in four layers that are read and written independently of any language model (so switching provider
 * never loses context):
 *  - conversation (short-term): topic, recent turns, tracked entities (channels, members, roles, messages), the last list shown, drafts with
 *    their versions and whether each was sent, pending questions, corrections, and a rolling summary of older turns;
 *  - preferences (long-term): what the owner asked to be remembered, per user, never anything that looks like a secret;
 *  - operations (operational): what was really done, with Discord ids, used for idempotency and for "do that again";
 *  - feedback: structured records of corrections, kept for the evaluation set and never fed back into prompts automatically.
 * One conversation per person per server (not per channel), because "send it here" is said in whichever channel the owner is standing in.
 */
const DIR = process.env.YSER_DATA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data");
const FILE = path.join(DIR, "brain.json");
const LIMITS = { turns: 24, entities: 12, versions: 12, ops: 400, feedback: 300, drafts: 12 };
export const TTL = { pending: 30 * 60_000, convo: 7 * 86_400_000 };

let store = { convos: {}, prefs: {}, ops: [], feedback: [] };
try { store = { ...store, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { /* first run */ }
let timer = null;
export const flush = () => { clearTimeout(timer); try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(store)); } catch { /* read-only disk: memory only */ } };
const save = () => { clearTimeout(timer); timer = setTimeout(flush, 1500); timer.unref?.(); };

const uid = () => Math.random().toString(36).slice(2, 8);
export const convoKey = message => `${message.guild?.id ?? message.guildId ?? "dm"}:${message.author?.id ?? "x"}`;

const blank = () => ({ topic: null, summary: "", turns: [], entities: { channels: [], members: [], roles: [], messages: [] }, list: null, focus: null, drafts: [], currentDraft: null, pending: null, corrections: [], lastIntent: null, lastOp: null, updatedAt: Date.now() });

export function getConvo(key) {
  const c = store.convos[key] ??= blank();
  if (Date.now() - c.updatedAt > TTL.convo) Object.assign(c, blank());
  if (c.pending && Date.now() - c.pending.at > TTL.pending) c.pending = null;
  return c;
}
export const touch = c => { c.updatedAt = Date.now(); save(); };
export function resetConvo(key) { store.convos[key] = blank(); save(); }

/* ── turns and the rolling summary ── */
export function addTurn(c, role, text, meta = {}) {
  c.turns.push({ role, text: String(text ?? "").slice(0, 700), at: Date.now(), ...meta });
  if (c.turns.length > LIMITS.turns) {
    const old = c.turns.splice(0, c.turns.length - Math.floor(LIMITS.turns / 2)); // older turns are folded into one short summary, not dropped silently
    const asks = old.filter(t => t.role === "user").map(t => "- " + t.text.slice(0, 120));
    c.summary = [c.summary, ...asks].join("\n").split("\n").slice(-14).join("\n");
  }
  touch(c);
}

/* ── entities: what has been talked about, newest first ── */
export function noteEntity(c, type, item) {
  if (!item?.id) return;
  const list = c.entities[type] ??= [];
  const at = Date.now(), i = list.findIndex(x => x.id === item.id);
  if (i >= 0) list.splice(i, 1);
  list.unshift({ ...item, at });
  if (list.length > LIMITS.entities) list.length = LIMITS.entities;
  touch(c);
}
export const lastEntity = (c, type) => c.entities[type]?.[0] ?? null;
/** What the last thing the assistant did or showed was about: "it" and "that" mean this. */
export function setFocus(c, type, items, via) { c.focus = { type, items: (Array.isArray(items) ? items : [items]).filter(Boolean), via, at: Date.now() }; touch(c); }
export function setList(c, kind, items, meta = {}) { c.list = { kind, items, meta, at: Date.now() }; touch(c); }

/* ── drafts: written content that has not necessarily been sent ── */
export function newDraft(c, { text, topic, title, kind = "announcement" }) {
  const d = { id: uid(), kind, topic, title, text, version: 1, versions: [text], status: "draft", sent: [], at: Date.now() };
  c.drafts.unshift(d);
  if (c.drafts.length > LIMITS.drafts) c.drafts.length = LIMITS.drafts;
  c.currentDraft = d.id;
  touch(c); return d;
}
export const currentDraft = c => c.drafts.find(d => d.id === c.currentDraft) ?? null;
export function reviseDraft(c, d, text, instruction) {
  d.versions.push(text); if (d.versions.length > LIMITS.versions) d.versions.shift();
  d.text = text; d.version++; d.status = "draft"; d.lastInstruction = instruction; d.at = Date.now(); // a changed draft is no longer the approved one
  touch(c); return d;
}
export function approveDraft(c, d) { d.status = "approved"; d.approvedVersion = d.version; touch(c); return d; }
export function markDraftSent(c, d, rec) { d.sent.push({ ...rec, version: d.version, at: Date.now() }); d.status = "sent"; touch(c); }

/* ── pending: a question the assistant is waiting on, or a task left unfinished ── */
export function setPending(c, p) { c.pending = { ...p, at: Date.now() }; touch(c); }
export function takePending(c) { const p = c.pending; c.pending = null; touch(c); return p; }
export function addCorrection(c, rec) {
  c.corrections.unshift({ ...rec, at: Date.now() }); c.corrections.length = Math.min(c.corrections.length, 20);
  store.feedback.push({ ...rec, at: new Date().toISOString() }); if (store.feedback.length > LIMITS.feedback) store.feedback.shift();
  touch(c);
}
export const feedbackRecords = () => store.feedback.slice();

/* ── operations: what really happened ── */
export function recordOp(op) {
  const row = { id: uid(), at: Date.now(), ...op };
  store.ops.push(row); if (store.ops.length > LIMITS.ops) store.ops.shift();
  save(); return row;
}
export const findOp = (key, { ok, since = 0 } = {}) => [...store.ops].reverse().find(o => o.key === key && o.at >= since && (ok == null || o.ok === ok)) ?? null;
export const recentOps = (guild, user, n = 5) => store.ops.filter(o => o.guild === guild && o.user === user).slice(-n).reverse();
export function updateOp(id, patch) { const o = store.ops.find(x => x.id === id); if (o) { Object.assign(o, patch); save(); } return o; }

/* ── preferences: long-term, per user, deliberately small ── */
const SECRET = /\b(password|passwd|token|api[- ]?key|secret|seed phrase|private key|bearer|credit card|card number|cvv|ssn)\b|\b[A-Za-z0-9_-]{32,}\b/i;
export const looksSecret = t => SECRET.test(String(t ?? ""));
export function setPref(user, text, key = prefKey(text)) {
  if (looksSecret(text)) return { ok: false, why: "that looks like a secret, so I won't store it" };
  const list = store.prefs[user] ??= [];
  const clean = String(text).trim().slice(0, 240), i = list.findIndex(p => p.key === key);
  if (i >= 0) list[i] = { ...list[i], text: clean, at: Date.now() }; else list.push({ key, text: clean, at: Date.now() });
  if (list.length > 30) list.shift();
  save(); return { ok: true, key };
}
export const prefsOf = user => (store.prefs[user] ?? []).slice();
export function forgetPref(user, query) {
  const list = store.prefs[user] ?? [], q = String(query ?? "").toLowerCase().trim();
  const keep = list.filter(p => q && !(p.text.toLowerCase().includes(q) || p.key.includes(q)));
  const gone = list.length - keep.length;
  if (gone) { store.prefs[user] = keep; save(); }
  return gone;
}
/** Which area a preference is about, so a writing preference is only applied when writing. */
function prefKey(text) {
  const t = String(text).toLowerCase();
  if (/announce/.test(t)) return "announcements";
  if (/\b(reply|answer|response|explain|talk|style|tone|short|brief|detail)/.test(t)) return "style";
  if (/\b(channel|server)\b/.test(t)) return "channels";
  return "general-" + t.replace(/[^a-z0-9]+/g, "-").slice(0, 24);
}
/** The preferences that matter for this request: general and style ones always, a topic one only when the request is about that topic. */
export function relevantPrefs(user, text = "") {
  const t = text.toLowerCase();
  return prefsOf(user).filter(p => p.key === "style" || p.key.startsWith("general") || (p.key === "announcements" && /announce|post|message|write|draft/.test(t)) || (p.key === "channels" && /channel|category|send|post/.test(t)));
}

/* ── retrieval: the right context, not all of it ── */
const ago = ms => { const s = Math.round((Date.now() - ms) / 1000); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
export function contextBlock(c, user, text = "") {
  const out = [];
  if (c.topic) out.push(`Current topic: ${c.topic}`);
  if (c.summary) out.push(`Earlier in this conversation:\n${c.summary}`);
  const d = currentDraft(c);
  if (d) out.push(`Current draft (${d.kind}, version ${d.version}, ${d.status}${d.sent.length ? `, already sent ${d.sent.length}x` : ""}): "${d.text.slice(0, 500)}"`);
  if (c.focus?.items?.length) out.push(`The last thing I did or showed was about: ${c.focus.type} ${c.focus.items.map(i => i.name ?? i.label ?? i.id).join(", ")} (${ago(c.focus.at)}). "it"/"that" means this.`);
  if (c.list?.items?.length) out.push(`Last list I showed (${c.list.kind}): ${c.list.items.slice(0, 10).map((m, i) => `${i + 1}. ${m.label ?? m.name} (${m.id})`).join("; ")}`);
  const ent = ["channels", "roles", "members"].map(t => c.entities[t]?.length ? `${t}: ${c.entities[t].slice(0, 4).map(e => e.name ?? e.label ?? e.id).join(", ")}` : "").filter(Boolean);
  if (ent.length) out.push("Recently discussed " + ent.join(" | "));
  if (c.pending) out.push(`I am waiting for: ${c.pending.ask ?? c.pending.field}`);
  const recent = c.turns.slice(-6).map(t => `${t.role === "user" ? "Owner" : "Me"}: ${t.text.slice(0, 160)}`);
  if (recent.length) out.push("Recent turns:\n" + recent.join("\n"));
  const prefs = relevantPrefs(user, text).map(p => `- ${p.text}`);
  if (prefs.length) out.push("The owner's saved preferences:\n" + prefs.join("\n"));
  return out.join("\n").slice(0, 2400);
}

/** For tests: wipe everything. */
export function _reset() { store = { convos: {}, prefs: {}, ops: [], feedback: [] }; clearTimeout(timer); }
