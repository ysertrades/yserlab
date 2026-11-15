import { PermissionFlagsBits } from "discord.js";
import { env } from "./env.js";
import { writeStatus, settings } from "./store.js";
import { feedState, events, pick } from "./calendar/feed.js";
import { stats } from "./knowledge.js";

const started = Date.now();
const TEXT_TYPES = new Set([0, 5, 15, 16]); // text, announcement, forum, media
const KIND = { 0: "text", 5: "announcement", 15: "forum", 16: "media" };

/** What the control panel shows: that the bot is alive, the channels it can see (and whether it may post in each), and the state of its inputs. */
export async function heartbeat(client) {
  const guilds = [];
  for (const guild of client.guilds.cache.values()) {
    const me = guild.members.me;
    const channels = [];
    for (const c of guild.channels.cache.values()) {
      if (!TEXT_TYPES.has(c.type)) continue;
      const perms = me ? c.permissionsFor(me) : null;
      channels.push({ id: c.id, name: c.name, kind: KIND[c.type], parent: c.parent?.name ?? null, canSend: !!perms?.has(PermissionFlagsBits.SendMessages) || c.type === 15 && !!perms?.has(PermissionFlagsBits.SendMessagesInThreads) });
    }
    channels.sort((a, b) => (a.parent ?? "").localeCompare(b.parent ?? "") || a.name.localeCompare(b.name));
    guilds.push({ id: guild.id, name: guild.name, channels });
  }
  const { config } = await settings();
  let next = null;
  try { const e = pick(await events(), config.news).find(x => x.at.toMillis() > Date.now() && !x.allDay); if (e) next = { title: e.title, currency: e.currency, at: e.at.toISO(), impact: e.impact }; } catch { /* the feed may be down */ }
  await writeStatus({ online: true, tag: client.user?.tag, uptime: Math.round((Date.now() - started) / 1000), ping: client.ws.ping, guilds, feed: feedState(), next, ai: { ready: !!(env.groqKey || env.geminiKey), model: env.groqKey ? "groq " + (env.groqModel || "openai/gpt-oss-120b") : env.geminiModel, knowledge: stats() }, version: "1.0.0", at: new Date().toISOString() });
}
export const offline = () => writeStatus({ online: false, at: new Date().toISOString() });
