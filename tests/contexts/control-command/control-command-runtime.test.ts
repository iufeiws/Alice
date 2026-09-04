import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentLoopRuntime } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import type { AgentBehaviorState } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { createControlCommandRuntime } from "../../../src/contexts/control-command/src/index.js";
import { textEvent } from "../conversation-hub/message-runtime-helpers.js";

test("force_clear 清除会话且不改变 Agent 状态、不触发 wake", async () => {
  const agentLoopRuntime = createAgentLoopRuntime();
  const clearedReasons: string[] = [];
  const states: string[] = [];
  let wakeCalls = 0;
  const runtime = createControlCommandRuntime({
    agentLoopRuntime,
    agentState: {
      getSnapshot: () => snapshot("sleeping"),
      setState(state) {
        states.push(state);
        return snapshot(state);
      }
    },
    clearLLMSession(reason) {
      clearedReasons.push(reason);
    },
    onForceWake() {
      wakeCalls += 1;
    },
    appendLog() {}
  });

  assert.equal(await runtime.handle(textEvent("session-1", "om_clear", "  /force_clear  ")), true);
  assert.deepEqual(clearedReasons, ["force_clear"]);
  assert.deepEqual(states, []);
  assert.equal(wakeCalls, 0);
  assert.equal(agentLoopRuntime.isMainAgentBusy(), false);
});

test("force_wake 保留清除、唤醒和 sleep cocoon 清理语义", async () => {
  const agentLoopRuntime = createAgentLoopRuntime();
  const records: string[] = [];
  let resolveWake: (() => void) | undefined;
  const wakeReady = new Promise<void>((resolve) => {
    resolveWake = resolve;
  });
  const runtime = createControlCommandRuntime({
    agentLoopRuntime,
    agentState: {
      getSnapshot: () => snapshot("sleeping"),
      setState(state, options) {
        records.push(`state:${state}:${options?.reason}:${options?.clearSleepCocoon === true}`);
        return snapshot(state);
      },
      waitForWake: () => wakeReady
    },
    clearLLMSession(reason) {
      records.push(`clear:${reason}`);
    },
    onForceWake() {
      records.push("wake");
    },
    appendLog() {}
  });

  assert.equal(await runtime.handle(textEvent("session-1", "om_wake", "/force_wake")), true);
  assert.deepEqual(records, ["clear:force_wake", "state:waiting:force_wake:true"]);
  resolveWake?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(records, ["clear:force_wake", "state:waiting:force_wake:true", "wake"]);
});

test("force_clear 在 Main Agent 忙碌时被消费但不清除会话", async () => {
  const agentLoopRuntime = createAgentLoopRuntime();
  const occupied = agentLoopRuntime.beginClearSession({ kind: "talk", sessionId: "talk-1" });
  if (!occupied.acquired) throw new Error("expected main agent acquisition");
  const logs: string[] = [];
  let clearCalls = 0;
  const runtime = createControlCommandRuntime({
    agentLoopRuntime,
    clearLLMSession() {
      clearCalls += 1;
    },
    appendLog(level, message) {
      logs.push(`${level}:${message}`);
    }
  });

  assert.equal(await runtime.handle(textEvent("session-1", "om_clear_busy", "/force_clear")), true);
  assert.equal(clearCalls, 0);
  assert.equal(logs.some((entry) => entry.includes("force clear skipped: main agent busy")), true);
  occupied.release();
});

test("force_clear 清除失败时释放占用并记录具体错误", async () => {
  const agentLoopRuntime = createAgentLoopRuntime();
  const logs: string[] = [];
  const runtime = createControlCommandRuntime({
    agentLoopRuntime,
    clearLLMSession() {
      throw new Error("short memory capture failed");
    },
    appendLog(level, message) {
      logs.push(`${level}:${message}`);
    }
  });

  assert.equal(await runtime.handle(textEvent("session-1", "om_clear_fail", "/force_clear")), true);
  assert.equal(agentLoopRuntime.isMainAgentBusy(), false);
  assert.equal(logs.some((entry) => entry.includes("force clear llm session clear failed: short memory capture failed")), true);
});

test("非精确控制命令不被消费", async () => {
  const runtime = createControlCommandRuntime({
    agentLoopRuntime: createAgentLoopRuntime(),
    clearLLMSession() {
      throw new Error("must not clear");
    },
    appendLog() {}
  });

  assert.equal(await runtime.handle(textEvent("session-1", "om_text", "/force_clear now")), false);
  assert.equal(await runtime.handle(textEvent("session-1", "om_unknown", "/unknown")), false);
});

function snapshot(state: AgentBehaviorState) {
  return {
    state,
    intimacy: 50,
    updatedAt: "2026-05-24T00:00:00.000Z",
    responseDelayMs: 0
  };
}
