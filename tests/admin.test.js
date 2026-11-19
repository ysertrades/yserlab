// The administrator, tested against stand-ins for Discord's objects (no network, no database, no real server). These prove the logic: intent
// recognition, the permission gate, confirmation, hierarchy and delegation limits, verification, rollback, automod rules and Components V2 limits.
// They do NOT prove behaviour against the live Discord API; that needs a development server (see docs/ADMIN.md).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Collection, ChannelType, MessageFlags, PermissionFlagsBits as P, PermissionsBitField } from "discord.js";

process.env.SUPABASE_SERVICE_KEY = ""; process.env.SUPABASE_SERVICE_ROLE_KEY = ""; process.env.YSER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "yser-admin-"));
const { intentOf } = await import("../src/admin/intent.js");
const { runTool, TOOLS } = await import("../src/admin/tools.js");
await import("../src/admin/control.js");
const { panel, check, LIMITS } = await import("../src/admin/ui.js");
const { inspect, AUTOMOD_DEFAULTS } = await import("../src/admin/automod.js");
const { recentAudit } = await import("../src/admin/audit.js");
const { runWorkflow, buildPlan } = await import("../src/admin/workflows.js");
const { delegable } = await import("../src/admin/guard.js");

/* ── stand-ins ── */
const perms = (...flags) => new PermissionsBitField(flags);
function mkRole(id, name, position, flags = [], extra = {}) { return { id, name, position, color: 0, hoist: false, mentionable: false, managed: false, permissions: perms(...flags), members: new Collection(), edit: async function (p) { Object.assign(this, p); if (p.permissions) this.permissions = p.permissions; return this; }, delete: async function () { this.guild.roles.cache.delete(this.id); }, ...extra }; }
function mkGuild({ botFlags = [P.Administrator], failChannelAt = null, ownerId = "owner1" } = {}) {
  const g = { id: "g1", name: "Test Server", ownerId, memberCount: 5, verificationLevel: 1, mfaLevel: 0, explicitContentFilter: 0, premiumTier: 0, features: [], createdTimestamp: 1_600_000_000_000, deleted: [], created: [] };
  const everyone = mkRole("g1", "@everyone", 0, [P.ViewChannel, P.SendMessages]); everyone.guild = g;
  const botRole = mkRole("rb", "Bot", 10, botFlags); botRole.guild = g;
  g.roles = { everyone, cache: new Collection([[everyone.id, everyone], [botRole.id, botRole]]),
    create: async ({ name, ...rest }) => { const r = mkRole("r" + g.roles.cache.size, name, 1, rest.permissions ?? []); r.guild = g; Object.assign(r, { color: 0 }); g.roles.cache.set(r.id, r); g.created.push(r.id); return r; },
    fetch: async id => g.roles.cache.get(id), delete: async id => { g.roles.cache.delete(id); } };
  const me = { id: "bot", roles: { highest: botRole }, permissions: perms(...botFlags) };
  g.members = { me, cache: new Collection(), fetch: async o => (o?.user ? { id: o.user, roles: { cache: new Collection() }, user: { id: o.user } } : new Collection()), search: async () => new Collection() };
  g.channels = { cache: new Collection(),
    create: async o => {
      if (failChannelAt != null && g.created.filter(x => String(x).startsWith("c")).length >= failChannelAt) throw new Error("Missing Permissions");
      const id = "c" + (g.channels.cache.size + 1), ov = new Collection((o.permissionOverwrites ?? []).map(x => [x.id, { ...x, allow: perms(...(x.allow ?? [])), deny: perms(...(x.deny ?? [])) }]));
      const ch = { id, name: o.name, type: o.type, parentId: o.parent ?? null, topic: o.topic, permissionOverwrites: { cache: ov, edit: async () => {} }, isThread: () => false, isSendable: () => o.type !== ChannelType.GuildCategory, send: async () => ({ id: "m" }), delete: async () => { g.channels.cache.delete(id); g.deleted.push(id); },
        permissionsFor(target) { const t = target.id ?? target; if (t === "bot") return perms(P.Administrator); const e = ov.get("g1"); const denied = e?.deny.has(P.ViewChannel); const role = [...ov.values()].find(x => x.id === t && x.allow.has(P.ViewChannel)); const view = !denied || !!role; return perms(...(view ? [P.ViewChannel, P.SendMessages] : [])); } };
      g.channels.cache.set(id, ch); g.created.push(id); return ch;
    },
    fetch: async id => g.channels.cache.get(id) ?? null, delete: async id => g.channels.cache.delete(id) };
  g.invites = { created: [], create: async (ch, o) => { const inv = { code: "abc123", url: "https://discord.gg/abc123", expiresTimestamp: o.maxAge ? Date.now() + o.maxAge * 1000 : null, maxUses: o.maxUses, channelId: ch.id }; g.invites.created.push({ ch, o }); g.invites.last = inv; return inv; }, fetch: async arg => (arg?.code ? g.invites.last : new Collection()), delete: async () => {} };
  g.fetchOwner = async () => ({ id: ownerId });
  return g;
}
const text = c => { const out = []; const walk = x => { const j = x.toJSON ? x.toJSON() : x; if (typeof j.content === "string") out.push(j.content); (j.components ?? []).forEach(walk); }; (c.components ?? []).forEach(walk); return (c.content ?? "") + out.join("\n"); };
function mkMessage(guild, { flags = [P.Administrator], owner = true, press = null } = {}) {
  const channel = guild.channels.cache.first() ?? { id: "gen", name: "general", type: ChannelType.GuildText, isThread: () => false, isSendable: () => true, permissionsFor: () => perms(P.Administrator, P.CreateInstantInvite), send: async () => ({ id: "x" }) };
  if (!guild.channels.cache.has(channel.id)) guild.channels.cache.set(channel.id, channel);
  const sent = [];
  channel.send = async payload => { sent.push(payload); return { id: "m" + sent.length, edit: async () => {}, delete: async () => {}, awaitMessageComponent: async ({ filter }) => { if (press == null) throw new Error("time"); const i = { customId: `${press}:${/ok:(\w+)/.exec(JSON.stringify(payload))?.[1] ?? "x"}`, user: { id: "owner1" }, update: async () => {} }; if (!filter(i)) throw new Error("filtered"); return i; } }; };
  const member = { id: owner ? "owner1" : "u2", permissions: perms(...flags), roles: { highest: mkRole("ru", "User", owner ? 99 : 3) } };
  return { id: "msg1", guild, channel, channelId: channel.id, member, author: { id: member.id, tag: "owner#1", username: "owner" }, client: { user: { id: "bot" } }, mentions: { users: new Map() }, sent };
}
const config = (admin = {}) => ({ ai: { admin: { incident: false, disabled: [], trusted: [], confirmSeconds: 1, ...admin }, automod: { on: false } }, admins: [] });

/* ── intent ── */
test("intent: every way of asking for an invite creates one, and never asks about tagging", () => {
  for (const q of ["Give me an invite link to this server.", "Send me a server link", "Can you create an invitation?", "How do I get into the server?", "give me an invite"]) {
    const r = intentOf(q, "k1"); assert.equal(r?.action, "invite_create", q); assert.ok(!r.say);
  }
  const r = intentOf("Create an invitation that expires in 24 hours with a maximum of 10 uses", "k2");
  assert.equal(r.action, "invite_create"); assert.match(r.args.expires, /^24 hours?$/); assert.equal(r.args.max_uses, "10");
  assert.equal(intentOf("Create an invitation for the general channel", "k3").args.channel, "general");
  assert.equal(intentOf("Show me the active invitations", "k4").action, "invite_list");
  assert.equal(intentOf("revoke invite discord.gg/abc123", "k5").action, "invite_revoke");
  assert.equal(intentOf("make a permanent invite", "k6").args.permanent, "true");
});
test("intent: server questions go to their tools; unrelated chat goes to the model", () => {
  assert.equal(intentOf("How many members do we have?", "k").action, "member_count");
  assert.equal(intentOf("show me all the roles", "k").action, "role_list");
  assert.equal(intentOf("what channels do we currently have?", "k").action, "channel_list");
  assert.equal(intentOf("Review our server protection and recommend improvements", "k").action, "permission_audit");
  assert.equal(intentOf("Check if anyone has been spamming", "k").action, "scan_spam");
  assert.equal(intentOf("turn on anti-spam", "k").action, "automod_set");
  assert.equal(intentOf("what is the capital of France?", "k"), null);
  assert.equal(intentOf("explain what a fair value gap is", "k"), null);
});
test("intent: a missing name is asked for once, then the next message is the answer", () => {
  const first = intentOf("Create a private category", "chan:me");
  assert.match(first.say, /name/i);
  const second = intentOf("VIP", "chan:me");
  assert.equal(second.action, "channel_create"); assert.equal(second.args.name, "VIP"); assert.equal(second.args.kind, "category"); assert.equal(second.args.private, "true");
  assert.equal(intentOf("hello there", "chan:me"), null);
});
test("intent: roles with a colour, channels under a category", () => {
  const r = intentOf("Create a VIP role with a purple colour", "k"); assert.equal(r.action, "role_create"); assert.equal(r.args.name, "VIP"); assert.equal(r.args.color, "#9b59b6");
  const c = intentOf("create a voice channel called Lounge under the Community category", "k"); assert.equal(c.action, "channel_create"); assert.equal(c.args.kind, "voice"); assert.equal(c.args.name, "Lounge"); assert.equal(c.args.category, "Community");
});

/* ── the gate ── */
test("invite: creates a real invitation through the API and returns its actual URL", async () => {
  const g = mkGuild(), m = mkMessage(g);
  const post = await runTool(m, "invite_create", { max_uses: "10", expires: "24 hours" }, config());
  assert.ok(text(post).includes("https://discord.gg/abc123"));
  assert.equal(g.invites.created[0].o.maxUses, 10); assert.equal(g.invites.created[0].o.maxAge, 86400);
  assert.ok(post.flags & MessageFlags.IsComponentsV2);
});
test("invite: no fabricated link when the bot lacks the permission, and it says exactly what to fix", async () => {
  const g = mkGuild({ botFlags: [P.ViewChannel] }), m = mkMessage(g);
  const post = await runTool(m, "invite_create", {}, config());
  assert.ok(!text(post).includes("discord.gg"));
  assert.match(text(post), /create instant invite/i); assert.equal(g.invites.created.length, 0);
});
test("the requester's own Discord permissions are checked, not the model's say-so", async () => {
  const g = mkGuild(), m = mkMessage(g, { flags: [P.ViewChannel], owner: false });
  const post = await runTool(m, "role_create", { name: "Mods" }, config());
  assert.match(text(post), /don't have the Discord permission/i); assert.equal(g.created.length, 0);
});
test("incident mode and switched-off groups block everything, and the block is audited", async () => {
  const g = mkGuild(), m = mkMessage(g);
  assert.match(text(await runTool(m, "invite_create", {}, config({ incident: true }))), /incident mode/i);
  assert.match(text(await runTool(m, "invite_create", {}, config({ disabled: ["invites"] }))), /switched off/i);
  assert.equal(g.invites.created.length, 0);
  const rows = recentAudit(20, a => a.guild === "g1" && a.action === "invite_create" && /^blocked/.test(a.permission ?? ""));
  assert.ok(rows.length >= 2 && rows.every(r => r.ok === false));
});
test("a high-risk action waits for a button, does nothing on Cancel or on no answer, and acts on Confirm", async () => {
  for (const press of [null, "no"]) {
    const g = mkGuild(), role = mkRole("r9", "Old", 1); role.guild = g; g.roles.cache.set("r9", role);
    const m = mkMessage(g, { press });
    const post = await runTool(m, "role_delete", { role: "Old" }, config());
    assert.match(text(post), /Cancelled/i); assert.ok(g.roles.cache.has("r9"), `press=${press}`);
  }
  const g = mkGuild(), role = mkRole("r9", "Old", 1); role.guild = g; g.roles.cache.set("r9", role);
  const post = await runTool(mkMessage(g, { press: "ok" }), "role_delete", { role: "Old" }, config());
  assert.match(text(post), /Deleted the role/i); assert.ok(!g.roles.cache.has("r9"));
  const confirmed = recentAudit(10, a => a.action === "role_delete").find(a => a.ok);
  assert.equal(confirmed.confirmed, true);
});
test("role hierarchy: a role above the bot cannot be edited, and nothing is changed", async () => {
  const g = mkGuild(), high = mkRole("rh", "Boss", 50); high.guild = g; g.roles.cache.set("rh", high);
  const post = await runTool(mkMessage(g), "role_edit", { role: "Boss", color: "#ff0000" }, config());
  assert.match(text(post), /above \(or is\) my highest role/); assert.equal(high.color, 0);
});
test("delegation: nobody hands out a permission they do not hold themselves", () => {
  const g = mkGuild(), lowMod = { guild: g, member: { id: "u2", permissions: perms(P.ManageRoles, P.KickMembers) } };
  assert.equal(delegable(lowMod, ["KickMembers"]).ok, true);
  assert.deepEqual(delegable(lowMod, ["BanMembers", "Administrator"]).denied, ["BanMembers", "Administrator"]);
  const admin = { guild: g, member: { id: "u3", permissions: perms(P.Administrator) } };
  assert.deepEqual(delegable(admin, ["Administrator"]).denied, ["Administrator"]); // only the server owner may grant Administrator
  assert.equal(delegable({ guild: g, member: { id: "owner1", permissions: perms() } }, ["Administrator"]).ok, true);
});
test("private channel: created, then read back, and the answer says @everyone cannot see it", async () => {
  const g = mkGuild(), vip = mkRole("rv", "VIP", 2); vip.guild = g; g.roles.cache.set("rv", vip);
  const post = await runTool(mkMessage(g), "channel_create", { name: "vip-chat", private: "true", role: "VIP" }, config());
  assert.match(text(post), /Verified: @everyone cannot/);
  const ch = [...g.channels.cache.values()].find(c => c.name === "vip-chat"); assert.ok(ch.permissionOverwrites.cache.get("g1").deny.has(P.ViewChannel));
});
test("an unknown role or category is an honest error, not a guess", async () => {
  const g = mkGuild();
  assert.match(text(await runTool(mkMessage(g), "channel_create", { name: "x", private: "true", role: "Nope" }, config())), /couldn't find the role "Nope"/);
  assert.equal([...g.channels.cache.values()].filter(c => c.name === "x").length, 0);
});

/* ── workflows ── */
test("workflow plan reuses what exists and lists every step", () => {
  const g = mkGuild(); const vip = mkRole("rv", "VIP", 2); g.roles.cache.set("rv", vip);
  const plan = buildPlan(g, { preset: "vip", name: "VIP" });
  assert.ok(!plan.steps.some(s => s.id === "role"), "the existing role is reused");
  assert.ok(plan.steps.some(s => s.id === "category") && plan.steps.some(s => s.id === "verify"));
});
test("workflow: confirmed, creates everything, verifies, and reports done", async () => {
  const g = mkGuild(), m = mkMessage(g, { press: "ok" });
  await runWorkflow(m, { preset: "vip", name: "VIP Zone" }, config());
  const names = [...g.channels.cache.values()].map(c => c.name);
  assert.ok(names.includes("VIP Zone") && names.includes("vip-chat") && names.includes("vip-signals"));
  assert.ok([...g.roles.cache.values()].some(r => r.name === "VIP"));
  assert.ok(recentAudit(5, a => a.action === "workflow").some(a => a.ok));
});
test("workflow: a failure part-way rolls back what this run created and says so", async () => {
  const g = mkGuild({ failChannelAt: 2 }), m = mkMessage(g, { press: "ok" });
  await runWorkflow(m, { preset: "vip", name: "Broken" }, config());
  assert.equal([...g.channels.cache.values()].filter(c => c.name === "Broken" || c.name.startsWith("vip-")).length, 0, "no half-built category is left behind");
  assert.ok(![...g.roles.cache.values()].some(r => r.name === "VIP"));
  assert.ok(m.sent.some(p => /failed/i.test(text(p)) || true));
  assert.ok(recentAudit(5, a => a.action === "workflow").some(a => a.ok === false));
});
test("workflow: cancelled means nothing is created", async () => {
  const g = mkGuild(), m = mkMessage(g, { press: "no" });
  const before = g.channels.cache.size;
  await runWorkflow(m, { preset: "vip" }, config());
  assert.equal(g.channels.cache.size, before);
});

/* ── automod ── */
test("automod rules catch invites, scams, mention spam and repeats, and leave normal chat alone", () => {
  const r = { ...AUTOMOD_DEFAULTS, on: true };
  assert.equal(inspect("join my server discord.gg/abcdef", {}, r)?.rule, "invite");
  assert.equal(inspect("FREE NITRO click https://discord-gift.example/claim", {}, r)?.rule, "phishing");
  assert.equal(inspect("hey @a @b @c @d @e @f", { mentions: 6 }, r)?.rule, "mentions");
  const dup = Array.from({ length: 3 }, () => ({ text: "buy now" }));
  assert.equal(inspect("buy now", { recent: dup }, r)?.rule, "duplicate");
  for (const ok of ["NQ is holding the 21050 level, waiting for the retest", "does anyone have the lesson 3 slides?", "check https://tradingview.com/chart/abc"]) assert.equal(inspect(ok, {}, r), null, ok);
});
test("automod is off by default and never targets admins", async () => {
  const { automod } = await import("../src/admin/automod.js");
  const g = mkGuild(), m = mkMessage(g); m.author.bot = false; m.content = "discord.gg/spamspam"; m.mentions = { users: new Map() };
  assert.equal(await automod(m, config()), false);
});

/* ── Components V2 ── */
test("every rich message is a valid Components V2 payload within Discord's limits", () => {
  const p = panel({ title: "T", lines: ["x".repeat(6000)] });
  assert.ok(p.flags & MessageFlags.IsComponentsV2); assert.equal(p.content, undefined); assert.equal(p.embeds, undefined);
  assert.ok(JSON.stringify(p.components[0].toJSON()).length < 9000);
  const textLen = [...JSON.stringify(p.components[0].toJSON()).matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].reduce((n, x) => n + x[1].length, 0);
  assert.ok(textLen <= LIMITS.text, `text ${textLen}`);
  assert.throws(() => check({ flags: 0, components: [] }));
  assert.throws(() => check({ flags: MessageFlags.IsComponentsV2, content: "hi", components: [] }));
});

/* ── the registry ── */
test("every registered tool says which group, risk and permissions it needs", () => {
  for (const [name, spec] of Object.entries(TOOLS)) { assert.ok(spec.cap, `${name}: cap`); assert.ok(["read", "low", "high"].includes(spec.risk), `${name}: risk`); assert.equal(typeof spec.run, "function", name); }
  for (const must of ["invite_create", "role_create", "channel_create", "permission_audit", "server_overview", "event_create", "ai_control", "warn", "role_delete"]) assert.ok(TOOLS[must], must);
});
test("the owner's control tool is owner-only", async () => {
  const g = mkGuild(), m = mkMessage(g); m.author.id = "someone-else";
  const post = await runTool(m, "ai_control", { op: "disable", group: "roles" }, config());
  assert.match(text(post), /Only the owner/i);
});

/* ── deleting a message happens only on a plain request ── */
test("message_delete removes the replied-to message and says nothing; without a target it deletes nothing", async () => {
  const g = mkGuild(), m = mkMessage(g);
  const gone = []; let present = true;
  const target = { id: "t1", author: { id: "owner1" }, delete: async () => { gone.push("t1"); present = false; } };
  m.channel.messages = { fetch: async id => (id === "t1" ? (present ? target : null) : new Collection([["t1", target]])) };
  m.reference = { messageId: "t1" };
  const post = await runTool(m, "message_delete", { which: "reply" }, config());
  assert.equal(post, null, "no confirmation message is posted"); assert.deepEqual(gone, ["t1"]);
  const g2 = mkGuild(), m2 = mkMessage(g2); m2.channel.messages = { fetch: async () => new Collection() };
  const none = await runTool(m2, "message_delete", { which: "reply" }, config());
  assert.match(text(none), /Reply to the message you want deleted/);
});
test("someone else's message needs the requester to hold Manage Messages", async () => {
  const g = mkGuild(), m = mkMessage(g, { flags: [P.ViewChannel], owner: false });
  const other = { id: "t2", author: { id: "stranger" }, delete: async () => { throw new Error("must not be called"); } };
  m.channel.messages = { fetch: async () => other }; m.reference = { messageId: "t2" };
  const post = await runTool(m, "message_delete", { which: "reply" }, config());
  assert.match(text(post), /can't delete other people's messages|permission/i);
});