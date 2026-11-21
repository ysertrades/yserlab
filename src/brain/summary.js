import * as mem from "./memory.js";
import * as art from "./artifacts.js";

/**
 * Conversation compression. When the short-term turns grow past their limit the oldest are folded into a summary that keeps what matters
 * for continuing: how the conversation started, the topics so far and what was said about each, what was asked recently, and corrections. The
 * summary is only a reminder. Exact text is never replaced by it: explanations and embeds are artifacts, retrieved whole by id.
 */
const clean = s => String(s ?? "").replace(/\s+/g, " ").trim();
export function fold(c, old) {
  const w = c.work ??= {};
  const firstUser = old.find(t => t.role === "user" && clean(t.text).length > 12);
  if (!w.firstAsk && firstUser) w.firstAsk = clean(firstUser.text).slice(0, 140);
  const prior = String(c.summary ?? "").split("\n").filter(l => /^- /.test(l));
  const asks = [...prior, ...old.filter(t => t.role === "user" && clean(t.text).length > 12 && !/^\(asked me to remember/.test(t.text)).map(t => "- " + clean(t.text).slice(0, 110))].slice(-7);
  const topics = [...(c.topics ?? [])].reverse().map(t => `${t.label}${t.aspects?.length ? ` (${t.aspects.join(", ")})` : ""}`);
  const fixes = (c.corrections ?? []).slice(0, 2).map(x => `- corrected: ${clean(x.text).slice(0, 80)}`);
  return [w.firstAsk ? `Started with: ${w.firstAsk}` : "", topics.length ? `Topics so far, oldest first: ${topics.join(" → ")}` : "", asks.length ? "Asked earlier:" : "", ...asks, ...fixes].filter(Boolean).join("\n").slice(0, 1100);
}
mem.setFolder(fold);
/** A one-paragraph description of a conversation for places that cannot show the turns (a log line, another platform). */
export const describe = (c, owner, guild) => `${c.topic ? `About ${c.topic}. ` : ""}${art.visible(owner, guild).slice(0, 3).map(a => `${art.label(a)} (${a.type})`).join(", ")}`.trim();
