import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentStateController, type AgentBehaviorState } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { memoryStore } from "./agent-state-helpers.js";

test("agent state returns documented delay ranges", () => {
  assertDelay("idle", 0, 20_000);
  assertDelay("idle", 1, 120_000);
  assertDelay("away", 0, 5 * 60_000);
  assertDelay("away", 1, 30 * 60_000);
  assertDelay("curious", 0, 8_000);
  assertDelay("curious", 1, 12_000);
  assertDelay("test", 0.5, 8_000);
  assertDelay("waiting", 0, 8_000);
  assertDelay("waiting", 1, 15_000);
  assertDelay("going_to_sleep", 1, 15_000);
});

test("calling remains active without an automatic inactive deadline", () => {
  const controller = createAgentStateController({
    store: memoryStore(),
    random: () => 0
  });

  controller.setState("calling", { reason: "talk_session_opened" });

  assert.equal(controller.getSnapshot().state, "calling");
  assert.equal(controller.getSnapshot().reason, "talk_session_opened");
  assert.equal(controller.getSnapshot().responseDelayMs, 0);
  assert.equal(controller.getSnapshot().nextTransitionAt, undefined);
  assert.equal(controller.canReplyToInbound(), true);
  assert.equal(controller.canRunHeartbeat(), true);
});

function assertDelay(state: AgentBehaviorState, randomValue: number, expected: number): void {
  const controller = createAgentStateController({
    store: memoryStore(),
    random: () => randomValue
  });

  controller.setState(state, { durationMs: 1 });

  assert.equal(controller.getInboundDelayMs(), expected);
  assert.equal(controller.getSnapshot().responseDelayMs, expected);
}
