import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentStateController } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { memoryStore, persistedSnapshot } from "./agent-state-helpers.js";

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

test("agent state restores sleep cocoon fields", () => {
  const controller = createAgentStateController({
    store: memoryStore(persistedSnapshot({
      state: "waiting",
      sleepCocoonEnteredAt: "2026-05-24T23:00:00.000",
      sleepDurationMs: 27_000_000,
      sleepCocoonAutoCheckedAt: "2026-05-25T21:00:00.000"
    }))
  });

  assert.equal(controller.getSnapshot().sleepCocoonEnteredAt, "2026-05-24T23:00:00.000");
  assert.equal(controller.getSnapshot().sleepDurationMs, 27_000_000);
  assert.equal(controller.getSnapshot().sleepCocoonAutoCheckedAt, "2026-05-25T21:00:00.000");
});

test("persisted deprecated working state recovers to a safe state", () => {
  const waiting = createAgentStateController({
    store: memoryStore(persistedSnapshot({
      state: "working"
    }))
  });
  assert.equal(waiting.getSnapshot().state, "waiting");

  const serious = createAgentStateController({
    store: memoryStore(persistedSnapshot({
      state: "working",
      previousState: "serious"
    }))
  });
  assert.equal(serious.getSnapshot().state, "serious");
});
