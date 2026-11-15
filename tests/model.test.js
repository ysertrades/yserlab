import test from "node:test";
import assert from "node:assert/strict";
import { modelText } from "../src/ai.js";

test("model digest includes vocabulary, concepts and checklist, and respects the limit", () => {
  const doc = { title: "My model", summary: "Bias then entry.", glossary: [{ term: "C2", means: "second candle" }], concepts: [{ name: "CISD", kind: "setup", look_for: "a change in state", must: ["closes beyond"], steps: ["mark", "wait"] }], checklist: { phases: [{ name: "Bias", items: [{ text: "HTF bias set" }] }] } };
  const text = modelText(doc);
  for (const s of ["My model", "C2: second candle", "## CISD (setup)", "Must hold: closes beyond", "HTF bias set"]) assert.ok(text.includes(s), s);
  assert.ok(modelText({ ...doc, summary: "x".repeat(50000) }, 1000).length < 1100);
  assert.equal(modelText(null), "(no model uploaded yet)");
});
