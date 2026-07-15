import { test } from "node:test";
import assert from "node:assert/strict";
import { createProactiveEventConsumerTick, createProactiveEventQueue } from "../../../src/contexts/initiative/src/application/proactive-event-queue.js";
import type { AgentEvent } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";

function event(id: string): AgentEvent {
  return {
    id,
    source: { plugin: "test" },
    externalSession: { scope: "dm", sessionId: "session" },
    type: "system.heartbeat",
    payload: { kind: "text", text: "" },
    meta: { receivedAt: "2026-01-01T00:00:00.000" }
  };
}

test("proactive event queue is FIFO", () => {
  const queue = createProactiveEventQueue();
  queue.enqueue({ event: event("first"), label: "first" });
  queue.enqueue({ event: event("second"), label: "second" });

  assert.equal(queue.dequeue()?.event.id, "first");
  assert.equal(queue.dequeue()?.event.id, "second");
  assert.equal(queue.dequeue(), undefined);
});

test("proactive event consumer handles one queued event per tick", async () => {
  const queue = createProactiveEventQueue();
  const handled: string[] = [];
  queue.enqueue({ event: event("first"), label: "first" });
  queue.enqueue({ event: event("second"), label: "second" });
  const tick = createProactiveEventConsumerTick({
    queue,
    canRun: () => true,
    run: async ({ event }) => {
      handled.push(event.id);
      return true;
    },
    setWaiting() {}
  });

  assert.deepEqual(await tick({}), { processed: 1, stop: true });
  assert.deepEqual(handled, ["first"]);
  assert.equal(queue.dequeue()?.event.id, "second");
});
