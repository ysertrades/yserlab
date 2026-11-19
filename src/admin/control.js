import { isOwner } from "../access.js";
import { db, settings } from "../store.js";
import { recentAudit } from "./audit.js";
import { AUTOMOD_DEFAULTS, rulesOf, scanChannel } from "./automod.js";
import { CAPABILITIES, TOOLS } from "./tools.js";
import { panel } from "./ui.js";

/**
 * The owner's controls over the administrator itself, spoken in plain words: switch a group of tools off or on, stop everything during an
 * incident, choose which risky actions may run without a confirmation, tune the server protection, and inspect what it has done. Owner only,
 * checked here and not from anything the model says. Changes are written to the same settings the app's control page edits.
 */
const plain = text => ({ content: String(text).slice(0, 1990), allowedMentions: { parse: [] } });
const friendly = (m, t) => Object.assign(new Error(m), { friendly: t });
const isTrue = v => /^(true|yes|on|1|enable|enabled)$/i.test(String(v ?? ""));

/** Changes the stored settings with `edit(data)` and refreshes the bot's copy. */
export async function setConfig(edit) {
  if (!db) throw friendly("no db", "I can't save settings right now (no database connection).");
  const { data: row, error } = await db.from("bot_config").select("data").eq("id", "main").maybeSingle();
  if (error) throw new Error(error.message);
  const next = edit(structuredClone(row?.data ?? {}));
  const { error: e2 } = await db.from("bot_config").update({ data: next }).eq("id", "main");
  if (e2) throw new Error(e2.message);
  await settings(true);
  return next;
}
const admin = d => (d.ai ??= {}, d.ai.admin ??= {}, d.ai.admin);

const ownerOnly = message => { if (!isOwner(message.author?.id)) throw friendly("owner only", "Only the owner can change how the administrator works."); };

Object.assign(TOOLS, {
  ai_control: {
    cap: "info", risk: "read", bot: [], aliases: ["ai_status", "capabilities", "incident", "resume"],
    async run({ message, args, config, action }) {
      const A = config.ai?.admin ?? {}, rules = rulesOf(config);
      const op = String(args.op ?? args.mode ?? (action === "incident" ? "incident_on" : action === "resume" ? "incident_off" : "status")).toLowerCase();
      if (op === "status") {
        const failures = recentAudit(200).filter(a => !a.ok && a.confirmed !== false).slice(0, 5);
        return panel({ title: "Administrator status", accent: A.incident ? "down" : "up", lines: [
          A.incident ? "🛑 **Incident mode is ON**: every administrator action is blocked." : "✅ Running normally.",
          `Tool groups: ${CAPABILITIES.map(c => `${(A.disabled ?? []).includes(c) ? "⛔" : "✅"} ${c}`).join(" · ")}`,
          `Runs without asking: ${(A.trusted ?? []).length ? A.trusted.join(", ") : "nothing (every risky action asks first)"}`,
          `Server protection (automod): ${rules.on ? "on" : "off"}`,
          failures.length ? `Recent failures:\n${failures.map(f => `• ${f.action}: ${String(f.error).slice(0, 90)}`).join("\n")}` : "No recent failures.",
          `-# ${Object.keys(TOOLS).length} tools registered. Say "show recent actions" for the log.`,
        ] });
      }
      ownerOnly(message);
      const group = String(args.group ?? args.capability ?? args.name ?? "").toLowerCase();
      if (op === "incident_on" || op === "incident_off") { await setConfig(d => { admin(d).incident = op === "incident_on"; return d; }); return plain(op === "incident_on" ? "🛑 Incident mode is on. I will not run any administrator action until you say \"resume administrator actions\"." : "✅ Administrator actions are back on."); }
      if (op === "disable" || op === "enable") {
        const wanted = group === "all" ? CAPABILITIES : CAPABILITIES.filter(c => c === group);
        if (!wanted.length) throw friendly("unknown group", `Which group? One of: ${CAPABILITIES.join(", ")}, or all.`);
        await setConfig(d => { const a = admin(d); a.disabled = op === "disable" ? [...new Set([...(a.disabled ?? []), ...wanted])] : (a.disabled ?? []).filter(c => !wanted.includes(c)); return d; });
        return plain(`${op === "disable" ? "⛔ Switched off" : "✅ Switched on"}: ${wanted.join(", ")}.`);
      }
      if (op === "trust" || op === "untrust") {
        const tool = String(args.tool ?? args.name ?? "").toLowerCase(); if (!TOOLS[tool]) throw friendly("unknown tool", `I don't have a tool called "${tool}".`);
        await setConfig(d => { const a = admin(d); a.trusted = op === "trust" ? [...new Set([...(a.trusted ?? []), tool])] : (a.trusted ?? []).filter(t => t !== tool); return d; });
        return plain(op === "trust" ? `✅ **${tool}** will run without asking for confirmation.` : `**${tool}** will ask for confirmation again.`);
      }
      throw friendly("unknown op", "I can show the status, switch a tool group on or off, turn incident mode on or off, and choose which actions run without asking.");
    },
  },
  automod_set: {
    cap: "moderation", risk: "read", bot: [], aliases: ["automod_status", "automod_on", "automod_off"],
    async run({ message, args, config, action }) {
      const rules = rulesOf(config);
      const status = () => panel({ title: "Server protection", accent: rules.on ? "up" : "flat", lines: [
        rules.on ? "✅ On" : "⛔ Off (say \"turn on anti-spam\" to start)",
        `Invite links: ${rules.inviteLinks ? "deleted" : "allowed"} · mass mentions: ${rules.massMention ? `${rules.massMention}+` : "off"} · repeated messages: ${rules.duplicates ? `${rules.duplicates} in ${rules.duplicateSeconds}s` : "off"} · flooding: ${rules.flood ? `${rules.flood} in ${rules.floodSeconds}s` : "off"}`,
        `Scam patterns: ${rules.phishing ? "on" : "off"} · blocked domains: ${rules.blockedDomains.length || "none"} · blocked words: ${rules.blockedWords.length || "none"} · links from accounts under ${rules.newAccountDays || "—"} days: ${rules.newAccountDays ? "blocked" : "allowed"}`,
        `Action: deletes the message${rules.action === "warn" || rules.action === "timeout" ? " and records a warning" : ""}${rules.action === "timeout" && rules.timeoutAfterWarnings ? `; after ${rules.timeoutAfterWarnings} warnings a ${rules.timeoutMinutes}-minute timeout` : ""}. It never bans or kicks on its own, and never touches admins, moderators or bots.`,
        "-# Raid and mass-join detection needs the Server Members intent, which is not enabled for the bot.",
      ] });
      if (action === "automod_status" || (!args.op && !args.setting && action === "automod_set" && !args.on)) return status();
      ownerOnly(message);
      const on = action === "automod_off" ? false : action === "automod_on" ? true : args.on != null ? isTrue(args.on) : null;
      const setting = String(args.setting ?? "").trim(), value = args.value;
      await setConfig(d => {
        d.ai ??= {}; d.ai.automod = { ...AUTOMOD_DEFAULTS, ...(d.ai.automod ?? {}) };
        if (on != null) d.ai.automod.on = on;
        if (setting && setting in AUTOMOD_DEFAULTS && setting !== "on") {
          const kind = typeof AUTOMOD_DEFAULTS[setting];
          d.ai.automod[setting] = Array.isArray(AUTOMOD_DEFAULTS[setting]) ? String(value ?? "").split(/\s*,\s*/).filter(Boolean) : kind === "number" ? Math.max(0, Number(value) || 0) : kind === "boolean" ? isTrue(value) : String(value ?? "");
        }
        return d;
      });
      Object.assign(rules, rulesOf((await settings(true)).config));
      return status();
    },
  },
  scan_spam: {
    cap: "moderation", risk: "read", user: [], bot: [], aliases: ["check_spam", "scan_channel", "find_suspicious_links"],
    async run({ channel, config }) {
      const { scanned, hits } = await scanChannel(channel, config, 100);
      if (!hits.length) return panel({ title: "Spam check", accent: "up", lines: [`✅ Nothing suspicious in the last ${scanned} messages in ${channel}.`], footer: "Using the current protection rules" });
      const by = new Map(); for (const h of hits) by.set(h.message.author.id, [...(by.get(h.message.author.id) ?? []), h]);
      return panel({ title: "Spam check", accent: "amber", pings: [], lines: [`Checked ${scanned} messages in ${channel}. **${hits.length}** would be flagged, from ${by.size} ${by.size === 1 ? "person" : "people"}:`, ...[...by.entries()].slice(0, 10).map(([id, list]) => `• <@${id}>: ${[...new Set(list.map(h => h.why))].slice(0, 3).join("; ")} (${list.length})`), "-# I only report. Tell me what to do (warn, timeout, delete): I won't punish anyone on a guess."] });
    },
  },
});
