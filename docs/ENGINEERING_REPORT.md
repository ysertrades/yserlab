# Intelligence upgrade: engineering report

Method: five temporary specialist agents (architecture and memory audit, security attacks, educational-answer audit, scenario dataset, performance) worked independently, then their findings were fixed in a single integration pass. The agents had no persistent identity; their reports are in `docs/audit/` and their test assets in `tests/security.test.js`, `eval/scenarios.js`, `eval/run-scenarios.js`, `eval/perf.js`.

## 1. Architecture (verified from source, details in `docs/audit/architecture.md`)

* App message: `AssistantChat.tsx` → Supabase Edge Function `assistant` (JWT + feature check) → thread, history, memories, model route with fallback, tools.
* Discord message: `index.js` → gates → `brain.handle` (owner/admin, in a server) → otherwise `askUnified` (the same function, service key + `discord_links`) → fallback `ai.js`.
* Shared today: threads, messages, memories, journal, trading model, education index. Not shared: the brain's preferences and drafts (`data/brain.json`).

## 2. Weaknesses found and what was done

| Finding | Status |
| --- | --- |
| Non-owner admins answered from the owner's journal and model (fallback path) | Fixed (`assistant.js`) |
| Model-chosen risky actions passed `guard()` with no relation to the owner's words | Fixed: needs words in the owner's message; `ai_control` changes refused from a model |
| `guard` allowed any tool for intents without a tool list; `constructor`/`__proto__` counted as actions | Fixed (default deny, `Object.hasOwn`) |
| Permission checks passed when a message had no member | Fixed: fail closed, scheduled jobs flagged explicitly |
| Legacy moderation actions had no Discord-permission check | Fixed (`mod.js`) |
| Model/someone's `@everyone`, `@here`, user mentions pinged for real | Fixed: only when the owner's own message asks |
| "remember" stored secrets in many forms and authority/permission claims | Fixed (normalisation, wider patterns, authority filter, never replayed as turns) |
| Display names / channel text could carry instructions into the model's context | Fixed: sanitised, labelled untrusted data |
| Fuzzy role match could hand out a different, more powerful role | Fixed: exact name required |
| Requester who cannot see a channel could make the bot post there | Fixed |
| Classifier slow on long input; duplicate-send race; 3-minute provider stall | Fixed |
| Education answers told to name lessons/PDFs; headers and diagram footers leaked sources | Fixed in the bot; prompt text fixed in the app's function (not deployed) |
| Two memory systems; brain actions not in the app thread; weak secret filter and 2.5k tool cap in the function | Not fixed (need the function change and migration below) |

## 3. Evaluation (245 scenarios, `npm run eval:scenarios`)

| Metric | Baseline | Now |
| --- | --- | --- |
| Scenarios fully correct | 64.5% | 97.1% |
| Intent accuracy | 73.8% | 99.6% |
| Tool-selection accuracy | 80.4% | 98.8% |
| Correct-argument rate | 64.4% | 96.2% |
| Reference-resolution accuracy | 50.0% | 96.6% |
| Missing-clarification rate | 37.0% | 0.0% |
| Unnecessary-clarification rate | 1.4% | 0.0% |
| Confirmation correctness | 92.9% | 100% |
| Verified-execution rate | 60.2% | 98.1% |
| Unintended-mutation rate | 1.2% | 0.0% |
| Average latency per turn | 1-2 ms | 0.8 ms (p95 1.6 ms) |

Other suites: `npm test` 181 passing (existing 55, brain 43, security 78, education 5); `npm run eval` all bars met; security tests 100% passing (incl. cross-user isolation and permission enforcement in the tested cases).

Honest limits of these numbers:
* The scenarios were written by an agent that read the code, and the same rules were then tuned against them: they measure regression and coverage, not generalisation to phrasing nobody wrote down.
* The runner was changed once: for a message with several operations, the expected tool/intent now counts when it is among those executed (the first-clause convention in the dataset).
* Seven scenarios still fail: a typo'd channel name is passed on unchanged (the send still works); "put those there" (move channels) is not implemented; a rename scenario and a memory-format scenario expect a different state; "no, I meant channels" expects a channel name the list prints as a mention; one expectation about "no operation" contradicts the scenario's own text. They are left as written.
* Everything runs against stand-ins. No test touched the live Discord API or a real model, so model-dependent behaviour (draft quality, how the model follows the new educational wording, provider quality comparison) is **unmeasured**. No provider benchmarking was done; the router uses a fixed preference order per job.

Performance (stand-in): classification p95 0.15 ms; context retrieval ~0.01 ms; deterministic handle p95 < 1 ms; 20 000-member list 14 ms. Still over budget: writing a very large `brain.json` is synchronous (52 ms at 150 conversations at their caps), and a concurrent-ordering probe in `eval:perf` still reports unordered turns (per-user serial handling was added; not re-verified against that probe).

## 4. Implemented improvements (files)

`src/brain/*` (classifier with multi-instruction handling, memory, resolver, registry, router with deadline, handlers, new tools), `src/admin/guard.js`, `src/admin/tools.js`, `src/mod.js`, `src/assistant.js`, `src/ai.js`, `src/knowledge.js`, `src/index.js`, `src/diagram.js`, `src/pdfDrawings.js`; tests and eval under `tests/`, `eval/`; audits under `docs/audit/`.
App repo (uncommitted): `supabase/functions/assistant/index.ts` (educational wording only), `supabase/shared-memory.sql` (not applied).

## 5. Database changes

None applied. `charts/supabase/shared-memory.sql` is the proposed, additive migration (extra columns on `assistant_memories`, `assistant_drafts` and versions, `discord_link_codes`, `assistant_audit`, owner-only RLS). Review before running; wiring the bot and the function to use it is not done.

## 6. Deployment

1. Bot: push `yserlab` main, then Restart in the bot-hosting panel (deployment 1b9f737b-021f-465f-9d57-d246acd64514). Enable the Server Members Intent for the member list; set `NVIDIA_API_KEY` to use NIM.
2. Education wording in the app: deploy the `assistant` function only after reviewing the diff (it has not been type-checked or run).
3. `npm test` and `npm run eval:scenarios` should be green before any deploy.

## 7. Rollback

Bot: `git revert` the commit and restart. App function: redeploy the previous version from git. `data/brain.json` can be deleted safely (it only holds conversation state and preferences).

## 8. Remaining limitations

Shared Discord/app memory; the app side of security findings (function-side secret filter, thread selection); channel moving; no live-API or real-model validation; no fine-tuning (nothing here trains a model: improvements are architecture, deterministic rules, context, tests).
