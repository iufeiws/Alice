import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateTokenPressureSwitch, createChatAgent as createChatAgentUnderTest, type LLMSessionSnapshot } from "../../../src/contexts/agent-loop/src/application/chat-agent.js";
import type { LLMRequestSenderInput } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import type { LLMChatInput, LLMClient } from "../../../src/contexts/llm-gateway/src/index.js";
import type { AgentEvent, ToolCall } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { buildLLMTextVariables, createLLMTextVariableRenderer } from "../../../src/contexts/agent-profile/src/application/llm-text-renderer.js";
import { loadConfig } from "../../../src/apps/api/bootstrap/app-config-runtime.js";
import { createOutputRouter } from "../../../src/platform/output-router/src/index.js";
import { createAllowAllPolicy } from "../../../src/contexts/agent-loop/src/ports/policy.js";
import { createIntentRouter } from "../../../src/contexts/agent-loop/src/application/intent-router.js";
import { createSessionResolver } from "../../../src/contexts/agent-loop/src/application/session-resolver.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createAgentStateController, type AgentBehaviorState } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { createChatAgent, runPreparedChatEvent, textEvent, chatTestTools, memoryStore, messageContentText } from "./agent-tools-helpers.js";

test("chat agent injects fixed prefix cursor into model requested from_prefix checks", async () => {
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
    { role: "tool", name: "Bookcase", toolCallId: "tool_draw", content: "<book>fixed story</book>" }
  ];
  const checkChatInputs: Array<{ id: string; input: Record<string, unknown> }> = [];
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-30T01:00:00.000Z")),
    llm: {
      async chat() {
        if (checkChatInputs.some((entry) => entry.id === "tool_check")) {
          return { message: { role: "assistant", content: "done" } };
        }
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "tool_check",
              type: "function",
              function: { name: "Chat", arguments: "{\"action\":\"poll\",\"scope\":\"from_prefix\"}" }
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
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true },
      layers: [{ id: "static", title: "Static", role: "system", enabled: true, content: "static prompt", order: 1 }],
      appendLayers: []
    }),
    initialLLMSession: {
      messages: fixedPrefixStatic,
      staticPromptFingerprint: "old-fingerprint",
      requestTimestamps: [],
      mode: "fixed_prefix",
      modeStaticMessages: fixedPrefixStatic,
      modeStaticTokenEstimate: 50,
      modeStartedAt: "2026-05-30T00:00:00.000Z",
      modeExpiresAt: "2026-05-30T03:00:00.000Z",
      fixedPrefixKind: "bookcase",
      fixedPrefixCursorMessageId: 12
    },
    tools: [{
      id: "messaging",
      listTools() {
        return [{ name: "Chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        checkChatInputs.push({ id: call.id, input: call.input });
        return { callId: call.id, ok: true, output: "fresh chat" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());

  assert.equal(checkChatInputs.find((entry) => entry.id === "tool_check")?.input.__fromPrefixAfterMessageId, 12);
});

test("chat agent appends sleep cocoon goodnight instruction from heartbeat event", async () => {
  const requests: LLMChatInput[] = [];
  const sleepCalls: Array<Record<string, unknown>> = [];
  const behaviorRuns: Array<{ result: string; steps: Array<{ kind: string; result: string }>; error?: string }> = [];
  const sessionUpdates: Array<{ mode?: string; fixedPrefixKind?: string; messages: LLMChatInput["messages"] }> = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "晚安" } };
    }
  };
  const event = {
    ...textEvent(),
    type: "system.heartbeat" as const,
    meta: {
      receivedAt: "2026-05-26T00:00:00.000Z",
      raw: { agentInitiatedTriggerEvent: "sleep_cocoon.auto_goodnight_check" }
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [{
      id: "sleep_cocoon",
      listTools() {
        return [{ name: "sleep_cocoon", description: "sleep", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        sleepCalls.push(call.input);
        return {
          callId: call.id,
          ok: true,
          resetLLMSession: true,
          fixedPrefixKind: "sleep_cocoon",
          fixedPrefixTtlMs: 60_000,
          output: "ok"
        };
      }
    }],
    getPromptProfile: () => ({
      userName: "YY",
      visibleTools: { feishu: true },
      layers: [{
        id: "base",
        title: "Base",
        role: "system",
        enabled: true,
        order: 1,
        content: "base prompt"
      }],
      appendLayers: []
    }),
    onLLMSessionUpdated(session) {
      sessionUpdates.push({ mode: session.mode, fixedPrefixKind: session.fixedPrefixKind, messages: session.messages });
    },
    recordAgentInitiatedBehaviorRun(run) {
      behaviorRuns.push(run);
    }
  });

  await runPreparedChatEvent(core, event);

  assert.equal(requests.length, 1);
  assert.equal(sessionUpdates.at(-1)?.mode, "fixed_prefix");
  assert.equal(sessionUpdates.at(-1)?.fixedPrefixKind, "sleep_cocoon");
  assert.deepEqual(sleepCalls, [{ action: "in" }]);
  assert.deepEqual(behaviorRuns.map((run) => ({
    result: run.result,
    steps: run.steps.map((step) => ({ kind: step.kind, result: step.result })),
    error: run.error
  })), [{
    result: "completed",
    steps: [
      { kind: "llm_instruction", result: "completed" }
    ],
    error: undefined
  }]);
  assert.equal(requests[0].messages.some((message) => message.role === "user"), true);
  const sleepToolRequestIndex = requests[0].messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "sleep_cocoon");
  assert.ok(sleepToolRequestIndex >= 0);
  assert.equal(requests[0].messages[sleepToolRequestIndex]?.toolCalls?.[0]?.function.arguments, "{\"action\":\"in\"}");
  assert.equal(requests[0].messages[sleepToolRequestIndex + 1]?.role, "tool");
  assert.equal(requests[0].messages[sleepToolRequestIndex + 1]?.toolCallId, requests[0].messages[sleepToolRequestIndex]?.toolCalls?.[0]?.id);
});

test("chat agent skips sleep cocoon goodnight when sleep tool is hidden", async () => {
  const requests: LLMChatInput[] = [];
  const sleepCalls: Array<Record<string, unknown>> = [];
  const behaviorRuns: Array<{ result: string; error?: string }> = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "晚安" } };
    }
  };
  const event = {
    ...textEvent(),
    type: "system.heartbeat" as const,
    meta: {
      receivedAt: "2026-05-26T00:00:00.000Z",
      raw: { agentInitiatedTriggerEvent: "sleep_cocoon.auto_goodnight_check" }
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [{
      id: "sleep_cocoon",
      listTools() {
        return [{ name: "sleep_cocoon", description: "sleep", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        sleepCalls.push(call.input);
        return { callId: call.id, ok: true, output: "ok" };
      }
    }],
    getPromptProfile: () => ({
      userName: "YY",
      visibleTools: { feishu: true, sleep_cocoon: false },
      layers: [{
        id: "base",
        title: "Base",
        role: "system",
        enabled: true,
        order: 1,
        content: "base prompt"
      }],
      appendLayers: []
    }),
    recordAgentInitiatedBehaviorRun(run) {
      behaviorRuns.push(run);
    }
  });

  await runPreparedChatEvent(core, event);

  assert.equal(requests.length, 0);
  assert.deepEqual(sleepCalls, []);
  assert.deepEqual(behaviorRuns.map((run) => ({ result: run.result, error: run.error })), [{ result: "skipped", error: "tool_hidden:sleep_cocoon" }]);
});

test("chat agent appends sleep cocoon morning instruction from heartbeat event", async () => {
  const requests: LLMChatInput[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "早安" } };
    }
  };
  const event = {
    ...textEvent(),
    type: "system.heartbeat" as const,
    meta: {
      receivedAt: "2026-05-26T08:00:00.000Z",
      raw: { agentInitiatedTriggerEvent: "sleep_cocoon.wake" }
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [],
    getPromptProfile: () => ({
      userName: "YY",
      visibleTools: { feishu: true },
      layers: [{
        id: "base",
        title: "Base",
        role: "system",
        enabled: true,
        order: 1,
        content: "base prompt"
      }],
      appendLayers: []
    })
  });

  await runPreparedChatEvent(core, event);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages.some((message) => message.role === "user"), true);
  assert.equal(requests[0].messages.some((message) => messageContentText(message.content).includes("sleep_cocoon")), false);
});

test("chat agent appends force wake instruction from heartbeat event", async () => {
  const requests: LLMChatInput[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "醒了" } };
    }
  };
  const event = {
    ...textEvent(),
    type: "system.heartbeat" as const,
    meta: {
      receivedAt: "2026-05-26T08:00:00.000Z",
      raw: { agentInitiatedTriggerEvent: "sleep_cocoon.force_wake" }
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [],
    getPromptProfile: () => ({
      userName: "YY",
      visibleTools: { feishu: true },
      layers: [{
        id: "base",
        title: "Base",
        role: "system",
        enabled: true,
        order: 1,
        content: "base prompt"
      }],
      appendLayers: []
    })
  });

  await runPreparedChatEvent(core, event);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages.some((message) => message.role === "user"), true);
});
