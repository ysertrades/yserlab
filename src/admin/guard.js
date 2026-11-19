import { PermissionFlagsBits as P, PermissionsBitField } from "discord.js";

/**
 * Permission checks, done on the backend and never taken from the model's say-so: what the person asking may do in Discord, what the bot
 * may do, and whether the role hierarchy allows it. A failed check names exactly what is missing.
 */
export const DANGEROUS = ["Administrator", "ManageGuild", "ManageRoles", "ManageChannels", "ManageWebhooks", "KickMembers", "BanMembers", "ModerateMembers", "ManageMessages", "MentionEveryone", "ManageNicknames", "ManageEvents", "ManageThreads", "ViewAuditLog"];
export const nameOfPerm = flag => Object.keys(P).find(k => P[k] === flag) ?? String(flag);
const human = n => n.replace(/([A-Z])/g, " $1").trim().toLowerCase();
export const permList = flags => [...new Set((Array.isArray(flags) ? flags : [flags]).filter(Boolean))];
export const permNames = bitfield => new PermissionsBitField(bitfield).toArray();

/** True for the server's owner and anyone with Administrator; otherwise they must hold every permission listed. Scheduled jobs (no member) were checked when they were set up. */
export function userCan(message, flags) {
  const member = message.member;
  if (!member) return true;
  if (message.guild?.ownerId === member.id || member.permissions?.has(P.Administrator)) return true;
  return member.permissions?.has(permList(flags)) ?? false;
}
export const userMissing = (message, flags) => permList(flags).filter(f => !userCan(message, f)).map(nameOfPerm);

/** What the bot lacks, here (in a channel when one is given, which honours that channel's own overwrites). */
export function botMissing(guild, flags, channel) {
  const me = guild.members.me;
  if (!me) return ["(the bot is not in the server)"];
  const perms = channel?.permissionsFor ? channel.permissionsFor(me) : me.permissions;
  if (!perms) return ["(permissions unavailable)"];
  if (perms.has(P.Administrator)) return [];
  return permList(flags).filter(f => !perms.has(f)).map(nameOfPerm);
}
export const sayMissing = (names, who = "my role") => `Missing: ${names.map(human).join(", ")}. Give ${who} ${names.length > 1 ? "those permissions" : "that permission"} in Server Settings, Roles.`;

/** A role the bot can change: below its own highest role, and not @everyone or a managed (bot / booster) role. */
export const botCanEditRole = (guild, role) => !!role && role.id !== guild.id && !role.managed && role.position < guild.members.me.roles.highest.position;
/** The person asking may only touch roles below their own (the owner may touch all). */
export function userCanEditRole(message, role) {
  const m = message.member;
  if (!m || message.guild.ownerId === m.id) return true;
  return role.position < m.roles.highest.position;
}
export function botCanEditMember(guild, member) {
  if (!member) return false;
  if (member.id === guild.ownerId) return false;
  return member.roles.highest.position < guild.members.me.roles.highest.position;
}
export function userCanEditMember(message, member) {
  const m = message.member;
  if (!m || message.guild.ownerId === m.id) return member.id !== message.guild.ownerId;
  return member.id !== message.guild.ownerId && member.roles.highest.position < m.roles.highest.position;
}
/** Permissions a requester may hand out: only ones they hold themselves (the owner and administrators may give any except Administrator, which only the owner may). */
export function delegable(message, names) {
  const wanted = names.map(n => P[n]).filter(Boolean);
  const m = message.member;
  if (!m) return { ok: true, denied: [] };
  const owner = message.guild.ownerId === m.id;
  const denied = names.filter(n => n === "Administrator" ? !owner : !(owner || m.permissions.has(P.Administrator) || m.permissions.has(P[n])));
  return { ok: !denied.length, denied, wanted };
}
/** What people say for each permission, mapped to Discord's own. "view" is seeing the channel at all; "send" is writing in it: they are different things. */
const PERMS = [
  [/\b(view|see|seeing|viewing|visible|visibility|access|show|hide|hidden)\b/, "ViewChannel", "view the channel"],
  [/\b(read ?(the )?history|history|read messages|past messages)\b/, "ReadMessageHistory", "read message history"],
  [/\b(send|sending|write|writing|talk|talking|chat|chatting|speak in text|post|posting|messages?)\b/, "SendMessages", "send messages"],
  [/\b(react|reacting|reactions?)\b/, "AddReactions", "add reactions"],
  [/\b(attach|attachments?|files?|upload|uploads|images?|pictures?)\b/, "AttachFiles", "attach files"],
  [/\b(embed|embeds|links?)\b/, "EmbedLinks", "embed links"],
  [/\b(mention ?everyone|@everyone|everyone ping|ping everyone)\b/, "MentionEveryone", "mention @everyone"],
  [/\b(external emoji|custom emoji|emojis?)\b/, "UseExternalEmojis", "use external emoji"],
  [/\b(stickers?)\b/, "UseExternalStickers", "use external stickers"],
  [/\b(threads?)\b/, "CreatePublicThreads", "create threads"],
  [/\b(slash|app commands?|bot commands?|commands?)\b/, "UseApplicationCommands", "use commands"],
  [/\b(polls?)\b/, "SendPolls", "create polls"],
  [/\b(manage messages|delete messages|pin)\b/, "ManageMessages", "manage messages"],
  [/\b(invites?)\b/, "CreateInstantInvite", "create invites"],
  [/\b(connect|join|joining)\b/, "Connect", "connect to voice"],
  [/\b(speak|speaking|voice|mic|microphone)\b/, "Speak", "speak in voice"],
  [/\b(stream|streaming|video|camera|screen ?share)\b/, "Stream", "stream"],
];
export const permsOf = spec => {
  const out = [];
  for (const part of String(spec ?? "").toLowerCase().split(/\s*(?:,|&|\+|\band\b|\/)\s*/).filter(Boolean)) {
    const direct = Object.keys(P).find(k => k.toLowerCase() === part.replace(/[^a-z]/g, ""));
    if (direct) { out.push([direct, part]); continue; }
    const hit = PERMS.find(([re]) => re.test(part));
    if (hit) out.push([hit[1], hit[2]]);
  }
  return [...new Map(out.map(x => [x[0], x])).values()];
};
export const allowOf = v => /^(false|no|off|deny|denied|remove|disable|disallow|block|hide)$/i.test(String(v ?? "").trim()) ? false : /^(true|yes|on|allow|allowed|enable|grant|show|let)$/i.test(String(v ?? "").trim()) ? true : /^(reset|neutral|default|clear|null|inherit)$/i.test(String(v ?? "").trim()) ? null : undefined;

