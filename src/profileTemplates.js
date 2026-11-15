/**
 * Diagrams drawn from the owner's own PDFs (the "Ideal Profile" document: the ideal profile, the ideal London reversal, the ideal New York
 * reversal). Candle rows are [open, high, low, close]. Drawn bullish (the manipulation wick takes a LOW, then price expands up);
 * mirrored for the bearish version.
 */
const row = (...r) => r;

const HTF = [ // 1H/4H candles: the previous session consolidates or retraces, a wick takes the 1H/4H swing low, then price expands away
  row(101, 103, 99, 100), row(100, 102, 96, 97), row(97, 101, 93, 99), row(99, 100, 95, 96), row(96, 98, 94, 95), row(95, 97, 92, 93),
  row(93, 100, 88, 99), row(99, 106, 97, 105), row(105, 108, 102, 103), row(103, 112, 102, 111), row(111, 118, 109, 116), row(116, 124, 114, 122),
];
const ASIA_LONDON = [ // Asia consolidates (1-10), London takes the Asian low (12) and expands
  row(100, 103, 98, 99), row(99, 102, 97, 101), row(101, 104, 99, 100), row(100, 103, 96, 98), row(98, 101, 95, 100), row(100, 102, 96, 97), row(97, 101, 95.5, 100),
  row(100, 103, 97, 98), row(98, 101, 96, 99), row(99, 102, 96.5, 97.5),
  row(97.5, 99, 94, 95), row(95, 97, 88, 96.5), row(96.5, 104, 95, 103), row(103, 106, 100, 101), row(101, 109, 100, 108), row(108, 113, 106, 112),
  row(112, 116, 109, 110), row(110, 119, 109, 118), row(118, 124, 116, 123), row(123, 126, 119, 121), row(121, 130, 120, 129), row(129, 132, 126, 127),
];
const NY = [ // Asia drifts down (1-7), London consolidates lower (8-15), New York takes the 1H/4H swing low at 8:30/9:30 (18) and expands
  row(110, 111, 108, 109), row(109, 110, 106, 107), row(107, 109, 105, 108), row(108, 109, 104, 105), row(105, 106, 102, 103), row(103, 105, 101, 104), row(104, 105, 100, 101),
  row(101, 103, 98, 99), row(99, 101, 96, 97), row(97, 99, 93, 94), row(94, 97, 92, 96), row(96, 98, 93, 94), row(94, 95, 91, 92), row(92, 95, 90, 94), row(94, 96, 91, 92),
  row(92, 93, 89, 90), row(90, 92, 86, 87), row(87, 90, 80, 89), row(89, 98, 88, 97), row(97, 103, 95, 102), row(102, 106, 100, 101), row(101, 110, 100, 109), row(109, 116, 107, 115), row(115, 119, 112, 113),
];

export const PROFILE_TEMPLATES = [
  { id: "ideal-profile", name: "Ideal profile (1H/4H wick takes a swing, then the daily expands away)", native: "bull",
    about: "from the owner's Ideal Profile PDF: the previous session consolidates or retraces, the high or low of day wick forms by manipulating a 1H/4H swing, and a protected swing is created for the daily candle body to expand away from; paired with a volatility driver or SMT",
    spec: { title: "Ideal Profile", subtitle: "A wick takes the 1H/4H swing, then the daily candle expands away", caption: "Previous session consolidates, a wick takes the swing, the day expands away.", assumed: "Assumed: bullish, 1H/4H into the daily.", divider: true, panels: [
      { chip: "H1/H4", label: "Consolidate or retrace, then a wick takes the swing low", numbers: false, range: [84, 128], bars: HTF, marks: [
        { type: "level", at: "3:low", label: "swing low", color: "blue", dash: "dashed", from: 3, to: 9 },
        { type: "circle", at: "7:low", color: "red" }, { type: "note", at: "7:low", text: "wick takes the swing", color: "ink" },
        { type: "arrow", from: "8:high", to: "12:high", color: "teal", curve: -.15, label: "expansion" }] },
      { chip: "Daily", label: "Daily expansion", numbers: false, range: [84, 128], bars: [row(99, 125, 88, 123)], marks: [
        { type: "level", at: "1:low", label: "manipulation", color: "red", dash: "dashed", from: 1, to: 1 }] }] } },

  { id: "ideal-london", name: "Ideal London reversal (London takes the Asian range, paired with SMT)", native: "bull",
    about: "from the owner's Ideal Profile PDF: the Asia session consolidates or retraces, the high or low of day wick forms by manipulating the Asian range, creating a protected swing for the candle body to expand away from; paired with SMT",
    spec: { title: "Ideal London Reversal", subtitle: "London takes the Asian range, then expands away", caption: "Asia consolidates, London's wick takes the range, paired with SMT.", assumed: "Assumed: bullish, Asia into London.", panels: [
      { numbers: false, bars: ASIA_LONDON, marks: [
        { type: "zone", from: "3:high", to: "5:low", fromBar: 1, toBar: 10, color: "zone", label: "Asia" },
        { type: "level", at: "5:low", label: "Asian low", color: "blue", dash: "dashed", from: 1, to: 13 },
        { type: "circle", at: "12:low", color: "red" }, { type: "note", at: "12:low", text: "London reversal", color: "ink" },
        { type: "arrow", from: "13:low", to: "22:high", color: "teal", curve: -.2, label: "expansion" }] }] } },

  { id: "ideal-ny", name: "Ideal New York reversal (NY wick at 8:30/9:30 takes a 1H/4H swing)", native: "bull",
    about: "from the owner's Ideal Profile PDF: the previous sessions consolidate or retrace, a New York wick around 8:30/9:30 takes a 1H/4H swing high or low, creating a protected swing for the body to expand away from; paired with a volatility driver or SMT",
    spec: { title: "Ideal New York Reversal", subtitle: "A New York wick at 8:30/9:30 takes the swing, then price expands", caption: "Asia and London build the swing, New York takes it, the body expands away.", assumed: "Assumed: bullish, Asia, London, New York.", panels: [
      { numbers: false, bars: NY, marks: [
        { type: "level", at: "14:low", label: "", color: "blue", dash: "dashed", from: 8, to: 18 }, { type: "note", at: "9:low", text: "1H/4H swing low", color: "ink" },
        { type: "note", at: "3:high", text: "Asia", color: "ink" }, { type: "note", at: "10:high", text: "London", color: "ink" },
        { type: "circle", at: "18:low", color: "red" }, { type: "note", at: "18:low", text: "New York reversal 8:30 / 9:30", color: "ink" },
        { type: "arrow", from: "19:low", to: "24:high", color: "teal", curve: -.2, label: "expansion" }] }] } },
];
