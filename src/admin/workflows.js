import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { audit } from "./audit.js";
import { botMissing, sayMissing, userMissing } from "./guard.js";
import { accessOverwrites, effective, findRole } from "./tools.js";
import { confirmButtons, panel } from "./ui.js";

/**
 * Multi-step server work. A request like "set up a VIP category" or "prepare the server for a new course" becomes a plan: ordered steps, each
 * with what it needs first, how to do it, how to undo it and how to check it. The plan is shown and confirmed before anything is created, the
 * bot's permissions are checked up front, each step reports as it finishes (the status message is edited in place), what already exists is reused
 * rather than created twice, every result is read back from Discord, and if a step fails what this run created is removed again.
 */
const clean = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const csv = v => (Array.isArray(v) ? v : String(v ?? "").split(/\s*(?:,|\|)\s*/)).map(x => String(x).trim()).filter(Boolean);
const slug = s => String(s).toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").slice(0, 90) || "channel";

const PRESETS = {
  vip: { channels: ["vip-chat", "vip-signals", "vip-voice:voice"], role: "VIP", private: true },
  staff: { channels: ["staff-chat", "staff-logs", "staff-voice:voice"], role: "Staff", private: true },
  course: { channels: ["course-info:read_only", "announcements:read_only", "lesson-1", "lesson-2", "lesson-3", "questions", "homework", "live-session:voice"], role: "Student", instructors: "Instructor", private: true },
};

/** The plan, without running anything: what will be created, reused or skipped. */
export function buildPlan(guild, args) {
  const kind = /course|class|academy|training|lesson/i.test(`${args.preset ?? ""} ${args.kind ?? ""} ${args.name ?? ""}`) ? "course" : /staff|mod/i.test(`${args.preset ?? ""} ${args.name ?? ""}`) ? "staff" : "vip";
  const base = PRESETS[args.preset] ?? PRESETS[kind];
  const name = String(args.name ?? args.category ?? (kind === "course" ? "Trading Course" : kind === "staff" ? "Staff" : "VIP")).trim().slice(0, 90);
  const channels = (csv(args.channels).length ? csv(args.channels) : base.channels).map(c => { const [n, t] = String(c).split(":"); return { name: slug(n), type: t === "voice" ? ChannelType.GuildVoice : ChannelType.GuildText, readOnly: t === "read_only" }; });
  const roleName = String(args.role ?? base.role).trim();
  const priv = args.private == null ? base.private : /^(true|yes|on|1)$/i.test(String(args.private));
  const instructors = base.instructors && !args.role ? base.instructors : args.instructors ? String(args.instructors) : null;
  const existingRole = findRole(guild, roleName), existingCat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && clean(c.name) === clean(name));
  const steps = [];
  if (priv && !existingRole) steps.push({ id: "role", label: `Create the **${roleName}** role`, needs: [P.ManageRoles] });
  if (instructors && !findRole(guild, instructors)) steps.push({ id: "instructors", label: `Create the **${instructors}** role`, needs: [P.ManageRoles] });
  steps.push({ id: "category", label: existingCat ? `Reuse the **${existingCat.name}** category` : `Create the **${name}** category${priv ? " (private)" : ""}`, needs: existingCat ? [] : [P.ManageChannels] });
  for (const c of channels) steps.push({ id: `ch:${c.name}`, label: `${existingCat && guild.channels.cache.some(x => x.parentId === existingCat.id && clean(x.name) === clean(c.name)) ? "Reuse" : "Create"} ${c.type === ChannelType.GuildVoice ? "voice" : "text"} channel **${c.name}**${c.readOnly ? " (read-only)" : ""}`, needs: [P.ManageChannels] });
  steps.push({ id: "verify", label: "Check that everything exists and the access is correct", needs: [] });
  if (args.announce) steps.push({ id: "announce", label: "Post a welcome message in the first channel", needs: [P.SendMessages] });
  if (args.invite) steps.push({ id: "invite", label: "Create an invitation", needs: [P.CreateInstantInvite] });
  return { kind, name, roleName, priv, instructors, channels, steps, needs: [...new Set(steps.flatMap(s => s.needs))] };
}

/** Runs a plan end to end. Returns the final summary post. */
export async function runWorkflow(message, args, config) {
  const guild = message.guild, plan = buildPlan(guild, args), t0 = Date.now();
  const um = userMissing(message, [P.ManageChannels, ...(plan.priv ? [P.ManageRoles] : [])]);
  if (um.length) return { content: `You don't have the Discord permission for that (${um.join(", ")}), so I can't set it up for you.`, allowedMentions: { parse: [] } };
  const bm = botMissing(guild, plan.needs);
  if (bm.length) return { content: `I can't start: ${sayMissing(bm)} Nothing was created.`, allowedMentions: { parse: [] } };
  if (config.ai?.admin?.incident) return { content: "🛑 Administrator actions are switched off (incident mode).", allowedMentions: { parse: [] } };
  if ((config.ai?.admin?.disabled ?? []).includes("workflows")) return { content: "The workflow tools are switched off.", allowedMentions: { parse: [] } };

  const preview = plan.steps.map((s, i) => `${i + 1}. ${s.label}`);
  const trusted = (config.ai?.admin?.trusted ?? []).includes("workflow");
  if (!trusted && !(await confirmButtons(message, { title: `Set up ${plan.name}?`, lines: ["This will make these changes:", ...preview], ttl: (config.ai?.admin?.confirmSeconds ?? 30) * 1000, danger: false }))) {
    audit({ guild: guild.id, user: message.author?.id, action: "workflow", target: plan.name, risk: "high", confirmed: false, ok: false, error: "cancelled", ms: Date.now() - t0 });
    return { content: "Cancelled. Nothing was changed.", allowedMentions: { parse: [] } };
  }

  const status = message.channel?.send ? await message.channel.send(panel({ title: `Setting up ${plan.name}`, lines: preview.map(l => `⏳ ${l.replace(/^\d+\. /, "")}`), accent: "amber" })) : null;
  const done = [], failed = [], created = [];
  const progress = (current) => status?.edit(panel({ title: `Setting up ${plan.name}`, accent: "amber", lines: plan.steps.map(s => `${done.find(d => d.id === s.id) ? (done.find(d => d.id === s.id).reused ? "↪️" : "✅") : failed.find(f => f.id === s.id) ? "❌" : s.id === current ? "🔄" : "⏳"} ${s.label}`) })).catch(() => {});
  const reason = `Set up by ${message.author?.tag ?? "the owner"} via YSER Lab`;
  const state = { role: null, instructors: null, category: null, channels: [] };
  try {
    for (const step of plan.steps) {
      await progress(step.id);
      if (step.id === "role" || step.id === "instructors") {
        const q = step.id === "role" ? plan.roleName : plan.instructors;
        let role = findRole(guild, q), reused = !!role && clean(role.name) === clean(q);
        if (!reused) { role = await guild.roles.create({ name: q, reason }); created.push({ kind: "role", id: role.id, name: role.name }); }
        state[step.id] = role; done.push({ id: step.id, reused });
      } else if (step.id === "category") {
        let cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && clean(c.name) === clean(plan.name)), reused = !!cat;
        const roles = [state.role ?? findRole(guild, plan.roleName), state.instructors ?? (plan.instructors ? findRole(guild, plan.instructors) : null)].filter(Boolean);
        if (!cat) { cat = await guild.channels.create({ name: plan.name, type: ChannelType.GuildCategory, permissionOverwrites: plan.priv ? accessOverwrites(guild, { mode: "private", roles }) : undefined, reason }); created.push({ kind: "channel", id: cat.id, name: cat.name }); }
        state.category = cat; state.roles = roles; done.push({ id: "category", reused });
      } else if (step.id.startsWith("ch:")) {
        const spec = plan.channels.find(c => `ch:${c.name}` === step.id);
        let ch = guild.channels.cache.find(c => c.parentId === state.category.id && clean(c.name) === clean(spec.name)), reused = !!ch;
        if (!ch) {
          const ow = plan.priv ? accessOverwrites(guild, { mode: "private", roles: state.roles }) : [];
          ch = await guild.channels.create({ name: spec.name, type: spec.type, parent: state.category.id, permissionOverwrites: ow.length ? ow : undefined, reason });
          if (spec.readOnly && state.roles[0]) await ch.permissionOverwrites.edit(state.roles[0].id, { SendMessages: false }, { reason }).catch(() => {});
          created.push({ kind: "channel", id: ch.id, name: ch.name });
        }
        state.channels.push({ spec, ch }); done.push({ id: step.id, reused });
      } else if (step.id === "verify") {
        const problems = [];
        const cat = await guild.channels.fetch(state.category.id, { force: true }).catch(() => null);
        if (!cat) problems.push("the category is missing");
        for (const { spec, ch } of state.channels) {
          const fresh = await guild.channels.fetch(ch.id, { force: true }).catch(() => null);
          if (!fresh) { problems.push(`#${spec.name} is missing`); continue; }
          if (fresh.parentId !== state.category.id) problems.push(`#${spec.name} is not in the category`);
          if (plan.priv && effective(fresh, guild.roles.everyone).view) problems.push(`#${spec.name} is still visible to @everyone`);
          if (plan.priv && state.roles[0] && !effective(fresh, state.roles[0]).view) problems.push(`#${spec.name} is not visible to ${state.roles[0].name}`);
        }
        if (problems.length) throw new Error(`verification failed: ${problems.join("; ")}`);
        done.push({ id: "verify" });
      } else if (step.id === "announce") {
        const first = state.channels.find(c => c.ch.isSendable?.())?.ch;
        const sent = first ? await first.send(panel({ title: `Welcome to ${plan.name}`, lines: [args.welcome ? String(args.welcome).slice(0, 1500) : `This space is ready. Introduce yourself and ask questions in the channels here.`] })) : null;
        if (!sent?.id) throw new Error("Discord did not confirm the welcome message");
        done.push({ id: "announce" });
      } else if (step.id === "invite") {
        const target = state.channels.find(c => c.ch.type === ChannelType.GuildText)?.ch ?? guild.rulesChannel ?? guild.systemChannel;
        const inv = target ? await guild.invites.create(target, { maxAge: 0, unique: true, reason }) : null;
        if (!inv) throw new Error("no channel to invite to");
        state.invite = inv.url; done.push({ id: "invite" });
      }
      await progress(null);
    }
  } catch (e) {
    const step = plan.steps.find(s => !done.some(d => d.id === s.id) && !failed.some(f => f.id === s.id));
    if (step) failed.push({ id: step.id, error: String(e.message ?? e) });
    const undone = [];
    for (const item of created.reverse()) { // newest first, so channels go before the category and role they sit under
      try { await (item.kind === "role" ? guild.roles.delete(item.id, "rollback") : guild.channels.delete(item.id, "rollback")); undone.push(item.name); } catch { /* stays; reported below */ }
    }
    audit({ guild: guild.id, user: message.author?.id, action: "workflow", target: plan.name, risk: "high", confirmed: true, ok: false, error: failed[0]?.error, ms: Date.now() - t0 });
    const left = created.filter(c => !undone.includes(c.name));
    const post = panel({ title: `Setting up ${plan.name} failed`, accent: "down", lines: [`❌ ${failed[0]?.error ?? "unknown error"}`, `Completed before it stopped: ${done.length ? done.map(d => d.id).join(", ") : "nothing"}.`, undone.length ? `↩️ Rolled back what this run created: ${undone.join(", ")}.` : "Nothing needed rolling back.", left.length ? `⚠️ Could not remove: ${left.map(c => c.name).join(", ")}. Check them in Server Settings.` : ""] });
    if (status) { await status.edit(post).catch(() => {}); return null; }
    return post;
  }
  audit({ guild: guild.id, user: message.author?.id, action: "workflow", target: plan.name, risk: "high", confirmed: !trusted, ok: true, ms: Date.now() - t0 });
  const summary = panel({ title: `${plan.name} is ready`, accent: "up", lines: [
    ...plan.steps.map(s => `${done.find(d => d.id === s.id)?.reused ? "↪️" : "✅"} ${s.label}`),
    state.invite ? `🔗 ${state.invite}` : "",
    `-# Verified with Discord in ${Math.round((Date.now() - t0) / 100) / 10}s. ↪️ means it already existed and was left as it was.`,
  ] });
  if (status) { await status.edit(summary).catch(() => {}); return null; }
  return summary;
}
