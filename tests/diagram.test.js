import test from "node:test";
import assert from "node:assert/strict";
import { compile, drawDiagram } from "../src/diagram.js";
import { TEMPLATES, fromTemplate, mirror, stepsFromTemplate } from "../src/diagramTemplates.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test("every template draws in both directions", async () => {
  for (const t of TEMPLATES) for (const dir of ["bullish", "bearish"]) {
    const png = await drawDiagram(fromTemplate(t.id, dir), 640);
    assert.ok(png && png.subarray(0, 4).equals(PNG), `${t.id} ${dir}`);
  }
});

test("mirroring swaps high and low in anchors, flips the candles and the words", () => {
  const m = mirror(TEMPLATES.find(t => t.id === "fvg").spec);
  assert.equal(m.panels[0].flip, true);
  assert.equal(m.panels[0].marks[0].from, "1:low");
  assert.equal(m.panels[0].marks[0].to, "3:high");
  assert.match(m.title, /Bearish/);
  assert.match(m.subtitle, /candle 1's low and candle 3's high/);
  assert.equal(mirror(TEMPLATES.find(t => t.id === "pd").spec).panels[0].marks[0].from, "1:@0.00");
  assert.match(mirror(TEMPLATES.find(t => t.id === "fractal").spec).panels[0].label, /higher timeframe/); // the chart's timeframe is not price direction
});

test("a bad spec drops the bad parts and still draws the rest", async () => {
  const built = await compile({ title: "T", panels: [{ pattern: "fvg", marks: [{ type: "level", at: "9:nope" }, { type: "arrow", from: "1:high", to: "1:high" }, { type: "zone", from: "1:high", to: "3:low" }, null, { type: "weird" }] }] });
  assert.ok(built);
  assert.ok(built.page.objects.some(o => o.type === "series"));
  assert.equal(built.page.objects.filter(o => o.type === "line").length, 0);
});

test("nothing to draw gives null, not a crash", async () => {
  assert.equal(await compile({ panels: [{ pattern: "no-such-thing" }] }), null);
  assert.equal(await compile(null), null);
});

test("the fractal model comes as four steps that draw, bullish and bearish", async () => {
  for (const dir of ["bullish", "bearish"]) {
    const steps = stepsFromTemplate("fractal", dir);
    assert.equal(steps.length, 4);
    for (const s of steps) assert.ok(await drawDiagram(s, 640));
  }
});

