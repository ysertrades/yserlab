import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { PermissionFlagsBits as P } from "discord.js";
import { viaGemini, viaGroq } from "../ai.js";
import { env } from "../env.js";
import { audit } from "./audit.js";
import { botMissing, sayMissing } from "./guard.js";
import { panel } from "./ui.js";
import { findRole } from "./tools.js";

/**
 * Embeds and announcements, done the way a person would expect. "Make an embed announcing a giveaway starting tomorrow" is written straight
 * away from what was said (never inventing prizes, times, links or handles, and never asking a question the request already answers). The
 * result is remembered as a draft, so the next messages mean it: "change the colour to dark", "make it shorter", "post it in #lab" act on that
 * embed, in place, instead of starting something new. Everything is a Components V2 container; editing keeps the message and swaps the colour or text.
 */
const FILE = path.join(process.env.YSER_DATA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data"), "drafts.json");
const TTL = 6 * 3_600_000;
let drafts = {};
try { drafts = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { /* none yet */ }
const save = () => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(drafts)); } catch { /* memory only */ } };
const keyOf = message => `${message.guild?.id}:${message.author?.id}`;
export const draftOf = message => { const d = drafts[keyOf(message)]; return d && Date.now() - d.at < TTL ? d : null; };
export const setDraft = (message, d) => { drafts[keyOf(message)] = { ...d, at: Date.now() }; save(); };
export const forgetDrafts = () => { drafts = {}; };

/* ── colour ── */
export const COLOURS = {
  "dark grey": "#2b2d31", "dark gray": "#2b2d31", dark: "#2b2d31", darker: "#17181a", charcoal: "#2b2d31", black: "#0b0c0e", "jet black": "#0b0c0e",
  purple: "#8d9bff", violet: "#8d9bff", lilac: "#a99cf5", brand: "#8d9bff", default: "#8d9bff", indigo: "#4b4fd6",
  blue: "#3d5afe", cobalt: "#3d5afe", "light blue": "#5cc8f2", cyan: "#5cc8f2", teal: "#1abc9c", green: "#3ccf7a", lime: "#8fd14f",
  red: "#f06b6b", crimson: "#c0392b", orange: "#e67e22", gold: "#f5b544", yellow: "#f5c542", pink: "#ff6fb5", white: "#f4f5f7", grey: "#8e8e94", gray: "#8e8e94", silver: "#b8bcc8", brown: "#8d6e63",
};
/** The colour a message asks for, ignoring colours it rules out ("dark, not purple"). Null when it names none. */
export function colourOf(text) {
  const t = String(text ?? "").toLowerCase().replace(/\b(?:not|no|instead of|rather than|except)\s+(?:a\s+|the\s+)?(?:#[0-9a-f]{6}|[a-z]+(?:\s(?:grey|gray|blue))?)/g, " ");
  const hex = /#([0-9a-f]{6})\b/i.exec(t); if (hex) return `#${hex[1].toLowerCase()}`;
  for (const name of Object.keys(COLOURS).sort((a, b) => b.length - a.length)) if (new RegExp(`\\b${name}\\b`).test(t)) return COLOURS[name];
  return null;
}

/* ── writing ── */
const money = /\$\s?\d|\b\d[\d,.]*\s?(?:usd|dollars?|eur|gbp|k)\b|[€£]\s?\d/i;
/** Takes out anything the request did not say: amounts, handles, links, placeholders, empty hype. */
export function guardFacts(text, request) {
  const asked = String(request ?? "").toLowerCase();
  return String(text ?? "").split("\n").filter(line => {
    const l = line.toLowerCase();
    if (/\[[^\]]*(?:your|add|insert|name|link|here)[^\]]*\]|@yourserver|@your[a-z]*|\{\{.*\}\}/i.test(line)) return false;
    if (money.test(line) && !money.test(asked)) return false;
    if (/https?:\/\/\S+/.test(line) && !/https?:\/\//.test(asked)) return false;
    if (/\b(1st|2nd|3rd|first|second|third) (place|prize)\b/i.test(line) && !/\b(place|prize|winner)s?\b/.test(asked)) return false;
    if (/may the odds|good luck and|don'?t miss out|hurry|limited time only/i.test(l)) return false;
    return true;
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
const SYSTEM = (today) => `You write Discord announcements for a trading community called YSER Lab. Reply with ONLY a JSON object: {"title": string, "body": string}.
Today is ${today}.
Rules, all strict:
- Use ONLY the facts in the request. Never invent prizes, amounts, times, links, handles, names, rules, steps or numbers. If a detail was not given, leave it out or say it is coming (for example "Details to follow"). Never write placeholders like [Your Server].
- Never ask a question. Do the task with what you have.
- Work out relative dates (tomorrow, Saturday, next week) from today and write the real date, like "Thursday, November 19". Do not invent a time of day.
- Title: at most 60 characters, one fitting emoji at the start is allowed. Body: 2 to 5 short lines, plain and warm, bold labels allowed with **, at most 450 characters. No hashtags, no clichés ("may the odds"), no all-caps shouting.
- Write in the language of the request.`;
const json = s => { try { return JSON.parse(/\{[\s\S]*\}/.exec(String(s ?? ""))?.[0] ?? "null"); } catch { return null; } };
let writer = async (system, prompt) => { // swapped in tests
  try { const out = env.geminiKey ? await viaGemini(system, [], prompt) : await viaGroq(system, [], prompt); return out?.text ?? null; } catch { try { const out = await viaGroq(system, [], prompt); return out?.text ?? null; } catch { return null; } }
};
export const useWriter = fn => { writer = fn; };
const nyToday = () => DateTime.now().setZone("America/New_York").toFormat("cccc, LLLL d, yyyy");

/** The announcement for a request: { title, body }. Falls back to a plain, honest version when no model answers. */
export async function compose(request, draft = null) {
  const prompt = draft ? `Current announcement:\nTitle: ${draft.title}\nBody:\n${draft.body}\n\nChange it as asked, keeping everything else exactly as it is: ${request}` : request;
  const raw = await writer(SYSTEM(nyToday()), prompt);
  const j = json(raw);
  if (j?.title && j?.body) return { title: String(j.title).replace(/\*\*/g, "").slice(0, 100), body: guardFacts(String(j.body), request + (draft ? `\n${draft.body}` : "")).slice(0, 1800) || "Details to follow." };
  if (draft) return null;
  const topic = String(request).replace(/^(please\s+)?(make|create|write|draft|prepare|build|send|post)\s+(for me\s+)?(me\s+)?(an?\s+)?(embed|announcement)\s+(of|about|for|announcing|that says)?\s*/i, "").replace(/[.!]+$/, "").trim();
  return { title: (topic ? topic[0].toUpperCase() + topic.slice(1) : "Announcement").slice(0, 80), body: "Details to follow." };
}

export function embedPost(d, pings = []) {
  return panel({ title: d.title, lines: [d.body], accent: d.colour ?? "#8d9bff", heading: "##", footer: d.footer, pings });
}

/* ── understanding what was asked ── */
const WORD = "(?:embed|announcement|message|post|panel|card|notice|it|that|this)";
/** One message can hold several instructions ("make the colour dark. send it to #lab, then mention everyone below it"): they are read one by one and done in order. */
export function clausesOf(text) {
  const t = String(text ?? "").replace(/<@!?\d+>/g, " ").trim();
  return t.split(/[\n;]+|(?<=[.!?])\s+(?=[A-Za-z<@#])|\s*,?\s*\b(?:and\s+then|then|after\s+that|and\s+also|also)\b\s+|\s*,\s*(?:and\s+)?(?=(?:send|post|put|move|mention|ping|tag|notify|make|change|set)\b)|\s+and\s+(?=(?:send|post|put|move|mention|ping|tag|notify|change|set)\b)/i).map(s => s.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "")).filter(Boolean);
}
const PING_TO = "(@?every ?one|@?here|everybody|all members|<@&\\d+>|(?:the\\s+)?[\\w][\\w -]*?\\s+role)";
export function embedIntent(clause, hasDraft) {
  const t = String(clause ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const channel = /<#(\d{15,})>/.exec(t)?.[1];
  const ping = new RegExp(`^(?:please\\s+|now\\s+|and\\s+)?(?:mention|ping|tag|notify|alert)\\s+${PING_TO}(?:\\s+(?:below|under|underneath|beneath|after|right after|here|there|now|too|as well)(?:\\s+(?:it|the (?:embed|message|announcement)|that|this))?)?(?:\\s+in\\s+(?:the\\s+)?(?:<#\\d+>|#?[\\w-]+(?:\\s+channel)?))?$`, "i").exec(t);
  if (ping) {
    const who = ping[1].toLowerCase();
    const mention = /every ?one|everybody|all members/.test(who) ? "@everyone" : /here/.test(who) ? "@here" : /<@&(\d+)>/.exec(ping[1])?.[1] ?? ping[1].replace(/^the\s+/i, "").replace(/\s+role$/i, "").trim();
    return { op: "ping", mention, channel, name: /\bin\s+(?:the\s+)?#?([\w-]+)(?:\s+channel)?$/i.exec(t)?.[1] };
  }
  if (hasDraft) {
    if (/^(?:please\s+|now\s+)?(?:post|send|put|move|publish|share|repost|forward|drop)\s+(?:it|this|that|the (?:embed|announcement|message))?\s*(?:in|to|into|on)?\s*(?:the\s+)?(?:<#\d+>|#?[\w-]+(?: channel)?)$/i.test(t) && (channel || /\b(in|to|into)\b/i.test(t))) return { op: "repost", channel, name: /(?:in|to|into|on)\s+(?:the\s+)?#?([\w-]+)(?:\s+channel)?$/i.exec(t)?.[1] };
    const asksColour = /\b(colou?r|accent|tint|shade)\b/i.test(t) || new RegExp(`\\b(?:make|turn|paint|set|change)\\s+${WORD}\\b.*\\b(?:dark|black|purple|blue|green|red|gold|yellow|orange|pink|white|grey|gray|teal|cyan|#[0-9a-f]{6})\\b`, "i").test(t);
    if (asksColour && colourOf(t)) return { op: "colour", colour: colourOf(t) };
    if ((new RegExp(`\\b${WORD}\\b`, "i").test(t) || /\b(title|heading|description|body|footer)\b/i.test(t)) && /\b(shorter|longer|shorten|expand|title|heading|description|body|line|footer|add|remove|delete|rewrite|rephrase|replace|translate|professional|casual|exciting|simpler|bold|emoji)\b/i.test(t) && t.length < 260 && !/\b(role|channel|invite|member|server|permission)\b/i.test(t.replace(/<#\d+>/g, ""))) return { op: "edit", request: t };
  }
  if (/\b(make|create|write|draft|prepare|build|compose|design|send|post|do)\b.*\b(embed|announcement|announce|announcing|panel|notice)\b|^announce\b/i.test(t) && !/\b(delete|remove|edit|change)\b.*\b(embed|announcement)\b/i.test(t)) return { op: "create", request: t, channel };
  return null;
}
/** The steps a whole message asks for, in order; null when none of it is about an embed. */
export function embedPlan(text, hasDraft) {
  const plan = []; let draft = hasDraft;
  for (const clause of clausesOf(text)) {
    const step = embedIntent(clause, draft);
    if (!step) { if (plan.length) continue; else return null; }
    if (step.op === "create") draft = true;
    // a ping on its own, with no embed behind it, is only taken when it is the whole message
    if (step.op === "ping" && !draft && clausesOf(text).length > 1) continue;
    plan.push(step);
  }
  return plan.length ? plan : null;
}

/** Handles an embed request. Returns true when it did (the message is fully handled, nothing else should answer). */
export async function handleEmbed(message, text, config) {
  if (!message.guild) return false;
  const first = draftOf(message), plan = embedPlan(text, !!first);
  if (!plan) return false;
  const guild = message.guild, t0 = Date.now();
  const base = op => ({ guild: guild.id, user: message.author.id, action: `embed_${op}`, risk: "low", permission: "ok" });
  const say = content => message.channel.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
  const fail = async (op, why) => { audit({ ...base(op), ok: false, error: why, ms: Date.now() - t0 }); await say(why); return true; };
  const find = (step, fallback) => (step.channel ? guild.channels.cache.get(step.channel) : null) ?? (step.name ? guild.channels.cache.find(c => c.isSendable?.() && c.name.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(step.name.toLowerCase().replace(/[^a-z0-9]+/g, ""))) : null) ?? fallback;
  let cur = first;
  for (const step of plan) {
    try {
      if (step.op === "create") {
        const target = step.channel ? find(step, message.channel) : message.channel;
        const miss = botMissing(guild, [P.SendMessages, P.ViewChannel], target); if (miss.length) return fail("create", `I can't post there: ${sayMissing(miss)}`);
        const made = await compose(step.request);
        const d = { ...made, colour: colourOf(step.request) ?? "#8d9bff" };
        const sent = await target.send(embedPost(d));
        if (!sent?.id) return fail("create", "Discord did not confirm that the embed was sent.");
        cur = { ...d, messageId: sent.id, channelId: target.id, at: Date.now() }; setDraft(message, cur);
        audit({ ...base("create"), ok: true, target: `#${target.name}`, ms: Date.now() - t0 });
      } else if (step.op === "colour" || step.op === "edit") {
        if (!cur) return false;
        const channel = guild.channels.cache.get(cur.channelId) ?? message.channel;
        const old = await channel.messages.fetch(cur.messageId).catch(() => null);
        if (!old || old.author.id !== message.client.user.id) return fail(step.op, "I can't find the embed I made any more (it may have been deleted). Ask me to make it again.");
        let d = { ...cur };
        if (step.op === "colour") d.colour = step.colour;
        else { const changed = await compose(step.request, cur); if (!changed) return fail("edit", "I couldn't reach my writing model just now, so I left the embed as it was. Try again in a minute."); d = { ...d, ...changed }; }
        const post = embedPost(d);
        await old.edit({ components: post.components, flags: post.flags });
        cur = d; setDraft(message, cur);
        audit({ ...base(step.op), ok: true, target: `#${channel.name}`, ms: Date.now() - t0 });
      } else if (step.op === "repost") {
        if (!cur) return false;
        const target = find(step, message.channel);
        if (target.id === cur.channelId && !step.channel && !step.name) return fail("repost", "It is already in this channel. Tell me which channel to post it in.");
        const miss = botMissing(guild, [P.SendMessages, P.ViewChannel], target); if (miss.length) return fail("repost", `I can't post in ${target}: ${sayMissing(miss)}`);
        const sent = await target.send(embedPost(cur));
        if (!sent?.id) return fail("repost", "Discord did not confirm that it was posted.");
        cur = { ...cur, messageId: sent.id, channelId: target.id }; setDraft(message, cur);
        audit({ ...base("repost"), ok: true, target: `#${target.name}`, ms: Date.now() - t0 });
        await message.channel.send({ content: `📣 Posted in ${target}.`, allowedMentions: { parse: [] } }).then(m => setTimeout(() => m.delete().catch(() => {}), 6000)).catch(() => {});
      } else if (step.op === "ping") {
        // The mention goes in a message of its own, in the channel the embed is in (or the one named), right below it.
        const target = step.channel || step.name ? find(step, message.channel) : cur ? guild.channels.cache.get(cur.channelId) ?? message.channel : message.channel;
        const everyone = step.mention === "@everyone" || step.mention === "@here";
        const role = everyone ? null : /^\d{15,}$/.test(step.mention) ? guild.roles.cache.get(step.mention) : findRole(guild, step.mention);
        if (!everyone && !role) return fail("ping", `I couldn't find a role called "${step.mention}", so I mentioned nobody.`);
        const miss = botMissing(guild, [P.SendMessages, P.ViewChannel, ...(everyone ? [P.MentionEveryone] : [])], target); if (miss.length) return fail("ping", `I can't mention them in ${target}: ${sayMissing(miss)}`);
        const sent = await target.send(everyone ? { content: step.mention, allowedMentions: { parse: ["everyone"] } } : { content: `<@&${role.id}>`, allowedMentions: { roles: [role.id] } });
        if (!sent?.id) return fail("ping", "Discord did not confirm that the mention was sent.");
        audit({ ...base("ping"), ok: true, target: `#${target.name} ${everyone ? step.mention : role.name}`, ms: Date.now() - t0 });
      }
    } catch (e) {
      console.warn("embed:", e?.message ?? e);
      return fail(step.op, /Missing (Permissions|Access)|50013|50001/.test(String(e?.message)) ? "Discord refused it: I'm missing a permission there." : "I couldn't finish that, so I stopped there.");
    }
  }
  return true;
}