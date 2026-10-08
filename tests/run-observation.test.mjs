import test from "node:test";
import assert from "node:assert/strict";
import {
  RUN_START_TIMEOUT_MS,
  hasRunStarted,
  isRunStartStalled,
} from "../lib/run-observation.ts";

function emptySnapshot(overrides = {}) {
  return {
    status: "running",
    createdAt: 1_000,
    latestStage: null,
    lastEventId: 0,
    progress: { totalCount: 0 },
    tasks: [],
    ...overrides,
  };
}

test("an empty run may wait until the startup deadline", () => {
  const snapshot = emptySnapshot();
  assert.equal(hasRunStarted(snapshot), false);
  assert.equal(
    isRunStartStalled(snapshot, 1_000 + RUN_START_TIMEOUT_MS - 1),
    false,
  );
});

test("an empty run is classified as stalled after the startup deadline", () => {
  assert.equal(
    isRunStartStalled(emptySnapshot(), 1_000 + RUN_START_TIMEOUT_MS),
    true,
  );
});

test("any progress signal permanently disables the startup watchdog", () => {
  const now = 1_000 + RUN_START_TIMEOUT_MS * 10;
  for (const snapshot of [
    emptySnapshot({ latestStage: "request.received" }),
    emptySnapshot({ lastEventId: 1 }),
    emptySnapshot({ progress: { totalCount: 1 } }),
    emptySnapshot({ tasks: [{ taskId: "agent-1" }] }),
    emptySnapshot({ status: "completed" }),
  ]) {
    assert.equal(hasRunStarted(snapshot), true);
    assert.equal(isRunStartStalled(snapshot, now), false);
  }
});
