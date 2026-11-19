import { env } from "../env.js";
import { db, log } from "../store.js";
import { api, MAX_DURATION_MS } from "./index.js";
import { say } from "../admin/giveaways.js";

/**
 * The app's giveaway panel. The bot copies what it knows about giveaways into the `giveaways` table (so the page can show them live),
 * and does what the page asks through bot_jobs (kind "giveaway"): start, end, reroll, cancel, change a running one (extra entries for roles or
 * members, the end time, winners, prize, requirements), list the entrants, remove one, delete a finished one. Everything goes through the same
 * yserbot functions as /giveaway and the AI, so the three can never disagree.
 */
let last = "";
const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

export async function syncGiveaways(client, { force = false } = {}) {
  const a = api(); if (!db || !a) return;
  const rows = [], now = new Date().toISOString();
  for (const guild of client.guilds.cache.values()) {
    const { active, ended } = a.list(guild.id, guild);
    const nameOf = id => guild.members.cache.get(id)?.displayName ?? guild.members.cache.get(id)?.user?.username ?? null;
    for (const g of active) rows.push({ id: `a:${g.messageId}`, guild_id: guild.id, status: "active", channel_id: g.channelId, message_id: g.messageId, short_id: g.dropId, prize: g.title, winners: g.winners, entrants: g.entrants, ends_at: num(g.endsAt), started_at: num(g.startedAt), host_id: g.hostId, required_role: g.requiredRoleId, min_age: g.minAccountAgeDays || 0, bonus_roles: g.bonusRoles ?? [], bonus_users: (g.bonusUsers ?? []).map(b => ({ ...b, name: nameOf(b.id) })), winner_list: [], image_url: g.imageUrl, updated_at: now });
    for (const e of ended) rows.push({ id: `e:${e.shortId}`, guild_id: guild.id, status: "ended", channel_id: e.channelId, message_id: e.messageId, short_id: e.shortId, prize: e.title, winners: e.winners, entrants: e.entrants, ends_at: null, ended_at: num(e.endedAt), host_id: e.hostId, required_role: e.requiredRoleId, min_age: e.minAccountAgeDays || 0, bonus_roles: [], bonus_users: [], winner_list: e.winnersList ?? [], image_url: e.imageUrl, updated_at: now });
  }
  const sig = JSON.stringify(rows.map(({ updated_at, ...r }) => r));
  if (!force && sig === last) return;
  last = sig;
  if (rows.length) { const { error } = await db.from("giveaways").upsert(rows, { onConflict: "id" }); if (error) { if (!/does not exist|schema cache/i.test(error.message)) console.warn("giveaway sync:", error.message); return; } }
  const keep = new Set(rows.map(r => r.id));
  const { data } = await db.from("giveaways").select("id");
  const stale = (data ?? []).map(r => r.id).filter(id => !keep.has(id));
  if (stale.length) await db.from("giveaways").delete().in("id", stale);
}

/** Resolves a member the page named by tag, id or part of a name. */
async function memberId(guild, v) {
  const raw = String(v?.id ?? v?.name ?? v ?? "").trim();
  const id = raw.replace(/\D/g, "");
  if (id.length >= 15) return id;
  const found = await guild.members.search({ query: raw.replace(/^@/, "").slice(0, 32), limit: 2 }).catch(() => null);
  return found?.first()?.id ?? null;
}
const userBonus = async (guild, list) => { const out = []; for (const b of list ?? []) { const id = await memberId(guild, b); if (!id) throw Object.assign(new Error("member"), { friendly: `I couldn't find the member "${b.name ?? b.id}".` }); out.push({ id, extra: Math.max(1, Math.min(50, Number(b.extra) || 1)) }); } return out; };

/** One request from the page. Returns the result (the page shows it); throws a plain sentence when it can't be done. */
export async function giveawayJob(client, p) {
  const a = api(); if (!a) throw new Error("The giveaway system didn't load. Check the bot's log.");
  const guild = client.guilds.cache.get(String(p.guildId ?? "")) ?? client.guilds.cache.first();
  if (!guild) throw new Error("The bot isn't in a server.");
  const fail = r => { throw new Error(say(r)); };
  const ctx = { guild, client, session: { uid: env.owners[0] ?? client.user.id } };
  let out;
  switch (p.op) {
    case "start": {
      const ms = Number(p.durationMs) || a.parseDuration(p.duration);
      if (!ms || ms < 10_000 || ms > MAX_DURATION_MS) throw new Error("A giveaway lasts from 10 seconds up to 30 days.");
      const body = { prize: p.prize, winners: Number(p.winners) || 1, duration: `${Math.round(ms / 1000)}s`, channelId: p.channelId, requiredRoleId: p.requiredRoleId || null, bonusRoles: p.bonusRoles ?? [], bonusUsers: await userBonus(guild, p.bonusUsers), minAccountAgeDays: Number(p.minAccountAgeDays) || 0, mention: p.mention || null, imageUrl: p.imageUrl || "dynamic:prizeGiveawayBanner" };
      out = await a.create(guild.id, body, ctx); if (!out.ok) fail(out); break;
    }
    case "end": out = await a.endNow(guild.id, { messageId: p.messageId }, ctx); if (!out.ok) fail(out); break;
    case "reroll": out = await a.reroll(guild.id, { shortId: p.shortId }, ctx); if (!out.ok) fail(out); break;
    case "cancel": out = await a.cancel(guild, p.messageId); if (out.error) fail(out); break;
    case "delete": out = await a.remove(guild.id, { shortId: p.shortId }, ctx); if (!out.ok) fail(out); break;
    case "clear_history": out = a.clearHistory(guild.id); break;
    case "participants": out = await a.participants(guild.id, { messageId: p.messageId }, ctx); if (!out.ok) fail(out); break;
    case "remove_entrant": out = await a.removeParticipant(guild.id, { messageId: p.messageId, userId: p.userId }, ctx); if (!out.ok) fail(out); break;
    case "restart": out = await a.restartEmpty(guild.id, p, ctx); if (!out.ok) fail(out); break;
    case "update": {
      const patch = { ...(p.patch ?? {}) };
      if (patch.addBonusUsers) patch.addBonusUsers = await userBonus(guild, patch.addBonusUsers);
      out = await a.update(guild, p.messageId, patch); if (out.error) fail(out); out = { ok: true, changes: out.changes }; break;
    }
    default: throw new Error("unknown giveaway action");
  }
  await syncGiveaways(client, { force: true }).catch(() => {});
  await log("giveaway", { note: `panel: ${p.op}${p.prize ? " " + String(p.prize).slice(0, 60) : ""}` });
  return out;
}