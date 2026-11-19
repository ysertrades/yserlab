/**
 * Plain-language giveaway requests, understood by rule before any language model sees them, so "run a giveaway for a $50 gift card for
 * 24 hours with 2 winners in #giveaways, 2x entries for @VIP" starts one, in the channel named or (with none named) in the same channel, and
 * never turns into a round of questions. Only a missing prize is asked about, once.
 */
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const UNIT = "(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)";
const MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const num = s => (/^\d+$/.test(String(s)) ? Number(s) : WORDS[String(s).toLowerCase()] ?? null);

/** "24 hours", "2d", "1 day 12 hours", "90 min" -> milliseconds (0 when none). */
export function durationMs(text) {
  let total = 0;
  for (const m of String(text ?? "").matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT})\\b`, "gi"))) total += Number(m[1]) * (MS[m[2].toLowerCase()[0]] ?? 0);
  return Math.round(total);
}
const STOP = `(?=\\s+(?:for\\s+\\d|for\\s+(?:a|an|the)?\\s*(?:day|hour|week|minute)|lasting|that\\s+(?:ends|lasts)|ends?\\b|ending|with\\s+\\d|with\\s+(?:one|two|three|four|five)\\b|(?:and\\s+)?(?:\\d+|one|two|three|four|five)\\s+winners?|in\\s+(?:the\\s+)?#|in\\s+<#|in\\s+(?:the\\s+)?[\\w-]+\\s+channel|(?:and\\s+)?(?:give|extra|\\d+\\s*x|double|triple|ping|mention|only|requires?|restricted)\\b)|[,.;!]|$)`;

function bonusFrom(raw) {
  const roles = [], users = [];
  const mention = "(<@&\\d+>|<@!?\\d+>)";
  const add = (m, extra) => { const id = /\d+/.exec(m)[0]; (m.startsWith("<@&") ? roles : users).push({ id, extra: Math.max(1, Math.min(m.startsWith("<@&") ? 10 : 50, extra)) }); };
  const amount = (nx, plus, word, nExtra) => nx ? Number(nx) - 1 : plus ? Number(plus) : nExtra ? Number(nExtra) : word ? ({ double: 1, triple: 2, quadruple: 3 }[word.toLowerCase()] ?? 1) : 1;
  const A = "(?:(\\d+)\\s*(?:x|×)|\\+\\s*(\\d+)|(double|triple|quadruple)|(\\d+)\\s+extra)";
  const seen = new Set();
  for (const m of raw.matchAll(new RegExp(`${A}\\s*(?:extra\\s*)?(?:entries|entry|tickets?|chances?)?\\s*(?:for|to|on|with)?\\s*${mention}`, "gi"))) { if (!seen.has(m[5])) { seen.add(m[5]); add(m[5], amount(m[1], m[2], m[3], m[4])); } }
  for (const m of raw.matchAll(new RegExp(`${mention}\\s*(?:gets?|has|have|receives?|with|:|=|should get|will get)\\s*(?:an?\\s*)?${A}`, "gi"))) { if (!seen.has(m[1])) { seen.add(m[1]); add(m[1], amount(m[2], m[3], m[4], m[5])); } }
  for (const m of raw.matchAll(new RegExp(`(?:give|giving|grant|add)\\s*(?:to\\s+)?${mention}\\s*(?:an?\\s*)?${A}`, "gi"))) { if (!seen.has(m[1])) { seen.add(m[1]); add(m[1], amount(m[2], m[3], m[4], m[5])); } }
  for (const m of raw.matchAll(new RegExp(`(?:extra|bonus)\\s*(?:entries|entry|tickets?)\\s*(?:for|to)\\s*${mention}`, "gi"))) { if (!seen.has(m[1])) { seen.add(m[1]); add(m[1], 1); } }
  return { roles, users };
}

/** What a message asks of giveaways: { action, args } to run, { say, pending } to answer, or null. */
export function giveawayIntent(raw) {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!/\b(giveaways?|give-?aways?|raffle)\b|\breroll\b|\bentries\b|\bextra entr/i.test(text)) return null;
  const plain = text.replace(/<@&?!?\d+>|<#\d+>/g, " ").replace(/\s+/g, " ");
  const channelId = /<#(\d{15,})>/.exec(text)?.[1] ?? null;
  const channelName = /\bin\s+(?:the\s+)?#?([\w-]+)\s+channel\b/i.exec(plain)?.[1] ?? /\bin\s+#([\w-]+)/i.exec(plain)?.[1] ?? null;
  const channel = channelId ?? channelName;
  const which = /\b(?:giveaway\s+(?:id\s+)?|id\s+)([a-z0-9]{8})\b/i.exec(plain)?.[1] ?? null;
  const prizeHint = /\b(?:the\s+)?(?:(?:giveaway|drop)\s+(?:for|of)\s+)(.+?)$/i.exec(plain)?.[1] ?? null;

  if (/\b(cancel|delete|scrap|abort|remove|call off)\b.*\bgiveaway\b/i.test(plain) && !/\b(entry|entries|winner|bonus|extra)\b/i.test(plain)) return { action: "giveaway_cancel", args: { which: which ?? prizeHint ?? undefined } };
  if (/\breroll\b|\bpick (?:a )?new winners?\b|\bredraw\b/i.test(plain)) return { action: "giveaway_reroll", args: { which: which ?? undefined } };
  if (/\b(end|finish|stop|close|draw|wrap up|pick (?:the )?winners?)\b.*\b(giveaway|it)\b|\bend the giveaway\b/i.test(plain) && !/\b(start|run|host|launch|create)\b/i.test(plain)) return { action: "giveaway_end", args: { which: which ?? undefined } };
  if (/\b(how many|who|list|show|see|top)\b.*\b(entered|entries|entrants|participants|joined)\b|\bparticipants\b/i.test(plain) && /\bgiveaway|entries|entered\b/i.test(plain)) return { action: "giveaway_participants", args: { which: which ?? undefined } };
  if (/\b(show|list|what|which|any|see)\b.*\bgiveaways?\b/i.test(plain) && !/\b(start|run|host|launch|create|make)\b/i.test(plain)) return { action: "giveaway_list", args: {} };

  const bonus = bonusFrom(text);
  const removing = /\b(remove|take away|undo|clear|reset)\b.*\b(bonus|extra)\b|\bno (?:more )?(?:bonus|extra)\b/i.test(plain);
  const starting = /\b(start|run|host|launch|create|make|begin|kick off|set up|do|open)\b.*\b(giveaway|raffle)\b|\b(giveaway|raffle)\b.*\b(for|of)\b/i.test(plain) && !/\b(end|cancel|reroll)\b/i.test(plain);
  if (!starting && (bonus.roles.length || bonus.users.length || /\b(extra|bonus)\b.*\b(entr|ticket)/i.test(plain))) {
    if (removing) return { action: "giveaway_bonus", args: { removeRoles: [...text.matchAll(/<@&(\d+)>/g)].map(m => m[1]), removeUsers: [...text.matchAll(/<@!?(\d+)>/g)].map(m => m[1]), which: which ?? undefined } };
    if (bonus.roles.length || bonus.users.length) return { action: "giveaway_bonus", args: { bonusRoles: bonus.roles, bonusUsers: bonus.users, which: which ?? undefined } };
    const named = /\b(?:extra|bonus)\s+(?:entries|entry|tickets?)\s+(?:for|to)\s+(?:the\s+)?([\w ]+?)\s*(?:role)?(?=\s+(?:in|on|for|,|\.|$)|$)/i.exec(plain)?.[1];
    if (named) return { action: "giveaway_bonus", args: { bonus_role: named.trim(), bonus_extra: "1", which: which ?? undefined } };
  }
  const extend = /\b(extend|add|prolong|push|give it)\b.*?(\d+(?:\.\d+)?\s*(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?))\b.*\b(longer|more|extra|to the giveaway|to it)?/i.exec(plain);
  if (!starting && extend && /\b(giveaway|it|longer|time)\b/i.test(plain)) return { action: "giveaway_edit", args: { extend_ms: String(durationMs(extend[2])), which: which ?? undefined } };
  const winnersChange = /\b(?:make it|change (?:it )?to|set (?:the )?winners? to|now)\s+(\d+|one|two|three|four|five)\s+winners?\b/i.exec(plain);
  if (winnersChange && !/\b(start|run|host|launch|create|begin|kick off|set up|open)\b/i.test(plain)) return { action: "giveaway_edit", args: { winners: String(num(winnersChange[1])), which: which ?? undefined } };

  if (!starting) return null;
  const args = {};
  const prize = [
    /\b(?:giveaway|raffle)\s+(?:of|for|with)\s+(?:an?\s+|the\s+)?(.+?)STOP/i, /\bprize\s*(?:is|of|:)\s*(?:an?\s+|the\s+)?(.+?)STOP/i, /\bgiv(?:e|ing)\s+away\s+(?:an?\s+|the\s+)?(.+?)STOP/i, /\b(?:giveaway|raffle)\s*[:\-–]\s*(.+?)STOP/i,
  ].map(r => new RegExp(r.source.replace("STOP", STOP), "i").exec(plain)?.[1]).find(Boolean);
  if (prize) args.prize = prize.replace(/^["“']|["”']$/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  const dur = new RegExp(`\\b(?:for|lasting|ends?\\s+in|ending\\s+in|in|lasts?|runs?\\s+for|duration(?:\\s+of)?)\\s+(\\d+(?:\\.\\d+)?\\s*${UNIT}(?:\\s*(?:and\\s*)?\\d+\\s*${UNIT})*)`, "i").exec(plain)?.[1] ?? new RegExp(`\\b(\\d+${UNIT})\\b`, "i").exec(plain)?.[1];
  if (dur) args.duration_ms = String(durationMs(dur));
  const winners = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+winners?\b/i.exec(plain);
  if (winners) args.winners = String(num(winners[1]));
  if (channel) args.channel = channel;
  const role = /\b(?:only\s+(?:for\s+)?|restricted\s+to\s+|limited\s+to\s+|requires?\s+(?:the\s+)?(?:role\s+)?|required\s+role\s+|members?\s+with\s+(?:the\s+)?)<@&(\d+)>/i.exec(text)?.[1] ?? /\b(?:required role|requires? the)\s+([\w ]+?)\s+role\b/i.exec(plain)?.[1];
  if (role) args.required_role = role;
  const age = /(\d+)\s*\+?\s*days?\s*old\b|account\s+(?:age\s+)?(?:of\s+)?(?:at least|older than|over|minimum)\s*(\d+)/i.exec(plain);
  if (age) args.min_age_days = age[1] ?? age[2];
  const ping = /\b(?:ping|mention|tag|notify)\s+(@everyone|@here|<@&\d+>)/i.exec(text)?.[1];
  if (ping) args.mention = ping.startsWith("<@&") ? /\d+/.exec(ping)[0] : ping;
  if (bonus.roles.length) args.bonusRoles = bonus.roles;
  if (bonus.users.length) args.bonusUsers = bonus.users;
  if (!args.prize) return { say: "What's the prize?", pending: { action: "giveaway_start", args, field: "prize" } };
  return { action: "giveaway_start", args };
}
