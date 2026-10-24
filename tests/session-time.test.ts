import test from "node:test";
import assert from "node:assert/strict";
import { sessionTiming, formatDuration } from "../apps/web/session-time.js";

const start = "2026-10-24T03:00:00.000Z", end = "2026-10-24T03:02:30.000Z";
const step = { status: "running", messages: [{ time: start }] };

test("Session timing uses the persisted first event and includes in-session approval waits", () => {
  const expected = { kind: "running", start: Date.parse(start) };
  assert.deepEqual(sessionTiming(step, { status: "running" }), expected);
  assert.deepEqual(sessionTiming({ ...step, status: "waiting_approval" }, { status: "waiting_approval" }), expected);
  assert.deepEqual(sessionTiming(step, { status: "cancelling" }), expected);
  assert.deepEqual(sessionTiming({ status: "waiting_approval", messages: [] }, { status: "waiting_approval" }), { kind: "pending" });
});

test("Completed sessions keep their own duration while reviews and later roles continue", () => {
  const completed = { ...step, status: "succeeded", completedAt: end };
  const expected = { kind: "completed", start: Date.parse(start), end: Date.parse(end) };
  for (const status of ["waiting_review", "paused", "running", "succeeded", "cancelled"]) {
    assert.deepEqual(sessionTiming(completed, { status, completedAt: "2026-10-25T03:00:00.000Z" }), expected);
  }
});

test("Cancelled sessions use the recorded stop time without starting queued sessions", () => {
  const run = { status: "cancelled", completedAt: end };
  assert.deepEqual(sessionTiming({ ...step, status: "cancelled" }, run), { kind: "completed", start: Date.parse(start), end: Date.parse(end) });
  assert.deepEqual(sessionTiming({ status: "cancelled", messages: [] }, run), { kind: "pending" });
  assert.deepEqual(sessionTiming({ status: "queued", messages: [] }, { status: "running" }), { kind: "pending" });
});

test("Missing or interrupted timing records do not turn into fabricated live durations", () => {
  for (const value of [
    sessionTiming(step, { status: "needs_reconciliation" }),
    sessionTiming({ ...step, status: "succeeded" }, { status: "running" }),
    sessionTiming({ ...step, status: "failed" }, { status: "failed" }),
    sessionTiming({ ...step, completedAt: "2026-10-24T02:00:00.000Z" }, { status: "running" }),
    sessionTiming({ ...step, messages: [{ time: "invalid" }] }, { status: "running" }),
  ]) assert.deepEqual(value, { kind: "unavailable" });
});

test("Session durations show seconds, hours and nonnegative clock differences", () => {
  assert.equal(formatDuration(0), "00:00");
  assert.equal(formatDuration(150999), "02:30");
  assert.equal(formatDuration(3600000), "01:00:00");
  assert.equal(formatDuration(3661000), "01:01:01");
  assert.equal(formatDuration(360001000), "100:00:01");
  assert.equal(formatDuration(-5000), "00:00");
});

test("Follow-up clocks measure the active reply without changing the original step duration", () => {
  const completed = { ...step, id: "coder", status: "succeeded", completedAt: end };
  const followup = { stepId: "coder", startedAt: "2026-10-24T04:00:00.000Z" };
  assert.deepEqual(sessionTiming({ ...completed, status: "running" }, { status: "running", followup }), { kind: "running", start: Date.parse(followup.startedAt) });
  assert.deepEqual(sessionTiming(completed, { status: "needs_reconciliation", followup }), { kind: "unavailable" });
  assert.deepEqual(sessionTiming(completed, { status: "succeeded" }), { kind: "completed", start: Date.parse(start), end: Date.parse(end) });
});
