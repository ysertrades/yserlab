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
  description: "Use for ANY Discord action the owner asks for, however unusual. Actions: purge (delete messages, newest first; count a number or all; user for one person's), timeout, untimeout, kick, ban, unban, warn, slowmode, lock, unlock, say (post words, tagging people by @name), poll, pin, unpin, react, create_channel, rename_channel, topic, dm, role_add, role_remove, nickname, countdown. Put the person in user (tag, id or name; \"me\" is the owner). To run it LATER set delay_seconds / delay_minutes / delay_hours, or at (a New York clock time like 17:00 or 5pm), and repeat (daily, weekdays or weekly) for something recurring.",
  parameters: { type: "OBJECT", properties: { action: { type: "STRING", description: "purge, timeout, untimeout, kick, ban, unban, warn, slowmode, lock or unlock" }, user: { type: "STRING", description: "Who it is about: their @tag, ID or name. Empty for actions on a channel or for deleting everyone's messages." }, count: { type: "STRING", description: "For purge: how many messages (a number), or \"all\"." }, text: { type: "STRING", description: "Words to post, DM or count down to; write @name to tag someone and @me for the owner." }, question: { type: "STRING", description: "Poll question." }, options: { type: "STRING", description: "Poll options separated by |." }, emoji: { type: "STRING", description: "Emoji to react with." }, role: { type: "STRING", description: "Role name." }, name: { type: "STRING", description: "A name: new channel, nickname." }, topic: { type: "STRING", description: "Channel topic." }, delay_seconds: { type: "STRING", description: "Do it after this many seconds." }, delay_minutes: { type: "STRING", description: "Do it after this many minutes." }, delay_hours: { type: "STRING", description: "Do it after this many hours." }, at: { type: "STRING", description: "Do it at this New York time, e.g. 17:00, 5pm or 2026-11-20 09:30." }, repeat: { type: "STRING", description: "daily, weekdays or weekly." }, minutes: { type: "STRING", description: "For timeout: how long, in minutes." }, seconds: { type: "STRING", description: "For slowmode: seconds between messages (0 turns it off)." }, days: { type: "STRING", description: "For ban: how many days of their messages to remove (0 to 7)." }, reason: { type: "STRING", description: "Why, in a few words, if the owner gave one." }, channel: { type: "STRING", description: "The channel it applies to, if they named one. Empty means this channel." } }, required: ["action"] },
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
const asksAboutJournal = q => /\b(trades?|journal|win ?rate|pnl|p&l|profit|loss(es)?|streak|r[- ]?multiple|performance|month|week|today|yesterday|average|best|worst|instrument|session|how (am i|have i)|my (results|numbers|stats))\b/i.test(q);

const SYSTEM = `You are YSER Lab, the personal trading mentor of one trader, living in their Discord server. You know three things completely: THEIR OWN MODEL (their playbook, which always comes first), the whole TTrades Trading Education Center (the textbook behind it: every lesson, diagram, PDF handout and video), and their journal numbers.
How to answer:
- Never say "TTrades": the fractal model is just "the fractal model", the education center is "the education center"; drop that word from lesson titles when you cite them.
- Answer from the material below, in the trader's own terms (their model's vocabulary first). Name the lesson you draw from, e.g. "(lesson: Understanding Fair Value Gaps)". If their model and a lesson differ, follow their model and say what the lesson adds or does differently.
- You are also a sharp general assistant: when they ask about anything else (markets, economics, news, science, coding, writing, life), answer it properly from your own knowledge, without forcing it back to trading, and say when you are not sure or the facts may have changed.
- Reason, don't just look up. A request that is new (not word for word in the material) is worked out from the rules you know: combine the concepts (a candle 2 closure whose entry is a CISD on the lower timeframe is ONE idea built from two) and answer or draw the combination, instead of replying that you don't have it.
- Be precise on THEIR model and the education center: give the actual rules, conditions, steps and levels the material states, not generalities, and never invent rules or numbers there; if the material doesn't cover it, say so plainly and then reason from what it does say.
- Be direct and brief: a few sentences for simple questions, a short structured answer (bullets or numbered steps) for how-to or explain-it questions. Plain words, Discord markdown sparingly, no filler.
- Numbers about their trading come only from the journal summary. Never give financial advice or tell them to take a trade; you help them study, review and stay consistent.
- If they ask you to send or show a picture, chart or screenshot from a trade THEY logged, call show_trade_chart.
- If they ask you to show, draw, illustrate, diagram or make an image of a concept, setup or example (not one of their trades), call draw_diagram with a full sentence of what to draw (and count when they ask for several images or slides, e.g. "make me 4 images explaining the foundation of the fractal model" is count 4). Never describe a picture in words when they asked to see it; call the tool.
- If they ask to share, post or show their daily, weekly or monthly PnL card (results card), call share_pnl_card.
- One picture request is ONE draw_diagram call with the whole sentence, even when it joins two ideas ("show me a c2 closure with a cisd entry" is one picture: the higher timeframe over the lower one, body to body); set count only when they ask for several images.
- Moderation is done with the moderate tool, never described: "delete the last 20 messages" is purge with count 20; "delete 10 of @x's messages" is purge with that user and count 10; "delete everything @x wrote" is purge with count all; also timeout, untimeout, kick, ban, unban, warn, slowmode, lock, unlock. It always starts from the newest message. Always pass the person the owner tagged or named in user. Do it at once when asked; the bot tags the person in its answer.
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
  c.visual && `How the PDF draws it: ${c.visual}`,
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
  return text.length > limit ? text.slice(0, limit) + "\n…(the rest of the model is cut for length)" : text;
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
  return out.join("\n\n") + "\n(only the parts of the model that match the question are shown)";
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
  const parts = [SYSTEM, ...(smt ? [`THE OWNER'S RULES FOR SMT, 2S/3S, STRENGTH SWITCH AND PSP (authoritative; follow them exactly, and when you teach one, run the strong/weak and switch tests out loud, name the one condition that decided it, and end with a one-line question for the student):\n${SMT_RULES}`] : []),`THEIR MODEL (from the PDFs they uploaded in the app; their playbook, it comes first):\n${big ? modelText(doc, room.model) : modelFor(doc, query, room.model)}`];
  if (edu.text) parts.push(`TTRADES EDUCATION CENTER (the textbook; passages that match the question):\n${edu.text}`);
  if (hasKnowledge() && (big || asksForStructure(text))) parts.push(`STRUCTURE OF THE EDUCATION CENTER (the four courses and their lessons, as the site lists them, newest first; a lesson can belong to more than one course):\n${structureText({ overview: big, titles: big || scale >= 1 })}`);
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
export { viaGroq, viaGemini }; // for scripts/education/ask.js, which tries questions without Discord
