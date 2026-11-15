import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { zoneName, ZONE } from "../src/calendar/feed.js";
import { find } from "../src/milestones.js";
import { DEFAULTS } from "../src/config.js";

test("times follow daylight saving: the same 08:30 release is labelled EST in winter and EDT in summer", () => {
  const winter = DateTime.fromISO("2026-12-04T13:30:00Z", { setZone: true }).setZone(ZONE);
  const summer = DateTime.fromISO("2026-07-02T12:30:00Z", { setZone: true }).setZone(ZONE);
  assert.equal(winter.toFormat("h:mm a"), "8:30 AM"); assert.equal(zoneName(winter), "EST");
  assert.equal(summer.toFormat("h:mm a"), "8:30 AM"); assert.equal(zoneName(summer), "EDT");
});

test("an instant keeps its New York wall time across the clock change", () => {
  const before = DateTime.fromISO("2026-03-06T13:30:00Z", { setZone: true }).setZone(ZONE); // EST
  const after = DateTime.fromISO("2026-03-13T12:30:00Z", { setZone: true }).setZone(ZONE);  // EDT, one hour earlier in UTC
  assert.equal(before.toFormat("HH:mm"), after.toFormat("HH:mm"));
});

test("milestones: a 3-win streak is found once, and a thin month has no win rate", () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, trade_date: `2026-11-0${i + 1}`, created_at: `2026-11-0${i + 1}T10:00:00Z`, pnl: i === 0 ? -100 : 200, r_multiple: i === 0 ? -1 : 2 }));
  const found = find(rows, DEFAULTS);
  assert.ok(found.some(m => m.key.startsWith("ms:streak:3:")));
  assert.ok(!found.some(m => m.key.startsWith("ms:wr:")));
});
