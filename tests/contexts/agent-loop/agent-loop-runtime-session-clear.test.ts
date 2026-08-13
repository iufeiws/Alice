import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentLoopRuntime } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import type { SessionClearResult } from "../../../src/contexts/llm-session/src/application/session-clear-coordinator.js";
import type { LLMSessionClearReason } from "../../../src/contexts/llm-session/src/domain/llm-session.js";
import { textEvent } from "./agent-loop-runtime-helpers.js";

/**
 * agent-loop runtime 层 Chat clear 集成测试（§7.1 / §12.4）:
 * - clearCurrentLLMSession(reason): Promise<SessionClearResult> 转发到 llm session runtime 并 await。
 * - Short Memory 未完成时 loop 不继续: requestRun 不得在 clear Promise 完成前返回,
 *   也不得开启新 loop（§11.2）。
 */

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function withTimeout<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    })
  ]);
}

test("agent loop runtime 转发 clearCurrentLLMSession 并 await 返回 SessionClearResult", async () => {
  const runtime = createAgentLoopRuntime();
  const seenReasons: LLMSessionClearReason[] = [];
  runtime.setLLMSessionRuntime({
    clearCurrentLLMSession(reason: LLMSessionClearReason): Promise<SessionClearResult> {
      seenReasons.push(reason);
      return Promise.resolve({ cleared: true, shortMemoryCaptured: false });
    }
  } as any);

  const result = await runtime.clearCurrentLLMSession("yield_end");

  assert.deepEqual(result, { cleared: true, shortMemoryCaptured: false });
  assert.deepEqual(seenReasons, ["yield_end"]);
});

test("Short Memory 未完成时 loop 不继续, 也不开启新 loop", async () => {
  const runtime = createAgentLoopRuntime();
  let releaseClear: (() => void) | undefined;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  let clearStarted = false;
  runtime.setLLMSessionRuntime({
    async clearCurrentLLMSession() {
      clearStarted = true;
      await clearGate;
      return { cleared: true, shortMemoryCaptured: true };
    }
  } as any);
  runtime.setRunners({
    prepareChat() {
      return {
        prepare: () => [],
        async complete() {
          // 真实 wiring: loop 结束路径(如 yield_end)必须等待 clear 完成。
          await runtime.clearCurrentLLMSession("yield_end");
          return [];
        }
      };
    }
  });

  let settled = false;
  const run = runtime.requestRun({
    kind: "chat",
    sessionId: "session-1",
    reason: "test",
    event: textEvent("session-1")
  }).then((result) => {
    settled = true;
    return result;
  });
  await flushMicrotasks();

  assert.equal(clearStarted, true, "clear 必须已开始");
  assert.equal(settled, false, "清除 Promise 完成前 loop 不得返回");
  assert.equal(runtime.isRunning(), true, "清除 Promise 完成前 loop 仍视为运行中");
  const second = await runtime.requestRun({ kind: "talk", sessionId: 1780830000101, reason: "test" });
  assert.deepEqual(second, { started: false, outputs: [] }, "清除完成前不得开启新 loop");

  releaseClear?.();
  const first = await withTimeout(run);
  assert.deepEqual(first, { started: true, outputs: [] });
  assert.equal(settled, true);
  assert.equal(runtime.isRunning(), false);
});
