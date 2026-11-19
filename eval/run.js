// Runs the evaluation dataset and prints the numbers that decide whether the assistant is actually correct (not just fluent):
// intent accuracy, tool selection, reference resolution, context retention, task completion, duplicate operations, incorrect executions,
// provider-failure recovery and unnecessary model calls. Exits with an error when a number is below its bar, so it can gate a deploy.
//   npm run eval            all metrics
//   npm run eval -- --verbose   every failing case in full
// It runs against the stand-in server (tests/helpers/world.js): it proves the logic, not the live Discord API.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.SUPABASE_SERVICE_KEY = ""; process.env.SUPABASE_SERVICE_ROLE_KEY = ""; process.env.OWNER_ID = "owner1";
process.env.YSER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "yser-eval-"));
const { makeWorld, fakeProviders, said } = await import("../tests/helpers/world.js");
const brain = await import("../src/brain/index.js");
const mem = await import("../src/brain/memory.js");
const { classify } = await import("../src/brain/classify.js");
const { setProviders } = await import("../src/brain/router.js");
const { intentCases, dialogues } = await import("./dataset.js");

const verbose = process.argv.includes("--verbose");
const config = { ai: { admin: { incident: false, disabled: [], trusted: [], confirmSeconds: 1 }, automod: { on: false } }, admins: [] };
const fails = [];
const tally = () => ({ ok: 0, n: 0, add(pass, why) { this.n++; if (pass) this.ok++; else if (why) fails.push(why); } });
const M = { intent: tally(), tool: tally(), reference: tally(), retention: tally(), completion: tally(), duplicates: tally(), execution: tally(), recovery: tally(), modelCalls: tally(), clarify: tally() };

/* 1. single-message intent classification */
const roleNames = ["Moderator", "Instructor", "VIP", "Academy"];
for (const [text, want, ctx = {}] of intentCases) {
  const k = classify(text, { convo: {}, roleNames: ctx.roles ?? roleNames, draft: ctx.draft ? { id: "d" } : null });
  M.intent.add(k.primary === want, `intent: "${text}" -> ${k.primary} (wanted ${want})`);
}

/* 2. dialogues */
const isQuestion = s => /\?\s*$/m.test(s) || /\b(which|what would you like|what should)\b/i.test(s);
const matches = (want, got) => want.length === got.length && want.every((w, i) => (w instanceof RegExp ? w.test(got[i]) : w === got[i]));
for (const d of dialogues) {
  mem._reset(); const fp = fakeProviders(d.ai); setProviders(fp.providers);
  const w = makeWorld(d.world); await d.before?.(w); w.reset();
  let scenarioOk = true, wrote = 0;
  for (const [i, t] of d.turns.entries()) {
    const label = `${d.id} #${i + 1} "${t.say.slice(0, 50)}"`;
    if (t.newConversation) mem.resetConvo("g1:owner1");
    t.pre?.(w);
    const m0 = w.mutations.length, calls0 = fp.calls.length;
    const r = await brain.handle(w.say(t.say), t.say, config);
    const text = said(r), delta = w.mutations.slice(m0);
    let ok = true; const bad = [];
    const fail = why => { ok = false; bad.push(why); };
    if (t.unhandled ? r.handled : !r.handled) fail(t.unhandled ? "should have been left to the existing path" : "not handled by the assistant");
    if (t.primary) { const pass = r.k?.primary === t.primary; M.intent.add(pass, `${label}: intent ${r.k?.primary} (wanted ${t.primary})`); if (!pass) fail("intent"); }
    if (t.tool) { const op = mem.recentOps("g1", "owner1", 1)[0]; const pass = op?.action === t.tool; M.tool.add(pass, `${label}: tool ${op?.action} (wanted ${t.tool})`); if (!pass) fail("tool"); }
    for (const s of t.said ?? []) if (!new RegExp(s, "i").test(text)) fail(`reply lacks /${s}/`);
    for (const s of t.notSaid ?? []) if (new RegExp(s, "i").test(text)) fail(`reply contains /${s}/`);
    if (t.mutations) { const pass = matches(t.mutations, delta); M.execution.add(pass, `${label}: changes ${JSON.stringify(delta)} (allowed ${JSON.stringify(t.mutations.map(String))})`); if (!pass) fail("mutations"); }
    if (t.check) { const pass = !!t.check(w); if (!pass) fail("state check"); if (t.ref) M.reference.add(pass && matches(t.mutations ?? delta, delta), `${label}: reference resolved to the wrong target`); }
    else if (t.ref) M.reference.add(!bad.length, `${label}: reference not resolved`);
    if (t.retention) { const pass = !isQuestion(text) && ok; M.retention.add(pass, `${label}: asked something already known / failed: ${text.slice(0, 100)}`); if (!pass) fail("retention"); }
    if (t.ask) { const pass = isQuestion(text); M.clarify.add(pass, `${label}: should have asked, said: ${text.slice(0, 100)}`); if (!pass) fail("clarify"); }
    if (t.duplicateGuard) M.duplicates.add(w.mutations.filter(m => m.startsWith("message_send")).length === 1, `${label}: sent twice after a timeout`);
    if (!/^draft\.(write|revise)$|^message\.edit$/.test(t.primary ?? "") && !/write|revise/.test(r.k?.primary ?? "")) M.modelCalls.add(fp.calls.length === calls0, `${label}: made ${fp.calls.length - calls0} model call(s) for a deterministic operation`);
    wrote = w.mutations.filter(m => m.startsWith("message_send")).length;
    if (!ok) { scenarioOk = false; if (verbose) console.log(`  ✖ ${label}: ${bad.join("; ")}\n    reply: ${text.replace(/\s+/g, " ").slice(0, 200)}`); }
  }
  if (d.maxSends != null) M.duplicates.add(wrote <= d.maxSends, `${d.id}: ${wrote} sends, allowed ${d.maxSends}`);
  if (d.providerFailure) M.recovery.add(scenarioOk && fp.calls.length > 0, `${d.id}: did not recover from a provider failure`);
  M.completion.add(scenarioOk, `scenario ${d.id} did not complete`);
}

/* the report */
const pct = t => (t.n ? `${Math.round(1000 * t.ok / t.n) / 10}%`.padStart(6) : "   n/a");
const BARS = { intent: 0.95, tool: 1, reference: 1, retention: 1, completion: 1, duplicates: 1, execution: 1, recovery: 1, modelCalls: 1, clarify: 1 };
const rows = [["Intent accuracy", "intent"], ["Tool-selection accuracy", "tool"], ["Reference-resolution accuracy", "reference"], ["Context retention (no questions already answered)", "retention"], ["Clarifies when it must", "clarify"], ["Task completion rate", "completion"], ["Duplicate-operation safety", "duplicates"], ["Correct execution (no unintended changes)", "execution"], ["Provider-failure recovery", "recovery"], ["No model call for deterministic work", "modelCalls"]];
console.log("\nAssistant evaluation\n" + "─".repeat(70));
let bad = 0;
for (const [name, key] of rows) { const t = M[key], low = t.n && t.ok / t.n < BARS[key]; if (low) bad++; console.log(`${name.padEnd(52)} ${pct(t)}  (${t.ok}/${t.n})${low ? "  ✖ below bar" : ""}`); }
console.log("─".repeat(70));
if (fails.length) { console.log(`\n${fails.length} failing case(s):`); for (const f of fails.slice(0, 40)) console.log(" - " + f); }
console.log(bad ? `\n${bad} metric(s) below the bar.` : "\nEvery metric meets its bar.");
mem.flush(); process.exit(bad ? 1 : 0);
