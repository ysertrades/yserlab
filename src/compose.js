/**
 * Two charts that belong together: a higher-timeframe idea (a closure, the fractal model) on top and, under it, the lower-timeframe
 * candles that make it up, drawn body to body (see `stack` in diagram.js). The lower candles are not drawn by hand: each one is cut
 * out of the higher candle it sits under (same open, high, low and close for the group), with the entry model (a CISD) built in.
 * Rows are [open, high, low, close]; everything here is bullish, and a bearish request is the mirror of it.
 */
const seeded = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

/**
 * The lower-timeframe candles of a run of higher-timeframe candles, `g` under each. Candle `sweep` (0-based) is the one whose low is
 * taken: it opens, pushes up a little, runs down to the low (a down-closing run), then climbs back to its close. Returns the candles
 * and where the CISD is: the run that was swept starts at `run` (its open is the CISD level), `low` is the candle with the low, `cisd`
 * the first candle after it to close back above that level.
 */
export function ltfFromHtf(rows, { g = 5, sweep = -1, seed = 11 } = {}) {
  const rnd = seeded(seed), out = [];
  let info = null;
  rows.forEach(([o, h, l, c], i) => {
    const range = h - l || 1, from = out.length;
    let path;
    if (i === sweep) {
      let b = h > o ? o + .28 * (h - o) : o; // a small push up first, so the run that gets swept has a clear start
      if (c <= b) b = o;
      path = [[0, o], [.14, b], [.45, l], [1, c]];
    } else path = c >= o ? [[0, o], [.3, l], [.75, h], [1, c]] : [[0, o], [.3, h], [.75, l], [1, c]];
    const at = t => { for (let k = 1; k < path.length; k++) if (t <= path[k][0]) { const [t0, v0] = path[k - 1], [t1, v1] = path[k]; return v0 + (v1 - v0) * (t - t0) / (t1 - t0); } return c; };
    const group = [];
    for (let j = 0; j < g; j++) {
      let so = at(j / g), sc = at((j + 1) / g);
      if (j > 0) so = group[j - 1][3];
      if (j > 0 && j < g - 1 && !(i === sweep && j >= 1 && j <= 3)) sc += (rnd() - .5) * range * .07; // a little noise, but never on the swept run
      if (j === g - 1) sc = c;
      sc = Math.min(h, Math.max(l, sc));
      const wick = range * (.025 + rnd() * .04);
      group.push([so, Math.min(h, Math.max(so, sc) + wick), Math.max(l, Math.min(so, sc) - wick), sc]);
    }
    // The extremes of the higher candle are made by one lower candle each.
    let hi = 0, lo = 0;
    group.forEach((r, j) => { if (Math.max(r[0], r[3]) > Math.max(group[hi][0], group[hi][3])) hi = j; if (Math.min(r[0], r[3]) < Math.min(group[lo][0], group[lo][3])) lo = j; });
    group[hi][1] = h; group[lo][2] = l;
    group.forEach(r => out.push(r.map(v => +v.toFixed(4))));
    if (i === sweep) {
      const down = k => out[k][3] < out[k][0];
      const m = from + lo;
      let s = down(m) ? m : m - 1;
      while (s - 1 >= from && down(s - 1)) s--;
      if (s >= from) {
        const level = out[s][0];
        let j = -1;
        for (let k = m + 1; k < from + g; k++) if (out[k][3] > level) { j = k; break; }
        info = { run: s, low: m, level, cisd: j };
      }
    }
  });
  return { rows: out, info };
}

/** The marks that name the CISD on the lower-timeframe candles (1-based candle numbers), and the entry at the open of the next higher candle. */
export function cisdMarks(info, entryBar) {
  if (!info) return [];
  const marks = [{ type: "circle", at: `${info.low + 1}:low`, color: "red" }];
  if (info.cisd >= 0) {
    marks.push({ type: "level", at: `${info.run + 1}:open`, label: "", color: "blue", from: info.run + 1, to: info.cisd + 1 });
    marks.push({ type: "circle", at: `${info.cisd + 1}:close`, color: "teal", r: 28 });
    marks.push({ type: "note", at: `${info.cisd + 1}:high`, text: "CISD", color: "ink" });
  }
  if (entryBar) marks.push({ type: "dot", at: `${entryBar}:open`, color: "teal" }, { type: "note", at: `${entryBar}:open`, text: "Entry", color: "ink", dx: 20, dy: 40 });
  return marks;
}
