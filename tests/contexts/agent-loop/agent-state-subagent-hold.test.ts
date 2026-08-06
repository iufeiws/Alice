import test from "node:test";
import assert from "node:assert/strict";
import { createAgentStateController } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";

test("Pi SubAgent activity hold keeps Chat state waiting without a deadline", () => {
  const content = { value: "" };
  const state = createAgentStateController({
    store: {
      read: () => content.value,
      write: (next) => { content.value = next; }
    },
    now: () => new Date("2026-08-05T03:00:00.000Z"),
    random: () => 0.5
  });
  state.setState("idle");
  state.acquirePiSubAgentHold();
  assert.equal(state.getSnapshot().state, "waiting");
  assert.equal(state.getSnapshot().nextTransitionAt, undefined);
  assert.throws(() => state.setState("idle"), /agent_state_waiting_locked/);
  state.releasePiSubAgentHold();
  assert.equal(state.getSnapshot().state, "waiting");
  assert.ok(state.getSnapshot().nextTransitionAt);
});
