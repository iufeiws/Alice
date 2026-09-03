import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageRuntime } from "../../../src/contexts/conversation-hub/src/application/ingest-channel-message.js";
import { createAliceStore } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { AgentStateTransition } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { makeTempDir } from "./message-runtime-helpers.js";

const path = await import("node:path");

function makeRuntime(input: {
  clearLLMSession(reason: string): void | Promise<void>;
  logs: string[];
}) {
  const store = createAliceStore(path.join(makeTempDir("runtime-idle-transition-clear"), "alice.sqlite"));
  let listener: ((transition: AgentStateTransition) => unknown) | undefined;
  const snapshot = () => ({ state: "waiting" as const, intimacy: 50, updatedAt: "2026-05-26T00:00:00.000Z", responseDelayMs: 0 });
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    startHeartbeatPaused: true,
    clearLLMSession: input.clearLLMSession,
    agentState: {
      getSnapshot: snapshot,
      canReplyToInbound: () => true,
      canRunHeartbeat: () => true,
      getInboundDelayMs: () => 0,
      tick: snapshot,
      onTransition(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      }
    },
    store,
    chatAgent: { prepareEventRun: () => [] },
    outputRouter: { async sendAll() {} },
    appendLog(level, message) {
      input.logs.push(`${level}:${message}`);
    },
    appendMessageLog(entry) {
      return store.insertMessageLog({ time: "2026-05-26T00:00:00.000Z", ...entry });
    }
  });
  return {
    runtime,
    transition(previous: "waiting" | "idle", current: "waiting" | "idle", reason?: string) {
      return listener?.({
        previous: { state: previous, intimacy: 50, updatedAt: "2026-05-26T00:00:00.000Z", responseDelayMs: 0 },
        current: { state: current, reason, intimacy: 50, updatedAt: "2026-05-26T00:00:01.000Z", responseDelayMs: 0 }
      });
    }
  };
}

test("waiting 到 idle(inactive) 的精确跃迁清除 LLM session", async () => {
  const reasons: string[] = [];
  const { runtime, transition } = makeRuntime({ clearLLMSession: (reason) => void reasons.push(reason), logs: [] });
  await transition("waiting", "idle", "inactive");
  assert.deepEqual(reasons, ["mode_transition"]);
  await runtime.flushAll();
});

test("同状态 snapshot 更新不触发 mode_transition 清除", async () => {
  const reasons: string[] = [];
  const { runtime, transition } = makeRuntime({ clearLLMSession: (reason) => void reasons.push(reason), logs: [] });
  await transition("idle", "idle", "inactive");
  assert.deepEqual(reasons, []);
  await runtime.flushAll();
});

test("mode_transition 清除失败会记录错误", async () => {
  const logs: string[] = [];
  const { runtime, transition } = makeRuntime({
    clearLLMSession() {
      throw new Error("short memory worker boom");
    },
    logs
  });
  await transition("waiting", "idle", "inactive");
  assert.equal(logs.some((line) => line.includes("idle transition llm session clear failed") && line.includes("short memory worker boom")), true);
  await runtime.flushAll();
});

test("flushAll 退订精确状态跃迁监听器", async () => {
  const reasons: string[] = [];
  const { runtime, transition } = makeRuntime({ clearLLMSession: (reason) => void reasons.push(reason), logs: [] });
  await runtime.flushAll();
  await transition("waiting", "idle", "inactive");
  assert.deepEqual(reasons, []);
});
