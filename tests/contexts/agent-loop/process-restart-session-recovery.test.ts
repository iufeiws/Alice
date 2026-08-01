import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../../src/apps/api/bootstrap/app-config-runtime.js";
import { createRestartTools } from "../../../src/capabilities/tools/restart/src/index.js";
import { createLLMSessionArchive } from "../../../src/contexts/llm-session/src/application/archive-llm-session.js";
import { createLLMSessionRuntime } from "../../../src/contexts/llm-session/src/application/llm-session-runtime.js";
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
    appendLog() {}
  });
  const savedRecords: ProcessRestartContinuationRecord[] = [];
  let record: ProcessRestartContinuationRecord | undefined;
  let requestCount = 0;
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_TOKEN_PRESSURE_CONTEXT_IMPORTANCE: "1" }),
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
      return Number(sessionRuntime.ensureCurrentLLMSession(occurredAt, "chat").id);
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
