// Educational answers must sound like an instructor, not a retrieval system. These checks are on what the model is GIVEN (labels, headers,
// instructions): if a source name is not in the prompt, it can't leak into an answer; and when the user asks for a source it must be there.
// They do not test real model output.
import test from "node:test";
import assert from "node:assert/strict";
process.env.SUPABASE_SERVICE_KEY = ""; process.env.SUPABASE_SERVICE_ROLE_KEY = "";
const { context, asksForSource } = await import("../src/ai.js");
const { recall, hasKnowledge } = await import("../src/knowledge.js");

const FORBIDDEN = /TTRADES EDUCATION CENTER|PDF handout|study note|the PDFs they uploaded|How the PDF draws|\[[^\]\n]*·[^\]\n]*\]/;
const QUESTIONS = ["What is a CISD?", "Explain a fair value gap like I'm new.", "How do I trade candle 3 in the fractal model?", "Teach me SMT.", "What is a PSP?", "Why do I need a CISD after the sweep?"];

test("education: the prompt for an ordinary question names no source, lesson, file or retrieval", { skip: !hasKnowledge() }, () => {
  for (const q of QUESTIONS) for (const big of [false, true]) {
    const { system } = context({ doc: null, rows: [], text: q, history: [], big });
    assert.doesNotMatch(system, FORBIDDEN, `${q} (big=${big})`);
    assert.doesNotMatch(system, /SOURCE NOTES \(the user asked/, "sources are not in context unless asked");
    assert.match(system, /Never mention or hint at where something came from/);
    assert.doesNotMatch(system, /Name the lesson you draw from/);
  }
});
test("education: passages carry a topic heading only, never a lesson title or kind", { skip: !hasKnowledge() }, () => {
  const r = recall("what is a fair value gap", { chars: 6000 });
  assert.ok(r.text.length > 100); assert.doesNotMatch(r.text, /· lesson ·|· PDF handout|· study note|· video\]/);
  assert.ok(r.sources.length > 0, "sources are kept separately for when they are asked for");
});
test("education: an explicit request for a source brings the source notes into context", { skip: !hasKnowledge() }, () => {
  for (const q of ["Which lesson explains fair value gaps? Give me the page number too.", "where did you get that", "Quote exactly what it says about CISD", "cite your source for the fair value gap"]) assert.equal(asksForSource(q), true, q);
  const { system } = context({ doc: null, rows: [], text: "Which lesson explains fair value gaps?", history: [], big: false });
  assert.match(system, /SOURCE NOTES \(the user asked/);
});
test("education: ordinary questions are not mistaken for source requests", () => {
  for (const q of QUESTIONS.concat(["what is a lesson learned from my trades", "explain candle 2 closure"])) assert.equal(asksForSource(q), false, q);
});
test("education: the course outline is only given when the question is about what the course covers", { skip: !hasKnowledge() }, () => {
  assert.doesNotMatch(context({ doc: null, rows: [], text: "What is a CISD?", history: [], big: true }).system, /COURSE OUTLINE/);
});
