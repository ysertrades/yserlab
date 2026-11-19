import { env } from "./env.js";
import { entries, model } from "./store.js";
import { isWin, isLoss } from "./cards.js";
import { SMT_RULES, asksAboutSmt } from "./smtLesson.js";
import { asksForStructure, hasKnowledge, Index, recall, stats, structureText } from "./knowledge.js";

/**
 * The AI: answers about your trading with your own model (the PDFs you uploaded in the app), the whole TTrades Trading Education Center
 * (every lesson, diagram, handout and video, searched per question: see knowledge.js) and your journal numbers. It can't count: the numbers
 * come from the summary below, which the bot works out itself. It can ask for a picture from a trade; the bot then shows the timeframe
 * and trade dropdowns.
 *
 * Groq takes ~8000 tokens per request, so for Groq the bot sends the parts of your model and of the lessons that match the question, not
 * everything; Gemini (the fallback) has room for much more and gets it.
 */
const histories = new Map(); // channel -> [{ role, text, at }]
const KEEP = 8, FORGET = 30 * 60_000;

const TOOLS = [{ functionDeclarations: [{
  name: "show_trade_chart",
  description: "Use when the user wants a picture (a chart or screenshot) from a trade they logged. The bot then asks which trade.",
  parameters: { type: "OBJECT", properties: { timeframe: { type: "STRING", description: "The timeframe or story step they named, such as H4, M15 or Cover. Leave empty if they didn't say." } } },
}, {
  name: "draw_diagram",
  description: "Use when the user wants a concept, setup or example SHOWN, drawn or illustrated as an image (\"show me a fair value gap\", \"draw the fractal model\", \"give me a diagram of CISD\", \"visualise it\", \"make an image of what you mean\"). The bot draws it in the YSER slides editor's style. Not for pictures of their own logged trades.",
  parameters: { type: "OBJECT", properties: { what: { type: "STRING", description: "What to draw, in a full sentence with the details that matter (bullish or bearish, which candles, which levels), using the model's own terms." }, count: { type: "STRING", description: "How many separate images or slides they asked for (2 to 6), if they asked for several (\"make me 4 images explaining...\", \"slides of...\"). Leave empty for one picture." } }, required: ["what"] },
}, {
  name: "share_pnl_card",
  description: "Use when the user asks to share, post, send or show their daily, weekly or monthly PnL card (results card). The bot posts the card picture.",
  parameters: { type: "OBJECT", properties: { period: { type: "STRING", description: "daily, weekly or monthly" }, which: { type: "STRING", description: "this or last (last week, last month, yesterday). Default this." } }, required: ["period"] },
}, {
  name: "moderate",
  description: "Use for ANY Discord action the owner asks for, however unusual. Actions: purge (delete messages, newest first; count a number or all; user for one person's), timeout, untimeout, kick, ban, unban, warn, slowmode, lock, unlock, say (post words, tagging people by @name), poll, pin, unpin, react, create_channel, rename_channel, topic, dm, role_add, role_remove, nickname, countdown, set_permission (change one permission of a channel for @everyone, a role or a person: put it in permission, allow true/false/reset, and who in target), hide and unhide (make a channel invisible or visible), delete_channel, move_channel, clone_channel, nsfw, create_role, edit_role, delete_role (role, color, name, hoist, mentionable), voice_mute, voice_unmute, voice_disconnect, voice_move, thread_archive, remind (a real notification: text is what to remind, user defaults to the owner; ALWAYS give the time as delay_seconds, delay_minutes, delay_hours or at), and for reading the server: server_info (the overview: name, owner, channels, roles, boosts, safety settings, NEVER a list of people), member_list (the ACTUAL members: use it for \"members\", \"who is in this server\", \"show everyone\"; with role for one role's members, query to search by name), member_count (how many members), member_online (who is online), member_info (who one person is: joined, roles), channel_visibility (which channels @everyone or a role can see: role, and mode visible, hidden or readonly), channel_info (who can see and write in one channel and its permission overwrites), read_messages (the latest messages in a channel; count up to 25). Put the person in user (tag, id or name; \"me\" is the owner). To run it LATER set delay_seconds / delay_minutes / delay_hours, or at (a New York clock time like 17:00 or 5pm), and repeat (daily, weekdays or weekly) for something recurring.",
  parameters: { type: "OBJECT", properties: { action: { type: "STRING", description: "invite_create, invite_list, invite_revoke, server_overview, member_list, member_count, member_online, channel_visibility, channel_list, channel_info, channel_create, channel_access, channel_reorder, role_list, role_info, role_members, role_create, role_edit, role_delete, role_assign, role_audit, permission_audit, member_search, joined_recently, mod_history, mod_log, tempban, event_create, event_list, event_cancel, thread_create, message_edit, summarize_channel, announce, role_panel, workflow, automod_set, scan_spam, ai_control, purge, timeout, untimeout, kick, ban, unban, warn, slowmode, lock, unlock, remind, set_permission, hide, unhide, delete_channel, move_channel, clone_channel, nsfw, create_role, edit_role, delete_role, voice_mute, voice_unmute, voice_disconnect, voice_move, thread_archive, server_info, member_info or read_messages" }, permission: { type: "STRING", description: "For set_permission: the permission(s) in plain words, separated by commas: view the channel, send messages, read history, add reactions, attach files, embed links, mention everyone, create threads, use commands, connect, speak, stream." }, allow: { type: "STRING", description: "For set_permission: true to allow it, false to turn it off / deny it, reset to put it back to the default." }, target: { type: "STRING", description: "Who a channel permission is for: everyone (default), a role name, or a @tag." }, color: { type: "STRING", description: "For roles: a hex colour like #3D5AFE." }, hoist: { type: "STRING", description: "For roles: true to show the role separately in the member list." }, mentionable: { type: "STRING", description: "For roles: true if anyone may mention it." }, user: { type: "STRING", description: "Who it is about: their @tag, ID or name. Empty for actions on a channel or for deleting everyone's messages." }, count: { type: "STRING", description: "For purge: EXACTLY how many messages the owner named (\"my last 3 messages\" is 3), as a digit string. Use \"all\" ONLY when they explicitly say all or everything. If they gave no number, use 1." }, text: { type: "STRING", description: "Words to post, DM or count down to; write @name to tag someone and @me for the owner." }, question: { type: "STRING", description: "Poll question." }, options: { type: "STRING", description: "Poll options separated by |." }, emoji: { type: "STRING", description: "Emoji to react with." }, role: { type: "STRING", description: "Role name." }, name: { type: "STRING", description: "A name: new channel, nickname." }, topic: { type: "STRING", description: "Channel topic." }, delay_seconds: { type: "STRING", description: "Do it after this many seconds." }, delay_minutes: { type: "STRING", description: "Do it after this many minutes." }, delay_hours: { type: "STRING", description: "Do it after this many hours." }, at: { type: "STRING", description: "Do it at this New York time, e.g. 17:00, 5pm or 2026-11-20 09:30." }, repeat: { type: "STRING", description: "daily, weekdays or weekly." }, minutes: { type: "STRING", description: "For timeout: how long, in minutes." }, seconds: { type: "STRING", description: "For slowmode: seconds between messages (0 turns it off)." }, days: { type: "STRING", description: "For ban: how many days of their messages to remove (0 to 7)." }, reason: { type: "STRING", description: "Why, in a few words, if the owner gave one." }, channel: { type: "STRING", description: "The channel it applies to, if they named one. Empty means this channel." }, kind: { type: "STRING", description: "For channel_create: text, voice, announcement, forum, stage or category." }, category: { type: "STRING", description: "The category a new or moved channel goes in." }, private: { type: "STRING", description: "true to make a new channel or category private (only the named roles see it)." }, access: { type: "STRING", description: "For channel_access / channel_create: private, read_only or public." }, max_uses: { type: "STRING", description: "For invite_create: how many times the invite can be used (0 or empty is unlimited)." }, expires: { type: "STRING", description: "For invite_create: how long it lasts, like \"24 hours\", \"7 days\" or \"never\"." }, permanent: { type: "STRING", description: "For invite_create: true for an invite that never expires." }, code: { type: "STRING", description: "For invite_revoke: the invite code or link." }, preset: { type: "STRING", description: "For workflow: vip, staff or course." }, channels: { type: "STRING", description: "For workflow: the channels to create, separated by commas (name:voice for a voice channel)." }, announce: { type: "STRING", description: "For workflow: true to post a welcome message." }, invite: { type: "STRING", description: "For workflow: true to also create an invite." }, title: { type: "STRING", description: "A title for an announcement or panel." }, description: { type: "STRING", description: "An event description." }, location: { type: "STRING", description: "An external event location." }, hours: { type: "STRING", description: "How many hours an event or poll lasts." }, op: { type: "STRING", description: "For ai_control: status, incident_on, incident_off, disable, enable, trust or untrust." }, group: { type: "STRING", description: "For ai_control: the tool group (invites, info, channels, permissions, roles, members, moderation, events, threads, messages, community, workflows or all)." }, tool: { type: "STRING", description: "For ai_control trust/untrust: a tool name." }, setting: { type: "STRING", description: "For automod_set: the setting to change (inviteLinks, massMention, duplicates, flood, blockedWords, blockedDomains, newAccountDays, action, timeoutAfterWarnings, timeoutMinutes, logChannel)." }, value: { type: "STRING", description: "For automod_set: the new value." }, on: { type: "STRING", description: "For automod_set: true or false to switch the protection on or off." }, position: { type: "STRING", description: "For channel_reorder: the new position." }, duration: { type: "STRING", description: "How long it runs, like \"24 hours\" or \"2 days\"." }, duration_ms: { type: "STRING", description: "Duration in milliseconds, if you computed it." } }, required: ["action"] },
}, {
  name: "send_to_channel",
  description: "Use when the owner wants something posted in one or MORE Discord channels (comma separated): the economic calendar / news (today, tomorrow, week), a daily, weekly or monthly PnL card (the PnL calendar is the monthly one), or words of their own that may tag people. Can be scheduled with delay_* / at / repeat.",
  parameters: { type: "OBJECT", properties: { what: { type: "STRING", description: "news_today, news_tomorrow, news_week, pnl_daily, pnl_weekly, pnl_monthly or text" }, channel: { type: "STRING", description: "Channel names or #mentions, comma separated, to send to. Empty means this channel." }, delay_seconds: { type: "STRING", description: "Send after this many seconds." }, delay_minutes: { type: "STRING", description: "Send after this many minutes." }, delay_hours: { type: "STRING", description: "Send after this many hours." }, at: { type: "STRING", description: "Send at this New York time, e.g. 17:00 or 5pm." }, repeat: { type: "STRING", description: "daily, weekdays or weekly." }, text: { type: "STRING", description: "For text: exactly what to post, keeping any @tags." }, which: { type: "STRING", description: "this or last, for a PnL card." } }, required: ["what"] },
}, {
  name: "manage_schedule",
  description: "Use when the owner asks what is scheduled, or to cancel a scheduled item (by its code) or all of them.",
  parameters: { type: "OBJECT", properties: { op: { type: "STRING", description: "list or cancel" }, id: { type: "STRING", description: "The code of the item to cancel, or all." } }, required: ["op"] },
}] }];

function summary(rows, recent = 25) {
  const done = rows.filter(e => e.pnl != null || e.r_multiple != null);
  const pnl = done.reduce((s, e) => s + (e.pnl ?? 0), 0), r = done.reduce((s, e) => s + (e.r_multiple ?? 0), 0);
  const wins = done.filter(isWin).length, losses = done.filter(isLoss).length;
  const month = new Date().toISOString().slice(0, 7);
  const m = done.filter(e => e.trade_date.startsWith(month));
  const byInstrument = {};
  for (const e of done) { const k = e.instrument ?? "?"; (byInstrument[k] ??= { n: 0, pnl: 0 }); byInstrument[k].n++; byInstrument[k].pnl += e.pnl ?? 0; }
  const lines = done.slice(0, recent).map(e => `${e.trade_date} ${e.instrument ?? "?"} ${e.direction ?? ""} ${e.session ?? ""} pnl=${e.pnl ?? "?"} r=${e.r_multiple ?? "?"} "${(e.title ?? "").slice(0, 50)}"`);
  return [
    `All time: ${done.length} trades, ${wins} wins, ${losses} losses, win rate ${wins + losses ? Math.round(100 * wins / (wins + losses)) : 0}%, pnl ${Math.round(pnl)}, total R ${r.toFixed(2)}.`,
    `This month (${month}): ${m.length} trades, pnl ${Math.round(m.reduce((s, e) => s + (e.pnl ?? 0), 0))}.`,
    `By instrument: ${JSON.stringify(byInstrument)}`,
    lines.length ? `Most recent trades:\n${lines.join("\n")}` : "",
  ].filter(Boolean).join("\n");
}
/** True when the user wants to know where something comes from (only then do lesson names and sources go into the prompt). */
export const asksForSource = q => /\b(sources?|cite|citations?|references?|where (did|do|does) (you|that|this|it) (get|learn|read|come)|which (lesson|pdf|video|page|document|file)|what (lesson|pdf|page|document)|page (number|\d+)|exact(ly)? (quote|words|wording|what)|quote (it|that|the|exactly)|in which (lesson|pdf|video))\b/i.test(q);
const asksAboutJournal = q => /\b(trades?|journal|win ?rate|pnl|p&l|profit|loss(es)?|streak|r[- ]?multiple|performance|month|week|today|yesterday|average|best|worst|instrument|session|how (am i|have i)|my (results|numbers|stats))\b/i.test(q);

const SYSTEM = `You are YSER Lab, the personal trading mentor of one trader, living in their Discord server. You are an experienced instructor of THEIR trading model (their playbook, which always comes first) and of the fractal model course behind it, and you read their journal numbers. The reference material below is what you know, not something you look up.
How to answer:
- Never say "TTrades": the method is just "the fractal model".
- Teach like a knowledgeable instructor speaking from your own expertise, in the trader's own terms (their model's vocabulary first). Never mention or hint at where something came from: no "according to...", "the lesson says", "the education center", "the PDF", "your uploaded...", "the document", "the material", "the passage", "the knowledge base", no lesson or file names, no page numbers, no "lesson:" tags, and no talk of searching, retrieval or context. Only when the user explicitly asks where it comes from, or asks for a source, lesson name, page number or an exact quote, reveal it from the SOURCE NOTES when they are given (and say plainly when you have no source for a claim).
- Terms and rules must match the reference exactly. If their model and the course differ, give their model's version as the rule; mention a variation only when it changes what they should do, in plain words ("a common variation is..."), without naming a source.
- You are also a sharp general assistant: when they ask about anything else (markets, economics, news, science, coding, writing, life), answer it properly from your own knowledge, without forcing it back to trading, and say when you are not sure or the facts may have changed.
- Reason, don't just look up. A request that is new (not word for word in the material) is worked out from the rules you know: combine the concepts (a candle 2 closure whose entry is a CISD on the lower timeframe is ONE idea built from two) and answer or draw the combination, instead of replying that you don't have it.
- Be precise on THEIR model and the fractal model course: give the actual rules, conditions, steps and levels, not generalities, and never invent rules or numbers there. If the specifics are not covered, say so in plain words ("I don't have a rule for that in your model") and then reason from the rules you do know or give the general trading convention, saying "in general" so it is clear it is not part of their model.
- Be direct and brief: a few sentences for simple questions, a short structured answer (bullets or numbered steps) for how-to or explain-it questions. Plain words, Discord markdown sparingly, no filler.
- Numbers about their trading come only from the journal summary. Never give financial advice or tell them to take a trade; you help them study, review and stay consistent.
- If they ask you to send or show a picture, chart or screenshot from a trade THEY logged, call show_trade_chart.
- If they ask you to show, draw, illustrate, diagram or make an image of a concept, setup or example (not one of their trades), call draw_diagram with a full sentence of what to draw (and count when they ask for several images or slides, e.g. "make me 4 images explaining the foundation of the fractal model" is count 4). Never describe a picture in words when they asked to see it; call the tool.
- If they ask to share, post or show their daily, weekly or monthly PnL card (results card), call share_pnl_card.
- One picture request is ONE draw_diagram call with the whole sentence, even when it joins two ideas ("show me a c2 closure with a cisd entry" is one picture: the higher timeframe over the lower one, body to body); set count only when they ask for several images.
- Discord administration is done by tools, never by explaining. If the request is clear, call the tool at once; ask a question only when an essential detail is missing (a name, a role, a time), and ask it once. "Give me an invite", "send me a server link", "how do I get in" are invite_create: it makes a real invitation and returns the URL (use expires / max_uses / permanent / channel when they gave them); never ask who to tag and never describe how to make one. Counting and describing the server: server_overview, role_list, channel_list. "Create a private category called VIP" is channel_create with kind category, private true and the role; making many things at once ("set up a VIP category", "prepare the server for a new course") is workflow. "Check our protection", "audit permissions" is permission_audit; "anyone spamming" is scan_spam; "turn on anti-spam" is automod_set. Reminders and events: remind for a ping, event_create for a Discord scheduled event (start time in at, New York time). A name in a request is not a request to tag someone. After a tool runs, the bot reports the real result; never claim a change you did not make.
- Time and notifying. "Remind me in 10 minutes to X", "alert me at 5pm", "tell me when it is 9:30" are ALWAYS the moderate tool with action remind, text X and the time in delay_minutes / delay_hours / at (a New York clock time); a request that is only words in your answer never notifies anyone, so never say you will remind them without calling the tool. Anything the owner wants done later (post, lock, unlock, poll, purge) takes the same delay_ / at / repeat fields. To notify everyone, put @everyone (or @here) in the text of say or remind; it really pings the whole server, so do it when the owner asks for it. Say in your answer what you set and when.
- Discord, understood properly. Viewing a channel (ViewChannel) and sending in it (SendMessages) are different permissions: "turn off viewing", "hide this channel" or "nobody can see it" is hide (or set_permission with permission "view the channel", allow false), NEVER lock; "lock" or "stop people talking" is lock (SendMessages only); "read-only" is lock; "private" is hide for everyone then allow view for the role or person named. A permission change applies to a channel for a target: @everyone unless a role or person is named. "Let X see this channel" is set_permission view, allow true, target X; "go back to normal" is allow reset. Roles: colours are hex; "show separately" is hoist. Moderation ladder: warn, then timeout (mute), then kick, then ban; timeouts last up to 28 days. Slowmode is seconds between messages per person. Threads are archived or locked, not deleted. Voice: mute, move or disconnect a person in a voice channel. Use exactly the permission the owner named, never a neighbouring one, and say in your reply what changed.
- Moderation is done with the moderate tool, never described: "delete the last 20 messages" is purge with count 20; "delete 10 of @x's messages" is purge with that user and count 10; "delete everything @x wrote" is purge with count all; also timeout, untimeout, kick, ban, unban, warn, slowmode, lock, unlock. Questions about the server itself are different requests with different tools: "members in this server" / "who is in this server" is member_list (real people, never an overview), "how many members" is member_count, "who is online" is member_online, "server information" is server_info, "who is @x" is member_info and "what was said above" is read_messages: you have full administrator access, so never say you lack access to server information. It always starts from the newest message. Always pass the person the owner tagged or named in user; "my messages" or "mine" means user "me" (the owner), and a count means exactly that many of those messages, never more. Read the whole request: the number, whose messages and which channel all matter, and never widen it. Do it at once when asked; the bot tags the person in its answer.
- The owner can ask for anything and the bot does it: call moderate for any Discord action (say, poll, dm, roles, channels, pins, reactions, countdowns, moderation) and send_to_channel for the news, PnL cards or words in one or several channels. "Tag this person" means write @name in text (the bot knows who people are and tags them for real). "my calendar" is the economic calendar unless they say PnL; "my PnL calendar" is the monthly card. Anything that should happen later ("in 30 seconds", "in 10 minutes", "at 5 pm", "every weekday at 9") uses delay_seconds / delay_minutes / delay_hours / at / repeat on that same call; "what's scheduled" or "cancel it" uses manage_schedule. Never refuse a request as impossible without calling the tool first; if a tool cannot do it, say exactly what is missing.
- A request to SEE something ("show me how an SS looks") is never answered with questions or a paragraph: call draw_diagram at once and let the defaults decide. Ask a question only when the request contradicts itself.`;

const GROQ_MODELS = () => [...new Set([env.groqModel, "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"].filter(Boolean))];
const GEMINI_MODELS = () => [...new Set([env.geminiModel, "gemini-flash-lite-latest", "gemini-flash-latest", "gemini-3.5-flash"].filter(Boolean))];
const lower = p => ({ type: "object", properties: Object.fromEntries(Object.entries(p.properties).map(([k, v]) => [k, { type: "string", description: v.description }])), required: p.required });
const GROQ_TOOLS = TOOLS[0].functionDeclarations.map(f => ({ type: "function", function: { name: f.name, description: f.description, parameters: lower(f.parameters) } }));
/** The tool the model called, as the answer the bot acts on. */
function called(name, args) {
  if (name === "show_trade_chart") return { chart: true, timeframe: args?.timeframe || "" };
  if (name === "draw_diagram") return { diagram: String(args?.what || "").slice(0, 400), count: Math.min(6, Math.max(1, parseInt(args?.count, 10) || 1)) };
  if (name === "share_pnl_card") return { card: { period: /week/i.test(args?.period) ? "weekly" : /month/i.test(args?.period) ? "monthly" : "daily", last: /last|prev|yesterday/i.test(String(args?.which ?? "") + " " + String(args?.period ?? "")) } };
  if (name === "moderate") return { mod: { ...args } };
  if (name === "send_to_channel") return { send: { ...args } };
  if (name === "manage_schedule") return { schedule: { ...args } };
  return null;
}

class Overloaded extends Error {}
/** Groq (the chat): an OpenAI-style call with the same tool. Returns { text } or { chart, timeframe }, or throws. */
async function viaGroq(system, history, text) {
  const messages = [{ role: "system", content: system }, ...history.map(h => ({ role: h.role === "model" ? "assistant" : "user", content: h.text })), { role: "user", content: text }];
  let last = "no model answered", tooBig = false;
  for (const model of GROQ_MODELS()) {
    try {
      const body = { model, messages, tools: GROQ_TOOLS, temperature: 0.4, max_completion_tokens: 1000 };
      if (model.startsWith("openai/gpt-oss")) body.reasoning_effort = "low";
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.groqKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(40_000) });
      if (!response.ok) { last = `AI error ${response.status}`; if (response.status === 413 || response.status === 429) tooBig = true; continue; }
      const message = (await response.json()).choices?.[0]?.message;
      const call = message?.tool_calls?.find(c => called(c.function?.name, {}));
      if (call) { let args = {}; try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* no arguments */ } return called(call.function.name, args); }
      const answer = String(message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (answer) return { text: answer };
      last = "empty answer";
    } catch (e) { last = e.message; }
  }
  throw tooBig ? new Overloaded(last) : new Error(last);
}

/** Gemini: the fallback when Groq isn't set or fails. */
async function viaGemini(system, history, text) {
  const contents = [...history.map(h => ({ role: h.role, parts: [{ text: h.text }] })), { role: "user", parts: [{ text }] }];
  const body = JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, tools: TOOLS, generationConfig: { temperature: 0.4, maxOutputTokens: 1500 } });
  let last = "no model answered";
  for (const name of GEMINI_MODELS()) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${name}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.geminiKey }, body, signal: AbortSignal.timeout(45_000) });
      if (!response.ok) { last = `AI error ${response.status}`; continue; }
      const parts = (await response.json()).candidates?.[0]?.content?.parts ?? [];
      const call = parts.find(p => p.functionCall)?.functionCall;
      if (call && called(call.name, call.args)) return called(call.name, call.args);
      const answer = parts.map(p => p.text ?? "").join("").trim();
      if (answer) return { text: answer };
    } catch (e) { last = e.message; }
  }
  throw new Error(last);
}

const list = v => (Array.isArray(v) ? v.filter(Boolean) : []);
const conceptText = c => [
  `## ${c.name}${c.kind ? ` (${c.kind})` : ""}${list(c.timeframes).length ? ` [${c.timeframes.join(", ")}]` : ""}`,
  c.look_for && `Look for: ${c.look_for}`,
  c.visual && `How it looks on the chart: ${c.visual}`,
  list(c.must).length && `Must hold: ${c.must.join("; ")}`,
  list(c.steps).length && `Steps: ${c.steps.map((s, i) => `${i + 1}) ${s}`).join(" ")}`,
  list(c.not).length && `Doesn't count: ${c.not.join("; ")}`,
  list(c.rules).length && `Rules: ${c.rules.join("; ")}`,
].filter(Boolean).join("\n");

/**
 * The model you uploaded, as readable text: what it is, its own vocabulary, each concept with what to look for and what must hold,
 * and the checklist. Kept within `limit` characters, with the most useful parts first so a trim only loses detail.
 */
export function modelText(doc, limit = 22000) {
  if (!doc) return "(no model uploaded yet)";
  const parts = [`${doc.title ?? "Trading model"}\n${doc.summary ?? ""}`];
  if (list(doc.glossary).length) parts.push("VOCABULARY (use these meanings):\n" + doc.glossary.map(g => `- ${g.term}: ${g.means}`).join("\n"));
  parts.push("CONCEPTS:\n" + list(doc.concepts).map(conceptText).join("\n\n"));
  const phases = list(doc.checklist?.phases);
  if (phases.length) parts.push("CHECKLIST BEFORE A TRADE:\n" + phases.map(ph => `${ph.name}${ph.timeframe ? ` (${ph.timeframe})` : ""}: ${list(ph.items).map(i => i.text).join(" | ")}`).join("\n"));
  const text = parts.join("\n\n");
  return text.length > limit ? text.slice(0, limit) : text;
}

const modelIndexes = new WeakMap();
/**
 * The part of your model that bears on the question, within `limit` characters: always its title, summary and the names of its concepts,
 * then the concepts, definitions and checklist phases that match the question, best first.
 */
export function modelFor(doc, query, limit = 7000) {
  if (!doc) return "(no model uploaded yet)";
  const full = modelText(doc, 1e9);
  if (full.length <= limit) return full;
  let idx = modelIndexes.get(doc);
  if (!idx) {
    const chunks = [
      ...list(doc.concepts).map(c => ({ h: c.name, t: conceptText(c) })),
      ...list(doc.glossary).map(g => ({ h: g.term, t: `${g.term}: ${g.means}`, glossary: true })),
      ...list(doc.checklist?.phases).map(ph => ({ h: ph.name, t: `Checklist, ${ph.name}${ph.timeframe ? ` (${ph.timeframe})` : ""}: ${list(ph.items).map(i => i.text).join(" | ")}` })),
    ];
    idx = new Index(chunks); modelIndexes.set(doc, idx);
  }
  const head = `${doc.title ?? "Trading model"}\n${doc.summary ?? ""}\nCONCEPTS IN THE MODEL: ${list(doc.concepts).map(c => c.name).join(", ")}`;
  const out = [head];
  let size = head.length;
  for (const { chunk } of idx.search(query, 30)) {
    if (size + chunk.t.length > limit) continue;
    out.push(chunk.t); size += chunk.t.length + 2;
  }
  if (out.length === 1) { // nothing matched: give the opening of the model rather than only its title
    const rest = modelText(doc, limit - head.length);
    return rest;
  }
  return out.join("\n\n");
}

/** Everything the AI is told for one question; `scale` shrinks it for a provider with less room. */
export function context({ doc, rows, text, history = [], big = false, scale = 1 }) {
  const follow = text.length < 40 ? history.filter(h => h.role === "user").slice(-1)[0]?.text ?? "" : "";
  const query = `${follow} ${text}`;
  const journal = asksAboutJournal(text);
  const room = big
    ? { model: 40000, edu: 36000, journal: 25 }
    : { model: Math.round(6200 * scale), edu: Math.round((journal ? 6000 : 9800) * scale), journal: journal ? 10 : 2 };
  const smt = asksAboutSmt(query);
  if (smt && !big) room.edu = Math.round(room.edu * .5); // the owner's SMT rules take that room
  const edu = hasKnowledge() ? recall(query, { chars: room.edu, perLesson: big ? 4 : 3 }) : { text: "", lessons: [] };
  const parts = [SYSTEM, ...(smt ? [`RULES FOR SMT, 2S/3S, THE STRENGTH SWITCH AND PSP (authoritative; apply them exactly, never attribute them to anyone; when you teach one, run the strong/weak and switch tests out loud, name the one condition that decided it, and end with a one-line question for the student):\n${SMT_RULES}`] : []),`THEIR TRADING MODEL (their playbook; it comes first):\n${big ? modelText(doc, room.model) : modelFor(doc, query, room.model)}`];
  if (edu.text) parts.push(`REFERENCE: THE FRACTAL MODEL COURSE (background knowledge for answering; never mention it or its sections):\n${edu.text}`);
  if (hasKnowledge() && asksForStructure(text)) parts.push(`COURSE OUTLINE (only for a question about what is covered or in what order; the four courses and their lessons, newest first; a lesson can belong to more than one course):\n${structureText({ overview: big, titles: big || scale >= 1 })}`);
  if (edu.sources?.length && asksForSource(`${follow} ${text}`)) parts.push(`SOURCE NOTES (the user asked where this comes from: reveal what they asked for, quote exactly when they ask for a quote, and never invent page numbers):\n${edu.sources.map(s => `- ${s.lesson}${s.kind ? ` (${s.kind})` : ""}${s.heading ? `, section: ${s.heading}` : ""}`).join("\n")}`);
  parts.push(`THEIR JOURNAL:\n${summary(rows, room.journal)}\n\nNow: ${new Date().toString().slice(0, 33)}`);
  return { system: parts.join("\n\n"), lessons: edu.lessons };
}

let modelCache = { owner: null, at: 0, doc: null };
const cachedModel = async owner => { if (modelCache.owner !== owner || Date.now() - modelCache.at > 60_000) modelCache = { owner, at: Date.now(), doc: await model(owner) }; return modelCache.doc; };

/** Facts that change (news, scores, prices, releases) are looked up on the web, through Gemini's search. Null if it can't. */
const asksCurrent = q => /\b(news|headlines?|right now|currently|who won|weather|score|release date|earnings|cpi|fomc|nfp|price of|what happened|latest|this week)\b/i.test(q) && !/\b(my|journal|trades?|pnl|model|fractal|cisd|smt|psp|closure)\b/i.test(q);
async function viaSearch(text) {
  if (!env.geminiKey) return null;
  for (const name of GEMINI_MODELS()) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${name}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.geminiKey }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ systemInstruction: { parts: [{ text: `You are YSER Lab, a trader's assistant in Discord. Answer from a web search, briefly and plainly, with the date of what you found. Today is ${new Date().toDateString()}.` }] }, contents: [{ role: "user", parts: [{ text }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.3, maxOutputTokens: 900 } }) });
      if (!r.ok) continue;
      const answer = ((await r.json()).candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join("").trim();
      if (answer) return { text: answer };
    } catch { /* next model */ }
  }
  return null;
}

export async function ask({ owner, channelId, text }) {
  if (!env.groqKey && !env.geminiKey) return { text: "My AI isn't connected yet: add `GROQ_API_KEY` in the host's variables." };
  if (asksCurrent(text)) { const found = await viaSearch(text); if (found) return found; }
  const [rows, doc] = await Promise.all([entries(owner).catch(() => []), cachedModel(owner)]);
  const history = (histories.get(channelId) ?? []).filter(h => Date.now() - h.at < FORGET).slice(-KEEP);
  const short = history.slice(-4).map(h => ({ ...h, text: h.text.slice(0, 600) })); // Groq's room is small: only the latest turns, trimmed
  let out;
  const gemini = async () => viaGemini(context({ doc, rows, text, history, big: true }).system, history, text);
  try {
    if (!env.groqKey) out = await gemini();
    else {
      try { out = await viaGroq(context({ doc, rows, text, history: short }).system, short, text); }
      catch (e) {
        if (!(e instanceof Overloaded)) throw e;
        try { out = await viaGroq(context({ doc, rows, text, history: short, scale: .6 }).system, short.slice(-2), text); } // over the per-minute allowance: a smaller version
        catch { if (!env.geminiKey) throw e; out = await gemini(); }                                                       // or Gemini, which has room for all of it
      }
    }
  } catch (e) { if (!env.groqKey || !env.geminiKey) throw e; out = await gemini(); }
  // The model sometimes writes a picture's description (or imitates "(drew a diagram: ...)") instead of calling the tool: draw it anyway.
  if (out.text && (/^\s*\(?\s*(drew|draws|posted|showed|sent)\b[^:]{0,20}:/i.test(out.text) || (wantsPicture(text) && !/\b(trades?|journal|pnl|card|results|stats)\b/i.test(text)))) {
    out = { diagram: out.text.replace(/^\s*\(?\s*(drew|draws|posted|showed|sent)\b[^:]{0,20}:\s*/i, "").replace(/\)\s*$/, "").slice(0, 400) || text, count: /\b(\d)\s*(images|slides|pictures|diagrams)\b/i.test(text) ? Number(RegExp.$1) : 1 };
    if (!/\b(draw|diagram|image|picture|slides?)\b/i.test(out.diagram)) out.diagram = text; // what the user asked is the better brief than the model's prose
  }
  const keep = histories.get(channelId) ?? [];
  keep.push({ role: "user", text, at: Date.now() });
  keep.push({ role: "model", text: out.chart ? "(showed a trade chart picker)" : out.schedule ? "(looked at the schedule)" : out.mod ? "(did a moderation action)" : out.send ? "(sent it to the channel)" : out.diagram ? "Sent the picture." : out.card ? `(posted the ${out.card.period} card)` : out.text || "…", at: Date.now() });
  histories.set(channelId, keep.slice(-KEEP * 2));
  return out;
}

const wantsPicture = q => /\b(draw|diagram|illustrate|visuali[sz]e|images?|pictures?|slides?)\b|\bshow me (a|an|the|how)\b/i.test(q);
export const modelDoc = cachedModel;
export const knowledgeStats = stats;
export { viaGroq, viaGemini, called, TOOLS }; // viaGroq and viaGemini: for scripts/education/ask.js, which tries questions without Discord
