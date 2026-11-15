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


import { pdfDrawings, specFromDrawing, matchDrawings } from "../src/pdfDrawings.js";
import fs from "node:fs";
test("the owner's PDF charts are traced and draw at the PDF's own proportions", { skip: !fs.existsSync("knowledge/model/drawings.json") }, async () => {
  const all = pdfDrawings();
  assert.ok(all.length > 100, "traced pages");
  const hit = matchDrawings("show me an ideal profile", 1)[0];
  assert.equal(hit.drawing.pdf, "Ideal Profile");
  const spec = specFromDrawing(hit.drawing);
  assert.ok(spec.panels.length >= 1 && spec.panels[0].aspect > 0);
  assert.ok(await drawDiagram(spec, 640));
});

import { toLtf } from "../src/diagramTemplates.js";
test("the lower timeframe view has more candles and keeps every anchor on a real candle", async () => {
  const spec = toLtf(fromTemplate("ss", "bullish"), 4);
  assert.equal(spec.panels[0].bars.length, 12);
  const built = await compile(spec);
  assert.ok(built && built.page.objects.some(o => o.type === "line"));
  assert.ok(await drawDiagram(spec, 640));
});

import { compoundOf, composeEntry, drawDiagram as _draw } from "../src/diagram.js";
test("a c2 closure with a CISD entry is one stacked picture", async () => {
  assert.deepEqual(compoundOf("Show me a c2 closure with the charts of a cisd as an entry"), { htf: "c2-closure", entry: "cisd" });
  assert.equal(compoundOf("show me a c2 closure"), null);
  const spec = await composeEntry("c2-closure", "bullish");
  assert.equal(spec.stack, true);
  assert.equal(spec.panels[1].bars.length, spec.panels[0].groups.reduce((a, b) => a + b, 0));
  assert.ok((await _draw(spec)).length > 5000);
});
