import { isAdmin } from "./access.js";
import { newsPicture } from "./calendar/news.js";
import { cardOnRequest } from "./cards.js";
import { picturePost, textPost } from "./post.js";

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
  if (!id && who) { // a name: the closest member
    try { const found = await message.guild.members.search({ query: String(who).replace(/^@/, "").slice(0, 32), limit: 1 }); id = found.first()?.id ?? null; } catch { /* needs the members list: ask for a tag instead */ }
  }
  return id;
}
function channelOf(message, name) {
  const mentioned = message.mentions.channels.first();
  if (mentioned) return mentioned;
  if (!name) return message.channel;
  const q = String(name).toLowerCase().replace(/^#/, "").replace(/[^a-z0-9]+/g, "");
  return message.guild?.channels.cache.find(c => c.isTextBased?.() && c.name.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(q)) ?? null;
}
const missingPermission = e => /Missing (Permissions|Access)|50013|50001/.test(String(e?.message ?? e)) ? "I don't have the permission for that here. Give my role Manage Messages, Moderate Members, Kick Members or Ban Members as the action needs, and keep it above theirs." : null;

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
  const channel = channelOf(message, args.channel);
  if (!channel) return textPost({ text: `I couldn't find the channel "${args.channel}".`, accent: "down" });
  const reason = String(args.reason || `Asked by ${message.author.tag}`).slice(0, 400);
  try {
    if (action === "purge") {
      const named = (args.user && !/^(everyone|all|anyone|nobody|none|any)$/i.test(String(args.user).trim())) || [...message.mentions.users.values()].some(u => u.id !== message.client.user.id);
      const userId = named ? await targetOf(message, args.user) : null;
      if (named && !userId) return textPost({ text: "I couldn't tell who you mean. Tag them (@name) and I'll clear their messages.", accent: "down" });
      const count = String(args.count ?? "").toLowerCase() === "all" ? "all" : Number(args.count) || 1;
      const { deleted, skippedOld } = await purge(channel, { count, userId, keepId: message.id });
      return textPost({ text: `🧹 Deleted **${deleted}** message${deleted === 1 ? "" : "s"}${userId ? ` from ${tag(userId)}` : ""} in ${channel}${count === "all" ? " (all I could reach)" : `, newest first`}.${skippedOld ? `\n-# ${skippedOld} older than I could clear were left.` : ""}`, accent: "accent" });
    }
    if (action === "slowmode") { const s = Math.max(0, Math.min(21600, Math.round(Number(args.seconds ?? args.minutes * 60) || 0))); await channel.setRateLimitPerUser(s, reason); return textPost({ text: s ? `🐢 Slowmode in ${channel}: one message every **${s}s**.` : `⚡ Slowmode is off in ${channel}.` }); }
    if (action === "lock" || action === "unlock") { await channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: action === "lock" ? false : null }, { reason }); return textPost({ text: action === "lock" ? `🔒 ${channel} is locked. Nobody can send here until I unlock it.` : `🔓 ${channel} is open again.` }); }
    if (action === "unban") { const id = await targetOf(message, args.user); if (!id) return textPost({ text: "Tell me who to unban (their ID or tag).", accent: "down" }); await message.guild.bans.remove(id, reason); return textPost({ text: `✅ ${tag(id)} is unbanned.` }); }

    const id = await targetOf(message, args.user);
    if (!id) return textPost({ text: "Tag the person (or give their ID) so I know exactly who you mean.", accent: "down" });
    if (id === message.author.id || isAdmin(config, id) || id === message.client.user.id) return textPost({ text: `I won't do that to ${tag(id)}: they're an admin (or me).`, accent: "down" });
    if (action === "warn") return textPost({ text: `⚠️ ${tag(id)} this is a warning${args.reason ? `: ${args.reason}` : ""}.`, accent: "amber" });
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
  const channel = channelOf(message, args.channel);
  if (!channel?.isSendable?.()) return textPost({ text: `I couldn't find a channel called "${args.channel ?? ""}" that I can send to.`, accent: "down" });
  const what = String(args.what ?? "").toLowerCase();
  try {
    if (/^news/.test(what)) {
      const kind = /week/.test(what) ? "week" : /tomorrow/.test(what) ? "tomorrow" : "today";
      const pic = await newsPicture(kind, config);
      if (!pic) return textPost({ text: `There's no news to send for ${kind === "week" ? "this week" : kind}.` });
      await channel.send(picturePost({ png: pic.png, name: pic.name, text: pic.text }));
    } else if (/^pnl|card/.test(what)) {
      const period = /month/.test(what) ? "monthly" : /week/.test(what) ? "weekly" : "daily";
      const card = await cardOnRequest(owner, period, /last|prev|yesterday/.test(what + " " + (args.which ?? "")));
      if (!card) return textPost({ text: "No trades logged for that period, so there's no card to send." });
      await channel.send(picturePost({ png: card.png, name: `${card.name}.png`, text: `**${card.label}**` }));
    } else if (what === "text" || args.text) {
      if (!args.text) return textPost({ text: "What should I write?", accent: "down" });
      await channel.send(textPost({ text: String(args.text).slice(0, 3800) }));
    } else return textPost({ text: "I can send the news (today, tomorrow or the week), a PnL card, or a message of yours.", accent: "down" });
    return textPost({ text: `📤 Sent to ${channel}.` });
  } catch (e) {
    return textPost({ text: missingPermission(e) ?? `I couldn't send that: ${e?.message ?? e}`, accent: "down" });
  }
}
