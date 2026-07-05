import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateTokenPressureSwitch, createChatAgent as createChatAgentUnderTest, type LLMSessionSnapshot } from "../../../src/contexts/agent-loop/src/application/chat-agent.js";
import type { LLMRequestSenderInput } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import type { LLMChatInput, LLMClient } from "../../../src/contexts/llm-gateway/src/index.js";
import type { ToolCall } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { buildLLMTextVariables, createLLMTextVariableRenderer } from "../../../src/contexts/agent-profile/src/application/llm-text-renderer.js";
import { loadConfig } from "../../../src/apps/api/bootstrap/app-config-runtime.js";
import { createOutputRouter } from "../../../src/platform/output-router/src/index.js";
import { createAllowAllPolicy } from "../../../src/contexts/agent-loop/src/ports/policy.js";
import { createIntentRouter } from "../../../src/contexts/agent-loop/src/application/intent-router.js";
import { createSessionResolver } from "../../../src/contexts/agent-loop/src/application/session-resolver.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createAgentStateController, type AgentBehaviorState } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { createChatAgent, runPreparedChatEvent, textEvent, chatTestTools, memoryStore } from "./agent-tools-helpers.js";

test("chat agent requires an injected prompt profile", async () => {
  const core = createChatAgentUnderTest({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm: { async chat() { return { message: { role: "assistant", content: "unused" } }; } },
    getPromptRenderer: () => createLLMTextVariableRenderer({ variables: () => buildLLMTextVariables({ time: createCurrentTimeProvider("UTC") }) }),
    llmRequestSender: async () => ({ message: { role: "assistant", content: "unused" } }),
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy()
  });

  await assert.rejects(() => runPreparedChatEvent(core, textEvent()), /requires getPromptProfile/);
});

test("chat agent exposes platform-neutral tools", async () => {
  const requests: LLMChatInput[] = [];
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_TOKEN_PRESSURE_CONTEXT_IMPORTANCE: "1" }),
    llm: {
      async chat(input) {
        requests.push(input);
        return { message: { role: "assistant", content: "final answer" } };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [{
      id: "test-tools",
      listTools() {
        return [{
          name: "Chat",
          description: "view",
          inputSchema: { type: "object" }
        }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "history" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());

  assert.equal(requests[0].tools?.[0].function.name, "Chat");
});

test("chat agent resolves tool calls before final reply", async () => {
  const requests: LLMChatInput[] = [];
  const toolCalls: ToolCall[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "tool_1",
              type: "function",
              function: {
                name: "Chat",
                arguments: "{\"action\":\"poll\"}"
              }
            }]
          }
        };
      }
      return { message: { role: "assistant", content: "final answer" } };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_TOKEN_PRESSURE_CONTEXT_IMPORTANCE: "1" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [{
      id: "test-tools",
      listTools() {
        return [{
          name: "Chat",
          description: "view",
          inputSchema: { type: "object" }
        }];
      },
      async execute(call) {
        toolCalls.push(call);
        return { callId: call.id, ok: true, output: "history" };
      }
    }]
  });

  const outputs = await runPreparedChatEvent(core, textEvent());
  assert.deepEqual(outputs, []);
  assert.equal(toolCalls[0].toolName, "Chat");
  assert.equal(requests[1].messages.at(-1)?.role, "tool");
  assert.equal(requests[1].messages.at(-1)?.content, "history");
});

test("chat agent prepares chat loop execution for external function-call runtime", async () => {
  let externalRuntimeCalls = 0;
  let setActiveCalls = 0;
  let createActiveCalls = 0;
  let prepareChatSessionCalls = 0;
  let ensureChatSessionCalls = 0;
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_TOKEN_PRESSURE_CONTEXT_IMPORTANCE: "1" }),
    llm: {
      async chat() {
        throw new Error("direct llm client should not be called");
      }
    },
    setActiveLoopSessionContext(input) {
      setActiveCalls += 1;
      input.setLocalSession(input.session);
    },
    createActiveLoopSessionContext(input) {
      createActiveCalls += 1;
      input.setLocalSession(input.session);
      return input.session;
    },
    async prepareChatLoopSessionContext(input) {
      prepareChatSessionCalls += 1;
      const messages = await input.buildMessages();
      const session = input.createSession(messages);
      input.setLocalSession(session);
      return { session, messages };
    },
    async ensureChatLoopSessionContext(input) {
      ensureChatSessionCalls += 1;
      return input.getSession() ?? input.prepareSession(input.getPendingMode() ?? input.defaultMode());
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy()
  });

  const prepared = await core.prepareEventRun(textEvent());
  assert.equal(Array.isArray(prepared), false);
  if (Array.isArray(prepared)) throw new Error("expected prepared run");
  const spec = await Promise.resolve(prepared.prepare ? prepared.prepare() : prepared.spec);
  assert.ok(spec && !Array.isArray(spec));
  externalRuntimeCalls += 1;
  assert.equal(spec.initialMessages.length > 0, true);
  const finalMessage = { role: "assistant" as const, content: "runtime reply" };
  prepared.complete({
    messages: [...spec.initialMessages, finalMessage],
    rounds: 1,
    finalResult: { message: finalMessage },
    finalMessage,
    stopReason: "completed",
    invalidateSession: false,
    toolCallCount: 0
  });
  await prepared.dispose?.();

  assert.equal(externalRuntimeCalls, 1);
  assert.equal(setActiveCalls > 0, true);
  assert.equal(createActiveCalls, 0);
  assert.equal(prepareChatSessionCalls, 1);
  assert.equal(ensureChatSessionCalls, 1);
});

test("token pressure calculation is independent from preview execution", () => {
  assert.equal(calculateTokenPressureSwitch({
    lastInputTokens: 8000,
    baselineInputTokens: 4000,
    baselinePreviewTokens: 3,
    currentPreviewTokens: 60,
    cacheHitPrice: 0.02,
    cacheMissPrice: 1
  }).shouldReset, true);
});


test("chat agent sends tool names to injected LLM sender without rendering schemas", async () => {
  const senderInputs: LLMRequestSenderInput[] = [];
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_TOKEN_PRESSURE_CONTEXT_IMPORTANCE: "1" }),
    llm: {
      async chat() {
        throw new Error("direct llm client should not be called");
      }
    },
    llmRequestSender: async (input) => {
      senderInputs.push(input);
      return { message: { role: "assistant", content: "done" } };
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [{
      id: "test-tools",
      listTools() {
        return [{
          name: "Chat",
          get description(): string {
            throw new Error("tool description should be rendered by LLMRequests");
          },
          get inputSchema(): Record<string, unknown> {
            throw new Error("tool schema should be rendered by LLMRequests");
          }
        }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "history" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());

  assert.deepEqual(senderInputs[0].toolNames, ["Chat"]);
});

test("chat agent ordinary chat does not enter deprecated working state", async () => {
  const controller = createAgentStateController({
    store: memoryStore(),
    random: () => 0
  });
  const states: AgentBehaviorState[] = [];
  controller.onChange((snapshot) => {
    states.push(snapshot.state);
  });
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm: {
      async chat() {
        return { message: { role: "assistant", content: "done" } };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    state: controller
  });

  await runPreparedChatEvent(core, textEvent());

  assert.equal(states.includes("working"), false);
});

test("chat agent appends assistant tool call and tool result before the next llm request", async () => {
  const requests: LLMChatInput[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "checking history",
            reasoningContent: "I should inspect messages first.",
            toolCalls: [{
              id: "tool_1",
              type: "function",
              function: {
                name: "Chat",
                arguments: "{\"action\":\"poll\"}"
              }
            }]
          },
          finishReason: "tool_calls"
        };
      }
      return { message: { role: "assistant", content: "done" } };
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
      id: "test-tools",
      listTools() {
        return [{
          name: "Chat",
          description: "view",
          inputSchema: { type: "object" }
        }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "history result" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());

  assert.equal(requests.length, 2);
  const toolCallIndex = requests[1].messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.id === "tool_1");
  assert.ok(toolCallIndex >= 0);
  assert.equal(requests[1].messages[toolCallIndex]?.content, "checking history");
  assert.equal(requests[1].messages[toolCallIndex]?.reasoningContent, "I should inspect messages first.");
  assert.equal(requests[1].messages[toolCallIndex]?.toolCalls?.[0].function.name, "Chat");
  assert.equal(requests[1].messages[toolCallIndex + 1]?.role, "tool");
  assert.equal(requests[1].messages[toolCallIndex + 1]?.toolCallId, "tool_1");
  assert.equal(requests[1].messages[toolCallIndex + 1]?.content, "history result");
});

test("chat agent stops before another llm request when a tool invalidates the session", async () => {
  const requests: LLMChatInput[] = [];
  const sessionUpdates: LLMChatInput["messages"][] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length > 1) {
        throw new Error("unexpected follow-up llm request");
      }
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "tool_return",
            type: "function",
            function: {
              name: "Bookcase",
              arguments: "{\"action\":\"return\"}"
            }
          }]
        },
        finishReason: "tool_calls"
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
      id: "bookcase",
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
    clearActiveLoopSessionContext(input) {
      if (!input.getLocalSession()) return false;
      input.setLocalSession(undefined);
      input.onCleared?.();
      return true;
    },
    onLLMSessionUpdated(session) {
      sessionUpdates.push(session.messages);
    },
    onLLMSessionCleared() {}
  });

  await runPreparedChatEvent(core, textEvent());

  assert.equal(requests.length, 1);
  const latestMessages = sessionUpdates.at(-1) ?? [];
  assert.equal(latestMessages.at(-2)?.role, "assistant");
  assert.equal(latestMessages.at(-2)?.toolCalls?.[0].function.name, "Bookcase");
  assert.equal(latestMessages.at(-1)?.role, "tool");
  assert.equal(latestMessages.at(-1)?.content, "{\"action\":\"return\"}");
});

test("chat agent exits the current loop after finish_and_wait", async () => {
  const requests: LLMChatInput[] = [];
  const sessionUpdates: LLMSessionSnapshot[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length > 1) throw new Error("unexpected follow-up llm request");
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "tool_wait",
            type: "function",
            function: { name: "Yield", arguments: "{\"action\":\"poll\"}" }
          }]
        },
        finishReason: "tool_calls"
      };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    llm,
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
      sessionUpdates.push(session);
    }
  });

  await runPreparedChatEvent(core, textEvent());

  assert.equal(requests.length, 1);
  assert.equal(sessionUpdates.at(-1)?.waitChatStartedAt, "2026-05-26T00:00:00.000Z");
  assert.equal(sessionUpdates.at(-1)?.messages.at(-1)?.role, "assistant");
  assert.equal(sessionUpdates.at(-1)?.messages.at(-1)?.toolCalls?.[0]?.function.name, "Yield");
  assert.equal(sessionUpdates.at(-1)?.messages.some((message) => message.role === "tool" && message.name === "Yield"), false);
});
