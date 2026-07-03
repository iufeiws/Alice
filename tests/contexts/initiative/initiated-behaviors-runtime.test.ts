import test from "node:test";
import assert from "node:assert/strict";
import {
  createAgentInitiatedBehaviorRun,
  createAgentInitiatedBehaviorRunStore,
  defaultAgentInitiatedBehaviorPlans
} from "../../../src/contexts/initiative/src/domain/initiated-behavior.js";
import { tempPath } from "./initiated-behaviors-helpers.js";

test("initiated behavior run store aggregates randomized thirty minute buckets", () => {
  const store = createAgentInitiatedBehaviorRunStore();
  const plan = defaultAgentInitiatedBehaviorPlans.find((entry) => entry.id === "care")!;
  const run = createAgentInitiatedBehaviorRun({
    plan,
    triggeredAt: "2026-06-06T00:10:00.000Z",
    trigger: "randomized",
    result: "completed"
  });
  run.respondedWithin15m = true;
  store.record(run);

  const buckets = store.randomThirtyMinuteBuckets(new Date("2026-06-06T00:30:00.000Z"));
  assert.equal(buckets.at(-2)?.total, 1);
  assert.equal(buckets.at(-2)?.respondedWithin15m, 1);
});

test("initiated behavior run store persists and marks 15 minute responses", () => {
  const dbPath = tempPath("initiated-behavior-runs", "runs.sqlite");
  const plan = defaultAgentInitiatedBehaviorPlans.find((entry) => entry.id === "care")!;
  const store = createAgentInitiatedBehaviorRunStore({ dbPath });
  store.record(createAgentInitiatedBehaviorRun({
    plan,
    triggeredAt: "2026-06-06T08:00:00.000",
    triggeredAtUtc: "2026-06-06T00:00:00.000Z",
    trigger: "randomized",
    result: "completed",
    sessionId: "session"
  }));

  assert.equal(store.markRespondedWithin15m({
    sessionId: "session",
    respondedAt: "2026-06-06T00:10:00.000Z"
  }), 1);

  const reopened = createAgentInitiatedBehaviorRunStore({ dbPath });
  assert.equal(reopened.list(1)[0].respondedWithin15m, true);
  assert.equal(reopened.list(1)[0].triggeredAtUtc, "2026-06-06T00:00:00.000Z");
});

test("initiated behavior run store does not count pending responses as missed in buckets", () => {
  const store = createAgentInitiatedBehaviorRunStore({ dbPath: tempPath("initiated-behavior-runs-pending", "runs.sqlite") });
  const plan = defaultAgentInitiatedBehaviorPlans.find((entry) => entry.id === "care")!;
  store.record(createAgentInitiatedBehaviorRun({
    plan,
    triggeredAt: "2026-06-06T08:10:00.000",
    triggeredAtUtc: "2026-06-06T00:10:00.000Z",
    trigger: "randomized",
    result: "completed",
    sessionId: "session"
  }));

  const buckets = store.randomThirtyMinuteBuckets(new Date("2026-06-06T00:20:00.000Z"));
  const currentBucket = buckets.at(-1);
  assert.equal(currentBucket?.total, 1);
  assert.equal(currentBucket?.respondedWithin15m, 0);
  assert.equal(currentBucket?.notRespondedWithin15m, 0);
});

test("initiated behavior run store marks expired responses as missed", () => {
  const store = createAgentInitiatedBehaviorRunStore();
  const plan = defaultAgentInitiatedBehaviorPlans.find((entry) => entry.id === "care")!;
  store.record(createAgentInitiatedBehaviorRun({
    plan,
    triggeredAt: "2026-06-06T00:00:00.000Z",
    trigger: "randomized",
    result: "completed",
    sessionId: "session"
  }));

  assert.equal(store.finalizeExpiredResponses(new Date("2026-06-06T00:16:00.000Z")), 1);
  assert.equal(store.list(1)[0].respondedWithin15m, false);
});
