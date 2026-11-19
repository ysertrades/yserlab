import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { api, MAX_DURATION_MS } from "../giveaway/index.js";
import { CAPABILITIES, TOOLS, findChannel, findRole } from "./tools.js";
import { durationMs } from "./giveawayIntent.js";
import { panel } from "./ui.js";

/**
 * Running giveaways from Discord, by the AI or by a plain request. Every tool calls the same functions the yserbot control panel used
 * (vendor/yserbot/web/giveaways.js and the /giveaway command), so a giveaway started here is the same giveaway as one started with /giveaway or
 * from the app's panel: same card, same Enter button, same draw, same winner messages. A giveaway goes to the channel named, or to the
 * channel the request was made in when none is named.
 */
const plain = text => ({ content: String(text).slice(0, 1990), allowedMentions: { parse: [] } });
const friendly = (m, t) => Object.assign(new Error(m), { friendly: t });
const link = (guildId, channelId, messageId) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
const stamp = (ms, f = "R") => `<t:${Math.floor(ms / 1000)}:${f}>`;
const ERRORS = {
  bad_prize: "Give the giveaway a prize.", bad_winners: "Winners must be between 1 and 50.", bad_duration: "A giveaway lasts from 10 seconds up to 30 days.",
  bad_channel: "I can't use that channel for a giveaway.", bad_role: "I couldn't find one of the roles.", bad_age: "The minimum account age must be 0 to 3650 days.", bad_mention: "I couldn't find the role to ping.",
  guild_unavailable: "I can't see this server right now.", unknown_giveaway: "I couldn't find that giveaway.", not_found: "That giveaway isn't running (it may have ended).",
  end_in_past: "The new end time would already be over.", no_winners: "Nobody won this giveaway, so there is nobody to send a prize to.", empty_prize: "Write the prize message first.", unknown_winner: "That member is not a winner of this giveaway.", too_long: "A giveaway can run for 30 days at most.", message_deleted: "The giveaway's message was deleted.", channel_gone: "The giveaway's channel is gone.",
};
export const say = r => ERRORS[r?.error] ?? `${r?.error ?? "it failed"}${r?.detail ? ` (${r.detail})` : ""}`;
const gaw = () => { const a = api(); if (!a) throw friendly("not loaded", "The giveaway system isn't available right now (it failed to load). Check the bot's log."); return a; };

/** The running giveaway a request means: by message id, drop id or words of the prize; else the only one; else the latest here; else the latest anywhere. */
export function pickActive(guild, channelId, which) {
  const { active } = gaw().list(guild.id, guild);
  if (!active.length) return { none: true };
  const w = String(which ?? "").trim();
  let found = null;
  if (/^\d{15,}$/.test(w)) found = active.find(g => g.messageId === w);
  else if (/^[a-z0-9]{8}$/i.test(w)) found = active.find(g => String(g.dropId ?? "").toLowerCase() === w.toLowerCase());
  else if (w) { const q = w.toLowerCase(); found = active.find(g => String(g.title).toLowerCase().includes(q)); }
  if (found) return { giveaway: found, active };
  if (w) return { missing: w, active };
  if (active.length === 1) return { giveaway: active[0], active };
  const here = active.filter(g => g.channelId === channelId).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const pick = here[0] ?? [...active].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
  return { giveaway: pick, active, assumed: true };
}
const nameList = (guild, g) => [...(g.bonusRoles ?? []).map(b => `<@&${b.id}> +${b.extra}`), ...(g.bonusUsers ?? []).map(b => `<@${b.id}> +${b.extra}`)];
const resolveRoles = (guild, list, label = "role") => (list ?? []).map(r => {
  const id = String(r.id ?? "").replace(/\D/g, "");
  const role = id.length >= 15 ? guild.roles.cache.get(id) : findRole(guild, r.name ?? r.id);
  if (!role) throw friendly("role not found", `I couldn't find the ${label} "${r.name ?? r.id}".`);
  return { id: role.id, extra: Math.max(1, Math.min(10, Number(r.extra) || 1)) };
});

Object.assign(TOOLS, {
  giveaway_start: {
    cap: "giveaways", risk: "low", user: [P.ManageGuild], bot: [P.SendMessages, P.ViewChannel, P.AttachFiles],
    aliases: ["start_giveaway", "giveaway", "giveaway_create"],
    async run({ guild, channel, args, message, client, resolveMember }) {
      const a = gaw(), assumed = [];
      const prize = String(args.prize ?? "").replace(/\s+/g, " ").trim();
      if (!prize) throw friendly("no prize", "What's the prize?");
      let ms = Number(args.duration_ms) || durationMs(args.duration) || 0;
      if (!ms) { ms = 24 * 3_600_000; assumed.push("lasts 24 hours"); }
      if (ms < 10_000 || ms > MAX_DURATION_MS) throw friendly("bad duration", ERRORS.bad_duration);
      let winners = Math.floor(Number(args.winners) || 0);
      if (!winners) { winners = 1; assumed.push("1 winner"); }
      let target = channel;
      if (args.channel) { target = findChannel(guild, args.channel, [ChannelType.GuildText, ChannelType.GuildAnnouncement]); if (!target) throw friendly("channel not found", `I couldn't find a channel called "${args.channel}". Nothing was posted.`); }
      else assumed.push("posted in this channel");
      const required = args.required_role ? resolveRoles(guild, [{ id: args.required_role, name: args.required_role }], "required role")[0] : null;
      const roles = resolveRoles(guild, [...(args.bonusRoles ?? []), ...(args.bonus_role ? [{ name: args.bonus_role, id: args.bonus_role, extra: args.bonus_extra }] : [])]);
      const users = [...(args.bonusUsers ?? [])];
      if (args.bonus_user || (args.user && args.bonus_extra && !args.bonus_role)) { const m = await resolveMember(); if (!m) throw friendly("no member", "Tag the member who should get the extra entries."); users.push({ id: m.id, extra: Number(args.bonus_extra) || 1 }); }
      const body = {
        prize, winners, duration: a.formatDuration?.(ms) ?? `${Math.round(ms / 1000)}s`, channelId: target.id,
        requiredRoleId: required?.id ?? null, bonusRoles: roles, bonusUsers: users,
        minAccountAgeDays: Number(args.min_age_days) || 0, mention: args.mention || null, imageUrl: "dynamic:prizeGiveawayBanner",
      };
      body.duration = require_format(ms);
      const out = await a.create(guild.id, body, { guild, client, session: { uid: message.author?.id ?? client.user.id } });
      if (!out.ok) throw friendly(out.error, `I couldn't start it: ${say(out)}`);
      const extra = [...roles.map(r => `<@&${r.id}> +${r.extra}`), ...users.map(u => `<@${u.id}> +${u.extra}`)];
      return panel({ title: "Giveaway started", accent: "up", lines: [
        `**${prize}**`, `${winners} winner${winners === 1 ? "" : "s"} · ends ${stamp(out.endsAt)} (${stamp(out.endsAt, "f")})`, `In ${target}: ${link(guild.id, target.id, out.messageId)}`,
        required ? `Only <@&${required.id}> can enter.` : "", extra.length ? `Extra entries: ${extra.join(", ")}` : "", body.minAccountAgeDays ? `Accounts must be ${body.minAccountAgeDays}+ days old.` : "",
        assumed.length ? `-# Because you didn't say: ${assumed.join(", ")}.` : "",
      ], footer: `Giveaway ${out.messageId} is live; say "add extra entries to a role" or "end the giveaway" any time` });
    },
  },
  giveaway_end: {
    cap: "giveaways", risk: "low", user: [P.ManageGuild], bot: [P.SendMessages], aliases: ["end_giveaway"],
    async run({ guild, channel, args }) {
      const r = pickActive(guild, channel.id, args.which);
      if (r.none) throw friendly("none", "There's no giveaway running right now.");
      if (r.missing) throw friendly("missing", `I couldn't find a running giveaway matching "${r.missing}".`);
      const out = await gaw().endNow(guild.id, { messageId: r.giveaway.messageId }, { guild });
      if (!out.ok) throw friendly(out.error, `I couldn't end it: ${say(out)}`);
      return plain(`🏁 Ended **${r.giveaway.title}** and drew the winner${r.giveaway.winners === 1 ? "" : "s"} in <#${r.giveaway.channelId}>.${r.assumed ? ` (There were ${r.active.length} running; I ended the latest here.)` : ""}`);
    },
  },
  giveaway_reroll: {
    cap: "giveaways", risk: "low", user: [P.ManageGuild], bot: [P.SendMessages], aliases: ["reroll_giveaway"],
    async run({ guild, args }) {
      const { ended } = gaw().list(guild.id, guild);
      const w = String(args.which ?? "").trim().toLowerCase();
      const pick = w ? ended.find(e => e.shortId === w || String(e.title).toLowerCase().includes(w)) : ended.find(e => e.entrants > 0);
      if (!pick) throw friendly("none", ended.length ? "I couldn't find an ended giveaway with entries to reroll." : "No giveaway has ended yet, so there's nothing to reroll.");
      const out = await gaw().reroll(guild.id, { shortId: pick.shortId }, { guild });
      if (!out.ok) throw friendly(out.error, `I couldn't reroll it: ${say(out)}`);
      return plain(`🎲 Rerolled **${pick.title}**. The new winner${pick.winners === 1 ? "" : "s"} were announced under the giveaway.`);
    },
  },
  giveaway_list: {
    cap: "giveaways", risk: "read", bot: [], aliases: ["list_giveaways", "giveaways"],
    async run({ guild }) {
      const { active, ended } = gaw().list(guild.id, guild);
      const lines = [
        ...(active.length ? ["**Running**", ...active.map(g => `• **${g.title}** · ${g.entrants} entr${g.entrants === 1 ? "y" : "ies"} · ${g.winners} winner${g.winners === 1 ? "" : "s"} · ends ${stamp(g.endsAt)} · <#${g.channelId}>${nameList(guild, g).length ? `\n   ⭐ ${nameList(guild, g).join(", ")}` : ""} · \`${g.dropId ?? g.messageId}\``)] : ["No giveaway is running."]),
        ...(ended.length ? ["", "**Recently ended**", ...ended.slice(0, 5).map(e => `• **${e.title}** · ${e.entrants} entries · ${e.winnersList?.length ? e.winnersList.map(w => `<@${w.id}>`).join(", ") : "no winner"} · \`${e.shortId}\``)] : []),
      ];
      return panel({ title: "Giveaways", accent: active.length ? "accent" : "flat", lines });
    },
  },
  giveaway_participants: {
    cap: "giveaways", risk: "read", user: [P.ManageGuild], bot: [], aliases: ["giveaway_entries"],
    async run({ guild, channel, args }) {
      const r = pickActive(guild, channel.id, args.which);
      if (r.none) throw friendly("none", "There's no giveaway running right now.");
      if (r.missing) throw friendly("missing", `I couldn't find a running giveaway matching "${r.missing}".`);
      const out = await gaw().participants(guild.id, { messageId: r.giveaway.messageId }, { guild });
      if (!out.ok) throw friendly(out.error, say(out));
      return panel({ title: `Entries: ${out.prize}`, lines: [`**${out.count}** people entered · **${out.totalTickets}** tickets in the draw`, ...out.participants.slice(0, 10).map(p => `• <@${p.id}> · ${p.entries} ticket${p.entries === 1 ? "" : "s"}${p.young ? " · new account" : ""}`), out.count > 10 ? `-# and ${out.count - 10} more` : ""] });
    },
  },
  giveaway_bonus: {
    cap: "giveaways", risk: "low", user: [P.ManageGuild], bot: [P.SendMessages], aliases: ["extra_entries", "giveaway_extra"],
    async run({ guild, channel, args, resolveMember }) {
      const r = pickActive(guild, channel.id, args.which);
      if (r.none) throw friendly("none", "There's no giveaway running right now. Start one and I'll add the extra entries.");
      if (r.missing) throw friendly("missing", `I couldn't find a running giveaway matching "${r.missing}".`);
      const patch = {};
      if (args.removeRoles?.length || args.removeUsers?.length) { patch.removeBonusRoles = args.removeRoles ?? []; patch.removeBonusUsers = args.removeUsers ?? []; }
      const roles = resolveRoles(guild, [...(args.bonusRoles ?? []), ...(args.bonus_role ? [{ name: args.bonus_role, id: args.bonus_role, extra: args.bonus_extra }] : [])]);
      const users = [...(args.bonusUsers ?? [])];
      if (args.user && !args.bonusUsers?.length) { const m = await resolveMember(); if (m) users.push({ id: m.id, extra: Number(args.bonus_extra) || 1 }); }
      if (roles.length) patch.addBonusRoles = roles;
      if (users.length) patch.addBonusUsers = users;
      if (!Object.keys(patch).length) throw friendly("nothing", "Who should get extra entries, and how many? For example \"2x entries for @VIP\" or \"+3 entries for @someone\".");
      const out = await gaw().update(guild, r.giveaway.messageId, patch);
      if (out.error) throw friendly(out.error, `I couldn't change it: ${say(out)}`);
      const now = nameList(guild, { bonusRoles: out.record.bonusRoles, bonusUsers: out.record.bonusUsers });
      return panel({ title: "Extra entries updated", accent: "up", lines: [`**${out.record.prize}** · the card was updated in place.`, now.length ? `Extra entries now: ${now.join(", ")}` : "No extra entries any more.", `Takes effect for the draw: every entrant is counted with their current roles when it ends.`, r.assumed ? `-# ${r.active.length} giveaways are running; I changed the latest here. Say "for <prize>" to pick another.` : ""] });
    },
  },
  giveaway_edit: {
    cap: "giveaways", risk: "low", user: [P.ManageGuild], bot: [P.SendMessages], aliases: ["edit_giveaway", "extend_giveaway"],
    async run({ guild, channel, args }) {
      const r = pickActive(guild, channel.id, args.which);
      if (r.none) throw friendly("none", "There's no giveaway running right now.");
      if (r.missing) throw friendly("missing", `I couldn't find a running giveaway matching "${r.missing}".`);
      const patch = {};
      if (args.extend_ms) patch.extendMs = Number(args.extend_ms);
      else if (args.extend) patch.extendMs = durationMs(args.extend);
      if (args.ends_in) patch.endsInMs = durationMs(args.ends_in);
      if (args.winners) patch.winners = args.winners;
      if (args.prize) patch.prize = args.prize;
      if ("required_role" in args) patch.requiredRoleId = args.required_role ? resolveRoles(guild, [{ id: args.required_role, name: args.required_role }])[0].id : null;
      if (args.min_age_days != null) patch.minAccountAgeDays = args.min_age_days;
      if (!Object.keys(patch).length) throw friendly("nothing", "What should change: the end time, the winners, the prize or the requirements?");
      const out = await gaw().update(guild, r.giveaway.messageId, patch);
      if (out.error) throw friendly(out.error, `I couldn't change it: ${say(out)}`);
      return plain(`✏️ Updated **${out.record.prize}** (${out.changes.join(", ") || "no change"}). It ends ${stamp(out.record.endTime)}.`);
    },
  },
  giveaway_cancel: {
    cap: "giveaways", risk: "high", user: [P.ManageGuild], bot: [P.ManageMessages], aliases: ["cancel_giveaway", "delete_giveaway"],
    preview: ({ guild, channel, args }) => { const r = pickActive(guild, channel.id, args.which); return { title: "Cancel this giveaway?", lines: [r.giveaway ? `**${r.giveaway.title}** with ${r.giveaway.entrants} entries will be removed and nobody is drawn.` : "No matching giveaway."] }; },
    async run({ guild, channel, args }) {
      const r = pickActive(guild, channel.id, args.which);
      if (r.none) throw friendly("none", "There's no giveaway running right now.");
      if (r.missing) throw friendly("missing", `I couldn't find a running giveaway matching "${r.missing}".`);
      const out = await gaw().cancel(guild, r.giveaway.messageId);
      if (out.error) throw friendly(out.error, say(out));
      return plain(`🛑 Cancelled **${out.prize}**. Nobody was drawn.`);
    },
  },
});
for (const spec of Object.values(TOOLS)) for (const alias of spec.aliases ?? []) TOOLS[alias] ??= spec;
if (!CAPABILITIES.includes("giveaways")) CAPABILITIES.push("giveaways");

function require_format(ms) { // the exact short form the giveaway code reads: 90s, 15m, 6h, 2d
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000]]) if (ms % size === 0) return `${ms / size}${unit}`;
  return `${Math.round(ms / 1000)}s`;
}
