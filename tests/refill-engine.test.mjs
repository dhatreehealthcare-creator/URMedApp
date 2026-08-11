import assert from "node:assert/strict";
import test from "node:test";
import { effectiveRefillStatus, estimateRefillDueDate, validateRefillDate } from "../lib/refill-engine.ts";

test("estimates a refill date from delivery using UTC calendar days", () => {
  assert.equal(estimateRefillDueDate("2026-08-11T23:30:00.000Z", 30), "2026-09-10");
});

test("classifies active, due, overdue and snoozed reminders", () => {
  const today = new Date("2026-08-11T12:00:00.000Z");
  assert.equal(effectiveRefillStatus({ status: "active", dueDate: "2026-08-12" }, today), "active");
  assert.equal(effectiveRefillStatus({ status: "active", dueDate: "2026-08-11" }, today), "due");
  assert.equal(effectiveRefillStatus({ status: "active", dueDate: "2026-08-10" }, today), "overdue");
  assert.equal(effectiveRefillStatus({ status: "active", dueDate: "2026-08-10", snoozedUntil: "2026-08-14" }, today), "snoozed");
});

test("limits customer reminder dates to a valid one-year window", () => {
  const today = new Date("2026-08-11T12:00:00.000Z");
  assert.equal(validateRefillDate("2027-08-11", today), "2027-08-11");
  assert.throws(() => validateRefillDate("2027-08-12", today), /one year/);
  assert.throws(() => validateRefillDate("not-a-date", today), /valid reminder date/);
});
