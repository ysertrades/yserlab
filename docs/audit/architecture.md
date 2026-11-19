# Architecture and memory audit: YSER Lab bot + in-app assistant

Read-only audit, 2026-11-19. Everything below was read from source. Paths: `B:` = `yserlab/` (bot), `F:` = `charts/supabase/functions/assistant/index.ts` (the Edge Function, shortened `fn`), `A:` = `charts/` (app). Anything I could not verify from the code is marked UNVERIFIED.

## 1. How a message reaches a model

### 1a. App message (in-app Chat tab)
1. `A:src/journal/AssistantChat.tsx:113-118` adds the user turn locally and calls `chat()`.
2. `A:src/journal/assistant.ts:16,28` -> `supabase.functions.invoke("assistant", { task:"chat", message, thread_id?, new_thread? })` with the user's JWT.
3. `fn:845-854` `Deno.serve` -> `whoIs()` `fn:192-209`: the Bearer token is not the service key, so it validates the JWT (`sb.auth.getUser`, `fn:204`), checks `has_feature('ai')` (`fn:206`), returns `{uid, via:"app", token}`. `source = "app"` (`fn:852`).
4. `chat()` `fn:740-842`:
   - `userDb(uid)` `fn:745`; `pruneOld()` (90 d) `fn:747`;
   - `currentThread()` `fn:699-705`: given id, else the latest thread of ANY source updated in the last 36 h, else a new one;
   - pending yes/no shortcut `fn:751-758`;
   - history = last 24 messages `fn:764`; memories chosen by keyword overlap `fn:689-697,766`;
   - live data: regex-triggered news wire / calendar / White House `fn:780-782`; web search through Gemini when `needsFresh` `fn:783-786`;
   - route: `vision` if images, `reason` if `looksHard`, else `chat` (`fn:771`); candidates = models whose provider key exists (`fn:56-68`);
   - loop of up to 5 steps (`fn:790`): `generate()` `fn:160-174` builds a request sized to each model's budget (`fn:791-809`), tries each candidate in order, falls through on any error; tool calls run via `TOOLS[name].run(ctx,args)` `fn:821-824`; tool output is capped `fn:833,807`.
   - answer saved as two `assistant_messages` rows + `patchThread` `fn:837-839`, then `compact()` fire-and-forget `fn:840`.

### 1b. Discord message
1. `B:src/index.js:102` MessageCreate. Filters: bots/webhooks/self `:105`; waiting-yes/no `:106`; `settings()` (bot_config, 10 s cache) `:107`; automod `:109`; must be tagged or in an AI channel `:110-113`; image+tag -> card flow `:115-119`; `mayUseAi` `:121`; owner account must be known `:127`; embed handler (admins, guild) `:128`.
2. Intelligence layer, only for admins in a guild `:132-141`: `brain.handle()` (`B:src/brain/index.js:383-400`) classifies, may answer deterministically and RETURN (`index.js:134-139`, no model, no function call). If not handled it returns `context` (`mem.contextBlock`).
3. `intentOf()` quick admin intent `:142`; otherwise `askUnified(...)` `:144` with `context = channelContext(message) + brainContext`.
4. `B:src/assistant.js:23-47`: POST `${SUPABASE_URL}/functions/v1/assistant` with `Authorization: Bearer <service key>`, body `{task:"chat", discord_id, message, channel, client_tools, context}`, 65 s timeout (`:26-31`).
5. Function: `whoIs` `fn:195-200` sees the service key (`isServiceToken` `fn:181-190`), validates `discord_id` format, looks it up in `discord_links`, `via:"bot"`, `source="discord"`. Same `chat()` as 1a, differences: bot's `client_tools` are accepted only for Discord (`fn:760`), `body.context` (max 4000 chars) is injected as "latest messages in this channel" (`fn:770,800`), and when the model picks a client tool the function stores a placeholder pair and returns `client_call` (`fn:814-820`) instead of an answer.
6. Back in the bot: `client_call` -> `called()` mapping (`assistant.js:35`) -> `index.js:145-177` executes (diagram, mod, send, card, schedule); `noteResult()` posts a note to the function `index.js:158,175` -> `fn:862-866`.
7. Fallback: if the function errors / is down / has no answer, `assistant.js:46` -> `ai.js:234 ask()` (separate prompt, Groq then Gemini, no tools run server-side, owner's journal read directly via `store.js:54`).

## 2. Providers and models actually integrated

| Where | Provider | Model ids in code | Source |
|---|---|---|---|
| fn (chat route) | Groq | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` | `fn:33-35,43` |
| fn | Gemini | `env GEMINI_MODEL` or `gemini-flash-lite-latest`, `gemini-flash-latest` | `fn:36-37` |
| fn | NVIDIA NIM | `env NVIDIA_MODEL` or `nvidia/nemotron-3.5-super-vl-120b-a12b` (no native tools: JSON-in-prompt protocol `fn:123-125,148-151`) | `fn:39` |
| fn web_search | Gemini `google_search` (flash-latest, flash-lite-latest), then Groq `groq/compound-mini`, `groq/compound`, then Google News RSS | `fn:613-652` |
| fn `ai` function (app, not the assistant) | Gemini (`GEMINI_MODEL`, flash-lite-latest, flash-latest, 2.5-flash-lite; careful: flash-latest first) + NVIDIA (`nemotron-3.5-super-vl-120b-a12b`) + Gemini File API for PDFs | `A:supabase/functions/ai/index.ts:276-279,352-353,399-423` |
| Bot `ai.js` (fallback) | Groq `env GROQ_MODEL`, gpt-oss-120b/20b, qwen3.8-27b; Gemini `env GEMINI_MODEL` (default flash-lite-latest), flash-lite-latest, flash-latest, `gemini-3.5-flash`; search via Gemini | `B:src/ai.js:83-84,220-232`. NO NVIDIA in ai.js. |
| Bot `brain/router.js` | Groq (`GROQ_MODEL`, gpt-oss-120b/20b), Gemini (`GEMINI_MODEL`, flash-latest), NVIDIA `env NVIDIA_MODEL` default **`meta/llama-3.3-70b-instruct`** | `B:src/brain/router.js:27-47`, `B:src/env.js:14-19`. Used only for writing/revising drafts (`B:src/brain/index.js:36,42`). |

Routes in fn (`fn:41-50`): chat = groq120b, gemini-lite, gemini-flash, groq20b, qwen, nvidia; reason = gemini-flash first; vision = gemini, nvidia; fast = groq20b first. Overridable via `ASSISTANT_ROUTES` secret (`fn:52-54`). The `status` task (`fn:877`) reports which keys/routes are live.

Observations (not guesses): the NVIDIA model differs between bot (llama-3.3-70b) and function (nemotron); `qwen/qwen3.8-27b`, `nemotron-3.5-super-vl-120b-a12b`, `gemini-3.5-flash` ids cannot be checked offline (UNVERIFIED that they exist on the providers; a wrong id just becomes a silent fallthrough entry in `attempts`, `fn:170`). `ASSISTANT.md:25` says Groq key "not set yet"; I cannot tell the current state without calling `status`.

## 3. Where conversation, memory, drafts and preferences live

### Supabase (project aubplblrooadtfskdcfh), created by `A:supabase/assistant.sql`
| Table / bucket | Content | Writer | Reader |
|---|---|---|---|
| `assistant_threads` (`assistant.sql:9-17`) | id, user_id, title, rolling summary, source app/discord | fn only (service key); RLS also lets owner write | fn, app (via fn tasks) |
| `assistant_messages` (`:20-29`) | turns, `source`, `meta` jsonb; old turns deleted after fold into summary (`fn:708-719`), 90-day prune (`fn:249`) | fn | fn |
| `assistant_memories` (`:33-40`) | kind preference/fact/context, text<=600, `source` (free text), last_used_at | fn tool `save_memory` (`fn:582-597`) | fn `memoriesFor` (`fn:689`), app "What I remember" |
| `assistant_pending` (`:44-52`) | one pending journal edit, 10 min TTL | fn | fn |
| `discord_links` (`:56-61`) | discord_id -> user_id, unique(user_id) | bot (`assistant.js:82`) | fn `whoIs` |
| bucket `knowledge` (private) (`:83`) | `ttrades/kb.json` (5.8 MB), `ttrades/kb.hash`, `owner/smt.txt` | bot `publishKnowledge` (`assistant.js:88-104`, runs once at boot `index.js:56`) | fn `kb()` `fn:322`, `get_owner_rules` `fn:547` |
| bucket `charts` | `<uid>/models/<pdfid>.pdf`, `<pdfid>.json`, combined `<uid>/models/model.json` | app (`A:src/journal/aiModel.ts:100,195`) | fn `userDb.model` `fn:254`; bot `store.js:81-87` |
| `preferences` (`A:supabase/preferences.sql`) | one row per user: slides editor colours | app | app only; the assistant never reads it |
| `entries`, `tags`, `indicators`, `slide_boards` ... | journal data | app, fn (`create/update_journal_entry`) | fn tools, bot `store.js:54-69` |
| `bot_config/status/log/sent/jobs` (`yserlab.sql`) | bot settings, owner_user | app admin, bot | admin RLS only |

### Bot local files (disk of the host; `YSER_DATA_DIR` or `yserlab/data/`)
| File | Content | Source |
|---|---|---|
| `data/brain.json` | convos (topic, 24 turns, summary, entities, lists, **drafts with versions**, pending, corrections), **prefs per Discord user (max 30)**, ops log (idempotency), feedback | `B:src/brain/memory.js:15-23,29,67,106` |
| `data/drafts.json` | embed drafts | `B:src/admin/embeds.js:19-23` |
| `data/jobs.json`, `data/people.json` | scheduled jobs, who-is-who | `B:src/sched.js:12`, `B:src/people.js:9` |
| `data/audit.jsonl`, `warnings.json` | admin audit / warns | `B:src/admin/audit.js:11-12` |
| in-memory `histories` Map | fallback chat history per channel, 8 turns, 30 min | `B:src/ai.js:16-17,238,258-261` |

Whether `data/` survives a restart on bot-hosting.net is UNVERIFIED (code tolerates a read-only disk and silently keeps memory only: `memory.js:23`, `sched.js:15`).

### What is shared app <-> Discord today
Shared (via the function): threads, messages (with `source` tag, search via `search_conversations` `fn:575-581`), long-term `assistant_memories`, journal, model, education center, owner SMT rules, the pending-confirmation flow (a "yes" in Discord applies a change proposed in the app thread, `fn:751`).
NOT shared:
- Brain preferences ("remember that ...", `classify.js:129-133`, stored `brain/index.js:211-216` -> `brain.json` only). They never reach `assistant_memories`, so the app and the model path never see them; the reverse also holds (`styleLines` `brain/index.js:32` reads only brain prefs).
- Brain drafts/announcement versions, embed drafts, brain conversation state: local files only.
- Everything the brain handles deterministically (`index.js:134-139` returns before the function is called, and `noteResult` is not called there) is invisible to the assistant thread: "what did you just do" in the app has no answer.
- `preferences` table (app) is not read by the assistant.
- Fallback answers (`ai.js`) do not write to `assistant_messages` and use their own history Map.

## 4. How PDFs and education knowledge are retrieved and injected

- Education center (course lessons): `B:knowledge/ttrades/kb.json` is built offline by `B:scripts/education/*` (chunks of kinds text, note, glossary, overview, diagram, pdf, video). Bot loads it with BM25 (`B:src/knowledge.js:38-96`); function downloads the published copy and builds an identical BM25 index (`fn:281-333`, copy of the same class and ALIASES `fn:261-268`). Weights `text 1.5 ... pdf .9, video .55` (`fn:328`).
- Injection in the function is tool-driven, not preloaded: the model must call `search_education` (`fn:505-511`, 9000 chars, 3 per lesson) or `get_trading_model` (`fn:512-518`, 9000 chars). `useSources` is computed (`fn:769`) but its branch is empty (`fn:802`), so there is no automatic injection. Result goes back as a tool message capped by `trim(content, cap/3.5)` with `cap = 2500` for budget < 10000 tokens (i.e. every Groq model) else 12000 (`fn:806-807`).
- Owner's PDFs (the trading model): the app uploads PDF to `charts/<uid>/models/` (`aiModel.ts:195`); the `ai` function reads each PDF with Gemini (File API for large ones, `ai/index.ts:399-423`) into concepts/glossary/checklist JSON; the app merges them to `model.json` (`aiModel.ts:280-292`). The assistant indexes concepts, glossary and checklist phases (not the raw PDF text) in a per-user BM25 cache of 60 s (`fn:353-376`); the head (title, summary, concept names) is always included.
- Bot fallback path injects directly into the system prompt: model + education passages + journal summary (`ai.js:198-213`), Groq ~6200/9800 chars scaled, Gemini 40000/36000.
- PDF page drawings (`B:knowledge/model/drawings.json`, `pdfDrawings.js`) are used by the bot's diagram code only (`diagram.js`, `pdfDrawings.js`), never by the function.
- Owner SMT rules: bot publishes `SMT_RULES` text to `owner/smt.txt` (`assistant.js:100`); function exposes it as tool `get_owner_rules` (`fn:547-556`), cached forever once found (`ownerRulesCache`).

## 5. User isolation

- App path: JWT -> `uid` (`fn:202-208`). Bot path: service key + `discord_id` -> `discord_links` row (`fn:195-200`). A Discord id with no row gets 403 (`fn:199`). The bot writes only one row: `env.owners[0]` -> `bot_config.owner_user` (`assistant.js:77-85`, refreshed every 10 min `index.js:57`).
- All data access is `admin` (service role, RLS bypassed) wrapped by `userDb(uid)`, each query hand-filtered `.eq("user_id", uid)` (`fn:215-255`). Isolation therefore rests on every method keeping that filter; there is no RLS backstop on the function path. Spot check: all 30+ methods in `userDb` carry the filter or an id-scoped path (`model()` uses `${uid}/models/`). Tools never receive `admin` through `Ctx` (`fn:379`), though `get_news_wire`, `get_economic_calendar`, `get_white_house_schedule`, `get_owner_rules`, `web_search` use module-level `admin`/globals (non-user data, `fn:523,533,543,551`).
- RLS on memory tables (`assistant.sql:63-80`): `assistant_threads/messages/memories` = `for all to authenticated using/with check (user_id = auth.uid())`; `assistant_pending` and `discord_links` = select only for owner. No `has_feature('ai')` gate on these tables (compare `access.sql:92`, which gates entries etc.); the gate is only in the function (`fn:206`) and is skipped for the bot path.
- `assistant.sql:7-8` claims "the tests check that another user's id never sees these rows". I found no such test in either repo (searched yserlab/tests, charts scripts/tools, glob for assistant/userDb/discord_links in test files). UNVERIFIED.
- Storage: `charts` bucket policy is folder = auth.uid (`schema.sql:131-134`); `knowledge` bucket has no authenticated policy (service only) - good.

## 6. Weaknesses

Ranked by value. Each: implementation / problem / cause / fix / files / risk / tests.

**W1. Non-owner admins fall back to the OWNER's data (isolation leak).**
- Impl: `mayUseAi` allows admins when `config.ai.access === "admins"` (`access.js:6`). `index.js:144` calls `askUnified({owner, discordId: message.author.id})`. For a non-owner, `discord_links` has no row, the function returns 403 (`fn:199`), `askUnified` logs and falls to `ask({owner,...})` (`assistant.js:38-46`), which reads the owner's journal and model (`ai.js:237`, `store.js:54,81`).
- Problem: an admin who is not the owner gets answers built from the owner's trades/model. `ASSISTANT.md:73` states "Only the owner can use Discord", which the code does not enforce in this path.
- Root cause: fallback keyed on `owner` (account) not on the caller; 403 treated like an outage.
- Fix: in `askUnified`, if status is 401/403/404 do not fall back with owner data; fall back only on network errors/5xx/timeouts, and for non-owners call `ask` with no journal/model (or refuse). Return `via` so replies can say "(offline mode)".
- Files: `B:src/assistant.js`, `B:src/ai.js` (context), `B:src/index.js:144`.
- Risk: low code risk; behaviour change for admins. Tests: unit test `askUnified` with a 403 and a non-owner id asserts `ask` is not called with owner; test with a 503 asserts fallback still works.

**W2. Two unconnected memory systems.**
- Impl: brain prefs/drafts in `brain.json` (`memory.js:106`), assistant memories in Postgres (`fn:582`). "Remember that..." from an admin in a guild is eaten by the brain (`classify.js:129`, `OWNED` `classify.js:268`) and never reaches Supabase; `memory.show` lists only brain prefs.
- Problem: a preference stated in Discord is invisible to the app, to the model path, and is lost if the bot disk is ephemeral (UNVERIFIED); and asking "what do you remember" in the app omits it. Duplicate/contradictory memory is possible.
- Root cause: INTELLIGENCE.md "Not covered yet" first bullet (`INTELLIGENCE.md:53`).
- Fix: section 7 (shared store); brain `setPref/prefsOf/forgetPref` become a thin client of `assistant_memories` with a local cache and offline queue.
- Files: `B:src/brain/memory.js`, `B:src/brain/index.js:32,211-216`, `fn` tasks, `A:src/journal/AssistantChat.tsx`.
- Risk: medium (touches the working brain tests, async API). Tests: extend `tests/brain.test.js` with an injected remote store; contract test for dedupe/secret filter parity.

**W3. Deterministic brain actions are invisible to the assistant thread.**
- Impl: `index.js:134-139` returns after `brain.handle`; only the model path calls `noteResult` (`:158,175`). `noteResult` also silently drops the note if no thread exists within 36 h (`fn:863-864`).
- Problem: follow-ups in the app or in a model-handled Discord turn ("send it again", "what did you just do") lack that context.
- Root cause: two code paths with separate state.
- Fix: call `noteResult` (as a `kind:"action"` note) after brain results; make `note` create a thread when none exists.
- Files: `B:src/index.js`, `fn:862-866`. Risk: low. Tests: brain-handled turn produces one `assistant_messages` row with `meta.note`.

**W4. Education retrieval is truncated on the first-choice models.**
- Impl: `search_education` returns up to 9000 chars (`fn:508`) but tool results are cut to `cap/3.5` tokens x 3.5 = 2500 chars when `s.budget < 10000` (`fn:806-807`), and Groq models (budget 6000) are first in `chat` (`fn:43`). The cut is applied to the JSON string `{"lessons":[...],"passages":"..."}`.
- Problem: ~72 % of retrieved passages are dropped for the default model; the cut may land mid-JSON/mid-passage.
- Root cause: one retrieval size for all models; trimming after retrieval instead of sizing retrieval.
- Fix: pass the model budget into the tool (`ctx.room`) so `recall(query, chars)` returns what fits (about 2200 for Groq, 9000 Gemini); return plain text, not JSON-wrapped; keep lessons list first.
- Files: `fn:335,505-518,791-809`. Risk: low-medium. Tests: tool-result size per budget; golden question "how do I trade candle 3" returns the matching lesson title inside the cap.

**W5. Model tool list/system prompt is large for Groq's 6000-token budget.**
- Impl: `room = budget - tokens(SYSTEM) - tokens(all tool decls) - message - turn - 900` (`fn:795`) with ~24 tool declarations plus client tools (13+ in Discord, `assistant.js:20`) sent every step (`fn:762,808`).
- Problem: ESTIMATED (not measured): fixed prompt consumes most of 6000 tokens in Discord, leaving little room for history, memories, channel context; `room` can go negative, silently dropping history (`fn:805`) with no signal.
- Root cause: static all-tools declaration; budget values are constants (`fn:33-35`) not read from limits.
- Fix: measure with a debug field (`fixed_tokens`) in the response; select tools per request (only education/model tools when `asksTrading`, only client tools when the message looks like an action); log when `room < 500`.
- Files: `fn:762,795`. Risk: medium (tool choice errors). Tests: token-count snapshot test per route; eval set of 20 Discord messages for tool pick accuracy.

**W6. Secret filter weaker in the function than in the bot.**
- Impl: bot `SECRET` regex also blocks any 32+ char token and card/ssn words (`memory.js:104`); function blocks only keywords/prefixes (`fn:587`).
- Problem: a pasted API key without the word "key" is stored in `assistant_memories` and later injected into prompts and listed in the app.
- Fix: one shared filter (copy the bot regex into the function, plus a server-side check in the `memory` insert path; optionally a DB `check`).
- Files: `fn:587`, `assistant.sql:36`. Risk: low. Tests: table of secret-like strings (JWT, `gsk_`, `nvapi-`, 40-hex, card numbers) rejected; normal sentences accepted.

**W7. Thread selection is time-based and source-blind.**
- Impl: latest thread of any source within 36 h (`fn:701,863`). `ASSISTANT.md:65` says 12 hours (doc drift).
- Problem: a Discord question lands in whatever app thread was last used (unrelated topic, wrong summary); `compact` and `pending` bind to it; two concurrent Discord messages can create two threads (no lock).
- Root cause: no thread per channel/surface; selection not transactional.
- Fix: keep one rolling thread per (user, surface/channel) for Discord (`channel_id` column) while app threads stay explicit; `search_conversations` already crosses threads. Fix doc.
- Files: `fn:699-705`, `assistant.sql`, `ASSISTANT.md`. Risk: medium (behaviour). Tests: Discord message after an app thread keeps separate thread; parallel calls create one thread.

**W8. Casual "ok/no/go/stop" is consumed as a confirmation.**
- Impl: with a pending action (10 min) any message < 40 chars matching YES/NO regex (`fn:721-722,752`) resolves it, before the model sees the message.
- Problem: in an open Discord channel "ok", "no", "stop", "go" intended for something else applies or cancels a journal edit; `YES` also matches "ok thanks".
- Fix: require an explicit phrase or a button/pending id in Discord ("yes apply" / reply to the proposal message), show the summary again on ambiguity.
- Files: `fn:721-758`. Risk: low. Tests: matrix of short replies with and without a pending row.

**W9. Duplicate retrieval code in two repos.**
- Impl: BM25 `Index`, `ALIASES`, `STOP`, `tokens`, `recall` exist in `B:src/knowledge.js:13-96` and `fn:260-349`.
- Problem: drift (already: function `ALIASES` lacks `sibi,bisi,vi,mmxm,ohlc,ict,ndog,nwog,fx`, compare `knowledge.js:20-23` with `fn:262-267`), so the same question can retrieve differently in app and Discord.
- Fix: single source (a shared module copied by a sync script, as done for the slides editor) plus a parity test with fixed queries.
- Files: both. Risk: low. Tests: both indexes return the same top-3 lessons for a 20-question list.

**W10. Function cold start loads a 5.8 MB index per isolate.**
- Impl: `kb()` downloads and parses `kb.json` (5,819,117 bytes) and builds the BM25 in-process (`fn:322-333`), cached per isolate; a miss is retried every 60 s.
- Problem: first request after cold start pays download+parse+index (not measured; UNVERIFIED size of the delay); memory use may approach isolate limits.
- Fix: measure; if slow, pre-tokenize at publish time (upload `index.json` with tf maps) or move to pgvector/`tsvector` retrieval in Postgres; keep `kb.hash` check.
- Files: `fn:322`, `B:src/assistant.js:88`. Risk: medium. Tests: time to first answer after cold start, memory log.

**W11. Knowledge is published only at boot.**
- Impl: `publishKnowledge()` called once (`index.js:56`), unlike `ensureLink` (interval).
- Problem: kb or SMT rule changes after deploy reach the app only after the next restart; failure is only a console warning (`assistant.js:103`).
- Fix: interval hash check (cheap: hash compare) or publish on rebuild. Files: `B:src/index.js:56`. Risk: low. Tests: changing `SMT_RULES` changes the hash and triggers upload.

**W12. No tests found for the function; isolation claim unproven.**
- Impl: `assistant.sql:8` promises tests; none located (see section 5). `userDb`, `statsOf`, `Index`, `candidates` are exported (`fn:215,399,281,56`) so they are testable.
- Fix: Deno tests with a fake client asserting every `userDb` method adds `user_id`; run the SQL with two JWTs against a local/staging DB for the RLS checks.
- Files: new tests only. Risk: none. Tests: that is the task.

**W13. Function-path isolation lacks an RLS backstop.**
- Impl: service role + manual filters (`fn:178,215`).
- Problem: one future method without `.eq("user_id")` would leak across users; the bot path also skips `has_feature('ai')` and the suspended check (`fn:195-200` vs `:206`).
- Fix: for the app path create the Supabase client with the user's JWT so RLS applies; keep service role only for the bot path and for `knowledge`. Check `has_feature('ai')`/suspended after resolving the link.
- Files: `fn:178-256`. Risk: medium (policy gaps may surface: feature_gate restrictive policies). Tests: cross-user matrix per table.

**W14. Fallback path silently diverges.**
- Impl: `ai.js ask()` has a different system prompt, no tools, in-memory history (`ai.js:16,238`), no memory/threads.
- Problem: during a function outage Discord answers lose memory, journal tools and rules; the user is not told (`assistant.js:46` returns no marker; `assistantError()` is exported but I did not verify any caller shows it).
- Fix: tag fallback replies (`via:"fallback"`), append a short footer once per outage, and queue a `note` when the function returns. Files: `assistant.js`, `index.js`. Risk: low. Tests: simulated 503.

**W15. `discord_links` has one fixed owner and no pairing flow.**
- Impl: unique(user_id), written only by the bot from `env.owners[0]` (`assistant.js:82`; `assistant.sql:61`); other owner ids in `OWNER_ID` list are not linked.
- Problem: multi-user is impossible; a second owner id gets 403 then W1 fallback. Only a design gap today.
- Fix: pairing code flow (section 7). Files: `fn`, `assistant.js`, app UI. Risk: medium. Tests: pairing happy path, expired code, reused code, unlink.

**W16. Provider/model drift between bot and function.** NVIDIA default differs (`env.js:19` vs `fn:39`); bot router and `ai.js` keep their own model lists (`router.js:28-34`, `ai.js:83-84`). Fix: read model names from one place (function `status`/ env). Risk: low. Tests: `status` vs bot env check at boot.

## 7. Design: shared memory between Discord and the app (not applied)

Goal: one memory for a person, written from both sides, with source tracking, per-user RLS, and the Discord brain using it instead of `brain.json` for durable items. Principles: reuse the existing tables where they already fit (`assistant_memories`, `assistant_messages`), add only what is missing (drafts, structured preferences, links with verification, an audit of writes). Writes by the bot and function use the service key plus `user_id` resolved from `discord_links`; the app writes through RLS as the signed-in user.

```sql
-- 1) Memories: make provenance and scope explicit (extends the existing table, backwards compatible).
alter table public.assistant_memories
  add column if not exists origin      text not null default 'app' check (origin in ('app','discord','model','brain')),
  add column if not exists scope       text not null default 'global' check (scope in ('global','style','announcements','channels','trading')),
  add column if not exists pref_key    text,                       -- brain's prefKey (style, announcements, ...)
  add column if not exists confidence  real not null default 1,
  add column if not exists deleted_at  timestamptz,                -- soft delete so offline caches can reconcile
  add column if not exists updated_at  timestamptz not null default now(),
  add column if not exists discord_message_id text;                -- exact message that produced it (if any)
create unique index if not exists assistant_memories_pref on public.assistant_memories (user_id, pref_key) where pref_key is not null and deleted_at is null;
create index if not exists assistant_memories_updated on public.assistant_memories (user_id, updated_at desc);
-- keep the secret rule in the database too (same intent as brain/memory.js SECRET)
alter table public.assistant_memories drop constraint if exists no_secrets;
alter table public.assistant_memories add constraint no_secrets
  check (text !~* '(password|passwd|api[ _-]?key|secret|seed phrase|private key|bearer|cvv|nvapi-|gsk_)' and text !~ '[A-Za-z0-9_-]{32,}');

-- 2) Drafts: written content with versions, usable from Discord (announcements, embeds) and the app.
create table if not exists public.assistant_drafts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  thread_id   uuid references public.assistant_threads on delete set null,
  kind        text not null default 'announcement',
  title       text not null default '',
  topic       text not null default '',
  text        text not null,
  version     int  not null default 1,
  status      text not null default 'draft' check (status in ('draft','approved','sent','discarded')),
  origin      text not null default 'discord' check (origin in ('app','discord','model','brain')),
  sent        jsonb not null default '[]'::jsonb,          -- [{channel_id,message_id,version,at}]
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create table if not exists public.assistant_draft_versions (
  id         bigserial primary key,
  draft_id   uuid not null references public.assistant_drafts on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  version    int  not null,
  text       text not null,
  instruction text,
  origin     text not null default 'discord',
  created_at timestamptz not null default now(),
  unique (draft_id, version)
);
create index if not exists assistant_drafts_user on public.assistant_drafts (user_id, updated_at desc);

-- 3) Link pairing (replaces "the bot writes the owner's row"): one-time code created in the app, redeemed in Discord.
create table if not exists public.discord_link_codes (
  code_hash   text primary key,                            -- sha256 of the code, never the code
  user_id     uuid not null references auth.users on delete cascade,
  expires_at  timestamptz not null default now() + interval '10 minutes',
  used_at     timestamptz
);
alter table public.discord_links
  add column if not exists verified_at timestamptz,
  add column if not exists linked_via  text not null default 'bot' check (linked_via in ('bot','pairing'));
-- allow several Discord ids per user: drop the one-to-one index
drop index if exists public.discord_links_user;
create index if not exists discord_links_user on public.discord_links (user_id);

-- 4) Write audit (who/what wrote shared state), small and prunable.
create table if not exists public.assistant_audit (
  id         bigserial primary key,
  user_id    uuid not null references auth.users on delete cascade,
  actor      text not null check (actor in ('app','discord','model','brain','system')),
  action     text not null,                                -- memory.add, memory.forget, draft.revise, link.create, ...
  ref        text,
  at         timestamptz not null default now()
);
create index if not exists assistant_audit_user on public.assistant_audit (user_id, at desc);

-- 5) Thread binding per Discord channel (fixes source-blind thread selection).
alter table public.assistant_threads add column if not exists channel_id text;
create unique index if not exists assistant_threads_channel on public.assistant_threads (user_id, channel_id) where channel_id is not null;

-- RLS: owners only. Service key (function, bot) bypasses RLS and always filters by user_id from userDb().
alter table public.assistant_drafts enable row level security;
alter table public.assistant_draft_versions enable row level security;
alter table public.discord_link_codes enable row level security;
alter table public.assistant_audit enable row level security;

drop policy if exists owner on public.assistant_drafts;
create policy owner on public.assistant_drafts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists owner on public.assistant_draft_versions;
create policy owner on public.assistant_draft_versions for all to authenticated
  using (user_id = auth.uid() and exists (select 1 from public.assistant_drafts d where d.id = draft_id and d.user_id = auth.uid()))
  with check (user_id = auth.uid() and exists (select 1 from public.assistant_drafts d where d.id = draft_id and d.user_id = auth.uid()));
-- the app may create a pairing code for itself and read its own; redeeming is done by the function (service key)
drop policy if exists owner_insert on public.discord_link_codes;
create policy owner_insert on public.discord_link_codes for insert to authenticated with check (user_id = auth.uid());
drop policy if exists owner_read on public.discord_link_codes;
create policy owner_read on public.discord_link_codes for select to authenticated using (user_id = auth.uid());
drop policy if exists owner_read on public.assistant_audit;
create policy owner_read on public.assistant_audit for select to authenticated using (user_id = auth.uid());   -- written only by service key
-- memories: the existing "owner" policy stays; the app UI reads where deleted_at is null.
-- Optional hardening: gate by feature like the data tables
-- create policy feature_gate on public.assistant_memories as restrictive for all to authenticated using (public.has_feature('ai')) with check (public.has_feature('ai'));
notify pgrst, 'reload schema';
```

### Who reads and writes what
| Data | Written by | Read by | Notes |
|---|---|---|---|
| Durable preference/fact (`assistant_memories`) | function tool `save_memory` (origin `model`), new function task `memory_set` called by the bot brain for "remember that ..." (origin `brain`/`discord`), app "What I remember" editor (origin `app`) | function prompt builder (`memoriesFor`), brain prompts (`styleLines`), app | Dedupe by `pref_key` upsert (brain keys) or lowercase text; forget = soft delete; client caches reconcile on `updated_at`. |
| Drafts and versions | brain (`newDraft/reviseDraft/approveDraft/markDraftSent` become calls to function tasks `draft_*`), app draft view later | brain, function tool `get_drafts`, app | `brain.json` keeps only the ephemeral conversation state (pending question, focus, list); drafts move to Postgres. Sent record includes Discord ids for idempotency. |
| Conversation turns | function (both surfaces); bot calls `note` for brain-handled turns | function, app | Discord threads bound by `channel_id`; app threads explicit. `source` already on every row. |
| Links | app creates a code (`discord_link_codes`), user sends `/link CODE` or `@bot link CODE` in Discord, bot forwards to function task `link_redeem` (service key) which inserts `discord_links` | function `whoIs` | Removes the single hard-wired owner row and the W1/W15 gaps; unlink from the app deletes the row. |
| Audit | function and bot (service key) | owner in app | Source tracking beyond the `origin` column. |

### Rules of the contract
- Source tracking: every memory/draft/message carries `origin` (`app|discord|model|brain`), the model path never overwrites a row whose origin is `app` without a confirmation turn.
- Ownership: `user_id` always comes from the verified JWT or from `discord_links`, never from the request body or the model.
- Conflict: last write wins on `updated_at`; deletes are soft for 30 days (cleanup job) so the bot's local cache can drop them.
- Privacy: bot keeps a small read-through cache (TTL 60 s) of memories and a write queue for outages; secrets rejected in three places (bot, function, DB check).
- Migration: import `brain.json` prefs once (`origin='brain'`, `pref_key` from `prefKey()`), then stop writing `brain.json` prefs. Rollback = keep the file path behind a flag.

### Tests required before shipping
1. RLS matrix with two JWTs (user A cannot select/insert/update/delete B's memories, drafts, versions, codes, audit).
2. Function: `userDb` methods always include `user_id` (fake client); a Discord id without a link gets 403 and the bot does NOT fall back to owner data (W1).
3. Pairing: code single-use, expires, hashed at rest, rate limited; unlink works; two ids per user work.
4. Round trip: "remember that I prefer short answers" in Discord appears in the app list with origin `discord`; deleting it in the app stops the bot from using it within the cache TTL.
5. Offline: function down -> brain queues the write -> flushes once; no duplicate on retry (idempotency key = `discord_message_id`).
6. Secret filter parity table across bot, function and DB constraint.

## Verification notes
- Read in full or in the relevant parts: `fn` (all sections 1-884 except tool bodies 379-440), `B:src/assistant.js`, `B:src/index.js:40-189`, `B:src/brain/{router,memory}.js`, `B:src/brain/index.js` (handle, memory handlers), `B:src/ai.js` (providers, context, ask), `B:src/store.js`, `B:src/env.js`, `B:src/access.js`, `B:src/knowledge.js` (1-110), `A:supabase/{assistant,yserlab,preferences,access}.sql`, `ASSISTANT.md`, `INTELLIGENCE.md`, parts of `A:src/journal/{assistant,aiModel}.ts` and `A:supabase/functions/ai/index.ts`.
- Not run: no code was executed, no live Supabase queries, no provider calls; deployed function version and secrets (e.g. whether GROQ_API_KEY is set) are not visible from source.
