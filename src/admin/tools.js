import { ChannelType, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, OverwriteType, PermissionFlagsBits as P } from "discord.js";
import { audit, addWarning, allWarnings, recentAudit, warningsOf } from "./audit.js";
import { DANGEROUS, botCanEditMember, botCanEditRole, botMissing, delegable, nameOfPerm, permNames, sayMissing, userCan, userCanEditMember, userCanEditRole, userMissing, permsOf } from "./guard.js";
import { confirmButtons, panel } from "./ui.js";
import { whenOf, addJob } from "../sched.js";

/**
 * The administrator's tool registry. Each tool says what it is (a capability group the owner can switch off), how risky it is (high-risk ones
 * ask for confirmation first), what the requester and the bot must be allowed to do, and what it runs. runTool is the only way in: it checks the
 * switches, both permission sets and the confirmation, runs the tool, writes the audit line and turns any failure into a plain explanation.
 * Nothing here says it did something unless Discord returned it, and each change is read back afterwards.
 */
const plain = text => ({ content: String(text).slice(0, 1990), allowedMentions: { parse: [] } });
const tag = id => `<@${id}>`;
const stamp = (ms, f = "R") => `<t:${Math.floor(ms / 1000)}:${f}>`;
const clean = s => String(s ?? "").toLowerCase().replace(/^[#@]/, "").replace(/[^a-z0-9]+/g, "");
const KINDS = { text: ChannelType.GuildText, announcement: ChannelType.GuildAnnouncement, announcements: ChannelType.GuildAnnouncement, news: ChannelType.GuildAnnouncement, forum: ChannelType.GuildForum, voice: ChannelType.GuildVoice, stage: ChannelType.GuildStageVoice, category: ChannelType.GuildCategory };
const kindName = type => ({ [ChannelType.GuildText]: "text", [ChannelType.GuildVoice]: "voice", [ChannelType.GuildCategory]: "category", [ChannelType.GuildAnnouncement]: "announcement", [ChannelType.GuildForum]: "forum", [ChannelType.GuildStageVoice]: "stage" }[type] ?? "other");
const csv = v => (Array.isArray(v) ? v : String(v ?? "").split(/\s*(?:,|&|\+|\band\b)\s*/i)).map(x => String(x).trim()).filter(Boolean);
const friendly = (message, text) => Object.assign(new Error(message), { friendly: text });

export const findRole = (guild, q) => {
  const k = clean(q); if (!k) return null;
  const forms = [k, k.replace(/s$/, "")].filter((x, i, a) => x && a.indexOf(x) === i); // "instructors" finds the role "Instructor"
  for (const f of forms) { const hit = guild.roles.cache.find(r => clean(r.name) === f); if (hit) return hit; }
  for (const f of forms) { const hit = guild.roles.cache.find(r => clean(r.name).includes(f)); if (hit) return hit; }
  return null;
};
export const findChannel = (guild, q, types) => {
  const k = clean(q); if (!k) return null;
  const pool = guild.channels.cache.filter(c => !c.isThread?.() && (!types || types.includes(c.type)));
  const id = String(q).replace(/\D/g, "");
  return (id.length >= 15 ? pool.find(c => c.id === id) : null) ?? pool.find(c => clean(c.name) === k) ?? pool.find(c => clean(c.name).includes(k)) ?? null;
};
const seconds = a => {
  if (/^(true|yes|1)$/i.test(String(a.permanent ?? "")) || /never|permanent|forever/i.test(String(a.expires ?? a.max_age ?? ""))) return 0;
  const n = x => Number(x) || 0;
  const direct = n(a.max_age_seconds) || n(a.max_age_minutes) * 60 || n(a.max_age_hours) * 3600 || n(a.max_age_days) * 86400;
  if (direct) return Math.min(direct, 604800);
  const m = /(\d+(?:\.\d+)?)\s*(s|sec|second|m|min|minute|h|hr|hour|d|day|w|week)/i.exec(String(a.expires ?? a.max_age ?? ""));
  if (m) return Math.min(604800, Math.round(Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2].toLowerCase()[0]] ?? 0)));
  return 0;
};
const expiryText = s => !s ? "never expires" : s >= 86400 ? `${Math.round(s / 86400 * 10) / 10} day(s)` : s >= 3600 ? `${Math.round(s / 3600 * 10) / 10} hour(s)` : `${Math.round(s / 60)} minute(s)`;

/** Overwrites for a private or read-only channel, from roles. */
export function accessOverwrites(guild, { mode, roles }) {
  const everyone = guild.roles.everyone, me = guild.members.me, out = [];
  if (mode === "private") out.push({ id: everyone.id, type: OverwriteType.Role, deny: [P.ViewChannel] });
  if (mode === "read_only") out.push({ id: everyone.id, type: OverwriteType.Role, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads] });
  for (const r of roles) out.push({ id: r.id, type: OverwriteType.Role, allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, ...(mode === "read_only" ? [] : [P.AttachFiles, P.EmbedLinks, P.AddReactions])] });
  if (me) out.push({ id: me.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.ManageChannels, P.ReadMessageHistory] });
  return out;
}
export const effective = (channel, role) => { const p = channel.permissionsFor(role); return { view: !!p?.has(P.ViewChannel), send: !!p?.has(P.SendMessages) }; };
const hex = n => `#${n.toString(16).padStart(6, "0")}`;
const isTrue = v => /^(true|yes|on|1)$/i.test(String(v ?? ""));

export const TOOLS = {
  /* ───────────── invites ───────────── */
  invite_create: {
    cap: "invites", risk: "low", user: [P.CreateInstantInvite], bot: [P.CreateInstantInvite],
    async run({ guild, channel, args, reason, me }) {
      const usable = c => c && !c.isThread?.() && c.type !== ChannelType.GuildCategory && c.permissionsFor(me)?.has(P.CreateInstantInvite);
      const named = args.channel ? findChannel(guild, args.channel) : null;
      const target = [named, channel, guild.rulesChannel, guild.systemChannel, guild.channels.cache.find(c => c.type === ChannelType.GuildText && usable(c))].find(usable);
      if (!target) throw friendly("no channel to invite to", "I can't create invites in any channel I can see. Give my role Create Invite on a channel (for example your rules or general channel) and ask again.");
      const maxAge = seconds(args), maxUses = Math.max(0, Math.min(100, parseInt(args.max_uses, 10) || 0)), temporary = isTrue(args.temporary);
      const invite = await guild.invites.create(target, { maxAge, maxUses, temporary, unique: true, reason });
      const back = await guild.invites.fetch({ code: invite.code, cache: false }).catch(() => null); // read it back: it exists
      const real = back ?? invite;
      return panel({ title: "Server invitation", accent: "up", lines: [`**${real.url}**`, `Channel: <#${target.id}>`, `Expires: ${real.expiresTimestamp ? stamp(real.expiresTimestamp) : expiryText(maxAge)}`, `Uses: ${maxUses ? `up to ${maxUses}` : "unlimited"}${temporary ? " · temporary membership" : ""}`], footer: back ? "Created and verified with Discord" : "Created (could not read it back to verify)" });
    },
  },
  invite_list: {
    cap: "invites", risk: "read", user: [P.ManageGuild], bot: [P.ManageGuild],
    async run({ guild }) {
      const all = [...(await guild.invites.fetch()).values()].sort((a, b) => b.uses - a.uses);
      if (!all.length) return panel({ title: "Invitations", lines: ["There are no active invitations."], accent: "flat" });
      return panel({ title: `Active invitations (${all.length})`, lines: all.slice(0, 15).map(i => `\`${i.code}\` · <#${i.channelId}> · ${i.uses}${i.maxUses ? `/${i.maxUses}` : ""} uses · ${i.expiresTimestamp ? "expires " + stamp(i.expiresTimestamp) : "never expires"}${i.inviterId ? ` · by ${tag(i.inviterId)}` : ""}`).concat(all.length > 15 ? [`-# and ${all.length - 15} more`] : []) });
    },
  },
  invite_revoke: {
    cap: "invites", risk: "read", user: [P.ManageGuild], bot: [P.ManageGuild],
    async run({ guild, args, reason }) {
      const code = String(args.code ?? args.text ?? "").replace(/^.*discord\.(?:gg|com\/invite)\//i, "").trim();
      if (!code) throw friendly("no code", "Which invitation? Give me its code or link (or ask me to list them first).");
      await guild.invites.delete(code, reason);
      const still = await guild.invites.fetch({ code, cache: false }).catch(() => null);
      if (still) throw new Error("it is still active");
      return plain(`🗑️ Invitation \`${code}\` is revoked and no longer works.`);
    },
  },

  /* ───────────── the server ───────────── */
  server_overview: {
    // "members" and "member_count" are NOT aliases of this: a member list and a member count are different requests (see brain/tools.js).
    cap: "info", risk: "read", bot: [], aliases: ["server_info", "server_summary", "server_settings", "server_stats"],
    async run({ guild, client }) {
      const g = await client.guilds.fetch({ guild: guild.id, withCounts: true }).catch(() => guild);
      const total = g.approximateMemberCount ?? guild.memberCount, online = g.approximatePresenceCount;
      const ch = guild.channels.cache, count = t => ch.filter(c => (Array.isArray(t) ? t : [t]).includes(c.type)).size;
      const owner = await guild.fetchOwner().catch(() => null);
      return panel({ title: guild.name, accent: "accent", lines: [
        guild.description ? `*${guild.description}*` : "",
        `👥 **${total}** members${online != null ? ` · ${online} online` : ""}`,
        `💬 ${count([ChannelType.GuildText, ChannelType.GuildAnnouncement])} text · 🔊 ${count([ChannelType.GuildVoice, ChannelType.GuildStageVoice])} voice · 🗂️ ${count(ChannelType.GuildCategory)} categories · 🧵 ${count(ChannelType.GuildForum)} forums`,
        `🎖️ ${guild.roles.cache.size - 1} roles · 😀 ${guild.emojis.cache.size} emoji`,
        `🚀 Boost level ${guild.premiumTier} · ${guild.premiumSubscriptionCount ?? 0} boosts`,
        owner ? `👑 Owner: ${tag(owner.id)}` : "",
        `🛡️ Verification: ${["none", "low", "medium", "high", "very high"][guild.verificationLevel] ?? guild.verificationLevel} · explicit-content filter ${["off", "no-role members", "everyone"][guild.explicitContentFilter] ?? guild.explicitContentFilter} · 2FA for moderators ${guild.mfaLevel ? "required" : "not required"}`,
        guild.features?.length ? `✨ Features: ${guild.features.slice(0, 12).map(f => f.toLowerCase().replace(/_/g, " ")).join(", ")}` : "",
        `-# ID ${guild.id} · created ${stamp(guild.createdTimestamp, "D")}`,
      ] });
    },
  },
  channel_list: {
    cap: "info", risk: "read", bot: [],
    async run({ guild }) {
      const cats = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).sort((a, b) => a.position - b.position);
      const children = id => guild.channels.cache.filter(c => c.parentId === id && !c.isThread?.() && c.type !== ChannelType.GuildCategory).sort((a, b) => a.position - b.position);
      const icon = c => ({ [ChannelType.GuildVoice]: "🔊", [ChannelType.GuildStageVoice]: "🎙️", [ChannelType.GuildForum]: "🧵", [ChannelType.GuildAnnouncement]: "📣" }[c.type] ?? "#");
      const lines = [];
      for (const c of children(null).values()) lines.push(`${icon(c)} ${c}`);
      for (const cat of cats.values()) { lines.push(`**${cat.name}**`); for (const c of children(cat.id).values()) lines.push(`  ${icon(c)} ${c}`); }
      return panel({ title: `Channels (${guild.channels.cache.filter(c => !c.isThread?.()).size})`, lines });
    },
  },
  channel_info: {
    cap: "info", risk: "read", bot: [], aliases: ["channel_permissions"],
    async run({ guild, channel }) {
      const ow = [...(channel.permissionOverwrites?.cache.values() ?? [])].map(o => { const who = o.type === OverwriteType.Role ? (o.id === guild.id ? "@everyone" : guild.roles.cache.get(o.id)?.name ?? o.id) : tag(o.id); const a = permNames(o.allow), d = permNames(o.deny); return `• ${who}: ${a.length ? "✅ " + a.slice(0, 6).join(", ") : ""}${d.length ? " 🚫 " + d.slice(0, 6).join(", ") : ""}`; });
      const e = effective(channel, guild.roles.everyone);
      return panel({ title: `#${channel.name}`, lines: [`Type: ${kindName(channel.type)}${channel.parent ? ` · in **${channel.parent.name}**` : ""}`, channel.topic ? `Topic: ${channel.topic}` : "", channel.rateLimitPerUser ? `Slowmode: ${channel.rateLimitPerUser}s` : "", `@everyone can ${e.view ? "see it" : "not see it"}${e.view ? " and " + (e.send ? "write in it" : "not write in it") : ""}`, ow.length ? `**Permission overwrites**\n${ow.slice(0, 14).join("\n")}` : "No permission overwrites (inherits the category)", `-# ID ${channel.id}`] });
    },
  },
  channel_create: {
    cap: "channels", risk: "low", user: [P.ManageChannels], bot: [P.ManageChannels], aliases: ["create_channel", "category_create", "create_category"],
    async run({ guild, args, reason, action, result }) {
      const wantCat = action.includes("categor") || /categor/i.test(String(args.kind ?? args.type ?? ""));
      const type = wantCat ? ChannelType.GuildCategory : KINDS[String(args.kind ?? args.type ?? "text").toLowerCase()] ?? ChannelType.GuildText;
      const name = String(args.name ?? "").trim();
      if (!name) throw friendly("no name", "What should it be called?");
      const parent = args.category && type !== ChannelType.GuildCategory ? findChannel(guild, args.category, [ChannelType.GuildCategory]) : null;
      if (args.category && !parent) throw friendly("category not found", `I couldn't find a category called "${args.category}". Name an existing one, or ask me to create it first.`);
      const asked = csv(args.role ?? args.roles), roles = asked.map(q => findRole(guild, q)).filter(Boolean), missingRole = asked.filter(q => !findRole(guild, q));
      if (missingRole.length) throw friendly("role not found", `I couldn't find the role ${missingRole.map(r => `"${r}"`).join(", ")}. Create it first, or name an existing role.`);
      const mode = isTrue(args.private) || /private|staff/i.test(String(args.access ?? "")) ? "private" : /read[- ]?only/i.test(String(args.access ?? "")) || isTrue(args.read_only) ? "read_only" : null;
      const made = await guild.channels.create({ name: name.slice(0, 100), type, parent: parent?.id, topic: args.topic && type !== ChannelType.GuildCategory ? String(args.topic).slice(0, 1024) : undefined, permissionOverwrites: mode ? accessOverwrites(guild, { mode, roles }) : undefined, reason });
      const back = await guild.channels.fetch(made.id, { force: true }).catch(() => null);
      if (!back) throw new Error("Discord did not return the new channel");
      const e = mode ? effective(back, guild.roles.everyone) : null;
      if (mode === "private" && e.view) throw new Error("created, but @everyone can still see it (check the category's permissions)");
      Object.assign(result, { kind: kindName(type), id: back.id, name: back.name, parentId: parent?.id ?? null, parentName: parent?.name ?? null, private: mode === "private", roles: roles.map(r => r.name) });
      return panel({ title: `Created ${kindName(type)}`, accent: "up", lines: [`${type === ChannelType.GuildCategory ? "**" + back.name + "**" : back}${parent ? ` in **${parent.name}**` : ""}`, mode === "private" ? `🔒 Private: ${roles.length ? `only ${roles.map(r => `**${r.name}**`).join(", ")} (and administrators)` : "only administrators and I"} can see it. Verified: @everyone cannot.` : mode === "read_only" ? "📖 Read-only for everyone" + (roles.length ? ` except ${roles.map(r => `**${r.name}**`).join(", ")}` : "") + ". Verified." : "Open to anyone who can see its category."] });
    },
  },
  channel_access: {
    cap: "permissions", risk: "low", user: [P.ManageChannels, P.ManageRoles], bot: [P.ManageChannels, P.ManageRoles], aliases: ["restrict", "make_private", "make_public", "read_only_for"],
    async run({ guild, channel, args, reason, action }) {
      const mode = action === "make_public" || /public|everyone/i.test(String(args.access ?? "")) ? "public" : /read/i.test(String(args.access ?? "")) || action === "read_only_for" ? "read_only" : "private";
      const asked = csv(args.role ?? args.roles ?? args.target), roles = asked.map(q => findRole(guild, q)), unknown = asked.filter((q, i) => !roles[i]);
      if (unknown.length) throw friendly("role not found", `I couldn't find the role ${unknown.map(r => `"${r}"`).join(", ")}.`);
      if (mode === "private" && !roles.length) throw friendly("needs roles", "Which role(s) should keep access? Name them and I'll hide the channel from everyone else.");
      if (mode === "public") await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: null, SendMessages: null }, { reason });
      else for (const o of accessOverwrites(guild, { mode, roles })) await channel.permissionOverwrites.edit(o.id, Object.fromEntries([...(o.allow ?? []).map(f => [nameOfPerm(f), true]), ...(o.deny ?? []).map(f => [nameOfPerm(f), false])]), { reason });
      const e = effective(await guild.channels.fetch(channel.id, { force: true }), guild.roles.everyone);
      if (mode === "private" && e.view) throw new Error("the change did not hide the channel from @everyone (a role with Administrator or a category overwrite is overriding it)");
      return panel({ title: "Access updated", accent: "up", lines: [`${channel}`, mode === "private" ? `🔒 Only ${roles.map(r => `**${r.name}**`).join(", ")} can see it.` : mode === "read_only" ? `📖 Everyone can read; ${roles.length ? roles.map(r => `**${r.name}**`).join(", ") : "nobody"} can write.` : "🔓 Back to the default for everyone.", `Verified: @everyone can ${e.view ? "see" : "not see"} it${e.view ? " and " + (e.send ? "write" : "not write") : ""}.`] });
    },
  },
  channel_reorder: {
    cap: "channels", risk: "low", user: [P.ManageChannels], bot: [P.ManageChannels],
    async run({ channel, args, reason }) {
      const pos = Math.max(0, parseInt(args.position, 10) || 0);
      await channel.setPosition(pos, { reason });
      return plain(`↕️ ${channel} moved to position ${pos}.`);
    },
  },

  /* ───────────── roles ───────────── */
  role_list: {
    cap: "info", risk: "read", bot: [],
    async run({ guild }) {
      const roles = [...guild.roles.cache.values()].filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position);
      return panel({ title: `Roles (${roles.length})`, lines: roles.slice(0, 40).map(r => `**${r.name}**${r.color ? ` · ${hex(r.color)}` : ""}${r.managed ? " · bot" : ""}${r.permissions.has(P.Administrator) ? " · ⚠️ Administrator" : ""}`).concat(roles.length > 40 ? [`-# and ${roles.length - 40} more`] : []) });
    },
  },
  role_info: {
    cap: "info", risk: "read", bot: [],
    async run({ guild, args }) {
      const role = findRole(guild, args.role ?? args.name); if (!role) throw friendly("no role", `I couldn't find a role called "${args.role ?? args.name ?? ""}".`);
      const dangerous = permNames(role.permissions).filter(n => DANGEROUS.includes(n));
      return panel({ title: role.name, lines: [`Colour ${hex(role.color)} · position ${role.position} · ${role.hoist ? "shown separately" : "not shown separately"} · ${role.mentionable ? "mentionable" : "not mentionable"}`, `Members I can see: ${role.members.size}${guild.memberCount > guild.members.cache.size ? " (my member list is partial)" : ""}`, dangerous.length ? `⚠️ Powerful permissions: ${dangerous.join(", ")}` : "No powerful permissions", `-# ID ${role.id}`] });
    },
  },
  role_members: {
    cap: "info", risk: "read", bot: [],
    async run({ guild, args }) {
      const role = findRole(guild, args.role ?? args.name); if (!role) throw friendly("no role", `I couldn't find a role called "${args.role ?? args.name ?? ""}".`);
      await guild.members.fetch({ time: 6000 }).catch(() => {});
      const members = [...role.members.values()], partial = guild.memberCount > guild.members.cache.size;
      return panel({ title: `${role.name} (${members.length}${partial ? "+" : ""})`, lines: [...members.slice(0, 40).map(m => `• ${tag(m.id)}`), members.length > 40 ? `-# and ${members.length - 40} more` : "", partial ? "-# Discord only sends me part of the member list unless the Server Members intent is switched on in the Developer Portal, so this may be incomplete." : ""] });
    },
  },
  role_create: {
    cap: "roles", risk: "low", user: [P.ManageRoles], bot: [P.ManageRoles], aliases: ["create_role"],
    async run({ guild, args, reason, message, result }) {
      const name = String(args.role ?? args.name ?? "").trim(); if (!name) throw friendly("no name", "What should the role be called?");
      const same = findRole(guild, name); if (same && clean(same.name) === clean(name)) throw friendly("exists", `There is already a role called **${same.name}**. Ask me to edit it instead.`);
      const color = args.color ? String(args.color).trim().replace(/^#?/, "#") : undefined;
      const perms = permsOf(args.permission ?? args.permissions).map(p => p[0]);
      const d = delegable(message, perms); if (!d.ok) throw friendly("not delegable", `You can't hand out ${d.denied.join(", ")} because you don't hold ${d.denied.length > 1 ? "them" : "it"} yourself.`);
      const role = await guild.roles.create({ name: name.slice(0, 100), color: color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined, permissions: perms.map(n => P[n]), hoist: isTrue(args.hoist), mentionable: isTrue(args.mentionable), reason });
      const back = guild.roles.cache.get(role.id) ?? await guild.roles.fetch(role.id, { force: true });
      Object.assign(result, { kind: "role", id: back.id, name: back.name });
      return panel({ title: "Role created", accent: "up", lines: [`**${back.name}**${color ? ` · ${color}` : ""}`, perms.length ? `Permissions: ${perms.join(", ")}` : "No special permissions", `-# Position ${back.position}. Move it in Server Settings, Roles if it should sit higher.`] });
    },
  },
  role_edit: {
    cap: "roles", risk: "low", user: [P.ManageRoles], bot: [P.ManageRoles], aliases: ["edit_role", "role_color", "role_permissions"],
    async run({ guild, args, reason, message }) {
      const role = findRole(guild, args.role ?? args.name); if (!role) throw friendly("no role", `I couldn't find a role called "${args.role ?? ""}".`);
      if (!botCanEditRole(guild, role)) throw friendly("hierarchy", `**${role.name}** is above (or is) my highest role, so I can't change it. Move my role higher in Server Settings, Roles.`);
      if (!userCanEditRole(message, role)) throw friendly("hierarchy", `You can't change **${role.name}** because it is not below your highest role.`);
      const patch = { reason }, notes = [];
      if (args.color) { const c = String(args.color).trim().replace(/^#?/, "#"); if (/^#[0-9a-f]{6}$/i.test(c)) { patch.color = c; notes.push(`colour ${c}`); } }
      if (args.name && args.role) { patch.name = String(args.name).slice(0, 100); notes.push(`renamed to ${patch.name}`); }
      if (args.hoist != null) { patch.hoist = isTrue(args.hoist); notes.push(patch.hoist ? "shown separately" : "not shown separately"); }
      if (args.mentionable != null) { patch.mentionable = isTrue(args.mentionable); notes.push(patch.mentionable ? "mentionable" : "not mentionable"); }
      const want = permsOf(args.permission ?? args.permissions).map(p => p[0]), on = args.allow == null ? true : !/^(false|no|off|remove|deny)$/i.test(String(args.allow));
      if (want.length) {
        if (on) { const d = delegable(message, want); if (!d.ok) throw friendly("not delegable", `You can't give ${d.denied.join(", ")} because you don't hold ${d.denied.length > 1 ? "them" : "it"} yourself.`); }
        patch.permissions = on ? role.permissions.add(want.map(n => P[n])) : role.permissions.remove(want.map(n => P[n]));
        notes.push(`${on ? "added" : "removed"} ${want.join(", ")}`);
      }
      if (!notes.length) throw friendly("nothing", "What should I change about the role: name, colour, permissions, shown separately or mentionable?");
      const done = await role.edit(patch);
      if (want.length && on !== want.every(n => done.permissions.has(P[n]))) throw new Error("Discord did not apply the permission change");
      return panel({ title: "Role updated", accent: "up", lines: [`**${done.name}**: ${notes.join("; ")}. Verified.`] });
    },
  },
  role_delete: {
    cap: "roles", risk: "high", user: [P.ManageRoles], bot: [P.ManageRoles], aliases: ["delete_role"],
    preview: ({ guild, args }) => { const r = findRole(guild, args.role ?? args.name); return { title: "Delete this role?", lines: [r ? `**${r.name}** (${r.members.size} cached members have it). This cannot be undone.` : `No role called "${args.role ?? ""}".`] }; },
    async run({ guild, args, reason, message }) {
      const role = findRole(guild, args.role ?? args.name); if (!role) throw friendly("no role", `I couldn't find a role called "${args.role ?? ""}".`);
      if (!botCanEditRole(guild, role) || !userCanEditRole(message, role)) throw friendly("hierarchy", `**${role.name}** is not below both your highest role and mine, so it can't be deleted from here.`);
      const name = role.name; await role.delete(reason);
      if (guild.roles.cache.has(role.id)) throw new Error("the role still exists");
      return plain(`🗑️ Deleted the role **${name}**.`);
    },
  },
  role_assign: {
    cap: "members", risk: "low", user: [P.ManageRoles], bot: [P.ManageRoles], aliases: ["role_add", "role_remove", "role_unassign"],
    async run({ guild, args, reason, message, resolveMember, action, result }) {
      const role = findRole(guild, args.role); if (!role) throw friendly("no role", `I couldn't find a role called "${args.role ?? ""}".`);
      const want = clean(args.role); if (clean(role.name) !== want && clean(role.name) !== want.replace(/s$/, "")) throw friendly("not exact", `I found **${role.name}**, which isn't exactly "${args.role}". Say the exact role name so I never hand out the wrong one.`);
      const member = await resolveMember(); if (!member) throw friendly("no member", "Tag the person (or give their ID) so I change the right member.");
      if (!botCanEditRole(guild, role)) throw friendly("hierarchy", `**${role.name}** is above my highest role, so I can't hand it out. Move my role higher in Server Settings, Roles.`);
      if (!userCanEditRole(message, role)) throw friendly("hierarchy", `You can't manage **${role.name}** because it is not below your highest role.`);
      const remove = action === "role_remove" || action === "role_unassign";
      const dangerous = remove ? [] : permNames(role.permissions).filter(n => DANGEROUS.includes(n));
      if (dangerous.length && !delegable(message, dangerous).ok) throw friendly("not delegable", `**${role.name}** carries ${dangerous.join(", ")}, which you don't hold, so you can't hand it out.`);
      await (remove ? member.roles.remove(role, reason) : member.roles.add(role, reason));
      const fresh = await guild.members.fetch({ user: member.id, force: true });
      if (fresh.roles.cache.has(role.id) === remove) throw new Error("Discord did not apply the role change");
      Object.assign(result, { kind: "role_change", roleId: role.id, roleName: role.name, memberId: member.id, removed: remove });
      return plain(remove ? `${tag(member.id)} no longer has **${role.name}**. Verified.` : `🎖️ ${tag(member.id)} now has **${role.name}**. Verified.`);
    },
  },
  role_audit: {
    cap: "info", risk: "read", bot: [],
    async run({ guild }) {
      const roles = [...guild.roles.cache.values()].filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position);
      const admin = roles.filter(r => r.permissions.has(P.Administrator) && !r.managed);
      const risky = roles.filter(r => !r.permissions.has(P.Administrator) && !r.managed && permNames(r.permissions).some(p => ["ManageGuild", "ManageRoles", "ManageChannels", "BanMembers", "KickMembers", "MentionEveryone", "ManageWebhooks"].includes(p)));
      const ev = permNames(guild.roles.everyone.permissions).filter(p => DANGEROUS.includes(p)), partial = guild.memberCount > guild.members.cache.size;
      const unused = partial ? [] : roles.filter(r => !r.managed && r.members.size === 0);
      return panel({ title: "Role audit", accent: admin.length > 2 || ev.length ? "amber" : "accent", lines: [
        `**${roles.length}** roles.`,
        admin.length ? `⚠️ Administrator: ${admin.map(r => `**${r.name}**`).join(", ")}` : "✅ No custom role has Administrator.",
        risky.length ? `Powerful (not admin): ${risky.slice(0, 10).map(r => `**${r.name}**`).join(", ")}` : "",
        ev.length ? `🚨 **@everyone** itself has: ${ev.join(", ")}. Anyone in the server has this.` : "✅ @everyone has no powerful permissions.",
        partial ? "-# I only see part of the member list, so I can't tell which roles are unused." : unused.length ? `Unused roles: ${unused.slice(0, 15).map(r => r.name).join(", ")}` : "No unused roles.",
      ] });
    },
  },

  /* ───────────── permissions and security ───────────── */
  permission_audit: {
    cap: "info", risk: "read", bot: [], aliases: ["security_audit", "audit_permissions", "protection_review"],
    async run({ guild, config }) {
      const everyone = guild.roles.everyone, findings = [];
      const privateName = /staff|admin|mod|private|log|vip|instructor|team|owner|internal|secret/i;
      for (const c of guild.channels.cache.values()) {
        if (c.isThread?.() || c.type === ChannelType.GuildCategory) continue;
        const e = effective(c, everyone);
        if (privateName.test(c.name) && e.view) findings.push({ sev: 3, text: `#${c.name} looks private by its name but **@everyone can see it**${e.send ? " and write in it" : ""}.` });
        const ov = c.permissionOverwrites?.cache.get(everyone.id);
        if (ov?.allow.has(P.MentionEveryone)) findings.push({ sev: 2, text: `#${c.name} lets @everyone ping everyone.` });
        if (ov?.allow.has(P.ManageMessages)) findings.push({ sev: 3, text: `#${c.name} lets @everyone manage messages.` });
        if ((c.type === ChannelType.GuildAnnouncement || /announce|news|rules|welcome/i.test(c.name)) && e.send) findings.push({ sev: 1, text: `#${c.name} (an announcement-style channel) lets everyone write.` });
      }
      const ev = permNames(everyone.permissions).filter(p => DANGEROUS.includes(p));
      if (ev.length) findings.push({ sev: 3, text: `@everyone has ${ev.join(", ")} server-wide.` });
      const admins = [...guild.roles.cache.values()].filter(r => r.permissions.has(P.Administrator) && !r.managed && r.id !== guild.id);
      if (admins.length > 2) findings.push({ sev: 2, text: `${admins.length} roles have Administrator (${admins.map(r => r.name).join(", ")}). Fewer is safer.` });
      if (guild.verificationLevel < 2) findings.push({ sev: 2, text: `Verification level is "${["none", "low"][guild.verificationLevel]}": new accounts can post immediately. Medium or higher slows raids.` });
      if (!guild.mfaLevel) findings.push({ sev: 1, text: "2FA is not required for moderators (Server Settings, Safety Setup)." });
      if (guild.explicitContentFilter === 0) findings.push({ sev: 1, text: "Discord's explicit-image filter is off." });
      const native = await guild.autoModerationRules?.fetch().then(r => r.size).catch(() => null), mine = config.ai?.automod?.on;
      if (!mine && !native) findings.push({ sev: 2, text: "No automatic moderation is active: neither Discord's AutoMod rules nor mine." });
      findings.sort((a, b) => b.sev - a.sev);
      const worst = findings[0]?.sev ?? 0;
      return panel({ title: "Security and permission audit", accent: worst >= 3 ? "down" : worst ? "amber" : "up", lines: [
        findings.length ? findings.slice(0, 14).map(f => `${f.sev >= 3 ? "🔴" : f.sev === 2 ? "🟠" : "🟡"} ${f.text}`).join("\n") : "✅ No problems found in channel permissions, roles or safety settings.",
        `-# Checked ${guild.channels.cache.filter(c => !c.isThread?.()).size} channels, ${guild.roles.cache.size - 1} roles. Discord AutoMod rules: ${native ?? "unknown"}. My own automod: ${mine ? "on" : "off"}.`,
      ] });
    },
  },

  /* ───────────── members and moderation ───────────── */
  member_search: {
    cap: "members", risk: "read", bot: [],
    async run({ guild, args }) {
      const q = String(args.user ?? args.name ?? args.text ?? "").replace(/^@/, "").trim(); if (!q) throw friendly("no query", "Who should I look for? Give me part of their name.");
      const found = [...(await guild.members.search({ query: q.slice(0, 32), limit: 10 })).values()];
      if (!found.length) return plain(`No member matches "${q}".`);
      return panel({ title: `Members matching "${q}"`, lines: found.map(m => `• ${tag(m.id)} · ${m.displayName} · joined ${stamp(m.joinedTimestamp, "D")} · \`${m.id}\``).concat(found.length > 1 ? ["-# Several matches: use the tag or ID for anything that changes a member, so I never pick the wrong person."] : []) });
    },
  },
  joined_recently: {
    cap: "members", risk: "read", bot: [],
    async run({ guild, args }) {
      const days = Math.max(1, Math.min(30, parseInt(args.days, 10) || 1));
      const all = await guild.members.fetch({ time: 8000 }).catch(() => null);
      if (!all) return panel({ title: "Recent joins", accent: "amber", lines: ["Discord won't give me the member list without the **Server Members intent**. Switch it on for the bot in the Developer Portal (Bot, Privileged Gateway Intents) and I can list who joined, detect raids and welcome people."] });
      const since = Date.now() - days * 86_400_000, list = [...all.values()].filter(m => m.joinedTimestamp >= since).sort((a, b) => b.joinedTimestamp - a.joinedTimestamp);
      return panel({ title: `Joined in the last ${days === 1 ? "24 hours" : days + " days"} (${list.length})`, lines: list.slice(0, 30).map(m => `• ${tag(m.id)} · ${stamp(m.joinedTimestamp)} · account ${stamp(m.user.createdTimestamp)}`) });
    },
  },
  warn: {
    cap: "moderation", risk: "low", user: [P.ModerateMembers], bot: [],
    async run({ guild, args, message, resolveMember }) {
      const member = await resolveMember(); if (!member) throw friendly("no member", "Tag the person (or give their ID) so I warn the right member.");
      if (member.id === message.author?.id) throw friendly("self", "You can't warn yourself.");
      if (!userCanEditMember(message, member)) throw friendly("hierarchy", "You can't moderate someone with a role equal to or above yours.");
      const reason = String(args.reason ?? args.text ?? "").trim() || "No reason given";
      const w = addWarning({ guild: guild.id, user: member.id, by: message.author?.id, reason });
      const count = warningsOf(guild.id, member.id).length;
      member.user.send({ content: `⚠️ You were warned in **${guild.name}**: ${reason}`, allowedMentions: { parse: [] } }).catch(() => {});
      return panel({ title: "Warning recorded", accent: "amber", pings: [member.id], lines: [`${tag(member.id)} · ${reason}`, `This is warning **${count}** for them (ID ${w.id}).`, count >= 3 ? "⚠️ They now have three or more warnings. A timeout or removal is your decision: I won't punish on my own." : ""] });
    },
  },
  mod_history: {
    cap: "moderation", risk: "read", user: [P.ModerateMembers], bot: [], aliases: ["warnings", "moderation_history"],
    async run({ guild, args, resolveMember }) {
      const member = args.user ? await resolveMember() : null;
      if (args.user && !member) throw friendly("no member", "Tag the person (or give their ID) so I look up the right member.");
      const warns = member ? warningsOf(guild.id, member.id) : allWarnings(guild.id).slice(-15);
      const acts = recentAudit(12, a => a.guild === guild.id && /^(warn|kick|ban|tempban|unban|timeout|untimeout|purge)/.test(a.action) && (!member || a.targetId === member.id));
      const lines = [...warns.slice(-10).reverse().map(w => `⚠️ ${stamp(Date.parse(w.at))} ${member ? "" : tag(w.user) + " "}${w.reason}${w.by ? ` · by ${tag(w.by)}` : ""}`), ...acts.map(a => `${a.ok ? "•" : "✖"} ${stamp(Date.parse(a.at))} **${a.action}**${a.targetId && !member ? " " + tag(a.targetId) : ""}${a.ok ? "" : " (failed)"}`)];
      return panel({ title: member ? `Moderation history: ${member.displayName}` : "Latest moderation activity", lines: lines.length ? lines : ["Nothing recorded yet."], footer: "From my own records: actions taken in Discord by others are not included" });
    },
  },
  tempban: {
    cap: "moderation", risk: "high", user: [P.BanMembers], bot: [P.BanMembers],
    preview: ({ args }) => ({ title: "Ban temporarily?", lines: [`${args.user ? args.user : "This member"} will be banned and automatically unbanned later (${args.delay_hours ? args.delay_hours + " h" : args.delay_minutes ? args.delay_minutes + " min" : args.days ? args.days + " days" : "as asked"}).`] }),
    async run({ guild, args, message, reason, resolveMember }) {
      const member = await resolveMember(); if (!member) throw friendly("no member", "Tag the person so I ban the right member.");
      if (!userCanEditMember(message, member) || !botCanEditMember(guild, member)) throw friendly("hierarchy", "Their top role is not below both yours and mine, so I can't ban them.");
      const ms = (Number(args.delay_hours) * 3600 + Number(args.delay_minutes) * 60 + Number(args.delay_seconds) + Number(args.days) * 86400) * 1000 || 0;
      const runAt = ms ? Date.now() + ms : whenOf(args);
      if (!runAt) throw friendly("no duration", "For how long? (for example 24 hours or 3 days)");
      await guild.members.ban(member.id, { reason });
      addJob({ kind: "mod", args: { action: "unban", user: member.id, reason: "temporary ban ended" }, runAt, repeat: null, channelId: message.channelId, guildId: guild.id, ownerId: message.author?.id });
      return plain(`🔨 ${tag(member.id)} is banned until ${stamp(runAt, "f")} and will be unbanned automatically.`);
    },
  },
  mod_log: {
    cap: "info", risk: "read", bot: [], aliases: ["audit_log", "recent_actions"],
    async run({ guild, args }) {
      const rows = recentAudit(Math.min(25, parseInt(args.count, 10) || 12), a => a.guild === guild.id);
      return panel({ title: "What I have done recently", lines: rows.length ? rows.map(a => `${a.ok ? "✅" : "❌"} ${stamp(Date.parse(a.at))} **${a.action}**${a.targetId ? " → " + tag(a.targetId) : a.target ? " → " + a.target : ""}${a.ok ? "" : ` · ${String(a.error ?? "failed").slice(0, 80)}`}${a.confirmed === false ? " · cancelled" : ""}`) : ["Nothing recorded yet."] });
    },
  },

  /* ───────────── events, threads, messages ───────────── */
  event_create: {
    cap: "events", risk: "low", user: [P.ManageEvents], bot: [P.ManageEvents], aliases: ["create_event"],
    async run({ guild, args, reason, result }) {
      const name = String(args.name ?? args.text ?? "").trim(); if (!name) throw friendly("no name", "What is the event called?");
      const start = whenOf(args); if (!start) throw friendly("no time", "When does it start? Give a day and time in New York time (for example 2026-11-21 18:00).");
      if (start < Date.now() + 60_000) throw friendly("past", "That time has already passed (New York time). Give me a future date and time.");
      const hours = Math.max(0.25, Math.min(24, Number(args.hours) || 1)), voice = args.channel ? findChannel(guild, args.channel, [ChannelType.GuildVoice, ChannelType.GuildStageVoice]) : null;
      const ev = await guild.scheduledEvents.create({ name: name.slice(0, 100), description: args.description ? String(args.description).slice(0, 1000) : undefined, scheduledStartTime: new Date(start), scheduledEndTime: voice ? undefined : new Date(start + hours * 3_600_000), privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly, entityType: voice ? (voice.type === ChannelType.GuildStageVoice ? GuildScheduledEventEntityType.StageInstance : GuildScheduledEventEntityType.Voice) : GuildScheduledEventEntityType.External, channel: voice ?? undefined, entityMetadata: voice ? undefined : { location: String(args.location ?? "Online").slice(0, 100) }, reason });
      Object.assign(result, { kind: "event", id: ev.id, name: ev.name, start });
      return panel({ title: "Event created", accent: "up", lines: [`**${ev.name}**`, `Starts ${stamp(start, "F")} (${stamp(start)})`, voice ? `In ${voice}` : `Location: ${args.location ?? "Online"}`, ev.url], footer: "Verified with Discord" });
    },
  },
  event_list: {
    cap: "events", risk: "read", bot: [], aliases: ["events", "upcoming_events"],
    async run({ guild }) {
      const list = [...(await guild.scheduledEvents.fetch()).values()].sort((a, b) => a.scheduledStartTimestamp - b.scheduledStartTimestamp);
      return panel({ title: `Upcoming events (${list.length})`, accent: list.length ? "accent" : "flat", lines: list.length ? list.slice(0, 15).map(e => `• **${e.name}** · ${stamp(e.scheduledStartTimestamp, "F")} (${stamp(e.scheduledStartTimestamp)}) · ${e.userCount ?? 0} interested`) : ["There are no scheduled events."] });
    },
  },
  event_cancel: {
    cap: "events", risk: "low", user: [P.ManageEvents], bot: [P.ManageEvents], aliases: ["cancel_event", "delete_event"],
    async run({ guild, args, reason }) {
      const q = clean(args.name ?? args.text), list = [...(await guild.scheduledEvents.fetch()).values()];
      const ev = list.find(e => clean(e.name) === q) ?? list.find(e => q && clean(e.name).includes(q));
      if (!ev) throw friendly("no event", `I couldn't find an event called "${args.name ?? ""}". Ask me to list the upcoming events.`);
      await guild.scheduledEvents.delete(ev.id, reason);
      return plain(`🗓️ Cancelled **${ev.name}**.`);
    },
  },
  thread_create: {
    cap: "threads", risk: "low", user: [P.CreatePublicThreads], bot: [P.CreatePublicThreads],
    async run({ channel, args, reason }) {
      const name = String(args.name ?? args.text ?? "").trim(); if (!name) throw friendly("no name", "What should the thread be called?");
      const t = await channel.threads.create({ name: name.slice(0, 100), autoArchiveDuration: 1440, reason });
      return plain(`🧵 Created ${t}.`);
    },
  },
  thread_manage: {
    cap: "threads", risk: "low", user: [P.ManageThreads], bot: [P.ManageThreads], aliases: ["thread_rename", "thread_unarchive", "thread_unlock", "thread_list"],
    async run({ channel, guild, args, reason, action }) {
      if (action === "thread_list") { const act = [...(await guild.channels.fetchActiveThreads()).threads.values()]; return panel({ title: `Active threads (${act.length})`, lines: act.length ? act.slice(0, 25).map(t => `• ${t} in <#${t.parentId}> · ${t.memberCount ?? "?"} members`) : ["No active threads."] }); }
      if (!channel.isThread?.()) throw friendly("not a thread", "Run that inside the thread you mean.");
      if (action === "thread_rename") { await channel.setName(String(args.name ?? "").slice(0, 100), reason); return plain(`✏️ Thread renamed to ${channel}.`); }
      if (action === "thread_unarchive") { await channel.setArchived(false, reason); return plain("🧵 Thread reopened."); }
      await channel.setLocked(false, reason); return plain("🔓 Thread unlocked.");
    },
  },
  message_edit: {
    cap: "messages", risk: "low", bot: [P.SendMessages],
    async run({ channel, message, args }) {
      const text = String(args.text ?? "").trim(); if (!text) throw friendly("no text", "What should the new text say?");
      const target = message.reference?.messageId ? await channel.messages.fetch(message.reference.messageId).catch(() => null) : [...(await channel.messages.fetch({ limit: 25, before: message.id })).values()].find(m => m.author.id === message.client.user.id);
      if (!target || target.author.id !== message.client.user.id) throw friendly("not mine", "I can only edit my own messages. Reply to the one you mean, or I'll use my latest in this channel.");
      if (target.flags?.has?.(32768)) { const p = panel({ lines: [text.slice(0, 3900)] }); await target.edit({ components: p.components, flags: p.flags }); } else await target.edit({ content: text.slice(0, 1990), allowedMentions: { parse: [] } });
      return plain("✏️ Edited. Its other content and buttons are unchanged.");
    },
  },
  summarize_channel: {
    cap: "messages", risk: "read", bot: [P.ReadMessageHistory], aliases: ["summarise", "summarize"],
    async run({ channel, message, args, summarize }) {
      const n = Math.max(10, Math.min(100, parseInt(args.count, 10) || 60));
      const batch = [...(await channel.messages.fetch({ limit: n, before: message.id })).values()].reverse().filter(m => !m.author.bot && m.content);
      if (batch.length < 3) return plain("There isn't enough recent discussion here to summarise.");
      const transcript = batch.map(m => `${m.member?.displayName ?? m.author.username}: ${m.content.replace(/\s+/g, " ").slice(0, 300)}`).join("\n").slice(0, 9000);
      const out = await summarize?.(transcript);
      if (!out) throw friendly("no model", "I couldn't reach my language model to summarise just now. Try again in a minute.");
      return panel({ title: `Summary of the last ${batch.length} messages in #${channel.name}`, lines: [out.slice(0, 3500)] });
    },
  },
  announce_rich: {
    cap: "messages", risk: "low", bot: [P.SendMessages], aliases: ["announce"],
    async run({ args }) {
      const body = String(args.text ?? "").trim(); if (!body) throw friendly("no text", "What should the announcement say?");
      const targets = (args.channels ?? []).filter(c => c?.isSendable?.());
      if (!targets.length) throw friendly("no channel", "I couldn't find a channel I can post in.");
      const all = /(^|[\s>*_~(])@(everyone|here)\b/i.test(body);
      const post = panel({ title: args.title ? String(args.title).slice(0, 200) : undefined, lines: [body.slice(0, 3600)], pings: [...body.matchAll(/<@!?(\d{15,})>/g)].map(m => m[1]) });
      if (all) post.allowedMentions = { parse: ["everyone"], users: post.allowedMentions.users };
      const sent = [];
      for (const c of targets) { const m = await c.send(post); if (m?.id) sent.push(c); }
      if (!sent.length) throw new Error("Discord did not confirm delivery");
      return plain(`📣 Announcement posted in ${sent.join(" ")}.`);
    },
  },
  message_delete: {
    cap: "messages", risk: "low", silent: true, bot: [P.ManageMessages], aliases: ["delete_message", "delete_this_message"],
    // Messages are only ever deleted on a plain request like this one: "delete this message" (a reply to it), "delete my last message".
    async run({ channel, message, args }) {
      let target = null;
      if (message.reference?.messageId) target = await channel.messages.fetch(message.reference.messageId).catch(() => null);
      else if (/last|previous|latest/i.test(String(args.which ?? ""))) target = [...(await channel.messages.fetch({ limit: 15, before: message.id })).values()].find(m => m.author.id === message.author.id) ?? null;
      if (!target) throw friendly("no target", "Reply to the message you want deleted and say \"delete this message\" (or say \"delete my last message\").");
      const mine = target.author.id === message.client.user.id, theirs = target.author.id === message.author.id;
      if (!mine && !theirs && !userCan(message, P.ManageMessages)) throw friendly("not allowed", "You can't delete other people's messages here (it needs Manage Messages).");
      await target.delete();
      const still = await channel.messages.fetch(target.id).catch(() => null);
      if (still) throw new Error("the message is still there");
      return null; // nothing more is posted: the message simply goes
    },
  },  role_panel: {
    cap: "community", risk: "low", user: [P.ManageRoles], bot: [P.ManageRoles, P.SendMessages],
    async run({ guild, channel, args }) {
      const asked = csv(args.role ?? args.roles), roles = asked.map(q => findRole(guild, q)), bad = asked.filter((q, i) => !roles[i]);
      if (!asked.length) throw friendly("no roles", "Which roles should members be able to pick? Name them (up to five).");
      if (bad.length) throw friendly("role not found", `I couldn't find ${bad.map(r => `"${r}"`).join(", ")}.`);
      const unsafe = roles.find(r => permNames(r.permissions).some(p => DANGEROUS.includes(p)) || !botCanEditRole(guild, r));
      if (unsafe) throw friendly("unsafe role", `**${unsafe.name}** has powerful permissions or sits above my role, so it can't be self-assigned.`);
      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");
      const row = new ActionRowBuilder().addComponents(...roles.slice(0, 5).map(r => new ButtonBuilder().setCustomId(`rolebtn:${r.id}`).setLabel(r.name.slice(0, 80)).setStyle(ButtonStyle.Secondary)));
      const sent = await channel.send(panel({ title: args.title ? String(args.title).slice(0, 200) : "Pick your roles", lines: [args.text ? String(args.text).slice(0, 1500) : "Press a button to add the role, and press it again to remove it."], rows: [row] }));
      if (!sent?.id) throw new Error("Discord did not confirm delivery");
      return plain(`🎖️ Role panel posted in ${channel}.`);
    },
  },
};
for (const [name, spec] of Object.entries(TOOLS)) for (const alias of spec.aliases ?? []) TOOLS[alias] ??= spec;
export const toolNames = () => Object.keys(TOOLS);
export const CAPABILITIES = ["invites", "info", "channels", "permissions", "roles", "members", "moderation", "events", "threads", "messages", "community", "workflows"];

const FAIL = e => e?.friendly ?? (/Missing (Permissions|Access)|50013|50001/.test(String(e?.message)) ? "Discord refused it: I'm missing a permission for that here. Give my role the permission it needs (or move my role higher) and ask again." : /Unknown (Channel|Role|Member|Message|Invite)|10003|10011|10007|10008|10006/.test(String(e?.message)) ? "That no longer exists (it may have been deleted). Check the name and try again." : /rate ?limit|429/i.test(String(e?.message)) ? "Discord is rate-limiting me. Wait a few seconds and ask again; nothing was changed." : `I couldn't complete that, so nothing is confirmed as changed (${String(e?.message ?? e).slice(0, 140)}).`);

/** Runs a registered tool, or returns undefined when the action isn't one of these. The one gate for everything above. */
export async function runTool(message, name, args, config, extras = {}) {
  const spec = TOOLS[name]; if (!spec) return undefined;
  const guild = message.guild, t0 = Date.now(), A = config.ai?.admin ?? {};
  const base = { guild: guild.id, guildName: guild.name, user: message.author?.id, action: name, risk: spec.risk, args: Object.fromEntries(Object.entries(args).filter(([k, v]) => typeof v !== "object" && !/token|key|secret/i.test(k)).map(([k, v]) => [k, String(v).slice(0, 80)])), provider: extras.provider };
  const finish = (extra, post) => {
    audit({ ...base, ms: Date.now() - t0, targetId: extras.targetId, ...extra });
    if (extras.outcome) Object.assign(extras.outcome, { ran: true, ok: !!extra.ok, error: extra.error, permission: extra.permission, confirmed: extra.confirmed }); // the brain reads what really happened from here, not from the wording of the reply
    return post;
  };
  if (A.incident) return finish({ ok: false, permission: "blocked: incident mode", error: "incident mode" }, plain("🛑 Administrator actions are switched off (incident mode). Say \"resume administrator actions\" when it's safe."));
  if ((A.disabled ?? []).includes(spec.cap)) return finish({ ok: false, permission: "blocked: capability off", error: "capability disabled" }, plain(`The **${spec.cap}** tools are switched off. Say "enable ${spec.cap} tools" to turn them back on.`));
  const channel = extras.channel ?? message.channel, me = guild.members.me;
  const um = spec.user ? userMissing(message, spec.user) : [];
  if (um.length) return finish({ ok: false, permission: `denied: user lacks ${um.join(", ")}`, error: "user lacks permission" }, plain(`You don't have the Discord permission for that (${um.map(n => n.replace(/([A-Z])/g, " $1").trim().toLowerCase()).join(", ")}), so I can't do it for you.`));
  const bm = spec.bot?.length ? botMissing(guild, spec.bot, ["channels", "permissions", "messages"].includes(spec.cap) ? channel : undefined) : [];
  if (bm.length) return finish({ ok: false, permission: `denied: bot lacks ${bm.join(", ")}`, error: "bot lacks permission" }, plain(`I can't do that: ${sayMissing(bm)}`));
  const ctx = { message, guild, channel, args, config, me, client: message.client, action: name, reason: String(args.reason || `Asked by ${message.author?.tag ?? "the owner"} via YSER Lab`).slice(0, 400), resolveMember: extras.resolveMember ?? (async () => null), summarize: extras.summarize, result: extras.result ?? {}, convoKey: extras.convoKey };
  const note = { permission: "ok", target: extras.targetLabel };
  try {
    const trusted = (A.trusted ?? []).includes(name);
    if (spec.risk === "high" && !trusted) {
      const p = spec.preview?.(ctx) ?? { title: `Run ${name}?`, lines: [] };
      if (!(await confirmButtons(message, { ...p, ttl: (A.confirmSeconds ?? 30) * 1000 }))) return finish({ ...note, ok: false, confirmed: false, error: "cancelled" }, plain("Cancelled. Nothing was changed."));
      note.confirmed = true;
    }
    const post = await spec.run(ctx);
    return finish({ ...note, ok: true }, post ?? (spec.silent ? null : plain("Done.")));
  } catch (e) {
    console.warn(`admin ${name}:`, e?.message ?? e);
    return finish({ ...note, ok: false, error: String(e?.message ?? e).slice(0, 300) }, plain(`❌ ${FAIL(e)}`));
  }
}
