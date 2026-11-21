// Runs the context-and-memory scenarios (eval/context-scenarios.js) and reports what a correct assistant would have done differently.
//   npm run eval:context                              everything, against this checkout
//   npm run eval:context -- --label after             name the result file (eval/results/context-<label>-<time>.json)
//   npm run eval:context -- --root ../old-checkout --label before     run the same scenarios against another checkout (the "before")
//   npm run eval:context -- --category follow-up,transform
//   npm run eval:context -- --id spec-               exact ids or prefixes
//   npm run eval:context -- --verbose                 every failing step with its reasons
// Nothing here is marked as passed unless it was executed. It proves the logic against stand-ins (tests/helpers/world.js and the stand-in
// model in eval/context-knowledge.js); it does not prove behaviour against the live Discord API or real model output.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = n => { const i = argv.findIndex(a => a === `--${n}` || a.startsWith(`--${n}=`)); if (i < 0) return null; return argv[i].includes("=") ? argv[i].split("=").slice(1).join("=") : argv[i + 1] ?? null; };
if (opt("root")) process.env.YSER_ROOT = path.resolve(opt("root"));
const verbose = argv.includes("--verbose"), label = opt("label") ?? "run", wantCats = opt("category")?.split(","), wantIds = opt("id")?.split(",");
const HERE = path.dirname(fileURLToPath(import.meta.url));

const { makeSession, judge, NEW } = await import("./context-harness.js");
const { scenarios: main } = await import("./context-scenarios.js");
const { heldout } = await import("./context-heldout.js");
const scenarios = argv.includes("--main-only") ? main : [...main, ...heldout];

const chosen = scenarios.filter(s => (!wantCats || wantCats.includes(s.cat)) && (!wantIds || wantIds.some(i => s.id === i || s.id.startsWith(i))));
const results = [], byCat = new Map();
const metrics = { follow: [0, 0], resolve: [0, 0], transform: [0, 0], action: [0, 0], ask: [0, 0], noask: [0, 0], persist: [0, 0], steps: [0, 0] };
const bump = (k, ok) => { metrics[k][1]++; if (ok) metrics[k][0]++; };

for (const sc of chosen) {
  const S = makeSession();
  const stepResults = []; let ok = true;
  for (const step of sc.steps) {
    if (step.restart) { S.restart(); continue; }
    step.opts?.pre?.(S);
    const { pre, ...turnOpts } = step.opts ?? {};
    const res = await S.turn(step.say, turnOpts);
    const bad = await judge(res, step.expect, S);
    const e = step.expect;
    bump("steps", !bad.length);
    if (e.answers !== undefined) { bump(sc.cat === "follow-up" || sc.cat === "topic-switch" || sc.cat === "multi-topic" ? "follow" : "resolve", !bad.length); }
    if (e.embedHas || e.answerHas || e.sentHas) bump("transform", !bad.length);
    if (e.sentTo || e.pinned || e.pinnedId || e.mutations) bump("action", !bad.length);
    if (e.asks) bump("ask", !bad.length);
    if (e.noAsk) bump("noask", !bad.length);
    if (sc.steps.some(s => s.restart)) bump("persist", !bad.length);
    stepResults.push({ say: step.say, source: res.source, ok: !bad.length, bad });
    if (bad.length) ok = false;
  }
  results.push({ id: sc.id, cat: sc.cat, title: sc.title, ok, steps: stepResults });
  const c = byCat.get(sc.cat) ?? [0, 0]; c[1]++; if (ok) c[0]++; byCat.set(sc.cat, c);
}

const pct = ([a, b]) => b ? `${(100 * a / b).toFixed(1)}%` : "n/a";
const passed = results.filter(r => r.ok).length;
const lines = [];
lines.push(`Context and memory evaluation: ${label} (${NEW ? "current memory architecture" : "previous memory architecture"})`);
lines.push(`Scenarios fully correct: ${passed}/${results.length} (${pct([passed, results.length])})`);
lines.push("");
for (const [cat, c] of byCat) lines.push(`  ${cat.padEnd(14)} ${String(c[0]).padStart(3)}/${String(c[1]).padEnd(3)} ${pct(c)}`);
lines.push("");
lines.push(`Step-level checks: ${pct(metrics.steps)} (${metrics.steps[0]}/${metrics.steps[1]})`);
for (const [k, name] of [["follow", "Follow-up understanding (subject kept across turns)"], ["resolve", "Subject resolved on a single follow-up"], ["transform", "Transformations built from the exact source"], ["action", "Sends / pins / edits applied to the right message"], ["ask", "Asked when the reference was ambiguous"], ["noask", "Did not ask when the reference was clear"], ["persist", "Correct after a restart"]]) lines.push(`  ${name.padEnd(58)} ${pct(metrics[k])}  (${metrics[k][0]}/${metrics[k][1]})`);
console.log(lines.join("\n"));
if (verbose) for (const r of results.filter(x => !x.ok)) { console.log(`\n✗ ${r.id}  ${r.title}`); for (const s of r.steps.filter(x => !x.ok)) console.log(`    "${s.say}" [${s.source}] ${s.bad.join("; ")}`); }

fs.mkdirSync(path.join(HERE, "results"), { recursive: true });
const file = path.join(HERE, "results", `context-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify({ label, architecture: NEW ? "current" : "previous", at: new Date().toISOString(), total: results.length, passed, metrics, categories: Object.fromEntries(byCat), failing: results.filter(r => !r.ok).map(r => ({ id: r.id, cat: r.cat, title: r.title, steps: r.steps.filter(s => !s.ok) })) }, null, 1));
console.log(`\nWrote ${path.relative(process.cwd(), file)}`);
process.exit(0);
