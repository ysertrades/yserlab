/**
 * The first look at a message from the owner, before any language model: the plain, common administrator requests are recognised by rule and
 * go straight to the tool, so "give me an invite link" can never turn into a question about tagging someone. Anything not recognised here goes to
 * the model as before. A request that is clear but missing one essential detail (a name) asks for it once and remembers what it was doing, so the
 * next message is taken as the answer.
 */
const pending = new Map(); // "channel:user" -> { action, args, ask, at }
const TTL = 3 * 60_000;
const COLOURS = { purple: "#9b59b6", violet: "#8d9bff", red: "#e74c3c", blue: "#3d5afe", green: "#3ccf7a", gold: "#f1c40f", yellow: "#f1c40f", orange: "#e67e22", pink: "#ff6fb5", white: "#ffffff", black: "#111111", grey: "#8e8e94", gray: "#8e8e94", teal: "#1abc9c", cyan: "#5cc8f2" };
const clean = s => String(s ?? "").replace(/<@!?\d+>/g, "").replace(/\s+/g, " ").trim();
const channelId = t => /<#(\d{15,})>/.exec(t)?.[1];

function invite(t) {
  if (!/\b(invites?|invitations?|server link|join link|link to (join|get into) (the |this )?server|how (do|can) (i|people|someone|we) (get|join|come) (in|into)? ?(the |this |our )?server)\b/i.test(t)) return null;
  if (/\b(revoke|delete|remove|cancel|disable|kill)\b/i.test(t)) {
    const code = /(?:discord\.gg\/|discord\.com\/invite\/|\bcode\s+)([a-z0-9-]{4,})/i.exec(t)?.[1] ?? /\b(?:invite|link)\s+([a-z0-9-]{5,})\b/i.exec(t)?.[1];
    return code ? { action: "invite_revoke", args: { code } } : { say: "Which invitation should I revoke? Give me its code or link, or ask me to list the active ones." };
  }
  if (/\b(show|list|active|existing|current|all)\b.*\b(invites?|invitations?)\b|\b(invites?|invitations?)\b.*\b(active|existing|list)\b/i.test(t)) return { action: "invite_list", args: {} };
  const args = {};
  if (/\b(permanent|never expires?|forever|doesn'?t expire|no expir)/i.test(t)) args.permanent = "true";
  const exp = /(?:expires?|lasts?|valid|for|in)\s+(?:in\s+)?(\d+(?:\.\d+)?)\s*(second|sec|minute|min|hour|hr|day|week)s?/i.exec(t) ?? /(\d+(?:\.\d+)?)\s*(second|sec|minute|min|hour|hr|day|week)s?\s*(?:expir|only|long)/i.exec(t);
  if (exp) args.expires = `${exp[1]} ${exp[2]}`;
  else if (/\b24\s*h/i.test(t)) args.expires = "24 hours";
  const uses = /(?:max(?:imum)?(?:\s+of)?|up to|limit(?:ed)?(?:\s+to)?|only)\s*(\d+)\s*(?:uses?|people|members|joins?)?|(\d+)\s*(?:uses?|time)/i.exec(t);
  if (uses) args.max_uses = uses[1] ?? uses[2];
  if (/\btemporary\b/i.test(t)) args.temporary = "true";
  const ch = channelId(t) ?? /\bfor\s+(?:the\s+)?#?([\w-]{2,})\s+channel\b/i.exec(t)?.[1];
  if (ch) args.channel = ch;
  return { action: "invite_create", args };
}

function create(t, key) {
  const m = /\b(create|make|add|new|set up)\b\s+(?:a|an|the|new|another)?\s*(.*)/i.exec(t);
  if (!m || /\b(poll|event|invite|message|announcement post|reminder|ticket|warning)\b/i.test(t)) return null;
  const rest = m[2];
  const what = /\b(category|channel|role)\b/i.exec(rest)?.[1]?.toLowerCase();
  if (!what) return null;
  if (/\b(set up|prepare)\b/i.test(t) && /\b(category|course|vip|staff|area|section)\b/i.test(t) && !/\bchannel\b/i.test(t)) return null; // that is a workflow
  const args = {};
  const kindWord = /\b(text|voice|announcement|announcements|forum|stage)\b/i.exec(rest)?.[1]?.toLowerCase();
  if (what === "category") args.kind = "category"; else if (what === "channel") args.kind = kindWord ?? "text";
  if (/\b(private|staff[- ]only|hidden|restricted)\b/i.test(t)) args.private = "true";
  if (/\bread[- ]?only\b/i.test(t)) args.access = "read_only";
  let name = /\b(?:called|named|name it|titled)\s+["“']?([^"”',.]+?)["”']?(?=\s+(?:category|channel|role|with|and|that|for|in|under)\b|[.,]|$)/i.exec(t)?.[1];
  if (!name) {
    const between = rest.split(new RegExp(`\\b${what}\\b`, "i"))[0] ?? "";
    name = between.replace(/\b(private|public|new|text|voice|announcements?|forum|stage|read[- ]?only|staff[- ]only|hidden|restricted|a|an|the|another)\b/gi, "").replace(/\s+/g, " ").trim();
  }
  if (what === "role") {
    args.name = name;
    const c = Object.keys(COLOURS).find(k => new RegExp(`\\b${k}\\b`, "i").test(t)), hex = /#[0-9a-f]{6}\b/i.exec(t)?.[0];
    if (hex || c) args.color = hex ?? COLOURS[c];
    if (/\b(show|display)\w*\s+(them\s+)?separately|\bhoist/i.test(t)) args.hoist = "true";
    if (!args.name || /^(colou?r|permission)/i.test(args.name)) return { say: "What should the role be called?", pending: { action: "role_create", args, field: "name" } };
    return { action: "role_create", args };
  }
  const forRole = /\bfor\s+(?:the\s+)?([\w ]+?)\s+role\b/i.exec(t)?.[1] ?? /\b(?:accessible|visible)\s+(?:to|for|by)\s+(?:the\s+)?([\w ]+?)(?:\s+role)?(?:\.|,|$)/i.exec(t)?.[1];
  if (forRole) args.role = forRole.trim();
  const under = /\b(?:under|in|inside)\s+(?:the\s+)?([\w &-]+?)\s+category\b/i.exec(t)?.[1];
  if (under) args.category = under.trim();
  args.name = name;
  if (!args.name) return { say: `What would you like to name the ${args.kind === "category" ? "category" : "channel"}?`, pending: { action: "channel_create", args, field: "name" } };
  return { action: "channel_create", args };
}

/** Returns { action, args } to run, { say } to reply with (and maybe remember), or null when the message is not one of these. */
export function intentOf(raw, key) {
  const t = clean(raw);
  if (!t) return null;
  const waiting = pending.get(key);
  if (waiting && Date.now() - waiting.at > TTL) pending.delete(key);
  const w = pending.get(key);
  const found = detect(t, key);
  if (found) { pending.delete(key); if (found.pending) pending.set(key, { ...found.pending, at: Date.now() }); return found; }
  if (w && t.length <= 80 && !/[?]$/.test(t) && !/^(no|cancel|never mind|stop|forget it)\b/i.test(t)) {
    pending.delete(key);
    const value = t.replace(/^["“']|["”']$/g, "").replace(/^(call it|name it|it'?s|its|the name is|name:)\s*/i, "");
    return { action: w.action, args: { ...w.args, [w.field]: value } };
  }
  if (w && /^(no|cancel|never mind|stop|forget it)\b/i.test(t)) { pending.delete(key); return { say: "Okay, cancelled." }; }
  return null;
}

function detect(t, key) {
  // Deleting a message: only when asked, and only the one meant (a reply, or "my last message"). Never as a side effect of anything else.
  if (/^(?:please\s+)?(?:delete|remove)\s+(?:this|that|the above|it|my last|my previous|my latest)(?:\s+one)?(?:\s+message)?(?:\s+(?:sent|written|posted)\s+by\s+me)?$/i.test(t) || /^(?:please\s+)?(?:delete|remove)\s+(?:this|that)\s+message\b/i.test(t)) return { action: "message_delete", args: { which: /\b(last|previous|latest)\b/i.test(t) ? "last" : "reply" } };
  let r = invite(t);
  if (r) return r;
  if (/\bresume\b.*\b(administrator|admin)\b.*\b(actions?|tools?)\b/i.test(t)) return { action: "ai_control", args: { op: "incident_off" } };
  if (/\b(stop|pause|disable|shut ?down|halt|freeze)\b.*\b(all )?(administrator|admin|server)\b.*\b(actions?|tools?|operations?)\b|\bincident mode\b/i.test(t)) return { action: "ai_control", args: { op: "incident_on" } };
  let m = /\b(enable|disable|turn (on|off))\s+(?:the\s+)?(\w+)\s+tools\b/i.exec(t);
  if (m) return { action: "ai_control", args: { op: /enable|on/i.test(m[1]) ? "enable" : "disable", group: m[3].toLowerCase() } };
  if (/\b(administrator|admin)\s+(status|settings)\b|\bwhat can you (do|manage)\b.*\b(server|discord)\b|\bwhich (tools|capabilities)\b/i.test(t)) return { action: "ai_control", args: { op: "status" } };
  m = /\bturn\s+(on|off)\s+(?:the\s+)?(anti-?spam|automod|auto-?moderation|server protection|protection)\b/i.exec(t);
  if (m) return { action: "automod_set", args: { on: m[1].toLowerCase() === "on" ? "true" : "false" } };
  if (/\b(show|what).*\b(server protection|automod|protection) (settings|status|rules)\b/i.test(t)) return { action: "automod_status", args: {} };
  if (/\b(review|audit|check)\b.*\b(server )?(protection|security|permissions|safety)\b|\b(weaknesses|vulnerabilit)/i.test(t) && !/\bchannel\b.*\bpermission\b.*\b(for|to)\b/i.test(t)) return { action: "permission_audit", args: {} };
  if (/\bwhich roles?\b.*\b(administrator|admin|dangerous|powerful)\b|\brole audit\b|\bunused roles?\b/i.test(t)) return { action: "role_audit", args: {} };
  if (/\b(anyone|someone|people|users?)\b.*\bspamm?(ing|ed)?\b|\bcheck\b.*\bspam\b|\bsuspicious links?\b|\bscam links?\b/i.test(t)) return { action: "scan_spam", args: {} };
  if (/\bhow many\b.*\b(members?|people|users)\b|\b(member|user) count\b|\bwho owns\b|\bserver owner\b|\b(summary|overview|info(?:rmation)?|details|configuration|settings|structure)\b.*\b(of |about )?(the |this |our )?server\b|\btell me about (the|this|our) server\b/i.test(t)) return { action: "server_overview", args: {} };
  if (/\b(show|list|what|which|see)\b.*\broles\b/i.test(t) && !/\b(create|make|add|give|remove|delete|assign)\b/i.test(t)) return { action: "role_list", args: {} };
  if (/\b(show|list|what|which|see)\b.*\bchannels\b/i.test(t) && !/\b(create|make|delete|rename|move|permission|access|private|hide)\b/i.test(t)) return { action: "channel_list", args: {} };
  if (/\b(upcoming|scheduled|next)\b.*\bevents?\b|\bshow\b.*\bevents\b/i.test(t) && !/\b(create|make|cancel)\b/i.test(t)) return { action: "event_list", args: {} };
  if (/\b(recent|latest|last)\b.*\b(actions|moderation|things you did)\b|\bwhat (have|did) you (done|do)\b.*\b(recently|today|lately)?/i.test(t) && /\b(show|what|list)\b/i.test(t)) return { action: "mod_log", args: {} };
  m = /\b(?:set ?up|prepare|build|create)\s+(?:a|an|the|my|our)?\s*(?:new\s+)?(.*?)\b(vip|staff|course|trading course|academy)\b\s*(?:category|area|section|space)?/i.exec(t);
  if (m && /\b(set ?up|prepare|build)\b/i.test(t) || /\bprepare the server for\b/i.test(t)) {
    const preset = /course|academy|training|class/i.test(t) ? "course" : /staff|mod/i.test(t) ? "staff" : "vip";
    const named = /\b(?:called|named)\s+["“']?([^"”',.]+)/i.exec(t)?.[1];
    return { action: "workflow", args: { preset, ...(named ? { name: named.trim() } : {}), ...(/\b(announce|announcement|welcome)\b/i.test(t) ? { announce: "true" } : {}), ...(/\b(invite|invitation|link)\b/i.test(t) ? { invite: "true" } : {}) } };
  }
  r = create(t, key);
  if (r) return r;
  return null;
}
export const forgetIntent = key => pending.delete(key);
