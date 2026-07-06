import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateTokenPressureSwitch, createChatAgent as createChatAgentUnderTest, type LLMSessionSnapshot } from "../../../src/contexts/agent-loop/src/application/chat-agent.js";
import type { LLMRequestSenderInput } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import type { LLMChatInput, LLMClient } from "../../../src/contexts/llm-gateway/src/index.js";
import type { AgentEvent, ToolCall } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { loadConfig } from "../../../src/apps/api/bootstrap/app-config-runtime.js";
import { createOutputRouter } from "../../../src/platform/output-router/src/index.js";
import { createAllowAllPolicy } from "../../../src/contexts/agent-loop/src/ports/policy.js";
import { createIntentRouter } from "../../../src/contexts/agent-loop/src/application/intent-router.js";
import { createSessionResolver } from "../../../src/contexts/agent-loop/src/application/session-resolver.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createAgentStateController, type AgentBehaviorState } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { createChatAgent, runPreparedChatEvent, textEvent, chatTestTools, memoryStore, messageContentText } from "./agent-tools-helpers.js";

test("chat agent appends sleep cocoon goodnight tool request from heartbeat event", async () => {
  const scenario = createSleepCocoonGoodnightScenario();

  await runPreparedChatEvent(scenario.core, scenario.event);

  assert.deepEqual(scenario.sleepCalls, [{ action: "in" }]);
  const sleepToolRequestIndex = scenario.requests[0].messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "sleep_cocoon");
  assert.ok(sleepToolRequestIndex >= 0);
  assert.equal(scenario.requests[0].messages[sleepToolRequestIndex]?.toolCalls?.[0]?.function.arguments, "{\"action\":\"in\"}");
  assert.equal(scenario.requests[0].messages[sleepToolRequestIndex + 1]?.toolCallId, scenario.requests[0].messages[sleepToolRequestIndex]?.toolCalls?.[0]?.id);
});

test("chat agent stores sleep cocoon goodnight fixed prefix session mode", async () => {
  const scenario = createSleepCocoonGoodnightScenario();

  await runPreparedChatEvent(scenario.core, scenario.event);

  assert.equal(scenario.sessionUpdates.at(-1)?.mode, "fixed_prefix");
  assert.equal(scenario.sessionUpdates.at(-1)?.fixedPrefixKind, "sleep_cocoon");
});

test("chat agent records completed sleep cocoon goodnight behavior run", async () => {
  const scenario = createSleepCocoonGoodnightScenario();

  await runPreparedChatEvent(scenario.core, scenario.event);

  assert.deepEqual(scenario.behaviorRuns.map((run) => ({
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
});

function createSleepCocoonGoodnightScenario() {
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

  return { core, event, requests, sleepCalls, behaviorRuns, sessionUpdates };
}

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
