/**
 * A line of text that fits, and still ends: nothing is ever cut mid-thought. Too long, it stops at the last full sentence, else at the last
 * clause (comma, semicolon, dash) that fits and closes with a full stop, and only as a last resort at a word with an ellipsis.
 */
export function fitText(value, max) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  const sentence = [...head.matchAll(/[.!?](?=\s|$)/g)].pop();
  if (sentence && sentence.index >= max * .45) return head.slice(0, sentence.index + 1);
  const clause = [...head.slice(0, max).matchAll(/[,;:—–](?=\s)|\s-\s/g)].pop();
  if (clause && clause.index >= max * .55) return head.slice(0, clause.index).replace(/[\s,;:—–-]+$/, "") + ".";
  const word = head.slice(0, max).replace(/\s+\S*$/, "").replace(/[\s,;:—–-]+(and|or|the|a|an|to|of|in|on|with|then|but)?$/i, "");
  return word + "…";
}

/** The first whole sentences of a text that fit in `max` characters (at least the first one, shortened to end cleanly if it alone is too long). */
export function leadSentences(text, max) {
  const parts = String(text ?? "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  let out = "";
  for (const p of parts) { if ((out ? out + " " + p : p).length > max) break; out = out ? out + " " + p : p; }
  return out || fitText(parts[0] ?? "", max);
}
