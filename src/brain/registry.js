import { TOOLS } from "../admin/tools.js";
import "./tools.js";

/**
 * The schema layer over the administrator's tool registry. admin/tools.js stays the single place where a tool runs and where its permissions
 * and risk live (so there is one gate); this file adds what the intelligence layer needs on top: what each tool requires, which tool is
 * allowed to answer which intent, and validation of the model's calls. A model can't invent a tool name, an argument or an id: anything not
 * declared here is rejected before it reaches Discord.
 */
export const SCHEMAS = {
  member_list: { purpose: "List the actual members of the server (filter by role, name, humans/bots; paged).", required: [], optional: ["role", "query", "kind", "sort"], verifies: "members come straight from Discord's member list" },
  channel_visibility: { purpose: "Which channels @everyone or a role can see, or which are hidden / read-only for them.", required: [], optional: ["role", "mode"], verifies: "read from the channels' permissions" },
  member_count: { purpose: "The number of members.", required: [], optional: [] },
  member_online: { purpose: "Who or how many are online (needs the Presence intent for names).", required: [], optional: [] },
  server_overview: { purpose: "Server information: name, owner, channels, roles, boosts, safety settings.", required: [], optional: [] },
  role_list: { purpose: "List the server's roles.", required: [], optional: [] },
  role_members: { purpose: "Members of one role.", required: ["role"], optional: [] },
  channel_list: { purpose: "List the channels by category.", required: [], optional: [] },
  invite_create: { purpose: "Create a real invite link.", required: [], optional: ["channel", "expires", "max_uses", "permanent", "temporary"], verifies: "read back from Discord" },
  channel_create: { purpose: "Create a text/voice/announcement channel or a category.", required: ["name"], optional: ["kind", "category", "private", "role", "access", "topic"], verifies: "fetched back; private means @everyone cannot view" },
  channel_access: { purpose: "Make an existing channel private, read-only or public for roles.", required: [], optional: ["access", "role", "roles"], verifies: "@everyone's view permission is read back" },
  role_create: { purpose: "Create a role.", required: ["name"], optional: ["color", "hoist", "mentionable", "permission"] },
  role_assign: { purpose: "Give a role to a member or take it away.", required: ["role"], optional: ["user"], verifies: "member is re-fetched" },
  message_send: { purpose: "Post an announcement or text in a channel (idempotent).", required: ["text"], optional: ["title", "key"], verifies: "message is fetched back" },
  message_update: { purpose: "Edit a message the bot sent.", required: ["messageId", "text"], optional: ["title"], verifies: "edit is read back" },
  message_pin: { purpose: "Pin a message.", required: ["messageId"], optional: [], verifies: "pinned flag is read back" },
  message_remove: { purpose: "Delete a message (asks for confirmation).", required: ["messageId"], optional: ["preview"], verifies: "message is confirmed gone" },
};
for (const [name, s] of Object.entries(SCHEMAS)) s.name = name;

/** Which tools may answer an intent. A related-but-different tool is not an acceptable substitute (a server overview is not a member list). */
export const INTENT_TOOLS = {
  "members.list": ["member_list"], "members.byRole": ["member_list", "role_members"], "members.search": ["member_list", "member_search"],
  "members.count": ["member_count"], "members.online": ["member_online"],
  "server.overview": ["server_overview"], "channels.visibility": ["channel_visibility"], "channel.info": ["channel_info"], "roles.list": ["role_list"], "channels.list": ["channel_list"], "invite.create": ["invite_create"],
  "channel.create": ["channel_create"], "category.create": ["channel_create"], "role.create": ["role_create"], "channel.access": ["channel_access", "hide"],
  "role.assign": ["role_assign", "role_add"], "role.remove": ["role_assign", "role_remove"],
  "draft.send": ["message_send"], "message.pin": ["message_pin"], "message.delete": ["message_remove"], "message.edit": ["message_update"],
  "compound.setup": ["channel_create", "role_assign", "channel_access"],
};
export const toolAllowed = (primary, tool) => !!INTENT_TOOLS[primary] && INTENT_TOOLS[primary].includes(tool); // default deny: an intent with no tool list may not run any tool
for (const p of ["draft.write", "draft.revise", "draft.approve", "draft.show", "draft.restore", "memory.remember", "memory.forget", "memory.show", "repeat", "correction.channel", "context.resume"]) INTENT_TOOLS[p] ??= [];

/** Everything the registry says about a tool, joining the schema with the gate's own permission data. */
export function describe(name) {
  const spec = TOOLS[name]; if (!spec) return null;
  const s = SCHEMAS[name] ?? {};
  return { name, cap: spec.cap, risk: spec.risk, userPermissions: spec.user ?? [], botPermissions: spec.bot ?? [], confirms: spec.risk === "high", ...s };
}

/** Actions the older moderation path accepts (they are not registry tools). */
const LEGACY = new Set(["purge", "timeout", "untimeout", "mute", "unmute", "kick", "ban", "unban", "warn", "slowmode", "lock", "unlock", "say", "poll", "pin", "unpin", "react", "create_channel", "rename_channel", "topic", "dm", "role_add", "role_remove", "nickname", "countdown", "set_permission", "permission", "permissions", "hide", "unhide", "delete_channel", "move_channel", "clone_channel", "nsfw", "create_role", "edit_role", "delete_role", "voice_mute", "voice_unmute", "voice_disconnect", "voice_move", "thread_archive", "thread_lock", "remind", "reminder", "alert", "member_info", "whois", "read_messages", "recent_messages", "workflow", "setup", "setup_category", "setup_course", "setup_vip"]);
export const knownAction = a => Object.hasOwn(TOOLS, a) || LEGACY.has(a);

/** Validates a model's call: the action exists, and the arguments it relies on are present. Returns { ok, errors }. */
export function validate(action, args = {}) {
  const a = String(action ?? "").toLowerCase();
  if (!knownAction(a)) return { ok: false, errors: [`unknown action "${a}"`] };
  const s = SCHEMAS[a]; if (!s) return { ok: true, errors: [] };
  const errors = s.required.filter(k => args[k] == null || String(args[k]).trim() === "").map(k => `missing ${k}`);
  return { ok: !errors.length, errors };
}
