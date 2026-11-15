import test from "node:test";
import assert from "node:assert/strict";
import { Index, tokens, asksForStructure } from "../src/knowledge.js";
import { context, modelFor } from "../src/ai.js";

test("shorthand is spelled out so an acronym finds the long name", () => {
  assert.ok(tokens("what is an fvg").includes("fair"));
  assert.ok(tokens("IC-CISD entries").includes("iccisd"));
  assert.ok(!tokens("what is the").length);
});

test("search ranks the passage that answers the question first", () => {
  const index = new Index([
    { title: "Order Blocks", h: "What is one", t: "An order block is the last opposing candle before a displacement." },
    { title: "Fair Value Gaps", h: "Invalidation", t: "A fair value gap is invalid when price closes through the consequent encroachment." },
    { title: "Kill Zones", h: "Times", t: "The New York kill zone runs in the morning." },
  ]);
  assert.equal(index.search("when is an FVG invalidated")[0].chunk.title, "Fair Value Gaps");
  assert.equal(index.search("ob definition")[0].chunk.title, "Order Blocks");
  assert.deepEqual(index.search("zzzz"), []);
});

test("a long model is cut to the parts that match the question", () => {
  const doc = { title: "Mine", summary: "Bias then entry.", concepts: [
    ...Array.from({ length: 40 }, (_, i) => ({ name: `Filler ${i}`, look_for: "nothing special ".repeat(30) })),
    { name: "Silver bullet", look_for: "a displacement during the window", must: ["inside the hour"] },
  ] };
  const text = modelFor(doc, "how do I find the silver bullet", 3000);
  assert.ok(text.length <= 3200);
  assert.ok(text.includes("Silver bullet") && text.includes("inside the hour"));
  assert.ok(text.includes("CONCEPTS IN THE MODEL"));
});

test("the prompt stays within Groq's room for a normal question", () => {
  const doc = { title: "Mine", summary: "x", concepts: Array.from({ length: 60 }, (_, i) => ({ name: `Concept ${i}`, look_for: "detail ".repeat(60), must: ["a", "b"] })) };
  const { system } = context({ doc, rows: [], text: "explain the fair value gap", history: [] });
  assert.ok(system.length < 26000, `prompt is ${system.length} characters`);
  assert.ok(asksForStructure("what lessons do you know about"));
  assert.ok(!asksForStructure("what is a fair value gap"));
});
