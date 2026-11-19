// Performance and concurrency benchmark for the assistant brain, run against the stand-in server (tests/helpers/world.js).
//   npm run eval:perf            full run, prints a table and flags anything over budget
//   npm run eval:perf -- --quick smaller sizes (a few seconds)
//   npm run eval:perf -- --strict exit code 1 when anything is flagged
// Sections: 1 classification, 2 memory retrieval and persistence, 3 concurrency (duplicate sends, corruption, ordering), 4 large member lists,
// 5 provider fallback, 6 brain.json growth and flush blocking. Proves logic and cost on the stand-in, not the live Discord API.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import v8 from "node:v8";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const quick = process.argv.includes("--quick"), strict = process.argv.includes("--strict");
process.env.SUPABASE_SERVICE_KEY = ""; process.env.SUPABASE_SERVICE_ROLE_KEY = ""; process.env.OWNER_ID = "owner1";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "yser-perf-"));
process.env.YSER_DATA_DIR = DATA;
v8.setFlagsFromString("--expose-gc"); const gc = vm.runInNewContext("gc");
const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
const mb = n => Math.round(n / 1048576 * 10) / 10;

/* the app logs every operation to the console: count it instead of printing it */
const realLog = console.log; let logged = 0;
console.log = () => { logged++; }; console.warn = () => { logged++; };

const { makeWorld, fakeProviders } = await import("../tests/helpers/world.js");
const brain = await import("../src/brain/index.js");
const mem = await import("../src/brain/memory.js");
const { classify } = await import("../src/brain/classify.js");
const router = await import("../src/brain/router.js");
const { intentCases } = await import("./dataset.js");

const config = { ai: { admin: { incident: false, disabled: [], trusted: [], confirmSeconds: 1 }, automod: { on: false } }, admins: [] };
const rows = [], flags = [], notes = [];
const row = (section, metric, value, limit = null, over = false) => { rows.push({ section, metric, value, limit }); if (over) flags.push(`${section} ${metric}: ${value}${limit ? ` (limit ${limit})` : ""}`); };
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const ms = n => `${(Math.round(n * 1000) / 1000).toFixed(n < 1 ? 3 : n < 100 ? 2 : 0)} ms`;
const stats = arr => ({ p50: q(arr, 0.5), p95: q(arr, 0.95), p99: q(arr, 0.99), max: Math.max(...arr) });
const timeIt = async fn => { const t = performance.now(); const out = await fn(); return [performance.now() - t, out]; };
const timeSync = fn => { const t = performance.now(); const out = fn(); return [performance.now() - t, out]; };
const freshWorld = opts => { const w = makeWorld(opts); w.reset(); return w; };
const author = (message, id) => ({ ...message, author: { id, tag: `${id}#1`, username: id } });

/* ---------- 1. classification ---------- */
{
  const base = intentCases.map(c => c[0]);
  const roleNames = ["Moderator", "Instructor", "VIP", "Academy", "Staff", "Beta Testers"];
  const typo = s => s.replace(/(\w)(\w)(\w)/, "$1$3$2");
  const extra = ["create a VIP category, add announcements and lessons channels, make them private and give access to Instructor", "write an announcement about the live stream tomorrow at 9:30 and keep it short",
    "give the second member from the list the Moderator role", "who has the Academy role", "I said announcements, not general", "send it to the staff channel instead", "remember that I prefer short replies",
    "what is the best time to trade the london session and why does the fractal model fail on thursdays", "ok", "".padEnd(1900, "show me the members and ")];
  const pool = [...base, ...base.map(typo), ...base.map(s => s.toUpperCase()), ...base.map(s => `hey, can you ${s.toLowerCase()} please? thanks`), ...extra];
  const N = quick ? 5000 : 30000, lat = [], byLen = [];
  for (let i = 0; i < 300; i++) classify(pool[i % pool.length], { convo: {}, roleNames, draft: null }); // warm up the JIT
  const convo = { entities: { channels: [], members: [], roles: [], messages: [] }, focus: null, list: null };
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const text = pool[i % pool.length], ctx = { convo, roleNames, draft: i % 3 === 0 ? { id: "d" } : null };
    const t = performance.now(); classify(text, ctx); const d = performance.now() - t; lat.push(d); if (text.length > 1000) byLen.push(d);
  }
  const wall = performance.now() - t0, s = stats(lat);
  row("1 classify", `throughput (${N} msgs)`, `${Math.round(N / (wall / 1000)).toLocaleString()} msg/s`);
  row("1 classify", "p50", ms(s.p50)); row("1 classify", "p95", ms(s.p95), "5 ms", s.p95 > 5); row("1 classify", "p99 / max", `${ms(s.p99)} / ${ms(s.max)}`);
  if (byLen.length) row("1 classify", "1900-char message p95", ms(q(byLen, 0.95)), "5 ms", q(byLen, 0.95) > 5);
  // pathological input for regex backtracking
  const evil = ["a ".repeat(3000), "show me ".repeat(500), "create a channel called " + "x".repeat(5000), "members ".repeat(1000) + "!!!", " ".repeat(8000) + "x"];
  let worst = 0, worstText = ""; for (const e of evil) { const [d] = timeSync(() => classify(e, { convo, roleNames, draft: null })); if (d > worst) { worst = d; worstText = e.slice(0, 24); } }
  row("1 classify", "worst adversarial input", `${ms(worst)} ("${worstText.trim()}...")`, "50 ms", worst > 50);
}

/* ---------- 2. memory retrieval and persistence ---------- */
{
  mem._reset();
  const key = "g1:owner1", c = mem.getConvo(key), TURNS = 1000;
  const types = ["channels", "members", "roles", "messages"];
  const [tBuild] = timeSync(() => {
    for (let i = 0; i < TURNS; i++) mem.addTurn(c, i % 2 ? "assistant" : "user", `turn ${i} ` + "lorem ipsum ".repeat(60));
    for (let i = 0; i < 12 * 40; i++) mem.noteEntity(c, types[i % 4], { id: `e${i}`, name: `entity-${i}`, text: "x".repeat(160) });
    for (let i = 0; i < 12; i++) { const d = mem.newDraft(c, { text: "announcement text ".repeat(30), topic: `topic ${i}` }); for (let v = 0; v < 14; v++) mem.reviseDraft(c, d, "rev ".repeat(120) + v, "shorter"); mem.markDraftSent(c, d, { channelId: "c1", channelName: "general", messageId: `m${i}`, url: "u" }); }
    mem.setList(c, "members", Array.from({ length: 15 }, (_, i) => ({ id: `u${i}`, label: `member ${i}` })));
    mem.setFocus(c, "members", Array.from({ length: 15 }, (_, i) => ({ id: `u${i}`, name: `member ${i}` })), "listed");
    for (let i = 0; i < 500; i++) mem.recordOp({ key: `k${i}`, guild: "g1", user: "owner1", action: "message_send", ok: true, ids: `id${i}` });
    for (let i = 0; i < 400; i++) mem.addCorrection(c, { phrase: `p${i}`, wrong: "w", right: "r", text: "t".repeat(100) });
    for (let i = 0; i < 40; i++) mem.setPref("owner1", `I like style ${i} replies`, `general-${i}`);
  });
  const caps = { turns: c.turns.length, entities: types.map(t => c.entities[t].length).join("/"), drafts: c.drafts.length, versions: c.drafts[0].versions.length, summaryLines: c.summary.split("\n").length, corrections: c.corrections.length, feedback: mem.feedbackRecords().length, ops: mem.recentOps("g1", "owner1", 1e9).length };
  notes.push(`state after ${TURNS} turns / 480 entity notes / 500 ops / 400 corrections: ${JSON.stringify(caps)}`);
  row("2 memory", `build state (${TURNS} turns + ops + feedback)`, ms(tBuild));
  mem.setPending(c, { kind: "fill", field: "name", ask: "What should it be called?" });
  const lat = [], REPS = 3000; let len = 0;
  for (let i = 0; i < 200; i++) mem.contextBlock(c, "owner1", "write an announcement and send it to the channel");
  for (let i = 0; i < REPS; i++) { const [d, out] = timeSync(() => mem.contextBlock(c, "owner1", "write an announcement and send it to the channel")); lat.push(d); len = out.length; }
  const s = stats(lat);
  row("2 memory", "contextBlock p50", ms(s.p50)); row("2 memory", "contextBlock p95", ms(s.p95), "20 ms", s.p95 > 20); row("2 memory", "contextBlock max", ms(s.max), "20 ms", s.max > 20);
  notes.push(`contextBlock output length ${len} chars (cap 2400)`);
  const op = [];
  for (let i = 0; i < 2000; i++) { const [a] = timeSync(() => mem.findOp(`k${i % 500}`, { ok: true })); const [b] = timeSync(() => mem.recentOps("g1", "owner1", 5)); const [d] = timeSync(() => mem.getConvo(key)); op.push(Math.max(a, b, d)); }
  row("2 memory", "findOp/recentOps/getConvo worst p95", ms(q(op, 0.95)), "1 ms", q(op, 0.95) > 1);
  const turnAdd = []; for (let i = 0; i < 2000; i++) { const [d] = timeSync(() => mem.addTurn(c, "user", "hello ".repeat(30))); turnAdd.push(d); }
  row("2 memory", "addTurn p95 (schedules a save)", ms(q(turnAdd, 0.95)));

  /* a large brain.json: load and save */
  const big = { convos: {}, prefs: {}, ops: [], feedback: [] }, USERS = quick ? 150 : 500; // every convo at its caps (24 turns, 12 drafts x 12 versions): the worst case per user
  for (let u = 0; u < USERS; u++) {
    const cv = { topic: "t", summary: "s\n".repeat(14), turns: Array.from({ length: 24 }, (_, i) => ({ role: "user", text: "x".repeat(300), at: Date.now() + i })), entities: {}, list: { kind: "members", items: Array.from({ length: 15 }, (_, i) => ({ id: `u${i}`, label: `m${i}` })), at: 1 }, focus: null, drafts: Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, text: "t".repeat(400), versions: Array.from({ length: 12 }, () => "v".repeat(400)), sent: [], status: "sent" })), currentDraft: null, pending: null, corrections: [], lastIntent: null, lastOp: null, updatedAt: Date.now() };
    for (const t of types) cv.entities[t] = Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, name: `entity ${i}`, text: "z".repeat(160), at: 1 }));
    big.convos[`g1:user${u}`] = cv;
  }
  for (let i = 0; i < 400; i++) big.ops.push({ id: `o${i}`, at: 1, guild: "g1", user: "u", action: "a", ok: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yser-perf-big-")), file = path.join(dir, "brain.json");
  const [tStr, json] = timeSync(() => JSON.stringify(big)); fs.writeFileSync(file, json);
  const prev = process.env.YSER_DATA_DIR; process.env.YSER_DATA_DIR = dir;
  const [tLoad, bigMem] = await timeIt(() => import(`../src/brain/memory.js?big=${Date.now()}`)); process.env.YSER_DATA_DIR = prev;
  const [tFlush] = timeSync(() => bigMem.flush());
  row("2 memory", `brain.json ${mb(json.length)} MB (${USERS} convos): JSON.stringify`, ms(tStr), "50 ms", tStr > 50);
  row("2 memory", `brain.json ${mb(json.length)} MB: load at startup (read+parse)`, ms(tLoad));
  row("2 memory", `brain.json ${mb(json.length)} MB: flush() (blocks the event loop)`, ms(tFlush), "50 ms", tFlush > 50);
  fs.rmSync(dir, { recursive: true, force: true });
  mem.flush(); gc(); // so a major GC of the synthetic 80 MB object does not land inside a later timing
}

/* ---------- 3. concurrency ---------- */
{ gc();
  const N = 50, ownerSay = (w, text) => w.say(text);
  const corrupt = key => { const probs = []; const c = mem.getConvo(key); if (c.turns.length > 24) probs.push(`turns ${c.turns.length}>24`); if (c.drafts.length > 12) probs.push("drafts>12"); try { JSON.parse(JSON.stringify(c)); } catch { probs.push("not serializable"); } return probs; };

  /* same user: 50 x "send it here" with one approved draft in hand */
  mem._reset(); router.setProviders(fakeProviders().providers);
  let w = freshWorld();
  await brain.handle(ownerSay(w, "Write an announcement about the live stream tomorrow."), "Write an announcement about the live stream tomorrow.", config); w.reset();
  const [tSend, outs] = await timeIt(() => Promise.all(Array.from({ length: N }, () => brain.handle(ownerSay(w, "send it here"), "send it here", config))));
  const sends = w.mutations.filter(m => m.startsWith("message_send")).length, attempts = mem.recentOps("g1", "owner1", 1000).filter(o => o.action === "message_send").length;
  const dangling = mem.recentOps("g1", "owner1", 1000).filter(o => o.ok === null).length;
  const replies = outs.map(o => (o.say ?? o.posts?.map(p => p.content ?? "").join("") ?? "")).filter(Boolean);
  const dupSaid = replies.filter(r => /already posted/.test(r)).length;
  row("3 concurrent", `same user, ${N}x "send it here": message_send mutations`, `${sends} (expected 1)`, "1", sends !== 1);
  row("3 concurrent", "  send attempts reaching the tool (ops recorded)", `${attempts} (expected 1)`, "1", attempts !== 1);
  row("3 concurrent", "  replies saying 'already posted' / sends confirmed", `${dupSaid} / ${outs.filter(o => o.ok && o.posts?.length && !/already posted/.test(replies.join(""))).length}`);
  row("3 concurrent", "  wall time for the burst", ms(tSend)); row("3 concurrent", "  ops left unresolved (ok=null)", String(dangling), "0", dangling > 0);
  const probs = corrupt("g1:owner1"); row("3 concurrent", "  state corruption", probs.length ? probs.join(", ") : "none", "none", probs.length > 0);

  /* same user: 50 x create the same channel / role */
  for (const [label, text, kind, expect] of [["create a channel called alerts", "create a channel called alerts", "channel_create", 1], ["create a VIP role", "create a VIP role", "role_create", 1]]) {
    mem._reset(); w = freshWorld(); w.sendMode = "ok";
    await Promise.all(Array.from({ length: N }, () => brain.handle(ownerSay(w, text), text, config)));
    const n = w.mutations.filter(m => m.startsWith(kind)).length;
    row("3 concurrent", `same user, ${N}x "${label}": ${kind} mutations`, `${n} (expected ${expect})`, String(expect), n !== expect);
  }

  /* same user: ordering of turns for 50 numbered messages */
  mem._reset(); w = freshWorld();
  const texts = Array.from({ length: N }, (_, i) => `remember that I like ordering test number ${i} style replies`);
  await Promise.all(texts.map(t => brain.handle(ownerSay(w, t), t, config)));
  const cv = mem.getConvo("g1:owner1"), roles = cv.turns.map(t => t.role[0]).join("");
  // older turns are folded into cv.summary in the order they were added, so ascending numbers there prove arrival order was kept
  const userOrder = [...cv.summary.matchAll(/number (\d+)/g)].map(m => Number(m[1])).concat(cv.turns.filter(t => t.role === "user").map(t => Number(/number (\d+)/.exec(t.text)?.[1])));
  const inOrder = userOrder.length > 1 && userOrder.every((v, i) => i === 0 || v > userOrder[i - 1]);
  const prefs = mem.prefsOf("owner1").length;
  row("3 concurrent", "same user ordering: user turns recorded in arrival order", String(inOrder), "true", !inOrder);
  row("3 concurrent", "  assistant reply sits next to its question", /^(ua)+$/.test(roles) ? "yes" : `no, turns end ${roles.slice(-16)} (all questions first, replies later)`, "yes", !/^(ua)+$/.test(roles));
  notes.push(`ordering burst: ${prefs} prefs kept (cap 30), ${cv.turns.length} turns kept (cap 24 then folds to 12).`);

  /* different users: 50 users, each writes then sends */
  mem._reset(); w = freshWorld();
  const ids = Array.from({ length: N }, (_, i) => `user${i}`);
  await Promise.all(ids.map(id => brain.handle(author(ownerSay(w, "Write an announcement about the live stream."), id), "Write an announcement about the live stream.", config))); w.reset();
  const [tDiff, outs2] = await timeIt(() => Promise.all(ids.map(id => brain.handle(author(ownerSay(w, "send it here"), id), "send it here", config))));
  const sends2 = w.mutations.filter(m => m.startsWith("message_send")).length, bad2 = ids.flatMap(id => corrupt(`g1:${id}`));
  const crossed = ids.filter(id => (mem.getConvo(`g1:${id}`).drafts[0]?.sent.length ?? 0) !== 1).length;
  row("3 concurrent", `${N} different users, 1 send each: message_send mutations`, `${sends2} (expected ${N})`, String(N), sends2 !== N);
  row("3 concurrent", "  users whose draft records exactly 1 send", `${N - crossed}/${N}`, `${N}/${N}`, crossed > 0);
  row("3 concurrent", "  wall time / state corruption", `${ms(tDiff)} / ${bad2.length ? bad2.join(",") : "none"}`, "none", bad2.length > 0);
  row("3 concurrent", "  all replies handled", `${outs2.filter(o => o.handled).length}/${N}`, `${N}/${N}`, outs2.some(o => !o.handled));
}

/* ---------- 4. large member lists ---------- */
{ gc();
  const sizes = quick ? [5000] : [5000, 20000];
  for (const n of sizes) {
    mem._reset(); router.setProviders(fakeProviders().providers);
    const people = Array.from({ length: n }, (_, i) => [`m${i}`, `Member ${String(n - i).padStart(6, "0")}`, i % 50 === 0 ? ["Moderator"] : [], i % 97 === 0]);
    const before = heap();
    const w = freshWorld({ people, memberCount: n + 10, extraRoles: [["Moderator", 5]] });
    const afterBuild = heap();
    const { fetchMembers } = await import("../src/brain/tools.js");
    w.listCalls = 0; const [tFetch, got] = await timeIt(() => fetchMembers(w.guild));
    const pages = w.listCalls;
    const [tHandle, out] = await timeIt(() => brain.handle(w.say("show me all the members"), "show me all the members", config));
    const afterOne = heap();
    const [tRole] = await timeIt(() => brain.handle(w.say("show me the moderators"), "show me the moderators", config));
    const [tSearch] = await timeIt(() => brain.handle(w.say("find member 00100"), "find member 00100", config));
    for (let i = 0; i < 4; i++) await brain.handle(w.say("show me all the members"), "show me all the members", config);
    const afterMany = heap();
    const lim = out.posts?.map(p => JSON.stringify(p)).join("").match(/Discord returned[^"\\]*|stopped after \d+ members/)?.[0] ?? "";
    row("4 members", `${n}: fetchMembers (${pages} pages, got ${got.members.length})`, ms(tFetch), "200 ms", tFetch > 200);
    row("4 members", `${n}: handle "show me all the members"`, ms(tHandle), "200 ms", tHandle > 200);
    row("4 members", `${n}: handle role filter / name search`, `${ms(tRole)} / ${ms(tSearch)}`, "200 ms", Math.max(tRole, tSearch) > 200);
    row("4 members", `${n}: heap, stand-in world / +1 list / +5 lists retained`, `${mb(afterBuild - before)} / +${mb(afterOne - afterBuild)} / +${mb(afterMany - afterBuild)} MB`, "snapshots <= +5 MB", afterMany - afterBuild > 5 * 1048576);
    if (lim) notes.push(`${n} members: the reply says "${lim}"`);
    if (got.members.length < n) notes.push(`${n} members: only ${got.members.length} returned (fetchMembers max=10000 default)`);
  }
}

/* ---------- 5. provider fallback ---------- */
{ gc();
  const sleep = t => new Promise(r => setTimeout(r, t));
  const slowFp = (name, delay, mode) => ({ enabled: () => true, call: async () => { await sleep(delay); if (mode === "fail") throw new Error("status 503"); return { text: `ðŸ“£ **${name}**\nJoin us.`, model: name }; } });
  const run = async (label, providers) => { router.setProviders(providers); mem._reset(); const t = performance.now(); let res; try { res = await router.complete({ task: "write", system: "s", messages: [{ role: "user", content: "Topic: x" }] }); } catch (e) { res = { error: e.code }; } return [performance.now() - t, res, label]; };
  const fp = fakeProviders({ failFirst: ["gemini"] }).providers;
  let [t, r] = await run("first fails once", fp); row("5 fallback", "first provider fails once (retry)", `${ms(t)} -> ${r.provider}`, "2 s", t > 2000);
  [t, r] = await run("first dead", fakeProviders({ failFirst: ["gemini*"] }).providers); row("5 fallback", "first provider always fails (instant 503)", `${ms(t)} -> ${r.provider}`, "2 s", t > 2000);
  [t, r] = await run("first slow", { gemini: slowFp("gemini", 1500, "ok"), groq: slowFp("groq", 10, "ok"), nvidia: slowFp("nvidia", 10, "ok") }); row("5 fallback", "first provider slow (1.5 s, succeeds)", `${ms(t)} -> ${r.provider}`);
  [t, r] = await run("slow then fail", { gemini: slowFp("gemini", 1500, "fail"), groq: slowFp("groq", 10, "ok"), nvidia: slowFp("nvidia", 10, "ok") }); row("5 fallback", "first slow 1.5 s then fails (x2 attempts)", `${ms(t)} -> ${r.provider}`, "2 s", t > 2000);
  const dead = { gemini: slowFp("gemini", 0, "fail"), groq: slowFp("groq", 0, "fail"), nvidia: slowFp("nvidia", 0, "fail") };
  [t, r] = await run("all fail", dead); row("5 fallback", "all 3 providers fail (instant errors)", `${ms(t)} -> ${r.error}`, "2 s", t > 2000);
  const [t2] = await timeIt(async () => { try { await router.complete({ task: "write", system: "s", messages: [{ role: "user", content: "x" }] }); } catch { /* expected */ } });
  row("5 fallback", "all fail again while cooling (second call)", ms(t2), "2 s", t2 > 2000);
  const [t3, r3] = await run("all slow-fail", { gemini: slowFp("gemini", 600, "fail"), groq: slowFp("groq", 600, "fail"), nvidia: slowFp("nvidia", 600, "fail") }); row("5 fallback", "all 3 fail after 600 ms each", `${ms(t3)} -> ${r3.error}`, "5 s", t3 > 5000);
  const w = freshWorld(); mem._reset(); router.setProviders(dead);
  const [tH, oH] = await timeIt(() => brain.handle(w.say("Write an announcement about the live stream."), "Write an announcement about the live stream.", config));
  row("5 fallback", "handle(draft.write) when every provider fails", `${ms(tH)} (${/couldn't reach/.test(oH.say ?? "") ? "clean message" : "unexpected"})`, "2 s", tH > 2000);
  notes.push("real timeouts in src/brain/router.js: 40 s per model (groq 3 models, nvidia 1) / 45 s (gemini 2 models), x2 attempts per provider: a hung gemini can hold a request ~3 min before groq is tried; no concurrency or hedging.");
  router.setProviders(fakeProviders().providers);
}

/* ---------- 6. brain.json growth and flush blocking ---------- */
{ gc();
  mem._reset(); router.setProviders(fakeProviders().providers);
  const OPS = quick ? 3000 : 10000, USERS = 200, w = freshWorld(), file = path.join(DATA, "brain.json"), audit = path.join(DATA, "audit.jsonl");
  const cmds = ["list the roles", "list the channels", "how many members do we have?", "server info", "Who is online?", "remember that I like short replies", "show me all members"];
  const lat = [], checkpoints = []; let maxLag = 0, last = performance.now();
  const lagTimer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - last - 5); last = now; }, 5);
  const startAudit = fs.existsSync(audit) ? fs.statSync(audit).size : 0;
  for (let i = 0; i < OPS; i++) {
    const text = cmds[i % cmds.length], user = `user${i % USERS}`;
    const [d] = await timeIt(() => brain.handle(author(w.say(text), user), text, config)); lat.push(d); if (d > (lat.worst ?? 0)) { lat.worst = d; lat.worstText = text; }
    if (i % 5 === 0) await new Promise(r => setImmediate(r));
    if ((i + 1) % (OPS / 4) === 0) { const [fl] = timeSync(() => mem.flush()); checkpoints.push({ ops: i + 1, kb: Math.round(fs.statSync(file).size / 1024), flush: fl }); }
  }
  clearInterval(lagTimer);
  const s = stats(lat), size = fs.statSync(file).size, st = JSON.parse(fs.readFileSync(file, "utf8"));
  const [tStr, json] = timeSync(() => JSON.stringify(st)); const [tW] = timeSync(() => fs.writeFileSync(file, json));
  row("6 growth", `${OPS} deterministic ops over ${USERS} users: handle p50 / p95`, `${ms(s.p50)} / ${ms(s.p95)}`, "200 ms", s.p95 > 200);
  row("6 growth", "  handle max (slowest command)", `${ms(s.max)} ("${lat.worstText}")`, "200 ms", s.max > 200);
  row("6 growth", "  brain.json size", `${Math.round(size / 1024)} KB (${Object.keys(st.convos).length} convos, ${st.ops.length} ops)`);
  row("6 growth", "  checkpoints (ops: KB, flush ms)", checkpoints.map(c => `${c.ops}: ${c.kb}KB ${ms(c.flush)}`).join(" | "));
  row("6 growth", "  flush = stringify + writeFileSync (sync)", `${ms(tStr)} + ${ms(tW)}`, "50 ms", tStr + tW > 50);
  row("6 growth", "  max event-loop stall seen during the run", ms(maxLag), "50 ms", maxLag > 50);
  const aSize = fs.existsSync(audit) ? fs.statSync(audit).size - startAudit : 0;
  row("6 growth", "  audit.jsonl growth (appendFileSync per op, no rotation)", `${Math.round(aSize / 1024)} KB for ${OPS} ops (~${Math.round(aSize / OPS)} B/op)`, "<= 1 MB", aSize > 1048576);
  // an idle convo is never dropped from disk until it is read again
  const stale = Object.keys(st.convos).length;
  notes.push(`convos kept in memory/disk: ${stale}; src/brain/memory.js never evicts a convo whose TTL (7d) has passed unless that user talks again.`);
  notes.push(`console lines the app emitted during the run (suppressed): ${logged}`);
  mem.flush();
}

/* ---------- report ---------- */
console.log = realLog;
const W = Math.min(150, Math.max(90, process.stdout.columns || 120)), w1 = 14, w2 = 62;
console.log(`\nAssistant performance${quick ? " (quick)" : ""}\n` + "=".repeat(W));
let sec = "";
for (const r of rows) {
  const over = flags.some(f => f.startsWith(`${r.section} ${r.metric}:`));
  console.log(`${r.section === sec ? "".padEnd(w1) : r.section.padEnd(w1)} ${r.metric.padEnd(w2)} ${String(r.value)}${over ? "   <== OVER" : ""}`); sec = r.section;
}
console.log("=".repeat(W));
if (notes.length) { console.log("Notes"); for (const n of notes) console.log(" - " + n); }
console.log(flags.length ? `\n${flags.length} item(s) over budget:` : "\nEverything is within budget.");
for (const f of flags) console.log(" ! " + f);
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* temp dir */ }
process.exit(strict && flags.length ? 1 : 0);

