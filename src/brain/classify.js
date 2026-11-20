/**
 * Intent classification, before any language model. Every message becomes one structured record:
 *   { primary, secondary[], action, resource, target{user,role,channel,ordinal,query}, params, refs[], needs[], clarify, confidence, source }
 * `primary` is what the owner wants to accomplish ("members.list"), `action` the tool that does it. Different requests that share words
 * ("members in this server" vs "server information" vs "how many members") get different intents, because the match is on what is being asked,
 * not on which words appear. What the classifier does not own comes back as primary "unknown" and goes to the language model as before.
 * Context (a draft, the last list, the last created channel) decides follow-ups such as "make it shorter" or "send it here".
 */

/* ── spelling: the few words that matter, tolerant of one slip (transposed or missing letters) ── */
const VOCAB = ["members", "member", "announcement", "announcements", "channel", "channels", "category", "categories", "server", "moderator", "moderators", "instructor", "instructors", "create", "delete", "private", "everyone", "online", "people", "role", "roles", "message", "shorter", "professional", "invite", "rename"];
export function osa(a, b) { // optimal string alignment distance (a swap of two letters counts once)
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
export function fixTypos(t) {
  return t.replace(/[a-z]{5,}/g, w => {
    if (VOCAB.includes(w)) return w;
    const hit = VOCAB.find(v => Math.abs(v.length - w.length) <= 1 && osa(v, w) <= (v.length >= 8 ? 2 : 1));
    return hit ?? w;
  });
}
const SLANG = [[/\bpls\b|\bplz\b|\bplease\b/g, " "], [/\bu\b/g, "you"], [/\bmsg\b/g, "message"], [/\bann\b/g, "announcement"], [/\bchnl\b|\bchan\b/g, "channel"], [/\bcat\b(?= called| named)/g, "category"], [/\bmods\b/g, "moderators"], [/\bwhos\b/g, "who is"], [/\bgimme\b/g, "give me"], [/\bwanna\b/g, "want to"], [/\bppl\b/g, "people"], [/\bsth\b/g, "something"], [/\brn\b/g, "right now"], [/\banyone\b(?= online| here| around| on)/g, "who is"], [/^(?:yo|hey|hi|hello|so|well)[, ]+/, ""], [/^(?:can|could|would|will) you\s+/, ""], [/^(?:i want you to|i need you to|i'd like you to|go ahead and)\s+/, ""]];
const prep = raw => String(raw ?? "").replace(/<@!?(\d{15,})>/g, " <@$1> ").toLowerCase().replace(/[“”]/g, '"').replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().replace(/[.!]+$/g, "").trim();
const slang = t => { for (const [re, to] of SLANG) t = t.replace(re, to); return t.replace(/\s+/g, " ").trim(); };
export function normalize(raw) { return fixTypos(slang(prep(raw))); }
/** The same, without the spelling correction: names (channels, roles) must keep the letters the owner typed. */
export const normalizeRaw = raw => slang(prep(raw));

const ORD = { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, fifth: 4, "5th": 4, last: -1 };
export function ordinalOf(t) {
  const w = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)\b(?:\s+(?:one|person|member|guy|user|name|human|result))?/.exec(t);
  if (w) return ORD[w[1]];
  const n = /\b(?:number|no\.?|nr\.?|num)\s*(\d{1,2})\b/.exec(t);
  return n ? Number(n[1]) - 1 : null;
}

/** The same words as the owner wrote them (names keep their capitals: "VIP", not "vip"). */
export const origCase = (original, s) => { if (!s) return s; const i = String(original).toLowerCase().indexOf(String(s).toLowerCase()); return i >= 0 ? String(original).slice(i, i + String(s).length) : s; };
const strip = s => { const r = String(s ?? "").replace(/^(the|a|an|our|this|that)\s+/, "").replace(/\s+(role|channel|category)$/, "").replace(/[?.!,"']+$/g, "").replace(/^["']/, "").trim(); return /^(role|channel|category|one)$/.test(r) ? "" : r; };
const singular = s => String(s).replace(/(ies)$/, "y").replace(/s$/, "");
const key = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const isTime = s => /^(tomorrow|today|tonight|this (morning|evening|afternoon|week|weekend)|next \w+|(on )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|the weekend|later|now)\b[\w ]*$/i.test(String(s).trim());
const TIMEY = /\b(tomorrow|today|tonight|next \w+|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const oneLine = (s, n = 300) => String(s ?? "").replace(/[​-‏⁠﻿]/g, "").replace(/\s+/g, " ").trim().slice(0, n);

const CHANNEL_WORDS = /\b(channels?|categor(?:y|ies)|private|public|read[- ]?only|hidden|visible|lock(?:ed)?|permissions?|access|roles?|members?|server)\b/;
const R = (primary, action, extra = {}) => ({ primary, secondary: [], action, resource: extra.resource ?? null, target: {}, params: {}, refs: [], needs: [], clarify: null, confidence: 0.9, source: "rule", ...extra });

/** What the words "it", "that", "them", "here" etc. refer to in this message. */
const refsIn = t => [...new Set([...t.matchAll(/\b(it|that|this|them|those|these|here|there|the previous one|the one above|the message above|the same)\b/g)].map(m => m[1]))];

/** A list of names from "announcements and discussion", "one for announcements and one for discussion", "a, b and c". */
export function namesFrom(text) {
  let t = String(text ?? "").toLowerCase().replace(/[.!?]+$/g, "");
  const pairs = [...t.matchAll(/\bone (?:for|called|named)\s+([\w -]+?)(?=\s*(?:,|\band\b|$))/g)].map(m => m[1].trim());
  if (pairs.length) return pairs;
  t = t.replace(/\b(call(?:ed)?|name(?:d)?|them|the|channels?|please|make|add|create|a|an)\b/g, " ").replace(/\s+/g, " ").trim();
  return t.split(/\s*(?:,|&|\+|\band\b)\s*/).map(s => s.trim().replace(/\s+/g, "-")).filter(s => s && s.length <= 60);
}

/** Which role a "who has <role>" style request means: a named role, or a bare noun that matches one of the server's roles. */
function roleOf(t, roleNames = []) {
  let m = /\b(?:with|has|have|having|holding|wearing)\s+(?:the\s+)?([\w &-]+?)\s+role\b/.exec(t) ?? /\bthe\s+([\w &-]+?)\s+role\b/.exec(t);
  if (m) return strip(m[1]);
  const noun = /\b(?:show|list|find|get|see|display|who (?:is|are)|who has)(?:\s+me)?\s+(?:all\s+|every\s+|the\s+|our\s+|everyone\s+(?:who\s+is\s+)?(?:a\s+|an\s+)?)*([a-z][\w &-]*?)\s*\??$/.exec(t);
  const cand = noun && strip(noun[1]);
  if (cand && roleNames.some(r => key(r) === key(cand) || key(r) === key(singular(cand)))) return cand;
  const bare = /^(?:the\s+|our\s+|all\s+the\s+)?([a-z][\w &-]*?)\s*\??$/.exec(t); // "i mean the moderators"
  if (bare && roleNames.some(r => key(r) === key(bare[1]) || key(r) === key(singular(bare[1])))) return strip(bare[1]);
  return null;
}

/* ── the members / server family ── */
const COUNT = /\bhow many\b.*\b(members?|people|users|accounts|humans)\b|\b(member|user) count\b|\bnumber of (members?|people|users)\b|\bhow big is\b.*\b(server|community|discord)\b|\bhow many of us\b/;
const ONLINE = /\bwho (?:is|are)\s+(?:currently\s+|all\s+)?online\b|\bwho is on(?:line)?\b|\bwho is (?:here|around|active)\b(?: right now)?|\bonline (?:members?|people|users)\b|\b(?:members?|people|users) (?:that are |who are )?online\b|\bwho(?:'s| is) (?:around|active) (?:right )?now\b|\bhow many (?:of us )?(?:are |people are |members are )?online\b/;
const OVERVIEW = /\bserver (?:info(?:rmation)?|overview|stat(?:s|istics)?|settings|details|summary|configuration|structure|profile)\b|\b(?:info(?:rmation)?|overview|details|summary|stat(?:s|istics)?|settings)\s+(?:about|of|on|for)\s+(?:the |this |our )?server\b|\btell me about (?:the |this |our )?server\b|\bserver owner\b|\bwho owns\b|\bboost (?:level|status)\b|\bhow is the server\b/;
const LIST_MEMBERS = [
  /^(?:the\s+|all\s+(?:the\s+)?|all\s+of\s+the\s+)?(?:server\s+)?(?:members?|people|users)(?:\s+list)?(?:\s+(?:in|of|on|from)\s+(?:the |this |our )?(?:server|discord|guild))?$/,
  /\b(?:show|list|display|get|give|see|find|pull up|fetch|print|dump|send)\b(?:\s+me)?(?:\s+only)?(?:\s+(?:all|every|each))?(?:\s+of)?(?:\s+(?:the|our|this))?\s*(?:server\s+)?(?:members?|people|users|everyone|everybody|humans|bots?)\b/,
  /\bwho(?:'s| is| are)?(?:\s+all)?\s+(?:in|on|inside|part of)\s+(?:the |this |our )?(?:server|discord|guild)\b/,
  /\b(?:everyone|everybody|all (?:the )?(?:members|people|users)|(?:the )?actual (?:people|members|users))\s+(?:in|on|inside|of)\s+(?:the |this |our )?(?:server|discord|guild)\b/,
  /\b(?:the )?actual (?:people|members|users|humans)\b/,
  /\bmembers?\s+(?:in|of|on)\s+(?:the |this |our )?(?:server|discord|guild)\b/,
  /\bwho are (?:the |our )?(?:(?:newest|latest|oldest|recent|first|last) )?(?:members|people|users)\b/,
];

/** The message's tail after a send verb: where it should go (one channel, several, "another", "the same as before", or here). */
function destination(tail) {
  if (/\b(another|a different|other|some other)\s+channel\b|\banywhere else\b/.test(tail)) return { other: true };
  if (/\bsame channel as (?:before|last time|earlier|the last)\b|\bwhere (?:i|you) (?:sent|posted) (?:it|that) (?:before|last time)\b/.test(tail)) return { sameAsBefore: true };
  if (/\b(?:to|in|into|on)\s*$/.test(tail)) return { dangling: true };
  const list = /\b(?:in|to|into|on|at)\s+(?:the\s+)?((?:<#\d+>|#?[\w-]+)(?:\s+channel)?(?:\s*(?:,|and|&)\s*(?:the\s+)?(?:<#\d+>|#?[\w-]+)(?:\s+channel)?)+)\s*(?:instead|too|as well)?\s*$/.exec(tail);
  if (list) { const names = list[1].split(/\s*(?:,|\band\b|&)\s*/).map(x => x.replace(/^(?:the\s+)/, "").replace(/\s+channel$/, "").replace(/^#/, "").trim()).filter(Boolean); if (names.length > 1 && !names.some(n => /^(here|it|that|this|too|instead|again)$/.test(n))) return { channels: names }; }
  const m = /\b(?:in|to|into|on|at)\s+(?:the\s+)?(<#\d+>|#?[\w-]+)(?:\s+channel)?(?:\s+(?:instead|too|as well))?\s*$/.exec(tail) ?? /\b(?:in|to|into|on)\s+(?:the\s+)?(<#\d+>|#?[\w-]+)(?:\s+channel)?\b/.exec(tail);
  if (m && !/^(here|there|it|that|this|too|instead|again)$/.test(m[1]) && !TIMEY.test(m[1])) return { channel: m[1].replace(/^#/, "") };
  if (/\b(here|this channel|this one|in here)\b/.test(tail)) return { here: true };
  return {};
}

const NOUN = "(?:it|that|this|the announcement|the draft|the message|the post|the latest(?: version)?|the revised(?: version)?|the new version|the final version|the same (?:announcement|message|post|thing))";
const SEND_RE = new RegExp(`^(?:now |ok(?:ay)?[, ]+|and |then |go ahead and )*(send|post|publish|share|drop|put)\\s+${NOUN}\\b(.*)$`);
const SEND_BARE = /^(?:now |ok(?:ay)?[, ]+|and |then )*(?:send|post|publish)(?:\s+(?:it|that))?(?:\s+((?:in|to|into|here)\b.*))?$/;

/**
 * Classifies one message. `ctx`: { convo, roleNames, channelNames, draft }. The conversation state decides follow-ups; with none, a bare
 * "send it" has nothing to refer to and is left to the existing path.
 */
export function classify(raw, ctx = {}) {
  const convo = ctx.convo ?? {}, roleNames = ctx.roleNames ?? [], draft = ctx.draft ?? null;
  const original = String(raw ?? "").trim().slice(0, 500); // intents are short; a very long message is never a command, and capping it keeps matching fast
  const t = normalize(original), t0 = normalizeRaw(original);
  if (!t) return R("unknown", null, { confidence: 0 });
  const refs = refsIn(t);
  const out = x => ({ ...x, refs: x.refs?.length ? x.refs : refs, text: t });

  /* the owner's earlier corrections in this conversation: the same words mean what they were corrected to */
  const learned = (convo.corrections ?? []).find(c => c.phrase === t && c.right);
  if (learned) return out({ ...R(learned.right.primary, learned.right.action, { params: learned.right.params ?? {}, target: learned.right.target ?? {}, confidence: 0.95 }), via: "learned correction" });

  /* a correction: "no, I mean ...", "I said X, not Y", "wrong channel, send it in X", "not here, in staff", "sorry I meant X" */
  const said = /^(?:no[, ]+)?i (?:said|meant|mean)\s+(?:the\s+)?(?:channel\s+)?#?([\w-]+?),?\s+(?:and )?not\s+(?:the\s+)?#?([\w-]+)/.exec(t0);
  if (said) {
    if (roleNames.some(r => key(r) === key(said[1]) || key(r) === key(singular(said[1])))) return out({ ...R("members.byRole", "member_list", { resource: "members", target: { role: said[1] }, params: { role: said[1] } }), correction: true, secondary: ["correction"] });
    return out(R("correction.channel", "resend_to", { correction: true, target: { channel: said[1] }, params: { wrong: said[2] } }));
  }
  const sentBefore = draft?.sent?.length > 0 || convo.lastIntent?.primary === "draft.send";
  const redirect = /^(?:wrong channel|not here|no|nope|sorry|oops)[, ]+(?:i (?:meant|mean)\s+)?(?:(?:send|post|put) (?:it |that )?)?(?:in |to |into )?(?:the )?#?([\w-]+?)(?: channel)?$/.exec(t0);
  if (redirect && sentBefore && !/^(?:it|that|this|here|there|one|again|members|people|roles|channels|them|how many|list)$/.test(redirect[1]) && (ctx.channelNames?.some(n => key(n) === key(redirect[1])) || /^(?:wrong channel|not here)/.test(t0) || /^(?:sorry|oops)/.test(t0) || /\b(?:in|to) /.test(t0))) return out(R("correction.channel", "resend_to", { correction: true, target: { channel: redirect[1] }, params: { wrong: null } }));
  const fix = /^(?:no|nope|nah|not that|wrong|that'?s wrong|that is wrong|sorry|oops|that'?s not (?:what i (?:asked|meant|said)|it|right))\b[,.!:;\s-]*(?:i (?:meant|mean|said|wanted|want)\s*|what i (?:meant|mean) (?:is|was)\s*|i was asking (?:for|about)\s*)?(.*)$/.exec(t) ?? /^i (?:meant|mean)\s+(.*)$/.exec(t);
  if (fix && fix[1]?.trim()) {
    const rest = fix[1].trim(), last = convo.lastIntent?.primary ?? "", variants = [rest, `show me ${rest}`, `list ${rest}`];
    if (/^(?:how many|the count|a count|count)$/.test(rest) || /^how many$/.test(rest)) variants.unshift("how many members");
    if (/^(?:list them|list|show them|them|the list)$/.test(rest) && /^members\./.test(last)) variants.unshift("show me the members");
    for (const v of variants) {
      const inner = classify(v, { ...ctx, correcting: true });
      if (inner.primary !== "unknown" && inner.primary !== "draft.write") return { ...inner, correction: true, secondary: ["correction"], text: t };
    }
  }

  /* memory commands */
  let m = /^remember\s+(?:that\s+)?(.+)$/.exec(t0) ?? /^(?:from now on|going forward|in future|from here on)[, ]+(.+)$/.exec(t0) ?? /^always\s+(.+)$/.exec(t0);
  if (m) { const body = /^always\s/.test(t0) ? "always " + m[1] : m[1]; return out(R("memory.remember", "memory_remember", { params: { text: oneLine(origCase(original, body), 240) } })); }
  m = /^forget\s+(?:about\s+|that\s+)?(.+)$/.exec(t0);
  if (m) return out(R("memory.forget", "memory_forget", { params: { text: m[1] } }));
  if (/^what do you (?:remember|know) about me\b|^what have you (?:remembered|saved)\b|^show (?:me )?(?:my )?(?:saved )?preferences\b|^what (?:announcement |writing )?(?:style|format) do i (?:like|prefer|want)\b|^what (?:are )?my preferences\b/.test(t0)) return out(R("memory.show", "memory_show"));

  /* several operations in one message */
  const compound = classifyCompound(t, original, ctx);
  if (compound) return out(compound);
  const multi = ctx.noMulti ? null : classifyMulti(original, ctx);
  if (multi) return out(multi);

  /* drafts: write, approve, revise, restore, show, send, edit, pin, delete */
  const write = /\b(?:write|draft|compose|create|make|prepare|put together|give me|do)\s+(?:me\s+)?(?:an?|the|another|new)?\s*(?:new\s+|short\s+|quick\s+|professional\s+)?(announcement|post(?!-)|notice|update message|message for the (?:server|community|members))\b(.*)$/.exec(t);
  const writeLoose = !write && !CHANNEL_WORDS.test(t) ? /\b(?:write|draft|compose|make|do)\s+(?:me\s+)?(?:something|another(?: one)?|one more|a new one)\b\s*((?:announcing|about|for|saying)\b.*)$/.exec(t) : null;
  if ((write && !/\b(channel|category|role|poll|event|invite)\b/.test(t.slice(0, write.index + write[0].length - write[2].length))) || writeLoose) {
    const tail = (write ? write[2] : writeLoose[1]).trim();
    let topic = null, when = null;
    const sameFormat = /\b(?:use |in )?the same (?:format|style|structure|layout) as (?:last time|before|the last one|the previous one|earlier)\b/.test(tail);
    const body = tail.replace(/[, ]*(?:and )?(?:use |in )?the same (?:format|style|structure|layout) as (?:last time|before|the last one|the previous one|earlier)\b/, "").trim();
    const about = /^(?:about|on|regarding|announcing|saying(?: that)?|that says|to say|telling (?:them|everyone) (?:that )?)\s+(.+)$/.exec(body) ?? /^for\s+(.+)$/.exec(body);
    if (about) { if (isTime(about[1])) when = about[1]; else topic = oneLine(origCase(original, about[1])); }
    return out(R("draft.write", "draft_write", { resource: "draft", params: { topic, when, sameFormat: sameFormat || undefined }, needs: topic ? [] : ["topic"], clarify: topic ? null : "What is the announcement about?" }));
  }
  m = SEND_RE.exec(t0) ?? /^(?:now |and |then )*(?:make|send|post) (?:the )?same (?:announcement|message|post)\b(.*)$/.exec(t0) ?? /^(?:now |and |then )*(?:send|post) (?:the )?same thing\b(.*)$/.exec(t0);
  if (m) { const tail = (m[2] ?? m[1] ?? "").trim(); return out(R("draft.send", "message_send", { resource: "draft", target: destination(tail), params: { tail }, needs: [], confidence: draft ? 0.95 : 0.7 })); }
  if (draft && (m = SEND_BARE.exec(t0))) { const tail = (m[1] ?? "").trim(); return out(R("draft.send", "message_send", { resource: "draft", target: destination(tail), params: { tail }, confidence: 0.9 })); }
  if (/^(?:now |and |also |then )*pin\s+(?:it|that|this|the (?:message|announcement|post)(?: (?:you|i) (?:just )?(?:sent|posted))?|the one (?:you|i) (?:just )?sent)(?:\s+(?:too|as well))?$/.test(t)) return out(R("message.pin", "message_pin", { resource: "message" }));
  m = /^(?:now |and |also |then )*(?:delete|remove|erase|get rid of)\s+the (?:one|message|announcement|post) (?:in|from|on)\s+(?:the\s+)?#?([\w-]+?)(?: channel)?$/.exec(t0);
  if (m) return out(R("message.delete", "message_remove", { resource: "message", params: { which: "in", channel: m[1] } }));
  if (/^(?:now |and |also |then )*(?:delete|remove|erase|get rid of)\s+(?:it|that|this|the (?:previous|last|latest|earlier|old|first) (?:one|message|version|announcement|post)|the previous one|the (?:message|announcement|post) (?:above|i (?:just )?sent|you (?:just )?sent)|the one (?:you|i) (?:just )?sent)(?:\s+(?:too))?$/.test(t)) return out(R("message.delete", "message_remove", { resource: "message", params: { which: /\b(previous|earlier|old|first)\b/.test(t) ? "previous" : /\b(last|latest)\b/.test(t) ? "last" : "that" } }));
  if (/^(?:now |and |also )*(?:edit|update|change|fix)\s+(?:the one|the message|the announcement|that one|it)\s*(?:(?:that )?(?:you|i) (?:just )?(?:sent|posted)|above)?(?:\s+(?:with|to|so)\b.*)?$/.test(t) && !/\bchannel\b/.test(t) && (draft?.sent?.length || /\b(sent|posted|above|the one|the message)\b/.test(t))) return out(R("message.edit", "message_update", { resource: "message", params: { instruction: /\b(?:with|to|so)\s+(.+)$/.exec(t)?.[1] ?? null } }));
  if (draft && /^(?:perfect|great|good|nice|awesome|excellent|love it|looks (?:good|great|perfect)|that'?s? (?:it|perfect|great|good|better)|approved?|done|ship it|that works|that'?s fine|fine|(?:yes|yeah|yep|yup)[, ]*(?:that'?s?(?: the one| it| good| great| right| perfect)?|that works|good|perfect|approved?))$/.test(t)) return out(R("draft.approve", "draft_approve", { resource: "draft" }));
  if (draft && /^(?:show|display|read|what'?s|let me see|see)(?: me)?\s+(?:the\s+)?(?:current\s+)?draft(?: again)?$/.test(t)) return out(R("draft.show", "draft_show", { resource: "draft" }));
  m = /^(?:now |and |also )*(?:use|go back to|restore|bring back|revert to|switch back to)\s+(?:the\s+)?(previous|last|earlier|first|original|approved|old)(?: one| version| draft)?(?:\s+(?:one|version|draft))?(?:\s+(?:i|you) (?:approved|liked|had))?$/.exec(t) ?? /^(?:now |and |also )*(?:use|go back to|restore) (?:the )?version (?:i|you) (approved)$/.exec(t);
  if (draft && m) return out(R("draft.restore", "draft_restore", { resource: "draft", params: { which: m[1] } }));

  /* explicit permission requests: "give everyone view access to all channels", "let the VIP role see #lessons", "hide all channels from everyone" */
  const ALL = /^(?:all(?: of)?(?: the)?(?: channels?)?|every(?: ?channel)?|everything|all of them|the channels|channels)$/;
  const scopeOf = txt => { const s = String(txt ?? "").replace(/^(?:to|for|on|in|of|from)\s+/, "").trim(); if (!s) return {}; if (ALL.test(s)) return { all: true }; const o = ordinalOf(s); const names = s.split(/\s*(?:,|\band\b|&)\s*/).map(x => x.replace(/^(?:the\s+)/, "").replace(/\s+channels?$/, "").replace(/^#/, "").trim()).filter(x => x && ordinalOf(x) == null && !/^(this|that|these|those)$/.test(x)); return { ordinal: o, channels: names.length ? names : undefined, here: /^(?:this|that)(?: channel| one)?$/.test(s) || undefined }; };
  const roleArg = txt => { const s = String(txt ?? "").trim(); if (!s || /^(everyone|everybody|@everyone|all|all members|the public|them)$/.test(s)) return null; return strip(s.replace(/\s+role$/, "")) || null; };
  m = /^(?:now |and |also |ok(?:ay)?[, ]+)*(?:give|let|allow|grant|restore)\s+(everyone|everybody|@everyone|[\w &-]+?)\s+(?:the\s+)?(?:view(?:ing)? access|access|permission to (?:view|see)|(?:view|see) (?:permission|access)|view)\s*(.*)$/.exec(t0) ?? /^(?:now |and |also |ok(?:ay)?[, ]+)*(?:let|allow)\s+(everyone|everybody|@everyone|[\w &-]+?)\s+(?:see|view)\s+(.+)$/.exec(t0) ?? /^(?:now |and |also |ok(?:ay)?[, ]+)*make\s+(all(?: the)?(?: channels?)?|every ?channel)\s+(?:visible|public)(?:\s+(?:to|for)\s+(everyone|everybody|@everyone|[\w &-]+))?$/.exec(t0);
  if (m && !/\b(create|channel called|invite|role called)\b/.test(t0) && !/^give (?:me|him|her|them)\b/.test(t0)) { const lead = m[1]; const swapped = ALL.test(lead); const scope = scopeOf(swapped ? lead : m[2]); return out(R("permission.grant", "permission_change", { resource: "permission", target: { ...scope, role: roleArg(swapped ? m[2] : lead) }, params: { what: "grant", explicit: true } })); }
  m = /^(?:now |and |also |ok(?:ay)?[, ]+)*(?:remove|revoke|take away|take|stop)\s+(?:the\s+)?(?:view(?:ing)? access|view permission|access|permission to (?:view|see)|view)\s+(?:from|for|of)\s+(everyone|everybody|@everyone|[\w &-]+?)(?:\s+(?:to|on|in|from|for)\s+(.+))?$/.exec(t0) ?? /^(?:now |and |also |ok(?:ay)?[, ]+)*(?:hide|lock|make private)\s+(all(?: of)?(?: the)?(?: channels?)?|every ?channel|everything)(?:\s+from\s+(everyone|everybody|@everyone|[\w &-]+))?$/.exec(t0) ?? /^(?:now |and |also |ok(?:ay)?[, ]+)*(?:stop|don'?t let)\s+(everyone|everybody|@everyone|[\w &-]+?)\s+(?:from\s+)?(?:seeing|viewing|see|view)\s+(.+)$/.exec(t0);
  if (m && !/\b(create|invite)\b/.test(t0)) { const lead = m[1]; const swapped = ALL.test(lead); const scope = scopeOf(swapped ? lead : m[2]); return out(R("permission.revoke", "permission_change", { resource: "permission", target: { ...scope, role: roleArg(swapped ? m[2] : lead) }, params: { what: "revoke", explicit: true } })); }

  /* a channel's access: refers to the channel just made, or the one named */
  m = /^(?:now |and |also |then |actually[, ]+|no[, ]+)*(?:make|set|turn|keep)\s+(it|that one|this one|that channel|this channel|the channel|that category|the category|them|that|this|(?:the )?#?[\w-]+ (?:channel|category))\s+(?:to be\s+)?(private|public|read[- ]?only|hidden|visible|locked)\b(.*)$/.exec(t);
  if (m) {
    const roles = /\b(?:for|to|only for|only|so only)\s+(?:the\s+)?([\w &,-]+?)(?:\s+(?:role|can see(?: it)?|only))*\s*$/.exec(m[3])?.[1];
    const named = /^(it|that one|this one|that channel|this channel|the channel|that category|the category|them|that|this)$/.test(m[1]) ? null : strip(m[1]).replace(/^#/, "");
    const mode = m[2].replace(/[- ]/g, "_").replace("readonly", "read_only").replace("hidden", "private").replace("locked", "read_only").replace("visible", "public");
    return out(R("channel.access", "channel_access", { resource: "channel", target: { channel: named || null }, params: { access: mode, roles: roles ?? null } }));
  }
  m = /^(?:now |and |also |then )*hide\s+(it|that one|that channel|this channel|the channel|that|this)(?:\s+from\s+(?:everyone|everybody|@everyone|all))?$/.exec(t);
  if (m) return out(R("channel.access", "channel_access", { resource: "channel", target: { channel: null }, params: { access: "private", roles: null } }));
  m = /\b(?:give|grant|allow)\s+(?:the\s+)?(?:access\s+to\s+(?:the\s+)?)?([\w &,-]+?)(?:\s+role)?(?:\s+access)?(?:\s+(?:to|for)\s+(?:it|that|this|them))?\s*$/.exec(t);
  if (m && /\baccess\b/.test(t) && !/\bcreate\b|\bmake a\b/.test(t)) return out(R("channel.access", "channel_access", { resource: "channel", params: { access: "private", roles: strip(m[1]) } }));

  /* roles on people: "give it to the second member", "give <@id> the Mentor role", "take it off the first one" */
  m = /^(?:now |and |also )*(?:give|assign|add|grant)\s+(<@\d+>|him|her|them)\s+(?:the\s+)?([\w &-]+?)(?:\s+role)?$/.exec(t);
  if (m) return out(R("role.assign", "role_assign", { resource: "member", target: { role: strip(m[2]) || null, user: m[1], ordinal: null } }));
  m = /^(?:now |and |also )*(give|assign|add|grant)\s+(.+?)\s+to\s+(.+)$/.exec(t);
  if (m && !/\baccess\b/.test(t) && /^(?:<@\d+>|him|her|them|that (?:person|guy|member|user)|(?:the )?(?:first|second|third|fourth|fifth|last)\b.*|(?:number|no\.?|num)\s*\d+.*|(?:the )?\d+(?:st|nd|rd|th)\b.*|#?\d+)$/.test(m[3].replace(/\bfrom (?:the|that|this) list\b/, "").trim())) {
    const roleText = /^(it|that|this)$/.test(m[2]) ? null : strip(m[2]) || null, who = m[3].replace(/\bfrom (?:the|that|this) list\b/, "").trim();
    return out(R("role.assign", "role_assign", { resource: "member", target: { role: roleText, user: who, ordinal: ordinalOf(who) } }));
  }
  m = /^(?:now |and |also )*(?:give|assign|grant)\s+(?!me\b)(?:the\s+)?([\w &-]+?)\s+role$/.exec(t);
  if (m && !/\baccess\b/.test(t)) return out(R("role.assign", "role_assign", { resource: "member", target: { role: strip(m[1]) || null, user: null, ordinal: null } }));
  m = /^(?:now |and |also )*(?:remove|take|revoke|strip)\s+(?:the\s+|that\s+)?([\w &-]*?)\s*role\s+(?:from|off)\s+(.+)$/.exec(t) ?? /^(?:now |and |also )*(?:remove|take away|revoke|take)\s+(it|that)\s+(?:from|off)\s+(.+)$/.exec(t);
  if (m) {
    const who = m[2].replace(/\bfrom (?:the|that|this) list\b/, "").trim(), role = m[1] && !/^(it|that|the|this)$/.test(m[1]) ? strip(m[1]) || null : null;
    return out(R("role.remove", "role_assign", { resource: "member", target: { role, user: who, ordinal: ordinalOf(who) }, params: { remove: true } }));
  }

  /* renaming and deleting channels */
  m = /^(?:now |and |also |actually[, ]+)*(?:rename|change|edit)\s+(it|that|this|(?:the )?(?:first|second|third|fourth|fifth|last)(?: one| channel)?|(?:number|no\.?|num)\s*\d+|(?:the |that |this )?(?:channel|category))(?:\s+(?:to|into)\s+(.+))?$/.exec(t0);
  if (m && (/^(?:rename)\b/.test(t0) || !/^(?:it|that|this)$/.test(m[1]) || !draft)) return out(R("channel.rename", "channel_rename", { resource: "channel", target: { ordinal: ordinalOf(m[1]), channel: /^(it|that|this|(?:the |that |this )?(?:channel|category))$/.test(m[1]) || ordinalOf(m[1]) != null ? null : m[1] }, params: { name: m[2] ? oneLine(m[2], 90).replace(/\s+/g, "-") : null }, needs: m[2] ? [] : ["name"], clarify: m[2] ? null : "What should it be renamed to?" }));
  m = /^(?:now |and |also )*(?:delete|remove)\s+(it|that|this|(?:the |that |this )?(?:channel|category)|#[\w-]+|<#\d+>)$/.exec(t0);
  if (m && /channel|category|#|<#/.test(m[1])) return out(R("channel.delete", "delete_channel", { resource: "channel", target: { channel: /^(?:it|that|this|(?:the |that |this )?(?:channel|category))$/.test(m[1]) ? null : m[1].replace(/^#/, "") } }));
  if (/^(?:continue|resume|carry on|pick up)(?: where (?:we|i) (?:stopped|left off|were)| from before| that| again)?$/.test(t)) return out(R("context.resume", "context_resume"));

  /* a permission that was just shown: "remove that permission", "take it away from everyone", "give it back" */
  const showedPermission = convo.focus?.type === "permission";
  const permTarget = txt => { if (!txt) return {}; const o = ordinalOf(txt); const names = txt.split(/\s*(?:,|\band\b|&)\s*/).map(x => x.replace(/^(?:the\s+)/, "").replace(/\s+channels?$/, "").replace(/^#/, "").trim()).filter(x => x && !/^(everyone|everybody|@everyone|all|them|those|these|it|that|this|all of them|every channel|all channels)$/.test(x) && ordinalOf(x) == null); return { ordinal: o, channels: names.length ? names : undefined }; };
  m = /^(?:now |and |also |ok(?:ay)?[, ]+)*(?:remove|revoke|take away|take off|disable|turn off|delete|get rid of|cancel)\s+(?:that|this|those|these|the|it)\s+(?:permission|access|view access|visibility|view|right)s?(?:\s+(?:from|for|on|in)\s+(.+))?$/.exec(t0) ?? (showedPermission ? /^(?:now |and |also |ok(?:ay)?[, ]+)*(?:undo (?:it|that)|revert (?:it|that)|take (?:it|that|them) (?:away|off)|remove (?:it|that|them)|revoke (?:it|that)|turn (?:it|that) off|hide (?:them|those|these|it all)|make (?:them|those|these) (?:private|hidden)|take (?:it|that|them) away again)(?:\s+(?:from|for|on|in)\s+(.+))?$/.exec(t0) : null);
  if (m) return out(R("permission.revoke", "permission_change", { resource: "permission", target: permTarget(m[1]), params: { what: "revoke" } }));
  m = /^(?:now |and |also |ok(?:ay)?[, ]+)*(?:give|restore|add|grant|allow|bring)\s+(?:that|this|those|these|the|it)\s+(?:permission|access|view access|visibility|view|right)s?(?:\s+back)?(?:\s+(?:to|for|on|in)\s+(.+))?$/.exec(t0) ?? (showedPermission ? /^(?:now |and |also |ok(?:ay)?[, ]+)*(?:give (?:it|that|them) back|put (?:it|that|them) back|add (?:it|that|them) back|bring (?:it|that|them) back|restore (?:it|that|them)|re-?add (?:it|that|them)|turn (?:it|that|them) back on|re-?enable (?:it|that|them)|return (?:it|that|them)|undo (?:that|it)|let (?:them|everyone) see (?:them|it|those)|add (?:it|that|them) again|do the opposite)(?:\s+(?:to|for|on|in)\s+(.+))?$/.exec(t0) : null);
  if (m) return out(R("permission.grant", "permission_change", { resource: "permission", target: permTarget(m[1]), params: { what: "grant" } }));
  m = /^(?:now |and |also )*(?:hide|make private)\s+(?:the\s+)?((?:first|second|third|fourth|fifth|last)(?: one| channel)?|(?:number|no\.?)\s*\d+)(?:\s+from\s+(?:everyone|everybody))?$/.exec(t0);
  if (m) return out(R("channel.access", "channel_access", { resource: "channel", target: { channel: null, ordinal: ordinalOf(m[1]) }, params: { access: "private", roles: null } }));

  /* creating things */
  m = /\b(create|make|add|new|set up|build|put)\b\s+(?:an?\s+|the\s+|another\s+)?(?:new\s+)?(.*)$/.exec(t0);
  if (m) {
    const rest = m[2], verb = m[1], restFixed = /\b(create|make|add|new|set up|build|put)\b\s+(?:an?\s+|the\s+|another\s+)?(?:new\s+)?(.*)$/.exec(t)?.[2] ?? rest;
    if (!/\b(poll|event|invite|message|announcement|post(?!-)|reminder|ticket|warning|draft)\b/.test(restFixed)) {
      const chFirst = /^(?:(?:private|public|read[- ]?only|text|voice|forum|stage)\s+)*(?:\d+\s+|two\s+|three\s+|four\s+|five\s+|some\s+|a few\s+|several\s+)?channels?\b/.test(restFixed);
      const cat = !chFirst && (/^(?:(private|public|read[- ]?only)\s+)?(?:(?:category\s+(?:called|named)\s+["']?([\w &-]+?)["']?|([\w &-]+?)\s+category)(?:\s+(?:called|named)\s+["']?([\w &-]+?)["']?)?)(?=\s+(?:and|with|that|for|which)\b|[,.]|$)/.exec(rest) ?? /^(?:(private|public)\s+)?category\b(?:\s+(?:called|named)\s+["']?([\w &-]+?)["']?)?\s*$/.exec(rest));
      if (cat) {
        const name = cat[2] ?? cat[4] ?? (cat[3] && !/^(a|an|new|private|public)$/.test(cat[3]) ? cat[3] : null);
        const priv = /\bprivate\b/.test(t) || /private/.test(cat[1] ?? "");
        return out(R("category.create", "channel_create", { resource: "category", params: { kind: "category", name: name ? origCase(original, strip(name)) : null, private: priv || undefined }, needs: name ? [] : ["name"], clarify: name ? null : "What should I name it?" }));
      }
      const many = /^(?:(private|public|read[- ]?only)\s+)?(?:(text|voice|forum|stage)\s+)?channels\s+(?:called|named)\s+(.+)$/.exec(rest);
      if (many) { const names = namesFrom(origCase(original, many[3])); if (names.length > 1) return out(R("channel.create", "channel_create", { resource: "channel", params: { kind: many[2] ?? "text", names, private: /\bprivate\b/.test(t) || undefined, intoFocus: /^(?:add|put)$/.test(verb), count: names.length, many: true } })); }
      const ch = /^(?:(private|public|read[- ]?only)\s+)?(?:(text|voice|forum|stage)\s+)?(?:(?:two|three|four|five|\d|some|a few|several)\s+)?(?:(?:channel\s+(?:called|named)\s+["']?([\w #&-]+?)["']?)|([\w -]+?)\s+channels?(?:\s+(?:called|named)\s+["']?([\w #&-]+?)["']?)?|channels?(?:\s+(?:called|named))?)(?=\s+(?:and|with|that|for|which|in|inside|under|to|into)\b|[,.]|$)(.*)$/.exec(rest);
      if (ch) {
        const tail = ch[6] ?? "";
        const kind = (ch[2] ?? "text").replace(/s$/, ""), many = /^(?:two|three|four|five|2|3|4|5|some|a few|several)\s/.test(rest);
        let named = ch[3] ?? ch[5] ?? (ch[4] && !/^(a|an|new|private|public|text|voice|read-only|two|three|four|five|some|several|a few|\d)$/.test(ch[4]) ? ch[4] : null);
        const priv = /\bprivate\b/.test(t) || /private/.test(ch[1] ?? "");
        const forWho = !named && /^\s*for\s+(?:the\s+)?([\w-]+)\s*$/.exec(tail)?.[1];
        if (forWho) named = forWho;
        const inCat = /\b(?:in|inside|under)\s+(?:the\s+)?([\w &-]+?)\s+category\b/.exec(tail + " " + t0)?.[1];
        const intoFocus = /^(?:add|put)$/.test(verb) || /\b(?:in|inside|under|into)\s+(?:it|that|there|that category|this category|the category)\b/.test(t) || /\bto (?:it|that category|the category)\b/.test(t) || /\bin there\b/.test(t);
        const cnt = /^(two|three|four|five|2|3|4|5)\b/.exec(rest)?.[1];
        const count = cnt ? ({ two: 2, three: 3, four: 4, five: 5 }[cnt] ?? Number(cnt)) : null;
        return out(R("channel.create", "channel_create", { resource: "channel", params: { kind: kind === "announcement" ? "announcement" : kind, name: named ? origCase(original, strip(named).replace(/^#/, "")) : null, private: priv || undefined, category: inCat ? origCase(original, strip(inCat)) : undefined, intoFocus, count, many }, needs: named ? [] : ["name"], clarify: named ? null : count && count > 1 ? `What should the ${count} channels be called?` : "What should the channel be called?" }));
      }
      const role = /^(?:(?:role\s+(?:called|named)\s+["']?([\w &-]+?)["']?)|([\w &-]+?)\s+role(?:\s+(?:called|named)\s+["']?([\w &-]+?)["']?)?|role\s+([\w &-]+?)|role)(?=\s+(?:and|with|that|for|colou?r)\b|[,.]|$)/.exec(rest);
      if (role) {
        const name = role[1] ?? role[3] ?? role[4] ?? (role[2] && !/^(a|an|new)$/.test(role[2]) ? role[2] : null);
        return out(R("role.create", "role_create", { resource: "role", params: { name: name ? origCase(original, strip(name)) : null }, needs: name ? [] : ["name"], clarify: name ? null : "What should the role be called?" }));
      }
    }
  }

  /* the members / server family: different intents, different tools */
  const generic = /\b(typical|average|usually|generally|should|ideal|good|best|most)\b/.test(t);
  if (COUNT.test(t) && !generic) return out(R("members.count", "member_count", { resource: "members" }));
  if (ONLINE.test(t)) return out(R("members.online", "member_online", { resource: "members" }));
  m = /^(?:find|search(?: for)?|look ?up)\s+(?:the\s+)?(?:a\s+)?(?:member|user|person)\s+@?([\w.\-]{2,32})$/.exec(t0) ?? /^(?:find|search(?: for)?|look ?up|who is|who'?s)\s+@?([\w.\-]{2,32})$/.exec(t0) ?? /^is\s+@?([\w.\-]{2,32})\s+(?:in|on|part of)\s+(?:the |this |our )?(?:server|discord|guild)\??$/.exec(t0);
  if (m && !/^(online|here|there|everyone|everybody|that|this|it|in|on|members|people|users)$/.test(m[1])) return out(R("members.search", "member_list", { resource: "members", params: { query: m[1] }, target: { query: m[1] } }));
  const role = roleOf(t, roleNames);
  const withRoleWord = /\b(?:everyone|everybody|people|members?|users|who|anyone|someone)\b.*\b(?:with|has|have|having)\s+(?:the\s+)?[\w &-]+?\s+role\b|\bwho (?:has|have|is)\s+(?:the\s+)?[\w &-]+?\s+role\b|\bmembers? (?:of|in) (?:the\s+)?[\w &-]+?\s+role\b|\b(?:show|list|find|get|see)\b[^\n]*?\brole (?:members?|people|holders)\b|\bwho(?:'s| is)? (?:a |an |the )?(?:moderator|instructor|admin)s?\b/.test(t);
  if (role && !/\bchannels?\b/.test(t) && (withRoleWord || /^(?:show|list|find|get|see|display|who|everyone|the|our|all)\b/.test(t) || ctx.correcting || /^(?:the\s+|our\s+)?[a-z][\w &-]*$/.test(t))) return out(R("members.byRole", "member_list", { resource: "members", target: { role }, params: { role }, tools: ["member_list"] }));
  if (withRoleWord) { const named = /\b(?:with|has|have|having|is)\s+(?:the\s+)?([\w &-]+?)\s+role\b/.exec(t)?.[1]; if (named) return out(R("members.byRole", "member_list", { resource: "members", target: { role: strip(named) }, params: { role: strip(named) } })); }
  if (OVERVIEW.test(t)) return out(R("server.overview", "server_overview", { resource: "server" }));
  if (LIST_MEMBERS.some(re => re.test(t)) && !/\b(create|make|add|delete|remove|ban|kick|mute|timeout|assign)\b/.test(t) && !/\bgive (?!me\b)/.test(t) && !generic) {
    const q = /\b(?:named|called|matching|with (?:the )?(?:name|username)|whose name (?:has|contains)|starting with|containing)\s+["']?([\w.\-]+)["']?/.exec(t)?.[1];
    const bots = /\bbots?\b/.test(t) && !/\bhumans?\b/.test(t) ? "bots" : /\b(humans?|real people|non[- ]?bots?)\b/.test(t) ? "humans" : undefined;
    const sort = /\b(newest|latest|most recent)\b/.test(t) ? "newest" : /\b(oldest|longest)\b/.test(t) ? "joined" : undefined;
    return out(R("members.list", "member_list", { resource: "members", params: { query: q, kind: bots, sort } }));
  }

  /* who can see which channels: "which channels can everyone see", "which channels are private", "what can the VIP role see", "who can see this channel" */
  if (/^(?:which|what|who|show|list|see|display|tell me|permissions?)\b/.test(t) && !/\b(create|make|set|give|delete|rename|move|hide|lock|add)\b/.test(t)) {
    const visWords = /\b(view|see|seen|access|read|visible|invisible|private|hidden|public|locked|restricted|open to)\b/;
    if ((/\b(?:channels?|categor(?:y|ies))\b/.test(t) && visWords.test(t) && !/^who\b|\b(?:this|that) channel\b|^permissions?\b/.test(t)) || /^what can (?:everyone|everybody|@everyone|the [\w &-]+ role|[\w&-]+) (?:see|view|access)\b/.test(t)) {
      const mode = /\bread[- ]?only\b/.test(t) ? "readonly" : /\b(private|hidden|invisible|locked|restricted|can'?t see|cannot see|not visible)\b/.test(t) ? "hidden" : "visible";
      const mentioned = roleNames.find(r => key(r) && key(t).includes(key(r)) && !/^(everyone)$/i.test(r));
      const who = /\b(everyone|everybody|@everyone|all members|the public)\b/.test(t) || !mentioned ? null : mentioned;
      return out(R("channels.visibility", "channel_visibility", { resource: "channels", target: { role: who }, params: { role: who ?? undefined, mode } }));
    }
    if (/^(?:who|which roles?|what roles?)\s+(?:can|could)\s+(?:see|view|access|write in|post in)\s+(?:this channel|that channel|this one|here|#[\w-]+|<#\d+>)/.test(t) || /^(?:permissions? (?:of|for)|what are the permissions (?:of|for)|who has access to)\s+(?:this channel|that channel|here|#[\w-]+|<#\d+>)/.test(t)) {
      const named = /(#[\w-]+|<#\d+>)/.exec(t0)?.[1];
      return out(R("channel.info", "channel_info", { resource: "channel", target: { channel: named?.replace(/^#/, "") ?? null } }));
    }
  }
  if (/\b(roles?)\b/.test(t) && /^(?:show|list|what|which|see|display)\b/.test(t) && !/\b(create|make|add|give|remove|delete|assign)\b/.test(t)) return out(R("roles.list", "role_list", { resource: "roles" }));
  if (/\b(channels?)\b/.test(t) && /^(?:show|list|what|which|see|display)\b/.test(t) && !/\b(create|make|delete|rename|move|permission|access|private|hide)\b/.test(t)) return out(R("channels.list", "channel_list", { resource: "channels" }));
  if (/\b(invites?|invitations?|server link|join link)\b/.test(t)) return out(R("invite.create", "invite_create", { resource: "invite", delegate: true }));

  if (/^(?:do (?:that|the same(?: thing)?) again|again|repeat(?: that)?|same again|make another(?: one)?|another one|one more)$/.test(t)) return out(R("repeat", "repeat"));

  /* a request that sounds like a draft change but nothing earlier matched: needs the current draft */
  if (draft && !CHANNEL_WORDS.test(t) && /^(?:and |also |now |ok(?:ay)? |then )*(?:make|keep|turn|rewrite|rephrase|reword|shorten|lengthen|tighten|simplify|add|include|mention|remove|drop|fix|change|update|edit|translate|use|improve|expand|trim|cut|punch|sharpen|soften|polish|redo|rework|try again|more|less|a bit|slightly|shorter|longer|simpler|clearer|friendlier|funnier)\b/.test(t) && !/^(?:add|create|make)\s+(?:an?|another|two|three|\d)\b/.test(t)) return out(R("draft.revise", "draft_revise", { resource: "draft", params: { instruction: oneLine(original.replace(/^(?:and |also |please |now |then |can you |could you )+/i, "")) } }));

  return out(R("unknown", null, { confidence: 0 }));
}

/**
 * Compound requests ("create a VIP category, add announcements and discussion channels, make them private, and give access to the VIP role")
 * become one plan: containers first, then what goes inside them, with "private" and "access" folded into each creation so every step is
 * verified by the tool that makes it. Returns null when the message is a single operation.
 */
export function classifyCompound(t, original, ctx = {}) {
  const verbs = (t.match(/\b(create|make|add|give|set up|build|send|pin|grant)\b/g) ?? []).length;
  const withChannels = /\b(?:category)\b.*\bwith\s+(?:(?:two|three|four|five|\d)\s+)?.+?\s+channels\b/.test(t);
  if (verbs < 2 && !withChannels && !/\bcreate\b.*\bprivate\b.*\bchannel\b.*\b(give|grant)\b/.test(t)) return null;
  if (/\b(announcement|poll|invite|event|message|post(?!-))\b/.test(t) && !/\b(channel|category)\b/.test(t)) return null;
  const cat = /\b(?:create|make|set up|build)\s+(?:an?\s+|the\s+)?(?:new\s+)?(?:(private)\s+)?(?:category\s+(?:called|named)\s+["']?([\w &-]+?)["']?|([\w &-]+?)\s+category)(?=\s*(?:,|\band\b|\bwith\b|$))/.exec(t);
  const chMany = /\badd\s+(?:(?:two|three|four|five|\d)\s+)?(?:private\s+)?(.+?)\s+channels\b/.exec(t) ?? /\bwith\s+(?:(?:two|three|four|five|\d)\s+)?(?:private\s+)?(.+?)\s+channels\b/.exec(t);
  const chOne = /\b(?:create|make)\s+(?:an?\s+)?(private\s+)?([\w-]+)\s+channel\b/.exec(t);
  const access = /\b(?:give|grant|allow)\s+(?:access\s+to\s+)?(?:the\s+)?([\w &,-]+?)(?:\s+role)?(?:\s+access)?\s*$/.exec(t.replace(/,?\s*and then\b/g, ", and"));
  const wantsAccess = /\baccess\b/.test(t);
  const isPrivate = /\bprivate\b|\bhidden\b|\bstaff[- ]only\b/.test(t);
  if (!(cat || chOne) || (verbs < 2 && !withChannels)) return null;
  if (!cat && !wantsAccess) return null;
  if (chOne && !cat && /\band (?:a|an) (?:public |private )?[\w-]+ channel\b/.test(t)) return null; // two channels: handled as separate operations
  const steps = [];
  const roles = wantsAccess && access ? access[1].split(/\s*(?:,|&|\band\b)\s*/).map(x => origCase(original, strip(x))).filter(Boolean) : [];
  const category = cat ? origCase(original, strip(cat[2] ?? cat[3] ?? "")) : null;
  if (cat) steps.push({ id: "cat", tool: "channel_create", args: { kind: "category", name: category, private: isPrivate || undefined, role: roles.join(", ") || undefined } });
  const names = chMany && cat ? namesFrom(chMany[1].replace(/^(?:two|three|four|five|\d)\s+/, "").replace(/\bprivate\b/g, "")) : chOne ? [chOne[2]] : [];
  for (const n of names.filter(x => x && !/^(them|it|private|a|an)$/.test(x))) steps.push({ id: "ch:" + n, tool: "channel_create", dependsOn: cat ? ["cat"] : [], args: { kind: "text", name: origCase(original, n), private: isPrivate || undefined, role: roles.join(", ") || undefined, category: category ?? undefined } });
  if (steps.length < 1) return null;
  return { primary: "compound.setup", secondary: steps.map(s => `${s.args.kind}.create`), action: "plan", resource: "server", target: { roles }, params: { steps, roles }, refs: [], needs: [], clarify: null, confidence: 0.85, source: "rule" };
}

/**
 * Several independent operations in one message ("show me the members and the server info", "send it here and pin it", "create a role
 * called Student and a role called Alumni"). Split into clauses; it is one request only when EVERY clause is something the classifier owns
 * on its own (a clause that is only a noun borrows the first clause's verb). The clauses run in order, each classified with what the
 * earlier ones produced, and a failed or unanswered clause stops the rest.
 */
export function classifyMulti(original, ctx = {}) {
  const raw = String(original ?? "").trim();
  if (raw.length > 300 || raw.length < 8) return null;
  const parts = raw.split(/\s*(?:,\s*(?:and\s+(?:then\s+)?|then\s+)?|;\s*|\s+and then\s+|\s+then\s+|\s+and\s+(?=(?:also\s+)?(?:send|post|pin|delete|remove|make|create|add|show|list|give|who|how|write|rename|hide|find|what)\b)|\s+and\s+(?=(?:a|an|the)\s)|\s+and\s+(?=(?:roles|channels|members|server|events|invites)\b))/i).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return null;
  const verb = /^(show|list|find|get|see|display|create|make|add)\b/i.exec(parts[0])?.[1];
  const stub = { ...ctx, draft: ctx.draft ?? { id: "stub", sent: [{}] }, convo: { ...(ctx.convo ?? {}), corrections: [] }, noMulti: true };
  const kinds = [];
  for (let i = 0; i < parts.length; i++) {
    let p = parts[i], k = classify(p, stub);
    if (k.primary === "unknown" && verb && i > 0) k = classify(`${verb} ${p}`, stub);
    if (k.primary === "unknown" || k.primary === "compound.setup" || k.correction) return null;
    kinds.push(k.primary);
  }
  if (kinds[0] === "draft.write" && kinds.slice(1).includes("draft.revise")) return null; // "write one, use the same format as last time" is one request
  if (new Set(kinds).size === 1 && !/^(?:role|channel|category)\./.test(kinds[0]) && kinds[0] !== "role.create") return null; // "list roles, list roles" is not a plan
  const creations = kinds.every(x => /\.create$/.test(x));
  return { primary: creations ? "compound.setup" : kinds[0], secondary: kinds.slice(creations ? 0 : 1), multi: true, action: "multi", resource: "server", target: {}, params: { clauses: parts, verb: verb ?? null }, refs: [], needs: [], clarify: null, confidence: 0.8, source: "rule" };
}

/** True for the intents the classifier owns and can run without a language model. */
export const OWNED = new Set(["members.list", "members.byRole", "members.search", "members.count", "members.online", "server.overview", "roles.list", "channels.list", "channels.visibility", "permission.revoke", "permission.grant", "channel.info", "invite.create", "draft.write", "draft.approve", "draft.revise", "draft.restore", "draft.show", "draft.send", "message.pin", "message.delete", "message.edit", "channel.create", "category.create", "role.create", "channel.access", "channel.rename", "channel.delete", "role.assign", "role.remove", "compound.setup", "memory.remember", "memory.forget", "memory.show", "repeat", "context.resume", "correction.channel"]);
