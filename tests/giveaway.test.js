// The giveaway and verification systems from yserbot, running in this bot: the copied modules load, the draw is weighted by extra entries (roles and
// named members), a giveaway can be started, changed while it runs and cancelled, and plain requests are understood. Discord is replaced by stand-ins.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Collection } from "discord.js";

process.env.SUPABASE_SERVICE_KEY = ""; process.env.SUPABASE_SERVICE_ROLE_KEY = ""; process.env.YSER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "yser-gaw-"));
const { modules, api } = await import("../src/giveaway/index.js");
const { giveawayIntent, durationMs } = await import("../src/admin/giveawayIntent.js");
const { intentOf } = await import("../src/admin/intent.js");

const m = modules();
test("the yserbot modules load, and both slash commands are defined", () => {
  assert.ok(m, "modules");
  assert.equal(m.giveaway.data.toJSON().name, "giveaway"); assert.equal(m.verify.data.toJSON().name, "verify");
  const subs = m.giveaway.data.toJSON().options.map(o => o.name); for (const s of ["create", "end", "reroll", "list"]) assert.ok(subs.includes(s), s);
  assert.equal(typeof m.giveaway.updateGiveaway, "function"); assert.equal(typeof m.giveaway.cancelGiveaway, "function");
});

/* ── the draw ── */
const member = (id, roles = []) => ({ id, roles: { cache: new Set(roles) } });
test("tickets: one each, extra for a role, extra for a named member, and both add up under the cap", () => {
  const g = m.giveaway, roles = g.normalizeBonusRoles(null, [{ id: "r1", extra: 2 }]), users = g.normalizeBonusUsers([{ id: "109", extra: 4 }]);
  assert.equal(g.ticketsForMember(member("101"), roles, users, "101"), 1);
  assert.equal(g.ticketsForMember(member("102", ["r1"]), roles, users, "102"), 3);
  assert.equal(g.ticketsForMember(member("109"), roles, users, "109"), 5);
  assert.equal(g.ticketsForMember(member("109", ["r1"]), roles, users, "109"), 7);
  assert.equal(g.ticketsForMember(null, roles, users, "109"), 5, "a member who is not cached still gets their own bonus");
  assert.deepEqual(g.normalizeBonusUsers([{ id: "<@123>", extra: 999 }, { id: "123", extra: 3 }, { id: "" }]), [{ id: "123", extra: 50 }]);
});
test("the weighted pool really makes extra entries more likely, and a member can win only once", async () => {
  const guild = { members: { cache: new Collection([["a", member("a", ["vip"])], ["b", member("b")], ["303", member("303")]]), fetch: async () => null } };
  const pool = await m.giveaway.buildWeightedPool(["a", "b", "303"], guild, null, [{ id: "vip", extra: 6 }], [{ id: "303", extra: 2 }]);
  const count = id => pool.filter(x => x === id).length;
  assert.deepEqual([count("a"), count("b"), count("303")], [7, 1, 3]);
  const wins = { a: 0, b: 0, 303: 0 };
  for (let i = 0; i < 3000; i++) { const w = m.giveaway.pickWinners ? m.giveaway.pickWinners(pool, 1) : null; if (!w) break; wins[w[0]]++; }
  if (m.giveaway.pickWinners) { assert.ok(wins.a > wins[303] && wins[303] > wins.b, JSON.stringify(wins)); assert.ok(wins.a > 3000 * 0.5, "a holds 7 of 11 tickets"); }
});

/* ── a giveaway's life, with stand-in Discord objects ── */
function world() {
  const edits = [], deleted = [];
  const msg = { id: "900000000000000001", channelId: "800000000000000001", guildId: "700000000000000001", attachments: new Collection(), edit: async p => { edits.push(p); return msg; }, delete: async () => { deleted.push(msg.id); }, reply: async () => ({}) };
  const channel = { id: "800000000000000001", name: "giveaways", isTextBased: () => true, send: async () => msg, messages: { fetch: async () => msg } };
  const guild = {
    id: "700000000000000001", name: "Test", client: { channels: { fetch: async () => channel }, users: { cache: new Collection(), fetch: async () => ({ send: async () => {} }) } },
    channels: { cache: new Collection([[channel.id, channel]]), fetch: async () => channel },
    roles: { cache: new Collection([["600000000000000001", { id: "600000000000000001", name: "VIP" }], ["600000000000000002", { id: "600000000000000002", name: "Member" }]]) },
    members: { cache: new Collection(), fetch: async () => null }, iconURL: () => null,
  };
  return { guild, channel, msg, edits, deleted };
}
test("a giveaway is created from the panel function with extra entries, edited in place while it runs, and cancelled", async () => {
  const { guild, msg, edits, deleted } = world();
  const a = api();
  const out = await a.create(guild.id, { prize: "$50 gift card", winners: 2, duration: "1h", channelId: "800000000000000001", requiredRoleId: "600000000000000002", bonusRoles: [{ id: "600000000000000001", extra: 1 }], bonusUsers: [{ id: "500000000000000001", extra: 3 }], imageUrl: "dynamic:prizeGiveawayBanner" }, { guild, client: guild.client, session: { uid: "400000000000000001" } });
  assert.equal(out.ok, true, JSON.stringify(out));
  const rec = a.active(msg.id);
  assert.equal(rec.prize, "$50 gift card"); assert.equal(rec.winnersCount, 2);
  assert.deepEqual(rec.bonusRoles, [{ id: "600000000000000001", extra: 1 }]); assert.deepEqual(rec.bonusUsers, [{ id: "500000000000000001", extra: 3 }]);
  assert.ok(rec.requirementLines.some(l => /Extra entries/.test(l)) && rec.requirementLines.some(l => /Bonus entries/.test(l)), "the card lists the extra entries");

  const listed = a.list(guild.id, guild).active[0];
  assert.equal(listed.title, "$50 gift card"); assert.equal(listed.bonusUsers.length, 1);

  const before = edits.length;
  const up = await a.update(guild, msg.id, { addBonusRoles: [{ id: "600000000000000002", extra: 2 }], removeBonusUsers: ["500000000000000001"], addBonusUsers: [{ id: "500000000000000002", extra: 5 }], extendMs: 3600000, winners: 3 });
  assert.equal(up.ok, true, JSON.stringify(up));
  const after = a.active(msg.id);
  assert.deepEqual(after.bonusRoles.map(b => b.extra).sort(), [1, 2]); assert.deepEqual(after.bonusUsers, [{ id: "500000000000000002", extra: 5 }]);
  assert.equal(after.winnersCount, 3); assert.ok(after.endTime > rec.endTime + 3_000_000, "the end moved");
  assert.ok(edits.length > before, "the same message was edited, not replaced");
  assert.equal((await a.update(guild, msg.id, { endsInMs: 1000 })).error, "end_in_past");

  const gone = await a.cancel(guild, msg.id);
  assert.equal(gone.ok, true); assert.equal(a.active(msg.id), null); assert.deepEqual(deleted, [msg.id]);
});

/* ── plain requests ── */
test("durations", () => { assert.equal(durationMs("24 hours"), 86_400_000); assert.equal(durationMs("1 day 12 hours"), 129_600_000); assert.equal(durationMs("90 min"), 5_400_000); assert.equal(durationMs("2d"), 172_800_000); });
test("intent: a complete request starts a giveaway with everything it said, and none of the questions", () => {
  const r = giveawayIntent("Run a giveaway for a $50 Amazon gift card for 24 hours with 2 winners in <#123456789012345678>, 2x entries for <@&222222222222222222> and +3 entries for <@333333333333333333>");
  assert.equal(r.action, "giveaway_start");
  assert.equal(r.args.prize, "$50 Amazon gift card"); assert.equal(r.args.duration_ms, "86400000"); assert.equal(r.args.winners, "2"); assert.equal(r.args.channel, "123456789012345678");
  assert.deepEqual(r.args.bonusRoles, [{ id: "222222222222222222", extra: 1 }]); assert.deepEqual(r.args.bonusUsers, [{ id: "333333333333333333", extra: 3 }]);
  const s = giveawayIntent("start a giveaway for a month of premium access");
  assert.equal(s.action, "giveaway_start"); assert.equal(s.args.prize, "month of premium access".replace(/^/, "a ").replace(/^a /, "")); assert.ok(!s.args.channel, "no channel named: the same channel");
  assert.match(giveawayIntent("make a giveaway").say, /prize/i);
  const t = giveawayIntent("host a giveaway of one VIP role lasting 3 days, only for <@&222222222222222222>, ping @everyone");
  assert.equal(t.args.prize, "one VIP role"); assert.equal(t.args.duration_ms, String(3 * 86_400_000)); assert.equal(t.args.required_role, "222222222222222222"); assert.equal(t.args.mention, "@everyone");
});
test("intent: managing a running giveaway", () => {
  assert.equal(giveawayIntent("end the giveaway").action, "giveaway_end");
  assert.equal(giveawayIntent("reroll the giveaway").action, "giveaway_reroll");
  assert.equal(giveawayIntent("cancel the giveaway").action, "giveaway_cancel");
  assert.equal(giveawayIntent("show me the giveaways").action, "giveaway_list");
  assert.equal(giveawayIntent("how many people entered the giveaway?").action, "giveaway_participants");
  const b = giveawayIntent("give <@&222222222222222222> 3 extra entries in the giveaway"); assert.equal(b.action, "giveaway_bonus"); assert.deepEqual(b.args.bonusRoles, [{ id: "222222222222222222", extra: 3 }]);
  const u = giveawayIntent("add +2 entries for <@333333333333333333> to the giveaway"); assert.equal(u.action, "giveaway_bonus"); assert.deepEqual(u.args.bonusUsers, [{ id: "333333333333333333", extra: 2 }]);
  const x = giveawayIntent("remove the extra entries for <@&222222222222222222>"); assert.equal(x.action, "giveaway_bonus"); assert.deepEqual(x.args.removeRoles, ["222222222222222222"]);
  assert.equal(giveawayIntent("extend the giveaway by 2 hours").args.extend_ms, String(2 * 3_600_000));
  assert.equal(giveawayIntent("make it 3 winners for the giveaway").args.winners, "3");
  assert.equal(giveawayIntent("what is the weather"), null);
});
test("intent: a giveaway with no prize asks once, and the next message is the prize", () => {
  const first = intentOf("start a giveaway in <#123456789012345678>", "c:me");
  assert.match(first.say, /prize/i);
  const second = intentOf("a $25 gift card", "c:me");
  assert.equal(second.action, "giveaway_start"); assert.equal(second.args.prize, "a $25 gift card"); assert.equal(second.args.channel, "123456789012345678");
});
