/**
 * Intent classification, before any language model. Every message becomes one structured record:
 *   { primary, secondary[], action, resource, target{user,role,channel,ordinal,query}, params, refs[], needs[], clarify, confidence, source }
 * `primary` is what the owner wants to accomplish ("members.list"), `action` the tool that does it. Different requests that share words
 * ("members in this server" vs "server information" vs "how many members") get different intents, because the match is on what is being asked,
 * not on which words appear. What the classifier does not own comes back as primary "unknown" and goes to the language model as before.
 * Context (a draft, the last list, the last created channel) decides follow-ups such as "make it shorter" or "send it here".
 */

/* ── spelling: the few words that matter, tolerant of one slip (transposed or missing letters) ── */
const VOCAB = ["members", "member", "announcement", "announcements", "channel", "channels", "category", "categories", "server", "moderator", "moderators", "instructor", "instructors", "create", "delete", "private", "everyone", "online", "people", "role", "roles", "message", "shorter", "professional", "invite", "people"];
function osa(a, b) { // optimal string alignment distance (a swap of two letters counts once)
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
const SLANG = [[/\bpls\b|\bplz\b/g, "please"], [/\bu\b/g, "you"], [/\bmsg\b/g, "message"], [/\bann\b/g, "announcement"], [/\bchnl\b|\bchan\b/g, "channel"], [/\bcat\b(?= called| named)/g, "category"], [/\bmods\b/g, "moderators"], [/\bwhos\b/g, "who is"], [/\bgimme\b/g, "give me"], [/\bwanna\b/g, "want to"]];
export function normalize(raw) {
  let t = String(raw ?? "").replace(/<@!?\d+>(?=\s*$)/, "").toLowerCase().replace(/[“”]/g, '"').replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().replace(/[.!]+$/g, "").trim();
  for (const [re, to] of SLANG) t = t.replace(re, to);
  return fixTypos(t);
}

const ORD = { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, fifth: 4, "5th": 4, last: -1 };
export function ordinalOf(t) {
  const w = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)\b(?:\s+(?:one|person|member|guy|user|name|human|result))?/.exec(t);
  if (w) return ORD[w[1]];
  const n = /\b(?:number|no\.?|nr\.?)\s*(\d{1,2})\b/.exec(t) ?? /\bnum(?:ber)?\s*(\d{1,2})\b/.exec(t);
  return n ? Number(n[1]) - 1 : null;
}

/** The same words as the owner wrote them (names keep their capitals: "VIP", not "vip"). */
export const origCase = (original, s) => { if (!s) return s; const i = String(original).toLowerCase().indexOf(String(s).toLowerCase()); return i >= 0 ? String(original).slice(i, i + String(s).length) : s; };
const strip = s => String(s ?? "").replace(/^(the|a|an|our|this|that)\s+/, "").replace(/\s+(role|channel|category)$/, "").replace(/[?.!,"']+$/g, "").replace(/^["']/, "").trim();
const singular = s => String(s).replace(/(ies)$/, "y").replace(/s$/, "");
const key = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const isTime = s => /^(tomorrow|today|tonight|this (morning|evening|afternoon|week|weekend)|next \w+|(on )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|the weekend|later|now)\b[\w ]*$/i.test(String(s).trim());
const TIMEY = /\b(tomorrow|today|tonight|next \w+|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

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
  let m = /\b(?:with|has|have|having|holding|wearing|in)\s+(?:the\s+)?([\w &-]+?)\s+role\b/.exec(t) ?? /\bthe\s+([\w &-]+?)\s+role\b/.exec(t);
  if (m) return strip(m[1]);
  const noun = /\b(?:show|list|find|get|see|display|who (?:is|are)|who has)(?:\s+me)?\s+(?:all\s+|every\s+|the\s+|our\s+|everyone\s+(?:who\s+is\s+)?(?:a\s+|an\s+)?)*([a-z][\w &-]*?)\s*\??$/.exec(t);
  const cand = noun && strip(noun[1]);
  if (cand && roleNames.some(r => key(r) === key(cand) || key(r) === key(singular(cand)))) return cand;
  const bare = /^(?:the\s+|our\s+|all\s+the\s+)?([a-z][\w &-]*?)\s*\??$/.exec(t); // "i mean the moderators"
  if (bare && roleNames.some(r => key(r) === key(bare[1]) || key(r) === key(singular(bare[1])))) return strip(bare[1]);
  return null;
}

/* ── the members / server family ── */
const COUNT = /\bhow many\b.*\b(members?|people|users|accounts|humans)\b|\b(member|user) count\b|\bnumber of (members?|people|users)\b|\bhow big is\b.*\bserver\b|\bhow many of us\b/;
const ONLINE = /\bwho (?:is|are)\s+(?:currently\s+|all\s+)?online\b|\bwho is on(?:line)?\b|\bonline (?:members?|people|users)\b|\b(?:members?|people|users) (?:that are |who are )?online\b|\bwho(?:'s| is) (?:around|active) (?:right )?now\b/;
const OVERVIEW = /\bserver (?:info(?:rmation)?|overview|stat(?:s|istics)?|settings|details|summary|configuration|structure|profile)\b|\b(?:info(?:rmation)?|overview|details|summary|stat(?:s|istics)?|settings)\s+(?:about|of|on|for)\s+(?:the |this |our )?server\b|\btell me about (?:the |this |our )?server\b|\bserver owner\b|\bwho owns\b|\bboost (?:level|status)\b|\bhow is the server\b/;
const LIST_MEMBERS = [
  /^(?:the\s+|all\s+(?:the\s+)?|all\s+of\s+the\s+)?(?:server\s+)?(?:members?|people|users)(?:\s+list)?(?:\s+(?:in|of|on|from)\s+(?:the |this |our )?(?:server|discord|guild))?$/,
  /\b(?:show|list|display|get|give|see|find|pull up|fetch|print|dump|send)\b(?:\s+me)?(?:\s+(?:all|every|each))?(?:\s+of)?(?:\s+(?:the|our|this))?\s*(?:server\s+)?(?:members?|people|users|everyone|everybody|humans)\b/,
  /\bwho(?:'s| is| are)?(?:\s+all)?\s+(?:in|on|inside|part of)\s+(?:the |this |our )?(?:server|discord|guild)\b/,
  /\b(?:everyone|everybody|all (?:the )?(?:members|people|users)|(?:the )?actual (?:people|members|users))\s+(?:in|on|inside|of)\s+(?:the |this |our )?(?:server|discord|guild)\b/,
  /\b(?:the )?actual (?:people|members|users|humans)\b/,
  /\bmembers?\s+(?:in|of|on)\s+(?:the |this |our )?(?:server|discord|guild)\b/,
  /\bwho are (?:the |our )?(?:members|people|users)\b/,
];

/** The message's tail after a send verb: where it should go. */
function destination(tail, t) {
  const here = /\b(here|this channel|this one|in here)\b/.test(tail);
  const m = /\b(?:in|to|into|on|at)\s+(?:the\s+)?(<#\d+>|#?[\w-]+)(?:\s+channel)?(?:\s+(?:instead|too|as well))?\s*$/.exec(tail) ?? /\b(?:in|to|into|on)\s+(?:the\s+)?(<#\d+>|#?[\w-]+)(?:\s+channel)?\b/.exec(tail);
  const other = /\b(another|a different|other|some other)\s+channel\b|\banywhere else\b/.test(tail);
  if (other) return { other: true };
  if (m && !/^(here|there|it|that|this|too|instead|again)$/.test(m[1]) && !TIMEY.test(m[1])) return { channel: m[1].replace(/^#/, "") };
  if (here) return { here: true };
  return {};
}

/**
 * Classifies one message. `ctx`: { convo, roleNames, channelNames }. The conversation state decides follow-ups; with none, a bare
 * "send it" has nothing to refer to and asks.
 */
export function classify(raw, ctx = {}) {
  const convo = ctx.convo ?? {}, roleNames = ctx.roleNames ?? [], draft = ctx.draft ?? null;
  const original = String(raw ?? "").trim();
  const t = normalize(original);
  if (!t) return R("unknown", null, { confidence: 0 });
  const refs = refsIn(t);
  const out = x => ({ ...x, refs: x.refs?.length ? x.refs : refs, text: t });

  /* the owner's earlier corrections in this conversation: the same words mean what they were corrected to */
  const learned = (convo.corrections ?? []).find(c => c.phrase === t && c.right);
  if (learned) return out({ ...R(learned.right.primary, learned.right.action, { params: learned.right.params ?? {}, target: learned.right.target ?? {}, confidence: 0.95 }), via: "learned correction" });

  /* a correction: "no, I mean ...", "I said X, not Y" */
  const said = /^(?:no[, ]+)?i (?:said|meant|mean)\s+(?:the\s+)?(?:channel\s+)?#?([\w-]+?),?\s+(?:and )?not\s+(?:the\s+)?#?([\w-]+)/.exec(t);
  if (said) return out(R("correction.channel", "resend_to", { correction: true, target: { channel: said[1] }, params: { wrong: said[2] } }));
  const fix = /^(?:no|nope|nah|not that|wrong|that'?s wrong|that is wrong|that'?s not (?:what i (?:asked|meant|said)|it|right))[,.!:;\s-]*(?:i (?:mean|meant|said|want(?:ed)?)\s*|what i (?:mean|meant) (?:is|was)\s*|i was asking (?:for|about)\s*)?(.*)$/.exec(t) ?? /^i (?:mean|meant)\s+(.*)$/.exec(t);
  if (fix && fix[1]?.trim()) {
    const inner = classify(fix[1].trim(), { ...ctx, correcting: true });
    if (inner.primary !== "unknown") return { ...inner, correction: true, secondary: ["correction"], text: t };
  }

  /* memory commands */
  let m = /^(?:please\s+)?remember\s+(?:that\s+)?(.+)$/.exec(t);
  if (m) return out(R("memory.remember", "memory_remember", { params: { text: strip(original.replace(/^(?:please\s+)?remember\s+(?:that\s+)?/i, "")) } }));
  m = /^(?:please\s+)?forget\s+(?:about\s+|that\s+)?(.+)$/.exec(t);
  if (m) return out(R("memory.forget", "memory_forget", { params: { text: m[1] } }));
  if (/^what do you (?:remember|know) about me\b|^what have you (?:remembered|saved)\b|^show (?:me )?(?:my )?(?:saved )?preferences\b/.test(t)) return out(R("memory.show", "memory_show"));

  /* several operations in one message */
  const compound = classifyCompound(t, original, ctx);
  if (compound) return out(compound);

  /* drafts: write, approve, revise, send, edit, pin, delete */
  const write = /\b(?:write|draft|compose|create|make|prepare|put together|give me|do)\s+(?:me\s+)?(?:an?|the|another|new)?\s*(?:new\s+|short\s+|quick\s+|professional\s+)?(announcement|post|notice|update message|message for the (?:server|community|members))\b(.*)$/.exec(t);
  if (write && !/\b(channel|category|role|poll|event|invite)\b/.test(t.slice(0, write.index + write[0].length - write[2].length))) {
    const tail = write[2].trim();
    let topic = null, when = null;
    const about = /^(?:about|on|regarding|announcing|saying(?: that)?|that says|to say|telling (?:them|everyone) (?:that )?)\s+(.+)$/.exec(tail) ?? /^for\s+(.+)$/.exec(tail);
    if (about) { if (isTime(about[1])) when = about[1]; else topic = origCase(original, about[1]); }
    return out(R("draft.write", "draft_write", { resource: "draft", params: { topic, when }, needs: topic ? [] : ["topic"], clarify: topic ? null : "What is the announcement about?" }));
  }
  const noun = "(?:it|that|this|the announcement|the draft|the message|the post|the latest(?: version)?|the revised(?: version)?|the new version|the final version|the same (?:announcement|message|post))";
  m = new RegExp(`^(?:please |now |ok(?:ay)? |and |then |go ahead and )*(send|post|publish|share|drop|put)\\s+${noun}\\b(.*)$`).exec(t) ?? /^(?:please |now |and |then )*(?:make|do|send|post) (?:the )?same (?:announcement|message|post)\b(.*)$/.exec(t);
  if (m) {
    const tail = (m[2] ?? m[1] ?? "").trim(), dest = destination(tail, t);
    return out(R("draft.send", "message_send", { resource: "draft", target: dest, params: { tail }, needs: [], confidence: draft ? 0.95 : 0.7 }));
  }
  if (/^(?:please |now |and |also |then )*pin\s+(?:it|that|this|the (?:message|announcement|post)|the one (?:you|i) (?:just )?sent)(?:\s+(?:too|as well|please))?$/.test(t)) return out(R("message.pin", "message_pin", { resource: "message" }));
  if (/^(?:please |now |and |also |then )*(?:delete|remove|erase|get rid of)\s+(?:it|that|this|the (?:previous|last|latest|earlier|old|first) (?:one|message|version|announcement|post)|the previous one|the (?:message|announcement|post) (?:above|i (?:just )?sent|you (?:just )?sent)|the one (?:you|i) (?:just )?sent)(?:\s+(?:too|please))?$/.test(t)) return out(R("message.delete", "message_remove", { resource: "message", params: { which: /\b(previous|earlier|old|first)\b/.test(t) ? "previous" : /\b(last|latest)\b/.test(t) ? "last" : "that" } }));
  if (/^(?:please |now |and |also )*(?:edit|update|change|fix)\s+(?:the one|the message|the announcement|that one|it)\s*(?:(?:that )?(?:you|i) (?:just )?(?:sent|posted)|above)?(?:\s+(?:with|to|so)\b.*)?$/.test(t) && !/\bchannel\b/.test(t)) return out(R("message.edit", "message_update", { resource: "message", params: { instruction: /\b(?:with|to|so)\s+(.+)$/.exec(t)?.[1] ?? null } }));
  if (draft && /^(?:perfect|great|good|nice|awesome|excellent|love it|looks (?:good|great|perfect)|that'?s? (?:it|perfect|great|good|better)|approved?|done|ship it|that works|that'?s fine|fine)$/.test(t)) return out(R("draft.approve", "draft_approve", { resource: "draft" }));

  /* making a channel private and giving a role access: refers to the channel just made */
  m = /^(?:please |now |and |also |then )*(?:make|set|turn|keep)\s+(it|that|this|them|the (?:channel|category)|(?:the )?#?[\w-]+ (?:channel|category))\s+(?:to be\s+)?(private|public|read[- ]?only|hidden|visible|locked)\b(.*)$/.exec(t);
  if (m) {
    const roles = /\b(?:for|to|only for|only|so only)\s+(?:the\s+)?([\w &,-]+?)(?:\s+(?:role|can see(?: it)?|only))*\s*$/.exec(m[3])?.[1];
    return out(R("channel.access", "channel_access", { resource: "channel", target: { channel: /^(it|that|this|them)$/.test(m[1]) ? null : strip(m[1]).replace(/^#/, "") }, params: { access: m[2].replace(/\s/g, "_").replace("-", "_") === "readonly" ? "read_only" : m[2].replace("-", "_").replace(" ", "_"), roles: roles ?? null } }));
  }
  m = /\b(?:give|grant|allow)\s+(?:the\s+)?(?:access\s+to\s+(?:the\s+)?)?([\w &,-]+?)(?:\s+role)?(?:\s+access)?(?:\s+(?:to|for)\s+(?:it|that|this|them))?\s*$/.exec(t);
  if (m && /\baccess\b/.test(t) && !/\bcreate\b|\bmake a\b/.test(t)) return out(R("channel.access", "channel_access", { resource: "channel", params: { access: "private", roles: strip(m[1]) } }));

  /* roles on people: "give it to the second member", "remove the role from the second person" */
  m = /^(?:please |now |and |also )*(give|assign|add|grant)\s+(?:the\s+)?(it|that|this|(?:the\s+)?[\w &-]+?\s+role|that role|this role)\s+to\s+(.+)$/.exec(t);
  if (m && !/\baccess\b/.test(t)) {
    const rolePart = /^(it|that|this)$/.test(m[2]) ? null : strip(m[2]), who = m[3].replace(/\bfrom (?:the|that|this) list\b/, "").trim();
    return out(R("role.assign", "role_assign", { resource: "member", target: { role: rolePart, user: who, ordinal: ordinalOf(who) } }));
  }
  m = /^(?:please |now |and |also )*(?:remove|take|revoke|strip)\s+(?:the\s+|that\s+)?([\w &-]*?)\s*role\s+(?:from|off)\s+(.+)$/.exec(t) ?? /^(?:please |now |and |also )*(?:remove|take away|revoke)\s+(it|that)\s+(?:from|off)\s+(.+)$/.exec(t);
  if (m) {
    const who = m[2].replace(/\bfrom (?:the|that|this) list\b/, "").trim(), role = m[1] && !/^(it|that|the|this)$/.test(m[1]) ? strip(m[1]) : null;
    return out(R("role.remove", "role_assign", { resource: "member", target: { role, user: who, ordinal: ordinalOf(who) }, params: { remove: true } }));
  }

  /* creating things */
  m = /\b(create|make|add|new|set up|build)\b\s+(?:an?\s+|the\s+|another\s+)?(?:new\s+)?(.*)$/.exec(t);
  if (m) {
    const rest = m[2], verb = m[1];
    if (!/\b(poll|event|invite|message|announcement|post|reminder|ticket|warning|draft)\b/.test(rest)) {
      const cat = /^(?:(private|public|read[- ]?only)\s+)?(?:(?:category\s+(?:called|named)\s+["']?([\w &-]+?)["']?|([\w &-]+?)\s+category)(?:\s+(?:called|named)\s+["']?([\w &-]+?)["']?)?)(?=\s+(?:and|with|that|for|which)\b|[,.]|$)/.exec(rest) ?? /^(?:(private|public)\s+)?category\b(?:\s+(?:called|named)\s+["']?([\w &-]+?)["']?)?\s*$/.exec(rest);
      if (cat) {
        const name = cat[2] ?? cat[4] ?? (cat[3] && !/^(a|an|new|private|public)$/.test(cat[3]) ? cat[3] : null);
        const priv = /\bprivate\b/.test(t) || /private/.test(cat[1] ?? "");
        return out(R("category.create", "channel_create", { resource: "category", params: { kind: "category", name: name ? origCase(original, strip(name)) : null, private: priv || undefined }, needs: name ? [] : ["name"], clarify: name ? null : "What should I name it?" }));
      }
      const ch = /^(?:(private|public|read[- ]?only)\s+)?(?:(text|voice|forum|stage)\s+)?(?:(?:two|three|four|five|\d|some|a few|several)\s+)?(?:(?:channel\s+(?:called|named)\s+["']?([\w #&-]+?)["']?)|([\w -]+?)\s+channels?(?:\s+(?:called|named)\s+["']?([\w #&-]+?)["']?)?|channels?)(?=\s+(?:and|with|that|for|which|in|inside|under)\b|[,.]|$)(.*)$/.exec(rest);
      if (ch) {
        const tail = ch[6] ?? "";
        const kind = (ch[2] ?? "text").replace(/s$/, ""), many = /^(?:two|three|four|five|2|3|4|5|some|a few|several)\s/.test(rest);
        const named = ch[3] ?? ch[5] ?? (ch[4] && !/^(a|an|new|private|public|text|voice|read-only|two|three|four|five|some|several|a few|\d)$/.test(ch[4]) ? ch[4] : null);
        const priv = /\bprivate\b/.test(t) || /private/.test(ch[1] ?? "");
        const inCat = /\b(?:in|inside|under)\s+(?:the\s+)?([\w &-]+?)\s+category\b/.exec(tail + " " + t)?.[1];
        const intoFocus = /^(?:add|put)$/.test(verb) || /\b(?:in|inside|under|into)\s+(?:it|that|there|that category|this category|the category)\b/.test(t) || /\bto (?:it|that category|the category)\b/.test(t);
        const cnt = /^(two|three|four|five|2|3|4|5)\b/.exec(rest)?.[1];
        const count = cnt ? ({ two: 2, three: 3, four: 4, five: 5 }[cnt] ?? Number(cnt)) : null;
        return out(R("channel.create", "channel_create", { resource: "channel", params: { kind: kind === "announcement" ? "announcement" : kind, name: named ? origCase(original, strip(named).replace(/^#/, "")) : null, private: priv || undefined, category: inCat ? origCase(original, strip(inCat)) : undefined, intoFocus, count, many }, needs: named ? [] : ["name"], clarify: named ? null : count && count > 1 ? `What should the ${count} channels be called?` : "What should the channel be called?" }));
      }
      const role = /^(?:(?:role\s+(?:called|named)\s+["']?([\w &-]+?)["']?)|([\w &-]+?)\s+role(?:\s+(?:called|named)\s+["']?([\w &-]+?)["']?)?)(?=\s+(?:and|with|that|for|colou?r)\b|[,.]|$)/.exec(rest);
      if (role) {
        const name = role[1] ?? role[3] ?? (role[2] && !/^(a|an|new)$/.test(role[2]) ? role[2] : null);
        return out(R("role.create", "role_create", { resource: "role", params: { name: name ? origCase(original, strip(name)) : null }, needs: name ? [] : ["name"], clarify: name ? null : "What should the role be called?" }));
      }
    }
  }

  /* the members / server family: different intents, different tools */
  if (COUNT.test(t)) return out(R("members.count", "member_count", { resource: "members" }));
  if (ONLINE.test(t)) return out(R("members.online", "member_online", { resource: "members" }));
  const role = roleOf(t, roleNames);
  const withRoleWord = /\b(?:everyone|everybody|people|members?|users|who|anyone|someone)\b.*\b(?:with|has|have|having)\s+(?:the\s+)?[\w &-]+?\s+role\b|\bwho (?:has|have|is)\s+(?:the\s+)?[\w &-]+?\s+role\b|\bmembers? (?:of|in) (?:the\s+)?[\w &-]+?\s+role\b|\b(?:show|list|find|get|see)\b.*\b[\w &-]+? role (?:members?|people|holders)\b|\bwho(?:'s| is)? (?:a |an |the )?(?:moderator|instructor|admin)s?\b/.test(t);
  if (role && (withRoleWord || /^(?:show|list|find|get|see|display|who|everyone|the|our|all)\b/.test(t) || ctx.correcting || /^(?:the\s+|our\s+)?[a-z][\w &-]*$/.test(t))) return out(R("members.byRole", "member_list", { resource: "members", target: { role }, params: { role }, tools: ["member_list"] }));
  if (withRoleWord) { const named = /\b(?:with|has|have|having|is)\s+(?:the\s+)?([\w &-]+?)\s+role\b/.exec(t)?.[1]; if (named) return out(R("members.byRole", "member_list", { resource: "members", target: { role: strip(named) }, params: { role: strip(named) } })); }
  if (OVERVIEW.test(t)) return out(R("server.overview", "server_overview", { resource: "server" }));
  if (LIST_MEMBERS.some(re => re.test(t)) && !/\b(create|make|add|delete|remove|ban|kick|mute|timeout|assign)\b/.test(t) && !/\bgive (?!me\b)/.test(t)) {
    const q = /\b(?:named|called|matching|with (?:the )?(?:name|username)|whose name (?:has|contains)|starting with|containing)\s+["']?([\w.\-]+)["']?/.exec(t)?.[1];
    const bots = /\bbots?\b/.test(t) && !/\bhumans?\b/.test(t) ? "bots" : /\b(humans?|real people|non[- ]?bots?)\b/.test(t) ? "humans" : undefined;
    const sort = /\b(newest|latest|most recent)\b/.test(t) ? "newest" : /\b(oldest|longest)\b/.test(t) ? "joined" : undefined;
    return out(R("members.list", "member_list", { resource: "members", params: { query: q, kind: bots, sort } }));
  }
  m = /^(?:find|search(?: for)?|look ?up|who is|who'?s)\s+(?:the\s+)?(?:member\s+|user\s+|person\s+)?@?([\w.\-]{2,32})$/.exec(t);
  if (m && !/^(online|here|there|everyone|everybody|that|this|it|in|on)$/.test(m[1])) return out(R("members.search", "member_list", { resource: "members", params: { query: m[1] }, target: { query: m[1] } }));

  if (/\b(roles?)\b/.test(t) && /^(?:show|list|what|which|see|display)\b/.test(t) && !/\b(create|make|add|give|remove|delete|assign)\b/.test(t)) return out(R("roles.list", "role_list", { resource: "roles" }));
  if (/\b(channels?)\b/.test(t) && /^(?:show|list|what|which|see|display)\b/.test(t) && !/\b(create|make|delete|rename|move|permission|access|private|hide)\b/.test(t)) return out(R("channels.list", "channel_list", { resource: "channels" }));
  if (/\b(invites?|invitations?|server link|join link)\b/.test(t)) return out(R("invite.create", "invite_create", { resource: "invite", delegate: true }));

  if (/^(?:do (?:that|the same(?: thing)?) again|again|repeat(?: that)?|same again|make another(?: one)?|another one|one more)$/.test(t)) return out(R("repeat", "repeat"));

  /* a request that sounds like a draft change but nothing earlier matched: needs the current draft */
  if (draft && !CHANNEL_WORDS.test(t) && /^(?:and |also |please |now |ok(?:ay)? |then )*(?:make|keep|turn|rewrite|rephrase|reword|shorten|lengthen|tighten|simplify|add|include|mention|remove|drop|fix|change|update|edit|translate|use|improve|expand|trim|cut|punch|sharpen|soften|polish|redo|rework|try again|more|less|a bit|slightly|shorter|longer|simpler|clearer|friendlier|funnier)\b/.test(t) && !/^(?:add|create|make)\s+(?:an?|another|two|three|\d)\b/.test(t)) return out(R("draft.revise", "draft_revise", { resource: "draft", params: { instruction: original.replace(/^(?:and |also |please |now |then )+/i, "") } }));

  return out(R("unknown", null, { confidence: 0 }));
}

/**
 * Compound requests ("create a VIP category, add announcements and discussion channels, make them private, and give access to the VIP role")
 * become one plan: containers first, then what goes inside them, with "private" and "access" folded into each creation so every step is
 * verified by the tool that makes it. Returns null when the message is a single operation.
 */
export function classifyCompound(t, original, ctx = {}) {
  const verbs = (t.match(/\b(create|make|add|give|set up|build|send|pin|grant)\b/g) ?? []).length;
  if (verbs < 2 && !/\bcreate\b.*\bprivate\b.*\bchannel\b.*\b(give|grant)\b/.test(t)) return null;
  if (/\b(announcement|poll|invite|event|message|post)\b/.test(t) && !/\b(channel|category)\b/.test(t)) return null;
  const cat = /\b(?:create|make|set up|build)\s+(?:an?\s+|the\s+)?(?:new\s+)?(?:(private)\s+)?(?:category\s+(?:called|named)\s+["']?([\w &-]+?)["']?|([\w &-]+?)\s+category)(?=\s*(?:,|\band\b|$))/.exec(t);
  const chMany = /\badd\s+(?:(?:two|three|four|five|\d)\s+)?(?:private\s+)?(.+?)\s+channels\b/.exec(t) ?? /\bwith\s+(?:(?:two|three|four|five|\d)\s+)?(?:private\s+)?(.+?)\s+channels\b/.exec(t);
  const chOne = /\b(?:create|make)\s+(?:an?\s+)?(private\s+)?([\w-]+)\s+channel\b/.exec(t);
  const access = /\b(?:give|grant|allow)\s+(?:access\s+to\s+)?(?:the\s+)?([\w &,-]+?)(?:\s+role)?(?:\s+access)?\s*$/.exec(t.replace(/,?\s*and then\b/g, ", and"));
  const wantsAccess = /\baccess\b/.test(t);
  const isPrivate = /\bprivate\b|\bhidden\b|\bstaff[- ]only\b/.test(t);
  if (!(cat || chOne) || verbs < 2) return null;
  if (!cat && !wantsAccess) return null;
  const steps = [];
  const roles = wantsAccess && access ? access[1].split(/\s*(?:,|&|\band\b)\s*/).map(x => origCase(original, strip(x))).filter(Boolean) : [];
  const category = cat ? origCase(original, strip(cat[2] ?? cat[3] ?? "")) : null;
  if (cat) steps.push({ id: "cat", tool: "channel_create", args: { kind: "category", name: category, private: isPrivate || undefined, role: roles.join(", ") || undefined } });
  const names = chMany && cat ? namesFrom(chMany[1].replace(/^(?:two|three|four|five|\d)\s+/, "").replace(/\bprivate\b/g, "")) : chOne ? [chOne[2]] : [];
  for (const n of names.filter(x => x && !/^(them|it|private|a|an)$/.test(x))) steps.push({ id: "ch:" + n, tool: "channel_create", dependsOn: cat ? ["cat"] : [], args: { kind: "text", name: origCase(original, n), private: isPrivate || undefined, role: roles.join(", ") || undefined, category: category ?? undefined } });
  if (steps.length < 1) return null;
  return { primary: "compound.setup", secondary: steps.map(s => `${s.args.kind}.create`), action: "plan", resource: "server", target: { roles }, params: { steps, roles }, refs: [], needs: [], clarify: null, confidence: 0.85, source: "rule" };
}

/** True for the intents the classifier owns and can run without a language model. */
export const OWNED = new Set(["members.list", "members.byRole", "members.search", "members.count", "members.online", "server.overview", "roles.list", "channels.list", "invite.create", "draft.write", "draft.approve", "draft.revise", "draft.send", "message.pin", "message.delete", "message.edit", "channel.create", "category.create", "role.create", "channel.access", "role.assign", "role.remove", "compound.setup", "memory.remember", "memory.forget", "memory.show", "repeat", "correction.channel"]);
