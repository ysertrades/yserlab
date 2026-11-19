import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits as P } from "discord.js";
import { TOOLS, findRole } from "../admin/tools.js";
import { panel } from "../admin/ui.js";
import { getConvo, setList, setFocus } from "./memory.js";

/**
 * The tools the assistant's intelligence layer added to the administrator's registry. They are registered in the same TOOLS table, so every
 * one of them passes through runTool: capability switches, the requester's and the bot's real permissions, confirmation for risky ones, the
 * audit line and plain failure messages. Each reads from Discord (never from the model), says what it could not get, and verifies writes by
 * reading them back.
 */
const friendly = (message, text) => Object.assign(new Error(message), { friendly: text });
const plain = text => ({ content: String(text).slice(0, 1990), allowedMentions: { parse: [] } });
const tag = id => `<@${id}>`;
const stamp = (ms, f = "D") => `<t:${Math.floor(ms / 1000)}:${f}>`;
const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timed out waiting for Discord"), { timeout: true })), ms))]);

/** The text of a message, including the text inside a Components V2 container. */
export const plainOf = m => {
  const inside = c => [typeof c?.content === "string" ? c.content : "", ...(c?.components ?? []).map(inside)].filter(Boolean).join("\n");
  return String(m?.content || (m?.components ?? []).map(c => inside(c.toJSON ? c.toJSON() : c)).join("\n") || m?.embeds?.[0]?.description || "");
};

/* ───────────────────────── member retrieval ───────────────────────── */
const LIMIT_INTENT = "Discord only hands a bot the member list when the **Server Members Intent** is switched on for it (Developer Portal, Bot, Privileged Gateway Intents).";

/**
 * Every member Discord will give us. Reads the REST member list page by page (1000 at a time, up to `max`), falls back to what the bot has
 * already seen, and says exactly what limited it. Never pads the result: what comes back is what Discord returned.
 */
export async function fetchMembers(guild, { max = 10_000 } = {}) {
  const total = guild.memberCount ?? guild.members.cache.size;
  if (total && guild.members.cache.size >= total) return { members: [...guild.members.cache.values()], total, complete: true, limitation: null };
  try {
    const got = new Map();
    let after;
    while (got.size < max) {
      const page = await guild.members.list({ limit: 1000, after, cache: true });
      if (!page?.size) break;
      for (const m of page.values()) got.set(m.id, m);
      after = page.lastKey?.() ?? [...page.keys()].pop();
      if (page.size < 1000) break;
    }
    const complete = !total || got.size >= total;
    return { members: [...got.values()], total, complete, limitation: complete ? null : got.size >= max ? `Large server: I stopped after ${max} members.` : `Discord returned ${got.size} of ${total} members.` };
  } catch (e) {
    const text = String(e?.message ?? e), seen = [...guild.members.cache.values()];
    const intent = /disallowed|intent|Missing Access|50001|403/i.test(text);
    return { members: seen, total, complete: false, limitation: intent ? `${LIMIT_INTENT} Until then I can only list the ${seen.length} member${seen.length === 1 ? "" : "s"} I have seen so far.` : `Discord would not give me the member list (${text.slice(0, 100)}). These are the ${seen.length} I have seen so far.` };
  }
}

const roleNames = (m, guild, n = 3) => [...(m.roles?.cache?.values?.() ?? [])].filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position).slice(0, n).map(r => r.name);
const labelOf = m => m.displayName ?? m.user?.globalName ?? m.user?.username ?? m.id;

/** Applies the filters the request named. Every property used here is a real field of a Discord member. */
export function filterMembers(members, guild, { role, query, kind = "all", sort = "name" } = {}) {
  let list = members.slice();
  if (role) list = list.filter(m => m.roles?.cache?.has?.(role.id));
  if (query) { const q = norm(query); list = list.filter(m => [m.displayName, m.nickname, m.user?.username, m.user?.globalName, m.id].some(x => norm(x).includes(q))); }
  if (kind === "bots") list = list.filter(m => m.user?.bot); else if (kind === "humans") list = list.filter(m => !m.user?.bot);
  const by = { name: (a, b) => labelOf(a).localeCompare(labelOf(b)), joined: (a, b) => (a.joinedTimestamp ?? 0) - (b.joinedTimestamp ?? 0), newest: (a, b) => (b.joinedTimestamp ?? 0) - (a.joinedTimestamp ?? 0) }[sort] ?? (() => 0);
  return list.sort(by);
}

const PAGE = 15, snapshots = new Map(), SNAP_TTL = 20 * 60_000;
const gc = () => { for (const [k, s] of snapshots) if (Date.now() - s.at > SNAP_TTL) snapshots.delete(k); };

function pageOf(snap, page) {
  const pages = Math.max(1, Math.ceil(snap.items.length / PAGE)), p = Math.min(Math.max(0, page), pages - 1);
  const slice = snap.items.slice(p * PAGE, p * PAGE + PAGE);
  const lines = slice.map((m, i) => `${p * PAGE + i + 1}. ${m.bot ? "🤖" : "👤"} ${tag(m.id)} · ${m.label}${m.roles.length ? ` · ${m.roles.join(", ")}` : ""}${m.joined ? ` · joined ${stamp(m.joined)}` : ""} · \`${m.id}\``);
  const rows = [];
  if (pages > 1) rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mlist:${snap.id}:${p - 1}`).setLabel("◀ Previous").setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
    new ButtonBuilder().setCustomId(`mlist:${snap.id}:${p + 1}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(p >= pages - 1)));
  const post = panel({ title: snap.title, accent: snap.limitation ? "amber" : "accent", lines: [...lines, snap.limitation ? `\n⚠️ ${snap.limitation}` : ""], footer: `Showing ${p * PAGE + 1}-${p * PAGE + slice.length} of ${snap.items.length}${pages > 1 ? ` · page ${p + 1}/${pages}` : ""}${snap.total && snap.total !== snap.items.length ? ` · server has ${snap.total} members` : ""}`, rows });
  return { post, slice, page: p };
}

/** The Previous/Next buttons of a member list: only the person who asked can turn the page, and the list is remembered as shown. */
export async function handleListButton(interaction) {
  if (!interaction.isButton?.() || !interaction.customId.startsWith("mlist:")) return false;
  const [, id, page] = interaction.customId.split(":"), snap = snapshots.get(id);
  if (!snap) { await interaction.reply({ content: "That list has expired. Ask me for the members again.", ephemeral: true }).catch(() => {}); return true; }
  if (interaction.user.id !== snap.userId) { await interaction.reply({ content: "Only the person who asked can turn the page.", ephemeral: true }).catch(() => {}); return true; }
  const { post, slice } = pageOf(snap, Number(page));
  setList(getConvo(snap.convo), "members", slice.map(m => ({ id: m.id, label: m.label })), { page: Number(page) });
  await interaction.update(post).catch(() => {});
  return true;
}

function showMembers(ctx, members, { title, total, limitation, convo }) {
  gc();
  const items = members.map(m => ({ id: m.id, label: labelOf(m), bot: !!m.user?.bot, roles: roleNames(m, ctx.guild), joined: m.joinedTimestamp }));
  const snap = { id: Math.random().toString(36).slice(2, 8), at: Date.now(), userId: ctx.message.author?.id, convo, title, items, total, limitation };
  snapshots.set(snap.id, snap);
  const { post, slice } = pageOf(snap, 0);
  ctx.result.list = { kind: "members", items: slice.map(m => ({ id: m.id, label: m.label })), count: items.length, total, complete: !limitation };
  return post;
}

Object.assign(TOOLS, {
  member_list: {
    cap: "members", risk: "read", bot: [], aliases: ["members", "list_members", "show_members", "all_members", "server_members", "members_by_role", "role_members_list"],
    async run(ctx) {
      const { guild, args, message } = ctx;
      let role = null;
      if (args.role) { role = findRole(guild, args.role); if (!role) throw friendly("no role", `I couldn't find a role called "${args.role}".${similarRoles(guild, args.role)}`); }
      const { members, total, complete, limitation } = await fetchMembers(guild);
      const found = filterMembers(members, guild, { role, query: args.query ?? args.user, kind: /^bots?$/i.test(args.kind ?? "") ? "bots" : /^humans?|people$/i.test(args.kind ?? "") ? "humans" : "all", sort: args.sort ?? "name" });
      if (role) ctx.result.role = { id: role.id, name: role.name };
      const what = [role && `with **${role.name}**`, args.query && `matching "${args.query}"`, /^bots?$/i.test(args.kind ?? "") && "(bots)", /^humans?$/i.test(args.kind ?? "") && "(people)"].filter(Boolean).join(" ");
      if (!found.length) return panel({ title: `Members ${what}`.trim(), accent: limitation ? "amber" : "flat", lines: [limitation ? `I found none among the members I can see.\n⚠️ ${limitation}` : "Nobody matches."] });
      return showMembers(ctx, found, { title: `Members${what ? " " + what : ""} (${found.length}${complete ? "" : "+"})`, total, limitation: complete ? null : limitation, convo: ctx.convoKey });
    },
  },
  member_count: {
    cap: "info", risk: "read", bot: [], aliases: ["count_members", "how_many_members"],
    async run({ guild, client, result }) {
      const g = await client.guilds.fetch({ guild: guild.id, withCounts: true }).catch(() => guild);
      const total = g.approximateMemberCount ?? guild.memberCount, online = g.approximatePresenceCount;
      result.count = total;
      return plain(`👥 **${total}** members${online != null ? ` · about ${online} online right now` : ""}.`);
    },
  },
  member_online: {
    cap: "members", risk: "read", bot: [], aliases: ["who_is_online", "online_members"],
    async run(ctx) {
      const { guild, client } = ctx;
      const g = await client.guilds.fetch({ guild: guild.id, withCounts: true }).catch(() => guild);
      const online = g.approximatePresenceCount;
      const known = [...guild.members.cache.values()].filter(m => m.presence && m.presence.status !== "offline");
      if (known.length) return showMembers(ctx, known, { title: `Online now (${known.length}${online != null && online > known.length ? ` of about ${online}` : ""})`, total: guild.memberCount, limitation: online != null && online > known.length ? "This is only the online members I have presence data for." : null, convo: ctx.convoKey });
      return panel({ title: "Who is online", accent: "amber", lines: [online != null ? `About **${online}** members are online right now.` : "Discord did not tell me how many are online.", "I can't list them by name: Discord only shares individual presence with the **Presence Intent** (Developer Portal, Bot, Privileged Gateway Intents)."] });
    },
  },
  message_send: {
    cap: "messages", risk: "low", user: [P.SendMessages], bot: [P.SendMessages], aliases: ["send_draft", "post_message"],
    // Idempotent: the same key sends once. If Discord times out, the channel is read before anything is sent again.
    async run({ guild, channel, args, me, result }) {
      const text = String(args.text ?? "").trim(); if (!text) throw friendly("no text", "There is nothing to send yet.");
      if (!channel?.isSendable?.()) throw friendly("no channel", "I can't post in that channel.");
      const all = /(^|[\s>*_~(])@(everyone|here)\b/i.test(text);
      const post = panel({ title: args.title ? String(args.title).slice(0, 200) : undefined, lines: [text.slice(0, 3600)], pings: [...text.matchAll(/<@!?(\d{15,})>/g)].map(m => m[1]) });
      if (all) post.allowedMentions = { parse: ["everyone"], users: post.allowedMentions.users };
      const nonce = String(args.key ?? Math.random().toString(36).slice(2)).slice(0, 25);
      let sent = null, failure = null;
      try { sent = await withTimeout(channel.send({ ...post, nonce, enforceNonce: true }), 15_000); } catch (e) { failure = e; }
      if (!sent?.id) { // it may exist anyway: look before ever trying again
        const recent = await channel.messages.fetch({ limit: 12 }).catch(() => null);
        const needle = text.slice(0, 120);
        sent = [...(recent?.values() ?? [])].find(m => m.author?.id === me.id && Date.now() - m.createdTimestamp < 180_000 && plainOf(m).includes(needle)) ?? null;
        if (!sent) throw failure ?? new Error("Discord did not confirm delivery");
        result.recovered = true;
      }
      const back = await channel.messages.fetch(sent.id).catch(() => null);
      if (!back) throw new Error("Discord did not return the message I just sent");
      Object.assign(result, { kind: "message", id: back.id, channelId: channel.id, channelName: channel.name, url: `https://discord.com/channels/${guild.id}/${channel.id}/${back.id}`, text });
      return plain(`📣 Sent in ${channel}${result.recovered ? " (the first attempt timed out, but the message was already there, so I did not send it twice)" : ""}. ${result.url}`);
    },
  },
  message_update: {
    cap: "messages", risk: "low", bot: [P.SendMessages], aliases: ["edit_sent_message"],
    async run({ guild, channel, args, me, result }) {
      const text = String(args.text ?? "").trim(); if (!text) throw friendly("no text", "What should the message say now?");
      const target = await channel.messages.fetch(String(args.messageId ?? "")).catch(() => null);
      if (!target) throw friendly("gone", "I can't find that message any more (it may have been deleted), so I didn't edit anything.");
      if (target.author?.id !== me.id) throw friendly("not mine", "I can only edit messages I sent myself.");
      const p = panel({ title: args.title ? String(args.title).slice(0, 200) : undefined, lines: [text.slice(0, 3600)] });
      await target.edit({ components: p.components, flags: p.flags });
      const back = await channel.messages.fetch(target.id).catch(() => null);
      if (!back || !plainOf(back).includes(text.slice(0, 80))) throw new Error("Discord did not apply the edit");
      Object.assign(result, { kind: "message", id: back.id, channelId: channel.id, channelName: channel.name, url: `https://discord.com/channels/${guild.id}/${channel.id}/${back.id}`, text, edited: true });
      return plain(`✏️ Edited the message in ${channel}. ${result.url}`);
    },
  },
  message_pin: {
    cap: "messages", risk: "low", user: [P.ManageMessages], bot: [P.ManageMessages], aliases: ["pin_message"],
    async run({ channel, args, reason, result }) {
      const target = await channel.messages.fetch(String(args.messageId ?? "")).catch(() => null);
      if (!target) throw friendly("gone", "I can't find that message any more, so nothing was pinned.");
      if (target.pinned) { Object.assign(result, { kind: "message", id: target.id, already: true }); return plain("📌 That message is already pinned."); }
      await target.pin(reason);
      const back = await channel.messages.fetch(target.id, { force: true }).catch(() => null);
      if (!back?.pinned) throw new Error("Discord did not pin it");
      Object.assign(result, { kind: "message", id: back.id, pinned: true });
      return plain("📌 Pinned. Verified.");
    },
  },
  message_remove: {
    cap: "messages", risk: "high", bot: [], aliases: ["delete_sent_message"],
    preview: ({ args, channel }) => ({ title: "Delete this message?", lines: [`In ${channel}: "${String(args.preview ?? "").slice(0, 300)}"`, "This cannot be undone."] }),
    async run({ message, channel, args, me, result }) {
      const target = await channel.messages.fetch(String(args.messageId ?? "")).catch(() => null);
      if (!target) throw friendly("gone", "That message is already gone, so there was nothing to delete.");
      const mine = target.author?.id === me.id;
      if (!mine && !(message.member?.permissions?.has?.(P.ManageMessages) || message.guild?.ownerId === message.member?.id)) throw friendly("not allowed", "You can't delete other people's messages here (it needs Manage Messages).");
      if (!mine && !channel.permissionsFor?.(me)?.has(P.ManageMessages)) throw friendly("bot lacks", "I can't delete that one: I'm missing Manage Messages here.");
      await target.delete();
      const still = await channel.messages.fetch(target.id).catch(() => null);
      if (still) throw new Error("the message is still there");
      Object.assign(result, { kind: "message", id: target.id, deleted: true });
      return plain("🗑️ Deleted. Verified it is gone.");
    },
  },
});

function similarRoles(guild, q) {
  const k = norm(q).slice(0, 4), near = [...guild.roles.cache.values()].filter(r => r.id !== guild.id && k && norm(r.name).includes(k)).slice(0, 3).map(r => `**${r.name}**`);
  return near.length ? ` Did you mean ${near.join(" or ")}?` : "";
}
export { setFocus };
