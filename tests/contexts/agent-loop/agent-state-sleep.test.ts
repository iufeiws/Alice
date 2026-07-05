import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentStateController } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { memoryStore, persistedSnapshot } from "./agent-state-helpers.js";

test("going_to_sleep moves to sleeping at the next transition", () => {
  let current = new Date("2026-05-25T00:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: () => 0
  });

  controller.setState("going_to_sleep", { durationMs: 1 });
  current = new Date("2026-05-25T00:00:00.001Z");
  controller.tick();
  assert.equal(controller.getSnapshot().state, "sleeping");
  assert.equal(controller.getSnapshot().nextTransitionAt, "2026-05-25T06:00:00.001");
  assert.equal(controller.canRunHeartbeat(), false);
  assert.equal(controller.canReplyToInbound(), false);
});

test("sleeping moves back to waiting at the next transition", () => {
  let current = new Date("2026-05-25T00:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: () => 0
  });

  controller.setState("sleeping", { durationMs: 1 });
  current = new Date("2026-05-25T00:00:00.001Z");
  controller.tick();
  assert.equal(controller.getSnapshot().state, "waiting");
});

test("going_to_sleep postpones sleep on inbound messages without cancelling the cocoon", () => {
  let current = new Date("2026-05-24T16:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    timeZone: "Asia/Shanghai",
    random: () => 0
  });

  controller.setState("going_to_sleep", {
    sleepCocoonEnteredAt: "2026-05-25T00:00:00.000",
    sleepDurationMs: 8 * 60 * 60 * 1000
  });
  assert.equal(controller.getSnapshot().nextTransitionAt, "2026-05-25T00:05:00.000");

  current = new Date("2026-05-24T16:03:00.000Z");
  controller.noteInboundMessage();
  assert.equal(controller.getSnapshot().state, "going_to_sleep");
  assert.equal(controller.getSnapshot().lastInboundAt, "2026-05-25T00:03:00.000");
  assert.equal(controller.getSnapshot().nextTransitionAt, "2026-05-25T00:08:00.000");
  assert.equal(controller.getSnapshot().sleepCocoonEnteredAt, "2026-05-25T00:00:00.000");
  assert.equal(controller.getSnapshot().sleepDurationMs, 8 * 60 * 60 * 1000);

  current = new Date("2026-05-24T16:07:59.999Z");
  controller.tick();
  assert.equal(controller.getSnapshot().state, "going_to_sleep");

  current = new Date("2026-05-24T16:08:00.000Z");
  controller.tick();
  assert.equal(controller.getSnapshot().state, "sleeping");
  assert.equal(controller.getSnapshot().reason, "sleep_started");
});

test("sleeping transition uses persisted sleep cocoon duration", () => {
  let current = new Date("2026-05-25T00:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: () => 0
  });

  controller.setState("going_to_sleep", {
    durationMs: 1,
    sleepCocoonEnteredAt: "2026-05-25T00:00:00.000",
    sleepDurationMs: 90 * 60 * 1000
  });
  current = new Date("2026-05-25T00:00:00.001Z");
  controller.tick();

  assert.equal(controller.getSnapshot().state, "sleeping");
  assert.equal(controller.getSnapshot().nextTransitionAt, "2026-05-25T01:30:00.001");
});

test("clearSleepCocoon removes sleep cocoon pointers", () => {
  const controller = createAgentStateController({
    store: memoryStore(persistedSnapshot({
      state: "going_to_sleep",
      sleepCocoonEnteredAt: "2026-05-25T00:00:00.000",
      sleepDurationMs: 27_000_000,
      sleepCocoonAutoCheckedAt: "2026-05-25T22:00:00.000"
    }))
  });

  controller.setState("waiting", { reason: "force_wake", clearSleepCocoon: true });

  assert.equal(controller.getSnapshot().sleepCocoonEnteredAt, undefined);
  assert.equal(controller.getSnapshot().sleepDurationMs, undefined);
  assert.equal(controller.getSnapshot().sleepCocoonAutoCheckedAt, undefined);
});
