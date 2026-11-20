// A stand-in for a Discord server with enough behaviour to exercise the assistant end to end without a network: channels with permission
// overwrites, roles, members with paging, messages that can be sent, edited, pinned and deleted, buttons that can be pressed, and switches
// that make Discord misbehave (member list refused, a send that times out after the message was created). Every change is written to
// `mutations`, so a test can prove exactly what happened and that nothing else did. It proves logic; it does not prove the live Discord API.
import { Collection, ChannelType, PermissionFlagsBits as P, PermissionsBitField } from "discord.js";

const perms = (...flags) => new PermissionsBitField(flags.flat());
let seq = 100000000000000000n;
const nextId = () => String(++seq);

export function makeWorld({ botFlags = [P.Administrator], memberCount = null, memberListFails = false, extraRoles = [], people = null } = {}) {
  const world = { mutations: [], sendMode: "ok", confirm: "ok", memberListFails, sentTexts: [], listCalls: 0 };
  const mut = (kind, what) => world.mutations.push(`${kind}:${what}`);

  const guild = { id: "g1", name: "Test Server", ownerId: "owner1", memberCount: memberCount ?? 0, emojis: { cache: new Collection() }, verificationLevel: 1, mfaLevel: 0, explicitContentFilter: 0, premiumTier: 0, features: [], createdTimestamp: 1_600_000_000_000, premiumSubscriptionCount: 0 };
  const mkRole = (id, name, position, flags = []) => ({ id, name, position, color: 0, hoist: false, mentionable: false, managed: false, permissions: perms(...flags), members: new Collection(), guild });
  const everyone = mkRole("g1", "@everyone", 0, [P.ViewChannel, P.SendMessages]);
  const botRole = mkRole("rbot", "YSER Lab", 50, botFlags);
  guild.roles = { everyone, cache: new Collection([[everyone.id, everyone], [botRole.id, botRole]]),
    create: async ({ name, permissions }) => { const r = mkRole(nextId(), name, 1, permissions ?? []); guild.roles.cache.set(r.id, r); mut("role_create", name); return r; },
    fetch: async id => guild.roles.cache.get(id) ?? null };
  for (const [name, pos] of extraRoles) { const r = mkRole(nextId(), name, pos ?? 5); guild.roles.cache.set(r.id, r); }

  /* members */
  const ownerRole = mkRole("rown", "Owner", 99);
  const mkMember = (id, username, { bot = false, roles = [], joined = 1_700_000_000_000 } = {}) => {
    const m = { id, displayName: username, nickname: null, joinedTimestamp: joined, user: { id, username, globalName: username, bot }, permissions: perms(), guild };
    m.roles = { cache: new Collection(roles.map(r => [r.id, r])), get highest() { return [...m.roles.cache.values()].sort((a, b) => b.position - a.position)[0] ?? everyone; },
      add: async r => { m.roles.cache.set(r.id, r); mut("role_add", `${r.name}->${m.id}`); }, remove: async r => { m.roles.cache.delete(r.id); mut("role_remove", `${r.name}->${m.id}`); } };
    return m;
  };
  guild.mkMember = mkMember;
  const cache = new Collection();
  const owner = mkMember("owner1", "owner", { roles: [ownerRole] }); owner.permissions = perms(P.Administrator); cache.set(owner.id, owner);
  const mod = () => guild.roles.cache.find(r => r.name === "Moderator");
  for (const p of people ?? [["u1", "Ahmed"], ["u2", "Sara"], ["u3", "Omar"], ["u4", "Lina"]]) cache.set(p[0], mkMember(p[0], p[1], { roles: p[2] ? p[2].map(n => guild.roles.cache.find(r => r.name === n)).filter(Boolean) : [], bot: !!p[3] }));
  const me = mkMember("bot", "YSER Lab", { bot: true, roles: [botRole] }); me.permissions = perms(...botFlags); cache.set(me.id, me);
  if (!memberCount) guild.memberCount = cache.size;
  guild.members = { me, cache,
    list: async ({ limit = 1000, after } = {}) => {
      world.listCalls++;
      if (world.memberListFails) throw Object.assign(new Error("Missing Access"), { code: 50001 });
      const all = [...cache.values()], start = after ? all.findIndex(m => m.id === after) + 1 : 0;
      return new Collection(all.slice(start, start + limit).map(m => [m.id, m]));
    },
    fetch: async o => (typeof o === "string" ? cache.get(o) ?? null : o?.user ? cache.get(o.user) ?? null : cache), search: async () => new Collection() };

  /* channels */
  const overwritesOf = ow => ({ cache: ow, edit: async (target, flags) => {
    const id = target.id ?? target; const cur = ow.get(id) ?? { id, allow: perms(), deny: perms() };
    for (const [k, v] of Object.entries(flags)) { const f = P[k]; if (f == null) continue; cur.allow = cur.allow.remove(f); cur.deny = cur.deny.remove(f); if (v === true) cur.allow = cur.allow.add(f); else if (v === false) cur.deny = cur.deny.add(f); }
    ow.set(id, cur); mut("overwrite", `${id}`);
  } });
  const mkChannel = ({ id = nextId(), name, type = ChannelType.GuildText, parentId = null, overwrites = [] }) => {
    const ow = new Collection(overwrites.map(x => [x.id, { ...x, allow: perms(...(x.allow ?? [])), deny: perms(...(x.deny ?? [])) }]));
    const store = [];
    const ch = { id, name, type, parentId, guild, topic: null, rateLimitPerUser: 0, store, permissionOverwrites: overwritesOf(ow), isThread: () => false,
      get parent() { return parentId ? guild.channels.cache.get(parentId) : null; },
      isSendable: () => type !== ChannelType.GuildCategory && type !== ChannelType.GuildVoice,
      toString: () => `<#${id}>`,
      setName: async n => { ch.name = n; mut("rename_channel", `${id}->${n}`); },
      delete: async () => { guild.channels.cache.delete(id); mut("delete_channel", id); },
      setParent: async p => { ch.parentId = p; parentId = p; },
      permissionsFor(target) {
        const tid = target?.id ?? target;
        if (tid === "bot" || target?.permissions?.has?.(P.Administrator)) return perms(P.Administrator);
        const own = ow.size ? ow : ch.parent?.permissionOverwrites?.cache ?? ow;
        const e = own.get("g1"), r = own.get(tid);
        let view = !e?.deny.has(P.ViewChannel), send = !e?.deny.has(P.SendMessages);
        if (r?.allow.has(P.ViewChannel)) view = true; if (r?.allow.has(P.SendMessages)) send = true; if (r?.deny.has(P.ViewChannel)) view = false;
        return perms(...(view ? [P.ViewChannel, P.ReadMessageHistory] : []), ...(view && send ? [P.SendMessages] : []));
      },
      messages: {
        fetch: async (arg, opt) => {
          if (typeof arg === "string") { const m = store.find(x => x.id === arg); if (!m) throw new Error("Unknown Message"); return m; }
          const list = [...store].reverse().slice(0, arg?.limit ?? 50);
          const col = new Collection(list.map(m => [m.id, m])); return col;
        },
      },
      send: async payload => {
        const flat = JSON.stringify(payload);
        const isConfirm = /"custom_id":"ok:/.test(flat) || /ok:\w+/.test(flat);
        const create = () => {
          const m = { id: nextId(), channelId: id, channel: ch, author: { id: "bot" }, components: payload.components, content: payload.content, pinned: false, createdTimestamp: Date.now(), nonce: payload.nonce,
            edit: async p => { m.components = p.components ?? m.components; m.content = p.content ?? m.content; mut("message_edit", m.id); },
            pin: async () => { m.pinned = true; mut("pin", m.id); },
            delete: async () => { const i = store.indexOf(m); if (i >= 0) store.splice(i, 1); mut("message_delete", m.id); },
            awaitMessageComponent: async ({ filter }) => { if (world.confirm !== "ok" && world.confirm !== "no") throw new Error("time"); const cid = `${world.confirm}:${/ok:(\w+)/.exec(flat)?.[1] ?? "x"}`; const i = { customId: cid, user: { id: "owner1" }, update: async () => {} }; if (!filter(i)) throw new Error("filtered"); return i; } };
          store.push(m); return m;
        };
        if (isConfirm) return create();
        if (world.sendMode === "fail") throw new Error("Missing Permissions");
        if (store.some(m => payload.nonce && m.nonce === payload.nonce)) return store.find(m => m.nonce === payload.nonce); // Discord's own nonce de-duplication
        const m = create(); mut("message_send", `${name}`); world.sentTexts.push(flat);
        if (world.sendMode === "timeoutAfterCreate") { world.sendMode = "ok"; throw Object.assign(new Error("timed out"), { timeout: true }); }
        return m;
      } };
    guild.channels.cache.set(id, ch); return ch;
  };
  guild.channels = { cache: new Collection(),
    create: async o => { const ch = mkChannel({ name: o.name, type: o.type ?? ChannelType.GuildText, parentId: o.parent ?? null, overwrites: o.permissionOverwrites ?? [] }); mut("channel_create", `${o.type === ChannelType.GuildCategory ? "category:" : ""}${o.name}`); return ch; },
    fetch: async id => guild.channels.cache.get(id) ?? null };
  guild.mkChannel = mkChannel;
  guild.invites = { create: async (ch, o) => ({ code: "abc", url: "https://discord.gg/abc", expiresTimestamp: null, maxUses: o.maxUses, channelId: ch.id }), fetch: async () => ({ code: "abc", url: "https://discord.gg/abc" }) };
  guild.fetchOwner = async () => ({ id: "owner1" });
  guild.scheduledEvents = { create: async o => { mut("event_create", o.name); const ev = { id: nextId(), name: o.name, url: "https://discord.com/events/x", start: o.scheduledStartTime }; guild.events = [...(guild.events ?? []), { ...ev, ...o }]; return ev; }, fetch: async () => new Collection((guild.events ?? []).map(e => [e.id, e])) };

  const general = mkChannel({ name: "general" });
  const client = { user: { id: "bot" }, guilds: { fetch: async () => ({ approximateMemberCount: cache.size, approximatePresenceCount: 2 }) }, channels: { cache: guild.channels.cache } };
  guild.client = client;

  /** The owner's message, standing in `channel`. */
  const say = (text, channel = general) => ({ id: nextId(), guild, guildId: guild.id, channel, channelId: channel.id, content: text, member: owner, author: { id: "owner1", tag: "owner#1", username: "owner" }, client, mentions: { users: new Map(), channels: { first: () => null, values: () => [] } }, reference: null, mkMentions(...ids) { this.mentions.users = new Map(ids.map(i => [i, { id: i }])); return this; } });
  Object.assign(world, { guild, general, say, mkChannel, mkMember, owner, cache, mod, mkRole, perms });
  world.reset = () => { world.mutations.length = 0; world.sentTexts.length = 0; };
  return world;
}

/** A pair of stand-in AI providers: a writer that edits text predictably, and a counter so tests can prove how many model calls were made. */
export function fakeProviders({ failFirst = [] } = {}) {
  const calls = [], failed = new Set();
  const writer = name => ({
    enabled: () => true,
    call: async ({ system, messages }) => {
      calls.push(name);
      if (failFirst.includes(name) && !failed.has(name)) { failed.add(name); throw new Error("status 503"); }
      if (failFirst.includes(name + "*")) throw new Error("status 503");
      const user = messages.at(-1).content;
      if (/edit a Discord message/.test(system)) {
        const cur = /Current message:\n([\s\S]*?)\n\nChange requested: (.*)/.exec(user), text = cur[1], ask = cur[2].toLowerCase();
        if (/shorter|shorten|trim/.test(ask)) return { text: text.split(/[.!]\s/)[0].replace(/[.!]*$/, "") + "!", model: name };
        if (/professional/.test(ask)) return { text: "We are pleased to announce: " + text.replace(/^[^\w]+/, ""), model: name };
        if (/add that (.*)/.test(ask)) return { text: text + " " + /add that (.*)/.exec(ask)[1].replace(/^./, c => c.toUpperCase()) + ".", model: name };
        return { text: text + " (revised)", model: name };
      }
      const topic = /Topic: (.*)/.exec(user)?.[1] ?? "something";
      const short = /short/i.test(user);
      return { text: short ? `📣 ${topic}!` : `📣 **${topic}**\nJoin us tomorrow at 9:30 ET. Bring your questions and your charts. Everyone is welcome to watch.`, model: name };
    },
  });
  return { calls, providers: { groq: writer("groq"), gemini: writer("gemini"), nvidia: writer("nvidia") } };
}

export const textOf = payload => { const out = []; const walk = x => { const j = x?.toJSON ? x.toJSON() : x; if (typeof j?.content === "string") out.push(j.content); (j?.components ?? []).forEach(walk); }; (payload?.components ?? []).forEach(walk); return [payload?.content ?? "", ...out].join("\n"); };
export const said = r => [r.say ?? "", ...(r.posts ?? []).map(textOf)].join("\n");
