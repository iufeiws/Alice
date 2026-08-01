import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentStateController } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { memoryStore, persistedSnapshot } from "./agent-state-helpers.js";

test("waiting degrades to idle after inactivity", () => {
  let current = new Date("2026-05-25T00:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: () => 0
  });

  controller.start();
  assert.equal(controller.getSnapshot().state, "waiting");
  const deadline = Date.parse(`${controller.getSnapshot().nextTransitionAt}Z`);

  current = new Date(deadline - 1);
  controller.tick();
  assert.equal(controller.getSnapshot().state, "waiting");

  current = new Date(deadline);
  controller.tick();
  assert.equal(controller.getSnapshot().state, "idle");
});

test("inbound activity suspends inactive transitions until activity settles", () => {
  let current = new Date("2026-05-25T00:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: () => 0
  });

  controller.setState("idle", { durationMs: 1 });
  current = new Date("2026-05-25T00:00:00.001Z");
  controller.noteInboundMessage();

  assert.equal(controller.getSnapshot().nextTransitionAt, undefined);

  current = new Date("2026-05-25T01:00:00.000Z");
  controller.tick();
  assert.equal(controller.getSnapshot().state, "idle");

  controller.restartInactivityTimer();
  assert.notEqual(controller.getSnapshot().nextTransitionAt, undefined);
});

test("LLM activity suspends and restarts waiting inactivity from settlement time", () => {
  let current = new Date("2026-05-25T00:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: () => 0
  });

  current = new Date("2026-05-25T00:14:59.000Z");
  controller.suspendInactivityTimer();
  assert.equal(controller.getSnapshot().nextTransitionAt, undefined);

  current = new Date("2026-05-25T01:00:00.000Z");
  controller.tick();
  assert.equal(controller.getSnapshot().state, "waiting");

  controller.restartInactivityTimer();
  const deadline = Date.parse(`${controller.getSnapshot().nextTransitionAt}Z`);

  current = new Date(deadline - 1);
  controller.tick();
  assert.equal(controller.getSnapshot().state, "waiting");

  current = new Date(deadline);
  controller.tick();
  assert.equal(controller.getSnapshot().state, "idle");
});

test("idle timer routes to waiting, away, or idle by documented probabilities", () => {
  assertDueIdleRoute(0.24, "waiting");
  assertDueIdleRoute(0.3, "away");
  assertDueIdleRoute(0.9, "idle");
});

test("away returns to waiting after its timer", () => {
  let current = new Date("2026-05-25T00:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: () => 0
  });

  controller.setState("away", { durationMs: 1 });
  current = new Date("2026-05-25T00:00:00.001Z");
  controller.tick();

  assert.equal(controller.getSnapshot().state, "waiting");
  assert.equal(controller.getSnapshot().reason, "returned");
});

test("curious returns to waiting after inactivity", () => {
  let current = new Date("2026-05-25T00:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: () => 0
  });

  controller.setState("curious", { durationMs: 1 });
  current = new Date("2026-05-25T00:00:00.001Z");
  controller.tick();

  assert.equal(controller.getSnapshot().state, "waiting");
  assert.equal(controller.getSnapshot().reason, "inactive");
});

test("agent state applies documented post-message landing states", () => {
  const controller = createAgentStateController({
    store: memoryStore(),
    random: () => 0
  });

  controller.setState("idle");
  controller.noteInboundProcessed();
  assert.equal(controller.getSnapshot().state, "waiting");
  assert.equal(controller.getSnapshot().reason, "inbound_processed");

  controller.setState("waiting");
  controller.noteInboundProcessed();
  assert.equal(controller.getSnapshot().state, "waiting");

  controller.setState("curious");
  controller.noteInboundProcessed();
  assert.equal(controller.getSnapshot().state, "waiting");
  assert.equal(controller.getSnapshot().reason, "inbound_processed");

  controller.setState("going_to_sleep", { reason: "sleep_cocoon_in" });
  controller.noteInboundProcessed();
  assert.equal(controller.getSnapshot().state, "going_to_sleep");
  assert.equal(controller.getSnapshot().reason, "sleep_cocoon_in");

  controller.setState("serious");
  controller.noteInboundProcessed();
  assert.equal(controller.getSnapshot().state, "serious");

  controller.setState("test");
  controller.noteInboundProcessed();
  assert.equal(controller.getSnapshot().state, "test");
});

function assertDueIdleRoute(roll: number, expectedState: "waiting" | "away" | "idle"): void {
  const controller = createAgentStateController({
    store: memoryStore(persistedSnapshot({
      state: "idle",
      nextTransitionAt: "2026-05-24T23:59:59.999"
    })),
    now: () => new Date("2026-05-25T00:00:00.000Z"),
    random: () => roll
  });

  controller.tick();
  assert.equal(controller.getSnapshot().state, expectedState);
}
