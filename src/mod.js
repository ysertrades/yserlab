import { PermissionFlagsBits as P } from "discord.js";
import { permsOf, allowOf } from "./admin/guard.js";
import { TOOLS, runTool } from "./admin/tools.js";
import "./admin/control.js";
import { runWorkflow } from "./admin/workflows.js";
import { audit } from "./admin/audit.js";
import { confirmButtons } from "./admin/ui.js";
import { env } from "./env.js";
import { viaGemini, viaGroq } from "./ai.js";
import { isAdmin } from "./access.js";
import { newsPicture } from "./calendar/news.js";
import { cardOnRequest } from "./cards.js";
import { picturePost } from "./post.js";
const idsIn = t => [...new Set([...String(t ?? "").matchAll(/<@!?(\d{15,})>/g)].map(x => x[1]))];
/** A plain message (not a card): what the bot says reads as a message, and a tag is a real tag that notifies. */
const textPost = ({ text }) => ({ content: String(text ?? "").slice(0, 1990), allowedMentions: { users: idsIn(text), parse: [] } });
import { candidates, findPerson, tagText } from "./people.js";
import { addCountdown, whenOf } from "./sched.js";

/**
 * Discord moderation and sending, on the owner's word. Every action names the person with a real tag so they (and everyone reading) know who it
 * was about, and says exactly what happened. The owner and other admins are never a target. Needs only the permissions the action itself needs;
 * when one is missing the answer says which.
 */
const DAY = 86_400_000;
const tag = id => `<@${id}>`;
/** Who a message may notify: the people it tags, and everyone only when the owner asked for it with @everyone or @here. */
const pingsOf = t => ({ users: idsIn(t), parse: /(^|[\s>*_~(])@(everyone|here)\b/i.test(String(t ?? "")) ? ["everyone"] : [] });

async function targetOf(message, who) {
  const bot = message.client.user.id;
  const mentioned = [...message.mentions.users.values()].find(u => u.id !== bot);
  let id = mentioned?.id ?? (/\d{15,}/.exec(String(who ?? ""))?.[0] ?? null);
  if (!id && /^(me|myself)$/i.test(String(who ?? "").trim())) id = message.author.id;
  if (!id && who) {
    const found = candidates(String(who).replace(/^@/, ""));
    if (found.length === 1 || (found.length > 1 && found[0].exact && !found[1].exact)) id = found[0].id;
    else if (found.length) { message.__ambiguous = found.slice(0, 4).map(c => c.id); return null; }
  }
  if (!id && who) { // a name: the closest member
    try { const found = await message.guild.members.search({ query: String(who).replace(/^@/, "").slice(0, 32), limit: 1 }); id = found.first()?.id ?? null; } catch { /* needs the members list: ask for a tag instead */ }
  }
  return id;
}
function channelOf(message, name) {
  const mentioned = message.mentions.channels?.first?.();
  if (mentioned && !name) return mentioned;
  if (!name) return message.channel;
  const raw = String(name).replace(/[<>#!&]/g, "").trim(); // "#123…", "<#123…>" and a bare id all mean the channel with that id
  if (/^\d{15,}$/.test(raw)) return message.client.channels.cache.get(raw) ?? message.guild?.channels.cache.get(raw) ?? null;
  if (/^(this|here|current)( channel)?$/i.test(String(name).trim())) return message.channel;
  const q = String(name).toLowerCase().replace(/^#/, "").replace(/[^a-z0-9]+/g, "");
  return message.guild?.channels.cache.find(c => c.isTextBased?.() && c.name.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(q)) ?? null;
}
const missingPermission = e => /Missing (Permissions|Access)|50013|50001/.test(String(e?.message ?? e)) ? "I don't have the permission for that here. Give my role Manage Messages, Moderate Members, Kick Members or Ban Members as the action needs, and keep it above theirs." : null;

const unsure = message => message.__ambiguous?.length ? `I'm not sure which one you mean: ${message.__ambiguous.map(tag).join(" or ")}. Tag the right one (@name) and I'll do it.` : "I'm not sure who you mean. Tag them (@name) so I get exactly the right person.";
const YES = /^\s*(y|yes|yeah|yep|yup|confirm|confirmed|do it|go|go ahead|sure|ok|okay)\b/i;
/** Asks the owner to confirm, in the channel, naming who it is about; true only on a clear yes within 20 seconds. */
/** Who is being asked right now (channel:user). Their reply is the answer to the question, so the main handler must not treat it as a new request. */
export const waiting = new Set(); // kept for the main handler; confirmations are now buttons, so nothing waits on a typed reply
/** Asks the requester to confirm with buttons that expire (see admin/ui.js); true only on Confirm. */
async function confirm(message, text) {
  const [title, ...rest] = String(text).split("\n");
  return confirmButtons(message, { title: title.replace(/\*\*/g, "**"), lines: rest, ttl: 30_000 });
}

/** Every channel a request names ("news, results and #general"), or this one. */
function channelsOf(message, spec) {
  const named = String(spec ?? "").split(/\s*(?:,|&|\+|\band\b)\s*/i).map(x => x.trim()).filter(Boolean);
  const mentioned = [...(message.mentions.channels?.values?.() ?? [])];
  const out = named.length ? named.map(n => channelOf(message, n)) : mentioned.length ? mentioned : [message.channel];
  return [...new Set(out.filter(Boolean))];
}
const pollOptions = v => (Array.isArray(v) ? v : String(v ?? "").split(/\s*[|;]\s*|\s*,\s*/)).map(x => String(x).trim()).filter(Boolean).slice(0, 10);

/** The message an action means by "that one": the one replied to, else the newest before the request. */
async function lastMessage(message, channel) {
  if (message.reference?.messageId) return channel.messages.fetch(message.reference.messageId).catch(() => null);
  const batch = await channel.messages.fetch({ limit: 5, before: message.id }).catch(() => null);
  return batch?.first() ?? null;
}

/** Deletes messages newest first: the last `count`, or all of them, optionally only one person's. Returns how many went. */
async function purge(channel, { count, userId, keepId }) {
  const all = count === "all" || count === Infinity;
  const want = all ? Infinity : Math.max(1, Math.min(1000, Number(count) || 1));
  const picked = [];
  let before;
  for (let round = 0; round < 60 && picked.length < want; round++) { // up to 6000 messages back
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    before = batch.last().id;
    for (const m of batch.values()) {
      if (m.pinned || m.id === keepId || (userId && m.author.id !== userId)) continue;
      picked.push(m);
      if (picked.length >= want) break;
    }
  }
  const fresh = picked.filter(m => Date.now() - m.createdTimestamp < 14 * DAY - 60_000), old = picked.filter(m => !fresh.includes(m));
  let deleted = 0;
  for (let i = 0; i < fresh.length; i += 100) { const chunk = fresh.slice(i, i + 100); if (chunk.length === 1) { await chunk[0].delete().catch(() => {}); deleted++; } else deleted += (await channel.bulkDelete(chunk, true)).size; }
  let slow = 0;
  for (const m of old.slice(0, 150)) { try { await m.delete(); slow++; } catch { /* gone already */ } } // older than two weeks go one by one
  return { deleted: deleted + slow, skippedOld: Math.max(0, old.length - slow) };
}

const mins = n => { n = Math.round(n); return n >= 1440 ? `${Math.round(n / 1440)} day${n >= 2880 ? "s" : ""}` : n >= 60 ? `${Math.round(n / 60)} hour${n >= 120 ? "s" : ""}` : `${n} minute${n === 1 ? "" : "s"}`; };

/** The role or person a channel permission is about: "everyone" (default), a role name, or someone tagged. */
async function permissionTarget(message, who) {
  const q = String(who ?? "").trim().toLowerCase().replace(/^@/, "");
  if (!q || /^(everyone|all|everybody|members|the server|default)$/.test(q)) return { target: message.guild.roles.everyone, label: "@everyone" };
  const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === q) ?? message.guild.roles.cache.find(r => r.name.toLowerCase().includes(q));
  if (role && !/\d{15,}/.test(q)) return { target: role, label: `**${role.name}**` };
  const id = await targetOf(message, who);
  return id ? { target: id, label: tag(id) } : null;
}
/** The one entry point for every Discord action the AI asks for. Registered tools go through the gate (permissions, confirmation, audit, verification); the older actions below run as before. */
const WORKFLOWS = new Set(["workflow", "setup", "setup_category", "setup_course", "setup_vip"]);
async function summarize(transcript) {
  const system = "You summarise a Discord conversation for the server owner. Write 3 to 6 short bullet points: the topics, decisions, open questions and anything needing the owner's attention. Plain words, no preamble.";
  try { const out = env.geminiKey ? await viaGemini(system, [], transcript) : await viaGroq(system, [], transcript); return out?.text ?? null; } catch { return null; }
}
export async function moderate(message, args, config, hooks = {}) {
  if (!message.guild) return textPost({ text: "Moderation only works inside a server." });
  const action = String(args.action ?? "").toLowerCase();
  if (WORKFLOWS.has(action)) return runWorkflow(message, args, config);
  if (TOOLS[action]) {
    const channel = channelsOf(message, args.channel)[0];
    if (!channel && args.channel && !/^(everyone|all)$/i.test(String(args.channel))) { const own = ["invite_create", "channel_create"].includes(action); if (!own) return textPost({ text: `I couldn't find the channel "${args.channel}".` }); }
    const extras = { ...hooks, channel: channel ?? message.channel, summarize, resolveMember: async () => { const id = await targetOf(message, args.user); if (id) extras.targetId = id; return id ? message.guild.members.fetch(id).catch(() => null) : null; } };
    const call = { ...args, channels: action === "announce" || action === "announce_rich" ? channelsOf(message, args.channel) : undefined };
    return runTool(message, action, call, config, extras);
  }
  const t0 = Date.now();
  const post = await moderateLegacy(message, args, config);
  const said = String(post?.content ?? "");
  audit({ guild: message.guild.id, user: message.author?.id, action, target: args.user ? String(args.user).slice(0, 60) : undefined, risk: "legacy", permission: "ok", ok: !/couldn't|can't|don't|not sure|won't|missing|cancel/i.test(said), error: said.slice(0, 120), ms: Date.now() - t0 });
  return post;
}
async function moderateLegacy(message, args, config) {
  if (!message.guild) return textPost({ text: "Moderation only works inside a server." });
  const action = String(args.action ?? "").toLowerCase();
  const channel = channelsOf(message, args.channel)[0];
  if (!channel) return textPost({ text: `I couldn't find the channel "${args.channel}".`, accent: "down" });
  const reason = String(args.reason || `Asked by ${message.author.tag}`).slice(0, 400);
  try {
    const done = await extra(message, args, config, action, channel, reason);
    if (done) return done;
    if (action === "purge") {
      const named = (args.user && !/^(everyone|all|anyone|nobody|none|any)$/i.test(String(args.user).trim())) || [...message.mentions.users.values()].some(u => u.id !== message.client.user.id);
      const userId = named ? await targetOf(message, args.user) : null;
      if (named && !userId) return textPost({ text: unsure(message), accent: "down" });
      const count = String(args.count ?? "").toLowerCase() === "all" ? "all" : Math.max(1, Math.min(1000, Math.floor(Number(args.count)) || 1));
      const wide = userId || count === "all" || count > 25;
      // The owner's own word is enough: no second question (a "yes" reply used to be read as a new request and asked again).
      const { deleted, skippedOld } = await purge(channel, { count, userId, keepId: message.id });
      return textPost({ text: `🧹 Deleted **${deleted}** message${deleted === 1 ? "" : "s"}${userId ? ` from ${tag(userId)}` : ""} in ${channel}${count === "all" ? " (all I could reach)" : `, newest first`}.${skippedOld ? `\n-# ${skippedOld} older than I could clear were left.` : ""}`, accent: "accent" });
    }
    if (action === "slowmode") { const s = Math.max(0, Math.min(21600, Math.round(Number(args.seconds ?? args.minutes * 60) || 0))); await channel.setRateLimitPerUser(s, reason); return textPost({ text: s ? `🐢 Slowmode in ${channel}: one message every **${s}s**.` : `⚡ Slowmode is off in ${channel}.` }); }
    if (action === "lock" || action === "unlock") { await channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: action === "lock" ? false : null }, { reason }); return textPost({ text: action === "lock" ? `🔒 ${channel} is locked. Nobody can send here until I unlock it.` : `🔓 ${channel} is open again.` }); }
    if (action === "unban") { const id = await targetOf(message, args.user); if (!id) return textPost({ text: "Tell me who to unban (their ID or tag).", accent: "down" }); await message.guild.bans.remove(id, reason); return textPost({ text: `✅ ${tag(id)} is unbanned.` }); }

    const id = await targetOf(message, args.user);
    if (!id) return textPost({ text: unsure(message), accent: "down" });
    if (id === message.author.id || isAdmin(config, id) || id === message.client.user.id) return textPost({ text: `I won't do that to ${tag(id)}: they're an admin (or me).`, accent: "down" });
    if (action === "warn") return textPost({ text: `⚠️ ${tag(id)} this is a warning${args.reason ? `: ${args.reason}` : ""}.`, accent: "amber" });
    if ((action === "ban" || action === "kick") && !(await confirm(message, `${action === "ban" ? "🔨 Ban" : "👢 Kick"} ${tag(id)}?`))) return textPost({ text: "Cancelled." });
    if (action === "ban") { await message.guild.members.ban(id, { reason, deleteMessageSeconds: Math.max(0, Math.min(7, Number(args.days) || 0)) * 86400 }); return textPost({ text: `🔨 ${tag(id)} is **banned**${args.reason ? `: ${args.reason}` : ""}${args.days ? `. Their last ${args.days} day(s) of messages were removed.` : "."}`, accent: "down" }); }
    const member = await message.guild.members.fetch(id).catch(() => null);
    if (!member) return textPost({ text: `${tag(id)} isn't in this server.`, accent: "down" });
    if (action === "kick") { await member.kick(reason); return textPost({ text: `👢 ${tag(id)} was **kicked**${args.reason ? `: ${args.reason}` : ""}.`, accent: "amber" }); }
    if (action === "timeout" || action === "mute") { const m = Math.max(1, Math.min(40320, Number(args.minutes) || 10)); await member.timeout(m * 60_000, reason); return textPost({ text: `🔇 ${tag(id)} is **timed out for ${mins(m)}**${args.reason ? `: ${args.reason}` : ""}.`, accent: "amber" }); }
    if (action === "untimeout" || action === "unmute") { await member.timeout(null, reason); return textPost({ text: `🔊 ${tag(id)} can talk again.` }); }
    return textPost({ text: `I don't know the action "${action}". I can purge, timeout, untimeout, kick, ban, unban, warn, slowmode, lock, unlock, hide, unhide, set_permission, create/edit/delete roles and channels, voice mute/move/disconnect, and read the server.`, accent: "down" });
  } catch (e) {
    console.warn("moderation:", e?.message ?? e); // the technical reason goes to the log, never to the channel
    return textPost({ text: missingPermission(e) ?? "I couldn't complete that action, so nothing was changed. Try again, or tell me exactly what you want and I'll take another route.", accent: "down" });
  }
}

/** Sends something from the app (the news calendar, a PnL card, or words) to a channel the owner names; returns the reply for where they asked. */
export async function sendFromApp(message, args, { owner, config }) {
  const targets = channelsOf(message, args.channel).filter(c => c?.isSendable?.());
  if (!targets.length) return textPost({ text: `I couldn't find a channel called "${args.channel ?? ""}" that I can send to.`, accent: "down" });
  const what = String(args.what ?? "").toLowerCase();
  const sendAll = async build => { for (const c of targets) await c.send(build()); };
  try {
    if (/^(news|economic|calendar)/.test(what) && !/pnl|card/.test(what)) {
      const kind = /week/.test(what) ? "week" : /tomorrow/.test(what) ? "tomorrow" : "today";
      const pic = await newsPicture(kind, config);
      if (!pic) return textPost({ text: `There's no news to send for ${kind === "week" ? "this week" : kind}.` });
      await sendAll(() => picturePost({ png: pic.png, name: pic.name, text: pic.text }));
    } else if (/^pnl|card/.test(what)) {
      const period = /month|calendar/.test(what) ? "monthly" : /week/.test(what) ? "weekly" : "daily";
      const card = await cardOnRequest(owner, period, /last|prev|yesterday/.test(what + " " + (args.which ?? "")));
      if (!card) return textPost({ text: "No trades logged for that period, so there's no card to send." });
      await sendAll(() => picturePost({ png: card.png, name: `${card.name}.png`, text: `**${card.label}**` }));
    } else if (what === "text" || args.text) {
      if (!args.text) return textPost({ text: "What should I write?", accent: "down" });
      const words = tagText(String(args.text).slice(0, 1990), { me: message.author.id });
      await sendAll(() => ({ content: words, allowedMentions: pingsOf(words) }));
    } else return textPost({ text: "I can send the news (today, tomorrow or the week), a PnL card, or a message of yours.", accent: "down" });
    return textPost({ text: `📤 Sent to ${targets.join(" ")}.` });
  } catch (e) {
    return textPost({ text: missingPermission(e) ?? `I couldn't send that: ${e?.message ?? e}`, accent: "down" });
  }
}

/** The rest of what the owner can ask for: everything that is a Discord action but not a punishment. Returns a post, or undefined when the action is not one of these. */
async function extra(message, args, config, action, channel, reason) {
  const me = message.author.id;
  const text = tagText(String(args.text ?? args.reason ?? ""), { me });
  if (action === "set_permission" || action === "permission" || action === "permissions") {
    const wanted = permsOf(args.permission ?? args.permissions ?? args.text);
    if (!wanted.length) return textPost({ text: "Which permission? For example view the channel, send messages, add reactions, attach files, embed links, read history, mention @everyone, connect or speak.", accent: "down" });
    const state = allowOf(args.allow ?? args.state ?? args.value);
    if (state === undefined) return textPost({ text: "Should I allow it, deny it, or reset it to the default?", accent: "down" });
    const who = await permissionTarget(message, args.target ?? args.role ?? args.user);
    if (!who) return textPost({ text: unsure(message), accent: "down" });
    const flags = Object.fromEntries(wanted.map(([k]) => [k, state]));
    await channel.permissionOverwrites.edit(who.target, flags, { reason });
    return textPost({ text: `${state === false ? "🚫" : state === true ? "✅" : "↩️"} In ${channel}, ${who.label} ${state === false ? "can no longer" : state === true ? "can now" : "is back to the default for"}: ${wanted.map(w => w[1]).join(", ")}.` });
  }
  if (action === "hide" || action === "unhide") {
    const who = await permissionTarget(message, args.target ?? args.role ?? args.user);
    if (!who) return textPost({ text: unsure(message), accent: "down" });
    await channel.permissionOverwrites.edit(who.target, { ViewChannel: action === "hide" ? false : null }, { reason });
    return textPost({ text: action === "hide" ? `🙈 ${channel} is hidden from ${who.label}: they can no longer see it at all.` : `👀 ${channel} is visible to ${who.label} again.` });
  }
  if (action === "delete_channel") {
    if (!(await confirm(message, `🗑️ Delete the channel ${channel} for good?`))) return textPost({ text: "Cancelled. Nothing was deleted." });
    const name = channel.name; const here = channel.id === message.channelId;
    await channel.delete(reason);
    return textPost({ text: here ? "🗑️ Deleted this channel." : `🗑️ Deleted **#${name}**.` });
  }
  if (action === "create_role" || action === "edit_role" || action === "delete_role") {
    const q = String(args.role ?? args.name ?? "").trim();
    if (!q) return textPost({ text: "Which role?", accent: "down" });
    const find = () => message.guild.roles.cache.find(r => r.name.toLowerCase() === q.toLowerCase()) ?? message.guild.roles.cache.find(r => r.name.toLowerCase().includes(q.toLowerCase()));
    const color = args.color ? String(args.color).trim().replace(/^#?/, "#") : undefined;
    if (action === "create_role") { const r = await message.guild.roles.create({ name: q.slice(0, 100), color: color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined, hoist: /^(true|yes|on)$/i.test(String(args.hoist ?? "")), mentionable: /^(true|yes|on)$/i.test(String(args.mentionable ?? "")), reason }); return textPost({ text: `🎖️ Created the role **${r.name}**${color ? ` in ${color}` : ""}.` }); }
    const role = find();
    if (!role) return textPost({ text: `I couldn't find a role called "${q}".`, accent: "down" });
    if (action === "delete_role") { if (!(await confirm(message, `🗑️ Delete the role **${role.name}**?`))) return textPost({ text: "Cancelled." }); await role.delete(reason); return textPost({ text: `🗑️ Deleted the role **${role.name}**.` }); }
    const patch = { reason };
    if (color && /^#[0-9a-f]{6}$/i.test(color)) patch.color = color;
    if (args.name && args.role) patch.name = String(args.name).slice(0, 100);
    if (args.hoist != null) patch.hoist = /^(true|yes|on)$/i.test(String(args.hoist));
    if (args.mentionable != null) patch.mentionable = /^(true|yes|on)$/i.test(String(args.mentionable));
    await role.edit(patch);
    return textPost({ text: `🎖️ Updated **${role.name}**${patch.color ? ` (colour ${patch.color})` : ""}.` });
  }
  if (action === "nsfw" || action === "age_restrict") { await channel.setNSFW(!/^(false|no|off)$/i.test(String(args.allow ?? "true")), reason); return textPost({ text: `🔞 Age restriction updated in ${channel}.` }); }
  if (action === "move_channel" || action === "category") { const q = String(args.name ?? args.topic ?? "").toLowerCase().replace(/[^a-z0-9]+/g, ""); const cat = message.guild.channels.cache.find(c => c.type === 4 && c.name.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(q)); if (!cat) return textPost({ text: `I couldn't find a category called "${args.name ?? ""}".`, accent: "down" }); await channel.setParent(cat.id, { lockPermissions: false, reason }); return textPost({ text: `📁 Moved ${channel} to **${cat.name}**.` }); }
  if (action === "clone_channel") { const c = await channel.clone({ name: args.name ? String(args.name).slice(0, 90) : undefined, reason }); return textPost({ text: `✅ Copied ${channel} as ${c}, with the same permissions.` }); }
  if (action === "voice_mute" || action === "voice_unmute" || action === "voice_disconnect" || action === "voice_move") {
    const id = await targetOf(message, args.user); if (!id) return textPost({ text: "Tag the person so I know exactly who you mean.", accent: "down" });
    const m = await message.guild.members.fetch(id).catch(() => null);
    if (!m?.voice?.channel) return textPost({ text: `${tag(id)} isn't in a voice channel.`, accent: "down" });
    if (action === "voice_disconnect") await m.voice.disconnect(reason);
    else if (action === "voice_move") { const dest = channelOf(message, args.name ?? args.channel); if (!dest?.isVoiceBased?.()) return textPost({ text: "Which voice channel should I move them to?", accent: "down" }); await m.voice.setChannel(dest, reason); }
    else await m.voice.setMute(action === "voice_mute", reason);
    return textPost({ text: `🎙️ Done: ${action.replace("voice_", "")} for ${tag(id)}.` });
  }
  if (action === "thread_archive" || action === "thread_lock") { if (!channel.isThread?.()) return textPost({ text: "That only works inside a thread.", accent: "down" }); if (action === "thread_lock") await channel.setLocked(true, reason); await channel.setArchived(true, reason); return textPost({ text: "🧵 Thread closed." }); }  if (action === "server_info" || action === "members" || action === "member_count") {
    // Counts come from Discord itself (no member list needed), so they are right even with a large server.
    const g = await message.client.guilds.fetch({ guild: message.guild.id, withCounts: true }).catch(() => message.guild);
    const total = g.approximateMemberCount ?? g.memberCount ?? message.guild.memberCount, online = g.approximatePresenceCount;
    const ch = message.guild.channels.cache, roles = message.guild.roles.cache.size - 1;
    const kinds = { text: ch.filter(c => c.isTextBased?.() && !c.isThread?.() && !c.isVoiceBased?.()).size, voice: ch.filter(c => c.isVoiceBased?.()).size };
    const owner = await message.guild.fetchOwner().catch(() => null);
    return textPost({ text: `📊 **${message.guild.name}**\n👥 **${total}** members${online != null ? ` · ${online} online` : ""}\n💬 ${kinds.text} text and ${kinds.voice} voice channels · 🎖️ ${roles} roles\n🚀 Boost level ${message.guild.premiumTier} (${message.guild.premiumSubscriptionCount ?? 0} boosts)${owner ? `\n👑 Owner: ${tag(owner.id)}` : ""}\n-# Created ${new Date(message.guild.createdTimestamp).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}` });
  }
  if (action === "member_info" || action === "whois") {
    const id = await targetOf(message, args.user);
    if (!id) return textPost({ text: "Tag the person so I know exactly who you mean.", accent: "down" });
    const m = await message.guild.members.fetch(id).catch(() => null);
    if (!m) return textPost({ text: `${tag(id)} isn't in this server.`, accent: "down" });
    const when = d => d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "unknown";
    const roles = m.roles.cache.filter(r => r.id !== message.guild.id).sort((a, b) => b.position - a.position).map(r => r.name).slice(0, 12);
    return textPost({ text: `👤 ${tag(id)}\nJoined **${when(m.joinedTimestamp)}** · account created ${when(m.user.createdTimestamp)}\nRoles: ${roles.join(", ") || "none"}${m.communicationDisabledUntilTimestamp > Date.now() ? "\n🔇 Timed out right now" : ""}` });
  }
  if (action === "read_messages" || action === "recent_messages") {
    const n = Math.max(1, Math.min(25, Math.floor(Number(args.count)) || 10));
    const batch = await channel.messages.fetch({ limit: n, before: message.id }).catch(() => null);
    if (!batch?.size) return textPost({ text: `I couldn't read messages in ${channel}.`, accent: "down" });
    const lines = [...batch.values()].reverse().map(m => `**${m.member?.displayName ?? m.author.username}**: ${String(m.content || (m.attachments.size ? "[attachment]" : "[embed]")).replace(/\s+/g, " ").slice(0, 160)}`);
    return textPost({ text: `📜 Last ${lines.length} in ${channel}\n${lines.join("\n")}` });
  }  if (action === "remind" || action === "reminder" || action === "alert") {
    // A reminder that really notifies: it tags the person (the owner unless someone else is named), and everyone if asked, in the channel it was set in, and also sends a private message.
    const what = String(args.text ?? args.reason ?? "").trim() || "your reminder";
    const named = args.user && !/^(me|myself)$/i.test(String(args.user).trim()) ? await targetOf(message, args.user) : null;
    const id = named ?? me;
    const words = tagText(what, { me });
    const everyone = /(^|[\s>*_~(])@(everyone|here)\b/i.test(words);
    const post = `⏰ ${everyone ? "" : `${tag(id)} `}**Reminder:** ${words}`;
    await channel.send({ content: post.slice(0, 1990), allowedMentions: pingsOf(post) });
    if (!everyone) message.client.users.fetch(id).then(u => u.send({ content: `⏰ **Reminder:** ${words.replace(/<@!?\d+>/g, "").trim() || what}`.slice(0, 1990), allowedMentions: { parse: [] } })).catch(() => {});
    return textPost({ text: "-# ⏰ Reminder sent." });
  }  if (action === "say" || action === "announce") { if (!text) return textPost({ text: "What should I say?", accent: "down" }); for (const c of channelsOf(message, args.channel)) await c.send({ content: text.slice(0, 1990), allowedMentions: pingsOf(text) }); return textPost({ text: `📤 Said it in ${channelsOf(message, args.channel).join(" ")}.` }); }
  if (action === "poll") {
    const options = pollOptions(args.options);
    if (!args.question || options.length < 2) return textPost({ text: "A poll needs a question and at least two options.", accent: "down" });
    const hours = Math.max(1, Math.min(168, Math.round(Number(args.hours) || 24)));
    for (const c of channelsOf(message, args.channel)) await c.send({ poll: { question: { text: String(args.question).slice(0, 300) }, answers: options.map(o => ({ text: o.slice(0, 55) })), duration: hours, allowMultiselect: /multi/i.test(String(args.mode ?? "")) } });
    return textPost({ text: `📊 Poll posted: **${args.question}**` });
  }
  if (action === "pin" || action === "unpin") { const m = await lastMessage(message, channel); if (!m) return textPost({ text: "I couldn't find the message.", accent: "down" }); await (action === "pin" ? m.pin(reason) : m.unpin(reason)); return textPost({ text: action === "pin" ? "📌 Pinned." : "Unpinned." }); }
  if (action === "react") { const m = await lastMessage(message, channel); if (!m || !args.emoji) return textPost({ text: "Tell me which emoji and which message (reply to it).", accent: "down" }); for (const e of String(args.emoji).split(/\s+/).filter(Boolean).slice(0, 10)) await m.react(e).catch(() => {}); return textPost({ text: "Reacted." }); }
  if (action === "create_channel") { const c = await message.guild.channels.create({ name: String(args.name || "new-channel").slice(0, 90), topic: args.topic ? String(args.topic).slice(0, 1000) : undefined, reason }); return textPost({ text: `✅ Created ${c}.` }); }
  if (action === "rename_channel") { if (!args.name) return textPost({ text: "What should it be called?", accent: "down" }); await channel.setName(String(args.name).slice(0, 90), reason); return textPost({ text: `✏️ Renamed to ${channel}.` }); }
  if (action === "topic") { await channel.setTopic(String(args.topic ?? args.text ?? "").slice(0, 1000), reason); return textPost({ text: `📝 Topic set in ${channel}.` }); }
  if (action === "countdown") {
    const runAt = whenOf(args);
    if (!runAt) return textPost({ text: "Tell me when it ends: in how long, or at what time (New York).", accent: "down" });
    const label = String(args.text || args.name || "Countdown").slice(0, 120);
    const msg = await channel.send({ content: `⏳ **${label}**` });
    addCountdown({ args: { text: label }, runAt, channelId: channel.id, messageId: msg.id, guildId: message.guildId, ownerId: me, nextAt: Date.now() + 5000 });
    return textPost({ text: `⏳ Counting down to **${label}** in ${channel}.` });
  }
  if (["dm", "role_add", "role_remove", "nickname"].includes(action)) {
    const id = await targetOf(message, args.user);
    if (!id) return textPost({ text: "Tag the person so I know exactly who you mean.", accent: "down" });
    if (action === "dm") { const user = await message.client.users.fetch(id); await user.send({ content: text || "👋", allowedMentions: { parse: [] } }); return textPost({ text: `📨 Sent ${tag(id)} a private message.` }); }
    const member = await message.guild.members.fetch(id).catch(() => null);
    if (!member) return textPost({ text: `${tag(id)} isn't in this server.`, accent: "down" });
    if (action === "nickname") { await member.setNickname(args.name ? String(args.name).slice(0, 32) : null, reason); return textPost({ text: `🏷️ ${tag(id)} is now called **${args.name || "their own name"}**.` }); }
    const q = String(args.role ?? "").toLowerCase();
    const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === q) ?? message.guild.roles.cache.find(r => q && r.name.toLowerCase().includes(q));
    if (!role) return textPost({ text: `I couldn't find a role called "${args.role ?? ""}".`, accent: "down" });
    await (action === "role_add" ? member.roles.add(role, reason) : member.roles.remove(role, reason));
    return textPost({ text: action === "role_add" ? `🎖️ ${tag(id)} now has **${role.name}**.` : `${tag(id)} no longer has **${role.name}**.` });
  }
  return undefined;
}
