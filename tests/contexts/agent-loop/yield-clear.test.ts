import { test } from "node:test";
import assert from "node:assert/strict";
import type { LLMChatInput, LLMClient } from "../../../src/contexts/llm-gateway/src/index.js";
import { loadConfig } from "../../../src/apps/api/bootstrap/app-config-runtime.js";
import { createOutputRouter } from "../../../src/platform/output-router/src/index.js";
import { createAllowAllPolicy } from "../../../src/contexts/agent-loop/src/ports/policy.js";
import { createIntentRouter } from "../../../src/contexts/agent-loop/src/application/intent-router.js";
import { createSessionResolver } from "../../../src/contexts/agent-loop/src/application/session-resolver.js";
import { createFinishAndWaitTools, clearYieldAlbertContent } from "../../../src/capabilities/tools/finish-and-wait/src/index.js";
import { createChatAgent, runPreparedChatEvent, textEvent } from "./agent-tools-helpers.js";

test("Yield new rebuilds the chat session and sends a fresh request with the Albert alert", async () => {
  const requests: LLMChatInput[] = [];
  const appended: unknown[] = [];
  let rebuilt = 0;
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "call_new",
              type: "function",
              function: { name: "Yield", arguments: '{"action":"new"}' }
            }]
          },
          finishReason: "tool_calls"
        };
      }
      return { message: { role: "assistant", content: "fresh round" }, finishReason: "stop" };
    }
  };
  const yieldTools = createFinishAndWaitTools();
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      visibleTools: { feishu: true },
      layers: {
        meta: {},
        messages: [{ meta: { title: "Static", enabled: true }, role: "system", content: "static prompt" }]
      },
      appendLayers: { meta: {}, messages: [] },
      interruptLayer: { meta: {}, messages: [] }
    }),
    tools: [yieldTools],
    appendAlbertMessage(input) {
      appended.push(input);
    },
    onLLMSessionRebuilt() {
      rebuilt += 1;
    }
  });

  await runPreparedChatEvent(core, textEvent());

  assert.equal(requests.length, 2);
  assert.equal(rebuilt, 1);
  assert.deepEqual(appended, [{
    callId: "call_new",
    requester: textEvent().source,
    externalSession: textEvent().externalSession,
    contentText: clearYieldAlbertContent
  }]);
  assert.equal(requests[0].messages.some((message) => message.content === clearYieldAlbertContent), false);
  assert.equal(requests[1].messages.at(-1)?.role, "user");
  assert.equal(requests[1].messages.at(-1)?.name, "Alert");
  assert.equal(requests[1].messages.at(-1)?.content, clearYieldAlbertContent);
  assert.equal(requests[1].messages.some((message) => message.role === "assistant" && message.toolCalls?.some((call) => call.function.name === "Yield")), false);
});

test("Yield new does not append Albert or continue when session clear is not completed", async () => {
  const requests: LLMChatInput[] = [];
  const appended: unknown[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call_new_failed",
            type: "function",
            function: { name: "Yield", arguments: '{"action":"new"}' }
          }]
        },
        finishReason: "tool_calls"
      };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      visibleTools: { feishu: true },
      layers: {
        meta: {},
        messages: [{ meta: { title: "Static", enabled: true }, role: "system", content: "static prompt" }]
      },
      appendLayers: { meta: {}, messages: [] },
      interruptLayer: { meta: {}, messages: [] }
    }),
    tools: [createFinishAndWaitTools()],
    appendAlbertMessage(input) {
      appended.push(input);
    },
    onLLMSessionRebuilt() {
      return { cleared: false, shortMemoryCaptured: false };
    }
  });

  await assert.rejects(() => runPreparedChatEvent(core, textEvent()), /yield_clear_session_not_cleared/);
  assert.equal(requests.length, 1);
  assert.deepEqual(appended, []);
});
