import { ChannelType } from "discord.js";
import { runTool, findRole, TOOLS } from "../admin/tools.js";
import { userMissing, botMissing } from "../admin/guard.js";
import { PermissionFlagsBits as P } from "discord.js";
import { confirmButtons, panel } from "../admin/ui.js";
import { intentOf } from "../admin/intent.js";
import "./tools.js";
import { handleListButton } from "./tools.js";
import { classify, namesFrom, normalize, origCase } from "./classify.js";
const channelNamesOf = guild => [...guild.channels.cache.values()].map(c => c.name);
import { knownAction, toolAllowed, validate } from "./registry.js";
import { ask as askWhich, pickFromList, resolveChannel, resolveMember, resolveRole, sendable } from "./resolver.js";
import { complete } from "./router.js";
import { parseWhen } from "./when.js";
import * as mem from "./memory.js";

/**
 * The conversation manager. One entry point (handle) takes an owner's message in a server and runs the whole pipeline:
 *   pending question? -> classify (structured intent) -> resolve references from the structured state -> check the tool is the right one
 *   for the intent -> run it through the administrator's gate (permissions, confirmation, audit) -> verify the result from Discord ->
 *   update the state -> answer.
 * Whatever it does not own (general chat, trading questions, pictures...) is returned unhandled with the retrieved context, and the existing
 * language-model path answers it as before. Nothing here asks the model to pick a Discord id or a tool for something deterministic.
 */
const plain = text => ({ content: String(text).slice(0, 1990), allowedMentions: { parse: [] } });
const oneLine = (s, n = 300) => String(s ?? "").replace(/[\u200b-\u200f\u2060\ufeff]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const clip = (s, n = 80) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const FRESH = 30 * 60_000;
const fresh = e => e && Date.now() - e.at < FRESH;
const say = (text, extra = {}) => ({ handled: true, say: text, ...extra });
const posts = (list, extra = {}) => ({ handled: true, posts: list.filter(Boolean), ...extra });
const isCat = c => c?.type === ChannelType.GuildCategory;

/* ── drafting (the only place a language model is used for content) ── */
const WRITE_SYSTEM = "You write messages for the owner of a trading community's Discord server. Use only the facts you are given: never invent times, prices, links, names, prizes or promises. Plain, confident, friendly. Light Discord markdown only (bold for the key line, a short list if needed). At most 900 characters. Return ONLY the message text, no preamble, no quotation marks.";
const REVISE_SYSTEM = "You edit a Discord message exactly as the owner asks. Keep every fact that was not asked to change, and never add facts, times, links or names that are not in the message or the request. Return ONLY the full revised message text, no preamble, no quotation marks.";
const styleLines = uid => mem.relevantPrefs(uid, "announcement write draft").map(p => `- ${p.text}`).join("\n");

async function writeDraft(c, uid, { topic, when, sameFormat }) {
  const prefs = styleLines(uid), before = sameFormat ? c.drafts[0]?.text : null;
  const out = await complete({ task: "write", system: WRITE_SYSTEM, temperature: 0.5, max: 700, messages: [{ role: "user", content: `Write an announcement.\nTopic: ${oneLine(topic)}${when ? `\nWhen: ${oneLine(when, 80)}` : ""}${prefs ? `\nThe owner's saved preferences, follow them:\n${prefs}` : ""}${before ? `\nUse the same structure, length and style as this earlier message (new facts only from the topic):\n${before.slice(0, 700)}` : ""}` }] });
  c.topic = `announcement about ${clip(topic, 60)}`;
  return mem.newDraft(c, { text: out.text.trim().replace(/^["“]|["”]$/g, ""), topic });
}
async function reviseDraft(c, uid, d, instruction) {
  const prefs = styleLines(uid);
  const out = await complete({ task: "write", system: REVISE_SYSTEM, temperature: 0.3, max: 700, messages: [{ role: "user", content: `Current message:\n${d.text}\n\nChange requested: ${oneLine(instruction)}${prefs ? `\nThe owner's saved preferences:\n${prefs}` : ""}` }] });
  return mem.reviseDraft(c, d, out.text.trim().replace(/^["“]|["”]$/g, ""), instruction);
}
const showDraft = (d, note) => plain(`**Draft** · version ${d.version}${d.status === "approved" ? " · approved" : ""}\n${d.text}\n\n-# ${note ?? 'Say "send it" (here, or "in #channel"), or tell me what to change.'}`);

/* ── running a tool through the gate, and learning from what really happened ── */
async function callTool(env, tool, args, { channel, primary } = {}) {
  if (primary && !toolAllowed(primary, tool)) throw new Error(`the intent "${primary}" may not be answered with ${tool}`); // never substitute a related-but-different result
  const v = validate(tool, args);
  if (!v.ok) return { post: plain(`I can't do that yet: ${v.errors.join(", ")}.`), outcome: { ran: false, ok: false, error: v.errors.join(", ") }, result: {} };
  const outcome = {}, result = {}, { message, config } = env;
  const post = await runTool(message, tool, args, config, { channel: channel ?? message.channel, outcome, result, convoKey: mem.convoKey(message), resolveMember: env.resolveMember });
  return { post, outcome, result };
}
const record = (env, tool, r, extra = {}) => mem.recordOp({ guild: env.message.guild.id, user: env.uid, action: tool, ok: !!r.outcome.ok, error: r.outcome.error, ids: r.result.id ?? r.result.messageId ?? null, ...extra });

/** What a successful tool run taught the conversation: the entities it made or showed, and what "it" now means. */
function absorb(c, r) {
  const x = r.result ?? {};
  if (x.kind === "category" || x.kind === "text" || x.kind === "voice" || x.kind === "announcement" || x.kind === "forum" || x.kind === "stage") {
    const item = { id: x.id, name: x.name, kind: x.kind, parentId: x.parentId, parentName: x.parentName };
    mem.noteEntity(c, "channels", item); mem.setFocus(c, x.kind === "category" ? "category" : "channel", item, "created");
  } else if (x.kind === "role") { const item = { id: x.id, name: x.name }; mem.noteEntity(c, "roles", item); mem.setFocus(c, "role", item, "created"); }
  else if (x.kind === "message") { const item = { id: x.id, channelId: x.channelId, name: `message in #${x.channelName ?? "?"}`, channelName: x.channelName, text: clip(x.text, 160), url: x.url }; if (!x.deleted) { mem.noteEntity(c, "messages", item); mem.setFocus(c, "message", item, x.edited ? "edited" : "sent"); } else c.entities.messages = c.entities.messages.filter(m => m.id !== x.id); }
  else if (x.kind === "role_change") { mem.noteEntity(c, "members", { id: x.memberId, name: x.memberId }); mem.setFocus(c, "member", { id: x.memberId, name: x.memberId }, "role changed"); }
  if (x.visibility) {
    const v = x.visibility, names = rs => rs.map(r => "#" + r.name).join(", ") || "none";
    mem.setFocus(c, "permission", [{ id: v.role.id, name: `view access for ${v.role.name}`, perm: "ViewChannel", role: v.role, mode: v.mode, visible: v.visible, hidden: v.hidden, readonly: v.readonly }], "listed");
    mem.setList(c, "channels", (v.mode === "hidden" ? v.hidden : v.mode === "readonly" ? v.readonly : v.visible).map(ch => ({ id: ch.id, label: ch.name })), { permission: true });
    mem.noteFact(c, "permission", `Showed which channels ${v.role.name} can see. Can see (${v.visible.length}): ${names(v.visible)}. Hidden (${v.hidden.length}): ${names(v.hidden)}. The permission was View Channel for ${v.role.name}.`, { role: v.role, mode: v.mode, visible: v.visible, hidden: v.hidden, readonly: v.readonly });
  }
  if (x.list && x.list.items?.length) mem.noteFact(c, "list", `Showed a list of ${x.list.kind}${x.role ? " with " + x.role.name : ""} (${x.list.items.length}): ${x.list.items.slice(0, 8).map(i => i.label).join(", ")}`, { kind: x.list.kind });
  if (x.kind && x.id && !x.visibility && !x.list) mem.noteFact(c, "result", `${x.deleted ? "Deleted" : x.edited ? "Edited" : x.pinned ? "Pinned" : "Made"} ${x.kind} ${x.name ?? x.channelName ?? x.id}`, { id: x.id, kind: x.kind });
  if (x.list?.items?.length === 1) mem.noteEntity(c, "members", { id: x.list.items[0].id, name: x.list.items[0].label });
  if (x.list) { mem.setList(c, x.list.kind, x.list.items, { role: x.role, total: x.list.total }); mem.setFocus(c, "members", x.list.items, "listed"); if (x.role) mem.noteEntity(c, "roles", x.role); }
}

const rolesOf = guild => [...guild.roles.cache.values()].filter(r => r.id !== guild.id).map(r => r.name);
const findRoleIn = guild => q => findRole(guild, q);
const asked = (c, k, field, question, extra = {}) => { mem.setPending(c, { kind: "fill", field, k, ask: question, ...extra }); return say(question, { ok: true }); };

/** Picks the channel an instruction named: a unique match, or an honest question when several fit. */
function channelFor(env, k, query, { types } = {}) {
  const r = resolveChannel(env.message.guild, query, { current: env.message.channel, types });
  if (r.channel) return { channel: r.channel };
  if (r.ambiguous) {
    const opts = r.ambiguous.map(x => ({ id: x.id, label: x.name }));
    return { reply: asked(env.c, k, "channelId", `I found ${opts.length} channels with similar names. Which one should I use?\n${askWhich(r.ambiguous)}`, { options: opts }) };
  }
  const similar = (r.similar ?? []).map(x => `#${x.name}`).join(", ");
  return { reply: say(`I couldn't find a channel called "${query}".${similar ? ` Did you mean ${similar}?` : ""}`, { ok: false }) };
}

/* ─────────────────────────── the handlers ─────────────────────────── */
const HANDLERS = {
  async "members.list"(env, k) { return listLike(env, k, "member_list", { query: k.params.query, kind: k.params.kind, sort: k.params.sort }); },
  async "members.search"(env, k) { return listLike(env, k, "member_list", { query: k.params.query }); },
  async "members.byRole"(env, k) { return listLike(env, k, "member_list", { role: k.params.role }); },
  async "members.count"(env, k) { return simple(env, k, "member_count"); },
  async "members.online"(env, k) { return simple(env, k, "member_online"); },
  async "server.overview"(env, k) { return simple(env, k, "server_overview"); },
  async "roles.list"(env, k) { return simple(env, k, "role_list"); },
  async "channels.list"(env, k) { return simple(env, k, "channel_list"); },
  async "channels.visibility"(env, k) { return listLike(env, k, "channel_visibility", { role: k.params.role, mode: k.params.mode }); },
  async "channel.info"(env, k) {
    let channel = env.message.channel;
    if (k.target.channel) { const r = channelFor(env, k, k.target.channel); if (r.reply) return r.reply; channel = r.channel; }
    const r = await callTool(env, "channel_info", {}, { channel, primary: k.primary });
    record(env, "channel_info", r); return posts([r.post], { ok: !!r.outcome.ok, k });
  },

  async "invite.create"(env, k) {
    const q = intentOf(env.text, `${env.message.channelId}:${env.message.author.id}`); // the existing, tested invite parsing (expiry, uses, channel)
    const { moderate } = await import("../mod.js");
    const post = await moderate(env.message, { action: q?.action ?? "invite_create", ...(q?.args ?? {}) }, env.config);
    mem.recordOp({ guild: env.message.guild.id, user: env.uid, action: q?.action ?? "invite_create", ok: true });
    return posts([post], { ok: true, k });
  },

  async "draft.write"(env, k) {
    if (!k.params.topic) return asked(env.c, k, "topic", k.clarify ?? "What is the announcement about?");
    let d; try { d = await writeDraft(env.c, env.uid, k.params); } catch (e) { return say(`I couldn't reach my writing models just now, so nothing was drafted (${clip(e.message, 100)}). Try again in a moment.`, { ok: false }); }
    return posts([showDraft(d)], { ok: true, k, keep: true });
  },
  async "draft.revise"(env, k) {
    const d = mem.currentDraft(env.c); if (!d) return say("There's no draft to change yet. Tell me what to write.", { ok: false });
    let nd; try { nd = await reviseDraft(env.c, env.uid, d, k.params.instruction); } catch (e) { return say(`I couldn't reach my writing models, so the draft is unchanged (${clip(e.message, 100)}).`, { ok: false }); }
    const sent = nd.sent.length ? `The version already posted in #${nd.sent.at(-1).channelName} is unchanged: say "edit the one you sent" to update it, or "send it" to post this as a new message.` : undefined;
    return posts([showDraft(nd, sent)], { ok: true, k, keep: true });
  },
  async "draft.approve"(env) { const d = mem.currentDraft(env.c); if (!d) return say("There's nothing to approve yet.", { ok: false }); mem.approveDraft(env.c, d); return say(`Approved (version ${d.version}). Say "send it here" or "send it in #channel" whenever you're ready.`, { ok: true }); },

  async "draft.send"(env, k) {
    const { c, message } = env, d = mem.currentDraft(c);
    if (!d) return { handled: false }; // nothing of mine to send: "send it" may mean something else (a picture, a card), so the existing path decides
    let channel = message.channel;
    if (k.target.other || k.target.dangling) return asked(c, k, "channel", "Which channel should I send it to?");
    if (k.target.channels?.length) { const outs = []; for (const n of k.target.channels) { const r = await HANDLERS["draft.send"]({ ...env, picked: undefined }, { ...k, target: { channel: n } }); outs.push(r); if (r.ok === false || c.pending) break; } return posts(outs.flatMap(o => [o.say ? plain(o.say) : null, ...(o.posts ?? [])]), { ok: outs.every(o => o.ok !== false), k }); }
    if (k.target.sameAsBefore) { const ids = [...new Set(d.sent.map(s => s.channelId))]; if (ids.length === 1) env = { ...env, picked: { ...env.picked, channelId: ids[0] } }; else return asked(c, k, "channel", ids.length ? `Which one? I sent it to ${d.sent.map(s => `#${s.channelName}`).filter((x, i, a) => a.indexOf(x) === i).join(" and ")} before.` : "I haven't sent it anywhere yet. Which channel?"); }
    const picked = env.picked?.channelId; const named = picked ?? k.target.channel;
    if (named) { const r = channelFor(env, k, picked ? `<#${picked}>` : named); if (r.reply) return r.reply; channel = r.channel; }
    if (!sendable(channel)) return say(`I can't post messages in ${channel}. Tell me a text channel.`, { ok: false });
    const earlier = d.sent.find(s => s.channelId === channel.id);
    const key = `send:${d.id}:v${d.version}:${channel.id}`;
    const flying = mem.findOp(key, { since: Date.now() - 60_000 });
    if (flying && flying.ok === null) return say("I'm already sending that one.", { ok: true });
    const done = mem.findOp(key, { ok: true });
    if (done || d.sent.some(s => s.channelId === channel.id && s.version === d.version)) { const s = d.sent.find(x => x.channelId === channel.id && x.version === d.version) ?? {}; return say(`That version is already posted in ${channel}${s.url ? `: ${s.url}` : ""}. I didn't send it twice. Want it in another channel, or should I edit that message?`, { ok: true }); }
    if (earlier && !env.picked?.choice) return asked(c, k, "choice", `I already posted an earlier version of this in ${channel}. Should I **edit** that message or post this as a **new** one?`, { options: ["edit", "new"] });
    if (env.picked?.choice === "edit" && earlier) return doEdit(env, k, d, earlier);
    const op = mem.recordOp({ key, guild: message.guild.id, user: env.uid, action: "message_send", ok: null, channelId: channel.id });
    const r = await callTool(env, "message_send", { text: d.text, title: d.title, key: key.replace(/[^a-z0-9]/gi, "").slice(-24), allowEveryone: /(^|\s)@(everyone|here)\b|\bping (everyone|the server)|\bnotify everyone/i.test(env.text) }, { channel, primary: "draft.send" });
    mem.updateOp(op.id, { ok: !!r.outcome.ok, error: r.outcome.error, ids: r.result.id });
    if (!r.outcome.ok) return posts([r.post], { ok: false });
    mem.markDraftSent(c, d, { channelId: channel.id, channelName: channel.name, messageId: r.result.id, url: r.result.url });
    absorb(c, r); c.lastIntent = k;
    return posts([r.post], { ok: true, k });
  },

  async "message.edit"(env, k) {
    const { c } = env, d = mem.currentDraft(c); const last = d?.sent.at(-1);
    if (!d || !last) return { handled: false };
    if (k.params.instruction) { try { await reviseDraft(c, env.uid, d, k.params.instruction); } catch (e) { return say(`I couldn't reach my writing models, so nothing was edited (${clip(e.message, 100)}).`, { ok: false }); } }
    else if (d.version === last.version) return asked(c, k, "instruction", "What should I change in it?");
    return doEdit(env, k, d, last);
  },

  async "message.pin"(env, k) {
    const target = messageTarget(env, "pin"); if (target.reply) return target.reply;
    const channel = env.message.guild.channels.cache.get(target.item.channelId) ?? env.message.channel;
    const r = await callTool(env, "message_pin", { messageId: target.item.id }, { channel, primary: "message.pin" });
    record(env, "message_pin", r); if (r.outcome.ok) env.c.lastIntent = k;
    return posts([r.post], { ok: !!r.outcome.ok, k });
  },
  async "message.delete"(env, k) {
    const target = messageTarget(env, k.params.which ?? "that"); if (target.reply) return target.reply;
    const channel = env.message.guild.channels.cache.get(target.item.channelId) ?? env.message.channel;
    const r = await callTool(env, "message_remove", { messageId: target.item.id, preview: target.item.text }, { channel, primary: "message.delete" });
    record(env, "message_remove", r); if (r.outcome.ok) { absorb(env.c, r); env.c.lastIntent = k; }
    return posts([r.post], { ok: !!r.outcome.ok, k });
  },

  async "category.create"(env, k) { return createOne(env, k); },
  async "channel.create"(env, k) {
    const { c } = env;
    if (k.params.count > 1 && !k.params.name && !k.params.names) return asked(c, k, "names", k.clarify ?? `What should the ${k.params.count} channels be called?`);
    const names = k.params.names ?? (k.params.name ? [k.params.name] : []);
    if (!names.length) return asked(c, k, "name", k.clarify ?? "What should the channel be called?");
    const lines = [], out = [];
    for (const n of names) { const r = await createOne(env, { ...k, params: { ...k.params, name: n, names: undefined, count: null } }); if (r.reply) return r.reply; out.push(r); }
    if (out.length > 1) mem.setList(c, "channels", c.entities.channels.slice(0, out.length).reverse().map(e => ({ id: e.id, label: e.name })), { batch: true });
    return out.length === 1 ? out[0] : posts(out.flatMap(o => o.posts ?? []), { ok: out.every(o => o.ok), k });
  },
  async "role.create"(env, k) {
    if (!k.params.name) return asked(env.c, k, "name", k.clarify ?? "What should the role be called?");
    const dup = findRole(env.message.guild, k.params.name);
    if (dup && dup.name.toLowerCase() === k.params.name.toLowerCase()) { mem.noteEntity(env.c, "roles", { id: dup.id, name: dup.name }); mem.setFocus(env.c, "role", { id: dup.id, name: dup.name }, "existing"); return say(`There's already a role called **${dup.name}**, so I didn't create another. I'll use that one.`, { ok: true }); }
    const r = await callTool(env, "role_create", { name: k.params.name }, { primary: "role.create" });
    record(env, "role_create", r); if (r.outcome.ok) { absorb(env.c, r); env.c.lastIntent = k; }
    return posts([r.post], { ok: !!r.outcome.ok, k });
  },

  async "channel.access"(env, k) {
    const { c, message } = env, guild = message.guild;
    let channel = null;
    if (env.picked?.channelId) channel = guild.channels.cache.get(env.picked.channelId);
    else if (k.target.ordinal != null && c.list?.kind === "channels") { const p = pickFromList(c.list, k.target.ordinal < 0 ? "last" : ["first", "second", "third", "fourth", "fifth"][k.target.ordinal] ?? `number ${k.target.ordinal + 1}`); if (p.item) channel = guild.channels.cache.get(p.item.id); else if (p.outOfRange) return say(`The last list had only ${p.count} channels.`, { ok: false }); }
    else if (k.target.channel) { const r = channelFor(env, k, k.target.channel); if (r.reply) return r.reply; channel = r.channel; }
    else { const f = c.focus?.type === "channel" || c.focus?.type === "category" ? c.focus.items[0] : c.entities.channels.find(fresh); channel = f ? guild.channels.cache.get(f.id) : null; }
    if (!channel) return asked(c, k, "channel", "Which channel do you mean?");
    const roles = String(k.params.roles ?? "").split(/\s*(?:,|&|\band\b)\s*/).filter(x => x && !/^(it|them|that|only|everyone|just|admins?|me|nobody|no one)$/i.test(x));
    const mode = k.params.access ?? "private";
    let post, ok = false;
    if (mode === "private" && !roles.length) { // nobody named: hidden from everyone but administrators
      const lacks = userMissing(message, [P.ManageChannels, P.ManageRoles]);
      if (lacks.length) return posts([plain(`You don't have the Discord permission for that (${lacks.join(", ")}), so I can't change who sees ${channel}.`)], { ok: false });
      const { moderate } = await import("../mod.js");
      post = await moderate(message, { action: "hide", channel: channel.id, target: "everyone" }, env.config); ok = !channel.permissionsFor(guild.roles.everyone)?.has("ViewChannel");
      mem.recordOp({ guild: guild.id, user: env.uid, action: "channel_access", ok, ids: channel.id });
      if (ok) post = plain(`🔒 ${channel} is private now: @everyone can't see it (administrators still can). To let a role in, say "give access to <role>". Verified.`);
      else post = plain(`I changed ${channel}'s permissions but couldn't confirm that @everyone lost access (a category or role setting may override it).`);
    } else {
      const r = await callTool(env, "channel_access", { access: mode, role: roles.join(", ") }, { channel, primary: "channel.access" });
      record(env, "channel_access", r); ok = !!r.outcome.ok; post = r.post;
    }
    if (ok) { mem.noteEntity(c, "channels", { id: channel.id, name: channel.name, kind: isCat(channel) ? "category" : "text" }); mem.setFocus(c, isCat(channel) ? "category" : "channel", { id: channel.id, name: channel.name }, "changed"); c.lastIntent = k; }
    return posts([post], { ok, k });
  },

  async "role.assign"(env, k) { return roleChange(env, k, false); },
  async "role.remove"(env, k) { return roleChange(env, k, true); },

  async "compound.setup"(env, k) { return k.multi ? runMulti(env, k) : runPlan(env, k); },

  async "draft.show"(env) { const d = mem.currentDraft(env.c); return d ? posts([showDraft(d)], { ok: true }) : say("There's no draft yet.", { ok: false }); },
  async "draft.restore"(env, k) {
    const d = mem.currentDraft(env.c); if (!d) return say("There's no draft to go back in.", { ok: false });
    const r = mem.restoreDraft(env.c, d, k.params.which);
    if (!r) return say(k.params.which === "approved" ? "You haven't approved a version of this draft yet, so I don't know which to go back to." : "There's no earlier version to go back to.", { ok: false });
    return posts([showDraft(r, `Back to the ${k.params.which} version.`)], { ok: true });
  },
  async "context.resume"(env) {
    const p = env.c.parked ?? env.c.pending;
    if (!p) { const d = mem.currentDraft(env.c); return d ? posts([showDraft(d, "This is where we stopped.")], { ok: true }) : say("Nothing was left unfinished in this conversation.", { ok: false }); }
    env.c.parked = null; mem.setPending(env.c, p); return { ...say(p.ask ?? "Where were we? Tell me what's missing.", { ok: true }), resumed: p.k };
  },
  async "event.create"(env, k) {
    const { c, message } = env, src = c.embed && Date.now() - c.embed.at < 6 * 3_600_000 ? c.embed : (() => { const d = mem.currentDraft(c); return d ? { title: d.title || String(d.text).split("\n")[0].replace(/[*_#]/g, "").slice(0, 80), body: d.text } : null; })();
    const strip = s => String(s ?? "").replace(/[*_~`]/g, "").replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+/g, " ").trim();
    const name = strip(k.params.name ?? env.picked?.name ?? src?.title).slice(0, 100);
    if (!name) return asked(c, k, "name", "What is the event called?");
    const hint = src ? `${src.title} ${src.body}` : "";
    const wanted = `${k.params.rest ?? ""} ${env.picked?.when ?? ""}`;
    const w = parseWhen(wanted, { hint });
    if (w.needTime || w.problem) return asked(c, k, "when", w.needTime ? "What time should it start? (New York time, for example 6pm)" : "When should it start? Give a day and a time (New York time), for example tomorrow at 6pm.");
    const body = String(src?.body ?? ""), where = /\*{0,2}where:?\*{0,2}\s*(.+)/i.exec(body)?.[1], description = String(k.params.description ?? body.split("\n").filter(l => l.trim()).map(l => l.trim()).join("\n")).replace(/\*\*/g, "").slice(0, 900);
    const r = await callTool(env, "event_create", { name, at: w.at, description: description || undefined, location: where ? strip(where).slice(0, 100) : undefined }, { primary: "event.create" });
    record(env, "event_create", r);
    if (r.outcome.ok) { mem.noteEntity(c, "events", { id: r.result.id, name: r.result.name }); mem.noteFact(c, "result", `Created the Discord event "${r.result.name}" for ${w.at} (New York time)${where ? ` at ${strip(where)}` : ""}`, { id: r.result.id }); c.lastIntent = k; }
    return posts([r.post], { ok: !!r.outcome.ok, k });
  },
  async "permission.revoke"(env, k) { return permissionChange(env, k, "revoke"); },
  async "permission.grant"(env, k) { return permissionChange(env, k, "grant"); },
  async "channel.rename"(env, k) { return channelEdit(env, k, "rename"); },
  async "channel.delete"(env, k) { return channelEdit(env, k, "delete"); },

  async "memory.remember"(env, k) {
    const r = mem.setPref(env.uid, k.params.text);
    return say(r.ok ? `Saved. I'll remember: "${clip(k.params.text, 120)}"` : `I didn't save that: ${r.why}.`, { ok: r.ok });
  },
  async "memory.forget"(env, k) { const n = mem.forgetPref(env.uid, k.params.text); return say(n ? `Forgotten (${n} item${n === 1 ? "" : "s"}).` : "I don't have anything saved matching that.", { ok: true }); },
  async "memory.show"(env) { const p = mem.prefsOf(env.uid); return say(p.length ? `I remember:\n${p.map(x => `- ${x.text}`).join("\n")}` : "I haven't saved any preferences yet. Tell me \"remember that …\".", { ok: true }); },

  async repeat(env) {
    const last = env.c.lastIntent; if (!last) return say("I don't have a previous action to repeat.", { ok: false });
    if (["channel.create", "category.create", "role.create"].includes(last.primary)) return asked(env.c, { ...last, params: { ...last.params, name: null, names: undefined } }, "name", `What should it be called this time?`);
    return run(last, env);
  },

  async "correction.channel"(env, k) {
    const { c, message } = env, d = mem.currentDraft(c), last = d?.sent.at(-1);
    mem.addCorrection(c, { phrase: normalize(lastUserBefore(c)), wrong: `sent to #${k.params.wrong}`, right: `#${k.target.channel}`, text: env.text });
    if (!d || !last) return say(`Understood: ${k.target.channel}, not ${k.params.wrong}. I haven't sent anything in this conversation, so nothing needs fixing.`, { ok: true });
    const r = channelFor(env, k, k.target.channel); if (r.reply) return r.reply;
    const out = await HANDLERS["draft.send"]({ ...env, picked: { channelId: r.channel.id } }, { ...k, primary: "draft.send", target: {}, params: {} });
    const wrong = d.sent.find(s => s.channelId !== r.channel.id && (s.channelName ?? "").toLowerCase().includes(String(k.params.wrong).toLowerCase()));
    if (wrong && out.ok) { mem.setFocus(c, "message", { id: wrong.messageId, channelId: wrong.channelId, name: `message in #${wrong.channelName}`, text: clip(d.text, 160) }, "wrong"); out.posts = [...(out.posts ?? []), plain(`You're right, that should have gone to ${r.channel}, not #${wrong.channelName}. It's posted in the right place now. Say **"delete that"** if you want me to remove the one in #${wrong.channelName}.`)]; }
    return out;
  },
};
const lastUserBefore = c => c.turns.filter(t => t.role === "user").slice(-2, -1)[0]?.text ?? "";

async function simple(env, k, tool) {
  const r = await callTool(env, tool, {}, { primary: k.primary });
  record(env, tool, r); if (r.outcome.ok) { absorb(env.c, r); env.c.lastIntent = k; }
  return posts([r.post], { ok: !!r.outcome.ok, k });
}
async function listLike(env, k, tool, args) {
  const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v != null && v !== ""));
  const r = await callTool(env, tool, clean, { primary: k.primary });
  record(env, tool, r); if (r.outcome.ok) { absorb(env.c, r); env.c.lastIntent = k; env.c.topic = args.role ? `members with ${args.role}` : "the server's members"; }
  return posts([r.post], { ok: !!r.outcome.ok, k });
}

/** The message "it/that/the previous one" means. One clear candidate is used; several equally plausible ones are listed and asked about. */
function messageTarget(env, which) {
  const { c } = env, k = env.k;
  const mine = c.entities.messages.filter(fresh);
  if (env.picked?.messageId) { const it = c.entities.messages.find(m => m.id === env.picked.messageId); if (it) return { item: it }; }
  if (k.params?.which === "in") { const want = String(k.params.channel ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""); const hit = mine.find(m => String(m.channelName ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").includes(want)); return hit ? { item: hit } : { reply: say(`I haven't sent anything in #${k.params.channel} that I could delete.`, { ok: false }) }; }
  if (which === "previous") { if (mine.length >= 2) return { item: mine[1] }; return { reply: mine.length ? say("That's the only message I've sent in this conversation, so there's no earlier one. Did you mean that one?", { ok: false }) : { handled: false } }; }
  const f = c.focus?.type === "message" && fresh(c.focus) && c.focus.items.length === 1 ? c.focus.items[0] : null;
  if (which === "last" && mine[0]) return { item: mine[0] };
  if (f) return { item: f };
  if (mine.length === 1) return { item: mine[0] };
  if (mine.length > 1) return { reply: asked(c, k, "messageId", `Which message do you mean?\n${mine.slice(0, 5).map((m, i) => `${i + 1}. ${m.name}: "${clip(m.text, 60)}"`).join("\n")}`, { options: mine.slice(0, 5).map(m => ({ id: m.id, label: `${m.name} ${m.text}` })) }) };
  return { reply: { handled: false } }; // no message of mine is involved: the existing "reply to it and say delete this message" path handles it
}

async function doEdit(env, k, d, rec) {
  const channel = env.message.guild.channels.cache.get(rec.channelId) ?? env.message.channel;
  const r = await callTool(env, "message_update", { messageId: rec.messageId, text: d.text, title: d.title }, { channel, primary: "message.edit" });
  record(env, "message_update", r);
  if (r.outcome.ok) { rec.version = d.version; d.status = "sent"; absorb(env.c, r); env.c.lastIntent = k; }
  return posts([r.post], { ok: !!r.outcome.ok, k });
}

/** Creates one channel or category, in the right category, once (it won't make a second copy of something that already exists). */
async function createOne(env, k) {
  const { c, message } = env, guild = message.guild, isCategory = k.params.kind === "category" || k.primary === "category.create";
  if (!k.params.name) return asked(c, k, "name", k.clarify ?? (isCategory ? "What should I name it?" : "What should the channel be called?"));
  let parent = null;
  if (!isCategory) {
    if (k.params.category) { const r = channelFor(env, k, k.params.category, { types: [ChannelType.GuildCategory] }); if (r.reply) return r.reply; parent = r.channel; }
    else if (k.params.intoFocus) { const f = c.focus?.type === "category" && fresh(c.focus) ? c.focus.items[0] : c.entities.channels.find(e => e.kind === "category" && fresh(e)); if (f) parent = guild.channels.cache.get(f.id) ?? null; }
  }
  const same = [...guild.channels.cache.values()].find(x => x.name.toLowerCase().replace(/\s+/g, "-") === String(k.params.name).toLowerCase().replace(/\s+/g, "-") && isCat(x) === isCategory && (x.parentId ?? null) === (parent?.id ?? null));
  if (same && !env.picked?.again) return asked(c, { ...k, params: { ...k.params } }, "again", `${isCategory ? "A category" : "A channel"} called **${same.name}** already exists${parent ? ` in ${parent.name}` : ""}. Create another one anyway? (yes / no)`, { yes: true });
  const key = `create:${guild.id}:${isCategory ? "cat" : "ch"}:${String(k.params.name).toLowerCase()}:${parent?.id ?? ""}`;
  const op = mem.recordOp({ key, guild: guild.id, user: env.uid, action: "channel_create", ok: null });
  const args = { kind: isCategory ? "category" : k.params.kind ?? "text", name: k.params.name, private: k.params.private ? "true" : undefined, role: k.params.role, category: parent?.name };
  const r = await callTool(env, "channel_create", args, { primary: k.primary });
  mem.updateOp(op.id, { ok: !!r.outcome.ok, error: r.outcome.error, ids: r.result.id });
  if (r.outcome.ok) { absorb(c, r); c.lastIntent = k; }
  return posts([r.post], { ok: !!r.outcome.ok, k });
}

async function roleChange(env, k, remove) {
  const { c, message } = env, guild = message.guild, find = findRoleIn(guild);
  const rr = resolveRole(find, env.picked?.role ?? k.target.role, c);
  if (rr.none) return asked(c, k, "role", `Which role should I ${remove ? "remove" : "give"}?`);
  if (!rr.role) return say(`I couldn't find ${rr.named ? `a role called "${rr.named}"` : "that role"}. Name it again, or ask me to create it.`, { ok: false });
  if (rr.named) { const k1 = String(rr.named).toLowerCase().replace(/[^a-z0-9]/g, ""), k2 = rr.role.name.toLowerCase().replace(/[^a-z0-9]/g, ""); if (k2 !== k1 && k2 !== k1.replace(/s$/, "")) return say(`I found **${rr.role.name}**, which isn't exactly "${rr.named}". Say the exact role name so I never hand out the wrong one.`, { ok: false }); }
  const who = env.picked?.user ?? k.target.user;
  if (!who) return asked(c, k, "user", `Who should ${remove ? "lose" : "get"} **${rr.role.name}**?`);
  const m = resolveMember(who, c, message);
  if (m.problem) return say(m.problem, { ok: false });
  if (m.ambiguous) return asked(c, k, "user", `I'm not sure which person you mean: ${m.ambiguous.map(i => `<@${i}>`).join(" or ")}. Tag the right one.`);
  if (m.none) return asked(c, k, "user", `I couldn't tell who "${clip(who, 40)}" is. Tag them (@name) or give their ID.`);
  const name = m.label ?? `<@${m.id}>`;
  if (m.via !== "mention" && m.via !== "id") { // the target came from a reference, not a tag: confirm the exact person before changing anything
    const ok = await confirmButtons(message, { title: `${remove ? "Remove" : "Give"} **${rr.role.name}** ${remove ? "from" : "to"} ${name}?`, lines: [`I read "${clip(who, 40)}" as <@${m.id}> (ID \`${m.id}\`)${m.index != null ? `, number ${m.index + 1} in the last list` : ""}.`], ttl: 30_000, danger: false });
    if (!ok) return say("Cancelled. Nothing was changed.", { ok: false });
  }
  const r = await callTool({ ...env, resolveMember: async () => guild.members.fetch(m.id).catch(() => null) }, remove ? "role_remove" : "role_add", { role: rr.role.name, user: m.id }, { primary: remove ? "role.remove" : "role.assign" });
  record(env, "role_assign", r, { targetId: m.id });
  if (r.outcome.ok) { absorb(c, r); mem.noteEntity(c, "members", { id: m.id, name }); mem.noteEntity(c, "roles", { id: rr.role.id, name: rr.role.name }); c.lastIntent = k; }
  return posts([r.post], { ok: !!r.outcome.ok, k });
}

/**
 * "Remove that permission" / "give it back": acts on the permission the assistant last showed (for example View Channel for @everyone on the
 * channels listed), after listing exactly what will change and asking for confirmation. Every change is read back from Discord.
 */
async function permissionChange(env, k, what) {
  const { c, message } = env, guild = message.guild, revoke = what === "revoke";
  const explicit = !!k.params.explicit;
  let f = explicit ? null : ((c.focus?.type === "permission" && fresh(c.focus) ? c.focus.items[0] : null) ?? c.facts?.find(x => x.kind === "permission" && Date.now() - x.at < FRESH * 2)?.data ?? null);
  if (!f && !explicit) return { handled: false }; // nothing was shown that "that permission" could mean: the existing path decides
  if (explicit) { // the owner named what to change: read the live permissions instead of relying on an earlier list
    let who = guild.roles.everyone;
    if (k.target.role) { who = findRole(guild, k.target.role); if (!who) return say(`I couldn't find a role called "${k.target.role}".`, { ok: false }); }
    if (!k.target.all && !k.target.channels?.length && k.target.ordinal == null && !k.target.here) return asked(c, k, "channel", `Which channels? Name them, or say "all channels".`);
    const rows = [...guild.channels.cache.values()].filter(ch => !ch.isThread?.() && ch.type !== ChannelType.GuildCategory).map(ch => ({ id: ch.id, name: ch.name, view: !!ch.permissionsFor(who)?.has(P.ViewChannel) }));
    f = { role: { id: who.id, name: who.id === guild.id ? "@everyone" : who.name }, visible: rows.filter(r => r.view).map(r => ({ id: r.id, name: r.name })), hidden: rows.filter(r => !r.view).map(r => ({ id: r.id, name: r.name })) };
    if (k.target.here) k = { ...k, target: { ...k.target, channels: undefined } };
  }
  const role = guild.roles.cache.get(f.role?.id) ?? guild.roles.everyone, label = role.id === guild.id ? "@everyone" : role.name;
  let pool = (revoke ? f.visible : f.hidden) ?? [];
  if (k.target.here) pool = [...(f.visible ?? []), ...(f.hidden ?? [])].filter(x => x.id === message.channel.id);
  if (k.target.ordinal != null && c.list?.kind === "channels") { const p = pickFromList(c.list, k.target.ordinal < 0 ? "last" : ["first", "second", "third", "fourth", "fifth"][k.target.ordinal] ?? `number ${k.target.ordinal + 1}`); if (p.outOfRange) return say(`The last list had only ${p.count} channels.`, { ok: false }); pool = p.item ? [{ id: p.item.id, name: p.item.label }] : pool; }
  if (k.target.channels?.length) {
    const want = k.target.channels.map(n => { const r = resolveChannel(guild, n, { current: message.channel }); return r.channel?.id; });
    if (want.some(x => !x)) return say(`I couldn't match ${k.target.channels.filter((n, i) => !want[i]).map(n => '"' + n + '"').join(", ")} to a channel.`, { ok: false });
    pool = pool.filter(x => want.includes(x.id));
  }
  const chans = pool.map(x => guild.channels.cache.get(x.id)).filter(Boolean);
  if (!chans.length) return say(revoke ? `${label} can't see any of those channels, so there's nothing to remove.` : `There are no hidden channels from that list to give ${label} access to.`, { ok: true });
  const lacks = userMissing(message, [P.ManageChannels, P.ManageRoles]);
  if (lacks.length) return say(`You don't have the Discord permission for that (${lacks.join(", ")}), so I can't change channel access for you.`, { ok: false });
  const botLacks = chans.map(ch => botMissing(guild, [P.ManageChannels, P.ManageRoles], ch)).find(x => x.length);
  if (botLacks) return say(`I can't do that: I'm missing ${botLacks.join(", ")} on at least one of those channels.`, { ok: false });
  const ok = await confirmButtons(message, { title: `${revoke ? "Remove" : "Give back"} View Channel ${revoke ? "from" : "for"} ${label} on ${chans.length} channel${chans.length === 1 ? "" : "s"}?`, lines: [...chans.slice(0, 15).map(ch => `• ${ch}`), chans.length > 15 ? `-# and ${chans.length - 15} more` : "", revoke ? "They will no longer be able to see these channels." : "This puts their access back to the default for these channels."].filter(Boolean), ttl: 30_000 });
  if (!ok) return say("Cancelled. Nothing was changed.", { ok: false });
  const lines = [], done = [];
  for (const ch of chans) {
    try {
      await ch.permissionOverwrites.edit(role, { ViewChannel: revoke ? false : null }, { reason: `Asked by ${message.author?.tag ?? "the owner"} via YSER Lab` });
      const back = await guild.channels.fetch(ch.id, { force: true }).catch(() => null), sees = !!back?.permissionsFor(role)?.has(P.ViewChannel);
      if (revoke ? sees : false) { lines.push(`❌ ${ch}: it is still visible (a category or role setting overrides it)`); continue; }
      lines.push(`✅ ${ch}${!revoke && !sees ? " (reset, but another setting still hides it)" : ""}`); done.push(ch);
    } catch (e) { lines.push(`❌ ${ch}: ${/Missing/i.test(String(e?.message)) ? "I'm missing a permission there" : "Discord refused it"}`); }
  }
  const moved = new Set(done.map(d => d.id));
  const next = { ...f, visible: revoke ? f.visible.filter(x => !moved.has(x.id)) : [...f.visible, ...done.map(d => ({ id: d.id, name: d.name }))], hidden: revoke ? [...(f.hidden ?? []), ...done.map(d => ({ id: d.id, name: d.name }))] : (f.hidden ?? []).filter(x => !moved.has(x.id)) };
  mem.setFocus(c, "permission", [{ ...c.focus?.items?.[0], ...next, id: f.role?.id, name: `view access for ${label}`, perm: "ViewChannel" }], "changed");
  mem.noteFact(c, "permission", `${revoke ? "Removed" : "Restored"} View Channel for ${label} on ${done.map(d => "#" + d.name).join(", ") || "no channel"}`, next);
  mem.recordOp({ guild: guild.id, user: env.uid, action: "channel_permission", ok: done.length === chans.length, ids: done.map(d => d.id).join(",") });
  if (done.length) c.lastIntent = k;
  return posts([panel({ title: done.length === chans.length ? (revoke ? "View access removed" : "View access restored") : "Partly done", accent: done.length === chans.length ? "up" : "amber", lines, footer: "Read back from Discord" })], { ok: done.length === chans.length, k });
}

/** Renames or deletes a channel the owner pointed at: by position in the last batch ("the second one"), or the one just made or discussed. */
async function channelEdit(env, k, what) {
  const { c, message } = env, guild = message.guild;
  let channel = null;
  if (k.target.ordinal != null && c.list?.kind === "channels") { const p = pickFromList(c.list, `${k.target.ordinal + 1 === 0 ? "last" : ["first", "second", "third", "fourth", "fifth"][k.target.ordinal] ?? "number " + (k.target.ordinal + 1)}`); if (p.item) channel = guild.channels.cache.get(p.item.id); }
  else if (k.target.channel) { const r = channelFor(env, k, k.target.channel); if (r.reply) return r.reply; channel = r.channel; }
  else { const f = c.focus?.type === "channel" || c.focus?.type === "category" ? c.focus.items[0] : c.entities.channels.find(fresh); channel = f ? guild.channels.cache.get(f.id) : null; }
  if (!channel) return asked(c, k, "channel", k.target.ordinal != null ? "I don't have a list of channels to pick from. Which channel do you mean?" : "Which channel do you mean?");
  const { moderate } = await import("../mod.js");
  if (what === "rename") {
    const name = env.picked?.name ?? k.params.name;
    if (!name) return asked(c, { ...k, target: { ...k.target, ordinal: null, channel: channel.id } }, "name", `What should ${channel} be renamed to?`);
    const clean = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || String(name).slice(0, 90);
    const post = await moderate(message, { action: "rename_channel", channel: channel.id, name: isCat(channel) ? String(name).slice(0, 90) : clean }, env.config);
    const back = await guild.channels.fetch(channel.id).catch(() => null), ok = !!back && back.name === (isCat(channel) ? String(name).slice(0, 90) : clean);
    mem.recordOp({ guild: guild.id, user: env.uid, action: "rename_channel", ok, ids: channel.id });
    if (ok) { mem.noteEntity(c, "channels", { id: channel.id, name: back.name, kind: isCat(channel) ? "category" : "text" }); mem.setFocus(c, isCat(channel) ? "category" : "channel", { id: channel.id, name: back.name }, "renamed"); c.lastIntent = k; }
    return posts([ok ? post : plain("I tried to rename it but Discord didn't apply the change, so nothing is confirmed as renamed.")], { ok, k });
  }
  const id = channel.id, post = await moderate(message, { action: "delete_channel", channel: id }, env.config);
  const gone = !(await guild.channels.fetch(id).catch(() => null));
  mem.recordOp({ guild: guild.id, user: env.uid, action: "delete_channel", ok: gone, ids: id });
  if (gone) { c.entities.channels = c.entities.channels.filter(e => e.id !== id); c.focus = null; c.lastIntent = k; }
  return posts([post], { ok: gone, k });
}

/** Runs each clause of a multi-instruction message in order, classifying each with what the earlier ones produced; a failed or unanswered clause stops the rest. */
async function runMulti(env, k) {
  const { c, message } = env, out = []; let ok = true, ran = 0;
  for (const part of k.params.clauses) {
    const ctx = { convo: c, roleNames: rolesOf(message.guild), draft: mem.currentDraft(c), channelNames: channelNamesOf(message.guild), noMulti: true };
    let kk = classify(part, ctx);
    if (kk.primary === "unknown" && k.params.verb) kk = classify(`${k.params.verb} ${part}`, ctx);
    if (kk.primary === "unknown") { out.push(plain(`I couldn't tell what "${clip(part, 50)}" should do, so I stopped there.`)); ok = false; break; }
    const r = await run(kk, { ...env, text: part, picked: undefined });
    if (r.handled === false) { out.push(plain(`I stopped at "${clip(part, 50)}": that one isn't something I can do from here.`)); ok = false; break; }
    ran++;
    if (r.say) out.push(plain(r.say)); out.push(...(r.posts ?? []));
    if (r.ok === false || c.pending) { ok = r.ok !== false; if (r.ok === false && ran < k.params.clauses.length) out.push(plain("I stopped there, so the rest wasn't done.")); break; }
  }
  return posts(out, { ok, k });
}

/**
 * A multi-part request as an ordered plan: everything it depends on is checked first (so nothing is half-built because a role is missing),
 * steps run in order, a failed step stops what depends on it, and the report says exactly what was done, what failed and what was not attempted.
 */
async function runPlan(env, k) {
  const { c, message } = env, guild = message.guild;
  const roles = k.params.roles ?? [];
  for (const q of roles) if (!findRole(guild, q)) return say(`There's no role called "${q}" yet, so I haven't built anything. Create the role first (say "create a ${q} role"), or tell me which existing role should get access.`, { ok: false });
  const results = new Map(), lines = [];
  for (const s of k.params.steps) {
    const dead = (s.dependsOn ?? []).find(d => !results.get(d)?.ok);
    if (dead) { lines.push(`⏭️ **${s.args.name}**: not attempted, because **${results.get(dead)?.name ?? dead}** failed`); results.set(s.id, { ok: false, skipped: true, name: s.args.name }); continue; }
    const args = { ...s.args, private: s.args.private ? "true" : undefined };
    const op = mem.recordOp({ key: `plan:${guild.id}:${s.args.kind}:${String(s.args.name).toLowerCase()}`, guild: guild.id, user: env.uid, action: "channel_create", ok: null });
    const r = await callTool(env, s.tool, args, { primary: "compound.setup" });
    mem.updateOp(op.id, { ok: !!r.outcome.ok, error: r.outcome.error, ids: r.result.id });
    if (!r.outcome.ok) { lines.push(`❌ **${s.args.name}**: ${clip(String(r.post?.content ?? r.post?.components?.[0]?.toJSON?.().components?.map(x => x.content).join(" ") ?? r.outcome.error).replace(/^❌\s*/, ""), 160)}`); results.set(s.id, { ok: false, name: s.args.name }); continue; }
    absorb(c, r);
    const made = guild.channels.cache.get(r.result.id), roleOk = [];
    for (const q of roles) { const role = findRole(guild, q); const can = made?.permissionsFor?.(role)?.has("ViewChannel"); roleOk.push(`${role.name} ${can ? "can" : "CANNOT"} see it`); if (!can) r.outcome.ok = false; }
    lines.push(`${r.outcome.ok ? "✅" : "⚠️"} ${r.result.kind === "category" ? "Category" : "#"}**${r.result.name}**${r.result.parentName ? ` in ${r.result.parentName}` : ""}${r.result.private ? " · private" : ""}${roleOk.length ? ` · ${roleOk.join(", ")}` : ""}`);
    results.set(s.id, { ok: !!r.outcome.ok, name: r.result.name });
  }
  const okAll = [...results.values()].every(x => x.ok), some = [...results.values()].some(x => x.ok);
  c.lastIntent = okAll ? k : c.lastIntent;
  return posts([panel({ title: okAll ? "Done" : some ? "Partly done" : "Nothing was created", accent: okAll ? "up" : some ? "amber" : "down", lines, footer: okAll ? "Each step was read back from Discord" : "Failed steps stopped what depended on them" })], { ok: okAll, k });
}

/* ─────────────────────────── the pipeline ─────────────────────────── */
async function run(k, env) {
  const h = k.multi ? HANDLERS["compound.setup"] : HANDLERS[k.primary];
  if (!h) return { handled: false };
  env.k = k;
  try { const out = await h(env, k); return out.handled === false ? out : { ...out, k: out.resumed ?? k }; } // every answer carries the intent it was for
  catch (e) { console.warn("brain:", k.primary, e?.message ?? e); return say(`I couldn't complete that, so nothing is confirmed as changed (${clip(e?.message ?? e, 120)}).`, { ok: false, k }); }
}

/** The answer to a question the assistant asked: fills the missing piece and runs the original request. */
async function answerPending(env) {
  const { c, text } = env, p = c.pending; if (!p) return null;
  const t = normalize(text);
  if (/^(no|nope|cancel|never ?mind|stop|forget it|skip)\b/.test(t) && !p.yes) { mem.takePending(c); return say("Okay, cancelled.", { ok: true }); }
  if (p.yes) { mem.takePending(c); return /^(y|yes|yeah|yep|sure|ok|okay|do it|go)\b/.test(t) ? run(p.k, { ...env, picked: { again: true } }) : say("Okay, I won't.", { ok: true }); }
  const looksNew = /^(show|list|who|how|what|create|make|add|send|delete|remove|give|pin|find|write|draft|set|remember|forget|do|repeat|invite)\b/.test(t);
  const other = classify(text, { convo: c, roleNames: rolesOf(env.message.guild), draft: mem.currentDraft(c) });
  if (other.primary !== "unknown" && (looksNew || t.split(" ").length > 6)) { c.parked = p; mem.takePending(c); return null; } // a new request, not an answer: the unfinished question is kept so "continue where we stopped" can resume it
  mem.takePending(c);
  const k = structuredClone(p.k), field = p.field, raw = String(text).trim().replace(/[.!]+$/, "");
  const picked = {};
  if (p.options && (field === "channelId" || field === "messageId")) { // answered with a number, an ordinal or a name from the list shown
    const byOrd = pickFromList({ items: p.options }, t), byName = p.options.find(o => normalize(o.label).includes(t) || t.includes(normalize(o.label)));
    const hit = byOrd.item ?? byName ?? (/^\d$/.test(t) ? p.options[Number(t) - 1] : null);
    if (!hit) { mem.setPending(c, p); return say(`I still need to know which one: ${p.options.map((o, i) => `${i + 1}. ${o.label}`).join(" or ")}.`, { ok: false }); }
    picked[field] = hit.id;
  } else if (field === "topic") k.params.topic = origCase(raw, raw);
  else if (field === "name") k.params.name = raw.replace(/^(?:call it|name it|it'?s|its|the name is|name:)\s*/i, "").replace(/^["“']|["”']$/g, "");
  else if (field === "names") { k.params.names = namesFrom(raw); if (!k.params.names.length) { mem.setPending(c, p); return say("I couldn't read any names there. Give me the names, separated by commas.", { ok: false }); } }
  else if (field === "channel") {
    const all = /^(?:all|every|everything|all of them)(?: of)?(?: the)?(?: channels?)?$|^(?:the )?channels$/i.test(raw);
    if (all) { k.target.all = true; delete k.target.channel; }
    else if (k.primary.startsWith("permission.")) k.target.channels = raw.split(/\s*(?:,|\band\b|&)\s*/).map(x => x.replace(/^(?:in|to|into|on|the)\s+/i, "").replace(/\s+channels?$/i, "").replace(/^#/, "").trim()).filter(Boolean);
    else k.target.channel = raw.replace(/^(?:in|to|into|on)\s+(?:the\s+)?/i, "").replace(/\s+channel$/i, "");
  }
  else if (field === "instruction") k.params.instruction = raw;
  else if (field === "when") picked.when = raw;
  else if (field === "choice") { picked.choice = /\bedit|update|change|replace\b/.test(t) ? "edit" : /\bnew|another|post|send|fresh\b/.test(t) ? "new" : null; if (!picked.choice) { mem.setPending(c, p); return say("Should I **edit** the earlier message or post a **new** one?", { ok: false }); } }
  else if (field === "user") k.target.user = raw, k.target.ordinal = null;
  else if (field === "role") k.target.role = raw.replace(/^the\s+/i, "").replace(/\s+role$/i, "");
  else if (field === "roles") k.params.roles = raw;
  return run(k, { ...env, picked });
}

/**
 * Handles one owner message. Returns { handled: true, say? | posts? } when the assistant owns it and has answered, or
 * { handled: false, context } for the language model path (with the retrieved conversation context to give it).
 */
async function handleNow(message, text, config, deps = {}) {
  const guild = message.guild; if (!guild) return { handled: false, context: "" };
  const uid = message.author.id, c = mem.getConvo(mem.convoKey(message));
  const env = { message, text, config, c, uid, resolveMember: deps.resolveMember };
  mem.addTurn(c, "user", text);
  let out = c.pending ? await answerPending(env) : null;
  if (!out) {
    const k = classify(text, { convo: c, roleNames: rolesOf(guild), draft: mem.currentDraft(c), channelNames: channelNamesOf(guild) });
    if (k.primary === "unknown") mem.autoNote(uid, text); // something the owner told me (a preference, how things are): kept for later and shown when relevant
    if (k.primary === "unknown") return { handled: false, context: mem.contextBlock(c, uid, text), classified: k };
    if (k.correction && c.lastIntent) mem.addCorrection(c, { phrase: normalize(lastUserBefore(c)), wrong: c.lastIntent.primary, right: { primary: k.primary, action: k.action, params: k.params, target: k.target }, text });
    if (k.primary === "memory.remember") { const last = c.turns.at(-1); if (last?.role === "user") last.text = "(asked me to remember a preference)"; } // saved notes are never replayed as conversation text
    out = await run(k, env);
    if (out.handled && k.correction && out.ok && out.posts?.length) out.posts = [plain(`Understood, you meant ${k.primary.replace(".", " ")}. Here it is:`), ...out.posts];
  }
  if (!out.handled) return { handled: false, context: mem.contextBlock(c, uid, text) };
  mem.addTurn(c, "assistant", out.say ?? (out.ok === false ? "(that did not work)" : `(did: ${out.k?.primary ?? "it"})`));
  mem.touch(c);
  return out;
}

/** One message at a time per person: replies stay paired with their questions and a repeated command can't race itself. */
const chains = new Map();
export function handle(message, text, config, deps = {}) {
  const key = mem.convoKey(message), prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => handleNow(message, text, config, deps));
  chains.set(key, next);
  next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => {});
  return next;
}

/** Remembers an embed the embed writer made or changed (it keeps its own draft), so "it" in the next message means that announcement. */
export function noteEmbed(message, d) {
  try {
    if (!d?.messageId) return;
    const c = mem.getConvo(mem.convoKey(message)), channel = message.guild?.channels.cache.get(d.channelId);
    c.embed = { title: d.title, body: d.body, channelId: d.channelId, messageId: d.messageId, at: Date.now() };
    const item = { id: d.messageId, channelId: d.channelId, name: `embed in #${channel?.name ?? "?"}`, channelName: channel?.name, text: String(d.title ?? "").slice(0, 160), url: `https://discord.com/channels/${message.guild.id}/${d.channelId}/${d.messageId}` };
    mem.noteEntity(c, "messages", item); mem.setFocus(c, "message", item, "embed");
    mem.noteFact(c, "embed", `Made an announcement embed titled "${String(d.title ?? "").slice(0, 80)}" in #${channel?.name ?? "?"}. Its text: ${String(d.body ?? "").replace(/\s+/g, " ").slice(0, 300)}`, { messageId: d.messageId });
    c.topic = `announcement: ${String(d.title ?? "").slice(0, 60)}`; mem.addTurn(c, "assistant", `(made an embed: ${String(d.title ?? "").slice(0, 80)})`);
  } catch { /* the embed already went out */ }
}

/** After the language-model path ran something, remembers what it was (so "do that again", "it" and corrections still work). */
export function noteLLM(message, call, hooks = {}) {
  try {
    const c = mem.getConvo(mem.convoKey(message));
    const r = { outcome: hooks.outcome ?? {}, result: hooks.result ?? {} };
    if (r.outcome.ok) absorb(c, r);
    c.lastIntent = { primary: "model:" + call.action, action: call.action, params: {}, target: {} };
    mem.recordOp({ guild: message.guild?.id, user: message.author?.id, action: call.action, ok: !!r.outcome.ok, error: r.outcome.error, ids: r.result.id ?? null, via: "model" });
    mem.addTurn(c, "assistant", `(ran ${call.action}${r.outcome.ok === false ? ", it failed" : ""})`);
  } catch { /* the answer already went out */ }
}
export const noteAssistantText = (message, text) => { try { mem.addTurn(mem.getConvo(mem.convoKey(message)), "assistant", text); } catch { /* never blocks an answer */ } };

/** The context for the language-model path: the structured state, retrieved for this message. */
export const contextFor = (message, text) => message.guild ? mem.contextBlock(mem.getConvo(mem.convoKey(message)), message.author.id, text) : "";

/**
 * Guards a call the language model chose. The model's text can be steered by whatever it read (other people's messages, a pasted document),
 * so its choice is never trusted on its own:
 *  - the action must exist (own properties only) and, when the classifier knows the intent, must be a tool that may answer it;
 *  - a risky or changing action needs words in the OWNER's message that actually ask for it (an unrelated message can't trigger a purge);
 *  - the assistant's own safety settings are never changed from a model's choice, only from a direct command;
 *  - @everyone/@here in text it wrote is made harmless unless the owner's message asked for a ping;
 *  - references in its arguments ("it", "the second one", "here") are resolved from the state.
 * Returns { call } to run, or { say } to answer instead.
 */
const STEMS = {
  purge: ["delet", "clear", "purg", "clean", "remov", "wipe"], lock: ["lock", "freez", "silenc"], unlock: ["unlock", "open", "unfreez"],
  set_permission: ["permission", "allow", "deny", "let ", "view", "see", "send", "access", "block"], permission: ["permission", "allow", "deny", "access"], permissions: ["permission", "allow", "deny", "access"],
  hide: ["hide", "hidden", "private", "invisible", "see"], unhide: ["unhide", "show", "visible", "reveal"], delete_channel: ["delet", "remov"], nickname: ["nick", "rename", "call "],
  dm: ["dm", "message", "tell", "pm", "private"], say: ["say", "post", "write", "announc", "tell", "send", "type"], announce: ["announc", "post", "send", "tell"], announce_rich: ["announc", "post", "send", "tell"],
  slowmode: ["slow"], role_delete: ["delet", "remov"], delete_role: ["delet", "remov"], kick: ["kick", "remov"], ban: ["ban"], tempban: ["ban"], unban: ["unban"], timeout: ["timeout", "mute", "silenc", "time out"], untimeout: ["unmute", "untimeout", "timeout"],
  move_channel: ["move", "put"], clone_channel: ["clone", "copy", "duplicat"], rename_channel: ["rename", "call ", "name"], role_edit: ["edit", "change", "colo", "rename", "permission"], edit_role: ["edit", "change", "colo", "rename", "permission"],
  voice_mute: ["mute"], voice_unmute: ["unmute"], voice_disconnect: ["disconnect", "kick", "remov"], voice_move: ["move"], warn: ["warn"], channel_reorder: ["move", "reorder", "position"],
  event_cancel: ["cancel", "delet", "remov"], invite_revoke: ["revoke", "delet", "remov", "cancel", "disable"], message_remove: ["delet", "remov"], message_delete: ["delet", "remov"],
};
const SAFE_READS = new Set(["channel_visibility", "server_overview", "server_info", "member_list", "member_count", "member_online", "member_info", "role_list", "role_info", "role_members", "channel_list", "channel_info", "event_list", "invite_list", "mod_log", "mod_history", "read_messages", "recent_messages", "permission_audit", "role_audit", "scan_spam", "summarize_channel", "whois"]);
export function guard(message, text, call) {
  const c = mem.getConvo(mem.convoKey(message)), action = String(call.action ?? "").toLowerCase();
  const k = classify(text, { convo: c, roleNames: message.guild ? rolesOf(message.guild) : [], draft: mem.currentDraft(c) });
  if (!knownAction(action)) return { say: `I tried to run "${String(action).slice(0, 40)}", which isn't something I can do. Tell me again what you want and I'll pick the right action.` };
  if (k.primary !== "unknown" && !toolAllowed(k.primary, action)) {
    if (k.action && k.action !== "plan" && Object.hasOwn(TOOLS, k.action)) return { overruled: { from: action, to: k.action, primary: k.primary }, call: { ...call, action: k.action, ...(k.params?.role ? { role: k.params.role } : {}) } };
    return { say: "I understood that as something I handle myself, not a server action, so I didn't run anything." };
  }
  if (action === "ai_control" && !/^(status|)$/.test(String(call.op ?? "status").toLowerCase())) return { say: "I only change my own safety settings from a direct command (for example \"disable invites tools\"), never from my own guess, so I left them alone." };
  if (!SAFE_READS.has(action) && k.primary === "unknown") {
    const stems = STEMS[action] ?? [action.split("_")[0]], said = " " + String(text).toLowerCase() + " ";
    if (!stems.some(w => said.includes(w))) return { say: `I wasn't sure you asked me to do that (${action.replace(/_/g, " ")}), so I did nothing. Tell me plainly what you'd like.` };
  }
  const out = { ...call }, wanted = /@everyone|@here|\bping (everyone|the server)|\bnotify everyone/i.test(String(text));
  for (const f of ["text", "title", "reason"]) if (typeof out[f] === "string" && !wanted) out[f] = out[f].replace(/@(everyone|here)/gi, "@\u200b$1");
  if (/^(here|this channel)$/i.test(String(out.channel ?? ""))) delete out.channel;
  const f = c.focus;
  if (/^(it|that|this)$/i.test(String(out.channel ?? "")) && (f?.type === "channel" || f?.type === "category")) out.channel = f.items[0].id;
  const ord = String(out.user ?? "");
  if (/\b(first|second|third|fourth|fifth|last|number \d+)\b/i.test(ord) && c.list?.kind === "members") { const p = pickFromList(c.list, ord); if (p.item) out.user = p.item.id; }
  else if (/^(him|her|them|that (person|member|user))$/i.test(ord) && c.entities.members[0]) out.user = c.entities.members[0].id;
  return { call: out };
}

export { handleListButton, absorb };
