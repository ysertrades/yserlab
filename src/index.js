import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from "discord.js";
import { env, missing } from "./env.js";
import { settings, log } from "./store.js";
import { isAdmin, mayUseAi } from "./access.js";
import { checkAlerts, checkSchedule } from "./calendar/news.js";
import { checkCards } from "./cards.js";
import { checkMilestones } from "./milestones.js";
import { checkSessions } from "./sessions.js";
import { checkJobs } from "./jobs.js";
import { heartbeat, offline } from "./status.js";
import * as picker from "./picker.js";
import { modelDoc } from "./ai.js";
import { askUnified, noteResult, channelContext, ensureLink, publishKnowledge } from "./assistant.js";
import { designDiagram, designSlides, isGenericSs, Clarify } from "./diagram.js";
import { cardOnRequest } from "./cards.js";
import { picturePost, galleryPost } from "./post.js";
import { fonts } from "./render.js";
import { moderate, sendFromApp, waiting } from "./mod.js";
import { automod } from "./admin/automod.js";
import { DANGEROUS, permNames } from "./admin/guard.js";
import { intentOf } from "./admin/intent.js";
import * as brain from "./brain/index.js";
import { handleEmbed } from "./admin/embeds.js";
import { remember } from "./people.js";
import { pollJuice, publishTrump } from "./feeds.js";
import { cancel, list as listJobs, schedule, tick as tickJobs } from "./sched.js";

const gaps = missing();
if (gaps.length) { console.error(`YSER Lab can't start. Missing on the host: ${gaps.join(", ")}`); process.exit(1); }
fonts();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
  allowedMentions: { parse: [], repliedUser: false },
});

/** A loop that never overlaps itself and never dies from one bad round. */
function every(ms, name, fn) {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { console.warn(`${name}:`, e?.message ?? e); }
    busy = false;
  }, ms);
}

client.once(Events.ClientReady, async () => {
  console.log(`YSER Lab ready as ${client.user.tag} in ${client.guilds.cache.size} server(s)`);
  await settings(true);
  // The old Journal bot registered slash commands; this bot has none, so they are removed.
  await client.application.commands.set([]).catch(() => {}); // clears /giveaway and /verify registered earlier
  await log("bot", { note: `online as ${client.user.tag}` });
  await heartbeat(client).catch(() => {});
  void ensureLink(); void publishKnowledge(); // the assistant function maps the owner's Discord id to the account and reads the education center from storage
  setInterval(() => void ensureLink(), 10 * 60_000);
  every(1_000, "alerts", async () => { const { config } = await settings(); if (!config.paused) { await checkAlerts(client, config); await checkSessions(client); } });
  every(15_000, "schedule", async () => { const { config } = await settings(); if (!config.paused) { await checkSchedule(client); await checkCards(client); } });
  every(120_000, "milestones", async () => { const { config } = await settings(); if (!config.paused) await checkMilestones(client); });
  every(4_000, "jobs", () => checkJobs(client));
  every(1_000, "later", () => tickJobs(client, runLater)); // what the owner asked to happen at a time or after a delay
  every(30_000, "status", () => heartbeat(client));
  every(3_000, "juice", () => pollJuice()); // FinancialJuice headlines for the app's live wire (a new one reaches the page within seconds)
  every(60_000, "trump", () => publishTrump()); // the White House schedule (does real work every 4 minutes)
});

const stripMention = (text, id) => text.replace(new RegExp(`<@!?${id}>`, "g"), "").trim();
const chunks = text => { const out = []; let rest = text; while (rest.length > 1900) { let cut = rest.lastIndexOf("\n", 1900); if (cut < 800) cut = 1900; out.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart(); } out.push(rest); return out; };

/** A scheduled job, run with the same code as when asked live; the context stands in for the message it was asked in. */
async function runLater(job) {
  const { config, owner } = await settings();
  if (config.paused) return null;
  const guild = await client.guilds.fetch(job.guildId).catch(() => null);
  const channel = await client.channels.fetch(job.channelId).catch(() => null);
  if (!guild || !channel) return null;
  const ctx = { __scheduled: true, client, guild, channel, channelId: channel.id, guildId: guild.id, id: undefined, author: { id: job.ownerId, tag: "the schedule" }, reference: null, mentions: { users: new Map(), channels: { first: () => null, values: () => [] } } };
  const post = job.kind === "mod" ? await moderate(ctx, job.args, config) : await sendFromApp(ctx, job.args, { owner, config });
  await log(job.kind === "mod" ? "mod" : "send", { note: "scheduled: " + JSON.stringify(job.args).slice(0, 160) });
  return job.kind === "mod" ? post : null; // a moderation action says what it did; a send already is the post
}

/** The role-picker buttons the administrator posts: press to add the role, press again to remove it. Refuses any role with powerful permissions or above the bot, and reads the result back. */
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton() || !interaction.customId.startsWith("rolebtn:")) return;
  const say = content => (interaction.deferred || interaction.replied ? interaction.editReply({ content }) : interaction.reply({ content, flags: MessageFlags.Ephemeral })).catch(() => {});
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild, role = guild?.roles.cache.get(interaction.customId.slice(8)), me = guild?.members.me;
    if (!role) return say("That role no longer exists.");
    if (role.managed || !me?.permissions.has("ManageRoles") || role.position >= me.roles.highest.position) return say("I can't hand out that role right now. Ask an admin.");
    if (permNames(role.permissions).some(p => DANGEROUS.includes(p))) return say("That role carries powerful permissions, so it can't be self-assigned.");
    const had = interaction.member.roles.cache.has(role.id);
    await (had ? interaction.member.roles.remove(role, "role panel") : interaction.member.roles.add(role, "role panel"));
    const fresh = await guild.members.fetch({ user: interaction.user.id, force: true });
    if (fresh.roles.cache.has(role.id) === had) return say("Discord did not apply that change. Try again.");
    await say(had ? `Removed **${role.name}**.` : `You now have **${role.name}**.`);
  } catch (e) { console.warn("role button:", e?.message ?? e); await say("I couldn't change that role just now."); }
});

client.on(Events.MessageCreate, async message => {  try {
    remember(message); // learns who is who, so "tag Ahmed" later means the right person
    // Never answers a bot, a webhook, a system message or itself (the bot's own posts and other bots' never start a conversation).
    if (message.author.bot || message.webhookId || message.system || message.author.id === client.user?.id || !message.content && !message.attachments.size) return;
    if (waiting.has(`${message.channelId}:${message.author.id}`)) return; // the answer to a question just asked (yes / no), not a new request
    const { config, owner } = await settings();
    if (config.paused) return;
    if (await automod(message, config).catch(() => false)) return; // server protection, when the owner has switched it on
    const tagged = message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true });
    const channelId = message.channelId, parentId = message.channel.parentId;
    const open = (config.ai.channels ?? []).includes(channelId) || (!!parentId && (config.ai.channels ?? []).includes(parentId));
    if (!tagged && !open) return;
    // A picture with a tag: the trade card flow.
    if (tagged && [...message.attachments.values()].some(a => a.contentType?.startsWith("image/"))) {
      if (!isAdmin(config, message.author.id)) return;
      if (!owner) { await message.reply("Open YSER Lab in the app once so I know whose trades these are."); return; }
      await picker.startCard(message, owner);
      return;
    }
    if (!config.ai.on || !mayUseAi(config, message.author.id)) {
      if (tagged) await message.reply({ content: "I only answer my owner here.", allowedMentions: { repliedUser: false } });
      return;
    }
    const text = stripMention(message.content, client.user.id);
    if (!text) { if (tagged) await message.reply({ content: "Yes? Ask me anything about your model or your trades.", allowedMentions: { repliedUser: false } }); return; }
    if (!owner) { await message.reply("Open YSER Lab in the app once so I know whose trades and model to use."); return; }
    if (message.guild && isAdmin(config, message.author.id) && await handleEmbed(message, text, config).catch(e => { console.warn("embed:", e?.message ?? e); return false; })) return; // make / recolour / edit / repost an embed
    await message.channel.sendTyping().catch(() => {});
    // The intelligence layer first: structured intent, conversation memory and reference resolution. What it does not own continues below as before.
    let brainContext = "";
    if (message.guild && isAdmin(config, message.author.id)) {
      const b = await brain.handle(message, text, config).catch(e => { console.warn("brain:", e?.message ?? e); return { handled: false, context: "" }; });
      if (b.handled) {
        if (b.say) await message.reply({ content: b.say.slice(0, 1990), allowedMentions: { repliedUser: false } });
        for (const p of b.posts ?? []) await message.channel.send(p).catch(async () => message.reply({ content: "Done, but I couldn't post the details here." }).catch(() => null));
        await log("brain", { note: `${b.k?.primary ?? "answer"} ${b.ok === false ? "failed" : "ok"}` }, b.ok !== false);
        return;
      }
      brainContext = b.context ?? "";
    }
    const quick = isAdmin(config, message.author.id) && message.guild ? intentOf(text, `${channelId}:${message.author.id}`) : null; // plain admin requests go straight to their tool
    if (quick?.say) { await message.reply({ content: quick.say, allowedMentions: { repliedUser: false } }); return; }
    const out = quick?.action ? { mod: { action: quick.action, ...quick.args } } : await askUnified({ owner, channelId, discordId: message.author.id, text, context: (await channelContext(message)) + (brainContext ? `\n[What I remember about this conversation (structured memory; trust it for "it", "that", "here", "the second one")]\n${brainContext}` : "") });
    if (out.chart) { await picker.startChart(message, owner, out.timeframe); return; }
    if (out.schedule) { // looking at, or cancelling, what is scheduled
      if (!isAdmin(config, message.author.id)) return;
      const op = String(out.schedule.op ?? "list").toLowerCase();
      if (op === "cancel") { const n = cancel(out.schedule.id || "all"); await message.reply({ content: n ? `🗑️ Cancelled ${n} scheduled item${n === 1 ? "" : "s"}.` : "I couldn't find that one.", allowedMentions: { repliedUser: false } }); return; }
      const all = listJobs();
      await message.reply({ content: all.length ? `⏰ **Scheduled**\n${all.join("\n")}` : "Nothing is scheduled.", allowedMentions: { repliedUser: false } });
      return;
    }
    if (out.mod || out.send) { // moderation and sending: the owner's word only
      if (!isAdmin(config, message.author.id)) { await message.reply({ content: "Only my owner can do that.", allowedMentions: { repliedUser: false } }); return; }
      const NOW_ONLY = new Set(["event_create", "create_event", "tempban", "workflow", "setup", "setup_category", "setup_course", "setup_vip"]); // their "at" / delay is part of the request, not a time to run it
      const later = out.mod && NOW_ONLY.has(String(out.mod.action).toLowerCase()) ? null : schedule(message, out.mod ? "mod" : "send", out.mod ?? out.send); // "in 30 seconds", "at 5 pm", "every weekday at 9": saved for then
      if (later) { await message.channel.send(later); await log(out.mod ? "mod" : "send", { note: "scheduled" }); void noteResult(message.author.id, `(Scheduled: ${String(later.content ?? "").slice(0, 400)})`); return; }
      let call = out.mod;
      if (call && message.guild) { // the model's choice is checked against the intent, and "it" / "the second one" / "here" are resolved from the conversation state
        const g = brain.guard(message, text, call);
        if (g.say) { await message.reply({ content: g.say, allowedMentions: { repliedUser: false } }); return; }
        call = g.call; out.mod = call;
      }
      const hooks = { result: {}, outcome: {} };
      const post = out.mod ? await moderate(message, out.mod, config, hooks) : await sendFromApp(message, out.send, { owner, config });
      if (out.mod) brain.noteLLM(message, out.mod, hooks);
      if (!post) { await log("mod", { note: "completed (it reported in its own message)" }); return; }
      const sent = await message.channel.send(post).catch(async () => message.reply({ content: "Done, but I couldn't post the confirmation here." }).catch(() => null));
      if (out.mod) { // a clean-up's confirmation stays four seconds and goes; the owner's own message stays
        const quiet = ["purge", "slowmode", "remind", "reminder", "alert"].includes(String(out.mod.action).toLowerCase());
        setTimeout(() => { if (quiet) sent?.delete?.().catch(() => {}); }, 4000); // only the bot's own confirmation goes; the owner's message is never deleted unless they ask for that
      }
      await log(out.mod ? "mod" : "send", { note: JSON.stringify(out.mod ?? out.send).slice(0, 180) });
      void noteResult(message.author.id, `(I did it: ${JSON.stringify(out.mod ?? out.send).slice(0, 300)}. I answered: ${String(post?.content ?? "").slice(0, 500)})`);
      return;
    }
    if (out.card) {
      try {
        const card = await cardOnRequest(owner, out.card.period, out.card.last);
        if (!card) { await message.reply({ content: `No trades logged for ${out.card.last ? "last" : "this"} ${out.card.period === "daily" ? "day" : out.card.period.replace("ly", "")}, so there's no card to show.`, allowedMentions: { repliedUser: false } }); return; }
        await message.reply({ ...picturePost({ png: card.png, name: `${card.name}.png`, text: `**${card.label}**` }), allowedMentions: { repliedUser: false } });
        await log("card", { note: `${out.card.period} card on request` });
      } catch (e) {
        await log("card", { error: e?.message ?? String(e) }, false);
        await message.reply({ content: "I couldn't build that card just now. Try again in a minute.", allowedMentions: { repliedUser: false } });
      }
      return;
    }
    if (out.diagram) {
      // Drawn with the slides editor's own renderer; a failure says so instead of going silent.
      await message.channel.sendTyping().catch(() => {});
      try {
        const doc = await modelDoc(owner);
        if (out.count > 1) { // several images: a lesson in slides, one post, in order
          const { images, lessons } = await designSlides(out.diagram, { doc, count: out.count });
          const from = lessons.slice(0, 2).map(l => l.title.replace(/TTrades\s*/gi, "")).join(" · ");
          await message.reply({ ...galleryPost({ images, text: `**${images.map(i => i.spec.title).filter(Boolean)[0]?.slice(0, 60) ?? "Slides"}** · ${images.length} slides` }), allowedMentions: { repliedUser: false } });
          await log("diagram", { sources: from, note: `${images.length} slides: ${out.diagram.slice(0, 100)}` });
          return;
        }
        const { png, spec, lessons, more } = await designDiagram(isGenericSs(text) ? text : out.diagram, { doc, said: text });
        if (more?.length) { // a whole PDF was asked for: its pages, in order, in one post
          await message.reply({ ...galleryPost({ images: [{ png }, ...more], text: `**${String(spec.title).slice(0, 60)}** · ${1 + more.length} pages` }), allowedMentions: { repliedUser: false } });
          await log("diagram", { note: `${spec.title}: ${1 + more.length} pages from the PDF` });
          return;
        }
        const from = lessons.slice(0, 2).map(l => l.title.replace(/TTrades\s*/gi, "")).join(" · ");
        await message.reply({ ...picturePost({ png, name: "diagram.png", text: spec.title ? `**${String(spec.title).slice(0, 80)}**` : undefined }), allowedMentions: { repliedUser: false } });
        await log("diagram", { sources: from, note: out.diagram.slice(0, 120) });
      } catch (e) {
        if (e instanceof Clarify) { await message.reply({ content: e.message, allowedMentions: { repliedUser: false } }); return; } // not understood: ask, don't guess
        await log("diagram", { error: e?.message ?? String(e) }, false);
        await message.reply({ content: "I couldn't draw that one just now. Try again in a minute, or tell me which candles and levels you want in it.", allowedMentions: { repliedUser: false } });
      }
      return;
    }
    brain.noteAssistantText(message, out.text);
    const parts = chunks(out.text);
    await message.reply({ content: parts[0], allowedMentions: { repliedUser: false } });
    for (const part of parts.slice(1)) await message.channel.send(part);
  } catch (e) {
    await log("message", { error: e?.message ?? String(e) }, false);
    message.reply({ content: "Something went wrong on my side. Try again in a moment.", allowedMentions: { repliedUser: false } }).catch(() => {});
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try { if (await brain.handleListButton(interaction)) return; await picker.handle(interaction); }
  catch (e) { await log("interaction", { error: e?.message ?? String(e) }, false); }
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await offline().catch(() => {}); process.exit(0); });
process.on("unhandledRejection", e => console.warn("unhandled:", e?.message ?? e));
process.on("uncaughtException", e => console.warn("uncaught:", e?.message ?? e));

client.login(env.token);

