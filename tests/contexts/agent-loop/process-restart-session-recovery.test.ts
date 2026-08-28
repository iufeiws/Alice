import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../../src/apps/api/bootstrap/app-config-runtime.js";
import { createRestartTools } from "../../../src/capabilities/tools/restart/src/index.js";
import { createLLMSessionArchive } from "../../../src/contexts/llm-session/src/application/archive-llm-session.js";
import { createLLMSessionRuntime } from "../../../src/contexts/llm-session/src/application/llm-session-runtime.js";
import type { SessionClearRequest } from "../../../src/contexts/llm-session/src/application/session-clear-coordinator.js";
import type { ProcessRestartContinuationRecord } from "../../../src/contexts/agent-loop/src/adapters/json-process-restart-continuation-store.js";
import { createIntentRouter } from "../../../src/contexts/agent-loop/src/application/intent-router.js";
import { createSessionResolver } from "../../../src/contexts/agent-loop/src/application/session-resolver.js";
import { createAllowAllPolicy } from "../../../src/contexts/agent-loop/src/ports/policy.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createOutputRouter } from "../../../src/platform/output-router/src/index.js";
import { makeTempDir } from "../conversation-hub/message-runtime-helpers.js";
import { createChatAgent, runPreparedChatEvent, textEvent } from "./agent-tools-helpers.js";

test("restart checkpoint uses the same session id as the persisted Chat transcript", async () => {
  let nowMs = Date.parse("2026-08-01T15:26:15.531Z");
  const time = createCurrentTimeProvider("UTC", () => new Date(nowMs++));
  const archive = createLLMSessionArchive({
    memoryRoot: makeTempDir("restart-session-id"),
    time,
    appendLog() {}
  });
  const sessionRuntime = createLLMSessionRuntime({
    time,
    archive,
    getConversationStartIndex() { return undefined; },
    buildTalkRuntimeMessages() { return []; },
    appendLog() {},
    // §7.1: clear 必须经过统一 coordinator, 不存在绕过采集的兼容 fallback。
    sessionClearCoordinator: {
      async clearSession(request: SessionClearRequest) {
        if (!request.exists()) return { cleared: false, shortMemoryCaptured: false };
        await request.clear();
        return { cleared: true, shortMemoryCaptured: false };
      }
    }
  });
  const savedRecords: ProcessRestartContinuationRecord[] = [];
  let record: ProcessRestartContinuationRecord | undefined;
  let requestCount = 0;
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    time,
    llm: {
      async chat() {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{
                id: "restart_call",
                type: "function",
                function: { name: "restart", arguments: "{}" }
              }]
            }
          };
        }
        return { message: { role: "assistant", content: "resumed" } };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [createRestartTools({ async restart() {} })],
    loadLLMSession: sessionRuntime.loadCurrentLLMSessionTranscript,
    createLLMSessionId(occurredAt: string) {
      return sessionRuntime.ensureCurrentLLMSession(occurredAt, "chat").id;
    },
    onLLMSessionUpdated: sessionRuntime.updateCurrentLLMSessionTranscript,
    processRestartContinuationStore: {
      read: () => record,
      save(value) {
        record = value;
        savedRecords.push(value);
      },
      clear(toolCallId) {
        if (record?.toolCallId !== toolCallId) return false;
        record = undefined;
        return true;
      }
    }
  });

  await runPreparedChatEvent(core, textEvent());

  assert.equal(savedRecords[0]?.sessionId, archive.readCurrent()?.id);
});

test("an unrelated persisted restart checkpoint is discarded without blocking a newer event", async () => {
  let nowMs = Date.parse("2026-08-01T15:26:15.531Z");
  const time = createCurrentTimeProvider("UTC", () => new Date(nowMs++));
  let record: ProcessRestartContinuationRecord | undefined = {
    version: 1,
    sessionId: 8,
    toolCallId: "restart_call",
    restartCompleted: false,
    event: {
      ...textEvent(),
      id: "evt_old",
      externalSession: { scope: "dm", sessionId: "session-old" }
    },
    continuation: {
      version: 1,
      messages: [],
      round: 0,
      replyRound: 0,
      totalToolCallCount: 1,
      replyToolCallCount: 1,
      invalidateSession: false,
      result: {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "restart_call",
            type: "function",
            function: { name: "restart", arguments: "{}" }
          }]
        }
      },
      completeAfterToolCalls: false,
      interruptedCallIndex: 0,
      executedCalls: [],
      toolMessages: [],
      reachedToolCallLimit: false,
      resetSession: false,
      continueAfterReset: false,
      yieldReturn: false
    },
    createdAt: "2026-08-01T15:20:00.000"
  };
  let requestCount = 0;
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    time,
    llm: {
      async chat() {
        requestCount += 1;
        return { message: { role: "assistant", content: "processed" } };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [],
    createLLMSessionId() {
      return 9;
    },
    processRestartContinuationStore: {
      read: () => record,
      save(value) {
        record = value;
      },
      clear(toolCallId) {
        if (record?.toolCallId !== toolCallId) return false;
        record = undefined;
        return true;
      }
    }
  });

  await runPreparedChatEvent(core, textEvent());

  assert.equal(record, undefined);
});
