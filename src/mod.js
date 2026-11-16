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
  if (/^\d{15,}$/.test(String(name))) return message.guild?.channels.cache.get(String(name)) ?? null;
  if (/^(this|here|current)( channel)?$/i.test(String(name).trim())) return message.channel;
  const q = String(name).toLowerCase().replace(/^#/, "").replace(/[^a-z0-9]+/g, "");
  return message.guild?.channels.cache.find(c => c.isTextBased?.() && c.name.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(q)) ?? null;
}
const missingPermission = e => /Missing (Permissions|Access)|50013|50001/.test(String(e?.message ?? e)) ? "I don't have the permission for that here. Give my role Manage Messages, Moderate Members, Kick Members or Ban Members as the action needs, and keep it above theirs." : null;

const unsure = message => message.__ambiguous?.length ? `I'm not sure which one you mean: ${message.__ambiguous.map(tag).join(" or ")}. Tag the right one (@name) and I'll do it.` : "I'm not sure who you mean. Tag them (@name) so I get exactly the right person.";
const YES = /^\s*(y|yes|yeah|yep|yup|confirm|confirmed|do it|go|go ahead|sure|ok|okay)\b/i;
/** Asks the owner to confirm, in the channel, naming who it is about; true only on a clear yes within 20 seconds. */
async function confirm(message, text) {
  if (!message.id || !message.channel?.awaitMessages) return true; // scheduled: nobody to ask
  const ask = await message.channel.send({ content: `${text}\nReply **yes** within 20 seconds to do it.`, allowedMentions: { users: idsIn(text), parse: [] } });
  const got = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max: 1, time: 20_000 }).catch(() => null);
  const reply = got?.first();
  ask.delete().catch(() => {}); if (reply && YES.test(reply.content)) reply.delete().catch(() => {});
  return !!reply && YES.test(reply.content);
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

/** Runs one moderation request; returns the post to reply with. */
export async function moderate(message, args, config) {
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
      const wide = userId || count === "all" || count > 25;
      if (wide && !(await confirm(message, `🧹 Delete ${count === "all" ? "**all**" : `the last **${count}**`} message${count === 1 ? "" : "s"}${userId ? ` from ${tag(userId)}${userId === message.author.id ? " (that's **you**)" : ""}` : ` in ${channel}`}?`))) return textPost({ text: "Cancelled. Nothing was deleted." });
      const count = String(args.count ?? "").toLowerCase() === "all" ? "all" : Number(args.count) || 1;
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
    return textPost({ text: `I don't know the action "${action}". I can purge, timeout, untimeout, kick, ban, unban, warn, slowmode, lock and unlock.`, accent: "down" });
  } catch (e) {
    return textPost({ text: missingPermission(e) ?? `That didn't work: ${e?.message ?? e}`, accent: "down" });
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
      await sendAll(() => ({ content: words, allowedMentions: { users: idsIn(words), parse: [] } }));
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
  if (action === "say" || action === "announce") { if (!text) return textPost({ text: "What should I say?", accent: "down" }); for (const c of channelsOf(message, args.channel)) await c.send({ content: text.slice(0, 1990), allowedMentions: { users: idsIn(text), parse: [] } }); return textPost({ text: `📤 Said it in ${channelsOf(message, args.channel).join(" ")}.` }); }
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
