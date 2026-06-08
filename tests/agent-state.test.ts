import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentStateController, type AgentStateStore } from "../src/core/agent/src/state.js";

test("agent state defaults from missing or corrupt JSON", () => {
  const missing = createAgentStateController({
    store: memoryStore()
  });
  assert.equal(missing.getSnapshot().state, "waiting");
  assert.equal(missing.getSnapshot().intimacy, 50);

  const corrupt = createAgentStateController({
    store: memoryStore("not-json")
  });
  assert.equal(corrupt.getSnapshot().state, "waiting");
  assert.equal(corrupt.getSnapshot().intimacy, 50);
});

test("agent state clamps and persists intimacy", () => {
  const store = memoryStore();
  const controller = createAgentStateController({
    store
  });

  controller.setIntimacy(130);
  assert.equal(controller.getSnapshot().intimacy, 100);
  assert.ok(store.content?.includes('"intimacy": 100'));

  controller.setIntimacy(-5);
  assert.equal(controller.getSnapshot().intimacy, 0);
});

test("agent state reports persistence failures without blocking state updates", () => {
  const errors: unknown[] = [];
  const controller = createAgentStateController({
    store: {
      read() {
        return undefined;
      },
      write() {
        throw new Error("disk full");
      }
    },
    onPersistError(error) {
      errors.push(error);
    }
  });

  controller.setIntimacy(80);
  assert.equal(controller.getSnapshot().intimacy, 80);
  assert.equal(errors.length, 1);
});

test("agent state writes current-time fields in the configured timezone", () => {
  let current = new Date("2026-05-25T00:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    timeZone: "Asia/Shanghai",
    random: () => 0
  });

  controller.start();
  assert.equal(controller.getSnapshot().updatedAt, "2026-05-25T08:00:00.000");
  assert.equal(controller.getSnapshot().nextTransitionAt, "2026-05-25T08:15:00.000");

  current = new Date("2026-05-25T00:05:00.000Z");
  controller.tick();
  assert.equal(controller.getSnapshot().state, "waiting");

  current = new Date("2026-05-25T00:15:00.000Z");
  controller.tick();
  assert.equal(controller.getSnapshot().state, "idle");
  assert.equal(controller.getSnapshot().updatedAt, "2026-05-25T08:15:00.000");
});

test("agent state returns documented delay ranges", () => {
  const random = randomQueue([0, 1, 0.5, 0.25, 0, 1]);
  const controller = createAgentStateController({
    store: memoryStore(),
    random
  });

  controller.setState("idle", { durationMs: 1 });
  assert.equal(controller.getInboundDelayMs(), 120_000);
  assert.equal(controller.getSnapshot().responseDelayMs, 120_000);

  controller.setState("away", { durationMs: 1 });
  assert.equal(controller.getInboundDelayMs(), 17.5 * 60_000);

  controller.setState("curious", { durationMs: 1 });
  assert.equal(controller.getInboundDelayMs(), 9_000);

  controller.setState("test", { durationMs: 1 });
  assert.equal(controller.getInboundDelayMs(), 8_000);
  assert.equal(controller.getSnapshot().responseDelayMs, 8_000);

  controller.setState("waiting", { durationMs: 1 });
  assert.equal(controller.getInboundDelayMs(), 8_000);

  controller.setState("going_to_sleep", { durationMs: 1 });
  assert.equal(controller.getInboundDelayMs(), 15_000);
});

test("waiting degrades to idle after inactivity", () => {
  let current = new Date("2026-05-25T00:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: () => 0
  });

  controller.start();
  assert.equal(controller.getSnapshot().state, "waiting");

  current = new Date("2026-05-25T00:14:59.999Z");
  controller.tick();
  assert.equal(controller.getSnapshot().state, "waiting");

  current = new Date("2026-05-25T00:15:00.000Z");
  controller.tick();
  assert.equal(controller.getSnapshot().state, "idle");
});

test("idle inbound activity postpones no-message transition before processing", () => {
  let current = new Date("2026-05-25T00:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: () => 0
  });

  controller.setState("idle", { durationMs: 1 });
  current = new Date("2026-05-25T00:00:00.001Z");
  controller.noteInboundMessage();

  assert.equal(controller.getSnapshot().state, "idle");
  assert.equal(controller.getSnapshot().nextTransitionAt, "2026-05-25T00:05:00.001");

  controller.tick();
  assert.equal(controller.getSnapshot().state, "idle");
});

test("idle timer routes to waiting, away, or idle by documented probabilities", () => {
  const waiting = dueIdleController([0, 0, 0.24]);
  waiting.tick();
  assert.equal(waiting.getSnapshot().state, "waiting");

  const away = dueIdleController([0, 0, 0.3]);
  away.tick();
  assert.equal(away.getSnapshot().state, "away");

  const idle = dueIdleController([0, 0, 0.9, 0]);
  idle.tick();
  assert.equal(idle.getSnapshot().state, "idle");
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

test("sleep flow moves from going_to_sleep to sleeping and back to waiting", () => {
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

  current = new Date("2026-05-25T06:00:00.001Z");
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

test("working hooks are deprecated no-ops for current states", () => {
  const controller = createAgentStateController({
    store: memoryStore(),
    random: () => 0
  });

  controller.setState("serious");
  controller.noteWorkStarted({ serious: true });
  assert.equal(controller.getSnapshot().state, "serious");

  controller.setState("test");
  controller.noteWorkStarted();
  assert.equal(controller.getSnapshot().state, "test");
  assert.equal(controller.getSnapshot().responseDelayMs, 8_000);

  controller.setState("going_to_sleep", { reason: "sleep_cocoon_in" });
  controller.noteWorkStarted();
  assert.equal(controller.getSnapshot().state, "going_to_sleep");
  assert.equal(controller.getSnapshot().reason, "sleep_cocoon_in");
});

test("work finish does not override non-working states", () => {
  const controller = createAgentStateController({
    store: memoryStore(),
    random: () => 0
  });

  controller.setState("going_to_sleep", { reason: "sleep_cocoon_in" });
  controller.noteWorkFinished();
  assert.equal(controller.getSnapshot().state, "going_to_sleep");
  assert.equal(controller.getSnapshot().reason, "sleep_cocoon_in");
});

test("persisted deprecated working state recovers to a safe state", () => {
  const waiting = createAgentStateController({
    store: memoryStore(JSON.stringify({
      state: "working",
      intimacy: 50,
      updatedAt: "2026-05-25T00:00:00.000",
      responseDelayMs: 1000
    }))
  });
  assert.equal(waiting.getSnapshot().state, "waiting");

  const serious = createAgentStateController({
    store: memoryStore(JSON.stringify({
      state: "working",
      previousState: "serious",
      intimacy: 50,
      updatedAt: "2026-05-25T00:00:00.000",
      responseDelayMs: 1000
    }))
  });
  assert.equal(serious.getSnapshot().state, "serious");
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

test("agent state restores sleep cocoon fields", () => {
  const initial = JSON.stringify({
    state: "waiting",
    intimacy: 50,
    updatedAt: "2026-05-25T00:00:00.000",
    responseDelayMs: 1000,
    sleepCocoonEnteredAt: "2026-05-24T23:00:00.000",
    sleepDurationMs: 27_000_000,
    sleepCocoonAutoCheckedAt: "2026-05-25T21:00:00.000"
  });
  const controller = createAgentStateController({
    store: memoryStore(initial)
  });

  assert.equal(controller.getSnapshot().sleepCocoonEnteredAt, "2026-05-24T23:00:00.000");
  assert.equal(controller.getSnapshot().sleepDurationMs, 27_000_000);
  assert.equal(controller.getSnapshot().sleepCocoonAutoCheckedAt, "2026-05-25T21:00:00.000");
});

test("clearSleepCocoon removes sleep cocoon pointers", () => {
  const controller = createAgentStateController({
    store: memoryStore(JSON.stringify({
      state: "going_to_sleep",
      intimacy: 50,
      updatedAt: "2026-05-25T00:00:00.000",
      responseDelayMs: 1000,
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

function memoryStore(initial?: string): AgentStateStore & { content?: string } {
  return {
    content: initial,
    read() {
      return this.content;
    },
    write(content) {
      this.content = content;
    }
  };
}

function dueIdleController(randomValues: number[]) {
  let current = new Date("2026-05-25T00:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: randomQueue(randomValues)
  });
  controller.setState("idle", { durationMs: 1 });
  current = new Date("2026-05-25T00:00:00.001Z");
  return controller;
}

function randomQueue(values: number[]): () => number {
  return () => values.shift() ?? 0;
}
