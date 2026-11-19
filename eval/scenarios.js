// Adversarial scenario set for the assistant's brain (src/brain). Every scenario is a short conversation replayed through brain.handle against
// the stand-in server (tests/helpers/world.js); the LAST message is the one under test, everything before it ("prev") is replayed first.
//
// The expectations describe what a correct assistant would do, not what the current code does. Scenarios the system cannot pass today are
// kept on purpose: they are the baseline that later work is measured against. Never edit an expectation to make a run pass.
//
// Fields of a scenario (only `say` is required):
//   id, cat, diff (1-5)     identity, category key (see CATEGORIES), difficulty
//   world / setup(w, c)     options for makeWorld, and a function that prepares the server before the conversation starts
//   prev                    earlier turns: "text" or { say, ch: "channelName", reset: true (new conversation), pre(w) }
//   say                     the message under test
//   intent                  primary intent (string, or an array of acceptable ones); llm: true = must be left to the language model
//   tool                    the last recorded operation (mem.recentOps) this turn; null = no operation may be recorded. Derived from the
//                           intent when omitted.
//   args                    { key: expected } checked on the classification's params+target (string = case-insensitive equal, RegExp,
//                           boolean, array, or function(value)); or a function(k, c)
//   clarify                 true when it must ask a question first (default false)
//   confirm                 true when a confirm panel must appear (high risk, or the target came from a reference); default false
//   mut                     the exact allowed server changes this turn, in order: strings / RegExps, or function(w, c). Default [].
//                           null = not checkable on the stand-in (the operation has no stand-in side effect)
//   mutAllow                extra changes that are tolerated (e.g. permission overwrites)
//   state(w, c)             a state check on the resulting server / memory
//   said / notSaid          regexes (strings) the reply must / must not match
//   ref: true               counted in the reference-resolution metric
import { PermissionFlagsBits as P } from "discord.js";

export const CATEGORIES = {
  members: "Member / role / server queries",
  drafts: "Drafts and follow-ups",
  creation: "Creation and continuity",
  refs: "Reference resolution",
  corrections: "Corrections",
  multi: "Multi-instruction messages",
  missing: "Missing parameters / clarification",
  long: "Long conversations with topic switches",
  memory: "Preferences and memory",
  llm: "Left to the language model",
};

export const ID = { ahmed: "100000000000000001", sara: "100000000000000002", omar: "100000000000000003", lina: "100000000000000004" };
const PEOPLE = [[ID.ahmed, "Ahmed", ["Instructor"]], [ID.sara, "Sara", ["Moderator"]], [ID.omar, "Omar", ["Instructor", "VIP"]], [ID.lina, "Lina"]];
const W = { extraRoles: [["Instructor", 5], ["Moderator", 5]], people: PEOPLE };
const WV = { extraRoles: [["Instructor", 5], ["Moderator", 5], ["VIP", 5]], people: PEOPLE };

/* small helpers used by state checks */
const everyone = w => w.guild.roles.everyone;
const roleNamed = (w, n) => w.guild.roles.cache.find(r => r.name === n);
const hidden = (w, c, name) => !c.ch(name)?.permissionsFor(everyone(w)).has(P.ViewChannel);
const canSee = (w, c, name, role) => !!c.ch(name)?.permissionsFor(roleNamed(w, role))?.has(P.ViewChannel);
const parentOf = (c, name) => c.ch(name)?.parentId ?? null;
const sendMut = n => `message_send:${n}`;

/* the usual openings */
const WR = "write an announcement about the live stream";
const WRS = [WR, "send it here"];
const SA = w => { w.mkChannel({ name: "announcements" }); };
const SS = w => { w.mkChannel({ name: "staff" }); };
const SAS = w => { w.mkChannel({ name: "announcements" }); w.mkChannel({ name: "staff" }); };
const FILL = ["how many members do we have", "who is online", "server info", "show me the roles"];

export const scenarios = [];
const seq = {};
const add = (cat, diff, say, e = {}) => { seq[cat] = (seq[cat] ?? 0) + 1; scenarios.push({ id: `${cat}-${String(seq[cat]).padStart(2, "0")}`, cat, diff, say, world: W, ...e }); };
const LIST4 = ["Ahmed", "Lina", "Omar", "Sara"];

/* ═════════════ 1. member / role / server queries ═════════════ */
add("members", 1, "Show me everyone here", { intent: "members.list", said: LIST4 });
add("members", 1, "Who has the instructor role?", { intent: "members.byRole", args: { role: /instructor/i }, said: ["Ahmed", "Omar"], notSaid: ["Sara", "Lina"] });
add("members", 1, "list members", { intent: "members.list", said: LIST4 });
add("members", 4, "yo show me all the ppl in this server", { intent: "members.list", said: LIST4 });
add("members", 2, "who's in the server", { intent: "members.list", said: LIST4 });
add("members", 1, "members pls", { intent: "members.list", said: LIST4 });
add("members", 2, "can u show me the member list", { intent: "members.list", said: LIST4 });
add("members", 3, "i wanna see everybody in this discord", { intent: "members.list", said: LIST4 });
add("members", 3, "show me only the bots", { intent: "members.list", args: { kind: "bots" }, said: ["YSER Lab"], notSaid: ["Ahmed"] });
add("members", 2, "show humans only", { intent: "members.list", args: { kind: "humans" }, said: LIST4, notSaid: ["YSER Lab"] });
add("members", 3, "who are the newest members", { intent: "members.list", args: { sort: "newest" } });
add("members", 2, "find member Sara", { intent: "members.search", args: { query: /sara/i }, said: ["Sara"], notSaid: ["Ahmed"] });
add("members", 4, "is Omar in the server?", { intent: "members.search", args: { query: /omar/i }, said: ["Omar"], notSaid: ["Ahmed"] });
add("members", 3, "who is Lina", { intent: "members.search", args: { query: /lina/i }, said: ["Lina"], notSaid: ["Ahmed"] });
add("members", 1, "how many members do we have", { intent: "members.count", said: ["members"], notSaid: ["Ahmed"] });
add("members", 1, "member count", { intent: "members.count", notSaid: ["Ahmed"] });
add("members", 3, "how many ppl are here", { intent: "members.count", notSaid: ["Ahmed"] });
add("members", 2, "number of people in the server", { intent: "members.count", notSaid: ["Ahmed"] });
add("members", 4, "how big is our community", { intent: "members.count", notSaid: ["Ahmed"] });
add("members", 2, "how many of us are there", { intent: "members.count", notSaid: ["Ahmed"] });
add("members", 1, "who is online", { intent: "members.online" });
add("members", 2, "whos online rn", { intent: "members.online" });
add("members", 3, "anyone online?", { intent: "members.online" });
add("members", 2, "online members", { intent: "members.online" });
add("members", 3, "how many are online", { intent: "members.online" });
add("members", 1, "server info", { intent: "server.overview", said: ["Test Server"], notSaid: ["Ahmed"] });
add("members", 1, "tell me about this server", { intent: "server.overview", said: ["Test Server"] });
add("members", 2, "who owns this server", { intent: "server.overview" });
add("members", 2, "what's the boost level", { intent: "server.overview" });
add("members", 2, "server stats pls", { intent: "server.overview" });
add("members", 2, "show me the moderators", { intent: "members.byRole", args: { role: /moderator/i }, said: ["Sara"], notSaid: ["Ahmed", "Lina"] });
add("members", 2, "who are the mods", { intent: "members.byRole", args: { role: /mod/i }, said: ["Sara"], notSaid: ["Ahmed"] });
add("members", 2, "people with the VIP role", { world: WV, intent: "members.byRole", args: { role: /vip/i }, said: ["Omar"], notSaid: ["Ahmed", "Sara"] });
add("members", 2, "Show everyone with the wizard role", { intent: "members.byRole", args: { role: /wizard/i }, said: ["couldn't find a role"], notSaid: ["Ahmed"] });
add("members", 2, "list instructors", { intent: "members.byRole", args: { role: /instructor/i }, said: ["Ahmed", "Omar"], notSaid: ["Sara"] });
add("members", 3, "which members have the moderator role?", { intent: "members.byRole", args: { role: /moderator/i }, said: ["Sara"], notSaid: ["Ahmed"] });
add("members", 1, "show roles", { intent: "roles.list", said: ["Instructor", "Moderator"] });
add("members", 2, "what roles do we have", { intent: "roles.list", said: ["Instructor"] });
add("members", 1, "list channels", { intent: "channels.list", said: ["Channels"] });
add("members", 3, "make me an invite link", { intent: "invite.create", tool: "invite_create" });
add("members", 3, "give me the list of everyone in the server with the instructor role", { intent: "members.byRole", args: { role: /instructor/i }, said: ["Ahmed", "Omar"], notSaid: ["Sara"] });
add("members", 2, "SHOW ME THE MEMBERS!!!", { intent: "members.list", said: LIST4 });
add("members", 3, "the instructors?", { intent: "members.byRole", args: { role: /instructor/i }, said: ["Ahmed", "Omar"], notSaid: ["Sara"] });

/* ═════════════ 2. drafts and follow-ups ═════════════ */
add("drafts", 1, "Write an announcement about tomorrow's live stream.", { intent: "draft.write", args: { topic: /live stream/i }, said: ["version 1"] });
add("drafts", 1, "draft a post about the new course", { intent: "draft.write", args: { topic: /new course/i }, said: ["version 1"] });
add("drafts", 2, "can you write me a short announcement about the webinar", { intent: "draft.write", args: { topic: /webinar/i }, said: ["version 1"] });
add("drafts", 4, "pls write sth announcing the webinar on friday", { intent: "draft.write", args: { topic: /webinar/i }, said: ["version 1"] });
add("drafts", 2, "compose a notice about maintenance tonight", { intent: "draft.write", args: { topic: /maintenance/i }, said: ["version 1"] });
add("drafts", 2, "Make an announcement for tomorrow.", { intent: "draft.write", clarify: true, said: ["what is the announcement about"] });
add("drafts", 3, "write another one about the webinar", { prev: [WR], intent: "draft.write", args: { topic: /webinar/i }, said: ["version 1"] });
add("drafts", 2, "make a short announcement about friday's q&a", { intent: "draft.write", args: { topic: /q&a/i }, said: ["version 1"] });
add("drafts", 1, "Make it shorter", { prev: [WR], intent: "draft.revise", said: ["version 2"], notSaid: ["Everyone is welcome"] });
add("drafts", 1, "shorten it", { prev: [WR], intent: "draft.revise", said: ["version 2"], notSaid: ["Everyone is welcome"] });
add("drafts", 1, "make it more professional", { prev: [WR], intent: "draft.revise", said: ["version 2", "We are pleased to announce"] });
add("drafts", 2, "add that it's free", { prev: [WR], intent: "draft.revise", said: ["version 2", "It's free"] });
add("drafts", 3, "trim it down a bit pls", { prev: [WR], intent: "draft.revise", said: ["version 2"], notSaid: ["Everyone is welcome"] });
add("drafts", 2, "make it sound friendlier", { prev: [WR], intent: "draft.revise", said: ["version 2"] });
add("drafts", 2, "tighten it up", { prev: [WR], intent: "draft.revise", said: ["version 2"] });
add("drafts", 3, "can you make it shorter", { prev: [WR], intent: "draft.revise", said: ["version 2"], notSaid: ["Everyone is welcome"] });
add("drafts", 2, "translate it to arabic", { prev: [WR], intent: "draft.revise", said: ["version 2"] });
add("drafts", 1, "Perfect", { prev: [WR], intent: "draft.approve", said: ["approved"], state: (w, c) => c.draft()?.status === "approved" });
add("drafts", 2, "looks great", { prev: [WR], intent: "draft.approve", said: ["approved"], state: (w, c) => c.draft()?.status === "approved" });
add("drafts", 3, "yes that's the one", { prev: [WR], intent: "draft.approve", said: ["approved"], state: (w, c) => c.draft()?.status === "approved" });
add("drafts", 1, "Send it here", { prev: [WR], intent: "draft.send", mut: [sendMut("general")], state: w => /live stream/.test(w.sentTexts.at(-1) ?? "") });
add("drafts", 1, "send it", { prev: [WR], intent: "draft.send", mut: [sendMut("general")] });
add("drafts", 2, "post it here pls", { prev: [WR], intent: "draft.send", mut: [sendMut("general")] });
add("drafts", 3, "ok send", { prev: [WR], intent: "draft.send", mut: [sendMut("general")] });
add("drafts", 2, "go ahead and publish it", { prev: [WR], intent: "draft.send", mut: [sendMut("general")] });
add("drafts", 2, "send it here", { prev: [WR, "make it shorter"], intent: "draft.send", mut: [sendMut("general")], state: w => !/Bring your questions/.test(w.sentTexts.at(-1) ?? "") && /live stream/.test(w.sentTexts.at(-1) ?? "") });
add("drafts", 2, "send it in announcements", { prev: [WR], setup: SA, intent: "draft.send", args: { channel: /announcements/i }, mut: [sendMut("announcements")] });
add("drafts", 2, "post it to #announcements", { prev: [WR], setup: SA, intent: "draft.send", args: { channel: /announcements/i }, mut: [sendMut("announcements")] });
add("drafts", 2, "send it to the staff channel", { prev: [WR], setup: SS, intent: "draft.send", args: { channel: /staff/i }, mut: [sendMut("staff")] });
add("drafts", 2, "drop it in staff", { prev: [WR], setup: SS, intent: "draft.send", args: { channel: /staff/i }, mut: [sendMut("staff")] });
add("drafts", 3, "send it in annoucements", { prev: [WR], setup: SA, intent: "draft.send", args: { channel: /announcements/i }, mut: [sendMut("announcements")] });
add("drafts", 3, "send in announcements", { prev: [WR], setup: SA, intent: "draft.send", args: { channel: /announcements/i }, mut: [sendMut("announcements")] });
add("drafts", 2, "Pin it too", { prev: WRS, intent: "message.pin", mut: [/^pin:/], state: (w, c) => c.msgs("general").every(m => m.pinned) && c.msgs("general").length === 1 });
add("drafts", 1, "pin it", { prev: WRS, intent: "message.pin", mut: [/^pin:/], state: (w, c) => c.msgs("general").some(m => m.pinned) });
add("drafts", 2, "also pin that", { prev: WRS, intent: "message.pin", mut: [/^pin:/], state: (w, c) => c.msgs("general").some(m => m.pinned) });
add("drafts", 3, "pin the message you sent", { prev: WRS, intent: "message.pin", mut: [/^pin:/], state: (w, c) => c.msgs("general").some(m => m.pinned) });
add("drafts", 2, "delete that", { prev: WRS, intent: "message.delete", confirm: true, mut: [/^message_delete:/], state: (w, c) => c.msgs("general").length === 0 });
add("drafts", 2, "get rid of it", { prev: WRS, intent: "message.delete", confirm: true, mut: [/^message_delete:/], state: (w, c) => c.msgs("general").length === 0 });
add("drafts", 3, "Delete the previous one", { prev: [WR, "send it here", { say: "send it in staff" }], setup: SS, intent: "message.delete", confirm: true, mut: [/^message_delete:/], state: (w, c) => c.msgs("general").length === 0 && c.msgs("staff").length === 1, ref: true });
add("drafts", 4, "remove the one in staff", { prev: [WR, "send it here", "send it in staff"], setup: SS, intent: "message.delete", confirm: true, mut: [/^message_delete:/], state: (w, c) => c.msgs("staff").length === 0 && c.msgs("general").length === 1, ref: true });
add("drafts", 3, "edit the one you sent", { prev: [WR, "send it here", "add that it's free"], intent: "message.edit", mut: [/^message_edit:/], state: (w, c) => /It's free/i.test(JSON.stringify(c.msgs("general")[0]?.content ?? c.msgs("general")[0]?.components ?? "")) });
add("drafts", 3, "update the message you sent with the new version", { prev: [WR, "send it here", "add that it's free"], intent: "message.edit", mut: [/^message_edit:/], state: (w, c) => /It's free/i.test(JSON.stringify(c.msgs("general")[0]?.content ?? c.msgs("general")[0]?.components ?? "")) });
add("drafts", 3, "send it here", { prev: [WR, "send it here", "make it shorter"], intent: "draft.send", clarify: true, said: ["edit", "new"] });
add("drafts", 3, "edit it", { prev: [WR, "send it here", "make it shorter", "send it here"], intent: "draft.send", tool: "message_update", mut: [/^message_edit:/], said: ["Edited"] });
add("drafts", 3, "new", { prev: [WR, "send it here", "make it shorter", "send it here"], intent: "draft.send", tool: "message_send", mut: [sendMut("general")] });
add("drafts", 2, "send it here", { prev: WRS, intent: "draft.send", tool: null, mut: [], said: ["already posted"] });
add("drafts", 2, "send it", { llm: true });
add("drafts", 2, "send it to another channel", { prev: [WR], intent: "draft.send", clarify: true, said: ["which channel"] });
add("drafts", 3, "show me the draft", { prev: [WR, "make it shorter"], intent: "draft.show", said: ["live stream", "version 2"] });

/* ═════════════ 3. creation and continuity ═════════════ */
const PRIVCAT = "create a private category";
add("creation", 2, PRIVCAT, { intent: "category.create", clarify: true, said: ["name"] });
add("creation", 2, "Academy", { prev: [PRIVCAT], intent: "category.create", args: { name: "Academy", private: true }, mut: ["channel_create:category:Academy"], mutAllow: [/^overwrite:/], state: (w, c) => c.ch("Academy") && hidden(w, c, "Academy"), said: ["Created category"] });
add("creation", 3, "Add two channels", { prev: [PRIVCAT, "Academy"], intent: "channel.create", clarify: true, said: ["called"], notSaid: ["which category"] });
add("creation", 3, "lessons and resources", { prev: [PRIVCAT, "Academy", "Add two channels"], intent: "channel.create", args: { names: ["lessons", "resources"] }, mut: ["channel_create:lessons", "channel_create:resources"], mutAllow: [/^overwrite:/], state: (w, c) => parentOf(c, "lessons") === c.ch("Academy").id && parentOf(c, "resources") === c.ch("Academy").id, ref: true });
add("creation", 3, "One for announcements and one for discussion.", { prev: [PRIVCAT, "Academy", "Add two channels"], intent: "channel.create", args: { names: ["announcements", "discussion"] }, mut: ["channel_create:announcements", "channel_create:discussion"], mutAllow: [/^overwrite:/], state: (w, c) => parentOf(c, "announcements") === c.ch("Academy").id && parentOf(c, "discussion") === c.ch("Academy").id, ref: true });
add("creation", 3, "general-chat & qna", { prev: [PRIVCAT, "Academy", "Add two channels"], intent: "channel.create", args: { names: ["general-chat", "qna"] }, mut: ["channel_create:general-chat", "channel_create:qna"], mutAllow: [/^overwrite:/], state: (w, c) => parentOf(c, "qna") === c.ch("Academy").id, ref: true });
add("creation", 2, "Add a channel called lessons", { prev: ["create a category called Academy"], intent: "channel.create", mut: ["channel_create:lessons"], state: (w, c) => parentOf(c, "lessons") === c.ch("Academy").id, ref: true });
add("creation", 3, "add a voice channel called lounge", { prev: ["create a category called Academy"], intent: "channel.create", args: { kind: "voice" }, mut: ["channel_create:lounge"], state: (w, c) => parentOf(c, "lounge") === c.ch("Academy").id, ref: true });
add("creation", 3, "create a channel called lessons in it", { prev: ["create a category called Academy"], intent: "channel.create", mut: ["channel_create:lessons"], state: (w, c) => parentOf(c, "lessons") === c.ch("Academy").id, ref: true });
add("creation", 1, "create a category called Academy", { intent: "category.create", args: { name: "Academy" }, mut: ["channel_create:category:Academy"], said: ["Created category"] });
add("creation", 2, "make a new category named Trading Lab", { intent: "category.create", args: { name: "Trading Lab" }, mut: ["channel_create:category:Trading Lab"] });
add("creation", 1, "Create a channel called announcements", { intent: "channel.create", args: { name: "announcements" }, mut: ["channel_create:announcements"] });
add("creation", 1, "make a voice channel called lounge", { intent: "channel.create", args: { kind: "voice", name: "lounge" }, mut: ["channel_create:lounge"] });
add("creation", 2, "new text channel named trading-ideas", { intent: "channel.create", args: { name: "trading-ideas" }, mut: ["channel_create:trading-ideas"] });
add("creation", 2, "create a private staff channel", { intent: "channel.create", args: { name: "staff", private: true }, mut: ["channel_create:staff"], mutAllow: [/^overwrite:/], state: (w, c) => hidden(w, c, "staff") });
add("creation", 2, "Create a channel called general", { intent: "channel.create", clarify: true, mut: [], said: ["already exists"] });
add("creation", 2, "no", { prev: ["Create a channel called general"], mut: [], tool: null });
add("creation", 3, "yes", { prev: ["Create a channel called general"], intent: "channel.create", mut: ["channel_create:general"] });
add("creation", 1, "Create a VIP role", { intent: "role.create", args: { name: "VIP" }, mut: ["role_create:VIP"] });
add("creation", 1, "make a role called Mentor", { intent: "role.create", args: { name: "Mentor" }, mut: ["role_create:Mentor"] });
add("creation", 3, "create role Student", { intent: "role.create", args: { name: "Student" }, mut: ["role_create:Student"] });
add("creation", 2, "Create a VIP role", { world: WV, intent: "role.create", tool: null, mut: [], said: ["already"] });
add("creation", 2, "Make it private", { prev: ["Create a channel called announcements"], intent: "channel.access", mutAllow: [/^overwrite:/], state: (w, c) => hidden(w, c, "announcements"), said: ["private"], ref: true });
add("creation", 3, "give access to instructors", { prev: ["create a private staff channel"], intent: "channel.access", args: { roles: /instructor/i }, mutAllow: [/^overwrite:/], state: (w, c) => canSee(w, c, "staff", "Instructor") && hidden(w, c, "staff"), ref: true });
add("creation", 3, "make that channel read only", { prev: ["Create a channel called announcements"], intent: "channel.access", args: { access: "read_only" }, mutAllow: [/^overwrite:/], state: (w, c) => !c.ch("announcements").permissionsFor(everyone(w)).has(P.SendMessages), ref: true });
add("creation", 3, "Create a private announcements channel and give access to instructors", { intent: "compound.setup", mut: ["channel_create:announcements"], mutAllow: [/^overwrite:/], state: (w, c) => hidden(w, c, "announcements") && canSee(w, c, "announcements", "Instructor") });
add("creation", 2, "create 3 channels", { intent: "channel.create", clarify: true, said: ["called"] });
add("creation", 2, "add a channel called lessons in the Academy category", { setup: w => w.guild.channels.create({ name: "Academy", type: 4 }), intent: "channel.create", args: { name: "lessons" }, mut: ["channel_create:lessons"], state: (w, c) => parentOf(c, "lessons") === c.ch("Academy").id });
add("creation", 3, "create a channel called lessons in the Academy category", { intent: "channel.create", clarify: false, mut: [], said: ["couldn't find|doesn't exist|not found"] });
add("creation", 3, "set up a private channel for staff", { intent: "channel.create", args: { name: "staff", private: true }, mut: ["channel_create:staff"], mutAllow: [/^overwrite:/], state: (w, c) => hidden(w, c, "staff") });
add("creation", 3, "add 2 channels to it", { prev: ["create a category called Academy"], intent: "channel.create", clarify: true, said: ["called"], notSaid: ["which category"], ref: true });

/* ═════════════ 4. reference resolution ═════════════ */
const MEMBERS = ["Create a Mentor role", "show me the members"];
const gets = (n, role = "Mentor") => (w, c) => [`role_add:${role}->${c.shown(n)}`];
add("refs", 2, "Give it to the second member from the list", { prev: MEMBERS, intent: "role.assign", confirm: true, mut: gets(2), ref: true, args: { ordinal: 1 } });
add("refs", 2, "give it to the third one", { prev: MEMBERS, intent: "role.assign", confirm: true, mut: gets(3), ref: true });
add("refs", 3, "give Mentor to number 3", { prev: MEMBERS, intent: "role.assign", confirm: true, mut: gets(3), ref: true });
add("refs", 2, "assign it to the last one", { prev: MEMBERS, intent: "role.assign", confirm: true, mut: (w, c) => [`role_add:Mentor->${c.shown("last")}`], ref: true });
add("refs", 2, "give that role to the first person", { prev: MEMBERS, intent: "role.assign", confirm: true, mut: gets(1), ref: true });
add("refs", 2, "give the Mentor role to the 2nd guy", { prev: MEMBERS, intent: "role.assign", confirm: true, mut: gets(2), ref: true });
add("refs", 3, "assign Mentor role to the fifth person", { prev: MEMBERS, intent: "role.assign", confirm: true, mut: gets(5), ref: true });
add("refs", 3, `give it to <@${ID.sara}>`, { prev: ["Create a Mentor role"], intent: "role.assign", confirm: false, mut: [`role_add:Mentor->${ID.sara}`], ref: true });
add("refs", 3, `give <@${ID.lina}> the Mentor role`, { prev: ["Create a Mentor role"], intent: "role.assign", confirm: false, mut: [`role_add:Mentor->${ID.lina}`], ref: true });
add("refs", 4, "give it to her", { prev: ["Create a Mentor role", "find Sara"], intent: "role.assign", confirm: true, mut: [`role_add:Mentor->${ID.sara}`], ref: true });
add("refs", 2, "Remove the role from the second person", { prev: ["who has the instructor role"], intent: "role.remove", confirm: true, mut: [`role_remove:Instructor->${ID.omar}`], ref: true });
add("refs", 4, "take it off the first one", { prev: ["who has the instructor role"], intent: "role.remove", confirm: true, mut: [`role_remove:Instructor->${ID.ahmed}`], ref: true });
add("refs", 3, "actually change the second one", { prev: ["create a category called Academy", "add channels called lessons and quizzes"], intent: ["channel.rename", "channel.edit"], clarify: true, ref: true });
add("refs", 4, "rename the second one to q-and-a", { prev: ["create a category called Academy", "add channels called lessons and quizzes"], intent: "channel.rename", tool: "rename_channel", args: { name: "q-and-a" }, mut: null, ref: true });
add("refs", 3, "use the previous one", { prev: [WR, "make it shorter"], intent: "draft.restore", tool: null, state: (w, c) => c.draft()?.text === c.draft()?.versions[0], ref: true });
add("refs", 3, "go back to the first version", { prev: [WR, "make it more professional"], intent: "draft.restore", tool: null, state: (w, c) => c.draft()?.text === c.draft()?.versions[0], ref: true });
add("refs", 4, "use the version I approved", { prev: [WR, "perfect", "make it shorter"], intent: "draft.restore", tool: null, state: (w, c) => c.draft()?.text === c.draft()?.versions[0], ref: true });
add("refs", 4, "send it here", { prev: [WR, "perfect", "make it shorter", "use the version I approved"], intent: "draft.send", mut: [sendMut("general")], state: w => /Bring your questions/.test(w.sentTexts.at(-1) ?? ""), ref: true });
add("refs", 4, "put those there", { prev: ["create a channel called lessons", "create a channel called quizzes", "create a category called Academy"], intent: "channel.move", tool: "move_channel", args: { category: /academy/i }, mut: null, state: (w, c) => parentOf(c, "lessons") === c.ch("Academy").id && parentOf(c, "quizzes") === c.ch("Academy").id, ref: true });
add("refs", 3, "do the same thing again", { prev: ["how many members do we have"], intent: "repeat", tool: "member_count", said: ["members"], ref: true });
add("refs", 2, "again", { prev: ["show me the members"], intent: "repeat", tool: "member_list", said: LIST4, ref: true });
add("refs", 3, "do the same thing again", { prev: ["create a role called Mentor"], intent: "repeat", clarify: true, mut: [], ref: true });
add("refs", 4, "continue where we stopped", { prev: [PRIVCAT, "how many members do we have"], intent: "category.create", clarify: true, said: ["name"], ref: true });
add("refs", 4, "continue where we stopped", { prev: [WR, "make it shorter", "show me the members"], intent: "context.resume", state: (w, c) => /version 2/.test(c.lastReply), said: ["version 2"], ref: true });
add("refs", 4, "put a channel called lessons in there", { prev: ["create a category called Academy"], intent: "channel.create", mut: ["channel_create:lessons"], state: (w, c) => parentOf(c, "lessons") === c.ch("Academy").id, ref: true });
add("refs", 3, "make that one read only", { prev: ["Create a channel called announcements"], intent: "channel.access", args: { access: "read_only" }, mutAllow: [/^overwrite:/], state: (w, c) => !c.ch("announcements").permissionsFor(everyone(w)).has(P.SendMessages), ref: true });
add("refs", 3, "hide it from everyone", { prev: ["Create a channel called staff"], intent: "channel.access", mutAllow: [/^overwrite:/], state: (w, c) => hidden(w, c, "staff"), ref: true });
add("refs", 2, "pin it", { prev: [WR, "send it in announcements"], setup: SA, intent: "message.pin", mut: [/^pin:/], state: (w, c) => c.msgs("announcements").every(m => m.pinned) && c.msgs("announcements").length === 1, ref: true });
add("refs", 3, "send the same thing in staff", { prev: WRS, setup: SS, intent: "draft.send", mut: [sendMut("staff")], ref: true });
add("refs", 4, "send it to the same channel as before", { prev: [WR, "send it in announcements", "make it shorter"], setup: SA, intent: "draft.send", clarify: true, ref: true });
add("refs", 3, "give it to the third one too", { prev: ["Create a Mentor role", "show me the members", "give it to the second one"], intent: "role.assign", confirm: true, mut: gets(3), ref: true });

/* ═════════════ 5. corrections ═════════════ */
add("corrections", 2, "No, I mean the actual people in the server", { prev: ["Show me the server information"], intent: "members.list", said: ["Ahmed", "Understood"] });
add("corrections", 3, "no i meant who is online", { prev: ["Show me the server information"], intent: "members.online" });
add("corrections", 3, "no list them", { prev: ["how many members do we have"], intent: "members.list", said: LIST4 });
add("corrections", 3, "that's wrong, I meant the roles", { prev: ["list the channels"], intent: "roles.list", said: ["Instructor"] });
add("corrections", 4, "no, i meant instructors not moderators", { prev: ["who has the moderator role"], intent: "members.byRole", args: { role: /instructor/i }, said: ["Ahmed", "Omar"], notSaid: ["Sara"] });
add("corrections", 2, "no, make it private", { prev: ["Create a channel called announcements"], intent: "channel.access", mutAllow: [/^overwrite:/], state: (w, c) => hidden(w, c, "announcements") });
add("corrections", 2, "I said announcements, not general", { prev: WRS, setup: SA, intent: "correction.channel", tool: "message_send", mut: [sendMut("announcements")], state: (w, c) => c.msgs("announcements").length === 1, said: ["should have gone to"], ref: true });
add("corrections", 3, "wrong channel, send it in announcements", { prev: WRS, setup: SA, intent: ["correction.channel", "draft.send"], tool: "message_send", mut: [sendMut("announcements")], state: (w, c) => c.msgs("announcements").length === 1, ref: true });
add("corrections", 4, "not here, in staff", { prev: WRS, setup: SS, intent: ["correction.channel", "draft.send"], tool: "message_send", mut: [sendMut("staff")], state: (w, c) => c.msgs("staff").length === 1, ref: true });
add("corrections", 4, "sorry I meant announcements", { prev: [WR, "send it in staff"], setup: SAS, intent: ["correction.channel", "draft.send"], tool: "message_send", mut: [sendMut("announcements")], state: (w, c) => c.msgs("announcements").length === 1, ref: true });
add("corrections", 2, "nope the members", { prev: ["Show me the server information"], intent: "members.list", said: LIST4 });
add("corrections", 4, "no i meant how many", { prev: ["who is online"], intent: "members.count", notSaid: ["Ahmed"] });
add("corrections", 2, "no, longer", { prev: [WR, "make it shorter"], intent: "draft.revise", said: ["version 3"] });
add("corrections", 2, "no the instructors", { prev: ["Show me the moderators"], intent: "members.byRole", args: { role: /instructor/i }, said: ["Ahmed"], notSaid: ["Sara"] });
add("corrections", 3, "no I meant channels", { prev: ["list the roles"], intent: "channels.list", said: ["general"] });

/* ═════════════ 6. multi-instruction messages ═════════════ */
add("multi", 4, `create a role called Mentor and give it to <@${ID.ahmed}>`, { intent: "role.create", mut: ["role_create:Mentor", `role_add:Mentor->${ID.ahmed}`], confirm: false });
add("multi", 4, "create a VIP category with announcements and chat channels", { intent: "compound.setup", mut: ["channel_create:category:VIP", "channel_create:announcements", "channel_create:chat"] });
add("multi", 4, "create a private staff channel and a public lounge channel", { intent: "compound.setup", mut: ["channel_create:staff", "channel_create:lounge"], mutAllow: [/^overwrite:/], state: (w, c) => hidden(w, c, "staff") && !hidden(w, c, "lounge") });
add("multi", 3, "write an announcement about the stream and send it here", { intent: "draft.write", tool: "message_send", mut: [sendMut("general")], state: w => /stream/.test(w.sentTexts.at(-1) ?? "") });
add("multi", 3, "show me the members and the server info", { intent: ["members.list", "server.overview"], tool: "server_overview", said: ["Ahmed", "Test Server"] });
add("multi", 3, "send it here and pin it", { prev: [WR], intent: "draft.send", mut: [sendMut("general"), /^pin:/], state: (w, c) => c.msgs("general").some(m => m.pinned) });
add("multi", 3, "send it in announcements and staff", { prev: [WR], setup: SAS, intent: "draft.send", mut: [sendMut("announcements"), sendMut("staff")] });
add("multi", 3, "make it private and give access to instructors", { prev: ["Create a channel called announcements"], intent: "channel.access", args: { roles: /instructor/i }, mutAllow: [/^overwrite:/], state: (w, c) => hidden(w, c, "announcements") && canSee(w, c, "announcements", "Instructor"), ref: true });
add("multi", 4, "make it shorter and send it here", { prev: [WR], intent: "draft.revise", mut: [sendMut("general")], state: w => !/Bring your questions/.test(w.sentTexts.at(-1) ?? "") });
add("multi", 4, "delete that and send it again in staff", { prev: WRS, setup: SS, intent: "message.delete", confirm: true, mut: [/^message_delete:/, sendMut("staff")] });
add("multi", 3, "create a role called Student and a role called Alumni", { intent: "role.create", mut: ["role_create:Student", "role_create:Alumni"] });
add("multi", 3, "create channels called lessons and quizzes", { intent: "channel.create", args: { names: ["lessons", "quizzes"] }, mut: ["channel_create:lessons", "channel_create:quizzes"] });
add("multi", 3, "list roles and channels", { intent: "roles.list", tool: "channel_list", said: ["Instructor", "Channels"] });
add("multi", 4, "how many members and who is online", { intent: "members.count", tool: "member_online" });
add("multi", 3, "make a voice channel called lounge and a text channel called chat", { intent: "channel.create", mut: ["channel_create:lounge", "channel_create:chat"] });

/* ═════════════ 7. missing parameters / clarification ═════════════ */
add("missing", 1, "create a channel", { intent: "channel.create", clarify: true, said: ["called"] });
add("missing", 1, "create a role", { intent: "role.create", clarify: true, said: ["called"] });
add("missing", 1, "create a category", { intent: "category.create", clarify: true, said: ["name"] });
add("missing", 1, "make an announcement", { intent: "draft.write", clarify: true, said: ["what is the announcement about"] });
add("missing", 1, "write an announcement", { intent: "draft.write", clarify: true, said: ["what is the announcement about"] });
add("missing", 3, "give the VIP role", { world: WV, intent: "role.assign", clarify: true });
add("missing", 2, "give it to him", { intent: "role.assign", clarify: true, mut: [] });
add("missing", 3, "remove the role from him", { intent: "role.remove", clarify: true, mut: [] });
add("missing", 2, "make it private", { intent: "channel.access", clarify: true, said: ["which channel"], mut: [] });
add("missing", 2, "pin it", { llm: true });
add("missing", 2, "delete that", { llm: true });
add("missing", 4, "send it to", { prev: [WR], intent: "draft.send", clarify: true, mut: [] });
add("missing", 2, "add two channels", { intent: "channel.create", clarify: true, said: ["called"] });
add("missing", 2, "give access to instructors", { intent: "channel.access", clarify: true, mut: [] });
add("missing", 3, "create a channel called", { intent: "channel.create", clarify: true });
add("missing", 3, "rename the channel", { intent: "channel.rename", clarify: true, mut: [] });
add("missing", 3, "delete the channel", { intent: "channel.delete", clarify: true, mut: [] });
add("missing", 3, "send it to staff", { prev: [WR], intent: "draft.send", tool: null, mut: [], said: ["couldn't find"] });

/* ═════════════ 8. long conversations with topic switches ═════════════ */
add("long", 3, "send it here", { prev: [WR, "make it shorter", "show me the members", "server info", "who is online", "how many members do we have", "show me the roles"], intent: "draft.send", mut: [sendMut("general")], state: w => !/Bring your questions/.test(w.sentTexts.at(-1) ?? ""), ref: true });
add("long", 4, "give it to the third one", { prev: ["create a Mentor role", "show me the members", "how many members do we have", "server info", "who is online", "list channels"], intent: "role.assign", confirm: true, mut: gets(3), ref: true });
add("long", 3, "add a channel called lessons", { prev: ["create a category called Academy", "show me the roles", "show me the members", "server info"], intent: "channel.create", mut: ["channel_create:lessons"], state: (w, c) => parentOf(c, "lessons") === c.ch("Academy").id, ref: true });
add("long", 4, "send it here", { prev: [WR, ...Array.from({ length: 7 }, () => FILL).flat()], intent: "draft.send", mut: [sendMut("general")], ref: true });
add("long", 4, "send it in staff", { prev: [WR, "perfect", "show me the members", "how many are online", "server info"], setup: SS, intent: "draft.send", mut: [sendMut("staff")], state: w => /live stream/.test(w.sentTexts.at(-1) ?? ""), ref: true });
add("long", 4, "make it private", { prev: ["create a channel called announcements", "show me the members", "who has the moderator role", "show me the roles"], intent: "channel.access", mutAllow: [/^overwrite:/], state: (w, c) => hidden(w, c, "announcements"), ref: true });
add("long", 4, "go back to the first version", { prev: [WR, "make it more professional", "show me the members", "who is online"], intent: "draft.restore", tool: null, state: (w, c) => c.draft()?.text === c.draft()?.versions[0], ref: true });
add("long", 4, "remove the role from the second person", { prev: ["who has the instructor role", "how many members do we have", "server info", "list channels"], intent: "role.remove", confirm: true, mut: [`role_remove:Instructor->${ID.omar}`], ref: true });
add("long", 4, "pin that too", { prev: [...WRS, "show me the members", "server info", "create a role called Mentor"], intent: "message.pin", mut: [/^pin:/], state: (w, c) => c.msgs("general").some(m => m.pinned), ref: true });
add("long", 4, "send that one here", { prev: [WR, "make it shorter", "thanks", "what is a fair value gap", "ok cool", "show me the members"], intent: "draft.send", mut: [sendMut("general")], state: w => !/Bring your questions/.test(w.sentTexts.at(-1) ?? ""), ref: true });

/* ═════════════ 9. preferences / memory ═════════════ */
const PREF = "Remember that I prefer short announcements";
add("memory", 1, PREF, { intent: "memory.remember", said: ["Saved"], state: (w, c) => c.prefs().length === 1 });
add("memory", 3, "Write an announcement about the stream", { prev: [PREF, { reset: true, say: "hi" }], intent: "draft.write", notSaid: ["Bring your questions"], said: ["the stream!"] });
add("memory", 1, "what do you remember about me", { prev: [PREF], intent: "memory.show", said: ["short announcements"] });
add("memory", 1, "forget short announcements", { prev: [PREF], intent: "memory.forget", said: ["Forgotten"], state: (w, c) => c.prefs().length === 0 });
add("memory", 1, "remember that my api key is abcdefghijklmnopqrstuvwxyz1234567890ABCD", { intent: "memory.remember", said: ["didn't save"], state: (w, c) => c.prefs().length === 0 });
add("memory", 5, "write another announcement about the webinar, use the same format as last time", { prev: [WR, "make it shorter", "send it here"], intent: "draft.write", args: { topic: v => /webinar/i.test(v) && !/format|last time/i.test(v) }, state: (w, c) => !/Bring your questions/.test(c.draft()?.text ?? "") && c.draft()?.topic !== undefined, said: ["version 1"] });
add("memory", 3, "from now on keep announcements short", { intent: "memory.remember", state: (w, c) => c.prefs().length === 1 });
add("memory", 3, "always sign announcements with YSER Team", { intent: "memory.remember", state: (w, c) => c.prefs().length === 1 });
add("memory", 4, "what announcement style do I like", { prev: [PREF], intent: "memory.show", said: ["short announcements"] });
add("memory", 2, "forget my timezone", { prev: ["remember that my timezone is EST"], intent: "memory.forget", state: (w, c) => c.prefs().length === 0 });

/* ═════════════ 10. left to the language model ═════════════ */
for (const [d, s] of [[1, "hello"], [1, "good morning"], [1, "thanks bro"], [2, "what is a fair value gap"], [2, "explain SMT divergence like I'm 5"], [2, "should I buy gold now"], [1, "what's the capital of France"], [1, "tell me a joke"], [2, "how do I journal my trades better"], [2, "what does CISD stand for"], [2, "which timeframe is best for entries"], [1, "lol"], [5, "how many members does a typical trading community have"], [5, "write a post-mortem of my losing trade"], [5, "give me a post-trade checklist"], [1, "who won the world cup in 2022"], [1, "what's 15% of 240"], [2, "translate good luck to arabic"], [2, "is the dollar going up this week"], [4, "what's the best way to grow a discord server"], [2, "how is my win rate this month"], [3, "create a trading plan for me"], [3, "who is the best ICT teacher"]]) add("llm", d, s, { llm: true });
