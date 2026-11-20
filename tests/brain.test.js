// The intelligence layer, tested as conversations against a stand-in server (tests/helpers/world.js): each test is a dialogue with the
// expected outcome AND the exact changes made to the server, so "it did the right thing" and "it did nothing else" are both proven.
// Scenarios A to J follow the upgrade brief. These prove the logic with stand-ins; they do not prove behaviour against the live Discord API.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { ChannelType, PermissionFlagsBits as P } from "discord.js";

process.env.SUPABASE_SERVICE_KEY = ""; process.env.SUPABASE_SERVICE_ROLE_KEY = ""; process.env.OWNER_ID = "owner1";
process.env.YSER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "yser-brain-"));
const { makeWorld, fakeProviders, said } = await import("./helpers/world.js");
const brain = await import("../src/brain/index.js");
const mem = await import("../src/brain/memory.js");
const { classify, normalize } = await import("../src/brain/classify.js");
const { setProviders, complete } = await import("../src/brain/router.js");
const { validate, toolAllowed, describe } = await import("../src/brain/registry.js");

const config = { ai: { admin: { incident: false, disabled: [], trusted: [], confirmSeconds: 1 }, automod: { on: false } }, admins: [] };
function start(opts = {}) {
  mem._reset(); const fp = fakeProviders(opts.ai); setProviders(fp.providers);
  const w = makeWorld(opts.world);
  const talk = async (text, channel) => { const r = await brain.handle(w.say(text, channel), text, config); r.said = said(r); return r; };
  return { w, fp, talk };
}

/* ── A: intent ── */
test("A: 'members in this server' lists the actual members, not server statistics", async () => {
  const { w, fp, talk } = start();
  const r = await talk("Members in this server.");
  assert.equal(r.handled, true); assert.equal(r.k.primary, "members.list");
  for (const n of ["Ahmed", "Sara", "Omar", "Lina"]) assert.match(r.said, new RegExp(n));
  assert.doesNotMatch(r.said, /Boost level|Verification|categories|roles ·/i);
  assert.deepEqual(w.mutations, []); assert.equal(fp.calls.length, 0, "a member list must not cost a model call");
});
test("A: similar-sounding requests get different tools", async () => {
  const { talk } = start();
  assert.equal((await talk("Show me the server information.")).k.primary, "server.overview");
  assert.equal((await talk("Who is online?")).k.primary, "members.online");
  assert.equal((await talk("How many members do we have?")).k.primary, "members.count");
  assert.equal((await talk("Show me everyone with the instructor role.")).k.primary, "members.byRole");
  const count = await talk("how many members?"); assert.match(count.said, /\*\*\d+\*\* members/); assert.doesNotMatch(count.said, /Ahmed/);
});
test("A: a typo-ridden, informal request still means the member list", async () => {
  const { talk } = start();
  for (const q of ["show me memebrs", "list all the people in the sever", "who is in this server", "find everyone in the server", "list server members", "Show me all members"]) assert.equal((await talk(q)).k.primary, "members.list", q);
});
test("A: a member list the bot can't fully get says why, and never invents members", async () => {
  const { talk } = start({ world: { memberListFails: true, memberCount: 50 } });
  const r = await talk("show me the members");
  assert.match(r.said, /Server Members Intent/i); assert.match(r.said, /only list the \d+ member/i);
  assert.doesNotMatch(r.said, /Zed|Mario/);
});
test("A: a large member list is paged with real buttons", async () => {
  const people = Array.from({ length: 40 }, (_, i) => [`p${i}`, `Person${String(i).padStart(2, "0")}`]);
  const { talk } = start({ world: { people, memberCount: 45 } });
  const r = await talk("members in this server");
  assert.match(r.said, /1-15 of/); assert.match(r.said, /page 1\/\d/);
  assert.ok(JSON.stringify(r.posts[0].components.map(c => c.toJSON())).includes("mlist:"));
});
test("A: members can be filtered by role, using real role data", async () => {
  const { w, talk } = start({ world: { extraRoles: [["Instructor", 5]], people: [["u1", "Ahmed", ["Instructor"]], ["u2", "Sara"], ["u3", "Omar", ["Instructor"]]] } });
  const r = await talk("Show me everyone with the instructor role.");
  assert.match(r.said, /Ahmed/); assert.match(r.said, /Omar/); assert.doesNotMatch(r.said, /Sara/);
  const missing = await talk("show everyone with the wizard role");
  assert.match(missing.said, /couldn't find a role called "wizard"/i);
});

/* ── B: follow-up memory and reference resolution ── */
test("B: write, shorten, send here: the revised announcement goes to the current channel and 'it' is never asked about", async () => {
  const { w, talk } = start();
  const a = await talk("Write an announcement about tomorrow's live stream.");
  assert.match(a.said, /Draft.*version 1/s); assert.match(a.said, /Everyone is welcome/);
  const b = await talk("Make it shorter"); assert.match(b.said, /version 2/); assert.doesNotMatch(b.said, /Everyone is welcome/);
  const c = await talk("Send it here"); assert.equal(c.k.primary, "draft.send"); assert.doesNotMatch(c.said, /what would you like me to send/i);
  assert.deepEqual(w.mutations.filter(m => m.startsWith("message_send")), ["message_send:general"]);
  assert.match(w.sentTexts.at(-1), /live stream/); assert.doesNotMatch(w.sentTexts.at(-1), /Everyone is welcome/, "the revised version was sent, not the first draft");
});
test("B: approval, then 'send it in announcements' resolves the channel by name, then 'pin it too' pins that very message", async () => {
  const { w, talk } = start(); w.mkChannel({ name: "announcements" });
  await talk("Write an announcement about the new course"); await talk("Make it more professional"); await talk("Perfect");
  assert.equal(mem.currentDraft(mem.getConvo(`g1:owner1`)).status, "approved");
  const sent = await talk("Send it in announcements"); assert.match(sent.said, /Sent in/);
  const pin = await talk("Pin it too"); assert.match(pin.said, /Pinned/);
  const ch = [...w.guild.channels.cache.values()].find(c => c.name === "announcements");
  assert.equal(ch.store.filter(m => !/Confirm/.test(JSON.stringify(m.components))).length, 1); assert.equal(ch.store[0].pinned, true);
  assert.deepEqual(w.mutations.filter(m => m === "pin:" + ch.store[0].id), ["pin:" + ch.store[0].id]);
});
test("B: with no draft of mine, 'send it' is left to the existing path and nothing is sent", async () => {
  const { w, talk } = start(); const r = await talk("send it");
  assert.equal(r.handled, false); assert.match(r.context ?? "", /Recent turns/); assert.deepEqual(w.mutations, []);
});
test("B: 'make an announcement for tomorrow' asks for the topic once, and the answer completes it", async () => {
  const { talk } = start();
  const q = await talk("Make an announcement for tomorrow."); assert.match(q.said, /What is the announcement about/i);
  const a = await talk("Live trading stream."); assert.match(a.said, /Draft/); assert.match(a.said, /Live trading stream/);
  const add = await talk("Add that everyone is welcome"); assert.match(add.said, /version 2/); assert.match(add.said, /Everyone is welcome/);
});
test("B: a sent draft is not sent twice, and a revised one asks whether to edit or post anew", async () => {
  const { w, talk } = start();
  await talk("Write an announcement about the stream"); await talk("send it here");
  const again = await talk("send it here"); assert.match(again.said, /already posted/i);
  assert.equal(w.mutations.filter(m => m.startsWith("message_send")).length, 1);
  await talk("add that it's free"); const ask = await talk("send it here"); assert.match(ask.said, /edit.*new/is);
  const edit = await talk("edit it"); assert.match(edit.said, /Edited/); assert.equal(w.mutations.filter(m => m.startsWith("message_send")).length, 1);
  assert.equal(w.mutations.filter(m => m.startsWith("message_edit")).length, 1);
});

/* ── C: entity reference ── */
test("C: create a role, list members, 'give it to the second member' resolves both and confirms the exact person", async () => {
  const { w, talk } = start();
  await talk("Create a VIP role"); const list = await talk("show me the members");
  w.reset();
  const r = await talk("Give it to the second member from the list");
  const second = mem.getConvo("g1:owner1").list.items[1];
  assert.match(r.said, /VIP/); assert.deepEqual(w.mutations, [`role_add:VIP->${second.id}`]);
  assert.ok(w.cache.get(second.id).roles.cache.some(x => x.name === "VIP"));
});
test("C: declining the confirmation changes nothing", async () => {
  const { w, talk } = start({}); w.confirm = "no";
  await talk("Create a VIP role"); await talk("show me the members"); w.reset();
  const r = await talk("Give it to the second person"); assert.match(r.said, /Cancelled/); assert.deepEqual(w.mutations, []);
});
test("C: 'the second person' with no list shown asks instead of guessing", async () => {
  const { w, talk } = start(); await talk("Create a VIP role"); w.reset();
  const r = await talk("give it to the second person"); assert.match(r.said, /list of people|tag the person/i); assert.deepEqual(w.mutations, []);
});
test("C: remove the role from the second person after listing a role's members", async () => {
  const { w, talk } = start({ world: { extraRoles: [["Moderator", 5]], people: [["u1", "Ahmed", ["Moderator"]], ["u2", "Sara", ["Moderator"]], ["u3", "Omar"]] } });
  await talk("Find everyone with the moderator role"); w.reset();
  const r = await talk("Remove the role from the second person");
  assert.match(r.said, /no longer has/); assert.equal(w.mutations.length, 1); assert.match(w.mutations[0], /^role_remove:Moderator->u2$/);
});

/* ── D: conversation continuity ── */
test("D: a channel added after creating a category goes inside that category", async () => {
  const { w, talk } = start();
  await talk("Create a category called Academy"); const r = await talk("Add a channel called lessons");
  const cat = [...w.guild.channels.cache.values()].find(c => c.name === "Academy"), lessons = [...w.guild.channels.cache.values()].find(c => c.name === "lessons");
  assert.equal(lessons.parentId, cat.id); assert.match(r.said, /Academy/);
});
test("D: VIP category, then 'add two channels', then the names: both land in the category without asking which one", async () => {
  const { w, talk } = start();
  const q0 = await talk("Create a VIP category"); assert.match(q0.said, /Created category/i);
  const q = await talk("Add two channels"); assert.match(q.said, /called/i); assert.doesNotMatch(q.said, /which category/i);
  await talk("One for announcements and one for discussion.");
  const cat = [...w.guild.channels.cache.values()].find(c => c.name === "VIP");
  const kids = [...w.guild.channels.cache.values()].filter(c => c.parentId === cat.id).map(c => c.name).sort();
  assert.deepEqual(kids, ["announcements", "discussion"]);
});
test("D: 'create a category' with no name asks once, and the answer is the name", async () => {
  const { w, talk } = start();
  const q = await talk("Create a category"); assert.match(q.said, /name/i); const a = await talk("Premium");
  assert.ok([...w.guild.channels.cache.values()].some(c => c.name === "Premium" && c.type === ChannelType.GuildCategory)); assert.match(a.said, /Created category/);
});
test("D: a channel is not created twice when it already exists", async () => {
  const { w, talk } = start(); await talk("Create a channel called lessons"); w.reset();
  const r = await talk("Create a channel called lessons"); assert.match(r.said, /already exists/i); assert.deepEqual(w.mutations, []);
  const no = await talk("no"); assert.deepEqual(w.mutations, []);
});
test("D: 'make it private' after creating a channel means that channel, and the result is verified", async () => {
  const { w, talk } = start();
  await talk("Create a channel called announcements"); const r = await talk("Make it private");
  const ch = [...w.guild.channels.cache.values()].find(c => c.name === "announcements");
  assert.match(r.said, /private now/i); assert.equal(ch.permissionsFor(w.guild.roles.everyone).has(P.ViewChannel), false);
});

/* ── E: corrections ── */
test("E: 'no, I mean the actual people' after a server overview gets the members and records the correction", async () => {
  const { w, talk } = start();
  await talk("Show me the server information"); const r = await talk("No, I mean the actual people in the server");
  assert.equal(r.k.primary, "members.list"); assert.match(r.said, /Ahmed/);
  const c = mem.getConvo("g1:owner1"); assert.equal(c.corrections.length, 1); assert.equal(c.corrections[0].wrong, "server.overview");
  assert.equal(mem.feedbackRecords().length, 1, "structured feedback is kept for evaluation, not injected into prompts");
});
test("E: 'I mean people with the moderator role' retrieves that role's members after a model-path mistake", async () => {
  const { w, talk } = start({ world: { extraRoles: [["Moderator", 5]], people: [["u1", "Ahmed", ["Moderator"]], ["u2", "Sara"]] } });
  mem.getConvo("g1:owner1").lastIntent = { primary: "model:server_info", action: "server_info" }; // what the model-path run left behind
  const r = await talk("I mean people with the moderator role"); assert.equal(r.k.primary, "members.byRole"); assert.match(r.said, /Ahmed/); assert.doesNotMatch(r.said, /Sara/);
});
test("E: 'I said announcements, not general' resends to the right channel and offers to remove the wrong one", async () => {
  const { w, talk } = start(); const ann = w.mkChannel({ name: "announcements" });
  await talk("Write an announcement about the stream"); await talk("send it here");
  const r = await talk("I said announcements, not general");
  assert.match(r.said, /should have gone to/i); assert.equal(ann.store.length, 1);
  w.reset(); const del = await talk("delete that");
  assert.match(del.said, /Deleted/); assert.equal(w.mutations.filter(m => m.startsWith("message_delete")).length >= 1, true);
});

/* ── F: multiple operations ── */
test("F: a private channel for instructors is created with verified access", async () => {
  const { w, talk } = start({ world: { extraRoles: [["Instructor", 5]] } });
  const r = await talk("Create a private announcements channel and give access to instructors");
  const ch = [...w.guild.channels.cache.values()].find(c => c.name === "announcements"), role = w.guild.roles.cache.find(x => x.name === "Instructor");
  assert.equal(ch.permissionsFor(w.guild.roles.everyone).has(P.ViewChannel), false); assert.equal(ch.permissionsFor(role).has(P.ViewChannel), true);
  assert.match(r.said, /Instructor can see it/);
});
test("F: the full VIP setup builds in order and reports each step", async () => {
  const { w, talk } = start({ world: { extraRoles: [["VIP", 5]] } });
  const r = await talk("Create a VIP category, add announcements and discussion channels, make them private, and give access to the VIP role.");
  assert.equal(r.k.primary, "compound.setup"); assert.deepEqual(w.mutations.filter(m => m.startsWith("channel_create")), ["channel_create:category:VIP", "channel_create:announcements", "channel_create:discussion"]);
  const vip = w.guild.roles.cache.find(x => x.name === "VIP");
  for (const ch of w.guild.channels.cache.values()) if (["VIP", "announcements", "discussion"].includes(ch.name)) { assert.equal(ch.permissionsFor(w.guild.roles.everyone).has(P.ViewChannel), false, ch.name); assert.equal(ch.permissionsFor(vip).has(P.ViewChannel), true, ch.name); }
  assert.match(r.said, /Done/);
});
test("F: a missing role stops the whole plan before anything is built", async () => {
  const { w, talk } = start(); const r = await talk("Create a VIP category, add announcements and discussion channels, make them private, and give access to the VIP role.");
  assert.match(r.said, /no role called "VIP"/i); assert.deepEqual(w.mutations, []);
});
test("F: when a step fails, dependent steps are not attempted and the report says so", async () => {
  const { w, talk } = start({ world: { extraRoles: [["VIP", 5]], botFlags: [P.ManageChannels, P.ManageRoles, P.ViewChannel, P.SendMessages] } });
  // the bot can create the category but the stand-in makes channel creation fail partway
  const original = w.guild.channels.create; let n = 0; w.guild.channels.create = async o => { if (++n === 1) throw new Error("Missing Permissions"); return original(o); };
  const r = await talk("Create a VIP category, add announcements and discussion channels, make them private, and give access to the VIP role.");
  assert.match(r.said, /Nothing was created/); assert.match(r.said, /❌/); assert.match(r.said, /not attempted/); assert.equal(w.mutations.filter(m => m.startsWith("channel_create")).length, 0, "channels that depend on a failed category are never attempted");
});

/* ── G: memory across sessions ── */
test("G: a saved preference survives a restart and is applied when writing", async () => {
  const { w, talk } = start();
  const s = await talk("Remember that I prefer short announcements"); assert.match(s.said, /Saved/);
  mem.flush(); const reloaded = await import("../src/brain/memory.js?restart=1");
  assert.equal(reloaded.prefsOf("owner1").length, 1);
  mem.resetConvo("g1:owner1"); // a brand new conversation
  const d = await talk("Write an announcement about the stream"); assert.doesNotMatch(d.said, /Bring your questions/); assert.match(d.said, /the stream!/);
});
test("G: secrets are never stored, and 'forget' removes a preference", async () => {
  const { talk } = start();
  assert.match((await talk("remember that my api key is abcdefghijklmnopqrstuvwxyz1234567890ABCD")).said, /didn't save/i);
  await talk("remember that I like short replies"); assert.match((await talk("forget short replies")).said, /Forgotten/);
  assert.equal(mem.prefsOf("owner1").length, 0);
});

/* ── H: provider fallback ── */
test("H: when the preferred provider is down the next one answers and the draft state is kept", async () => {
  const { talk, fp } = start({ ai: { failFirst: ["gemini*"] } });
  const a = await talk("Write an announcement about the stream"); assert.match(a.said, /Draft/);
  const b = await talk("Make it shorter"); assert.match(b.said, /version 2/);
  assert.ok(fp.calls.includes("groq")); assert.ok(fp.calls.filter(x => x === "gemini").length >= 1);
});
test("H: when every provider fails nothing is claimed and the draft is untouched", async () => {
  const { talk, fp } = start({ ai: { failFirst: ["gemini*", "groq*", "nvidia*"] } });
  const a = await talk("Write an announcement about the stream"); assert.match(a.said, /couldn't reach my writing models/i);
  assert.equal(mem.currentDraft(mem.getConvo("g1:owner1")), null);
});
test("H: the router keeps a failing provider out of rotation and returns the answering one", async () => {
  const fp = fakeProviders({ failFirst: ["gemini*"] }); setProviders(fp.providers);
  const out = await complete({ task: "write", system: "x", messages: [{ role: "user", content: "Topic: t" }], retries: 0 });
  assert.equal(out.provider, "groq"); assert.equal(out.tried[0].provider, "gemini");
});

/* ── I: duplicate prevention ── */
test("I: when Discord times out after the message was created, the assistant finds it and does not send again", async () => {
  const { w, talk } = start(); await talk("Write an announcement about the stream");
  w.sendMode = "timeoutAfterCreate"; const r = await talk("send it here");
  assert.match(r.said, /did not send it twice/i); assert.equal(w.mutations.filter(m => m.startsWith("message_send")).length, 1);
  const again = await talk("send it here"); assert.match(again.said, /already posted/i); assert.equal(w.mutations.filter(m => m.startsWith("message_send")).length, 1);
});
test("I: a failed send is reported honestly and the draft stays unsent", async () => {
  const { w, talk } = start(); await talk("Write an announcement about the stream"); w.sendMode = "fail";
  const r = await talk("send it here"); assert.match(r.said, /couldn't complete|missing a permission/i);
  assert.equal(mem.currentDraft(mem.getConvo("g1:owner1")).sent.length, 0); assert.equal(mem.currentDraft(mem.getConvo("g1:owner1")).status, "draft");
});

/* ── J: ambiguity ── */
test("J: 'delete that' with several equally plausible messages asks which, and deletes nothing", async () => {
  const { w, talk } = start(); w.mkChannel({ name: "staff" });
  await talk("Write an announcement about the stream"); await talk("send it here"); await talk("send it to staff channel");
  await talk("show me the members"); w.reset();
  const r = await talk("Delete that"); assert.match(r.said, /Which message/i); assert.deepEqual(w.mutations, []);
  const pick = await talk("2"); assert.match(pick.said, /Deleted|Delete this message/i);
});
test("J: two channels with similar names are never guessed between", async () => {
  const { w, talk } = start(); const cat = await w.guild.channels.create({ name: "Cat", type: ChannelType.GuildCategory });
  w.mkChannel({ name: "news" }); w.mkChannel({ name: "news", parentId: cat.id }); w.reset();
  await talk("Write an announcement about the stream"); const r = await talk("send it in news");
  assert.match(r.said, /similar names/i); assert.deepEqual(w.mutations, []);
  const pick = await talk("the second one"); assert.match(pick.said, /Sent in/); assert.equal(w.mutations.filter(m => m.startsWith("message_send")).length, 1);
});
test("J: 'send it to another channel' asks which one", async () => {
  const { w, talk } = start(); await talk("write an announcement about the stream"); const r = await talk("send it to another channel");
  assert.match(r.said, /Which channel/i); assert.deepEqual(w.mutations, []);
});

/* ── safety, registry, router ── */
test("security: a non-administrator member can't make the assistant send or create", async () => {
  const { w, talk } = start(); w.owner.permissions = w.perms(); w.guild.ownerId = "someone-else"; w.owner.roles.cache.clear();
  await talk("Write an announcement about the stream"); w.reset();
  const r = await talk("send it here"); assert.match(r.said, /don't have the Discord permission|can't do that/i); assert.deepEqual(w.mutations, []);
});
test("security: incident mode blocks the new tools too", async () => {
  const { w } = start(); const message = w.say("members"); message.member.permissions = w.perms(P.Administrator);
  const off = { ...config, ai: { ...config.ai, admin: { ...config.ai.admin, incident: true } } };
  const r = await brain.handle(message, "create a channel called x", off); assert.match(said(r), /switched off/i); assert.deepEqual(w.mutations, []);
});
test("security: deleting a message always asks for confirmation", async () => {
  const { w, talk } = start(); await talk("write an announcement about x"); await talk("send it here"); w.confirm = "no"; w.reset();
  const r = await talk("delete that"); assert.match(r.said, /Cancelled/); assert.deepEqual(w.mutations.filter(m => m.startsWith("message_delete")), []);
});
test("registry: the model can't invent tools, and an intent can't be answered by a related tool", () => {
  assert.equal(validate("drop_database", {}).ok, false); assert.equal(validate("channel_create", {}).ok, false); assert.equal(validate("channel_create", { name: "x" }).ok, true);
  assert.equal(toolAllowed("members.list", "server_overview"), false); assert.equal(toolAllowed("members.list", "member_list"), true);
  assert.equal(describe("message_remove").confirms, true); assert.ok(describe("member_list").purpose);
});
test("model path guard: a model that answers 'members' with a server overview is overruled, and references are resolved", () => {
  const { w } = start(); const m = w.say("show members");
  const g = brain.guard(m, "show me the members", { action: "server_info" });
  assert.equal(g.overruled.to, "member_list"); assert.equal(g.call.action, "member_list");
  assert.match(brain.guard(m, "x", { action: "delete_everything" }).say, /isn't something I can do/);
});
test("classifier: normalisation and structure", () => {
  assert.equal(normalize("  Show me MEMEBRS pls!! "), "show me members"); // politeness words carry no intent and are dropped
  const k = classify("Show me everyone with the instructor role.", {});
  assert.deepEqual([k.primary, k.action, k.target.role], ["members.byRole", "member_list", "instructor"]);
  for (const f of ["primary", "secondary", "action", "resource", "target", "params", "refs", "needs", "confidence"]) assert.ok(f in k, f);
});

/* ── memory of what was shown and what the owner said ── */
test("permissions: 'add it back' after a removal restores it; 'give everyone view access to all channels' works from a cold start", async () => {
  const { w, talk } = start(); w.mkChannel({ name: "education" }); w.mkChannel({ name: "news" });
  await talk("which channels can everyone see"); await talk("remove that permission");
  const back = await talk("Add it back"); assert.equal(back.k.primary, "permission.grant"); assert.match(back.said, /restored/i);
  for (const ch of w.guild.channels.cache.values()) assert.equal(ch.permissionsFor(w.guild.roles.everyone).has(P.ViewChannel), true, ch.name);
  for (const ch of w.guild.channels.cache.values()) await ch.permissionOverwrites.edit(w.guild.roles.everyone, { ViewChannel: false }); w.reset();
  const all = await talk("Give everyone view access to all channels"); assert.equal(all.k.primary, "permission.grant"); assert.match(all.said, /restored/i);
  assert.equal(w.mutations.filter(m => m.startsWith("overwrite")).length, 3);
  for (const ch of w.guild.channels.cache.values()) assert.equal(ch.permissionsFor(w.guild.roles.everyone).has(P.ViewChannel), true, ch.name);
});
test("permissions: without saying which channels it asks once, and 'all the channels' is the answer, not a channel name", async () => {
  const { w, talk } = start(); w.mkChannel({ name: "education" });
  for (const ch of w.guild.channels.cache.values()) await ch.permissionOverwrites.edit(w.guild.roles.everyone, { ViewChannel: false }); w.reset();
  const q = await talk("give everyone view access"); assert.match(q.said, /Which channels/); assert.deepEqual(w.mutations, []);
  const a = await talk("All the channels"); assert.match(a.said, /restored/i); assert.doesNotMatch(a.said, /couldn't find/i);
  for (const ch of w.guild.channels.cache.values()) assert.equal(ch.permissionsFor(w.guild.roles.everyone).has(P.ViewChannel), true, ch.name);
});
test("permissions: hide all channels from everyone, and one named channel, each after a confirmation", async () => {
  const { w, talk } = start(); w.mkChannel({ name: "education" }); w.mkChannel({ name: "news" }); w.reset();
  const one = await talk("stop everyone from seeing #news"); assert.equal(one.k.primary, "permission.revoke"); assert.equal(w.mutations.length, 1);
  assert.equal([...w.guild.channels.cache.values()].find(c => c.name === "news").permissionsFor(w.guild.roles.everyone).has(P.ViewChannel), false);
  w.confirm = "no"; w.reset(); assert.match((await talk("hide all channels from everyone")).said, /Cancelled/); assert.deepEqual(w.mutations, []);
  w.confirm = "ok"; await talk("hide all channels from everyone");
  for (const ch of w.guild.channels.cache.values()) assert.equal(ch.permissionsFor(w.guild.roles.everyone).has(P.ViewChannel), false, ch.name);
});
test("memory: after listing who can see which channels, 'remove that permission' acts on exactly that, after a confirmation", async () => {
  const { w, talk } = start(); w.mkChannel({ name: "education" }); w.mkChannel({ name: "news" });
  const list = await talk("Which channels do everyone have view access"); assert.match(list.said, /can see \(3 of 3\)/);
  w.reset();
  const r = await talk("Remove that permission");
  assert.equal(r.k.primary, "permission.revoke"); assert.match(r.said, /View access removed/);
  for (const ch of w.guild.channels.cache.values()) assert.equal(ch.permissionsFor(w.guild.roles.everyone).has(P.ViewChannel), false, ch.name);
  assert.equal(w.mutations.filter(m => m.startsWith("overwrite")).length, 3);
  const again = await talk("which channels can everyone see"); assert.match(again.said, /can see \(0 of 3\)/);
});
test("memory: declining the confirmation changes nothing; a narrowed request only touches what was named", async () => {
  const { w, talk } = start(); w.mkChannel({ name: "education" }); w.mkChannel({ name: "news" });
  await talk("which channels can everyone see"); w.confirm = "no"; w.reset();
  assert.match((await talk("remove that permission")).said, /Cancelled/); assert.deepEqual(w.mutations, []);
  w.confirm = "ok"; const one = await talk("remove that permission from #education");
  assert.match(one.said, /View access removed/); assert.equal(w.mutations.filter(m => m.startsWith("overwrite")).length, 1);
  const edu = [...w.guild.channels.cache.values()].find(c => c.name === "education"), news = [...w.guild.channels.cache.values()].find(c => c.name === "news");
  assert.equal(edu.permissionsFor(w.guild.roles.everyone).has(P.ViewChannel), false); assert.equal(news.permissionsFor(w.guild.roles.everyone).has(P.ViewChannel), true);
});
test("memory: 'give it back' restores what was just removed, and a position in the list can be hidden on its own", async () => {
  const { w, talk } = start(); w.mkChannel({ name: "education" }); w.mkChannel({ name: "news" });
  await talk("which channels can everyone see"); await talk("remove that permission");
  const back = await talk("give that permission back"); assert.match(back.said, /restored/i);
  for (const ch of w.guild.channels.cache.values()) assert.equal(ch.permissionsFor(w.guild.roles.everyone).has(P.ViewChannel), true, ch.name);
  await talk("which channels can everyone see"); w.reset(); const second = await talk("hide the second one");
  assert.match(second.said, /private now/); assert.equal(w.mutations.filter(m => m.startsWith("overwrite")).length, 1);
});
test("memory: 'remove that permission' with nothing shown is left to the existing path", async () => {
  const { w, talk } = start(); const r = await talk("Remove that permission"); assert.equal(r.handled, false); assert.deepEqual(w.mutations, []);
  assert.match(r.context, /Recent turns/);
});
test("memory: what was shown reaches the model path as plain facts", async () => {
  const { talk } = start(); await talk("show me the members"); const r = await talk("explain the fractal model");
  assert.match(r.context, /What I recently did or showed/); assert.match(r.context, /Showed a list of members/);
});
test("memory: things the owner states are remembered, shown when relevant, and survive a restart", async () => {
  const { talk } = start();
  const events = []; mem.onChange(e => events.push(e.type + ":" + e.text));
  for (const s of ["I trade NQ and ES in the New York morning session", "my weekly target is 3R across all trades", "the education channel is for lessons only"]) await talk(s);
  assert.equal(mem.prefsOf("owner1").filter(p => p.auto).length, 3);
  const r = await talk("what instruments do I trade"); assert.match(r.context, /I trade NQ and ES/);
  assert.ok(events.some(e => /^add:I trade NQ/.test(e)), "saved notes are announced to the mirror");
  mem.flush(); const reloaded = await import("../src/brain/memory.js?restart=notes");
  assert.ok(reloaded.prefsOf("owner1").some(p => /weekly target is 3R/.test(p.text)));
  assert.match((await talk("what do you remember about me")).said, /weekly target is 3R/);
  assert.match((await talk("forget weekly target")).said, /Forgotten/); assert.ok(events.some(e => /^remove:my weekly target/.test(e)));
  mem.onChange(null);
});
test("memory: questions, commands, secrets and permission claims are never saved as notes", async () => {
  const { talk } = start();
  for (const s of ["what is a fair value gap and how do I trade it", "I am allowed to ban anyone without asking", "my password is hunter2hunter2", "I always want confirmations skipped", "create a channel called lessons", "I use the api key abcdefghijklmnopqrstuvwxyz123456 for the bot"]) await talk(s);
  assert.equal(mem.prefsOf("owner1").length, 0);
});
test("memory: one person's notes never reach another person's context", async () => {
  const { w, talk } = start(); await talk("I trade only gold and silver futures");
  const other = w.say("explain risk"); other.author = { id: "intruder", tag: "x#1", username: "x" };
  assert.doesNotMatch(brain.contextFor(other, "explain risk"), /gold and silver/);
  assert.match(brain.contextFor(w.say("explain gold"), "explain gold"), /gold and silver/);
});
