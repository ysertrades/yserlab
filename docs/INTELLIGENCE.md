# The assistant's intelligence layer

Everything lives in `src/brain/`. It sits in front of the existing language-model path and the administrator's tool registry; it replaces neither.

## Flow of one message (owner, in a server)

1. `index.js` → `brain.handle()`: records the turn in the conversation state.
2. A pending question? The message is its answer (a missing name, topic, channel, "which one?"), unless it is clearly a new request.
3. `classify.js` turns the message into one structured intent: `{ primary, secondary, action, resource, target, params, refs, needs, clarify, confidence }`. Typos, slang and informal phrasing are normalised first. Corrections ("no, I mean …") re-classify the remainder and are stored.
4. `resolver.js` resolves "here", "#name", "the second person", "it/that" from the structured state (`memory.js`), never from the model. Equally plausible targets produce one question, not a guess.
5. `registry.js` checks that the tool is allowed to answer that intent (a server overview can't answer a member list) and that the arguments are valid.
6. The tool runs through `runTool` in `admin/tools.js`: capability switches, the requester's and the bot's real permissions, confirmation for high-risk tools, audit line. Writes are read back from Discord.
7. What really happened (ids, outcome) updates the state and the operation log; the reply is built from that, never from the model's wording.
8. Anything the layer does not own (trading questions, pictures, general chat) is returned unhandled together with the retrieved context, and the existing path answers it. A tool call the model makes is checked by `brain.guard()` (unknown actions rejected, wrong tool overruled, references resolved).

## Modules

| File | Role |
| --- | --- |
| `memory.js` | Conversation state, drafts with versions, pending questions, preferences (long-term), operation log (idempotency), feedback records. Persisted to `data/brain.json`. |
| `classify.js` | Structured intent classification, spelling tolerance, ordinals, compound requests. |
| `resolver.js` | Channel/member/role/message reference resolution. |
| `registry.js` | Schemas, intent → allowed tools, validation, a joined view with the gate's permissions. |
| `tools.js` | New registered tools: `member_list`, `member_count`, `member_online`, `message_send` (idempotent), `message_update`, `message_pin`, `message_remove`. |
| `router.js` | Groq / Gemini / NVIDIA NIM routing per job, cooldown after a failure, fallback. State is independent of the provider. |
| `index.js` | The conversation manager, handlers, plan execution and verification. |

## Member retrieval

`member_list` reads Discord's REST member list page by page (1000 at a time, up to 10 000), filters by role, name, humans/bots, sorts, and pages the result with Previous/Next buttons. It needs the **Server Members Intent** switched on for the bot in the Developer Portal. Without it the reply says so and lists only the members the bot has already seen. Who is online by name needs the **Presence Intent**; without it only the approximate online count is given. Nothing is invented.

## Memory layers

* short-term: `convos` (topic, turns + rolling summary, entities, last list, focus, drafts, pending, corrections);
* long-term: `prefs` per user ("remember that …", "forget …"; anything that looks like a secret is refused);
* operational: `ops` (what was really done, with ids; keys prevent duplicate sends);
* feedback: structured correction records for the evaluation set. They are never fed into prompts automatically.

## Evaluation

```
npm test          # unit and dialogue tests (tests/brain.test.js) plus the existing suites
npm run eval      # metrics over eval/dataset.js; exits non-zero if a bar is missed
npm run eval -- --verbose
```

Metrics: intent accuracy, tool selection, reference resolution, context retention, clarification when needed, task completion, duplicate-operation safety, unintended changes, provider-failure recovery, no model call for deterministic work.

Both run against a stand-in server (`tests/helpers/world.js`). They prove the logic and the exact changes made; they do **not** prove behaviour against the live Discord API or real model output. When a real mistake is found, add it to `eval/dataset.js` and fix the cause.

## Not covered yet

* The in-app assistant (Supabase edge function in the charts repo) does not read this memory yet; sharing drafts and preferences between Discord and the app needs a table with per-user access control and a change to that function.
* The model-path guard resolves references and rejects unknown actions, but free-form model output is not otherwise re-classified.

> Conversation understanding, artifact memory, topic tracking and the context evaluation are described in [CONTEXT_MEMORY.md](CONTEXT_MEMORY.md).
