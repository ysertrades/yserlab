// Runs the adversarial scenario set (eval/scenarios.js) against the assistant's brain and the stand-in server, and reports what a correct
// assistant would have done differently. It is a baseline tool: failing scenarios are expected and are the point.
//   npm run eval:scenarios                       everything
//   npm run eval:scenarios -- --category refs,drafts
//   npm run eval:scenarios -- --id refs-03,memory-06    (exact ids, or a prefix such as "refs-")
//   npm run eval:scenarios -- --verbose          every failing scenario in full
//   npm run eval:scenarios -- --compare eval/results/<earlier>.json     deltas against an earlier run
// Every run writes eval/results/<ISO timestamp>.json with each failing scenario and the reasons. It proves the logic against the stand-in
// server (tests/helpers/world.js); it does not prove behaviour against the live Discord API or real model output.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

process.env.SUPABASE_SERVICE_KEY = ""; process.env.SUPABASE_SERVICE_ROLE_KEY = ""; process.env.OWNER_ID = "owner1";
process.env.YSER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "yser-scen-"));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { makeWorld, fakeProviders, said } = await import("../tests/helpers/world.js");
const brain = await import("../src/brain/index.js");
const mem = await import("../src/brain/memory.js");
const { setProviders } = await import("../src/brain/router.js");
const { scenarios, CATEGORIES } = await import("./scenarios.js");

/* ── command line ── */
const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = n => { const i = argv.findIndex(a => a === `--${n}` || a.startsWith(`--${n}=`)); if (i < 0) return null; return argv[i].includes("=") ? argv[i].split("=").slice(1).join("=") : argv[i + 1] ?? null; };
const verbose = flag("verbose"), wantCats = opt("category")?.split(",").map(s => s.trim()), wantIds = opt("id")?.split(",").map(s => s.trim()), compareFile = opt("compare");

const config = { ai: { admin: { incident: false, disabled: [], trusted: [], confirmSeconds: 1 }, automod: { on: false } }, admins: [] };
const KEY = "g1:owner1";
const warnings = []; console.warn = (...a) => { warnings.push(a.map(String).join(" ").slice(0, 160)); };
const say0 = console.log.bind(console); // the admin audit prints "[ok] admin ..." lines for every tool run; they are noise here
console.log = (...a) => { if (/^\[(ok|fail|cancelled|denied|blocked)\]/.test(String(a[0]))) return; say0(...a); };

/* the tool a correct answer leaves as its last recorded operation, when the scenario does not say otherwise */
const TOOL_OF = { "members.list": "member_list", "members.search": "member_list", "members.byRole": "member_list", "members.count": "member_count", "members.online": "member_online", "server.overview": "server_overview", "roles.list": "role_list", "channels.list": "channel_list", "invite.create": "invite_create", "channel.create": "channel_create", "category.create": "channel_create", "role.create": "role_create", "channel.access": "channel_access", "role.assign": "role_assign", "role.remove": "role_assign", "draft.send": "message_send", "message.pin": "message_pin", "message.delete": "message_remove", "message.edit": "message_update", "compound.setup": "channel_create", "correction.channel": "message_send", "draft.write": null, "draft.revise": null, "draft.approve": null, "draft.show": null, "draft.restore": null, "context.resume": null, "memory.remember": null, "memory.forget": null, "memory.show": null };

/* ── matching helpers ── */
const lc = v => String(v ?? "").toLowerCase();
function valueMatches(want, got) {
  if (want instanceof RegExp) return want.test(String(got ?? ""));
  if (typeof want === "function") return !!want(got);
  if (typeof want === "boolean") return !!got === want;
  if (Array.isArray(want)) return Array.isArray(got) && want.length === got.length && want.every((w, i) => lc(w) === lc(got[i]));
  if (typeof want === "number") return got === want;
  return lc(want) === lc(got);
}
const patternMatches = (want, got) => (want instanceof RegExp ? want.test(got) : want === got);
/** Compares the changes that happened with the ones allowed: returns what was missing and what was extra (unintended). */
function compareMutations(delta, want, allow = []) {
  const rest = delta.filter(d => !allow.some(a => patternMatches(a, d)));
  const missing = [], used = new Set();
  let from = 0;
  for (const w of want) {
    const i = rest.findIndex((d, j) => j >= from && !used.has(j) && patternMatches(w, d));
    if (i < 0) missing.push(String(w)); else { used.add(i); from = i + 1; }
  }
  const extra = rest.filter((d, j) => !used.has(j));
  const ordered = [...used].every((v, i, a) => i === 0 || v > a[i - 1]);
  return { missing, extra, ok: !missing.length && !extra.length && ordered };
}
const isConfirmMsg = m => /"custom_id":"ok:/.test(JSON.stringify(m.components ?? []));
const confirmCount = w => [...w.guild.channels.cache.values()].reduce((n, ch) => n + ch.store.filter(isConfirmMsg).length, 0);
const CLARIFY_TEXT = /\b(tag the person|tag them|ask me for the members first|list of people to pick)\b/i;

/* ── the context handed to scenario functions ── */
function makeCtx(w) {
  const c = { w, replies: [], lastReply: "", key: KEY,
    ch: name => [...w.guild.channels.cache.values()].filter(x => x.name === name).pop(),
    msgs: name => (c.ch(name)?.store ?? []).filter(m => !isConfirmMsg(m)),
    prefs: () => mem.prefsOf("owner1"),
    draft: () => mem.currentDraft(mem.getConvo(KEY)),
    /** the id of the n-th person (1-based, or "last") in the most recent numbered member list the owner was shown */
    shown(n) {
      for (const text of [...c.replies].reverse()) {
        const rows = [...text.matchAll(/^(\d+)\. .*?<@(\w+)>/gm)].map(m => [Number(m[1]), m[2]]);
        if (rows.length) return n === "last" ? rows.at(-1)[1] : rows.find(r => r[0] === n)?.[1] ?? "NO-SUCH-ROW";
      }
      return "NO-LIST-SHOWN";
    } };
  return c;
}

/* ── metric accumulators ── */
const METRICS = [
  ["intent", "Intent accuracy", true], ["tool", "Tool selection accuracy", true], ["args", "Correct-argument rate", true], ["ref", "Reference-resolution accuracy", true],
  ["unnecessary", "Unnecessary-clarification rate", false], ["missing", "Missing-clarification rate", false], ["confirm", "Confirmation correctness", true],
  ["exec", "Verified-execution rate", true], ["unintended", "Unintended-mutation rate", false], ["scenario", "Scenarios fully correct", true],
];
const newAcc = () => Object.fromEntries(METRICS.map(([k]) => [k, { ok: 0, n: 0 }]));
const tally = (acc, key, pass) => { acc[key].n++; if (pass) acc[key].ok++; };
const byCat = Object.fromEntries(Object.keys(CATEGORIES).map(k => [k, newAcc()])), overall = newAcc();
const note = (cat, key, pass) => { tally(overall, key, pass); tally(byCat[cat], key, pass); };
const turnMs = [], memMs = [], catCount = {}, failures = [], status = {};

/* ── one turn through the brain ── */
async function turn(w, c, spec) {
  const t = typeof spec === "string" ? { say: spec } : spec;
  if (t.reset) mem.resetConvo(KEY);
  t.pre?.(w);
  const msg = w.say(t.say, t.ch ? c.ch(t.ch) ?? w.general : w.general);
  const t0 = performance.now(); let r, threw = null;
  try { r = await brain.handle(msg, t.say, config); } catch (e) { threw = e; r = { handled: false }; }
  turnMs.push(performance.now() - t0);
  const text = said(r); c.replies.push(text); c.lastReply = text;
  return { r, text, threw };
}

/* ── select and run ── */
const picked = scenarios.filter(s => (!wantCats || wantCats.includes(s.cat)) && (!wantIds || wantIds.some(i => s.id === i || (i.endsWith("-") && s.id.startsWith(i)))));
if (!picked.length) { console.log("No scenario matches that filter."); process.exit(1); }

for (const sc of picked) {
  mem._reset(); const fp = fakeProviders(sc.ai); setProviders(fp.providers);
  const w = makeWorld(sc.world), c = makeCtx(w);
  warnings.length = 0; catCount[sc.cat] = (catCount[sc.cat] ?? 0) + 1;
  const why = [], kinds = new Set();
  const fail = (kind, text) => { why.push(`${kind}: ${text}`); kinds.add(kind); };
  let res;
  try {
    await sc.setup?.(w, c);
    for (const p of sc.prev ?? []) await turn(w, c, p);
    w.reset(); warnings.length = 0;
    const opsBefore = mem.recentOps("g1", "owner1", 1e6).length, confBefore = confirmCount(w);
    res = await turn(w, c, sc.say);
    const { r, text, threw } = res, delta = w.mutations.slice(), ops = mem.recentOps("g1", "owner1", 1e6);
    if (threw) fail("crash", String(threw?.message ?? threw).slice(0, 140));
    const convo = mem.getConvo(KEY), k = r.k ?? null, got = r.handled ? (k?.primary ?? "handled") : "left-to-model";

    /* intent */
    const wantIntent = sc.llm ? "left-to-model" : sc.intent, wantList = [].concat(wantIntent ?? []);
    let intentOk = true;
    if (wantList.length) { intentOk = sc.llm ? !r.handled : r.handled && (wantList.includes(k?.primary) || (k?.multi && [k.primary, ...(k.secondary ?? [])].some(x => wantList.includes(x)))); // a several-operations message is right when the operation it was checked for is one of the ones it ran
      note(sc.cat, "intent", intentOk); if (!intentOk) fail("intent", `got ${got}, wanted ${wantList.join(" | ")}`); }

    /* tool: the last operation recorded during this turn */
    const wantTool = sc.tool !== undefined ? sc.tool : sc.clarify || sc.llm ? null : TOOL_OF[wantList[0]];
    let toolOk = true;
    if (wantTool !== undefined) {
      const fresh = ops.length - opsBefore, last = fresh > 0 ? ops[0].action : null;
      const freshOps = ops.slice(0, Math.max(0, fresh)).map(o => o.action);
      toolOk = wantTool === null ? fresh === 0 : fresh > 0 && (k?.multi ? freshOps.includes(wantTool) : last === wantTool); // for a several-operations message the expected tool must be among those that ran
      note(sc.cat, "tool", toolOk);
      if (!toolOk) fail("tool", `recorded ${last ?? "no operation"}, wanted ${wantTool ?? "no operation"}`);
    }

    /* arguments (classification params + target) and resulting state */
    let argsOk = true, stateOk = true;
    if (sc.args) {
      if (typeof sc.args === "function") argsOk = !!(k && sc.args(k, c));
      else { const merged = { ...(k?.params ?? {}), ...(k?.target ?? {}) }; const bad = k ? Object.entries(sc.args).filter(([key, want]) => !valueMatches(want, merged[key])).map(([key, want]) => `${key}=${JSON.stringify(merged[key])} (wanted ${want})`) : ["no classification"]; argsOk = !bad.length; if (bad.length) fail("args", bad.join(", ")); }
    }
    if (sc.state) { try { stateOk = !!sc.state(w, c); } catch (e) { stateOk = false; } if (!stateOk) fail("state", `the resulting state is wrong (${text.replace(/\s+/g, " ").slice(0, 90)})`); }
    if (sc.args || sc.state) note(sc.cat, "args", argsOk && stateOk);

    /* clarification */
    {
      const asked = !!convo.pending || CLARIFY_TEXT.test(text), want = !!sc.clarify;
      if (want) { note(sc.cat, "missing", !asked); if (!asked) fail("clarify-missing", "did not ask, though it must"); }
      else { note(sc.cat, "unnecessary", asked); if (asked) fail("clarify-unnecessary", `asked a question it did not need to (${text.replace(/\s+/g, " ").slice(0, 80)})`); }
    }

    /* confirmation panel */
    const confirmed = confirmCount(w) - confBefore > 0;
    const wantMut = typeof sc.mut === "function" ? sc.mut(w, c) : sc.mut === undefined ? [] : sc.mut;
    if (sc.confirm || (wantMut && wantMut.length) || confirmed) { const ok = confirmed === !!sc.confirm; note(sc.cat, "confirm", ok); if (!ok) fail("confirm", confirmed ? "showed a confirm panel that was not needed" : "no confirm panel, but the target came from a reference / the action is risky"); }

    /* execution: exactly the allowed changes, nothing else */
    let mutOk = true;
    if (wantMut !== null) {
      const cmp = compareMutations(delta, wantMut, sc.mutAllow ?? []); mutOk = cmp.ok;
      if (!cmp.ok) fail(cmp.extra.length ? "mutation-unintended" : "mutation-missing", `changes ${JSON.stringify(delta.map(String))}${cmp.missing.length ? ` lack ${JSON.stringify(cmp.missing)}` : ""}${cmp.extra.length ? ` extra ${JSON.stringify(cmp.extra)}` : ""}`);
      note(sc.cat, "unintended", cmp.extra.length > 0);
    }
    if ((wantMut && wantMut.length) || sc.state) note(sc.cat, "exec", mutOk && stateOk && !threw);

    /* wording */
    for (const s of sc.said ?? []) if (!new RegExp(s, "i").test(text)) fail("said", `reply lacks /${s}/`);
    for (const s of sc.notSaid ?? []) if (new RegExp(s, "i").test(text)) fail("notSaid", `reply contains /${s}/`);
    if (sc.ref) note(sc.cat, "ref", !why.length);

    /* memory retrieval latency (the context block built for the model path) */
    const m0 = performance.now(); for (let i = 0; i < 20; i++) mem.contextBlock(convo, "owner1", String(sc.say)); memMs.push((performance.now() - m0) / 20);
    if (warnings.length) why.push(`warning: ${warnings[0]}`);
  } catch (e) { fail("harness", String(e?.stack ?? e).split("\n").slice(0, 2).join(" ")); }
  const pass = !why.some(x => !x.startsWith("warning:"));
  note(sc.cat, "scenario", pass); status[sc.id] = pass;
  if (!pass) {
    failures.push({ id: sc.id, category: sc.cat, difficulty: sc.diff, say: sc.say, prev: (sc.prev ?? []).map(p => (typeof p === "string" ? p : p.say)), reasons: why, kinds: [...kinds], reply: (res?.text ?? "").replace(/\s+/g, " ").slice(0, 240) });
    if (verbose) console.log(`✖ ${sc.id} (d${sc.diff}) "${String(sc.say).slice(0, 70)}"${sc.prev?.length ? `  after ${sc.prev.length} turn(s)` : ""}\n    ${why.join("\n    ")}\n    reply: ${(res?.text ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
  }
}

/* ── report ── */
const rate = a => (a.n ? a.ok / a.n : null);
const pct = a => (a.n ? `${(100 * a.ok / a.n).toFixed(1)}%`.padStart(6) : "   n/a");
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const p95 = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length * 0.95)] ?? 0; };
const summary = (acc) => Object.fromEntries(METRICS.map(([k]) => [k, { ok: acc[k].ok, n: acc[k].n, rate: rate(acc[k]) }]));
const latency = { avgTurnMs: mean(turnMs), p95TurnMs: p95(turnMs), turns: turnMs.length, memoryRetrievalAvgMs: mean(memMs), memoryRetrievalMaxMs: Math.max(0, ...memMs) };

console.log(`\nScenario evaluation: ${picked.length} scenario(s)\n${"─".repeat(78)}`);
for (const [k, name, higher] of METRICS) console.log(`${name.padEnd(36)} ${pct(overall[k])}  (${overall[k].ok}/${overall[k].n})${higher ? "" : "  lower is better"}`);
console.log(`${"Average latency per turn".padEnd(36)} ${latency.avgTurnMs.toFixed(2)} ms  (p95 ${latency.p95TurnMs.toFixed(2)} ms, ${latency.turns} turns)`);
console.log(`${"Memory-retrieval latency".padEnd(36)} ${(latency.memoryRetrievalAvgMs * 1000).toFixed(1)} µs avg  (max ${(latency.memoryRetrievalMaxMs * 1000).toFixed(1)} µs)`);
console.log(`\nPer category (% correct; scenario / intent / tool / args / reference / confirm / exec; unnecessary + missing clarifications and unintended changes are shown as the % that went wrong)`);
console.log(`${"category".padEnd(40)}${"n".padStart(4)}${"scen".padStart(7)}${"intent".padStart(7)}${"tool".padStart(7)}${"args".padStart(7)}${"ref".padStart(7)}${"conf".padStart(7)}${"exec".padStart(7)}${"unnec".padStart(7)}${"miss".padStart(7)}${"unint".padStart(7)}`);
const short = a => (a.n ? `${Math.round(100 * a.ok / a.n)}%` : "-").padStart(7);
const bad = a => (a.n ? `${Math.round(100 * a.ok / a.n)}%` : "-").padStart(7);
for (const [cat, name] of Object.entries(CATEGORIES)) { const a = byCat[cat]; if (!catCount[cat]) continue; console.log(`${name.padEnd(40)}${String(catCount[cat]).padStart(4)}${short(a.scenario)}${short(a.intent)}${short(a.tool)}${short(a.args)}${short(a.ref)}${short(a.confirm)}${short(a.exec)}${bad(a.unnecessary)}${bad(a.missing)}${bad(a.unintended)}`); }
const ofKind = {}; for (const f of failures) for (const kd of f.kinds) ofKind[kd] = (ofKind[kd] ?? 0) + 1;
console.log(`\n${failures.length} of ${picked.length} scenarios fail. Failing checks by kind: ${Object.entries(ofKind).sort((a, b) => b[1] - a[1]).map(([kd, n]) => `${kd} ${n}`).join(", ") || "none"}`);
if (!verbose && failures.length) console.log("(run with --verbose to see each failing scenario)");

/* ── results file ── */
const stamp = new Date().toISOString().replace(/:/g, "-");
const out = { timestamp: new Date().toISOString(), filter: { category: wantCats, id: wantIds }, scenarios: picked.length, passed: picked.length - failures.length, overall: summary(overall), categories: Object.fromEntries(Object.entries(byCat).filter(([k]) => catCount[k]).map(([k, a]) => [k, { n: catCount[k], ...summary(a) }])), latency, failureKinds: ofKind, failures, status };
fs.mkdirSync(path.join(HERE, "results"), { recursive: true });
const file = path.join(HERE, "results", `${stamp}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\nResults written to ${path.relative(process.cwd(), file)}`);

/* ── comparison with an earlier run ── */
if (compareFile) {
  let before; try { before = JSON.parse(fs.readFileSync(path.resolve(compareFile), "utf8")); } catch (e) { console.log(`\nCould not read ${compareFile}: ${e.message}`); before = null; }
  if (before) {
    const d = (a, b) => (a == null || b == null ? "   n/a" : `${b - a >= 0 ? "+" : ""}${(100 * (b - a)).toFixed(1)}`.padStart(6) + " pp");
    console.log(`\nCompared with ${path.basename(compareFile)} (${before.timestamp}): ${before.passed}/${before.scenarios} -> ${out.passed}/${out.scenarios} fully correct`);
    for (const [k, name, higher] of METRICS) { const a = before.overall?.[k]?.rate, b = out.overall[k].rate; console.log(`${name.padEnd(36)} ${a == null ? "  n/a" : (100 * a).toFixed(1) + "%"} -> ${b == null ? "n/a" : (100 * b).toFixed(1) + "%"}  ${d(a, b)}${a != null && b != null && b !== a ? (higher === (b > a) ? "  better" : "  worse") : ""}`); }
    console.log(`${"Average latency per turn".padEnd(36)} ${before.latency?.avgTurnMs?.toFixed(2) ?? "n/a"} ms -> ${latency.avgTurnMs.toFixed(2)} ms`);
    const fixed = Object.keys(status).filter(id => status[id] && before.status?.[id] === false), broke = Object.keys(status).filter(id => !status[id] && before.status?.[id] === true);
    console.log(`Newly passing (${fixed.length}): ${fixed.join(", ") || "none"}\nNewly failing (${broke.length}): ${broke.join(", ") || "none"}`);
  }
}
mem.flush(); process.exit(0);
