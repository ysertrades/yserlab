/**
 * The SMT / 2S / 3S / strength switch / PSP slides, exactly as the owner's method draws them (see smtLesson.js for the rules).
 * Three or four candles per panel. An SMT is a pair of NEIGHBOURING candles (c1,c2), (c2,c3), (c3,c4): each pair shares a candle
 * with the next. Drawn bullish (SMT on lows); mirrored for bearish. Candle rows are [open, high, low, close].
 * A PSP is the star plus its twin strip (the chart asset and the correlated asset closing in opposite colours).
 */
const row = (...r) => r;
const C1 = row(108, 109, 102, 104); // bearish
const LEFT = [C1, row(103, 104, 98, 100), row(101, 107, 100, 106)];  // lower low (weak), then higher low (strong)
const RIGHT = [C1, row(100, 104, 98, 103), row(103, 108, 102, 107)]; // lower low (weak) whose candle closes bullish: a PSP
const smt = (from, to, label, { solid = false, ss = false } = {}) => ({ type: "smt", from: `${from}:low`, to: `${to}:low`, style: solid || ss ? "solid" : "dashed", color: ss ? "ss" : "muted", label });
const psp = (at, blue, twin = ["bull", "bear"]) => ({ type: "psp", at: `${at}:low`, color: blue ? "ss" : "muted", twin });
const one = (t, rest) => ({ title: t.title, subtitle: t.subtitle, caption: t.caption, assumed: t.assumed ?? "Assumed: bullish, 6H, 3 candles.", panels: [{ numbers: true, ...rest }] });

export const SMT_TEMPLATES = [
  { id: "ss", name: "Strength switch: the two ways to see it (two SMTs, and SMT + PSP), side by side", native: "bull",
    about: "the default answer to any strength switch (SS) request: one slide, left two consecutive SMTs (weak leg then strong leg, no PSP needed), right one SMT plus a PSP that closes the SMT's way",
    spec: { title: "Strength Switch: two ways to see it", subtitle: "A sweep (weak leg) that flips to strength", caption: "Blue = Strength Switch. Each colour has its own reason.", assumed: "Assumed: bullish, 6H, 3 candles.", divider: true, panels: [
      { chip: "Two SMTs", numbers: true, label: "Weak leg, then a strong leg = SS. No PSP needed.", bars: LEFT, marks: [smt(1, 2, "6H"), smt(2, 3, "6H • SS", { ss: true })] },
      { chip: "SMT + PSP", numbers: true, label: "Weak leg + PSP closing bullish = SS. The star turns blue.", bars: RIGHT, marks: [smt(1, 2, "6H"), psp(2, true)] }] } },

  { id: "ss-two-smt", name: "Strength switch from two SMTs (weak then strong, no PSP)", native: "bull",
    about: "two consecutive SMTs: the first leg is weak (lower low), the second strong (higher low): an SS with a solid blue S2 line and no PSP",
    spec: one({ title: "Strength Switch From Two SMTs", subtitle: "Weak leg, then a strong leg", caption: "Weak leg, then a strong leg = SS. No PSP needed." }, { bars: LEFT, marks: [smt(1, 2, "6H"), smt(2, 3, "6H • SS", { ss: true })] }) },

  { id: "ss-psp", name: "Strength switch from an SMT plus a PSP", native: "bull",
    about: "one weak SMT whose last candle is a PSP that closes the SMT's way: the star turns blue (with the twin strip as evidence)",
    spec: one({ title: "Strength Switch From a PSP", subtitle: "A weak leg ending in a PSP that closes bullish", caption: "Weak leg + PSP closing bullish = SS. The star turns blue." }, { bars: RIGHT, marks: [smt(1, 2, "6H"), psp(2, true)] }) },

  { id: "stage-2s", name: "2S: two linked strong SMTs", native: "bull",
    about: "S1 strong then S2 strong, both solid neutral lines, label 6H • 2S (no strength switch)",
    spec: one({ title: "2S Stage", subtitle: "Two linked SMTs, both strong", caption: "Strong then strong = 2S. Neighbouring pairs share a candle." },
      { bars: [row(106, 108, 100, 102), row(102, 106, 101, 105), row(105, 109, 103, 108)], marks: [smt(1, 2, "6H", { solid: true }), smt(2, 3, "6H • 2S", { solid: true })] }) },

  { id: "stage-2s-order", name: "Strong then weak is 2S, not SS (order matters)", native: "bull",
    about: "S1 strong (higher low) then S2 weak (lower low): only a 2S, because an SS needs weak first",
    spec: one({ title: "Strong Then Weak = 2S", subtitle: "The order matters", caption: "Order matters: SS needs weak first." },
      { bars: [row(106, 108, 100, 102), row(102, 106, 101, 105), row(105, 106, 99, 101)], marks: [smt(1, 2, "6H", { solid: true }), smt(2, 3, "6H • 2S", { solid: true })] }) },

  { id: "stage-3s", name: "3S: three linked same-direction SMTs", native: "bull",
    about: "four candles, three neighbouring pairs, no weak-then-strong link: label 6H • 3S, all solid neutral",
    spec: one({ title: "3S Stage", subtitle: "Three linked SMTs on four candles", caption: "Three linked strong SMTs = 3S.", assumed: "Assumed: bullish, 6H, 4 candles." },
      { bars: [row(106, 108, 100, 102), row(102, 107, 101, 105), row(105, 108, 102, 106), row(106, 110, 103, 109)], marks: [smt(1, 2, "6H", { solid: true }), smt(2, 3, "6H • 2S", { solid: true }), smt(3, 4, "6H • 3S", { solid: true })] }) },

  { id: "ss-psp-s2", name: "SS with a PSP on S2 (the star stays neutral)", native: "bull",
    about: "weak then strong SMTs; the PSP sits on S2's last candle, where S2 is a strong leg, so its star is neutral while the S2 line is blue from the flip",
    spec: one({ title: "SS With a PSP on S2", subtitle: "The line is blue from the flip, the star is judged on its own leg", caption: "Blue line from the flip. S2 is strong, so its star stays neutral." },
      { bars: LEFT, marks: [smt(1, 2, "6H"), smt(2, 3, "6H • SS", { ss: true }), psp(3, false, ["bull", "bear"])] }) },

  { id: "ss-psp-s1", name: "Double confirmation: SS with a bullish PSP on the shared candle", native: "bull",
    about: "S1 weak with a bullish PSP on the shared candle (blue star), then a strong S2 (blue line): label 6H • SS",
    spec: one({ title: "SS With a PSP on S1", subtitle: "Double confirmation: blue star and blue line", caption: "Blue star: weak leg + PSP closing bullish. Blue line: the flip." },
      { bars: [C1, row(100, 104, 98, 103), row(103, 108, 100, 107)], marks: [smt(1, 2, "6H", { solid: true }), smt(2, 3, "6H • SS", { ss: true }), psp(2, true)] }) },

  { id: "psp-first", name: "PSP first: the PSP at the start of a weak leg turns the line blue", native: "bull",
    about: "a PSP on the first candle (pivot A) of a weak leg, closing the SMT's way: the LINE turns blue and the star stays neutral",
    spec: one({ title: "PSP First", subtitle: "A PSP at the start of a weak leg", caption: "PSP on the first candle: the line turns blue, the star stays neutral." },
      { bars: [row(100, 106, 98, 104), row(104, 105, 95, 97), row(97, 103, 96, 102)], marks: [{ type: "smt", from: "1:low", to: "2:low", style: "solid", color: "ss", label: "6H" }, psp(1, false)] }) },

  { id: "no-switch", name: "No switch: the PSP candle closed the wrong way", native: "bull",
    about: "a weak leg with a PSP, but the PSP candle closed bearish, against a bullish SMT: neutral star and neutral line",
    spec: one({ title: "No Switch", subtitle: "The PSP candle closed against the SMT", caption: "Weak leg, but the PSP candle closed bearish: no switch." },
      { bars: [C1, row(103, 104, 98, 99), row(99, 105, 98, 104)], marks: [smt(1, 2, "6H"), psp(2, false, ["bear", "bull"])] }) },

  { id: "below-15m", name: "Below 15M: SMT lines only, no PSP and no strength switch", native: "bull",
    about: "on charts below 15M there is no PSP, no star, no twin strip and no blue: only the SMT lines",
    spec: one({ title: "Below 15M", subtitle: "SMT lines only", caption: "PSP and SS are 15M and above.", assumed: "Assumed: bullish, 5M, 3 candles." },
      { bars: LEFT, marks: [smt(1, 2, "5M"), smt(2, 3, "5M")] }) },

  { id: "consecutive", name: "How consecutive-candle SMTs work (neighbouring pairs share a candle)", native: "bull",
    about: "four candles with brackets under c1-c2, c2-c3 and c3-c4: each SMT is a pair of neighbouring candles and pairs share a candle",
    spec: { title: "Consecutive Candle SMTs", subtitle: "One SMT = a pair of neighbouring candles", caption: "Neighbouring pairs share a candle.", assumed: "Assumed: bullish, 6H, 4 candles.", panels: [{ numbers: true,
      bars: [...LEFT, row(106, 109, 101, 108)], marks: [smt(1, 2, ""), smt(2, 3, ""), smt(3, 4, ""),
        { type: "bracket", from: 1, to: 2, row: 0, label: "c1–c2" }, { type: "bracket", from: 2, to: 3, row: 1, label: "c2–c3" }, { type: "bracket", from: 3, to: 4, row: 2, label: "c3–c4" }] }] } },
];
