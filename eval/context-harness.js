// The conversation harness for the context-and-memory evaluation. It drives the same message flow the bot runs (embed writer, then the
// intelligence layer, then the model) against the stand-in server (tests/helpers/world.js) and the stand-in model
// (eval/context-knowledge.js), and reports what really happened: what the model was given, what was posted, pinned or sent, what was asked.
// It uses only features the code under test exports, so the SAME scenarios run against an older checkout (the "before") and the current
// one (the "after"). It proves the logic against stand-ins; it does not prove behaviour against the live Discord API or real models.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

process.env.SUPABASE_SERVICE_KEY = ""; process.env.SUPABASE_SERVICE_ROLE_KEY = ""; process.env.OWNER_ID = "owner1";
process.env.YSER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "yser-ctx-"));
const root = process.env.YSER_ROOT ? path.resolve(process.env.YSER_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const at = p => "file:///" + path.join(root, p).replace(/\\/g, "/");
const { makeWorld, fakeProviders, textOf } = await import(at("tests/helpers/world.js"));
const brain = await import(at("src/brain/index.js"));
const mem = await import(at("src/brain/memory.js"));
const embeds = await import(at("src/admin/embeds.js"));
const router = await import(at("src/brain/router.js"));
const { modelAnswer, mentions, CONCEPTS } = await import("./context-knowledge.js");

export const NEW = typeof brain.prepareEmbed === "function";
export const config = { ai: { admin: { incident: false, disabled: [], trusted: [], confirmSeconds: 1 }, automod: { on: false } }, admins: [] };
const warnings = []; console.warn = (...a) => { warnings.push(a.map(String).join(" ").slice(0, 200)); };
const say0 = console.log.bind(console);
console.log = (...a) => { if (/^\[(ok|fail|cancelled|denied|blocked)\]/.test(String(a[0]))) return; say0(...a); };

/* ── the stand-in embed writer: faithful to a source when it is given one, literal otherwise (exactly what a real writer can do with what it receives) ── */
const writerLog = [];
const cut = (s, n) => String(s).length > n ? String(s).slice(0, n).replace(/\s+\S*$/, "") : String(s);
embeds.useWriter(async (system, prompt) => {
  writerLog.push({ system, prompt });
  const edit = /Current announcement:\nTitle: (.*)\nBody:\n([\s\S]*?)\n\nChange it as asked.*?: (.*)$/s.exec(prompt);
  if (edit) {
    let [, title, body, ask] = edit; ask = ask.toLowerCase();
    if (/title/.test(ask) && /short|trim|shorten/.test(ask)) title = title.split(/\s+/).slice(0, 3).join(" ");
    else if (/short|trim|shorten/.test(ask)) body = cut(body.split(/\n/).slice(0, 2).join("\n"), 220);
    else if (/professional/.test(ask)) body = "We are pleased to share: " + body;
    else body = body + " (revised)";
    return JSON.stringify({ title, body });
  }
  const src = /SOURCE:\n([\s\S]*)$/.exec(prompt)?.[1];
  const subject = /Subject: (.*)/.exec(prompt)?.[1];
  if (/educational/i.test(system) && src) {
    // a faithful educational summary: every source paragraph is kept as a section, in order, nothing added
    const paras = src.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    return JSON.stringify({ title: `📘 ${subject ?? "Lesson"}`, body: paras.map((p, i) => `**${i === 0 ? "Overview" : `Part ${i + 1}`}**\n${p}`).join("\n\n") });
  }
  const topic = String(prompt).replace(/^(please\s+)?(make|create|write|draft|prepare|build)\s+(for me\s+)?(me\s+)?(an?\s+)?(educational\s+)?(embed|announcement)\s*(of|about|for|announcing)?\s*/i, "").trim();
  const lead = topic || "the session";
  return JSON.stringify({ title: cut(lead[0].toUpperCase() + lead.slice(1), 60), body: `**${lead}**\nWe cover ${lead} in this session. Bring your charts and your questions.\nDetails to follow.` });
});

const bodyOf = m => textOf({ content: m.content, components: m.components });
const channelLines = (channels, msgChannel) => {
  const lines = [];
  for (const m of msgChannel.store.slice(-12)) {
    const t = bodyOf(m).replace(/\s+/g, " ").slice(0, 420); if (!t) continue;
    lines.push(`${m.author?.id === "bot" ? "You (YSER Lab)" : "owner"}: ${m.components?.length && !m.content ? "[embed] " : ""}${t}`);
  }
  return lines.join("\n");
};

export function makeSession({ aiFail = [] } = {}) {
  mem._reset(); embeds.forgetDrafts(); writerLog.length = 0; warnings.length = 0;
  const fp = fakeProviders({ failFirst: aiFail }); router.setProviders(fp.providers);
  const w = makeWorld();
  const ch = { general: w.general, education: w.mkChannel({ name: "education" }), announcements: w.mkChannel({ name: "announcements" }), lab: w.mkChannel({ name: "lab" }) };
  const S = { w, ch, fp, writerLog, modelCalls: [], last: null, results: [] };
  const all = () => Object.values(ch);
  const key = (user = "owner1") => `g1:${user}`;
  const sizes = () => new Map(all().map(c => [c.id, c.store.length]));

  S.turn = async (text, { channel = "general", provider = "stub", user = "owner1", noEmbed = false, forceText = null } = {}) => {
    if (typeof channel === "string") channel = ch[channel];
    const before = sizes(), mutBefore = w.mutations.length;
    const msg = w.say(text, channel);
    if (user !== "owner1") msg.author = { id: user, username: user, tag: user };
    const res = { text, source: "none", said: [], answer: null, modelInput: null, embed: null, asked: false, mutations: [], provider };
    let prep = null;
    try {
      if (NEW) prep = await brain.prepareEmbed(msg, text, config);
      if (prep?.say) { await channel.send({ content: prep.say }); res.source = "brain-ask"; res.asked = true; }
      else if (!prep?.skipEmbed && !noEmbed && await embeds.handleEmbed(msg, prep?.text ?? text, config, prep?.opts)) {
        res.source = "embed"; brain.noteEmbed(msg, embeds.draftOf(msg), prep?.meta); res.embed = embeds.draftOf(msg);
      } else {
        const b = await brain.handle(msg, text, config);
        if (b.handled) {
          res.source = "brain"; res.k = b.k;
          if (b.say) await channel.send({ content: b.say });
          for (const p of b.posts ?? []) await channel.send(p);
        } else {
          const question = b.rewrite ?? text, context = `${channelLines(ch, channel)}\n${b.context ?? ""}`;
          const answer = modelAnswer({ question, context, provider }); if (forceText) answer.text = forceText;
          res.source = "model"; res.answer = answer; res.modelInput = { question, context, rewrite: b.rewrite ?? null }; S.modelCalls.push(res.modelInput);
          await channel.send({ content: answer.text });
          brain.noteAssistantText(msg, answer.text, { question, original: text, rewrite: b.rewrite ?? null });
        }
      }
    } catch (e) { res.error = String(e?.stack ?? e).slice(0, 400); }
    for (const c of all()) for (const m of c.store.slice(before.get(c.id))) res.said.push({ channel: c.name, id: m.id, text: bodyOf(m) });
    res.sayText = res.said.map(s => s.text).join("\n");
    res.mutations = w.mutations.slice(mutBefore);
    // the bot's own plain-text replies are not changes to the server: only embeds, pins, edits and the like count
    for (const s of res.said) { const m = ch[s.channel]?.store.find(x => x.id === s.id); if (m && !m.components?.length) { const i = res.mutations.indexOf(`message_send:${s.channel}`); if (i >= 0) res.mutations.splice(i, 1); } }
    res.asked ||= res.source !== "model" && /\?\s*(\n|$)/.test(res.sayText) && !res.mutations.length;
    S.last = res; S.results.push(res);
    return res;
  };
  /** The bot restarts: what it saved to disk is loaded again, nothing else survives. */
  S.restart = () => {
    mem.flush();
    if (typeof mem._reload === "function") mem._reload();
    else { const keep = structuredClone(mem.getConvo(key())); mem._reset(); Object.assign(mem.getConvo(key()), keep); } // the older memory keeps the conversation; it has no explanation store to keep
  };
  S.msgs = name => ch[name].store;
  S.botTexts = name => ch[name].store.map(bodyOf);
  S.pinnedCount = () => all().reduce((n, c) => n + c.store.filter(m => m.pinned).length, 0);
  S.convo = (user) => mem.getConvo(key(user));
  S.warnings = warnings;
  S.store = () => mem.getStore();
  return S;
}

/* ── expectations ── */
const reOf = x => x instanceof RegExp ? x : new RegExp(String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
/** Compares one step's result with what a correct assistant would have done. Returns the list of reasons it did not. */
export async function judge(res, exp = {}, S) {
  const bad = [];
  const need = (ok, why) => { if (!ok) bad.push(why); };
  if (res.error) bad.push(`threw: ${res.error.split("\n")[0]}`);
  if (exp.source) need(res.source === exp.source, `handled by ${res.source}, expected ${exp.source}`);
  if (exp.answers !== undefined) need(res.answer?.concept === exp.answers, `answered about ${res.answer?.concept ?? "nothing"}, expected ${exp.answers}`);
  if (exp.aspect) need(res.answer?.aspect === exp.aspect, `answered aspect ${res.answer?.aspect ?? "none"}, expected ${exp.aspect}`);
  if (exp.resolved) need(res.answer && !res.answer.unresolved, "the model could not tell what the subject was");
  if (exp.structured) need(res.answer && res.answer.via !== "recent-turns" && res.answer.via !== "none", `subject came from ${res.answer?.via ?? "nowhere"}, not from structured context`);
  if (exp.qHas) for (const q of [].concat(exp.qHas)) need(res.modelInput && reOf(q).test(res.modelInput.question), `the question given to the model lacks ${q}`);
  if (exp.ctxHas) for (const q of [].concat(exp.ctxHas)) need(res.modelInput && reOf(q).test(res.modelInput.context), `the context given to the model lacks ${q}`);
  if (exp.ctxLacks) for (const q of [].concat(exp.ctxLacks)) need(!res.modelInput || !reOf(q).test(res.modelInput.context), `the context given to the model wrongly holds ${q}`);
  if (exp.noModel) need(res.source !== "model", "it asked the model when it should not have");
  if (exp.asks) need(res.asked, "it did not ask which one");
  if (exp.noAsk) need(!res.asked, `it asked: ${res.sayText.slice(0, 90)}`);
  if (exp.said) need(reOf(exp.said).test(res.sayText), `the reply lacks ${exp.said}`);
  if (exp.notSaid) need(!reOf(exp.notSaid).test(res.sayText), `the reply wrongly says ${exp.notSaid}`);
  if (exp.answerHas) for (const t of [].concat(exp.answerHas)) need(res.answer && res.answer.text.includes(t), `the answer lacks ${t}`);
  if (exp.embed || exp.embedHas || exp.embedFrom) {
    const text = res.embed ? [res.embed.title, res.embed.body].join("\n") : "";
    need(!!res.embed, "no embed was made");
    for (const t of [].concat(exp.embedHas ?? [])) need(text.includes(t), `the embed lacks ${t}`);
    for (const t of [].concat(exp.embedLacks ?? [])) need(!reOf(t).test(text), `the embed wrongly holds ${t}`);
    if (exp.embedTitle) need(reOf(exp.embedTitle).test(res.embed?.title ?? ""), `the embed title is "${res.embed?.title}"`);
    if (exp.embedMax) need(text.length <= exp.embedMax, `the embed is ${text.length} characters, over ${exp.embedMax}`);
  }
  if (exp.posted) need(res.said.some(s => s.channel === exp.posted), `nothing was posted in #${exp.posted}`);
  if (exp.sentTo) {
    const m = [...S.ch[exp.sentTo].store].reverse().find(x => x.author?.id === "bot" && !/Posted in/.test(bodyOf(x)));
    need(!!m && res.mutations.some(x => x === `message_send:${exp.sentTo}`), `the embed was not sent to #${exp.sentTo}`);
    for (const t of [].concat(exp.sentHas ?? [])) need(m && bodyOf(m).includes(t), `the message sent to #${exp.sentTo} lacks ${t}`);
  }
  if (exp.pinned) need(res.mutations.some(x => x.startsWith("pin:")), "nothing was pinned");
  if (exp.pinnedId) { const id = typeof exp.pinnedId === "function" ? exp.pinnedId(S) : exp.pinnedId; need(res.mutations.includes(`pin:${id}`), `the pinned message was not the right one (wanted ${id})`); }
  if (exp.noMutations) need(!res.mutations.length, `it changed things: ${res.mutations.join(", ")}`);
  if (exp.mutations) need(JSON.stringify(res.mutations) === JSON.stringify(exp.mutations), `changes were ${JSON.stringify(res.mutations)}, expected ${JSON.stringify(exp.mutations)}`);
  if (exp.custom) { try { const why = await exp.custom(res, S); if (why) bad.push(why); } catch (e) { bad.push(`the check itself could not run (${String(e.message).slice(0, 60)}): the step did not produce what it needed`); } }
  return bad;
}
export { mentions, CONCEPTS, mem, brain, embeds, textOf };
