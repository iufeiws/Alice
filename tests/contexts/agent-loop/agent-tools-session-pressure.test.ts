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

test("chat agent continues after Chat until the next response has no tool calls", async () => {
  const requests: LLMChatInput[] = [];
  const sent: string[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length <= 2) {
        return {
          message: {
            role: "assistant",
            content: `need more ${requests.length}`,
            toolCalls: [{
              id: `tool_view_${requests.length}`,
              type: "function",
              function: {
                name: "Chat",
                arguments: "{\"action\":\"poll\"}"
              }
            }]
          }
        };
      }
      if (requests.length === 3) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "tool_send",
              type: "function",
              function: {
                name: "Chat",
                arguments: "{\"action\":\"send\",\"type\":\"message\",\"content\":\"final\"}"
              }
            }]
          }
        };
      }
      return {
        message: {
          role: "assistant",
          content: "done"
        }
      };
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
      id: "messaging-test",
      listTools() {
        return [
          { name: "Chat", description: "view", inputSchema: { type: "object" } },
          { name: "Chat", description: "send", inputSchema: { type: "object" } }
        ];
      },
      async execute(call) {
        if (call.toolName === "Chat" && call.input.action === "send") sent.push(String(call.input.content));
        return { callId: call.id, ok: true, output: call.input.action === "send" ? "sent" : "history" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  assert.deepEqual(sent, ["final", "done"]);
  assert.equal(requests.length, 4);
});

test("chat agent leaves assistant content in place when tool calls exist", async () => {
  const requests: LLMChatInput[] = [];
  const toolCalls: ToolCall[] = [];
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm: {
      async chat(input) {
        requests.push(input);
        return requests.length === 1
          ? {
            message: {
              role: "assistant",
              content: "hello",
              toolCalls: [{
                id: "later_1",
                type: "function",
                function: { name: "later_tool", arguments: "{\"value\":1}" }
              }]
            }
          }
          : { message: { role: "assistant", content: "" } };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [chatTestTools((call) => toolCalls.push(call))]
  });

  await runPreparedChatEvent(core, textEvent());

  assert.deepEqual(toolCalls.map((call) => call.toolName), ["later_tool"]);
  const assistantMessage = requests[1].messages.find((message) => message.role === "assistant" && message.toolCalls?.length === 1);
  assert.equal(assistantMessage?.content, "hello");
  assert.equal(assistantMessage?.toolCalls?.[0]?.function.name, "later_tool");
});

test("chat agent uses first-call and follow-up extra params", async () => {
  const requests: LLMChatInput[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "tool_view",
              type: "function",
              function: {
                name: "Chat",
                arguments: "{\"action\":\"poll\"}"
              }
            }]
          }
        };
      }
      return { message: { role: "assistant", content: "done" } };
    }
  };
  const core = createChatAgent({
    config: loadConfig({
      LLM_MODEL: "test-model",
      LLM_EXTRA_PARAMS: "{\"cache_prompt\":true}",
      LLM_FOLLOWUP_EXTRA_PARAMS: "{\"cache_prompt\":false,\"reasoning_effort\":\"low\"}"
    }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [{
      id: "messaging-test",
      listTools() {
        return [{ name: "Chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "history" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  assert.deepEqual(requests.map((request) => request.extraParams), [
    { cache_prompt: true },
    { cache_prompt: false, reasoning_effort: "low" }
  ]);
});

test("chat agent skips fake append tool requests on first llm round", async () => {
  const senderInputs: LLMRequestSenderInput[] = [];
  const core = createChatAgent({
    config: loadConfig({
      LLM_MODEL: "test-model",
      LLM_EXTRA_PARAMS: "{\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"Chat\"}}}",
      LLM_FOLLOWUP_EXTRA_PARAMS: "{\"tool_choice\":\"auto\"}"
    }),
    llm: {
      async chat() {
        throw new Error("direct llm client should not be called");
      }
    },
    llmRequestSender: async (input) => {
      senderInputs.push(input);
      if (input.round === 0) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "tool_mirror",
              type: "function",
              function: { name: "Wardrobe", arguments: "{\"action\":\"mirror\"}" }
            }]
          }
        };
      }
      return { message: { role: "assistant", content: "done" } };
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true },
      layers: [{ id: "sys", title: "Sys", role: "system", enabled: true, content: "sys", order: 1 }],
      appendLayers: [{
        id: "append_check",
        title: "Check",
        role: "tool_request",
        enabled: true,
        content: "",
        toolCalls: [{ toolName: "Chat", toolArguments: "{\"action\":\"poll\"}" }],
        order: 1
      }]
    }),
    tools: [{
      id: "test-tools",
      listTools() {
        return [
          { name: "Chat", description: "view", inputSchema: { type: "object" } },
          { name: "Wardrobe", description: "mirror", inputSchema: { type: "object" } }
        ];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: call.toolName === "Chat" ? "history" : "outfit" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());

  assert.equal(senderInputs.length, 2);
  assert.equal(senderInputs[0].round, 0);
  assert.deepEqual(senderInputs[0].extraParams, { tool_choice: { type: "function", function: { name: "Chat" } } });
  assert.equal(senderInputs[0].messages.some((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Chat"), false);
  assert.equal(senderInputs[1].round, 1);
  assert.deepEqual(senderInputs[1].extraParams, { tool_choice: "auto" });
  assert.equal(senderInputs[1].messages.at(-1)?.content, "outfit");
});

test("chat agent does not retry transient-looking sender failures", async () => {
  const attempts: string[] = [];
  const llm: LLMClient = {
    async chat() {
      throw new Error("chat should not be called");
    },
    async chatStream() {
      attempts.push("stream");
      throw new Error("LLM request failed: 503 Service Unavailable service is too busy");
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy()
  });

  await assert.rejects(() => runPreparedChatEvent(core, textEvent()), /503 Service Unavailable/);

  assert.equal(attempts.length, 1);
});

test("chat agent does not retry non-transient llm failures", async () => {
  let attempts = 0;
  const llm: LLMClient = {
    async chat() {
      attempts += 1;
      throw new Error("LLM request failed: 400 Bad Request invalid tool_call");
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy()
  });

  await assert.rejects(() => runPreparedChatEvent(core, textEvent()), /400 Bad Request/);
  assert.equal(attempts, 1);
});

test("chat agent keeps an active transcript and appends fake Chat on the next heartbeat", async () => {
  const requests: LLMChatInput[] = [];
  let appendCheckCount = 0;
  let appendContextCalls = 0;
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: `final ${requests.length}` } };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    appendLoopSessionContext(input) {
      appendContextCalls += 1;
      input.session.messages = [
        ...input.session.messages,
        ...input.messages
      ];
      input.updateSession(input.session);
      return {
        session: input.session,
        appended: input.messages.length > 0
      };
    },
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true },
      layers: [{ id: "one", title: "One", role: "system", enabled: true, content: "system", order: 1 }],
      appendLayers: [{ id: "append_check", title: "Append check", role: "tool_request", enabled: true, content: "", thinking: "fake reason", toolCalls: [{ toolName: "Chat", toolArguments: "{\"action\":\"poll\"}" }], order: 1 }]
    }),
    tools: [{
      id: "messaging-test",
      listTools() {
        return [{ name: "Chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        if (call.input.action === "send") return { callId: call.id, ok: true, output: "sent" };
        appendCheckCount += 1;
        return { callId: call.id, ok: true, output: appendCheckCount === 1 ? "recent" : "new" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  await runPreparedChatEvent(core, textEvent());

  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages.some((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Chat"), false);
  assert.equal(requests[1].messages.some((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.arguments), true);
  assert.equal(requests[1].messages.at(-2)?.toolCalls?.[0].function.name, "Chat");
  assert.equal(requests[1].messages.at(-2)?.reasoningContent, "fake reason");
  assert.equal(requests[1].messages.at(-1)?.content, "recent");
  assert.equal(appendContextCalls, 1);
});

test("chat agent reuses appended context after llm request failures", async () => {
  const requests: LLMChatInput[] = [];
  let appendCheckCount = 0;
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length === 1) return { message: { role: "assistant", content: "first" } };
      throw new Error("LLM request failed: 503 Service Unavailable service is too busy");
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
      userName: "user",
      visibleTools: { feishu: true },
      layers: [{ id: "one", title: "One", role: "system", enabled: true, content: "system", order: 1 }],
      appendLayers: [{ id: "append_check", title: "Append check", role: "tool_request", enabled: true, content: "", toolCalls: [{ toolName: "Chat", toolArguments: "{\"action\":\"poll\"}" }], order: 1 }]
    }),
    tools: [{
      id: "messaging-test",
      listTools() {
        return [{ name: "Chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        if (call.input.action === "send") return { callId: call.id, ok: true, output: "sent" };
        appendCheckCount += 1;
        return { callId: call.id, ok: true, output: `recent ${appendCheckCount}` };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  await assert.rejects(() => runPreparedChatEvent(core, textEvent()), /503 Service Unavailable/);
  await assert.rejects(() => runPreparedChatEvent(core, textEvent()), /503 Service Unavailable/);

  assert.equal(requests.length, 3);
  assert.equal(appendCheckCount, 1);
  assert.deepEqual(requests[2].messages, requests[1].messages);
  assert.equal(requests[2].messages.at(-1)?.content, "recent 1");
});

test("chat agent records token pressure preview baseline from check chat preview", async () => {
  const scenario = createTokenPressureScenario();

  await runPreparedChatEvent(scenario.core, textEvent());
  await runPreparedChatEvent(scenario.core, textEvent());

  assert.deepEqual(scenario.previewCalls, [
    { action: "poll", __preview: true, __scope: "today" },
    { action: "poll", __preview: true, __scope: "today" }
  ]);
  assert.deepEqual(scenario.persistedSession?.tokenPressurePreviewBaselines?.["test-model|normal|today|"], {
    inputTokens: 8000,
    previewTokens: 3
  });
});

test("chat agent clears session before the next request under token pressure", async () => {
  const scenario = createTokenPressureScenario();

  await runPreparedChatEvent(scenario.core, textEvent());
  await runPreparedChatEvent(scenario.core, textEvent());
  await runPreparedChatEvent(scenario.core, textEvent());

  assert.deepEqual(scenario.events, ["completed", "completed", "cleared:token_pressure", "completed"]);
  assert.equal(scenario.requests[3].messages.some((message) => message.content === "final 2"), false);
});

function createTokenPressureScenario() {
  const requests: LLMChatInput[] = [];
  const events: string[] = [];
  const previewCalls: Array<Record<string, unknown>> = [];
  const normalCheckCalls: Array<Record<string, unknown>> = [];
  let persistedSession: LLMSessionSnapshot | undefined;
  let previewCount = 0;
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "tool_check",
              type: "function",
              function: { name: "Chat", arguments: "{\"action\":\"poll\"}" }
            }]
          },
          usage: { inputTokens: 4000, totalTokens: 4000 }
        };
      }
      if (requests.length === 2) {
        return {
          message: { role: "assistant", content: "final 2" },
          usage: { inputTokens: 8000, totalTokens: 8000 }
        };
      }
      return {
        message: { role: "assistant", content: `final ${requests.length}` },
        usage: { inputTokens: 12000, totalTokens: 12000 }
      };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_TOKEN_PRESSURE_CONTEXT_IMPORTANCE: "1" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true },
      layers: [{ id: "one", title: "One", role: "system", enabled: true, content: "system", order: 1 }]
    }),
    onLLMSessionCompleted() {
      events.push("completed");
    },
    onLLMSessionUpdated(session) {
      persistedSession = {
        messages: session.messages.map((message) => ({ ...message, toolCalls: message.toolCalls?.map((call) => ({ ...call, function: { ...call.function } })) })),
        staticPromptFingerprint: session.staticPromptFingerprint,
        requestTimestamps: [...session.requestTimestamps],
        lastTotalTokens: session.lastTotalTokens,
        lastInputTokens: session.lastInputTokens,
        lastUsageModel: session.lastUsageModel,
        tokenPressurePreviewBaselines: { ...(session.tokenPressurePreviewBaselines ?? {}) }
      };
    },
    loadLLMSession() {
      return persistedSession;
    },
    onLLMSessionCleared(reason) {
      events.push(`cleared:${reason}`);
      persistedSession = undefined;
    },
    tools: [{
      id: "messaging-test",
      listTools() {
        return [{ name: "Chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        if (call.input.__preview === true) {
          previewCalls.push(call.input);
          previewCount += 1;
          return { callId: call.id, ok: true, output: previewCount === 1 ? "0123456789" : "x".repeat(200) };
        }
        normalCheckCalls.push(call.input);
        return { callId: call.id, ok: true, output: "0123456789" };
      }
    }]
  });

  return {
    core,
    requests,
    events,
    previewCalls,
    normalCheckCalls,
    get persistedSession() {
      return persistedSession;
    }
  };
}
