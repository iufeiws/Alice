import { test } from "node:test";
import assert from "node:assert/strict";
import type { LLMChatInput, LLMClient } from "../../../src/contexts/llm-gateway/src/index.js";
import type { LLMSessionSnapshot } from "../../../src/contexts/agent-loop/src/application/chat-agent.js";
import { loadConfig } from "../../../src/apps/api/bootstrap/app-config-runtime.js";
import { createOutputRouter } from "../../../src/platform/output-router/src/index.js";
import { createAllowAllPolicy } from "../../../src/contexts/agent-loop/src/ports/policy.js";
import { createIntentRouter } from "../../../src/contexts/agent-loop/src/application/intent-router.js";
import { createSessionResolver } from "../../../src/contexts/agent-loop/src/application/session-resolver.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import {
  chatTestTools,
  createChatAgent,
  runPreparedChatEvent,
  textEvent
} from "./agent-tools-helpers.js";

/**
 * ChatAgent 层 Chat clear 集成测试（§7.1 / §12.4）:
 * - clearLLMSession(reason): Promise<SessionClearResult>。
 * - Prompt rebuild、Yield end、cancel 与 mode timeout 路径均等待 clear:
 *   清除 Promise 完成前, loop 不得返回、不得继续创建下一会话（§11.2）。
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

function timedYieldEvent() {
  return {
    ...textEvent(),
    id: "evt_timeout",
    type: "system.heartbeat" as const,
    meta: {
      ...textEvent().meta,
      raw: { agentInitiatedTriggerEvent: "yield.timeout" }
    }
  };
}

test("ChatAgent.clearLLMSession 返回 await 后的 SessionClearResult", async () => {
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    llm: {
      async chat() {
        return { message: { role: "assistant", content: "ok" } };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    onLLMSessionCleared: async (reason) => {
      assert.equal(reason, "admin_clear");
      return { cleared: true, shortMemoryCaptured: false };
    }
  });

  const result = await core.clearLLMSession("admin_clear");

  assert.deepEqual(result, { cleared: true, shortMemoryCaptured: false });
});

test("Chat clear 失败后保留原 session，下一次运行不会创建新 session", async () => {
  let createdSessions = 0;
  let clearCalls = 0;
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    llm: {
      async chat() {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "tool_clear",
              type: "function",
              function: { name: "Bookcase", arguments: "{\"action\":\"return\"}" }
            }]
          },
          finishReason: "tool_calls"
        };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    createLLMSessionId() {
      createdSessions += 1;
      return createdSessions;
    },
    tools: [{
      id: "messaging",
      listTools() {
        return [{ name: "Bookcase", description: "bookcase", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, invalidateLLMSession: true };
      }
    }],
    async onLLMSessionCleared() {
      clearCalls += 1;
      if (clearCalls === 1) throw new Error("capture failed");
      return { cleared: true, shortMemoryCaptured: false };
    }
  });

  await assert.rejects(() => runPreparedChatEvent(core, textEvent()), /capture failed/);
  assert.equal(createdSessions, 1);

  await runPreparedChatEvent(core, textEvent());
  assert.equal(createdSessions, 1, "失败后必须复用原 session，不能创建新 session");
});

test("prompt 静态指纹变化(prompt_static_changed)路径等待 clear 完成", async () => {
  const requests: LLMChatInput[] = [];
  const clearedReasons: string[] = [];
  let releaseClear: (() => void) | undefined;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    llm: {
      async chat(input) {
        requests.push(input);
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "tool_draw",
              type: "function",
              function: { name: "Bookcase", arguments: "{\"action\":\"return\"}" }
            }]
          },
          finishReason: "tool_calls"
        };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [{
      id: "messaging",
      listTools() {
        return [{ name: "Bookcase", description: "bookcase", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return {
          callId: call.id,
          ok: true,
          invalidateLLMSession: true,
          output: { action: "return" }
        };
      }
    }],
    onLLMSessionCleared: async (reason) => {
      clearedReasons.push(reason);
      await clearGate;
      return { cleared: true, shortMemoryCaptured: false };
    }
  });

  let settled = false;
  const run = runPreparedChatEvent(core, textEvent()).then((outputs) => {
    settled = true;
    return outputs;
  });
  await flushMicrotasks();

  assert.equal(clearedReasons.length, 1, "必须已触发 prompt_static_changed clear");
  assert.deepEqual(clearedReasons, ["prompt_static_changed"]);
  assert.equal(settled, false, "prompt rebuild 的 clear Promise 完成前 loop 不得返回");

  releaseClear?.();
  const outputs = await withTimeout(run);
  assert.equal(settled, true);
  assert.equal(outputs.length, 0);
  assert.equal(requests.length, 1, "clear 完成后不得开启新 loop / 新请求");
});

test("Yield 结束(await_chat 超时, yield_end)路径等待 clear 完成", async () => {
  const requests: LLMChatInput[] = [];
  const clearedReasons: string[] = [];
  let persistedSession: LLMSessionSnapshot | undefined;
  let nowMs = Date.parse("2026-05-26T00:00:00.000Z");
  let releaseClear: (() => void) | undefined;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    time: createCurrentTimeProvider("UTC", () => new Date(nowMs)),
    llm: {
      async chat(input) {
        requests.push(input);
        if (requests.length === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{
                id: "tool_wait",
                type: "function",
                function: { name: "Yield", arguments: "{\"action\":\"await_chat\"}" }
              }]
            },
            finishReason: "tool_calls"
          };
        }
        return { message: { role: "assistant", content: "" } };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true },
      layers: [{ id: "static", title: "Static", role: "system", enabled: true, content: "static prompt", order: 1 }],
      appendLayers: []
    }),
    tools: [chatTestTools()],
    onLLMSessionUpdated(session) {
      persistedSession = session;
    },
    onLLMSessionCleared: async (reason) => {
      clearedReasons.push(reason);
      await clearGate;
      return { cleared: true, shortMemoryCaptured: false };
    },
    loadLLMSession() {
      return persistedSession;
    }
  });

  await runPreparedChatEvent(core, textEvent());
  assert.equal(persistedSession?.waitChatMode, "await_chat");

  nowMs = Date.parse("2026-05-26T00:15:01.000Z");
  let settled = false;
  const run = runPreparedChatEvent(core, timedYieldEvent()).then((outputs) => {
    settled = true;
    return outputs;
  });
  await flushMicrotasks();

  assert.deepEqual(clearedReasons, ["yield_end"]);
  assert.equal(settled, false, "yield_end 的 clear Promise 完成前 loop 不得返回");

  releaseClear?.();
  const outputs = await withTimeout(run);
  assert.equal(settled, true);
  assert.equal(requests.length, 1, "clear 完成后不得发起新 LLM 请求");
  assert.equal(outputs.length, 0);
});

test("cancel(admin_cancel)路径等待 clear 完成", async () => {
  const requests: LLMChatInput[] = [];
  const clearedReasons: string[] = [];
  let cancelNow = false;
  let releaseClear: (() => void) | undefined;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    llm: {
      async chat(input) {
        requests.push(input);
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "call_cancel",
              type: "function",
              function: { name: "later_tool", arguments: "{}" }
            }]
          },
          finishReason: "tool_calls"
        };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    isLLMRunCancelled: () => cancelNow,
    tools: [chatTestTools((call) => {
      if (call.toolName === "later_tool") cancelNow = true;
    })],
    onLLMSessionCleared: async (reason) => {
      clearedReasons.push(reason);
      await clearGate;
      return { cleared: true, shortMemoryCaptured: false };
    }
  });

  let settled = false;
  const run = runPreparedChatEvent(core, textEvent()).then((outputs) => {
    settled = true;
    return outputs;
  });
  await flushMicrotasks();

  assert.deepEqual(clearedReasons, ["admin_cancel"]);
  assert.equal(settled, false, "cancel 的 clear Promise 完成前 loop 不得返回");

  releaseClear?.();
  const outputs = await withTimeout(run);
  assert.equal(settled, true);
  assert.equal(outputs.length, 0);
  assert.equal(requests.length, 1, "cancel 后不得继续创建下一会话 / 发起新请求");
});

test("mode timeout(mode_timeout)路径等待 clear 完成", async () => {
  const requests: LLMChatInput[] = [];
  const clearedReasons: string[] = [];
  const fixedPrefixStatic: LLMChatInput["messages"] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "tool_draw",
        type: "function",
        function: { name: "Bookcase", arguments: "{\"action\":\"draw\"}" }
      }]
    },
    { role: "tool", name: "Bookcase", toolCallId: "tool_draw", content: "<book>expired story</book>" }
  ];
  let releaseClear: (() => void) | undefined;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-30T02:01:00.000Z")),
    llm: {
      async chat(input) {
        requests.push(input);
        return { message: { role: "assistant", content: "normal again" } };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true },
      layers: [{ id: "static", title: "Static", role: "system", enabled: true, content: "new static prompt", order: 1 }],
      appendLayers: []
    }),
    initialLLMSession: {
      messages: [
        { role: "system", content: "old static prompt" },
        ...fixedPrefixStatic,
        { role: "assistant", content: "old live context" }
      ],
      staticPromptFingerprint: "old-fingerprint",
      requestTimestamps: [],
      mode: "fixed_prefix",
      modeStaticMessages: fixedPrefixStatic,
      modeStaticTokenEstimate: 50,
      modeStartedAt: "2026-05-30T00:00:00.000Z",
      modeExpiresAt: "2026-05-30T02:00:00.000Z",
      fixedPrefixKind: "bookcase",
      fixedPrefixStartedAt: "2026-05-30T00:00:00.000"
    },
    tools: [{
      id: "messaging",
      listTools() {
        return [{ name: "Chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "fresh normal chat" };
      }
    }],
    onLLMSessionCleared: async (reason) => {
      clearedReasons.push(reason);
      await clearGate;
      return { cleared: true, shortMemoryCaptured: false };
    }
  });

  let settled = false;
  const run = runPreparedChatEvent(core, textEvent()).then((outputs) => {
    settled = true;
    return outputs;
  });
  await flushMicrotasks();

  assert.deepEqual(clearedReasons, ["mode_timeout"]);
  assert.equal(settled, false, "mode timeout 的 clear Promise 完成前 loop 不得返回");

  releaseClear?.();
  const outputs = await withTimeout(run);
  assert.equal(settled, true);
  assert.equal(requests.length, 1, "clear 完成后才进入新会话的请求");
  assert.equal(outputs.length, 0);
});

test("clearLLMSession 不抛错并返回 handler 结果", async () => {
  const seen: string[] = [];
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    llm: {
      async chat() {
        return { message: { role: "assistant", content: "ok" } };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    onLLMSessionCleared: async (reason) => {
      seen.push(reason);
      return { cleared: true, shortMemoryCaptured: false };
    }
  });

  const result = await core.clearLLMSession("admin_clear");

  assert.deepEqual(result, { cleared: true, shortMemoryCaptured: false });
  assert.deepEqual(seen, ["admin_clear"]);
});
