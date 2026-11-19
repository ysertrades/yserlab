// The embed flow from the owner's real conversation: "make an embed announcing a giveaway starting tomorrow", then "change embed colour to dark",
// "make it an embed with dark colour not purple", then "post in #lab". Each must act on the embed just made, in place, without questions or invented facts.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Collection, ChannelType, MessageFlags, PermissionFlagsBits as P, PermissionsBitField } from "discord.js";

process.env.SUPABASE_SERVICE_KEY = ""; process.env.SUPABASE_SERVICE_ROLE_KEY = ""; process.env.YSER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "yser-embeds-"));
const { colourOf, embedIntent, guardFacts, compose, useWriter, handleEmbed, embedPost, draftOf, forgetDrafts } = await import("../src/admin/embeds.js");

const accentOf = post => post.components[0].toJSON().accent_color;
const textOf = post => JSON.stringify(post.components[0].toJSON());

test("colour: understands names, hex, and ignores the colour that is ruled out", () => {
  assert.equal(colourOf("Change embed colour to dark"), "#2b2d31");
  assert.equal(colourOf("Make it an embed worth dark colour not purple"), "#2b2d31");
  assert.equal(colourOf("make it blue"), "#3d5afe");
  assert.equal(colourOf("use #ff0000 for it"), "#ff0000");
  assert.equal(colourOf("not purple, black please"), "#0b0c0e");
  assert.equal(colourOf("make it shorter"), null);
});
test("intent: the follow-ups in the screenshots act on the embed; without an embed they do not", () => {
  assert.equal(embedIntent("Make for me an embed of announcing a giveaway starting tomorrow", false).op, "create");
  assert.equal(embedIntent("Change embed colour to dark", true).op, "colour");
  assert.equal(embedIntent("Make it an embed worth dark colour not purple", true).colour, "#2b2d31");
  assert.equal(embedIntent("Post in <#123456789012345678>", true).op, "repost");
  assert.equal(embedIntent("Post in <#123456789012345678>", true).channel, "123456789012345678");
  assert.equal(embedIntent("post it in yser-lab", true).name, "yser-lab");
  assert.equal(embedIntent("make it shorter", true).op, "edit");
  assert.equal(embedIntent("change the title to Giveaway Friday", true).op, "edit");
  assert.equal(embedIntent("make it shorter", false), null);
  assert.equal(embedIntent("give me an invite link", true), null);
  assert.equal(embedIntent("create a role called VIP", true), null);
});
test("nothing is invented: prizes, handles, placeholders and clichés are removed unless the request said them", () => {
  const written = "Giveaway starts Thursday, November 19\n1st place – $200 USD\n3. Share it and tag @YourServer\nPrize: [add your prize]\nGood luck, and may the odds be ever in your favor!\nStay tuned for the details.";
  const out = guardFacts(written, "announce a giveaway starting tomorrow");
  assert.equal(out, "Giveaway starts Thursday, November 19\nStay tuned for the details.");
  assert.match(guardFacts("Prize: $50 gift card", "giveaway with a $50 gift card"), /\$50/);
});
test("compose: uses the model's JSON, strips invented lines, and falls back honestly when no model answers", async () => {
  useWriter(async () => JSON.stringify({ title: "🎁 Giveaway starts tomorrow", body: "A new giveaway begins on **Thursday, November 19**.\n1st place – $200 USD\nStay tuned for how to enter." }));
  const d = await compose("make an embed announcing a giveaway starting tomorrow");
  assert.equal(d.title, "🎁 Giveaway starts tomorrow"); assert.ok(!/\$200/.test(d.body)); assert.match(d.body, /Thursday, November 19/);
  useWriter(async () => null);
  const f = await compose("Make for me an embed of announcing a giveaway starting tomorrow");
  assert.match(f.title, /giveaway starting tomorrow/i); assert.equal(f.body, "Details to follow.");
  assert.equal(await compose("make it shorter", { title: "T", body: "B" }), null, "an edit never invents a replacement when the model is down");
});

/* ── the whole conversation, against stand-in Discord objects ── */
function world() {
  const sent = [], edits = [];
  const mkChannel = (id, name) => ({ id, name, type: ChannelType.GuildText, isSendable: () => true, permissionsFor: () => new PermissionsBitField(P.Administrator), sent: [],
    send: async function (payload) { const m = { id: `m${sent.length + 1}`, author: { id: "bot" }, payload, channel: this, delete: async () => {}, edit: async p => { edits.push({ id: m.id, p }); m.payload = { ...m.payload, ...p }; return m; } }; sent.push(m); this.sent.push(m); this.store ??= new Collection(); this.store.set(m.id, m); return m; },
    messages: { fetch: async function (id) { return world.channels.find(c => c.store?.has(id))?.store.get(id) ?? null; } } });
  const ai = mkChannel("c1", "yser-ai"), lab = mkChannel("c2", "yser-lab"); world.channels = [ai, lab];
  const guild = { id: "g1", channels: { cache: new Collection([["c1", ai], ["c2", lab]]) }, members: { me: { permissions: new PermissionsBitField(P.Administrator) } } };
  const message = text => ({ id: "u" + Math.random(), guild, channel: ai, author: { id: "owner" }, client: { user: { id: "bot" } }, content: text });
  return { ai, lab, sent, edits, message, guild };
}
test("the screenshot conversation: make it, recolour it twice in place, then post it in another channel", async () => {
  forgetDrafts();
  useWriter(async () => JSON.stringify({ title: "🎁 Giveaway starts tomorrow", body: "A new giveaway begins on **Thursday, November 19**.\nStay tuned for how to enter." }));
  const w = world(), cfg = { ai: {} };
  assert.equal(await handleEmbed(w.message("Make for me an embed of announcing a giveaway starting tomorrow"), "Make for me an embed of announcing a giveaway starting tomorrow", cfg), true);
  assert.equal(w.sent.length, 1, "one message, not a duplicate plain text plus an embed");
  const made = w.sent[0].payload; assert.ok(made.flags & MessageFlags.IsComponentsV2); assert.equal(made.content, undefined);
  assert.equal(accentOf(made), 0x8d9bff);
  assert.match(textOf(made), /Giveaway starts tomorrow/); assert.ok(!/\$\d|YourServer/.test(textOf(made)));

  await handleEmbed(w.message("Change embed colour to dark"), "Change embed colour to dark", cfg);
  assert.equal(w.sent.length, 1, "the colour change edits the embed, it does not post a new one");
  assert.equal(accentOf(w.sent[0].payload), 0x2b2d31); assert.match(textOf(w.sent[0].payload), /Giveaway starts tomorrow/, "its words are untouched");

  await handleEmbed(w.message("Make it an embed worth dark colour not purple"), "Make it an embed worth dark colour not purple", cfg);
  assert.equal(w.sent.length, 1); assert.equal(accentOf(w.sent[0].payload), 0x2b2d31);

  await handleEmbed(w.message("Post in <#c2>"), "Post in <#123456789012345678>", { ai: {} }); // an unknown id falls back to the current channel, which is refused honestly
  assert.equal(w.lab.sent.length, 0);
  const t = "post it in yser-lab";
  assert.equal(await handleEmbed(w.message(t), t, cfg), true);
  assert.equal(w.lab.sent.length, 1, "posted in the other channel"); assert.equal(accentOf(w.lab.sent[0].payload), 0x2b2d31, "with the dark colour");
  assert.match(textOf(w.lab.sent[0].payload), /Giveaway starts tomorrow/);
  assert.equal(draftOf(w.message("x")).channelId, "c2");
});
test("a text edit keeps the message and changes only what was asked", async () => {
  forgetDrafts();
  let call = 0;
  useWriter(async (system, prompt) => (++call === 1 ? JSON.stringify({ title: "Session tonight", body: "Live review at the New York open.\nBring your questions." }) : JSON.stringify({ title: "Session tonight", body: "Live review at the New York open." })));
  const w = world(), cfg = { ai: {} };
  await handleEmbed(w.message("announce a live session tonight"), "announce a live session tonight", cfg);
  await handleEmbed(w.message("make it shorter"), "make it shorter", cfg);
  assert.equal(w.sent.length, 1); assert.ok(!/Bring your questions/.test(textOf(w.sent[0].payload))); assert.match(textOf(w.sent[0].payload), /New York open/);
});
test("with the writing model down, an edit leaves the embed alone and says so; a new embed still gets made", async () => {
  forgetDrafts();
  useWriter(async () => null);
  const w = world(), cfg = { ai: {} };
  await handleEmbed(w.message("make an embed about the weekly review"), "make an embed about the weekly review", cfg);
  assert.equal(w.sent.length, 1);
  const before = textOf(w.sent[0].payload);
  await handleEmbed(w.message("make it shorter"), "make it shorter", cfg);
  assert.equal(textOf(w.sent[0].payload), before); assert.ok(w.ai.sent.some(m => /left the embed as it was/.test(m.payload.content ?? "")));
});
