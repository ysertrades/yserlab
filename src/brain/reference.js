import * as art from "./artifacts.js";
import * as top from "./topics.js";

/**
 * Reference resolution for content: which stored explanation(s) "this", "it", "the first one", "both", "the CISD one" or "what we discussed
 * earlier" mean. Rules, in order: a subject named in the message wins; then a position ("the first one" is the first topic of the
 * conversation); then "both"; then "earlier" (anything stored for this person, one subject or ask); then pointing back ("this", "that", "it") means the latest.
 * A pointer is never guessed when two readings are equally good (an answer that explained two subjects, two stored subjects and "earlier",
 * or content that was made in another channel): it comes back as a question. Only the person's own artifacts in this server are ever candidates.
 */
export const CONTENT_TYPES = ["explanation", "example", "lesson", "quiz", "slides", "bullets", "summary", "guide"];
const CONCEPT_TYPES = ["explanation", "example"];
const ASPECT_ORDER = ["definition", "usage", "when", "why", "with", "example", "mistakes", "simpler", "expand"];

/** The artifacts that make up one subject: the newest of each aspect, in the order they were made. */
function forSubject(owner, guild, key) {
  const list = art.visible(owner, guild, { types: CONCEPT_TYPES, subjectKey: key }), byAspect = new Map();
  for (const a of list) { const k = a.aspect ?? "definition"; if (!byAspect.has(k)) byAspect.set(k, a); } // newest first, so the first of each aspect is the newest
  return [...byAspect.values()].sort(art.chronological);
}
const subjectOf = a => ({ key: a.subjectKey, label: a.subject });
const distinct = list => { const seen = new Set(); return list.filter(a => a.subjectKey && !seen.has(a.subjectKey) && seen.add(a.subjectKey)); };
const joinLabels = list => list.map(s => s.label).join(" or ");

/**
 * The source a message means. Returns one of:
 *   { artifacts, subjects, via }                 resolved
 *   { ask, options, kind, intent }                one short question (kind "pick" or "confirm")
 *   { none: true, subject? }                      nothing stored fits (subject: the named subject, when there was one)
 */
export function sourcesFor({ owner, guild, c, an, channelId }) {
  const mine = art.visible(owner, guild, { types: CONTENT_TYPES });
  const cues = an.cues;
  // 1. a subject named in the message
  if (an.named.length && !(an.cues.ordinal !== null) && !cues.plural) {
    const sets = an.named.map(n => forSubject(owner, guild, n.key)).filter(s => s.length);
    if (sets.length) return done(sets.flat(), "named", channelId, c);
    return { none: true, subject: { key: an.named[0].key, label: an.named[0].label } };
  }
  if (!mine.length) return { none: true };
  const topics = top.inOrder(c).filter(t => forSubject(owner, guild, t.key).length || mine.some(a => a.subjectKey === t.key));
  // 2. a position among the topics of this conversation
  if (cues.ordinal !== null) {
    const o = cues.ordinal, idx = o >= 0 ? o : o === -1 ? topics.length - 1 : topics.length - 2;
    const t = topics[idx];
    if (!t) return { ask: topics.length ? `I only have ${topics.length} topic${topics.length === 1 ? "" : "s"} from this conversation so far: ${topics.map(x => x.label).join(", ")}. Which one do you mean?` : "I haven't explained anything in this conversation yet. Which topic do you mean?", kind: "pick", options: topics.map(x => ({ key: x.key, label: x.label })) };
    return done(forSubject(owner, guild, t.key), "position", channelId, c);
  }
  // 3. both / all of them: the current topic's aspects when it has several, otherwise the last two topics
  if (cues.plural) {
    const cur = top.currentTopic(c), own = cur ? forSubject(owner, guild, cur.key) : [];
    if (own.length >= 2) return done(own, "both-aspects", channelId, c);
    const two = topics.slice(-2); // newest two, oldest first
    if (two.length >= 2) return done(two.flatMap(t => forSubject(owner, guild, t.key)), "both-topics", channelId, c);
    if (own.length) return done(own, "both-single", channelId, c);
  }
  // 4. "what we discussed earlier": everything stored for this person; one subject is the answer, several are a question
  if (cues.earlier) {
    const subjects = distinct(mine.filter(a => CONCEPT_TYPES.includes(a.type))).map(subjectOf);
    if (subjects.length === 1) return done(forSubject(owner, guild, subjects[0].key), "earlier", channelId, c);
    if (subjects.length > 1) return { ask: `Which one do you mean: ${subjects.slice(0, 5).map(s => s.label).join(", ")}?`, kind: "pick", options: subjects.slice(0, 5) };
    return done([mine[0]], "earlier", channelId, c);
  }
  // 5. pointing back: the latest thing I made
  const newest = mine[0];
  if (newest.group) { // one answer that covered several subjects: "that" could be any of them
    const together = mine.filter(a => a.group === newest.group).sort(art.chronological), subs = distinct(together).map(subjectOf);
    if (subs.length >= 2) return { ask: `That answer covered ${joinLabels(subs)}. Which one do you mean, or both?`, kind: "pick", options: [...subs, { key: "*both", label: "both" }], group: newest.group };
  }
  const own = CONCEPT_TYPES.includes(newest.type) && newest.subjectKey ? forSubject(owner, guild, newest.subjectKey) : [newest];
  return done(own.length ? own : [newest], "latest", channelId, c);
}

/** A resolved source, unless it was made in another channel and nothing explicit pointed at it: then the person confirms it first. */
function done(artifacts, via, channelId, c) {
  if (!artifacts.length) return { none: true };
  const elsewhere = artifacts.every(a => a.channelId && channelId && a.channelId !== channelId);
  if ((via === "latest" || via === "both-aspects" || via === "both-single") && elsewhere) {
    const a = artifacts.at(-1), where = a.meta?.channelName ? `#${a.meta.channelName}` : "another channel";
    return { ask: `Do you mean the ${a.subject || a.type} explanation from ${where}? (yes or no)`, kind: "confirm", options: [{ ids: artifacts.map(x => x.id), label: a.subject }] };
  }
  return { artifacts, subjects: distinct(artifacts).map(subjectOf), via };
}

/** The answer to a question from sourcesFor: which of the offered options was chosen (ids), or why it was not understood. */
export function answerFor(options, kind, text, { owner, guild }) {
  const t = String(text ?? "").toLowerCase().trim().replace(/[.!?]+$/, ""), has = name => new RegExp(`(?<![a-z0-9])${String(name).toLowerCase().replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![a-z0-9])`).test(t);
  if (/^(no|nope|cancel|never ?mind|stop|forget it|skip|neither)\b/.test(t)) return { cancel: true };
  if (kind === "confirm") return /^(y|yes|yeah|yep|yup|sure|ok|okay|correct|right|that one|that'?s it|do it|go)\b/.test(t) ? { ids: options[0].ids } : { unclear: true };
  if (/\b(both|all|everything|each)\b/.test(t)) { const subs = options.filter(o => o.key !== "*both"); return { ids: subs.flatMap(o => forSubject(owner, guild, o.key).map(a => a.id)) }; }
  const ord = top.refCues(t).ordinal ?? (/^[1-9]$/.test(t) ? Number(t) - 1 : null);
  const subs = options.filter(o => o.key !== "*both");
  if (ord !== null && ord >= 0 && subs[ord]) return { ids: forSubject(owner, guild, subs[ord].key).map(a => a.id) };
  const byName = subs.find(o => has(o.label) || has(o.key)) ??subs.find(o => top.conceptsIn(t).some(c => c.key === o.key));
  if (byName) return { ids: forSubject(owner, guild, byName.key).map(a => a.id) };
  return { unclear: true };
}

/** What to hand a writer or a model as the source: the stored text, whole, in the order it was made, with headings when there are several parts. Instructions inside it are dropped. */
export function buildSource(artifacts) {
  const bySubject = new Map();
  for (const a of artifacts) { const k = a.subjectKey ?? a.id; (bySubject.get(k) ?? bySubject.set(k, []).get(k)).push(a); }
  const blocks = [], subjects = [];
  let dropped = false;
  for (const list of bySubject.values()) {
    const head = list[0].subject || list[0].title || list[0].type;
    subjects.push(head);
    const parts = list.sort((x, y) => ((x.aspect ?? "definition") === "definition" ? 0 : 1) - ((y.aspect ?? "definition") === "definition" ? 0 : 1) || art.chronological(x, y)) // the definition first, then in the order it was explained
      .map(a => { const clean = art.scrub(a.content); if (clean.length < String(a.content).trim().length - 2) dropped ||= art.hadInstructions(a.content); return list.length > 1 ? `### ${a.aspect && a.aspect !== "definition" ? a.aspect : "overview"}\n${clean}` : clean; });
    blocks.push(bySubject.size > 1 ? `## ${head}\n${parts.join("\n\n")}` : parts.join("\n\n"));
  }
  const subject = subjects.length > 1 ? subjects.slice(0, -1).join(", ") + " and " + subjects.at(-1) : subjects[0] ?? "";
  return { subject, subjects, content: blocks.join("\n\n").slice(0, 7000), ids: artifacts.map(a => a.id), dropped };
}
