import { ChannelType } from "discord.js";
import { candidates } from "../people.js";
import { ordinalOf, osa } from "./classify.js";

/**
 * Reference resolution: turns "here", "#announcements", "the second person", "him", "the channel we made" into real Discord ids, using the
 * server's own data and the conversation's structured state. The rules: the most recent relevant thing wins, an action that is already done
 * is not a target again, and when two things are equally plausible it says so and asks (it never silently picks one).
 */
const norm = s => String(s ?? "").toLowerCase().replace(/^[#@]/, "").replace(/[^a-z0-9]+/g, "");
const TEXTISH = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];
export const where = c => `${c.parent?.name ? ` in ${c.parent.name}` : ""}`;

/** Channels a name could mean, exact matches before partial ones. { channel } when one clearly fits, { ambiguous } when several do. */
export function resolveChannel(guild, query, { current, types } = {}) {
  const q = String(query ?? "").trim();
  if (!q || /^(here|this( channel)?|this one|current( channel)?|in here)$/i.test(q)) return current ? { channel: current } : { none: true };
  const id = /<#(\d{15,})>/.exec(q)?.[1] ?? (/^\d{15,}$/.test(q) ? q : null);
  const pool = [...guild.channels.cache.values()].filter(c => !c.isThread?.() && (!types || types.includes(c.type)));
  if (id) { const hit = pool.find(c => c.id === id); return hit ? { channel: hit } : { none: true, similar: [] }; }
  const k = norm(q.replace(/\b(channel|category)\b/gi, "")); if (!k) return { none: true, similar: [] };
  const exact = pool.filter(c => norm(c.name) === k), part = pool.filter(c => norm(c.name).includes(k) || (k.length > 3 && k.includes(norm(c.name)) && norm(c.name).length > 3));
  const set = exact.length ? exact : part;
  if (set.length === 1) return { channel: set[0] };
  if (set.length > 1) return { ambiguous: set.slice(0, 5) };
  const near = pool.filter(c => k.length >= 4 && osa(norm(c.name), k) <= (k.length > 7 ? 2 : 1)); // a typo in a channel name still finds it, but only when exactly one channel is that close
  if (near.length === 1) return { channel: near[0] };
  if (near.length > 1) return { ambiguous: near.slice(0, 5) };
  return { none: true, similar: pool.filter(c => norm(c.name).slice(0, 4) === k.slice(0, 4)).slice(0, 3) };
}
export const sendable = c => !!c?.isSendable?.() && (!c.type || TEXTISH.includes(c.type) || c.isThread?.());
export const ask = list => list.map((c, i) => `${i + 1}. ${c.type === ChannelType.GuildCategory ? "" : "#"}${c.name}${where(c)}`).join("\n");

/** An item picked from a shown list by its position ("the second one", "number 3", "the last"). */
export function pickFromList(list, text) {
  if (!list?.items?.length) return { none: true };
  const i = ordinalOf(String(text).toLowerCase());
  if (i == null) return { none: true };
  const idx = i < 0 ? list.items.length + i : i;
  return list.items[idx] ? { item: list.items[idx], index: idx } : { outOfRange: true, count: list.items.length };
}

/** The member a message means: a tag, a position in the last list, "him/her/that person", or a name the bot has seen. */
export function resolveMember(text, c, message) {
  const tagged = /<@!?(\d{15,})>/.exec(text)?.[1];
  if (tagged && tagged !== message.client?.user?.id) return { id: tagged, via: "mention" };
  const raw = /^\d{15,}$/.exec(String(text).trim())?.[0]; if (raw) return { id: raw, via: "id" };
  const pick = pickFromList(c.list?.kind === "members" ? c.list : null, text);
  if (pick.item) return { id: pick.item.id, label: pick.item.label, via: "list", index: pick.index };
  if (pick.outOfRange) return { problem: `The last list had only ${pick.count} people.` };
  if (/\b(him|her|them|that (?:person|guy|member|user)|this (?:person|guy|member|user))\b/i.test(text)) {
    const m = c.entities.members?.[0];
    return m ? { id: m.id, label: m.name, via: "recent" } : { problem: "I'm not sure who you mean: no member was mentioned recently." };
  }
  if (/\b(second|first|third|fourth|fifth|last|number \d+)\b/i.test(text) && !c.list?.items?.length) return { problem: "I don't have a list of people to pick from. Ask me for the members first, or tag the person." };
  const name = String(text).replace(/^(the\s+)?/, "").replace(/^@/, "").trim();
  if (name) {
    const found = candidates(name);
    if (found.length === 1 || (found.length > 1 && found[0].exact && !found[1].exact)) return { id: found[0].id, via: "name" };
    if (found.length > 1) return { ambiguous: found.slice(0, 4).map(f => f.id) };
  }
  return { none: true };
}

/** The role "it" means in a role request: the one named, else what the last list was filtered by, else the role just made or discussed. */
export function resolveRole(guildFind, named, c) {
  if (named) return { role: guildFind(named), named };
  const fromList = c.list?.meta?.role;
  const ent = c.entities.roles?.[0];
  const pick = [c.focus?.type === "role" ? c.focus.items[0] : null, fromList, ent].find(Boolean);
  return pick ? { role: guildFind(pick.name ?? pick.id) ?? null, via: "context", ref: pick } : { none: true };
}
