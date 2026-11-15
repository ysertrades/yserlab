/**
 * The control panel's settings. They live in Supabase (table bot_config, edited from the YSER Lab page in the app); the bot reads
 * them every few seconds, so a change in the app takes effect without a restart. Anything missing falls back to these defaults.
 */
export const DEFAULTS = {
  /** Stops every post and every answer. Pause one feature with its own switch instead. */
  paused: false,
  /** Writes what would be posted to the log instead of sending it. */
  dryRun: false,
  /** Discord ids that are tagged on news alerts and may use the bot's features (the owner always may). */
  admins: [],
  cards: {
    daily: { on: false, channels: [], time: "17:30" },
    weekly: { on: false, channels: [], day: 5, time: "17:30" },
    monthly: { on: false, channels: [], time: "18:00" },
    /** Where the "Post to Discord" button on a card in the app sends it. */
    manual: { channels: [] },
    /** The look of the weekly and monthly cards: the same choices as the calendar's share panel. */
    style: {
      week: { brand: true, pattern: true, pill: true, equity: true, stats: true, beads: true, best: true, weekdays: true, rings: "gradient", amounts: "usd", clear: false, title: "" },
      month: { brand: true, pattern: true, pill: true, equity: true, stats: true, beads: true, best: true, weekdays: true, rings: "gradient", amounts: "usd", clear: false, title: "" },
    },
    tradeCard: { dim: "medium", pnl: true, ruler: true, brand: false },
  },
  news: {
    /** Which releases are shown: any of High, Medium, Low. */
    impact: ["High", "Medium"],
    /** Only these currencies (USD, CAD...). Empty means all of them. */
    currencies: [],
    /** Today's news, every weekday morning. Nothing is posted on a day without news. */
    today: { on: false, channels: [], time: "07:30" },
    /** Tomorrow's news at the market open, Monday to Thursday (Sunday has the weekly one). Nothing on a day without news. */
    open: { on: false, channels: [], time: "18:00" },
    /** The week ahead, every Sunday. */
    weekly: { on: false, channels: [], time: "18:00" },
    /** Each release: a heads-up some minutes before and a post at the exact minute. */
    alerts: { on: false, channels: [], before: 15, atRelease: true, tag: true },
  },
  sessions: {
    on: false, channels: [], tag: true,
    items: [
      { name: "New York open", time: "09:30", before: 15, days: [1, 2, 3, 4, 5], note: "" },
    ],
  },
  milestones: { on: false, channels: [], streaks: [3, 5, 7, 10], winRates: [60, 70, 80], personalBests: true },
  ai: {
    on: true,
    /** "owner" answers only you; "admins" also answers the admins above. */
    access: "owner",
    /** Channels and forums where the bot answers without being tagged. */
    channels: [],
  },
};

const isObject = v => v && typeof v === "object" && !Array.isArray(v);
export function merge(base, over) {
  if (!isObject(base)) return over === undefined ? base : over;
  const out = { ...base };
  if (isObject(over)) for (const key of Object.keys(over)) out[key] = key in base ? merge(base[key], over[key]) : over[key];
  return out;
}
