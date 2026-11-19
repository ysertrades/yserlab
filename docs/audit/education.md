# Audit: educational answers sound like retrieval

Paths: BOT = yserlab/src, APP = charts/supabase/functions/assistant/index.ts. Read-only audit, no source edited.

## A. Instructions that make the model cite or announce sources

| # | Where | Quoted text | Effect |
|---|---|---|---|
| A1 | BOT/ai.js:66 | `Name the lesson you draw from, e.g. "(lesson: Understanding Fair Value Gaps)".` | Direct cause of "lesson:" citations. |
| A2 | BOT/ai.js:65 | `...the education center is "the education center"; drop that word from lesson titles when you cite them.` | Presupposes citing; teaches the model to say "the education center". |
| A3 | BOT/ai.js:63 | `...the whole TTrades Trading Education Center (the textbook behind it: every lesson, diagram, PDF handout and video)` and `THEIR OWN MODEL (their playbook...)` | Frames the model as a librarian of documents. |
| A4 | BOT/ai.js:66 | `If their model and a lesson differ, follow their model and say what the lesson adds or does differently.` | Forces "the lesson says..." comparisons. |
| A5 | BOT/ai.js:69 | `...never invent rules or numbers there; if the material doesn't cover it, say so plainly...` | Fine on accuracy, but "the material" is announced as a phrase ("the material doesn't cover"). Reword. |
| A6 | BOT/ai.js:208 | `THEIR MODEL (from the PDFs they uploaded in the app; their playbook, it comes first):` | Label leaks "PDFs", "uploaded". |
| A7 | BOT/ai.js:209 | `TTRADES EDUCATION CENTER (the textbook; passages that match the question):` | Leaks "education center", "textbook", "passages", and the banned word TTrades in the label. |
| A8 | BOT/ai.js:210 | `STRUCTURE OF THE EDUCATION CENTER (the four courses and their lessons, as the site lists them...` | Legit only when the user asks for curriculum (gated by asksForStructure, knowledge.js:132); `big` mode (Gemini) injects it ALWAYS, so it is in context for every question. |
| A9 | BOT/ai.js:143 | `How the PDF draws it: ${c.visual}` (concept text) | "PDF" inside the model's context body. Same text duplicated at APP:359. |
| A10 | BOT/knowledge.js:99,114 | `const KIND = { note: "study note", text: "lesson", diagram: "diagram", pdf: "PDF handout", video: "video", ...}` and block header `[${lesson.title} · ${KIND} · ${c.h}]` | Every passage is prefixed with `[Lesson title · lesson]`, `[... · PDF handout]`. The model copies bracket headers into its answer. Also `lessons` is returned (knowledge.js:118, ai.js:212). |
| A11 | BOT/ai.js:162, 194 | `...(the rest of the model is cut for length)` and `(only the parts of the model that match the question are shown)` | Tells the model it sees fragments; encourages "the provided excerpt says". |
| A12 | BOT/ai.js:208 (smt) | `THE OWNER'S RULES FOR SMT ... (authoritative; follow them exactly, and when you teach one, run the strong/weak and switch tests out loud, name the one condition that decided it...)` | "Owner's rules" label can leak as "according to the owner's rules". "Name the one condition" is fine (reasoning, not source). |
| A13 | APP:672 | `You also know three specialised sources, used through tools: THEIR OWN TRADING MODEL (get_trading_model: the PDFs they uploaded...), the EDUCATION CENTER (search_education: the full fractal-model course)... use the sources and name the lesson or concept you draw from; general knowledge may add to it, and you say which part is which. If the sources and your general knowledge differ, follow the sources...` | App equivalent of A1, plus "say which part is which" forces a provenance split on every answer. |
| A14 | APP:673 | `Never invent anything and never say you looked something up unless a tool returned it.` | Invites "I looked this up in..." narration. Reword to forbid inventing and forbid announcing. |
| A15 | APP:675 | `Never say "TTrades": call it "the fractal model" and "the education center".` | Tells the model to name the education center. |
| A16 | APP:506 | search_education description: `Search the education center: every lesson, diagram, PDF handout and video transcript of the fractal model course...` | Tool descriptions are visible to the model and shape wording. |
| A17 | APP:509 | `return r.text ? { lessons: r.lessons, passages: r.text } : { passages: "", note: "Nothing in the education center matched." }` | Tool result hands the model a `lessons` title list and `passages`, plus a "Nothing in the education center matched" sentence the model tends to echo. |
| A18 | APP:344, 334 | `const block = \`[${c.title ?? ""} · ${KIND[c.k!]}...]\`` with KIND `lesson / PDF handout / study note / video` | Same as A10 for the app. |
| A19 | APP:513, 516 | get_trading_model description `read from the PDFs they uploaded in the app: their playbook...`; result `note: "The user hasn't uploaded a trading model yet."` | Leaks PDFs/uploaded. |
| A20 | APP:548, 554 | get_owner_rules description `The owner's own authoritative rules...`; `note: "The owner's SMT rules haven't been published yet."` | Leaks provenance and "published". |
| A21 | APP:370 | `CONCEPTS: ...` head line, no source label | OK, listed for completeness. |

Note: BOT/ai.js:63 and the APP SYSTEM have NO rule that says "do not mention sources", so any one of the labels above is enough for a leak. Also the SYSTEM prompts say `Name the lesson` while the owner wants the opposite, so these must be removed, not just softened.

## B. Where a source announcement can leak outside the model text

| # | Where | Quote | Note |
|---|---|---|---|
| B1 | BOT/index.js:197-198 | `const from = lessons.slice(0, 2).map(l => l.title.replace(/TTrades\s*/gi, "")).join(" · ");` ... `footer: from ? \`From: ${from}\` : undefined` | Multi-slide post footer announcing lesson titles. |
| B2 | BOT/index.js:208-209 | same `from` and `footer: ... \`From: ${from}\`` | Single diagram post footer. |
| B3 | BOT/index.js:204 | `text: \`**${...}** · from your PDF\`` | Caption on whole-PDF posts. Acceptable only if the user asked for a PDF by name; "pdf" is in the request regex (diagram.js:434), so tie the label to that. |
| B4 | BOT/pdfDrawings.js:77, 82 | `assumed: \`From your PDF: ${d.pdf}, page ${d.page}.\`` | Printed on the image itself (diagram.js:271 draws `assumed` at y=925). File name and page number on a picture. |
| B5 | BOT/diagram.js:375 | `assumed: "From your PDFs."` | Printed on a concept slide. |
| B6 | BOT/diagram.js:582 | `names.push(m.drawing.pdf + " (your PDF)")` | Shown in the clarify question (diagram.js:587). Ask-back with file names; low priority but a leak. |
| B7 | BOT/diagram.js:437 | `The PDF page's own text (the source of truth; page ${d.page} of "${d.pdf}"): ...` and diagram.js:397 `Lesson material:` | Narrator prompts; they can put "page N of file" into captions. Add "never write file names, page numbers or 'the lesson' in the words". |
| B8 | BOT/diagramTemplates.js:21,30 | `about: "from the owner's PDFs: ..."` | Template descriptions fed to the designer model. Low risk. |
| B9 | BOT/ai.js:260-261 history | The bot stores its own previous replies as model history; if a prior reply said "According to...", the next turn imitates it. After the fix, old history can still prime it (30 min TTL, KEEP 8). |
| B10 | APP: assistant_messages DB | Same imitation risk in persisted threads (24 messages loaded, APP:764). |
| B11 | BOT/ai.js:219-232 viaSearch / APP:621 web search | Prompts say `Answer from a web search ... with the date`. That is intended for news, not education; keep. |

## C. Recommended replacement wording

### C1. Bot SYSTEM (ai.js:63-66, replace those lines; keep 67 onward)

Replace the first paragraph (line 63):
```
You are YSER Lab, the personal trading mentor of one trader, living in their Discord server. You are an experienced instructor of THEIR trading model and of the fractal model course behind it, and you also read their journal numbers. The reference material below is what you know, not something you look up.
```
Replace line 65-66 with:
```
- Never say "TTrades"; the method is "the fractal model".
- Teach like a knowledgeable instructor speaking from your own expertise. Answer in the trader's own terms (their model's vocabulary first). Never mention or hint at where something came from: no "according to...", "the lesson says", "the education center", "the PDF", "your uploaded...", "the document", "the material", "the passage", "the knowledge base", no lesson or file names, no page numbers, no "lesson:" tags, and no talk of searching, retrieval or context. Only if the user explicitly asks where it comes from, asks for a source, lesson name, page number or an exact quote, reveal it using the SOURCE NOTES below.
- Terms and rules must match the reference exactly. If their model and the course differ, give their model's version as the rule; mention the course's variation only when it changes what they should do, in plain words ("a common variation is...") with no source naming.
```
Replace line 69's "if the material doesn't cover it, say so plainly" with:
```
...never invent rules or numbers there. If the specifics are not covered, say so in plain words ("I don't have a rule for that in your model") and then either reason from the rules you do know or give the general trading convention, saying "in general" so it is clear it is not part of their model.
```
(Note: "their model" is allowed in that sentence because it is about the trader's own playbook, not a document; avoid "your PDF".)

### C2. Context labels (ai.js:208-210)
- 208: `THEIR TRADING MODEL (their playbook; it comes first):` (drop "from the PDFs they uploaded in the app").
- 209: `REFERENCE: THE FRACTAL MODEL COURSE (background knowledge for answering; never mention it or its sections):` and strip bracket headers (below).
- 210: `COURSE OUTLINE (only for a question about what is covered or in what order; otherwise ignore):`. Also stop injecting it in `big` mode unless `asksForStructure(text)`: change `(big || asksForStructure(text))` to `asksForStructure(text)`.
- SMT label (208 inline): `THE OWNER'S RULES FOR SMT...` -> `RULES FOR SMT, 2S/3S, THE STRENGTH SWITCH AND PSP (authoritative; apply exactly, never attribute them; when you teach one, run the strong/weak and switch tests out loud, name the one condition that decided it, and end with a one-line question for the student):`.
- ai.js:143 and APP:359: `How the PDF draws it:` -> `How it looks on the chart:`.
- ai.js:162/194 trailer: delete both parentheticals (they are just context-size notes); or replace with nothing.

### C3. knowledge.js recall headers (knowledge.js:99,114) and APP:334,344
Keep the lesson title for ranking and for the SOURCE NOTES but remove it from the passage body:
```
const block = `[${c.h ?? KIND_LABEL[c.k] ?? ""}]\n${c.t}`;   // topic heading only, e.g. [Fair Value Gap]
```
with KIND dropped from the header entirely (no "lesson", "PDF handout", "video"). Return `lessons` (and a compact `sources` array) separately and out of the visible blocks:
```
return { text: picked.map(p => p.block).join("\n\n"), lessons, sources: picked.map(p => ({ lesson: p.lesson?.title, kind: KIND[p.k], heading: p.h })) };
```
In ai.js, add (only after the user's question has asked for a source, see C5) a block:
`SOURCE NOTES (reveal ONLY if the user explicitly asks where this comes from, for the lesson name, page number, source or an exact quote; otherwise never mention them):\n${sources}`.
Cheapest variant (no regex): always append SOURCE NOTES, plus the rule from C1 that says reveal only when asked. Safer variant: inject SOURCE NOTES only when `asksForSource(text)`:
```
export const asksForSource = q => /\b(source|cite|citation|reference|where (did|do) you (get|learn|read)|which (lesson|pdf|video|page|document)|what (lesson|pdf|page)|page (number|\d+)|exact (quote|words|wording)|quote (it|that|the)|in which)\b/i.test(q);
```
The safer variant guarantees no leak because the file/lesson names are not in context unless asked. (Trade-off: a follow-up "which lesson was that?" after a normal answer contains the word "lesson", so it matches; check `history` too by testing `follow + text`.)

### C4. App SYSTEM (APP:672, 673, 675) and tools
- 672 replace with:
```
- You are an experienced instructor of THEIR trading model (get_trading_model, which comes first for their method), of the fractal model course (search_education), and you read THEIR JOURNAL (get_journal_entries, get_trading_stats, get_calendar_performance). Tool results are your own knowledge: use them silently. Teach in your own voice; never say "according to", "the lesson", "the education center", "the PDF", "your uploaded...", "the document", "the knowledge base", "I searched/looked up/found", and never name lessons, files or pages or mention tools, searching or retrieval. Reveal a source (lesson title, kind, heading) only when the user explicitly asks where something comes from or asks for a lesson name, page number, citation or exact quote; the tool result's `sources` field has it. Where the course does not cover something, say so plainly or use general trading knowledge and mark it "in general" when the difference matters. If their model and general knowledge differ, their model decides.
```
- 673: `Never invent anything. Numbers about their trading come ONLY from get_trading_stats, get_calendar_performance or get_journal_entries. If a tool returns nothing, say you don't have it. If you are unsure or the facts may have changed, say so (web_search is for recent facts).` (drops "never say you looked something up", which invites the very phrase).
- 675: `Never say "TTrades"; the method is "the fractal model".`
- 506 description: `Look up background on the fractal model course (candle numbering, CISD, SMT, FVG, sessions, entries and more). Use silently for trading-method questions; never mention the lookup.`
- 509 return: `{ passages: r.text, sources: r.sources }` and the empty case `{ passages: "", note: "No matching reference; answer from general knowledge and say so only if it matters." }`. Delete the `lessons` key.
- 513/516: description `The user's own trading model: concepts, rules, vocabulary and checklist. It comes first for their method. Use silently.`; note `The user has no model saved yet.`
- 548/554: description `Authoritative rules for SMT, 2S/3S, the strength switch and PSP. Follow exactly; never attribute them.`; note `No rules available.`
- APP:344/334: same header change as C3.

### C5. Diagram footers and picture words
- BOT/index.js:197-198, 208-209: remove `footer: from ? ... : undefined` (or set `footer` to undefined). Keep the `lessons` variable for logging only. If the owner wants provenance available, put it in the `log("diagram", { note: ... , sources: from })` call, not in the post.
- BOT/index.js:204: change `· from your PDF` to `· ${pages} pages` (no PDF mention).
- BOT/pdfDrawings.js:77,82: `assumed: \`From your PDF: ${d.pdf}, page ${d.page}.\`` -> `assumed: ""`  (title is already on the slide). If kept for the owner's own proofing, gate behind an env flag `SHOW_DIAGRAM_SOURCE`.
- BOT/diagram.js:375: `assumed: "From your PDFs."` -> `assumed: ""`.
- BOT/diagram.js:582: `(your PDF)` -> `(from your model)`; or drop the suffix.
- BOT/diagram.js:397, 437: add to the narrator instruction: `Never write file names, page numbers, "the PDF", "the lesson" or "from your PDF" in the title, subtitle or caption.`

### C6. Keeping citations on request
- Context keeps a `sources` structure (lesson title, section, kind; PDF name and page for the model's own PDFs; `d.pdf`, `d.page` from the drawings index).
- Rule (system prompt, C1 and C4): reveal only on explicit ask; format `This comes from "<lesson title>" (<kind>)`; for exact quotes/pages, quote exactly from the passage; if no source note exists for the claim, say it is general knowledge.
- Prefer injecting sources only when `asksForSource(follow + text)` (bot) / when the model calls a `get_sources` call or reads `sources` in the tool result (app). For the app, the cheapest safe pattern is a result field the model only sees in the tool message: it is invisible to the user and the rule says reveal only when asked.

## D. 12 heuristic test questions

Forbidden regex for all non-source questions (case-insensitive):
`/\b(according to|as per|per the|the (lesson|pdf|document|material|passage|excerpt|textbook|handout|course)|education cent(er|re)|knowledge base|uploaded|lesson:|i (searched|looked (it )?up|found)|(provided|given) (context|material|text)|retrieved|page \d+|\.pdf|ttrades)\b/i`
Also reject a leading bracket `^\[.*·.*\]` and `(lesson` in parentheses.

| # | Question | Expected answer properties |
|---|---|---|
| 1 | "What is a CISD?" | Defines CISD (change in state of delivery) in the model's terms; includes what must close through what; no forbidden phrases; does not start with "According to". |
| 2 | "Explain a fair value gap like I'm new." | Three-candle imbalance explanation; correct candle roles; no source words; no "lesson:" tag. |
| 3 | "How do I trade candle 3 in the fractal model?" | Steps for C1 range, C2 sweep, C3 expansion in the model's vocabulary; says "the fractal model" not TTrades; no source words. |
| 4 | "What is the difference between a standard closure and a candle 2 closure?" | Both defined per owner's rules; states the deciding condition; no attribution. |
| 5 | "Teach me SMT." | Runs strong/weak and switch tests out loud, names the deciding condition, ends with a one-line question; no "the owner's rules" or "per". |
| 6 | "What is a PSP?" | Precision swing point explained; no source naming; no invented concepts (check it uses the supplied term, not a different expansion). |
| 7 | "What's the best candle numbering for 4H?" (not covered / ambiguous) | Says plainly it is not specified, or gives general convention marked "in general"; does not invent a rule or numbers; no "the material doesn't mention" wording (allowed: "I don't have a rule for that in your model"). |
| 8 | "Why do I need a CISD after the sweep?" | Reasons from the concept; follow-up style; no source words; no repeating of the definition header. |
| 9 | "Which lesson explains fair value gaps? Give me the page number too." | EXPLICIT source request: allowed and expected to name a lesson/title and say page/location, or admit no page number is available. Test inverts: must contain a lesson title, no fabricated page. |
| 10 | "Quote exactly what your notes say about CISD." | Allowed to quote and identify the source; quote must be a substring of the supplied passage. |
| 11 | "Draw me a CISD" (diagram) | Post has no `From:` footer; image text has no "From your PDF"; no file name or page on the image; title is the concept. |
| 12 | "What is in the course? List the lessons in order." | Structure question: listing lessons is allowed here (user asked); still no "according to" opening and no file names; "the education center" acceptable only if the user used it. |

Test mechanics: run `context({ doc, rows, text, history })` (ai.js:198) and assert (a) system string contains no `TTRADES EDUCATION CENTER`, `PDF handout`, `lesson`/`study note` bracket headers unless `asksForSource(text)`, and (b) after the model call, regex the reply. For deterministic coverage without a model, add unit tests on `recall()` output (no `· lesson ·` in `text`) and on the `from`/footer code path (no footer on posts).

## E. Priority order
1. Delete A1 and A13 (explicit "name the lesson" rules) and add the no-announce rule (C1, C4). Highest impact.
2. Strip bracket headers and KIND words from passages (knowledge.js:114, APP:344; A10, A18) and `lessons` from the tool result (APP:509).
3. Rename context labels (A6, A7, A9, A19, A20).
4. Remove `From:` footers and `From your PDF` image text (B1-B5).
5. Keep sources in a separate, reveal-on-ask field (C3, C6) and add tests (D).
6. Clear or ignore old history that contains "According to..." replies, otherwise the model imitates them for the next 30 minutes (bot) or 24 messages (app).
