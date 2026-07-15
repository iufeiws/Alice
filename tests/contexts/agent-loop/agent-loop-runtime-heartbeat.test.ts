import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentHeartbeatRuntime } from "../../../src/contexts/agent-loop/src/runtime/agent-heartbeat-runtime.js";

test("agent heartbeat passes forced run options to registered ticks", async () => {
  const calls: unknown[] = [];
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    ticks: [async (options) => {
      calls.push(options);
      return { processed: 2 };
    }],
    appendLog: () => {}
  });

  assert.equal(await heartbeat.run({ force: true }), 2);
  assert.deepEqual(calls, [{ force: true }]);
});

test("agent heartbeat stops after a tick requests it", async () => {
  const calls: string[] = [];
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    ticks: [
      () => {
        calls.push("first");
        return { processed: 1, stop: true };
      },
      () => {
        calls.push("second");
        return { processed: 1 };
      }
    ],
    appendLog: () => {}
  });

  assert.equal(await heartbeat.run(), 1);
  assert.deepEqual(calls, ["first"]);
  heartbeat.flush();
});

test("agent heartbeat pause and resume retain timer ownership", () => {
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    ticks: [async () => ({ processed: 0 })],
    appendLog: () => {}
  });

  heartbeat.schedule();
  assert.equal(heartbeat.isScheduled(), true);
  heartbeat.pause();
  assert.equal(heartbeat.isScheduled(), false);
  heartbeat.resume();
  assert.equal(heartbeat.isScheduled(), true);
  heartbeat.flush();
});
