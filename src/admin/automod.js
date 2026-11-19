import { PermissionFlagsBits as P } from "discord.js";
import { audit, addWarning, warningsOf } from "./audit.js";
import { isAdmin } from "../access.js";

/**
 * Server protection that runs on every message. Off until the owner switches it on ("turn on anti-spam"), and every rule is configurable under
 * config.ai.automod. It only ever does the mild, reversible things: delete the message, record a warning, and (after repeated violations, if
 * the owner set a timeout) time the person out. It never bans or kicks by itself, and it never touches the owner, admins, moderators or bots.
 * Raid and mass-join detection needs Discord's member-join events (the Server Members intent), which the bot does not have; the audit says so.
 */
export const AUTOMOD_DEFAULTS = {
  on: false,
  /** Delete invite links to other servers. */
  inviteLinks: true,
  /** Delete messages that mention this many people or more. 0 turns it off. */
  massMention: 6,
  /** Delete the same message repeated this many times within the window. 0 turns it off. */
  duplicates: 4, duplicateSeconds: 30,
  /** Delete messages from one person arriving faster than this many in the window. 0 turns it off. */
  flood: 8, floodSeconds: 8,
  /** Links to known scam patterns and these domains. */
  blockedDomains: [], phishing: true,
  blockedWords: [],
  /** Newer accounts than this many days cannot post links. 0 turns it off. */
  newAccountDays: 0,
  /** What happens: the message is always deleted; "warn" also records a warning; "timeout" times them out once they have this many warnings. */
  action: "warn", timeoutAfterWarnings: 0, timeoutMinutes: 10,
  /** Where each action is reported (a channel id). Empty: nowhere but the audit record. */
  logChannel: "",
};

const INVITE = /(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg|invite\.gg)\/[a-z0-9-]+/i;
const URL_RE = /\bhttps?:\/\/[^\s<>]+/gi;
const PHISH = [/disc[o0]rd[-.]?(?:nitro|gift|free|promo)/i, /free[-\s]?nitro/i, /steam(?:community|powered)?[-.](?:gift|promo)/i, /\b(?:nitro|steam)\b.{0,40}\bgift\b.{0,40}https?:\/\//i, /dlscord|d1scord|discorcl|discrod/i, /(?:claim|get)\s+your\s+(?:free\s+)?(?:nitro|reward|prize)/i];
const seen = new Map(); // user -> [{ at, text }]

export const rulesOf = config => ({ ...AUTOMOD_DEFAULTS, ...(config.ai?.automod ?? {}) });

/** What is wrong with a message, or null. Pure: used by the live handler and by "check for spam". */
export function inspect(content, { mentions = 0, accountAgeDays = null, recent = [] } = {}, rules = AUTOMOD_DEFAULTS) {
  const text = String(content ?? "");
  if (rules.inviteLinks && INVITE.test(text)) return { rule: "invite", why: "an invite link to another server" };
  if (rules.massMention && mentions >= rules.massMention) return { rule: "mentions", why: `${mentions} mentions in one message` };
  const links = text.match(URL_RE) ?? [];
  if (rules.phishing && (PHISH.some(r => r.test(text)))) return { rule: "phishing", why: "wording and links typical of a scam" };
  for (const d of rules.blockedDomains ?? []) if (d && links.some(l => l.toLowerCase().includes(String(d).toLowerCase()))) return { rule: "domain", why: `a blocked domain (${d})` };
  for (const w of rules.blockedWords ?? []) if (w && new RegExp(`\\b${String(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) return { rule: "word", why: "a blocked word" };
  if (rules.newAccountDays && links.length && accountAgeDays != null && accountAgeDays < rules.newAccountDays) return { rule: "new-account", why: `a link from an account only ${Math.floor(accountAgeDays)} day(s) old` };
  const norm = text.trim().toLowerCase();
  if (rules.duplicates && norm.length > 3 && recent.filter(r => r.text === norm).length + 1 >= rules.duplicates) return { rule: "duplicate", why: `the same message sent ${rules.duplicates} times` };
  if (rules.flood && recent.length + 1 >= rules.flood) return { rule: "flood", why: `${recent.length + 1} messages in ${rules.floodSeconds} seconds` };
  return null;
}

/** Called for every message. Returns true when it acted. */
export async function automod(message, config) {
  const rules = rulesOf(config);
  if (!rules.on || !message.guild || message.author.bot || message.webhookId || message.system) return false;
  if (isAdmin(config, message.author.id) || message.guild.ownerId === message.author.id) return false;
  const member = message.member;
  if (member?.permissions?.has([P.ManageMessages]) || member?.permissions?.has(P.Administrator)) return false; // moderators are never moderated
  const now = Date.now(), win = Math.max(rules.duplicateSeconds, rules.floodSeconds) * 1000;
  const list = (seen.get(message.author.id) ?? []).filter(r => now - r.at < win);
  const hit = inspect(message.content, { mentions: message.mentions?.users?.size ?? 0, accountAgeDays: (now - message.author.createdTimestamp) / 86_400_000, recent: list.filter(r => now - r.at < rules.floodSeconds * 1000 || r.text === message.content.trim().toLowerCase()) }, rules);
  list.push({ at: now, text: message.content.trim().toLowerCase() }); seen.set(message.author.id, list.slice(-30));
  if (seen.size > 5000) for (const k of seen.keys()) { seen.delete(k); if (seen.size < 4000) break; }
  if (!hit) return false;
  const me = message.guild.members.me;
  const canDelete = message.channel.permissionsFor(me)?.has(P.ManageMessages);
  const row = { guild: message.guild.id, user: "automod", action: `automod:${hit.rule}`, targetId: message.author.id, target: `#${message.channel.name}`, risk: "low", permission: canDelete ? "ok" : "bot lacks ManageMessages" };
  let acted = "";
  try {
    if (canDelete) { await message.delete(); acted = "deleted the message"; }
    if (rules.action === "warn" || rules.action === "timeout") {
      addWarning({ guild: message.guild.id, user: message.author.id, by: "automod", reason: `automod: ${hit.why}` });
      acted += (acted ? ", " : "") + "recorded a warning";
      const count = warningsOf(message.guild.id, message.author.id).length;
      if (rules.action === "timeout" && rules.timeoutAfterWarnings && count >= rules.timeoutAfterWarnings && member?.moderatable) { await member.timeout(rules.timeoutMinutes * 60_000, `automod: ${count} warnings`); acted += `, timed them out for ${rules.timeoutMinutes} minutes`; }
    }
    audit({ ...row, ok: true, ms: 0 });
    const text = `🛡️ ${acted || "noticed it"}: <@${message.author.id}> posted ${hit.why} in <#${message.channelId}>.`;
    const channel = rules.logChannel ? await message.client.channels.fetch(rules.logChannel).catch(() => null) : null;
    if (channel?.isSendable?.()) await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
    message.channel.send({ content: `<@${message.author.id}> that message was removed: ${hit.why}.`, allowedMentions: { users: [message.author.id], parse: [] } }).then(m => setTimeout(() => m.delete().catch(() => {}), 8000)).catch(() => {});
    return true;
  } catch (e) {
    audit({ ...row, ok: false, error: String(e?.message ?? e).slice(0, 200) });
    return false;
  }
}

/** "Check if anyone has been spamming": reads recent messages and reports what the rules would have caught, without acting. */
export async function scanChannel(channel, config, limit = 100) {
  const rules = { ...rulesOf(config), on: true };
  const batch = [...(await channel.messages.fetch({ limit })).values()].filter(m => !m.author.bot).reverse();
  const per = new Map(), hits = [];
  for (const m of batch) {
    const list = per.get(m.author.id) ?? [];
    const recent = list.filter(r => m.createdTimestamp - r.at < rules.floodSeconds * 1000 || r.text === m.content.trim().toLowerCase());
    const hit = inspect(m.content, { mentions: m.mentions?.users?.size ?? 0, accountAgeDays: (Date.now() - m.author.createdTimestamp) / 86_400_000, recent }, rules);
    list.push({ at: m.createdTimestamp, text: m.content.trim().toLowerCase() }); per.set(m.author.id, list);
    if (hit) hits.push({ message: m, ...hit });
  }
  return { scanned: batch.length, hits };
}
