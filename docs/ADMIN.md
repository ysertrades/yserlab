# The Discord administrator

What was built, how it is protected, what has been tested, and what is **not** done. Read the last two sections before trusting anything.

## How a request becomes an action

1. `src/admin/intent.js` recognises the common administrator requests by rule (invites, server and role and channel questions, audits, creating channels / categories / roles, set-up workflows, switching protection on or off). A clear request goes straight to its tool, with no language model in between, so "give me an invite link" can never turn into a question about tagging someone. A request that is clear but missing a name asks once and remembers (the next message is the answer).
2. Anything else goes to the assistant (Gemini / Groq / NVIDIA through the Supabase function), which can call the `moderate` tool with any of the registered actions.
3. `src/mod.js` `moderate()` sends registered actions through `runTool` (`src/admin/tools.js`); the older actions (purge, timeout, kick, ban, lock, say, poll, remind, voice, ...) run as before and are written to the same audit log.
4. `runTool` is the single gate: incident switch, capability switch, the **requester's own Discord permissions**, the **bot's permissions** (in the channel where relevant), confirmation buttons for high-risk tools, the tool itself, a **read-back from Discord**, and an audit line. A failure becomes a plain sentence that says what to fix; nothing is reported as done unless Discord returned it.

## Tools (src/admin/tools.js, control.js, workflows.js)

| Group | Tools |
|---|---|
| invites | invite_create (expiry, max uses, temporary, channel, permanent), invite_list, invite_revoke |
| info | server_overview, channel_list, channel_info, role_list, role_info, role_members, role_audit, permission_audit (also the security audit), mod_log, ai_control |
| channels | channel_create (text, voice, announcement, forum, stage, category; private / read-only; under a category), channel_reorder |
| permissions | channel_access (private / read-only / public for roles, verified) |
| roles | role_create, role_edit (name, colour, permissions, hoist, mentionable), role_delete (confirm), role_assign (hierarchy and delegation checks, verified) |
| members | member_search (by name; ID for anything that changes a member), joined_recently |
| moderation | warn (kept in a history), mod_history, tempban (confirm; unbans itself), automod_set, scan_spam |
| events | event_create, event_list, event_cancel |
| threads | thread_create, thread_manage |
| messages | announce (Components V2), message_edit (own messages only), summarize_channel |
| community | role_panel (button roles) |
| workflows | workflow: VIP, staff or course set-up as a plan: preview and confirm, permission pre-check, reuse of what exists, step-by-step progress, verification, rollback of what the run created on failure |

Older actions kept as they were: purge, slowmode, lock/unlock, hide/unhide, set_permission, kick, ban, unban, timeout, nickname, dm, say, poll, pin, react, remind (a real notification), countdown, voice_*, delete_channel (now with confirm buttons), move/clone channel, topic, nsfw.

## Embeds and announcements (src/admin/embeds.js)

"Make an embed announcing a giveaway starting tomorrow" is written at once from what was said (relative dates become real dates; prizes, amounts, times, links and handles are never invented, and lines containing them are removed unless the request gave them). The embed is remembered as a draft (6 hours), so the next messages act on it in place: "change the colour to dark" (names, hex, and `not purple` is understood), "make it shorter" / "change the title to ..." (the model rewrites only what was asked), "post it in #lab" (a copy goes there with the same colour). It never asks a question the request already answers. What the bot posted as a Components V2 message is now also readable by the assistant (its text displays are collected), so follow-ups know what `it` is.

## Safety rules that are enforced in code (not in the prompt)

- Only the owner (and admins, when the panel allows) can reach the administrator at all (`access.js`); on top of that the requester must hold the Discord permission the action needs (the server owner and Administrators always do).
- The bot's own permission is checked first (per channel where that matters); the message says exactly which permission is missing.
- Role hierarchy: the bot cannot touch a role at or above its own highest role; the requester cannot touch a role at or above theirs (the server owner may).
- Delegation: nobody can give a role (or hand out a role carrying) a permission they do not hold themselves; only the server owner can grant Administrator.
- High-risk actions (role_delete, tempban, delete_channel, kick, ban, a workflow) show what will happen and need a Confirm button press by the requester within 30 s; anyone else's press is ignored; expiry cancels. Owner can allow chosen tools to run without asking (`ai_control trust <tool>`).
- Incident mode (`stop all administrator actions` / `resume administrator actions`) blocks everything; tool groups can be switched off and on (`disable roles tools`). Owner only, checked in code. Settings are stored in `bot_config.data.ai.admin`.
- Automod (`src/admin/automod.js`) is **off by default**. When on it only deletes the message, records a warning and (optionally, after N warnings) times out. It never bans or kicks, never touches admins, moderators or bots, and its rules are configurable.
- Every operation is written to `data/audit.jsonl` and to the app's bot log: who, which server, what, the target, whether the permission check passed, whether it was confirmed, the result or error, and how long it took.
- Components V2: every rich message the administrator sends is built by `ui.panel` (container, text displays, separator, action rows) and validated before sending (flag set, no plain content or embeds, 4000-character text limit, component and button limits). One-line confirmations stay plain text, as the rest of the bot's replies do. No existing message, template or button was rewritten.

## Tested

`tests/admin.test.js` (22 tests, all passing, together with the existing 19) uses stand-ins for Discord's objects and proves: invite intent in many phrasings and parameters; the invite tool returns the URL Discord returned and fabricates nothing; missing bot / user permission and the incident and capability switches block and are audited; confirmation does nothing on cancel or timeout and acts on confirm; hierarchy and delegation limits; private channels are verified; workflows create, verify, roll back and cancel correctly; automod rules catch scams, invites, mention spam and repeats and leave normal chat alone; Components V2 limits; the registry is complete; the owner-only control.

## NOT verified, NOT done (be honest)

- **Nothing here has been run against the live Discord API.** The tests use stand-ins. The acceptance criterion "verified against actual Discord API results" is open until each tool is exercised in a development server. Do that before relying on any of it: invite, channel_create (private), role_create / role_assign, channel_access, event_create, workflow, role_panel, the confirm buttons.
- **No Server Members intent.** Without it (a privileged intent the owner must switch on in the Developer Portal, and the bot must request) these cannot work: raid / mass-join detection, welcome and goodbye messages, listing who joined, a complete role-member list, inactive-member reports, account-age checks on arrival. The tools say so when asked instead of guessing.
- **Not built:** ticket system (the bot had none; nothing to integrate), appeal workflows, moderator-activity and engagement reports (need message counting), reaction-based roles (button roles are built), forum-post management beyond threads, event editing, voice channel limits as a tool, mass role assignment, a visual control page in the app (control is by chat: status, disable / enable, trust, incident), per-role permission tiers beyond "owner / admins" (moderators and instructors cannot use the AI yet).
- Discord's native AutoMod rules are only read (counted in the audit), not created.
- The assistant model still decides which tool to call for anything the rule router does not recognise; the router covers the common requests, not every phrasing.
