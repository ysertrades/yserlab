// The repeatable evaluation dataset for the assistant's intelligence layer. Two parts:
//  1. intentCases: single messages (normal language, informal, misspelled, follow-ups, ambiguous, and things the assistant must NOT claim)
//     with the intent each must get.
//  2. dialogues: multi-turn conversations against the stand-in server. Each turn states what must be said, which intent and tool run, and
//     EXACTLY which changes may be made to the server; anything extra counts as an incorrect execution.
// Add a case here whenever a real mistake is found: that is how corrections improve the system (reviewed and committed, never auto-learned).
import { PermissionFlagsBits as P } from "discord.js";

const roles = ["Moderator", "Instructor", "VIP", "Academy"];
export const intentCases = [
  // the five requests from the brief that must trigger five different operations
  ["Members in this server.", "members.list"], ["Show me the server information.", "server.overview"], ["Who is online?", "members.online"],
  ["Show me everyone with the instructor role.", "members.byRole"], ["How many members do we have?", "members.count"],
  // member list, many ways
  ["Show me all members", "members.list"], ["List server members", "members.list"], ["Who is in this server?", "members.list"], ["Show me the members", "members.list"],
  ["Find everyone in the server", "members.list"], ["members", "members.list"], ["show members pls", "members.list"], ["gimme the member list", "members.list"],
  ["show me memebrs", "members.list"], ["list all the people in the sever", "members.list"], ["who's in this discord", "members.list"], ["list the humans in this server", "members.list"],
  // counts, online, overview
  ["how many people are in here", "members.count"], ["how many people are in the server", "members.count"], ["member count?", "members.count"], ["whos online", "members.online"], ["who is online right now?", "members.online"],
  ["server info", "server.overview"], ["tell me about this server", "server.overview"], ["server stats", "server.overview"], ["whats the server overview", "server.overview"],
  // roles
  ["Show me the moderators", "members.byRole", { roles }], ["who has the VIP role", "members.byRole"], ["show me the instructors", "members.byRole", { roles }], ["people with the moderator role", "members.byRole"],
  ["Which channels do everyone have view access", "channels.visibility"], ["which channels can everyone see", "channels.visibility"], ["which channels are private", "channels.visibility"], ["what can everyone see", "channels.visibility"], ["which channels can the VIP role see", "channels.visibility", { roles }], ["which channels are read only", "channels.visibility"], ["who can see this channel", "channel.info"], ["which channels are hidden from everyone", "channels.visibility"],
  ["Show me the roles", "roles.list"], ["list the channels", "channels.list"],
  // creation
  ["Create a VIP category", "category.create"], ["create a category called Academy", "category.create"], ["Create a channel called announcements", "channel.create"], ["make a voice channel called lounge", "channel.create"],
  ["Create a VIP role", "role.create"], ["add a channel called lessons", "channel.create"], ["Add two channels", "channel.create"], ["create a private staff channel", "channel.create"],
  ["Create a VIP category, add announcements and discussion channels, make them private, and give access to the VIP role.", "compound.setup"],
  ["Create a private announcements channel and give access to instructors", "compound.setup"],
  // drafts and follow-ups (with a draft in hand)
  ["Write an announcement about tomorrow's live trading stream.", "draft.write"], ["draft an annoucement about the webinar", "draft.write"], ["Make an announcement for tomorrow.", "draft.write"],
  ["Make it shorter", "draft.revise", { draft: true }], ["Make it more professional", "draft.revise", { draft: true }], ["add that everyone is welcome", "draft.revise", { draft: true }], ["shorten it", "draft.revise", { draft: true }],
  ["Perfect", "draft.approve", { draft: true }], ["Send it here", "draft.send", { draft: true }], ["send that", "draft.send", { draft: true }], ["post it in announcements", "draft.send", { draft: true }],
  ["Send it to the staff channel instead", "draft.send", { draft: true }], ["send it to another channel", "draft.send", { draft: true }],
  ["Pin it too", "message.pin"], ["pin that", "message.pin"], ["Delete the previous one", "message.delete"], ["delete that", "message.delete"], ["edit the one you just sent", "message.edit"],
  ["make it private", "channel.access"], ["make that channel private", "channel.access"], ["Give it to the second member from the list", "role.assign"], ["Remove the role from the second person", "role.remove"],
  ["do that again", "repeat"], ["make another one", "repeat"],
  // corrections
  ["No, I mean the actual people in the server", "members.list"], ["I mean people with the moderator role", "members.byRole"], ["I said announcements, not general", "correction.channel"],
  // memory
  ["Remember that I prefer short announcements", "memory.remember"], ["forget short announcements", "memory.forget"],
  // must be left to the language model, never claimed by a rule
  ["what is a fair value gap", "unknown"], ["thanks", "unknown"], ["how is my win rate this month", "unknown"], ["explain the fractal model", "unknown"], ["whats the weather", "unknown"],
  ["hello", "unknown"], ["can you help me with my journal", "unknown"], ["what does CISD mean", "unknown"],
];

const none = [];
const members = { primary: "members.list", tool: "member_list", mutations: none, notSaid: ["Boost level", "Verification"] };
export const dialogues = [
  { id: "members-vs-overview", turns: [
    { say: "Members in this server.", ...members, said: ["Ahmed", "Sara"] },
    { say: "Show me the server information.", primary: "server.overview", tool: "server_overview", mutations: none, said: ["Test Server"], notSaid: ["Ahmed"] },
    { say: "How many members do we have?", primary: "members.count", tool: "member_count", mutations: none, said: ["members"], notSaid: ["Ahmed"] },
    { say: "Who is online?", primary: "members.online", tool: "member_online", mutations: none },
  ] },
  { id: "members-limited", world: { memberListFails: true, memberCount: 50 }, turns: [
    { say: "show me the members", primary: "members.list", mutations: none, said: ["Server Members Intent"], notSaid: ["Zed"] },
  ] },
  { id: "announcement-flow", turns: [
    { say: "Write an announcement about tomorrow's live stream.", primary: "draft.write", mutations: none, said: ["version 1"] },
    { say: "Make it shorter", primary: "draft.revise", mutations: none, said: ["version 2"], retention: true },
    { say: "Send it here", primary: "draft.send", tool: "message_send", mutations: ["message_send:general"], said: ["Sent in"], retention: true, ref: true },
  ], maxSends: 1 },
  { id: "announcement-approve-pin", before: w => w.mkChannel({ name: "announcements" }), turns: [
    { say: "Write an announcement about the new course", primary: "draft.write", mutations: none },
    { say: "Make it more professional", primary: "draft.revise", mutations: none, retention: true },
    { say: "Perfect", primary: "draft.approve", mutations: none },
    { say: "Send it in announcements", primary: "draft.send", mutations: ["message_send:announcements"], retention: true, ref: true },
    { say: "Pin it too", primary: "message.pin", tool: "message_pin", mutations: [/^pin:\d+$/], retention: true, ref: true },
  ], maxSends: 1 },
  { id: "topic-clarification", turns: [
    { say: "Make an announcement for tomorrow.", primary: "draft.write", ask: true, said: ["What is the announcement about"] },
    { say: "Live trading stream.", primary: "draft.write", mutations: none, said: ["Draft"], retention: true },
    { say: "Add that everyone is welcome", primary: "draft.revise", mutations: none, said: ["Everyone is welcome"], retention: true },
  ] },
  { id: "no-duplicate-send", turns: [
    { say: "Write an announcement about the stream", primary: "draft.write", mutations: none },
    { say: "send it here", mutations: ["message_send:general"] },
    { say: "send it here", mutations: none, said: ["already posted"] },
  ], maxSends: 1 },
  { id: "category-then-channel", turns: [
    { say: "Create a category called Academy", primary: "category.create", tool: "channel_create", mutations: ["channel_create:category:Academy"] },
    { say: "Add a channel called lessons", primary: "channel.create", mutations: ["channel_create:lessons"], said: ["Academy"], retention: true, ref: true, check: (w) => [...w.guild.channels.cache.values()].find(c => c.name === "lessons")?.parent?.name === "Academy" },
  ] },
  { id: "category-two-channels", turns: [
    { say: "Create a VIP category", mutations: ["channel_create:category:VIP"] },
    { say: "Add two channels", primary: "channel.create", ask: true, mutations: none, notSaid: ["which category"] },
    { say: "One for announcements and one for discussion.", mutations: ["channel_create:announcements", "channel_create:discussion"], ref: true, check: w => [...w.guild.channels.cache.values()].filter(c => c.parent?.name === "VIP").length === 2 },
  ] },
  { id: "role-then-member", turns: [
    { say: "Create a VIP role", primary: "role.create", tool: "role_create", mutations: ["role_create:VIP"] },
    { say: "show me the members", primary: "members.list", mutations: none },
    { say: "Give it to the second member from the list", primary: "role.assign", mutations: [/^role_add:VIP->u\d$/], ref: true, retention: true },
  ] },
  { id: "remove-role-from-second", world: { extraRoles: [["Moderator", 5]], people: [["u1", "Ahmed", ["Moderator"]], ["u2", "Sara", ["Moderator"]], ["u3", "Omar"]] }, turns: [
    { say: "Find everyone with the moderator role", primary: "members.byRole", mutations: none, said: ["Ahmed", "Sara"], notSaid: ["Omar"] },
    { say: "Remove the role from the second person", primary: "role.remove", mutations: ["role_remove:Moderator->u2"], ref: true, retention: true },
  ] },
  { id: "private-after-create", turns: [
    { say: "Create a channel called announcements", primary: "channel.create", mutations: ["channel_create:announcements"] },
    { say: "Make it private", primary: "channel.access", mutations: [/^overwrite:/], said: ["private now"], retention: true, ref: true, check: w => ![...w.guild.channels.cache.values()].find(c => c.name === "announcements").permissionsFor(w.guild.roles.everyone).has(P.ViewChannel) },
  ] },
  { id: "correction-overview-to-members", turns: [
    { say: "Show me the server information", primary: "server.overview", mutations: none },
    { say: "No, I mean the actual people in the server", primary: "members.list", mutations: none, said: ["Ahmed"], corrected: true },
  ] },
  { id: "correction-wrong-channel", before: w => w.mkChannel({ name: "announcements" }), turns: [
    { say: "Write an announcement about the stream", mutations: none },
    { say: "send it here", mutations: ["message_send:general"] },
    { say: "I said announcements, not general", primary: "correction.channel", mutations: ["message_send:announcements"], said: ["should have gone to"], corrected: true },
  ] },
  { id: "private-for-instructors", world: { extraRoles: [["Instructor", 5]] }, turns: [
    { say: "Create a private announcements channel and give access to instructors", primary: "compound.setup", mutations: ["channel_create:announcements"], said: ["Instructor can see it"], check: w => { const ch = [...w.guild.channels.cache.values()].find(c => c.name === "announcements"); return !ch.permissionsFor(w.guild.roles.everyone).has(P.ViewChannel) && ch.permissionsFor(w.guild.roles.cache.find(r => r.name === "Instructor")).has(P.ViewChannel); } },
  ] },
  { id: "vip-setup", world: { extraRoles: [["VIP", 5]] }, turns: [
    { say: "Create a VIP category, add announcements and discussion channels, make them private, and give access to the VIP role.", primary: "compound.setup", mutations: ["channel_create:category:VIP", "channel_create:announcements", "channel_create:discussion"], said: ["Done"] },
  ] },
  { id: "vip-setup-missing-role", turns: [
    { say: "Create a VIP category, add announcements and discussion channels, make them private, and give access to the VIP role.", primary: "compound.setup", mutations: none, said: ["no role called"] },
  ] },
  { id: "memory-across-sessions", turns: [
    { say: "Remember that I prefer short announcements", primary: "memory.remember", mutations: none, said: ["Saved"] },
    { say: "Write an announcement about the stream", primary: "draft.write", mutations: none, notSaid: ["Bring your questions"], newConversation: true },
  ] },
  { id: "provider-fallback", ai: { failFirst: ["gemini*"] }, providerFailure: true, turns: [
    { say: "Write an announcement about the stream", primary: "draft.write", mutations: none, said: ["version 1"] },
    { say: "Make it shorter", primary: "draft.revise", mutations: none, said: ["version 2"], retention: true },
  ] },
  { id: "send-timeout-no-duplicate", turns: [
    { say: "Write an announcement about the stream", mutations: none },
    { say: "send it here", pre: w => { w.sendMode = "timeoutAfterCreate"; }, mutations: ["message_send:general"], said: ["did not send it twice"], duplicateGuard: true },
    { say: "send it here", mutations: none, said: ["already posted"] },
  ], maxSends: 1 },
  { id: "ambiguous-delete", before: w => w.mkChannel({ name: "staff" }), turns: [
    { say: "Write an announcement about the stream", mutations: none },
    { say: "send it here", mutations: ["message_send:general"] },
    { say: "send it to staff channel", mutations: ["message_send:staff"] },
    { say: "show me the members", mutations: none },
    { say: "Delete that", primary: "message.delete", ask: true, mutations: none, said: ["Which message"] },
  ], maxSends: 2 },
  { id: "ambiguous-channel", before: async w => { const cat = await w.guild.channels.create({ name: "Cat", type: 4 }); w.mkChannel({ name: "news" }); w.mkChannel({ name: "news", parentId: cat.id }); w.reset(); }, turns: [
    { say: "Write an announcement about the stream", mutations: none },
    { say: "send it in news", primary: "draft.send", ask: true, mutations: none, said: ["similar names"] },
    { say: "the second one", mutations: [/^message_send:news$/], said: ["Sent in"], ref: true },
  ], maxSends: 1 },
  { id: "no-draft-no-send", turns: [{ say: "send it", unhandled: true, mutations: none }] },
  { id: "channel-visibility", turns: [
    { say: "Which channels do everyone have view access", primary: "channels.visibility", tool: "channel_visibility", mutations: none, said: ["can see"], notSaid: ["unable"] },
    { say: "which channels are private", primary: "channels.visibility", mutations: none, said: ["Hidden from"] },
  ] },
  { id: "invite", turns: [{ say: "Give me an invite", primary: "invite.create", mutations: none }] },
];

