/**
 * Topic tracking and the reading of a message's references. Deterministic and independent of any model: it reads what a message is about
 * (a trading concept, or a term introduced with "what is ..."), whether it points back ("this", "it", "the first one", "both", "what we
 * discussed earlier") and what it asks for (an explanation, a transformation, an action). The conversation keeps a stack of topics, newest
 * first, each with the aspects discussed and the artifacts made, so a follow-up continues the topic and a new subject starts a new one
 * without forgetting the old ones.
 */
import { osa } from "./classify.js";
const C = (key, label, ...names) => ({ key, label, names: [label.toLowerCase(), ...names] });
export const CONCEPTS = [
  C("IFVG", "IFVG", "inverse fair value gap", "inversion fair value gap", "inverted fair value gap", "inversion fvg"), C("FVG", "FVG", "fair value gap", "fair value gaps", "imbalance"),
  C("CISD", "CISD", "change in state of delivery"), C("SMT", "SMT divergence", "smt", "smart money technique", "smt divergences"),
  C("liquidity sweep", "liquidity sweep", "sweep of liquidity", "liquidity grab", "stop hunt"), C("BSL", "BSL", "buy side liquidity", "buyside liquidity", "buy-side liquidity"), C("SSL", "SSL", "sell side liquidity", "sellside liquidity", "sell-side liquidity"),
  C("breaker block", "breaker block", "breaker", "breakers"), C("order block", "order block", "ob"), C("MSS", "MSS", "market structure shift"), C("BOS", "BOS", "break of structure"), C("CHoCH", "CHoCH", "change of character"),
  C("PSP", "PSP", "precision swing point"), C("killzone", "killzone", "kill zone", "kill zones"), C("premium and discount", "premium and discount", "premium discount", "premium/discount", "premium and discount array"),
  C("turtle soup", "turtle soup"), C("OTE", "OTE", "optimal trade entry"), C("displacement", "displacement"), C("PO3", "power of three", "po3", "power of 3", "amd"), C("judas swing", "judas swing"),
  C("equal highs and lows", "equal highs", "equal lows", "eqh", "eql", "equal highs and lows"), C("BPR", "balanced price range", "bpr"), C("rejection block", "rejection block"), C("mitigation block", "mitigation block"),
  C("NWOG", "new week opening gap", "nwog"), C("NDOG", "new day opening gap", "ndog"), C("silver bullet", "silver bullet"), C("daily bias", "daily bias"), C("draw on liquidity", "draw on liquidity", "dol"),
  C("2S", "2S", "second stage"), C("SS", "SS", "swing sweep"), C("market maker model", "market maker model", "mmxm"), C("liquidity", "liquidity"),
];
const esc = s => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const ALIASES = CONCEPTS.flatMap(c => c.names.map(n => ({ n, c }))).sort((a, b) => b.n.length - a.n.length);
const ALIAS_RE = ALIASES.map(a => ({ re: new RegExp(`(?<![a-z0-9])${esc(a.n)}(?:s|es)?(?![a-z0-9])`, "gi"), c: a.c }));
export const conceptByKey = key => CONCEPTS.find(c => c.key === key) ?? null;

/** Every known concept a text mentions, in the order mentioned (longest alias first so "inverse fair value gap" is not read as "fair value gap"). */
export function conceptsIn(text) {
  const t = String(text ?? ""), hits = [];
  for (const { re, c } of ALIAS_RE) { re.lastIndex = 0; let m; while ((m = re.exec(t))) { const a = m.index, b = a + m[0].length; if (!hits.some(h => a < h.b && b > h.a)) hits.push({ a, b, c }); } }
  const seen = new Set(), found = hits.sort((x, y) => x.a - y.a).map(h => h.c).filter(c => !seen.has(c.key) && seen.add(c.key));
  return found.length ? found : fuzzyConcepts(t);
}
/** A typo in a long concept name ("liqudity sweep", "breakr block") still finds it: one edit away, and only for names of six letters or more. */
const LONG = ALIASES.filter(a => a.n.length >= 6);
function fuzzyConcepts(text) {
  const words = String(text).toLowerCase().replace(/[^a-z0-9/ ]+/g, " ").split(/\s+/).filter(Boolean), hits = [], used = new Set();
  for (const { n, c } of LONG) { // longest names first, and a word already taken by one name is not taken again
    const size = n.split(/\s+/).length;
    for (let i = 0; i + size <= words.length; i++) {
      const span = Array.from({ length: size }, (_, j) => i + j), w = words.slice(i, i + size).join(" ");
      if (span.some(p => used.has(p)) || Math.abs(w.length - n.length) > 1 || osa(w, n) !== 1) continue;
      hits.push({ a: i, c }); span.forEach(p => used.add(p)); break;
    }
  }
  const seen = new Set(); return hits.sort((x, y) => x.a - y.a).map(h => h.c).filter(c => !seen.has(c.key) && seen.add(c.key));
}

const STOP = /^(it|this|that|these|those|them|they|something|anything|everything|what|how|why|when|me|you|us|more|again|one|the same|the above|your|my|our|trading)$/i;
/** Words that make a "what is ..." question about the world right now, not about a concept. */
const NOT_A_SUBJECT = /\b(price|prices|time|date|weather|today|tonight|tomorrow|yesterday|now|currently|score|news|worth|cost|my|your|our|you|me|i|we|doing|going on|happening|name|plan|schedule|balance|pnl|profit|loss|members?|server|channel|role|bot|ai)\b/i;
/** A term a question introduces that is not in the list ("what is a dealing range?"). Null for pronouns and for anything that is clearly not a subject. */
export function termOf(text) {
  const t = String(text ?? "").trim().replace(/\s+/g, " ");
  const m = /^(?:please |can you |could you |would you )?(?:(?:what(?:'s| is| are| was| were)|whats)|(?:define|explain|describe|teach me(?: about)?|tell me about|break down|walk me through|help me understand|what do you mean by|what does)|(?:how (?:does|do|is|are) ))\s+(?:an? |the )?(.{2,60}?)(?:\s+(?:work|mean|used?|trade[sd]?|in trading|in ict|in the market)\b.*)?[?.!]*$/i.exec(t);
  const term = m?.[1]?.replace(/\b(please|for me|to me|again|in simple terms|in detail)\b/gi, "").replace(/[?.!,]+$/g, "").trim();
  if (!term || STOP.test(term) || term.split(/\s+/).length > 5 || /^(a|an|the)\b/i.test(term) && term.split(/\s+/).length < 2) return null;
  if (/\b(this|that|it|them|they|these|those|here|there)\b/i.test(term)) return null;
  if (NOT_A_SUBJECT.test(term)) return null; // "what is the price of NQ right now?" is a question about the world, not a subject to learn
  return term;
}

/* ── what a message points back to ── */
const ANAPHORA = /\b(this|that|it|its|they|them|their|these|those|both|the same(?: thing| one)?|the above|above|what you (?:just )?(?:said|wrote|explained|gave|told me)|(?:the|that|this|your|my|previous|last|above) (?:explanation|answer|definition|description|example|lesson)|the topic|the previous (?:one|explanation|answer)|the last (?:one|explanation|answer)|the latest(?: one| explanation| answer)?)\b/i;
const ORD = [[/\b(first|1st|original|earliest|oldest)\b(?: one| topic| explanation)?/i, 0], [/\b(second|2nd)\b(?: one| topic| explanation)?/i, 1], [/\b(third|3rd)\b(?: one| topic| explanation)?/i, 2], [/\b(fourth|4th)\b(?: one| topic| explanation)?/i, 3],
  [/\b(last|latest|most recent|newest)\b(?: one| topic| explanation)?/i, -1], [/\b(one before|before that|the earlier (?:one|topic)|the previous topic|the topic before)\b/i, -2]];
const EARLIER = /\b(earlier|before|previously|last time|yesterday|the other day|we (?:talked|spoke|discussed|covered|went over)|we were (?:talking|discussing)|discussed|covered)\b/i;
const PLURAL = /\b(both|all of (?:them|these|those)|all (?:three|four|of it)|the two|them all|everything (?:we|you))\b/i;
const ASPECTS = [
  ["simpler", /\b(easier|simpler|simplify|in simple (?:terms|words)|plain (?:english|words|terms)|eli5|beginner)\b/i], ["mistakes", /\b(mistakes?|pitfalls?|errors?|go(?:es)? wrong|common problems)\b/i],
  ["example", /\b(examples?|for instance|show me one)\b/i], ["with", /\b(?:work|works|working|combine|combines|pair|pairs|interact|interacts|apply|applies)\b.*\bwith\b|\bwith (?:nq|es|ym|mnq|mes|gold|crypto|forex|indices)\b/i],
  ["when", /\bwhen\b.*\b(useful|best|valid|use|used|work|apply|trade|matters?)\b|\bmost useful\b/i], ["usage", /\bhow\b.{0,40}\b(used?|using|trade|trades|trading|apply|applied|enter|entry)\b|\b(?:use|using|trade|trading|apply|applying) (?:it|this|that|them)\b|\bapplications?\b/i], ["why", /\bwhy\b/i],
  ["expand", /\b(expand|more detail|elaborate|go deeper|in (?:more )?depth|tell me more|more on)\b/i], ["definition", /./],
];
export const ASPECT_LABEL = { definition: "definition", usage: "how it is used", example: "example", when: "when it is useful", why: "why it matters", mistakes: "common mistakes", simpler: "simpler version", with: "combined with other things", expand: "more detail" };
export const aspectOf = text => ASPECTS.find(([, re]) => re.test(String(text ?? "")))?.[0] ?? "definition";

/* what it asks for */
const FORMATS = [["embed", /\b(embed|announcement|panel|notice)\b/i], ["quiz", /\bquiz\b|\bflash ?cards?\b/i], ["lesson", /\blesson\b/i], ["slides", /\bslides?\b|\bpresentation\b/i], ["bullets", /\bbullet(?:s| points?)?\b|\bchecklist\b|\bcheat ?sheet\b/i],
  ["pdf", /\bpdf\b/i], ["guide", /\b(?:detailed |educational |complete |full )?guide\b/i], ["short", /\b(?:short(?:er)?|brief|condensed|quick) (?:version|summary)\b|\bsummar(?:y|i[sz]e)\b|\btl;?dr\b|\bshorter\b/i], ["professional", /\b(?:more )?professional\b/i]];
const TRANSFORM_VERB = /\b(make|create|build|write|generate|turn|convert|give me|prepare|draft|produce|put|rewrite|rephrase|redo|do)\b/i;
/** "send it to #education", "post that in education", "share this": the verb, a pointer straight after it, and at most a destination. Anything else ("post that the stream starts at 9") is not a send of stored content. */
const SEND_STORED = /^(?:please |now |and |then |ok(?:ay)?,? |can you |could you )*(?:send|post|share|publish|forward|drop|put|upload)\s+(?:it|this|that|these|those|them|both|the (?:explanation|answer|lesson|quiz|summary|example|definition|above)|(?:that|this|the) (?:explanation|answer|lesson|quiz|summary|example|definition)|what you (?:just )?(?:said|wrote|explained)|the (?:first|second|third|last) one)(?:\s+(?:again|too|now|here|there))?(?:\s+(?:to|in|into|on|at)\s+(?:the\s+)?(?:#?[\w-]+|<#\d+>)(?:\s+channel)?)?\s*[.!?]*$/i;
/** An embed request that points at stored content: "for this", "about that", "from it", "for both", "for the first one", "what we discussed earlier", "from that explanation". Not "an announcement that the stream starts". */
export const pointsAtStored = text => /\b(?:for|about|from|of|on|using|with|into)\s+(?:this|that|it|both|them|those|these)\s*(?:[.!?]|\band\b|,|$)|\b(?:this|that|the|your|my|previous|last) (?:explanation|answer|definition|lesson)\b|\bthe (?:first|second|third|fourth|last|latest|previous) (?:one|topic|explanation)\b|\b(?:for|about|from) both\b|\bwhat (?:we|you) (?:just |already )?(?:discussed|covered|talked about|explained|said|wrote|gave)\b|\b(?:we|you) (?:discussed|covered|talked about) (?:earlier|before|yesterday)\b|\bthe above\b|\b(?:turn|convert|put|transform|make)\s+(?:this|that|it|both|them|these|those)\b/i.test(String(text ?? ""));
export const refCues = text => {
  const t = String(text ?? ""), ord = ORD.find(([re]) => re.test(t));
  return { anaphora: ANAPHORA.test(t), ordinal: ord ? ord[1] : null, plural: PLURAL.test(t), earlier: EARLIER.test(t), named: conceptsIn(t) };
};
const WORDS = t => t.trim().split(/\s+/).filter(Boolean).length;

/**
 * Reads one message. `topic` is the conversation's current topic (or null). The result says what the message is about, how it points back,
 * what it asks for, and whether it continues the current topic.
 */
export function analyze(text, topic = null) {
  const t = String(text ?? "").trim(), cues = refCues(t), named = cues.named, term0 = termOf(t), term = term0 && !conceptsIn(term0).length ? term0 : null, format = FORMATS.find(([, re]) => re.test(t))?.[0] ?? null;
  const sends = SEND_STORED.test(t);
  const pins = /^(?:please |now |and |then )*pin\b/i.test(t), saves = /^(?:please |now |and )*(?:save|keep|remember|approve|store)\s+(?:it|this|that|the (?:explanation|answer|embed))\b|^(?:looks good|that'?s the one|use this one|approve (?:it|this))\b/i.test(t);
  const modifier = /\b(?:make|turn|rewrite|rephrase)\s+(?:it|this|that|the (?:explanation|answer))\s+(?:a bit |much |even |far )?(easier|simpler|shorter|longer|clearer|more (?:professional|detailed|casual|concise|friendly|exciting)|less (?:technical|formal))\b/i.exec(t)?.[1] ?? null;
  const asksFormat = !!format && (TRANSFORM_VERB.test(t) || /\bfor (?:this|that|it|both)\b/i.test(t)) && !/^(?:what|how|why|when|who|which)\b.*\?$/i.test(t);
  const question = /\?\s*$/.test(t) || /^(?:what|how|why|when|where|which|who|can you|could you|do you|does|is|are|explain|describe|define|tell me|give me|show me|walk me)\b/i.test(t);
  const aspect = aspectOf(t);
  // a short follow-up that names nothing ("can you give me an example?", "what mistakes do people make?"): it needs a topic, an aspect of one, and no ticker or number of its own
  const elliptical = !!topic && !named.length && !term && WORDS(t) <= 10 && aspect !== "definition" && !/\b[A-Z]{2,5}1?!?\b|\d/.test(t) && /^(?:and |also |ok(?:ay)?,? |so |but )?(?:how|when|why|what|where|which|can you|could you|would you|give me|show me|tell me|any|more|an example|example|expand|elaborate)\b/i.test(t);
  const kind = pins ? "pin" : saves ? "save" : sends ? "send" : (asksFormat || modifier) ? "transform" : question || elliptical ? "info" : "other";
  const explicit = named.length > 0 || !!term;
  // an explicit subject with no pointing back starts (or continues) that subject; pointing back keeps the current topic and treats a named concept as a second one
  const pointsBack = cues.anaphora || cues.ordinal !== null || cues.plural || cues.earlier || elliptical;
  return { text: t, kind, format, modifier, aspect, question, cues, named, term, explicit, anaphora: cues.anaphora, elliptical, pointsBack, followUp: pointsBack && !!topic, topic };
}

/** Whether a message is a question or request about the subject itself (an explanation, an example, a rewrite), and not an operation ("delete that", "send it", "ban him"): only these are rewritten or stored. */
const OPERATION = /\b(delete|remove|ban|kick|mute|unmute|timeout|pin|unpin|send|post|rename|move|lock|unlock|hide|unhide|purge|clear|assign|invite|schedule|remind|close|archive)\b/i;
export const educational = an => (an.kind === "info" || an.kind === "transform") && !OPERATION.test(an.text.replace(/\b(?:give|show) me (?:an? )?(?:examples?|analogy|analogies)\b/gi, ""));

/** The subject(s) a message is about: { primary, secondary, via, isNew }. Pointing back wins over a second named concept ("how does it work with BSL?" is still about the current topic). */
export function subjectFor(an, current) {
  const named = an.named.map(c => ({ key: c.key, label: c.label })), term = an.term ? [{ key: String(an.term).toLowerCase(), label: an.term }] : [];
  const explicit = [...named, ...term];
  if (an.followUp && current && (an.cues.anaphora || an.elliptical) && !(an.explicit && !an.cues.anaphora)) {
    const rest = explicit.filter(e => e.key !== current.key);
    return { primary: { key: current.key, label: current.label }, secondary: rest, via: an.cues.anaphora ? "anaphora" : "elliptical", isNew: false };
  }
  if (explicit.length) return { primary: explicit[0], secondary: explicit.slice(1), via: "explicit", isNew: !current || current.key !== explicit[0].key };
  if (an.followUp && current) return { primary: { key: current.key, label: current.label }, secondary: [], via: "context", isNew: false };
  return { primary: null, secondary: [], via: "none", isNew: false };
}

/* ── the stack of topics ── */
const TOPIC_TTL = 12 * 3_600_000;
export const currentTopic = c => { const t = c.topics?.[0]; return t && Date.now() - t.at < TOPIC_TTL ? t : null; };
/** Records that a subject was discussed (a new topic goes on top; an old one is brought back to the top without losing what was said about it). */
export function noteTopic(c, subject, aspect, { artifactIds = [], channelId = null } = {}) {
  if (!subject?.key) return null;
  c.topics ??= [];
  let t = c.topics.find(x => x.key === subject.key);
  if (t) c.topics.splice(c.topics.indexOf(t), 1); else t = { key: subject.key, label: subject.label, aspects: [], artifactIds: [], first: Date.now(), n: (c.topicSeq = (c.topicSeq ?? 0) + 1) }; // n: the order topics were first discussed, exact even within one millisecond
  c.topics.unshift(t);
  t.at = Date.now(); t.channelId = channelId ?? t.channelId ?? null;
  if (aspect && !t.aspects.includes(aspect)) t.aspects.push(aspect);
  for (const id of artifactIds) if (!t.artifactIds.includes(id)) t.artifactIds.push(id);
  if (c.topics.length > 14) c.topics.length = 14;
  c.topic = t.label; c.subtopic = aspect && aspect !== "definition" ? ASPECT_LABEL[aspect] ?? aspect : null;
  return t;
}
/** Topics in the order they were first discussed (oldest first): "the first one" is the first topic of the conversation. */
export const inOrder = c => [...(c.topics ?? [])].sort((a, b) => (a.n ?? a.first ?? a.at) - (b.n ?? b.first ?? b.at));
/** Brings an already-known topic back to the top as the current one (used when one answer covered several subjects: the first named is current). */
export function promote(c, key) { const i = (c.topics ?? []).findIndex(t => t.key === key); if (i > 0) { const [t] = c.topics.splice(i, 1); c.topics.unshift(t); } const t = c.topics?.[0]; if (t) { c.topic = t.label; t.at = Date.now(); } return t ?? null; }
