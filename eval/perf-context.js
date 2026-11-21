// How much the memory costs per message: the time to understand a message and build its context with a full artifact store, and how big
// the context is. Run with `npm run eval:perf-context`. Stand-in server, no network: this measures the memory code only.
import { makeSession, brain, mem } from "./context-harness.js";
import { performance } from "node:perf_hooks";

const S = makeSession();
const NAMES = ["IFVG", "FVG", "CISD", "SMT divergence", "liquidity sweep", "BSL", "SSL", "breaker block", "order block", "MSS", "PSP", "killzone"];
// fill the store the way a month of use would: 150 explanations across 12 subjects and 5 aspects
const art = await import("../src/brain/artifacts.js").catch(() => null);
for (let i = 0; i < 150; i++) {
  const n = NAMES[i % NAMES.length];
  await S.turn(i % 5 === 0 ? `What is ${n}?` : ["How is this used in trading?", "Can you give me an example?", "When is it most useful?", "What mistakes do people make with this?"][i % 4], { forceText: `${n} text number ${i}. `.repeat(40) });
}
const stats = (label, xs) => { xs.sort((a, b) => a - b); console.log(`${label.padEnd(44)} median ${xs[Math.floor(xs.length / 2)].toFixed(2)} ms   p95 ${xs[Math.floor(xs.length * .95)].toFixed(2)} ms   max ${xs.at(-1).toFixed(2)} ms`); };
const store = S.store();
console.log(`artifacts stored: ${store.artifacts.length}; conversation turns kept: ${S.convo().turns.length}; summary ${S.convo().summary.length} characters`);

const msg = text => S.w.say(text, S.ch.general);
const cases = [["follow-up question (rewrite + context)", "How is this used in trading?"], ["transformation (source retrieval)", "Turn this into a lesson"], ["unrelated server question", "how many members do we have?"], ["embed for this (prepareEmbed)", "Make an embed for this"], ["embed for the first one", "Make an embed for the first one"]];
for (const [label, text] of cases) {
  const xs = [];
  for (let i = 0; i < 100; i++) { const m = msg(text), t0 = performance.now(); if (label.startsWith("embed")) await brain.prepareEmbed(m, text, {}); else await brain.handle(m, text, { ai: { admin: { incident: false, disabled: [], trusted: [], confirmSeconds: 1 }, automod: { on: false } }, admins: [] }); xs.push(performance.now() - t0); }
  stats(label, xs);
}
const m = msg("How is this used in trading?"); const r = await brain.handle(m, "How is this used in trading?", { ai: { admin: { incident: false, disabled: [], trusted: [], confirmSeconds: 1 }, automod: { on: false } }, admins: [] });
console.log(`context handed to the model: ${r.context.length} characters (about ${Math.round(r.context.length / 4)} tokens)`);
const t = await brain.handle(msg("Turn this into a lesson"), "Turn this into a lesson", { ai: { admin: { incident: false, disabled: [], trusted: [], confirmSeconds: 1 }, automod: { on: false } }, admins: [] });
console.log(`context with an exact source attached: ${t.context.length} characters (about ${Math.round(t.context.length / 4)} tokens)`);
console.log(`brain.json on disk: ${(JSON.stringify(mem.getStore()).length / 1024).toFixed(0)} KB`);
process.exit(0);
