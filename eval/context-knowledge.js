// The stand-in "model" for the context evaluation. It is deliberately simple and honest: it knows a small set of concepts, answers about the
// concept and aspect it can read in the question it is given, and when the question names no concept it may look ONLY at what the assistant
// hands it (a "Current topic" line, or the last thing "Me:" said in the recent turns). So a scenario passes only when the context the
// assistant builds really carries the subject; nothing is inferred by magic. Each answer holds a unique marker such as [#CISD-def], so a test
// can prove which explanation an embed or a message was made from.
export const CONCEPTS = {
  IFVG: { names: ["ifvg", "inverse fair value gap", "inversion fair value gap"], label: "IFVG", full: "Inverse Fair Value Gap" },
  FVG: { names: ["fvg", "fair value gap"], label: "FVG", full: "Fair Value Gap" },
  CISD: { names: ["cisd", "change in state of delivery"], label: "CISD", full: "Change in State of Delivery" },
  SMT: { names: ["smt divergence", "smt"], label: "SMT divergence", full: "Smart Money Technique divergence" },
  "liquidity sweep": { names: ["liquidity sweep", "liquidity sweeps", "sweep of liquidity"], label: "liquidity sweep", full: "liquidity sweep" },
  BSL: { names: ["bsl", "buy side liquidity", "buyside liquidity"], label: "BSL", full: "Buy Side Liquidity" },
  SSL: { names: ["ssl", "sell side liquidity", "sellside liquidity"], label: "SSL", full: "Sell Side Liquidity" },
  "breaker block": { names: ["breaker block", "breaker blocks", "breaker"], label: "breaker block", full: "breaker block" },
  "order block": { names: ["order block", "order blocks"], label: "order block", full: "order block" },
  MSS: { names: ["mss", "market structure shift"], label: "MSS", full: "Market Structure Shift" },
  PSP: { names: ["psp", "precision swing point"], label: "PSP", full: "Precision Swing Point" },
  killzone: { names: ["killzone", "killzones", "kill zone"], label: "killzone", full: "killzone" },
  "premium and discount": { names: ["premium and discount", "premium discount", "premium/discount"], label: "premium and discount", full: "premium and discount" },
  "turtle soup": { names: ["turtle soup"], label: "turtle soup", full: "turtle soup" },
};
export const NAMES = Object.keys(CONCEPTS);
const ALIASES = Object.entries(CONCEPTS).flatMap(([key, c]) => c.names.map(n => [n, key])).sort((a, b) => b[0].length - a[0].length);

/** Every concept the text mentions, in the order mentioned. */
export function mentions(text) {
  const t = ` ${String(text ?? "").toLowerCase().replace(/[^a-z0-9/ ]+/g, " ")} `, found = [];
  const used = [];
  for (const [alias, key] of ALIASES) {
    let i = t.indexOf(` ${alias} `);
    while (i >= 0) { if (!used.some(([a, b]) => i < b && i + alias.length + 2 > a)) { found.push([i, key]); used.push([i, i + alias.length + 2]); } i = t.indexOf(` ${alias} `, i + 1); }
  }
  return [...new Set(found.sort((a, b) => a[0] - b[0]).map(f => f[1]))];
}

const ASPECTS = [
  ["simple", /\b(easier|simpler|simplify|plain|eli5|beginner|simple terms?)\b/i], ["mistakes", /\b(mistakes?|wrong|pitfalls?|errors?)\b/i], ["with", /\bwith (nq|es|ym|bsl|ssl|\w+ and \w+)\b/i],
  ["example", /\bexamples?\b/i], ["when", /\bwhen\b.*\b(useful|best|use|valid|work)\b|\bmost useful\b/i], ["usage", /\b(used?|trade|trading|apply|applied|use it|use this)\b/i], ["expand", /\b(expand|more detail|elaborate|go deeper)\b/i],
  ["def", /./],
];
const TRANSFORMS = [["quiz", /\bquiz\b/i], ["lesson", /\blesson\b/i], ["slides", /\bslides?\b/i], ["bullets", /\bbullet/i], ["pdf", /\bpdf\b/i], ["guide", /\bguide\b/i], ["short", /\b(short version|shorter|summary|summari[sz]e|tl;?dr)\b/i], ["professional", /\bprofessional\b/i], ["announcement", /\bannouncement\b/i]];
export const transformOf = q => TRANSFORMS.find(([, re]) => re.test(String(q ?? "")))?.[0] ?? null;
export const aspectOf = q => ASPECTS.find(([, re]) => re.test(String(q ?? "")))?.[0] ?? "def";
export const marker = (concept, aspect) => `[#${concept.replace(/\s+/g, "-")}-${aspect}]`;
export const midMarker = (concept, aspect) => `[#${concept.replace(/\s+/g, "-")}-${aspect}-mid]`;
/** Real answers are long. The padding makes each stand-in answer about a thousand characters, with a marker in the middle and one at the very end, so keeping only the first lines of it (as a truncated history does) loses the end marker. */
const PAD = " Keep the rules simple and written down: the timeframe, the session, the direction, the level, the invalidation and the target. Review every instance after the session, with a screenshot, and note what the higher timeframe was doing. Over a month the notes show which conditions pay and which do not, and that record is what turns a pattern into a plan you can repeat without hesitation or second-guessing.";

/** The words the stand-in model says for a concept and aspect. Long enough to be a real explanation, with one marker. */
export function explain(concept, aspect, extra = "") {
  const c = CONCEPTS[concept], L = c.label, F = c.full;
  const body = {
    def: `**${L}** (${F}) is a price-action idea traders use to read what the market is doing. It marks a specific, repeatable footprint in price, and its meaning depends on the candle that formed it, the timeframe and the direction it points. Read it together with the higher-timeframe bias before relying on it.`,
    usage: `**${L}** in trading: wait for the setup to form on your timeframe, check it agrees with the higher-timeframe bias, mark the level it creates, and plan entry, stop and target around that level. Skip it when the session or the news makes price unreliable.`,
    example: `Example of **${L}**: price runs into a prior high, the footprint appears on the five-minute chart, the next candle closes back through it, and the trade targets the opposite side of the range with the stop above the extreme.`,
    when: `**${L}** is most useful when the higher timeframe is clear, during the main sessions, and when price has just taken liquidity. It is least useful in the middle of a range.`,
    simple: `**${L}**, in plain words: it is a spot on the chart where price showed its hand. Spot it, wait for price to come back, and trade from there with a small stop.`,
    mistakes: `Common mistakes with **${L}**: trading it against the higher-timeframe bias, entering before the candle closes, and placing the stop inside the noise.`,
    with: `**${L}** with the index futures: ${extra || "on NQ and ES"} compare the two charts. When one makes the move and the other refuses, the footprint is stronger and the trade has a cleaner target.`,
    expand: `More on **${L}**: it works best with a clear sequence (sweep, displacement, retest). Keep a log of each one with the timeframe, session and outcome so you can see where it pays.`,
  }[aspect] ?? `**${L}**: ${aspect}.`;
  const half = Math.floor(PAD.length / 2), cut = PAD.indexOf(". ", half) + 1;
  return `${body}${PAD.slice(0, cut)} ${midMarker(concept, aspect)}${PAD.slice(cut)} ${marker(concept, aspect)}`;
}

/**
 * The stand-in model call. `question` is what the assistant sent as the user's message, `context` is the block it attached. Returns the text,
 * the concept and aspect it answered, and whether it had to guess ("unresolved") because neither text nor context named a subject.
 */
export function modelAnswer({ question, context = "", provider = "stub" }) {
  const q = String(question ?? ""), ctx = String(context ?? "");
  let concepts = mentions(q), via = "question";
  if (!concepts.length) {
    const topic = /Current topic:\s*([^\n]+)/i.exec(ctx)?.[1];
    const fromTopic = topic ? mentions(topic) : [];
    if (fromTopic.length) { concepts = [fromTopic[0]]; via = "topic-line"; }
    else {
      // what a model reading raw history would do: the concept in the last thing "Me:" said
      const lines = ctx.split("\n").filter(l => /^(Me|You \(YSER Lab\)):/.test(l)).reverse();
      for (const l of lines) { const m = mentions(l); if (m.length) { concepts = [m[0]]; via = "recent-turns"; break; } }
    }
  }
  if (!concepts.length) return { text: "Which topic do you mean? I can't tell from this message.", concept: null, aspect: null, unresolved: true, via: "none", provider };
  const kind = transformOf(q);
  if (kind) { // a transformation: the model can only rework what it is actually given
    const given = [...ctx.matchAll(/SOURCE CONTENT[^\n]*\n([\s\S]*?)\nEND SOURCE CONTENT/g)].map(m => m[1]);
    const lines = ctx.split("\n").filter(l => /^(Me|You \(YSER Lab\)):/.test(l)).reverse();
    const text = given.length ? given.join("\n\n") : (lines[0] ?? "").replace(/^(Me|You \(YSER Lab\)):\s*/, "");
    return { text: `${kind[0].toUpperCase() + kind.slice(1)} on ${CONCEPTS[concepts[0]].label}:\n${text}`, concept: concepts[0], aspect: `transform:${kind}`, concepts, via, unresolved: false, provider, usedSource: given.length > 0 };
  }
  const aspect = aspectOf(q), concept = concepts[0];
  if (via === "question" && concepts.length > 1 && aspect === "def" && /\b(and|&|vs|versus)\b/i.test(q)) { // two subjects in one question: one answer with a section for each
    return { text: concepts.slice(0, 2).map(c => explain(c, "def")).join("\n\n"), concept, aspect, concepts, via, unresolved: false, provider };
  }
  const text = aspect === "with" && concepts.length > 1 ? explain(concept, "with", concepts.slice(1).join(" and ")) : explain(concept, aspect);
  return { text, concept, aspect, concepts, via, unresolved: false, provider };
}
