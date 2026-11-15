import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { periodRows, cardSvg } from "../src/cards.js";
import { fonts } from "../src/render.js";

const rows = ["2026-11-02", "2026-11-05", "2026-11-09", "2026-10-30"].map((d, i) => ({ id: i, trade_date: d, pnl: 100 * (i + 1), r_multiple: 1, instrument: "MNQ", direction: "long" }));
const day = DateTime.fromISO("2026-11-05", { zone: "America/New_York" });

test("a week is Monday to Sunday and a month is the calendar month", () => {
  assert.deepEqual(periodRows(rows, "weekly", day).map(r => r.trade_date), ["2026-11-02", "2026-11-05"]);
  assert.deepEqual(periodRows(rows, "monthly", day).map(r => r.trade_date), ["2026-11-02", "2026-11-05", "2026-11-09"]);
  assert.deepEqual(periodRows(rows, "daily", day).map(r => r.trade_date), ["2026-11-05"]);
  assert.equal(periodRows(rows, "weekly", day.plus({ weeks: 5 })).length, 0);
});

test("the weekly and monthly cards draw from those trades", async () => {
  fonts(); // the card code measures text with a throwaway canvas
  const config = { cards: { style: {} } };
  for (const kind of ["weekly", "monthly"]) assert.match((await cardSvg(kind, rows, config, day)).svg, /<svg/);
});
