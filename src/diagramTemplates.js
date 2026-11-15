/**
 * Hand-drawn diagrams for the ideas the education center teaches, in the slides editor's style. The AI picks one by name and a direction
 * instead of placing marks itself, so the common pictures are always right. Each is drawn in its natural direction (`native`) and is
 * mirrored for the other (flip the candles, swap high and low in every anchor).
 * Anchors: "N:field" = candle N, field high/low/open/close/top/bottom/mid; "N:@0.5" = half way up the panel.
 */
import { SMT_TEMPLATES } from "./smtTemplates.js";
import { PROFILE_TEMPLATES } from "./profileTemplates.js";
const row = (...r) => r;
export const TEMPLATES = [
  {
    id: "fvg", name: "Fair value gap", native: "bull",
    about: "a three-candle gap (candle 1's high to candle 3's low), price returning into it, then expanding",
    spec: { title: "Bullish Fair Value Gap", subtitle: "The gap between candle 1's high and candle 3's low", panels: [{ label: "Price returns to the gap, then expands", pattern: "fvg-return", numbers: true, marks: [
      { type: "zone", from: "1:high", to: "3:low", fromBar: 2, toBar: 5, color: "amber", label: "FVG" },
      { type: "level", at: "3:high", label: "C3 high", color: "blue", from: 3, to: 6 },
      { type: "arrow", from: "5:low", to: "6:high", color: "teal", curve: .25, label: "expansion" }] }] },
  },
  {
    id: "c2-closure", name: "Candle 2 closure entry", native: "bull",
    about: "from the owner's PDFs: candle 2 wicks past candle 1's low and its body closes back inside candle 1's range; entry at the open of candle 3, stop on the candle 2 swing point",
    spec: { title: "Candle 2 Closure", subtitle: "C2 takes C1's low and closes back inside; enter on the open of C3", panels: [{ label: "Entry at the open of candle 3, stop on the C2 swing point", pattern: "c2-closure-run", numbers: true, marks: [
      { type: "level", at: "1:low", label: "C1 low", color: "blue", dash: "dashed", from: 1, to: 4 },
      { type: "level", at: "2:low", label: "Stop", color: "red", dash: "dashed", from: 2, to: 4 },
      { type: "circle", at: "2:close", color: "teal" }, { type: "note", at: "3:open", text: "Entry", color: "ink" },
      { type: "arrow", from: "3:open", to: "4:high", color: "teal", curve: -.2, label: "continuation" }] }] },
  },
  {
    id: "c3-closure", name: "Candle 3 closure entry", native: "bull",
    about: "from the owner's PDFs: candle 2 fails a standard closure (it does not close back inside candle 1), candle 3 then closes through candle 2's open; entry at the open of candle 4, stop on the candle 2 swing point",
    spec: { title: "Candle 3 Closure", subtitle: "C2 fails to close inside C1; C3 closes through C2's open; enter on the open of C4", panels: [{ label: "Entry at the open of candle 4, stop on the C2 swing point", pattern: "c3-closure-run", numbers: true, marks: [
      { type: "level", at: "2:open", label: "C2 open", color: "blue", dash: "dashed", from: 2, to: 4 },
      { type: "level", at: "2:low", label: "Stop", color: "red", dash: "dashed", from: 2, to: 4 },
      { type: "circle", at: "3:close", color: "teal" }, { type: "note", at: "4:open", text: "Entry", color: "ink" },
      { type: "arrow", from: "4:open", to: "4:high", color: "teal", curve: .2, label: "continuation" }] }] },
  },
  {
    id: "ifvg", name: "Inversion fair value gap", native: "bear",
    about: "a fair value gap that price closes through, so it flips and rejects price from the other side (IFVG)",
    spec: { title: "Bearish Inversion Fair Value Gap", subtitle: "A bullish gap is closed through, then rejects price", panels: [{ label: "The gap inverts and becomes resistance", numbers: true,
      bars: [row(40, 46, 38, 45), row(45, 64, 44, 62), row(62, 70, 50, 66), row(66, 67, 52, 54), row(54, 56, 38, 40), row(40, 49, 38, 47), row(47, 48, 28, 30)], marks: [
      { type: "zone", from: "1:high", to: "3:low", fromBar: 2, toBar: 7, color: "amber", label: "IFVG" },
      { type: "circle", at: "5:close", color: "red" },
      { type: "note", at: "5:low", text: "Closes through", color: "ink" },
      { type: "arrow", from: "6:high", to: "7:low", color: "red", curve: .2, label: "rejection" }] }] },
  },
  {
    id: "cisd", name: "Change in state of delivery", native: "bull",
    about: "a run of candles one way, then a close back through the open of that run (CISD)",
    spec: { title: "Bullish CISD", subtitle: "Price closes back through the open of the down-close run", panels: [{ label: "Candle 5 closes above candle 1's open", pattern: "cisd", numbers: true, marks: [
      { type: "level", at: "1:open", label: "CISD level", color: "blue", from: 1, to: 6 },
      { type: "circle", at: "5:close", color: "teal" },
      { type: "arrow", from: "4:low", to: "6:high", color: "teal", curve: -.2, label: "delivery higher" }] }] },
  },
  {
    id: "sweep", name: "Liquidity sweep and reversal", native: "bull",
    about: "price runs through an obvious low (sell-side liquidity), takes the stops, and reverses",
    spec: { title: "Liquidity Sweep", subtitle: "Price takes the low, then reverses", panels: [{ label: "Sell-side liquidity taken, then reversal", pattern: "sweep-low", numbers: false, marks: [
      { type: "level", at: "2:low", label: "SSL", color: "blue", dash: "dashed", from: 1, to: 8 },
      { type: "circle", at: "5:low", color: "red" },
      { type: "note", at: "5:low", text: "Sweep", color: "ink" },
      { type: "arrow", from: "5:low", to: "8:high", color: "teal", curve: -.25, label: "reversal" }] }] },
  },
  {
    id: "fractal", name: "TTrades fractal model (candles 1 to 4)", native: "bull", steps: fractalSteps(),
    about: "C1 sets the range, C2 sweeps one side and closes back inside, C3 expands through the other side, C4 continues",
    spec: { title: "TTrades Fractal Model", subtitle: "C2 takes liquidity, C3 expands", panels: [{ label: "Four candles on the higher timeframe", numbers: true,
      bars: [row(40, 62, 36, 58), row(58, 60, 22, 44), row(44, 78, 40, 74), row(74, 92, 70, 88)], marks: [
      { type: "level", at: "1:high", label: "C1 high", color: "blue", dash: "dashed", from: 1, to: 4 },
      { type: "level", at: "1:low", label: "C1 low", color: "red", dash: "dashed", from: 1, to: 4 },
      { type: "note", at: "2:low", text: "C2 sweep", color: "ink" },
      { type: "arrow", from: "2:low", to: "3:high", color: "teal", curve: -.25, label: "C3 expansion" }] }] },
  },
  {
    id: "pd", name: "Premium and discount", native: "bull",
    about: "a range split at equilibrium: buy in the discount (lower half), sell in the premium (upper half)",
    spec: { title: "Premium & Discount", subtitle: "Buy in discount, sell in premium", panels: [{ label: "The range split at equilibrium",
      bars: [row(50, 56, 46, 54), row(54, 64, 52, 62), row(62, 70, 60, 68), row(68, 72, 58, 60), row(60, 62, 48, 50), row(50, 52, 38, 40), row(40, 44, 30, 32), row(32, 46, 30, 44), row(44, 52, 42, 50)], marks: [
      { type: "zone", from: "1:@1", to: "1:@0.5", fromBar: 1, toBar: 9, color: "sl", label: "Premium" },
      { type: "zone", from: "1:@0.5", to: "1:@0", fromBar: 1, toBar: 9, color: "tp", label: "Discount" },
      { type: "level", at: "1:@0.5", label: "EQ", color: "blue", dash: "dashed", from: 1, to: 9 }] }] },
  },
  {
    id: "ob", name: "Order block", native: "bull",
    about: "the last opposite candle before a strong displacement, which price later returns to and reacts from",
    spec: { title: "Bullish Order Block", subtitle: "The last down candle before the displacement", panels: [{ label: "Price returns to the order block and reacts", numbers: true,
      bars: [row(54, 56, 50, 51), row(51, 53, 47, 48), row(48, 50, 44, 45), row(45, 66, 44, 64), row(64, 70, 60, 68), row(68, 69, 46, 53), row(53, 76, 50, 74)], marks: [
      { type: "zone", from: "3:top", to: "3:bottom", fromBar: 3, toBar: 7, color: "amber", label: "Order block" },
      { type: "arrow", from: "6:low", to: "7:high", color: "teal", curve: -.2, label: "reacts" }] }] },
  },
  {
    id: "smt", name: "SMT divergence", native: "bear",
    about: "two correlated markets: one makes a new high (or low) and the other fails to, so the move is weak",
    spec: { title: "SMT Divergence", subtitle: "One market takes the high, its correlated market does not", panels: [
      { label: "NQ: higher high", numbers: false, bars: [row(40, 48, 38, 46), row(46, 56, 44, 54), row(54, 60, 50, 52), row(52, 56, 48, 55), row(55, 68, 53, 66), row(66, 67, 58, 60)], marks: [
        { type: "level", at: "3:high", label: "", color: "blue", dash: "dashed", from: 3, to: 6 }, { type: "circle", at: "5:high", color: "red" }] },
      { label: "ES: lower high", numbers: false, bars: [row(40, 47, 38, 45), row(45, 54, 43, 52), row(52, 60, 49, 51), row(51, 55, 47, 54), row(54, 58, 52, 56), row(56, 57, 50, 52)], marks: [
        { type: "level", at: "3:high", label: "", color: "blue", dash: "dashed", from: 3, to: 6 }, { type: "circle", at: "5:high", color: "red" }, { type: "note", at: "5:high", text: "Fails to break", color: "ink" }] }] },
  },
  {
    id: "psp", name: "Precision swing point", native: "bull",
    about: "two correlated markets print opposite-colour candles at the same time at a swing (PSP)",
    spec: { title: "Precision Swing Point", subtitle: "Correlated markets close in opposite colours", panels: [
      { label: "NQ closes up", bars: [row(30, 38, 28, 36), row(36, 44, 34, 42), row(42, 50, 40, 48), row(48, 56, 46, 54), row(54, 66, 52, 64), row(64, 66, 56, 58)], marks: [{ type: "circle", at: "5:mid", color: "red" }] },
      { label: "ES closes down", bars: [row(30, 38, 28, 36), row(36, 44, 34, 42), row(42, 50, 40, 48), row(48, 56, 46, 54), row(54, 62, 50, 52), row(52, 54, 44, 46)], marks: [{ type: "circle", at: "5:mid", color: "red" }, { type: "note", at: "5:low", text: "PSP", color: "ink" }] }] },
  },
  ...SMT_TEMPLATES,
  ...PROFILE_TEMPLATES,
];

/** The fractal model built up one candle at a time: the candles still to come are drawn pale, so the scale never jumps between slides. */
function fractalSteps() {
  const bars = [row(40, 62, 36, 58), row(58, 60, 22, 44), row(44, 78, 40, 74), row(74, 92, 70, 88)];
  const slide = (title, subtitle, label, future, marks) => ({ title, subtitle, panels: [{ label, numbers: true, bars, future, marks }] });
  const range = [{ type: "level", at: "1:high", label: "C1 high", color: "blue", dash: "dashed", from: 1, to: 4 }, { type: "level", at: "1:low", label: "C1 low", color: "red", dash: "dashed", from: 1, to: 4 }];
  return [
    slide("Fractal Model: C1 Sets the Range", "The first candle's high and low are the levels everything else reacts to", "Candle 1: the range", 3, range),
    slide("Fractal Model: C2 Takes Liquidity", "C2 runs through one side of C1, then closes back inside", "Candle 2: the sweep", 2, [...range, { type: "circle", at: "2:low", color: "red" }, { type: "note", at: "2:low", text: "C2 sweep", color: "ink" }]),
    slide("Fractal Model: C3 Expands", "C3 leaves the sweep and runs through the other side of C1", "Candle 3: the expansion", 1, [...range, { type: "circle", at: "2:low", color: "red" }, { type: "arrow", from: "2:low", to: "3:high", color: "teal", curve: -.25, label: "C3 expansion" }]),
    slide("Fractal Model: C4 Continues", "C4 carries on in the direction of the expansion", "Candle 4: the continuation", 0, [...range, { type: "arrow", from: "2:low", to: "3:high", color: "teal", curve: -.25, label: "C3 expansion" }, { type: "arrow", from: "3:high", to: "4:high", color: "teal", curve: -.15, label: "C4" }]),
  ];
}

const SWAP = { high: "low", low: "high", top: "bottom", bottom: "top" };
const mirrorAnchor = a => {
  const s = String(a ?? "");
  const f = /^(\s*-?\d+(?:\.\d+)?\s*):@(\d(?:\.\d+)?)\s*$/.exec(s);
  if (f) return `${f[1]}:@${(1 - Number(f[2])).toFixed(2)}`;
  const m = /^(\s*-?\d+(?:\.\d+)?\s*):\s*(\w+)\s*$/.exec(s);
  return m ? `${m[1]}:${SWAP[m[2].toLowerCase()] ?? m[2]}` : s;
};
/** The same diagram upside down: candles flipped, every anchor mirrored; titles that name the direction swap it. */
export function mirror(spec) {
  const PAIRS = ["Bullish:Bearish", "bullish:bearish", "higher:lower", "Higher:Lower", "high:low", "High:Low", "above:below", "Above:Below", "up:down", "Up:Down", "buy:sell", "Buy:Sell", "SSL:BSL", "premium:discount", "Premium:Discount", "resistance:support", "Sweep low:Sweep high"];
  const MAP = {}; for (const p of PAIRS) { const [a, b] = p.split(":"); MAP[a] = b; MAP[b] = a; }
  // "higher timeframe" is about the chart, not the price, so it stays.
  const flip = t => String(t ?? "").replace(/\b(?:higher|lower) timeframe\b|\b(?:Bullish|Bearish|bullish|bearish|higher|lower|Higher|Lower|high|low|High|Low|above|below|Above|Below|up|down|Up|Down|buy|sell|Buy|Sell|SSL|BSL|premium|discount|Premium|Discount|resistance|support)\b/g, w => MAP[w] ?? w);
  return {
    ...spec, title: flip(spec.title), subtitle: flip(spec.subtitle),
    caption: flip(spec.caption), assumed: flip(spec.assumed),
    panels: spec.panels.map(p => ({
      ...p, label: flip(p.label), chip: p.chip, flip: !p.flip,
      marks: (p.marks ?? []).map(m => ({ ...m, ...(m.from ? { from: mirrorAnchor(m.from) } : {}), ...(m.to ? { to: mirrorAnchor(m.to) } : {}), ...(m.at ? { at: mirrorAnchor(m.at) } : {}), ...(m.label ? { label: flip(m.label) } : {}), ...(m.twin ? { twin: m.twin.map(s => s === "bull" ? "bear" : "bull") } : {}), ...(m.text ? { text: flip(m.text) } : {}) })),
    })),
  };
}
/** A template for a direction ("bullish" or "bearish"). */
export function fromTemplate(id, direction) {
  const t = TEMPLATES.find(x => x.id === id);
  if (!t) return null;
  const want = /bear|short|sell|down/i.test(direction ?? "") ? "bear" : "bull";
  return want === t.native ? t.spec : mirror(t.spec);
}
/** The step-by-step set of a template (each step a spec), in a direction; [] if it has none. */
export function stepsFromTemplate(id, direction) {
  const t = TEMPLATES.find(x => x.id === id);
  if (!t?.steps) { const one = fromTemplate(id, direction); return one ? [one] : []; }
  const want = /bear|short|sell|down/i.test(direction ?? "") ? "bear" : "bull";
  return want === t.native ? t.steps : t.steps.map(mirror);
}
export const templateList = () => TEMPLATES.map(t => `${t.id}: ${t.name}: ${t.about}${t.steps ? ` (has ${t.steps.length} steps)` : ""} (drawn ${t.native === "bull" ? "bullish" : "bearish"} by default)`).join("\n");


