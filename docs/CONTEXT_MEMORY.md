# Continuous conversation understanding and artifact memory

What this change is, what existed before it, how it works, and what has and has not been proven.

## 1. What was wrong (found by inspecting the code first)

The structured memory from the earlier upgrade (`src/brain/memory.js`) already kept entities, drafts with versions, pending questions, corrections and
operations, and it was independent of the model provider. It did **not** hold the thing the owner talks about most: what the assistant *explained*.

| Gap | Where it showed |
|---|---|
| An answer was stored as a turn cut to 700 characters (and 220 in the context block). The exact text was gone after one message. | "Make an embed for this" had nothing exact to work from |
| `handleEmbed` ran before the intelligence layer and wrote the embed from the **literal request**. | `Make an embed for this` produced an embed titled "This" |
| No topic tracking. `c.topic` was only set by drafts and embeds. | "How is it used?" relied on the model re-reading raw history |
| Pointers ("the first one", "both", "what we discussed earlier") were resolved for channels and members, never for content. | Multi-topic requests used the latest thing or nothing |
| "Send it" / "save this" meant a draft or an embed only. An explanation could not be sent, and `send this to #education` fell through to the model. | |
| Nothing was kept across a conversation expiring, and nothing linked a generated embed to what it was made from. | |
| The model's own history (`ai.js`, keyed by channel, last few turns, 600 characters each) was the only continuity for explanations. | |

## 2. Architecture

New modules in `src/brain/`, all independent of Gemini / Groq / NVIDIA (everything they keep is on disk with the conversation, everything they hand a model is text):

| Module | Role (the brief's name for it) |
|---|---|
| `artifacts.js` | **Artifact Memory Manager.** The exact content the assistant generated, with versions, approval, delivery (real Discord ids only), source/derived links, scope and pruning. |
| `topics.js` | **Topic Tracking Engine** and the reading of a message: concepts and terms, how it points back, what it asks for (info / transform / send / pin / save), aspect, the stack of topics. |
| `reference.js` | **Reference Resolution Engine** for content: named subject, position, "both", "earlier", "this"; asks instead of guessing; channel scope; builds the exact source for a writer or model. |
| `working.js` | **Working Memory Manager / Task State Manager.** The spec's working-memory object (`view()`), and the compact lines a model is given. Pending and completed actions, resolved references. |
| `summary.js` | **Conversation Summarisation Engine.** Folds old turns into how the conversation started, the topics so far, recent asks, corrections. Never replaces an artifact. |
| `converse.js` | **Conversation Context Manager / Context Retrieval Engine / Discord Action Memory.** `noteAnswer`, `prepareEmbed`, `understand`, `answerSource`, `sendArtifacts`, `noteEmbedArtifact`, `contextFor`, `ingestExternal`. |
| `sync.js` (extended) | **Cross-Platform Memory Layer.** Mirrors artifacts to `assistant_artifacts`; reads the app assistant's explanations back (`assistant_messages`, source `app`). |
| `memory.js` (extended) | **Persistent Memory Manager.** Artifacts live in the same file, outlive conversations (30 days, longer when approved or saved), and survive a restart (`_reload`). |
| `eval/context-*.js` | **Memory Evaluation System** (section 6). |

Reused as they were: the administrator's gate (`runTool`: permissions, confirmation, audit, read-back), idempotent sends, the router with provider failover, the classifier, Components V2 `panel()` for every embed and every sent explanation.

### Data model

* **Artifact**: `id, owner, guild, channelId, convoKey, sourceMessageId, type, subject, subjectKey, aspect, title, original, content, versions[], status, approvedVersion, deliveries[{channelId, messageId, url, version}], sources[], derived[], group, origin, meta, createdAt, updatedAt`. Types: explanation, example, lesson, quiz, slides, bullets, summary, guide, announcement, embed, draft. Statuses: generated, draft, approved, sent, edited, deleted, failed.
* **Conversation** (one per person per server, as before) gains `topics[]` (a stack: key, label, aspects, artifact ids, order first discussed), `subtopic` and `work` (pointers: last assistant response, active embed, target channel, completed actions with Discord ids, resolved references).
* **Working memory view** (`brain.workingMemory(message)`): `conversation_id, user_id, guild_id, channel_id, thread_id, current_topic, current_subtopic, active_entities, last_user_intent, last_assistant_response, active_explanation, active_artifact, active_draft, active_embed, active_announcement, active_target_channel, pending_actions, completed_actions, recent_references, conversation_summary, last_updated`.

### Scopes

| Scope | Where it lives | Rule |
|---|---|---|
| User | artifacts (`owner`), preferences | Never visible to anyone else (`art.visible` filters by owner). |
| Server | artifacts (`guild`) | Content from another server is not a candidate. Content from the app (`guild: "*"`) belongs to the person and is usable in all their servers. |
| Channel | artifact `channelId`, topic `channelId` | Content made in another channel is **confirmed** ("Do you mean the CISD explanation from #general?") before an unnamed pointer uses it. Naming it, or saying "earlier", needs no confirmation. |
| Thread | `thread_id` in working memory | Recorded; a thread uses the same conversation as its server. |
| Conversation | topics, working memory, pending question | Expires after 7 days; artifacts do not. |
| Application | `assistant_artifacts`, `assistant_messages` | Read and written only as the owner (RLS by `user_id`). |

## 3. The retrieval pipeline (the brief's 11 steps)

Per owner message in a server (`src/index.js` → `brain.prepareEmbed` → `handleEmbed` → `brain.handle` → model):

1. **Recent messages**: the structured turns, plus the channel lines already passed to the model path.
2. **Active state**: `getConvo` (topic stack, draft, pending, entities, `work`).
3. **References**: `topics.analyze` reads this/that/it/both/ordinals/"earlier"/named concepts.
4. **Previous explanations**: `reference.sourcesFor` finds the stored artifacts the pointer means.
5. **Exact artifacts**: `reference.buildSource` returns the whole text, definition first, then in the order explained, instruction-like sentences removed.
6. **Pending tasks**: a "which one?" question is answered first (`answerSource`, `prepareEmbed`).
7. **Intent**, 8. **kind** (information / transformation / action): `analyze().kind`, then the classifier for server operations. An operation is never rewritten into a question about a topic.
9. **Context built for the model**: `converse.contextFor` = structured block + working memory + "RESOLVED: 'this' means X" + the exact `SOURCE CONTENT` (at most 4,500 characters for a model; 7,000 for the embed writer).
10. **Answer or action** through the existing gate.
11. **Memory updated**: `noteAnswer` (artifact, topic, working memory), `noteEmbed` (embed artifact with sources, real message ids), `sendArtifacts` (delivery recorded only from what Discord returned).

Cost, measured with 150 artifacts stored (`npm run eval:perf-context`): a message is understood and its context built in about **0.5 to 1 ms** (p95 about 1.3 ms); the context handed to a model is about 500 tokens, about 1,650 with an exact source attached.

## 4. Behaviour you can rely on

* Follow-ups keep their subject without repeating it: the question given to the model says it out loud ("How is IFVG used in trading?") and carries a `RESOLVED` line and `Current topic`.
* "Make an embed for this / both / the first one / what we discussed earlier / the CISD explanation" writes an **educational embed from the stored text**. The writer receives `Subject` and `SOURCE`, never the request. If no model answers, the embed is built from the source itself (`fallbackEducation`), never from the request.
* One answer that covered two subjects is split into one artifact per subject; "that" then asks which (or both). Two stored subjects and "earlier" asks which. Nothing stored and a pointer: it says so instead of making something up.
* "Send this / it / that explanation to #channel" posts the stored text through `message_send` (idempotent, verified by reading the message back), records the channel and message id on the artifact, and "pin it" then pins exactly that message. Sent twice to the same channel: the second says it is already there.
* "Save this", "looks good" approve the newest thing (an embed or stored content); an edit afterwards makes it a draft again.
* Messages that are not about stored content are left alone: `Create an announcement that the stream starts at 9`, `Post that the stream starts…`, `Delete that`, small talk and market questions are not rewritten, hijacked or stored as knowledge.
* Stored text is data: sentences that talk to a model are removed before it is used as a source, pings are neutralised, and the source is labelled data in every prompt.

## 5. Cross-platform and restart

* After a restart, `brain.json` is loaded again: topics, artifacts (with versions, approval, deliveries) and an open question survive. Tested by `_reload()` and the restart scenarios.
* `sync.js` mirrors artifacts to `assistant_artifacts` (SQL: `charts/supabase/artifacts.sql`) and reads the app assistant's question-and-answer pairs back as artifacts (`origin: "app"`), so content discussed in the app can be made into an embed from Discord. **This part is unit-tested for the merge logic (`tests/context.test.js`) but has not been run against the live database or the live app assistant.**
* The app's edge function (`charts/supabase/functions/assistant`) was **not** changed: reading Discord-made artifacts inside the app is not implemented yet (the table and RLS are there for it).

## 6. Evaluation: before and after

`npm run eval:context` runs 221 conversations (180 written from the brief, 41 held-out ones written afterwards with different wording and aimed at hijacking, small talk, injection, odd input, duplicates) through the real message flow against the stand-in server (`tests/helpers/world.js`) and a stand-in model (`eval/context-knowledge.js`) that can only use what it is handed (the question it receives, a `Current topic` line, or the last thing the assistant said, which is what raw history gives it). "Before" is the same scenarios run against the previous checkout (commit `9dea974`) with `--root`.

| | Before | After |
|---|---|---|
| Scenarios fully correct | 59 / 221 (26.7%) | **221 / 221** |
| Follow-up understanding (subject kept) | 91.7% | 100% |
| Transformations built from the exact source | 0.7% | 100% |
| Sends / pins / edits on the right message | 21.7% | 100% |
| Asked when the reference was ambiguous | 0% | 100% |
| Did not ask when the reference was clear | 48.0% | 100% |
| Correct after a restart | 54.2% | 100% |

By category (before → after): follow-up 24→36 of 36, transformation 0→32 of 32, modification 8→8, actions 0→22 of 22, multi-topic 0→16 of 16, topic switching 0→10 of 10, persistence 2→8 of 8, provider switching 3→6 of 6, ambiguity 0→8 of 8, isolation 0→10 of 10, long history 0→6 of 6, verification 3→8 of 8, the ten tests from the brief 5→10 of 10, held-out 14→41 of 41.

Existing suites, unchanged: `npm test` 216 of 216 (197 earlier tests plus 19 new unit tests), `npm run eval` 100% (146/146 intents), `npm run eval:scenarios` 97.1% (238/245, the same 7 known failures as before).

### What these numbers do and do not show

* They prove the **memory, resolution and action logic**: that the right subject, the exact source and the right message are what reach the model, the embed writer and Discord, and that it asks when it should. They are produced by code that was run; nothing is marked passed that was not executed.
* They do **not** prove the quality of a real model's answers, the live Discord API, or the live Supabase tables. The stand-in model is simple on purpose. The "before" follow-up score is high because raw history lets a model infer a pronoun; it fails exactly where structure matters (several topics, "the first one", exact text, restart, asking).
* I wrote both the scenarios and the code, which is why 41 of them were written afterwards and aimed at breaking it; the sets together found real bugs that were fixed before this table was produced (an "IFVG" answer matching "FVG" as a substring, topics discussed in the same millisecond coming out in the wrong order, a greedy "what is the price of NQ" being stored as a subject, a typo match that also matched the generic word "liquidity", a scrub that dropped a whole line instead of one sentence, and embeds that could not be approved). Run your own conversations against the bot after restarting it.

## 7. Known limits

* Concept recognition uses a list of about 35 trading concepts plus "what is X" for unknown terms. A subject the list does not know and a question that does not use that pattern ("dealing range, how's it formed?") is not tracked as a topic (the model still answers; it just is not stored as an artifact).
* Splitting one answer between two subjects relies on each section starting with the subject's name; otherwise each subject gets the whole answer.
* The unnamed pointer across channels asks for confirmation (by design); the topic itself follows the person across channels.
* `brain.json` is written whole (about 530 KB with 150 artifacts) at most every 1.5 s; fine at this size.
* Mirroring and reading the shared store happen at start and every 15 minutes; a failure is logged and ignored.

## 8. Operating it

1. Run `charts/supabase/artifacts.sql` once in the Supabase SQL editor (additive; the bot ignores a missing table).
2. Deploy: push `yserlab` and restart the bot in the host panel.
3. `npm run eval:context` before and after any change to the memory code; `npm run eval:perf-context` for cost.
