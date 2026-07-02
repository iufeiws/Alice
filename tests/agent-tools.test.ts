import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateTokenPressureSwitch, createChatAgent as createChatAgentUnderTest, type ChatAgentDeps, type LLMSessionSnapshot } from "../src/contexts/agent-loop/src/application/chat-agent.js";
import type { LLMRequestSenderInput } from "../src/contexts/llm-gateway/src/llm-tool-loop.js";
import type { LLMChatInput, LLMClient } from "../src/contexts/llm-gateway/src/index.js";
import { createLLMRequests } from "../src/contexts/llm-gateway/src/llm-requests.js";
import type { AgentEvent, AgentOutput, ToolCall } from "../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import type { PromptProfile } from "../src/contexts/agent-profile/src/application/build-system-prompt.js";
import { buildLLMTextVariables } from "../src/contexts/agent-profile/src/application/llm-text-renderer.js";
import { loadConfig } from "../src/apps/api/bootstrap/app-config-runtime.js";
import { createOutputRouter } from "../src/platform/output-router/src/index.js";
import { createAllowAllPolicy } from "../src/contexts/agent-loop/src/ports/policy.js";
import { createIntentRouter } from "../src/contexts/agent-loop/src/application/intent-router.js";
import { createSessionResolver } from "../src/contexts/agent-loop/src/application/session-resolver.js";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";
import { createAgentStateController, type AgentBehaviorState, type AgentStateStore } from "../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { runAgentFunctionCallLoop } from "../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";

const fs = await import("node:fs");
const path = await import("node:path");

type TestChatAgentDeps = Omit<ChatAgentDeps, "llmRequestSender" | "getPromptVariables"> & Partial<Pick<ChatAgentDeps, "llmRequestSender">>;

function createChatAgent(deps: TestChatAgentDeps) {
  let persistedSession = deps.initialLLMSession;
  const loadLLMSession = deps.loadLLMSession ?? (() => persistedSession);
  const onLLMSessionUpdated = deps.onLLMSessionUpdated;
  const onLLMSessionCleared = deps.onLLMSessionCleared;
  const getPromptProfile = deps.getPromptProfile ?? testPromptProfile;
  const requestLogs = new WeakMap<object, any>();
  const llmRequestSender = deps.llmRequestSender ?? createLLMRequests({
    getTool(name) {
      for (const plugin of deps.tools ?? []) {
        const tool = plugin.listTools().find((entry) => entry.name === name);
        if (tool) return tool;
      }
      return undefined;
    },
    onRequestPrepared(input, request) {
      const entry = deps.onLLMRequestPrepared?.(request);
      if (entry) requestLogs.set(input, entry);
    },
    onResponseReceived(input, _request, result) {
      deps.onLLMResponseReceived?.(result, requestLogs.get(input));
    },
    onLog(event) {
      deps.onLLMLog?.({ ...event, round: event.round });
    }
  }).send;
  return createChatAgentUnderTest({
    getPromptProfile: testPromptProfile,
    ...deps,
    getPromptVariables: () => buildLLMTextVariables({ userName: getPromptProfile().userName, time: deps.time ?? createCurrentTimeProvider("UTC") }),
    llmRequestSender,
    loadLLMSession,
    onLLMSessionUpdated(session) {
      if (!deps.loadLLMSession) persistedSession = session;
      onLLMSessionUpdated?.(session);
    },
    onLLMSessionCleared(reason) {
      if (!deps.loadLLMSession) persistedSession = undefined;
      onLLMSessionCleared?.(reason);
    }
  });
}

type TestChatAgent = ReturnType<typeof createChatAgent>;

function testPromptProfile(): PromptProfile {
  const profile = JSON.parse(fs.readFileSync(path.join(process.cwd(), "src", "contexts", "agent-profile", "prompts", "prompt-profile.json"), "utf8")) as PromptProfile;
  return {
    ...profile,
    layers: profile.layers.filter((layer) => layer.role !== "tool_request"),
    appendLayers: (profile.appendLayers ?? []).filter((layer) => layer.role !== "tool_request")
  };
}

async function runPreparedChatEvent(core: TestChatAgent, event: AgentEvent): Promise<AgentOutput[]> {
  const prepared = await core.prepareEventRun(event);
  if (Array.isArray(prepared)) return prepared;
  try {
    const spec = await Promise.resolve(prepared.prepare ? prepared.prepare() : prepared.spec);
    if (!spec) return [];
    if (Array.isArray(spec)) return spec;
    return await Promise.resolve(prepared.complete(await runAgentFunctionCallLoop(spec))) ?? [];
  } catch (error) {
    await prepared.onError?.(error);
    throw error;
  } finally {
    await prepared.dispose?.();
  }
}

test("chat agent requires an injected prompt profile", async () => {
  const core = createChatAgentUnderTest({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm: { async chat() { return { message: { role: "assistant", content: "unused" } }; } },
    getPromptVariables: () => buildLLMTextVariables({ time: createCurrentTimeProvider("UTC") }),
    llmRequestSender: async () => ({ message: { role: "assistant", content: "unused" } }),
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy()
  });

  await assert.rejects(() => runPreparedChatEvent(core, textEvent()), /requires getPromptProfile/);
});

test("chat agent exposes platform-neutral tools and resolves tool calls before final reply", async () => {
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
  assert.equal(requests[0].tools?.[0].function.name, "Chat");
  assert.equal(toolCalls[0].toolName, "Chat");
  assert.equal(toolCalls[0].externalSession?.sessionId, "session-1");
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
    sentMessage: false,
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
  assert.deepEqual(calculateTokenPressureSwitch({
    lastInputTokens: 8000,
    baselineInputTokens: 4000,
    baselinePreviewTokens: 3,
    currentPreviewTokens: 60,
    cacheHitPrice: 0.02,
    cacheMissPrice: 1
  }), {
    lastInputTokens: 8000,
    baselineInputTokens: 4000,
    baselinePreviewTokens: 3,
    currentPreviewTokens: 60,
    cacheHitPrice: 0.02,
    cacheMissPrice: 1,
    contextImportance: 1,
    minRebuildTokens: 50,
    estimatedCurrentInputTokens: 4057,
    continuedTokenDelta: 4000,
    rebuildTokenDelta: 57,
    continuedCost: 80,
    rebuildCost: 57,
    shouldReset: true
  });
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
  const clearedReasons: string[] = [];
  let clearActiveCalls = 0;
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
              name: "bookcase",
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
        return [{ name: "bookcase", description: "bookcase", inputSchema: { type: "object" } }];
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
      clearActiveCalls += 1;
      input.setLocalSession(undefined);
      input.onCleared?.();
      return true;
    },
    onLLMSessionUpdated(session) {
      sessionUpdates.push(session.messages);
    },
    onLLMSessionCleared(reason) {
      clearedReasons.push(reason);
    }
  });

  await runPreparedChatEvent(core, textEvent());

  assert.equal(requests.length, 1);
  assert.equal(clearActiveCalls, 1);
  assert.equal(clearedReasons.at(-1), "prompt_static_changed");
  const latestMessages = sessionUpdates.at(-1) ?? [];
  assert.equal(latestMessages.at(-2)?.role, "assistant");
  assert.equal(latestMessages.at(-2)?.toolCalls?.[0].function.name, "bookcase");
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
            function: { name: "finish_and_wait", arguments: "{\"action\":\"poll\"}" }
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
  assert.equal(sessionUpdates.at(-1)?.messages.at(-1)?.toolCalls?.[0]?.function.name, "finish_and_wait");
  assert.equal(sessionUpdates.at(-1)?.messages.some((message) => message.role === "tool" && message.name === "finish_and_wait"), false);
});

test("chat agent resumes pending finish_and_wait with Chat result on heartbeat", async () => {
  const requests: LLMChatInput[] = [];
  const checkInputs: Record<string, unknown>[] = [];
  const sessionUpdates: LLMSessionSnapshot[] = [];
  let persistedSession: LLMSessionSnapshot | undefined;
  let nowMs = Date.parse("2026-05-26T00:00:00.000Z");
  const llm: LLMClient = {
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
              function: { name: "finish_and_wait", arguments: "{\"action\":\"poll\"}" }
            }]
          },
          finishReason: "tool_calls"
        };
      }
      return { message: { role: "assistant", content: "done" } };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    time: createCurrentTimeProvider("UTC", () => new Date(nowMs)),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true },
      layers: [{ id: "static", title: "Static", role: "system", enabled: true, content: "static prompt", order: 1 }],
      appendLayers: [{ id: "append_check", title: "Fake Chat", role: "tool_request", enabled: true, content: "", thinking: "check", toolCalls: [{ toolName: "Chat", toolArguments: "{\"action\":\"poll\"}" }], order: 1 }]
    }),
    tools: [chatTestTools((call) => {
      if (call.toolName === "Chat") checkInputs.push(call.input);
    })],
    onLLMSessionUpdated(session) {
      persistedSession = session;
      sessionUpdates.push(session);
    },
    loadLLMSession() {
      return persistedSession;
    }
  });

  await runPreparedChatEvent(core, textEvent());
  nowMs = Date.parse("2026-05-26T00:05:00.000Z");
  await runPreparedChatEvent(core, { ...textEvent(), id: "evt_2", type: "system.heartbeat" });

  assert.equal(requests.length, 2);
  assert.deepEqual(checkInputs, [{ action: "poll" }]);
  const secondMessages = requests[1].messages;
  const waitToolMessages = secondMessages.filter((message) => message.role === "tool" && message.name === "finish_and_wait");
  assert.equal(waitToolMessages.length, 1);
  assert.equal(waitToolMessages.at(-1)?.content, "<chat-log>\nnew chat\n</chat-log>\n<wait-duration>5m</wait-duration>\n<now local=\"2026-05-26T00:05:00.000\"/>");
  const waitIndex = secondMessages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "finish_and_wait");
  const checkChatAfterWait = secondMessages.slice(waitIndex + 1).find((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Chat");
  assert.equal(checkChatAfterWait, undefined);
  assert.equal(sessionUpdates.at(-1)?.waitChatStartedAt, undefined);
});

test("chat agent executes same-round tools when finish_and_wait appears and resumes wait result later", async () => {
  const requests: LLMChatInput[] = [];
  const calls: string[] = [];
  const sessionUpdates: LLMSessionSnapshot[] = [];
  let persistedSession: LLMSessionSnapshot | undefined;
  let nowMs = Date.parse("2026-05-26T00:00:00.000Z");
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length > 1) return { message: { role: "assistant", content: "done" } };
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tool_check",
              type: "function",
              function: { name: "Chat", arguments: "{\"action\":\"poll\"}" }
            },
            {
              id: "tool_wait",
              type: "function",
              function: { name: "finish_and_wait", arguments: "{\"action\":\"poll\"}" }
            },
            {
              id: "tool_later",
              type: "function",
              function: { name: "later_tool", arguments: "{\"action\":\"poll\"}" }
            }
          ]
        },
        finishReason: "tool_calls"
      };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    time: createCurrentTimeProvider("UTC", () => new Date(nowMs)),
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
    tools: [chatTestTools((call) => calls.push(call.toolName))],
    onLLMSessionUpdated(session) {
      persistedSession = session;
      sessionUpdates.push(session);
    },
    loadLLMSession() {
      return persistedSession;
    }
  });

  await runPreparedChatEvent(core, textEvent());

  assert.deepEqual(calls, ["Chat", "finish_and_wait", "later_tool"]);
  const latestMessages = sessionUpdates.at(-1)?.messages ?? [];
  const assistant = latestMessages.find((message) => message.role === "assistant" && message.toolCalls?.some((call) => call.function.name === "finish_and_wait"));
  assert.deepEqual(assistant?.toolCalls?.map((call) => call.function.name), ["Chat", "finish_and_wait", "later_tool"]);
  assert.equal(latestMessages.some((message) => message.role === "tool" && message.toolCallId === "tool_wait"), false);
  assert.equal(latestMessages.some((message) => message.role === "tool" && message.toolCallId === "tool_check"), true);
  assert.equal(latestMessages.some((message) => message.role === "tool" && message.toolCallId === "tool_later"), true);

  nowMs = Date.parse("2026-05-26T00:05:00.000Z");
  await runPreparedChatEvent(core, { ...textEvent(), id: "evt_resume", type: "system.heartbeat" });

  const resumedMessages = requests[1].messages;
  assert.equal(resumedMessages.some((message) => message.role === "tool" && message.toolCallId === "tool_check"), true);
  assert.equal(resumedMessages.some((message) => message.role === "tool" && message.toolCallId === "tool_wait"), true);
  assert.equal(resumedMessages.filter((message) => message.role === "tool" && message.toolCallId === "tool_later").length, 1);
});

test("chat agent rebuilds fixed prefix session immediately after bookcase draw", async () => {
  const requests: LLMChatInput[] = [];
  const checkChatInputs: Record<string, unknown>[] = [];
  let checkChatCallsInSession = 0;
  let activeArchiveSessionId: number | undefined;
  let nextArchiveSessionId = 1;
  const sessionUpdates: Array<{ id: number; mode?: string; messages: LLMChatInput["messages"] }> = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "old context marker",
            toolCalls: [{
              id: "tool_draw",
              type: "function",
              function: {
                name: "bookcase",
                arguments: "{\"action\":\"draw\"}"
              }
            }]
          },
          finishReason: "tool_calls"
        };
      }
      return { message: { role: "assistant", content: "story starts" } };
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
      layers: [{ id: "static", title: "Static", role: "system", enabled: true, content: "static prompt", order: 1 }],
      appendLayers: [{ id: "append_check", title: "Append check", role: "tool_request", enabled: true, content: "", thinking: "check", toolCalls: [{ toolName: "Chat", toolArguments: "{\"action\":\"poll\"}" }], order: 1 }]
    }),
    tools: [{
      id: "test-tools",
      listTools() {
        return [
          { name: "bookcase", description: "bookcase", inputSchema: { type: "object" } },
          { name: "Chat", description: "view", inputSchema: { type: "object" } }
        ];
      },
      async execute(call) {
        if (call.toolName === "bookcase") {
          return {
            callId: call.id,
            ok: true,
            resetLLMSession: true,
            fixedPrefixKind: "bookcase",
            output: "<book>static story</book>"
          };
        }
        if (call.input.__scope === "recent") {
          return { callId: call.id, ok: true, output: "recent chat" };
        }
        if (call.toolName === "Chat") checkChatInputs.push(call.input);
        checkChatCallsInSession += 1;
        return {
          callId: call.id,
          ok: true,
          messageCursorId: 42,
          output: checkChatCallsInSession === 1 ? "recent chat" : "fresh chat after fixed prefix"
        };
      }
    }],
    onLLMSessionUpdated(session) {
      activeArchiveSessionId ??= nextArchiveSessionId++;
      sessionUpdates.push({ id: activeArchiveSessionId, mode: session.mode, messages: session.messages });
    },
    onLLMSessionRebuilt() {
      activeArchiveSessionId = undefined;
      checkChatCallsInSession = 0;
    }
  });

  await runPreparedChatEvent(core, textEvent());

  assert.equal(requests.length, 2);
  const secondMessages = requests[1].messages;
  assert.equal(secondMessages.filter((message) => message.content === "static prompt").length, 1);
  assert.equal(secondMessages.some((message) => message.content === "old context marker"), true);
  const bookcaseIndex = secondMessages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "bookcase");
  const checkChatIndex = secondMessages.map((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Chat").lastIndexOf(true);
  assert.ok(bookcaseIndex >= 0);
  assert.ok(checkChatIndex > bookcaseIndex);
  assert.equal(secondMessages[bookcaseIndex + 1]?.content, "<book>static story</book>");
  assert.equal(secondMessages[checkChatIndex]?.toolCalls?.[0]?.function.arguments, "{\"action\":\"poll\"}");
  assert.equal(secondMessages[checkChatIndex + 1]?.content, "recent chat");
  assert.equal(checkChatInputs.at(-1)?.__fromPrefixAfterMessageId, 0);
  assert.equal(checkChatCallsInSession, 1);
  assert.deepEqual([...new Set(sessionUpdates.map((update) => update.id))], [1, 2]);
  assert.equal(sessionUpdates.at(-1)?.id, 2);
  assert.equal(sessionUpdates.at(-1)?.mode, "fixed_prefix");

  await runPreparedChatEvent(core, textEvent());

  assert.equal(requests.length, 3);
  const thirdMessages = requests[2].messages;
  const thirdCheckChatIndex = thirdMessages.map((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Chat").lastIndexOf(true);
  assert.ok(thirdCheckChatIndex > bookcaseIndex);
  assert.equal(thirdMessages[thirdCheckChatIndex]?.toolCalls?.[0]?.function.arguments, "{\"action\":\"poll\"}");
  assert.equal(thirdMessages[thirdCheckChatIndex + 1]?.content, "fresh chat after fixed prefix");
  const fromPrefixInputs = checkChatInputs.filter((input) => input.scope === "from_prefix");
  assert.equal(fromPrefixInputs.length, 2);
  assert.deepEqual(fromPrefixInputs.map((input) => input.__fromPrefixAfterMessageId), [0, 42]);
});

test("chat agent does not duplicate fixed prefix messages when appending fixed prefix context", async () => {
  const fixedPrefixStatic: LLMChatInput["messages"] = [
    { role: "system", content: "fixed static prompt" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "tool_draw",
        type: "function",
        function: { name: "bookcase", arguments: "{\"action\":\"draw\"}" }
      }]
    },
    { role: "tool", name: "bookcase", toolCallId: "tool_draw", content: "<book>fixed story</book>" }
  ];
  const requests: LLMChatInput[] = [];
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-30T01:00:00.000Z")),
    llm: {
      async chat(input) {
        requests.push(input);
        return { message: { role: "assistant", content: "story continues" } };
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
        return { callId: call.id, ok: true, output: "fresh chat" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());

  const messages = requests[0].messages;
  assert.equal(messages.filter((message) => message.content === "fixed static prompt").length, 1);
  assert.equal(messages.filter((message) => message.content === "<book>fixed story</book>").length, 1);
  assert.equal(messages.filter((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "bookcase").length, 1);
  assert.equal(messages.filter((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Chat").length, 1);
});

for (const scenario of [
  {
    fixedPrefixKind: "sleep_cocoon",
    enterCallId: "tool_sleep_in",
    clearCallId: "tool_sleep_out",
    clearArguments: "{\"action\":\"out\"}"
  },
  {
    fixedPrefixKind: "bookcase",
    enterCallId: "tool_bookcase_draw",
    clearCallId: "tool_bookcase_return",
    clearArguments: "{\"action\":\"return\"}"
  }
] as const) {
  test(`chat agent clears ${scenario.fixedPrefixKind} fixed prefix without rebuilding the session`, async () => {
    const fixedPrefixStatic: LLMChatInput["messages"] = [
      { role: "system", content: `${scenario.fixedPrefixKind} fixed prompt` },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: scenario.enterCallId,
          type: "function",
          function: { name: scenario.fixedPrefixKind, arguments: "{\"action\":\"poll\"}" }
        }]
      },
      { role: "tool", name: scenario.fixedPrefixKind, toolCallId: scenario.enterCallId, content: "success" }
    ];
    const requests: LLMChatInput[] = [];
    const sessionUpdates: LLMSessionSnapshot[] = [];
    let cleared = false;
    const core = createChatAgent({
      config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-30T01:00:00.000Z")),
      llm: {
        async chat(input) {
          requests.push(input);
          if (requests.length > 1) return { message: { role: "assistant", content: "done" } };
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{
                id: scenario.clearCallId,
                type: "function",
                function: { name: scenario.fixedPrefixKind, arguments: scenario.clearArguments }
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
        layers: [{ id: "static", title: "Static", role: "system", enabled: true, content: "new static prompt", order: 1 }],
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
        fixedPrefixKind: scenario.fixedPrefixKind,
        fixedPrefixCursorMessageId: 12
      },
      tools: [{
        id: scenario.fixedPrefixKind,
        listTools() {
          return [
            { name: "Chat", description: "view", inputSchema: { type: "object" } },
            { name: scenario.fixedPrefixKind, description: scenario.fixedPrefixKind, inputSchema: { type: "object" } }
          ];
        },
        async execute(call) {
          if (call.toolName === "Chat") return { callId: call.id, ok: true, output: "nothing new" };
          return {
            callId: call.id,
            ok: true,
            resetLLMSession: true,
            clearFixedPrefix: true,
            output: "success"
          };
        }
      }],
      onLLMSessionUpdated(session) {
        sessionUpdates.push(session);
      },
      onLLMSessionCleared() {
        cleared = true;
      }
    });

    await runPreparedChatEvent(core, textEvent());

    assert.equal(requests.length, 2);
    assert.equal(cleared, false);
    const secondRequestMessages = requests[1].messages;
    const requestClearIndex = secondRequestMessages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.id === scenario.clearCallId);
    assert.ok(requestClearIndex >= 0);
    assert.equal(secondRequestMessages[requestClearIndex + 1]?.role, "tool");
    assert.equal(secondRequestMessages[requestClearIndex + 1]?.toolCallId, scenario.clearCallId);
    const latest = sessionUpdates.at(-1);
    assert.equal(latest?.mode, "normal");
    assert.equal(latest?.fixedPrefixKind, undefined);
    assert.equal(latest?.fixedPrefixCursorMessageId, undefined);
    const clearIndex = latest?.messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.id === scenario.clearCallId) ?? -1;
    assert.ok(clearIndex >= 0);
    assert.equal(latest?.messages[clearIndex + 1]?.role, "tool");
    assert.equal(latest?.messages[clearIndex + 1]?.toolCallId, scenario.clearCallId);
  });
}

test("chat agent injects fixed prefix cursor into model requested from_prefix checks", async () => {
  const fixedPrefixStatic: LLMChatInput["messages"] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "tool_draw",
        type: "function",
        function: { name: "bookcase", arguments: "{\"action\":\"draw\"}" }
      }]
    },
    { role: "tool", name: "bookcase", toolCallId: "tool_draw", content: "<book>fixed story</book>" }
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

test("chat agent keeps fixed prefix current transcript when token pressure runs", async () => {
  let capturedSession: LLMSessionSnapshot | undefined;
  const promptProfile = {
    userName: "user",
    visibleTools: { feishu: true },
    layers: [{ id: "static", title: "Static", role: "system" as const, enabled: true, content: "static prompt", order: 1 }],
    appendLayers: [{ id: "append_check", title: "Append check", role: "tool_request" as const, enabled: true, content: "", thinking: "check", toolCalls: [{ toolName: "Chat", toolArguments: "{\"action\":\"poll\"}" }], order: 1 }]
  };
  const primerCore = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    llm: { async chat() { return { message: { role: "assistant", content: "primer" } }; } },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => promptProfile,
    tools: [{
      id: "messaging",
      listTools() {
        return [{ name: "Chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "recent" };
      }
    }],
    onLLMSessionUpdated(session) {
      capturedSession = session;
    }
  });
  await runPreparedChatEvent(primerCore, textEvent());
  assert.ok(capturedSession?.staticPromptFingerprint);

  const fixedPrefixStatic: LLMChatInput["messages"] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "tool_draw",
        type: "function",
        function: { name: "bookcase", arguments: "{\"action\":\"draw\"}" }
      }]
    },
    { role: "tool", name: "bookcase", toolCallId: "tool_draw", content: "<book>persistent story</book>" }
  ];
  const requests: LLMChatInput[] = [];
  const clearedReasons: string[] = [];
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-30T01:00:00.000Z")),
    llm: {
      async chat(input) {
        requests.push(input);
        return { message: { role: "assistant", content: "after rebuild" } };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => promptProfile,
    initialLLMSession: {
      ...capturedSession,
      messages: [
        ...(capturedSession?.messages ?? []),
        { role: "assistant", content: "old session marker" }
      ],
      lastTotalTokens: 10_000,
      mode: "fixed_prefix",
      modeStaticMessages: fixedPrefixStatic,
      modeStaticTokenEstimate: 100,
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
        return { callId: call.id, ok: true, output: "recent" };
      }
    }],
    onLLMSessionCleared(reason) {
      clearedReasons.push(reason);
    }
  });

  await runPreparedChatEvent(core, textEvent());

  assert.deepEqual(clearedReasons, []);
  assert.equal(requests.length, 1);
  const messages = requests[0].messages;
  assert.equal(messages.some((message) => typeof message.content === "string" && message.content.includes("old session marker")), true);
  const checkChatIndex = messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Chat");
  assert.ok(checkChatIndex >= 0);
  assert.equal(messages[checkChatIndex + 1]?.content, "recent");
});

test("chat agent uses fixed prefix current transcript from an initial session snapshot", async () => {
  const fixedPrefixStatic: LLMChatInput["messages"] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "tool_draw",
        type: "function",
        function: { name: "bookcase", arguments: "{\"action\":\"draw\"}" }
      }]
    },
    { role: "tool", name: "bookcase", toolCallId: "tool_draw", content: "<book>restored story</book>" }
  ];
  const requests: LLMChatInput[] = [];
  const clearedReasons: string[] = [];
  const sessionUpdates: LLMSessionSnapshot[] = [];
  const modeStartedAt = "2026-05-30T00:00:00.000Z";
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-30T01:00:00.000Z")),
    llm: {
      async chat(input) {
        requests.push(input);
        return { message: { role: "assistant", content: "restored" } };
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
      appendLayers: [{ id: "append_check", title: "Append check", role: "tool_request", enabled: true, content: "", thinking: "check", toolCalls: [{ toolName: "Chat", toolArguments: "{\"action\":\"poll\"}" }], order: 1 }]
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
      modeStartedAt,
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
        return { callId: call.id, ok: true, output: "fresh chat after restore" };
      }
    }],
    onLLMSessionCleared(reason) {
      clearedReasons.push(reason);
    },
    onLLMSessionUpdated(session) {
      sessionUpdates.push(session);
    }
  });

  await runPreparedChatEvent(core, textEvent());

  assert.deepEqual(clearedReasons, []);
  assert.equal(requests.length, 1);
  const messages = requests[0].messages;
  assert.equal(messages.some((message) => message.content === "old live context"), true);
  assert.equal(messages.some((message) => message.content === "old static prompt"), true);
  const bookcaseIndex = messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "bookcase");
  const checkChatIndex = messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Chat");
  assert.ok(bookcaseIndex >= 0);
  assert.ok(checkChatIndex > bookcaseIndex);
  assert.equal(messages[bookcaseIndex + 1]?.content, "<book>restored story</book>");
  assert.equal(messages[checkChatIndex + 1]?.content, "fresh chat after restore");
  assert.equal(sessionUpdates.at(-1)?.mode, "fixed_prefix");
  assert.equal(sessionUpdates.at(-1)?.modeStartedAt, modeStartedAt);
  assert.equal(sessionUpdates.at(-1)?.fixedPrefixKind, "bookcase");
});

test("chat agent exits expired fixed prefix mode on the next request", async () => {
  const fixedPrefixStatic: LLMChatInput["messages"] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "tool_draw",
        type: "function",
        function: { name: "bookcase", arguments: "{\"action\":\"draw\"}" }
      }]
    },
    { role: "tool", name: "bookcase", toolCallId: "tool_draw", content: "<book>expired story</book>" }
  ];
  const requests: LLMChatInput[] = [];
  const clearedReasons: string[] = [];
  const sessionUpdates: LLMSessionSnapshot[] = [];
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
      appendLayers: [{ id: "append_check", title: "Append check", role: "tool_request", enabled: true, content: "", thinking: "check", toolCalls: [{ toolName: "Chat", toolArguments: "{\"action\":\"poll\"}" }], order: 1 }]
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
      fixedPrefixCursorMessageId: 12
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
    onLLMSessionCleared(reason) {
      clearedReasons.push(reason);
    },
    onLLMSessionUpdated(session) {
      sessionUpdates.push(session);
    }
  });

  await runPreparedChatEvent(core, textEvent());

  assert.deepEqual(clearedReasons, ["mode_timeout"]);
  assert.equal(requests.length, 1);
  const messages = requests[0].messages;
  assert.equal(messages.some((message) => message.content === "old live context"), false);
  assert.equal(messages.some((message) => message.content === "<book>expired story</book>"), false);
  assert.equal(messages.some((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "bookcase"), false);
  assert.equal(messages.at(-1)?.content, "new static prompt");
  assert.equal(sessionUpdates.at(-1)?.mode, "normal");
  assert.equal(sessionUpdates.at(-1)?.modeStartedAt, undefined);
});

test("chat agent passes agent loop run context to exposed selfie tool calls", async () => {
  const requests: LLMChatInput[] = [];
  const executed: string[] = [];
  const contexts: Array<{ agentLoopRunSeq?: number; llmSessionId?: number }> = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tool_selfie_1",
                type: "function",
                function: { name: "selfie", arguments: "{\"pose\":\"first\"}" }
              },
              {
                id: "tool_selfie_2",
                type: "function",
                function: { name: "selfie", arguments: "{\"pose\":\"second\"}" }
              }
            ]
          }
        };
      }
      return { message: { role: "assistant", content: "done" } };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-08T00:00:00.000Z")),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: false, photo: true },
      layers: [{ id: "static", title: "Static", role: "system", enabled: true, content: "static prompt", order: 1 }]
    }),
    tools: [{
      id: "photo",
      listTools() {
        return [{ name: "selfie", description: "selfie", inputSchema: { type: "object" } }];
      },
      async execute(call, context) {
        executed.push(String(call.input.pose));
        contexts.push({ agentLoopRunSeq: context?.agentLoopRunSeq, llmSessionId: context?.llmSessionId });
        return { callId: call.id, ok: true, output: "sent" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());

  assert.deepEqual(executed, ["first", "second"]);
  assert.equal(requests[1].messages.at(-2)?.content, "sent");
  assert.equal(requests[1].messages.at(-1)?.content, "sent");
  assert.deepEqual(contexts, [
    { agentLoopRunSeq: 1, llmSessionId: Date.parse("2026-06-08T00:00:00.000Z") },
    { agentLoopRunSeq: 1, llmSessionId: Date.parse("2026-06-08T00:00:00.000Z") }
  ]);
});

test("chat agent uses empty reasoning content for tool requests when missing", async () => {
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
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [{
      id: "test-tools",
      listTools() {
        return [{ name: "Chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "history result" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());

  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-2)?.reasoningContent, "");
});

test("chat agent filters messaging tools when feishu visibility is disabled", async () => {
  const requests: LLMChatInput[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "ok" } };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: false },
      layers: [{ id: "one", title: "One", role: "system", enabled: true, content: "system", order: 1 }]
    }),
    tools: [{
      id: "messaging",
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
  assert.deepEqual(requests[0].tools, []);
});

test("chat agent filters photo tools when photo visibility is disabled", async () => {
  const requests: LLMChatInput[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "ok" } };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true, photo: false },
      layers: [{ id: "one", title: "One", role: "system", enabled: true, content: "system", order: 1 }]
    }),
    tools: [{
      id: "messaging",
      listTools() {
        return [{ name: "Chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "history" };
      }
    }, {
      id: "photo",
      listTools() {
        return [{ name: "selfie", description: "selfie", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "sent" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  assert.deepEqual(requests[0].tools?.map((tool) => tool.function.name), ["Chat"]);
});

test("chat agent skips llm calls when prompt profile has no enabled messages", async () => {
  const requests: LLMChatInput[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "ok" } };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true },
      layers: []
    })
  });

  const outputs = await runPreparedChatEvent(core, textEvent());
  assert.deepEqual(outputs, []);
  assert.equal(requests.length, 0);
});

test("chat agent renders prompt profile layers before user message", async () => {
  const requests: LLMChatInput[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "ok" } };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "小王",
      visibleTools: { feishu: true },
      layers: [
        { id: "sys", title: "Sys", role: "system", enabled: true, content: "hello {{user}}", order: 1 },
        { id: "usr", title: "Usr", role: "user", enabled: true, content: "timezone {{timezone}}", order: 2 }
      ]
    })
  });

  await runPreparedChatEvent(core, textEvent());
  assert.equal(requests[0].messages[0].role, "system");
  assert.equal(requests[0].messages[0].content, "hello 小王");
  assert.equal(requests[0].messages[1].role, "user");
  assert.equal(requests[0].messages[1].content, "timezone UTC");
  assert.equal(requests[0].messages.length, 2);
});

test("chat agent runs prompt tool request layers and appends actual tool result", async () => {
  const requests: LLMChatInput[] = [];
  const toolCalls: ToolCall[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "ok" } };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true },
      layers: [{
        id: "history",
        title: "History",
        role: "tool_request",
        enabled: true,
        content: "",
        thinking: "need history",
        toolCalls: [{
          toolName: "Chat",
          toolCallId: "call_prompt_history",
          toolArguments: "{\"action\":\"poll\"}"
        }],
        order: 1
      }]
    }),
    tools: [{
      id: "messaging",
      listTools() {
        return [{
          name: "Chat",
          description: "view",
          inputSchema: { type: "object" }
        }];
      },
      async execute(call) {
        toolCalls.push(call);
        return { callId: call.id, ok: true, output: "actual history" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());

  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].id, "call_prompt_history");
  assert.equal(toolCalls[0].toolName, "Chat");
  assert.deepEqual(toolCalls[0].input, { action: "poll" });
  assert.equal(requests[0].messages[0].role, "assistant");
  assert.equal(requests[0].messages[0].toolCalls?.[0].id, "call_prompt_history");
  assert.equal(requests[0].messages[1].role, "tool");
  assert.equal(requests[0].messages[1].content, "actual history");
});

test("chat agent waits for final Chat JSON and sends newline message content once", async () => {
  const requests: LLMChatInput[] = [];
  const sentLines: string[] = [];
  const completed: Array<{ sentMessage: boolean }> = [];
  const llm: LLMClient = {
    async chat(input) {
      return this.chatStream ? this.chatStream(input) : { message: { role: "assistant", content: "fallback" } };
    },
    async chatStream(input, handlers) {
      requests.push(input);
      if (requests.length === 1) {
        await handlers?.onToolCallDelta?.({
          index: 0,
          id: "tool_send",
          type: "function",
          function: {
            name: "Chat",
            arguments: "{\"action\":\"send\",\"type\":\"message\",\"content\":\"one\\n"
          }
        });
        assert.deepEqual(sentLines, []);
        await handlers?.onToolCallDelta?.({
          index: 0,
          function: {
            arguments: "two\\nthree\"}"
          }
        });
        assert.deepEqual(sentLines, []);
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "tool_send",
              type: "function",
              function: {
                name: "Chat",
                arguments: "{\"action\":\"send\",\"type\":\"message\",\"content\":\"one\\ntwo\\nthree\"}"
              }
            }]
          }
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
    onLLMSessionCompleted(result) {
      completed.push(result);
    },
    tools: [{
      id: "messaging-test",
      listTools() {
        return [{
          name: "Chat",
          description: "send",
          inputSchema: { type: "object" }
        }];
      },
      async execute(call) {
        sentLines.push(String(call.input.content));
        return { callId: call.id, ok: true, output: `sent: ${call.input.content}` };
      }
    }]
  });

  const outputs = await runPreparedChatEvent(core, textEvent());
  assert.deepEqual(outputs, []);
  assert.deepEqual(sentLines, ["one\ntwo\nthree"]);
  assert.equal(requests.length, 2);
  assert.deepEqual(completed, [{ sentMessage: true }]);
});

test("chat agent waits for final Chat JSON before sending duplicated-content arguments", async () => {
  const requests: LLMChatInput[] = [];
  const sentLines: string[] = [];
  const llm: LLMClient = {
    async chat(input) {
      return this.chatStream ? this.chatStream(input) : { message: { role: "assistant", content: "fallback" } };
    },
    async chatStream(input, handlers) {
      requests.push(input);
      if (requests.length === 1) {
        await handlers?.onToolCallDelta?.({
          index: 0,
          id: "tool_bad",
          type: "function",
          function: {
            name: "Chat",
            arguments: "{\"action\":\"send\",\"type\":\"message\",\"content\":\"原来如此。那这个测试,\\n"
          }
        });
        assert.deepEqual(sentLines, []);
        await handlers?.onToolCallDelta?.({
          index: 0,
          function: {
            arguments: "\\n<｜｜DSML｜｜parameter name=\\\"type\\\" string=\\\"true\\\">message\", \"content\":\"算是通过了吗,父皇？\"}"
          }
        });
        assert.deepEqual(sentLines, []);
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "tool_bad",
              type: "function",
              function: {
                name: "Chat",
                arguments: "{\"action\":\"send\",\"type\":\"message\",\"content\":\"原来如此。那这个测试,\\n\\n<｜｜DSML｜｜parameter name=\\\"type\\\" string=\\\"true\\\">message\", \"content\":\"算是通过了吗,父皇？\"}"
              }
            }]
          }
        };
      }
      if (requests.length === 2) {
        const toolMessage = input.messages.find((message) => message.role === "tool");
        assert.equal(toolMessage?.content, "sent: 算是通过了吗,父皇？");
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "tool_good",
              type: "function",
              function: {
                name: "Chat",
                arguments: "{\"action\":\"send\",\"type\":\"message\",\"content\":\"原来如此。那这个测试算是通过了吗,父皇？\"}"
              }
            }]
          }
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
      id: "messaging-test",
      listTools() {
        return [{ name: "Chat", description: "send", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        if (typeof call.input.content !== "string") {
          return { callId: call.id, ok: false, error: "invalid Chat arguments" };
        }
        sentLines.push(String(call.input.content));
        return { callId: call.id, ok: true, output: `sent: ${call.input.content}` };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  assert.deepEqual(sentLines, ["算是通过了吗,父皇？", "原来如此。那这个测试算是通过了吗,父皇？"]);
});

test("chat agent waits for final Chat JSON and sends newline voice content once", async () => {
  const sentLines: string[] = [];
  const llm: LLMClient = {
    async chat(input) {
      return this.chatStream ? this.chatStream(input) : { message: { role: "assistant", content: "fallback" } };
    },
    async chatStream(input, handlers) {
      if (input.messages.some((message) => message.role === "tool")) {
        return { message: { role: "assistant", content: "done" } };
      }
      await handlers?.onToolCallDelta?.({
        index: 0,
        id: "tool_send",
        type: "function",
        function: {
          name: "Chat",
          arguments: "{\"action\":\"send\",\"type\":\"voice\",\"content\":\"第一句\\\\n"
        }
      });
      assert.deepEqual(sentLines, []);
      await handlers?.onToolCallDelta?.({
        index: 0,
        function: {
          arguments: "第二句\\\\n第三句\"}"
        }
      });
      assert.deepEqual(sentLines, []);
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "tool_send",
            type: "function",
            function: {
              name: "Chat",
              arguments: "{\"action\":\"send\",\"type\":\"voice\",\"content\":\"第一句\\\\n第二句\\\\n第三句\"}"
            }
          }]
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
        return [{
          name: "Chat",
          description: "send",
          inputSchema: { type: "object" }
        }];
      },
      async execute(call) {
        sentLines.push(`${String(call.input.type)}:${String(call.input.content)}`);
        return { callId: call.id, ok: true, output: `sent: ${call.input.content}` };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  assert.deepEqual(sentLines, ["voice:第一句\\n第二句\\n第三句"]);
});

test("chat agent waits for final Chat JSON when type is omitted", async () => {
  const sentLines: string[] = [];
  const llm: LLMClient = {
    async chat(input) {
      return this.chatStream ? this.chatStream(input) : { message: { role: "assistant", content: "fallback" } };
    },
    async chatStream(input, handlers) {
      if (input.messages.some((message) => message.role === "tool")) {
        return { message: { role: "assistant", content: "done" } };
      }
      await handlers?.onToolCallDelta?.({
        index: 0,
        id: "tool_send",
        type: "function",
        function: {
          name: "Chat",
          arguments: "{\"action\":\"send\",\"content\":\"one\\n"
        }
      });
      assert.deepEqual(sentLines, []);
      await handlers?.onToolCallDelta?.({
        index: 0,
        function: {
          arguments: "two\"}"
        }
      });
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "tool_send",
            type: "function",
            function: {
              name: "Chat",
              arguments: "{\"action\":\"send\",\"content\":\"one\\ntwo\"}"
            }
          }]
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
        return [{
          name: "Chat",
          description: "send",
          inputSchema: { type: "object" }
        }];
      },
      async execute(call) {
        sentLines.push(String(call.input.content));
        return { callId: call.id, ok: true, output: `sent: ${call.input.content}` };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  assert.deepEqual(sentLines, ["one\ntwo"]);
});

test("chat agent sends one final Chat message when tool metadata arrives after arguments", async () => {
  const sentLines: string[] = [];
  const llm: LLMClient = {
    async chat(input) {
      return this.chatStream ? this.chatStream(input) : { message: { role: "assistant", content: "fallback" } };
    },
    async chatStream(input, handlers) {
      if (input.messages.some((message) => message.role === "tool")) {
        return { message: { role: "assistant", content: "done" } };
      }
      await handlers?.onToolCallDelta?.({
        index: 0,
        function: {
          arguments: "{\"action\":\"send\",\"content\":\"对、对不起……主人不是在凶您。\\n只是上次您熬到凌晨五点，\\n主人有点担心……\",\"type\":\"message\"}"
        }
      });
      assert.deepEqual(sentLines, []);
      await handlers?.onToolCallDelta?.({
        index: 0,
        id: "tool_send",
        type: "function",
        function: {
          name: "Chat"
        }
      });
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "tool_send",
            type: "function",
            function: {
              name: "Chat",
              arguments: "{\"action\":\"send\",\"content\":\"对、对不起……主人不是在凶您。\\n只是上次您熬到凌晨五点，\\n主人有点担心……\",\"type\":\"message\"}"
            }
          }]
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
        return [{
          name: "Chat",
          description: "send",
          inputSchema: { type: "object" }
        }];
      },
      async execute(call) {
        sentLines.push(String(call.input.content));
        return { callId: call.id, ok: true, output: `sent: ${call.input.content}` };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  assert.deepEqual(sentLines, ["对、对不起……主人不是在凶您。\n只是上次您熬到凌晨五点，\n主人有点担心……"]);
});

test("chat agent does not stream Chat before type is known", async () => {
  const sentLines: string[] = [];
  const llm: LLMClient = {
    async chat(input) {
      return this.chatStream ? this.chatStream(input) : { message: { role: "assistant", content: "fallback" } };
    },
    async chatStream(input, handlers) {
      if (input.messages.some((message) => message.role === "tool")) {
        return { message: { role: "assistant", content: "done" } };
      }
      await handlers?.onToolCallDelta?.({
        index: 0,
        id: "tool_send",
        type: "function",
        function: {
          name: "Chat",
          arguments: "{\"action\":\"send\",\"content\":\"should not stream\\n"
        }
      });
      assert.deepEqual(sentLines, []);
      await handlers?.onToolCallDelta?.({
        index: 0,
        function: {
          arguments: "\",\"type\":\"markdown\"}"
        }
      });
      assert.deepEqual(sentLines, []);
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "tool_send",
            type: "function",
            function: {
              name: "Chat",
              arguments: "{\"action\":\"send\",\"content\":\"should not stream\\n\",\"type\":\"markdown\"}"
            }
          }]
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
        return [{
          name: "Chat",
          description: "send",
          inputSchema: { type: "object" }
        }];
      },
      async execute(call) {
        sentLines.push(`${call.input.type ?? "message"}:${call.input.content}`);
        return { callId: call.id, ok: true, output: `sent: ${call.input.content}` };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  assert.deepEqual(sentLines, ["markdown:should not stream\n"]);
});

test("chat agent sends final newline Chat content into one tool message", async () => {
  const requests: LLMChatInput[] = [];
  const llm: LLMClient = {
    async chat(input) {
      return this.chatStream ? this.chatStream(input) : { message: { role: "assistant", content: "fallback" } };
    },
    async chatStream(input, handlers) {
      requests.push(input);
      if (requests.length > 1) {
        return { message: { role: "assistant", content: "done" } };
      }
      await handlers?.onToolCallDelta?.({
        index: 0,
        id: "tool_send",
        type: "function",
        function: {
          name: "Chat",
          arguments: "{\"action\":\"send\",\"content\":\"one\\n"
        }
      });
      await handlers?.onToolCallDelta?.({
        index: 0,
        function: {
          arguments: "two\"}"
        }
      });
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "tool_send",
            type: "function",
            function: {
              name: "Chat",
              arguments: "{\"action\":\"send\",\"content\":\"one\\ntwo\"}"
            }
          }]
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
        return [{ name: "Chat", description: "send", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return {
          callId: call.id,
          ok: true,
          output: `<chat-log>\n[today 22:48]\nAlice:${String(call.input.content)}\n</chat-log>\n<now local="2026-05-27 22:48:53"/>`
        };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  const toolMessage = requests[1].messages.find((message) => message.role === "tool");
  assert.equal(toolMessage?.content, "<chat-log>\n[today 22:48]\nAlice:one\ntwo\n</chat-log>\n<now local=\"2026-05-27 22:48:53\"/>");
});

test("chat agent can disable LLM streaming from config", async () => {
  const sentLines: string[] = [];
  let chatCalls = 0;
  const llm: LLMClient = {
    async chat(input) {
      chatCalls += 1;
      if (input.messages.some((message) => message.role === "tool")) {
        return { message: { role: "assistant", content: "done" } };
      }
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "tool_send",
            type: "function",
            function: {
              name: "Chat",
              arguments: "{\"action\":\"send\",\"type\":\"message\",\"content\":\"one\\ntwo\"}"
            }
          }]
        }
      };
    },
    async chatStream() {
      throw new Error("chatStream should not be called when streaming is disabled");
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [{
      id: "messaging-test",
      listTools() {
        return [{
          name: "Chat",
          description: "send",
          inputSchema: { type: "object" }
        }];
      },
      async execute(call) {
        sentLines.push(String(call.input.content));
        return { callId: call.id, ok: true, output: `sent: ${call.input.content}` };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  assert.equal(chatCalls, 2);
  assert.deepEqual(sentLines, ["one\ntwo"]);
});

test("chat agent emits llm lifecycle logs for streaming and non-streaming calls", async () => {
  const streamLogs: string[] = [];
  const streamCore = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm: {
      async chat() {
        throw new Error("chat should not be called");
      },
      async chatStream() {
        return { message: { role: "assistant", content: "done" } };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    onLLMLog(event) {
      streamLogs.push(`${event.kind}:${event.stream}`);
    }
  });

  await runPreparedChatEvent(streamCore, textEvent());
  assert.deepEqual(streamLogs, ["call_start:true", "stream_start:true", "stream_end:true"]);

  const nonStreamLogs: string[] = [];
  const nonStreamCore = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    llm: {
      async chat() {
        return { message: { role: "assistant", content: "done" } };
      },
      async chatStream() {
        throw new Error("chatStream should not be called");
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    onLLMLog(event) {
      nonStreamLogs.push(`${event.kind}:${event.stream}`);
    }
  });

  await runPreparedChatEvent(nonStreamCore, textEvent());
  assert.deepEqual(nonStreamLogs, ["call_start:false", "response_received:false"]);
});

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
            content: "need more",
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
  assert.deepEqual(sent, ["final"]);
  assert.equal(requests.length, 4);
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
              function: { name: "wardrobe", arguments: "{\"action\":\"mirror\"}" }
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
          { name: "wardrobe", description: "mirror", inputSchema: { type: "object" } }
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
        appendCheckCount += 1;
        return { callId: call.id, ok: true, output: appendCheckCount === 1 ? "recent" : "new" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  await runPreparedChatEvent(core, textEvent());

  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages.some((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Chat"), false);
  assert.equal(requests[1].messages.some((message) => message.role === "assistant" && message.content === "final 1"), true);
  assert.equal(requests[1].messages.at(-2)?.toolCalls?.[0].function.name, "Chat");
  assert.equal(requests[1].messages.at(-2)?.reasoningContent, "fake reason");
  assert.equal(requests[1].messages.at(-1)?.content, "recent");
  assert.equal(appendContextCalls, 1);
});

test("chat agent clears session before the next request when cached input cost exceeds check chat miss cost", async () => {
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

  await runPreparedChatEvent(core, textEvent());
  assert.deepEqual(events, ["completed"]);
  assert.deepEqual(normalCheckCalls, [{ action: "poll" }]);
  assert.deepEqual(previewCalls, []);

  await runPreparedChatEvent(core, textEvent());
  assert.deepEqual(events, ["completed", "completed"]);
  assert.deepEqual(previewCalls, [
    { action: "poll", __preview: true, __scope: "today" },
    { action: "poll", __preview: true, __scope: "today" }
  ]);

  await runPreparedChatEvent(core, textEvent());

  assert.deepEqual(events, ["completed", "completed", "cleared:token_pressure", "completed"]);
  assert.deepEqual(previewCalls, [
    { action: "poll", __preview: true, __scope: "today" },
    { action: "poll", __preview: true, __scope: "today" },
    { action: "poll", __preview: true, __scope: "today" }
  ]);
  assert.equal(requests.length, 4);
  assert.equal(requests[3].messages.some((message) => message.content === "final 2"), false);
  assert.deepEqual(persistedSession?.tokenPressurePreviewBaselines?.["test-model|normal|today|"], {
    inputTokens: 8057,
    previewTokens: 60
  });
});

test("chat agent restores token pressure baseline from persisted session snapshot", async () => {
  const requests: LLMChatInput[] = [];
  const events: string[] = [];
  const previewCalls: Array<Record<string, unknown>> = [];
  let persistedSession: LLMSessionSnapshot | undefined;
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return {
        message: { role: "assistant", content: `final ${requests.length}` },
        model: "deepseek-v4-flash",
        usage: { inputTokens: 3001, totalTokens: 3001 }
      };
    }
  };
  const baseDeps = {
    config: loadConfig({ LLM_MODEL: "deepseek-v4-flash", LLM_TOKEN_PRESSURE_CONTEXT_IMPORTANCE: "1" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true },
      layers: [{ id: "one", title: "One", role: "system" as const, enabled: true, content: "system", order: 1 }]
    }),
    onLLMSessionUpdated(session: LLMSessionSnapshot & { staticPromptFingerprint: string; requestTimestamps: string[] }) {
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
    onLLMSessionCleared(reason: string) {
      events.push(`cleared:${reason}`);
      persistedSession = undefined;
    },
    tools: [{
      id: "messaging-test",
      listTools() {
        return [{ name: "Chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call: ToolCall) {
        if (call.input.__preview === true) previewCalls.push(call.input);
        return { callId: call.id, ok: true, output: "abcdef" };
      }
    }]
  };
  const firstCore = createChatAgent(baseDeps);

  await runPreparedChatEvent(firstCore, textEvent());
  assert.ok(persistedSession);
  persistedSession = {
    ...persistedSession,
    lastInputTokens: 3001,
    lastUsageModel: "deepseek-v4-flash",
    tokenPressurePreviewBaselines: { "deepseek-v4-flash|normal|today|": { inputTokens: 1, previewTokens: 1 } }
  };

  const restartedCore = createChatAgent(baseDeps);
  await runPreparedChatEvent(restartedCore, textEvent());

  assert.deepEqual(previewCalls, [{ action: "poll", __preview: true, __scope: "today" }]);
  assert.deepEqual(events, ["cleared:token_pressure"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.some((message) => message.content === "final 1"), false);
});

test("chat agent uses fixed prefix check chat preview scope for token pressure baseline", async () => {
  const requests: LLMChatInput[] = [];
  const previewCalls: Array<Record<string, unknown>> = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "draw",
            toolCalls: [{
              id: "tool_draw",
              type: "function",
              function: { name: "bookcase", arguments: "{\"action\":\"draw\"}" }
            }]
          },
          model: "deepseek-chat",
          usage: { inputTokens: 200, totalTokens: 200 }
        };
      }
      return {
        message: { role: "assistant", content: `final ${requests.length}` },
        model: "deepseek-chat",
        usage: { inputTokens: 200, totalTokens: 200 }
      };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "deepseek-chat", LLM_STREAM_ENABLED: "false" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true },
      layers: [{ id: "static", title: "Static", role: "system", enabled: true, content: "static prompt", order: 1 }],
      appendLayers: [{ id: "append_check", title: "Append check", role: "tool_request", enabled: true, content: "", toolCalls: [{ toolName: "Chat", toolArguments: "{\"action\":\"poll\"}" }], order: 1 }]
    }),
    tools: [{
      id: "test-tools",
      listTools() {
        return [
          { name: "bookcase", description: "bookcase", inputSchema: { type: "object" } },
          { name: "Chat", description: "view", inputSchema: { type: "object" } }
        ];
      },
      async execute(call) {
        if (call.toolName === "bookcase") {
          return {
            callId: call.id,
            ok: true,
            resetLLMSession: true,
            fixedPrefixKind: "bookcase",
            output: "<book>static story</book>"
          };
        }
        if (call.input.__preview === true) previewCalls.push(call.input);
        return { callId: call.id, ok: true, messageCursorId: 42, output: "abc" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  await runPreparedChatEvent(core, textEvent());
  await runPreparedChatEvent(core, textEvent());

  assert.deepEqual(previewCalls.at(0), { action: "poll", __preview: true, __scope: "from_prefix", __fromPrefixAfterMessageId: 42 });
});

test("chat agent token pressure comparison uses model-specific prices", async () => {
  async function run(model: string): Promise<string[]> {
    const events: string[] = [];
    let persistedSession: LLMSessionSnapshot | undefined;
    const llm: LLMClient = {
      async chat() {
        return {
          message: { role: "assistant", content: "final" },
          model,
          usage: { inputTokens: 3001, totalTokens: 3001 }
        };
      }
    };
    const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: model, LLM_TOKEN_PRESSURE_CONTEXT_IMPORTANCE: "1" }),
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
      initialLLMSession: undefined,
      loadLLMSession() {
        return persistedSession;
      },
      onLLMSessionUpdated(session) {
        persistedSession = {
          messages: session.messages.map((message) => ({ ...message, toolCalls: message.toolCalls?.map((call) => ({ ...call, function: { ...call.function } })) })),
          staticPromptFingerprint: session.staticPromptFingerprint,
          requestTimestamps: [...session.requestTimestamps],
          lastTotalTokens: 3001,
          lastInputTokens: 3001,
          lastUsageModel: model,
          tokenPressurePreviewBaselines: { [`${model}|normal|today|`]: { inputTokens: 1, previewTokens: 1 } }
        };
      },
      onLLMSessionCleared(reason) {
        events.push(reason);
        persistedSession = undefined;
      },
      tools: [{
        id: "messaging-test",
        listTools() {
          return [{ name: "Chat", description: "view", inputSchema: { type: "object" } }];
        },
        async execute(call) {
          return { callId: call.id, ok: true, output: "abcdef" };
        }
      }]
    });

    await runPreparedChatEvent(core, textEvent());
    await runPreparedChatEvent(core, textEvent());
    return events;
  }

  assert.deepEqual(await run("deepseek-v4-flash"), ["token_pressure"]);
  assert.deepEqual(await run("deepseek-v4-pro"), []);
});

test("chat agent clears only when static prompt fingerprint changes", async () => {
  const requests: LLMChatInput[] = [];
  const clears: string[] = [];
  let appendContent = "append one";
  let staticContent = "static one";
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "ok" } };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true },
      layers: [
        { id: "static", title: "Static", role: "system", enabled: true, content: staticContent, order: 1 }
      ],
      appendLayers: [
        { id: "append", title: "Append", role: "user", enabled: true, content: appendContent, order: 1 }
      ]
    }),
    onLLMSessionCleared(reason) {
      clears.push(reason);
    },
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
  appendContent = "append two";
  await runPreparedChatEvent(core, textEvent());
  staticContent = "static two";
  await runPreparedChatEvent(core, textEvent());

  assert.deepEqual(clears, ["prompt_static_changed"]);
  assert.equal(requests[1].messages.some((message) => message.content === "ok"), true);
  assert.equal(requests[1].messages.some((message) => message.content === "append two"), true);
  assert.equal(requests[2].messages.some((message) => message.content === "ok"), false);
});

test("chat agent rechecks static prompt before each LLM request", async () => {
  const requests: LLMChatInput[] = [];
  const clears: string[] = [];
  const sessionUpdates: LLMChatInput["messages"][] = [];
  let dailyShell = "shell one";
  let dailyShellRaw = {
    date: "2026-05-29",
    createdAt: "2026-05-29T12:00:00.000",
    personality: { id: "p1", name: "P One", content: "shell one" },
    relationship: { id: "r1", name: "R One", content: "relationship one" },
    outfit: { id: "o1", name: "O One", content: "outfit one" }
  };
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "tool_wardrobe",
              type: "function",
              function: {
                name: "wardrobe",
                arguments: "{\"action\":\"switch\",\"name\":\"O Two\"}"
              }
            }]
          }
        };
      }
      return { message: { role: "assistant", content: `ok ${requests.length}` } };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true, shell: true },
      layers: [
        { id: "static", title: "Static", role: "system", enabled: true, content: "{{dailyShell/persona/content}}", order: 1 }
      ]
    }),
    getDailyShell: () => dailyShell,
    getDailyShellRaw: () => dailyShellRaw,
    onLLMSessionCleared(reason) {
      clears.push(reason);
    },
    onLLMSessionUpdated(session) {
      sessionUpdates.push(session.messages);
    },
    tools: [{
      id: "shell",
      listTools() {
        return [{ name: "wardrobe", description: "wardrobe", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        dailyShell = "shell two";
        dailyShellRaw = {
          ...dailyShellRaw,
          personality: { ...dailyShellRaw.personality, content: "shell two" }
        };
        return { callId: call.id, ok: true, output: "switched" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());

  assert.deepEqual(clears, ["prompt_static_changed"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages.some((message) => message.content === "shell one"), true);
  assert.equal(requests[1].messages.some((message) => message.content === "shell two"), true);
  assert.equal(requests[1].messages.some((message) => message.content === "switched"), false);
  assert.equal(sessionUpdates.some((messages) => messages.some((message) => message.role === "tool" && message.content === "switched")), true);
  assert.equal(sessionUpdates.at(-1)?.some((message) => message.content === "switched"), false);
});

test("chat agent stops after three consecutive identical tool calls", async () => {
  const requests: LLMChatInput[] = [];
  const calls: string[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return {
        message: {
          role: "assistant",
          content: "still checking",
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
        return [{ name: "Chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        calls.push(call.id);
        return { callId: call.id, ok: true, output: "history" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  assert.equal(requests.length, 3);
  assert.deepEqual(calls.filter((id) => id !== "append_append_Chat"), ["tool_view_1", "tool_view_2", "tool_view_3"]);
});

test("chat agent falls back after max llm requests when tool calls alternate", async () => {
  const requests: LLMChatInput[] = [];
  const calls: string[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      const useSearch = requests.length % 2 === 0;
      return {
        message: {
          role: "assistant",
          content: "still looping",
          toolCalls: [{
            id: `tool_${requests.length}`,
            type: "function",
            function: {
              name: useSearch ? "Chat" : "Chat",
              arguments: useSearch ? "{\"content\":\"loop\"}" : "{}"
            }
          }]
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
          { name: "Chat", description: "search", inputSchema: { type: "object" } }
        ];
      },
      async execute(call) {
        calls.push(call.toolName);
        return { callId: call.id, ok: true, output: "ok" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  assert.equal(requests.length, 10);
  assert.equal(calls.length, 10);
});

test("chat agent stops after three consecutive identical Chat calls", async () => {
  const requests: LLMChatInput[] = [];
  const sent: string[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return {
        message: {
          role: "assistant",
          content: "still sending",
          toolCalls: [{
            id: `tool_send_${requests.length}`,
            type: "function",
            function: {
              name: "Chat",
              arguments: "{\"action\":\"send\",\"type\":\"message\",\"content\":\"same\"}"
            }
          }]
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
        return [{ name: "Chat", description: "send", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        sent.push(`${call.id}:${String(call.input.content)}`);
        return { callId: call.id, ok: true, output: "sent" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  assert.equal(requests.length, 3);
  assert.deepEqual(sent, [
    "tool_send_1:same",
    "tool_send_2:same",
    "tool_send_3:same"
  ]);
});

test("chat agent stops after the generic total tool call limit", async () => {
  const requests: LLMChatInput[] = [];
  const sent: string[] = [];
  let nowMs = Date.parse("2026-05-26T00:00:00.000Z");
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      nowMs += 61_000;
      const content = requests.length % 2 === 0 ? "even" : "odd";
      return {
        message: {
          role: "assistant",
          content: "still sending",
          toolCalls: [{
            id: `tool_send_${requests.length}`,
            type: "function",
            function: {
              name: "Chat",
              arguments: `{"action":"send","type":"message","content":"${content}"}`
            }
          }]
        }
      };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    time: createCurrentTimeProvider("UTC", () => new Date(nowMs)),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [{
      id: "messaging-test",
      listTools() {
        return [{ name: "Chat", description: "send", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        sent.push(`${call.id}:${String(call.input.content)}`);
        return { callId: call.id, ok: true, output: "sent" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  assert.equal(requests.length, 20);
  assert.equal(sent.length, 20);
  assert.deepEqual(sent.slice(0, 5), [
    "tool_send_1:odd",
    "tool_send_2:even",
    "tool_send_3:odd",
    "tool_send_4:even",
    "tool_send_5:odd"
  ]);
  assert.equal(sent.at(-1), "tool_send_20:even");
});

test("chat agent executes all exposed tools when Chat appears in the same round", async () => {
  const calls: string[] = [];
  const llm: LLMClient = {
    async chat(input) {
      if (input.messages.some((message) => message.role === "tool" && message.toolCallId === "tool_send")) {
        return { message: { role: "assistant", content: "done" } };
      }
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tool_view",
              type: "function",
              function: {
                name: "Chat",
                arguments: "{\"action\":\"poll\"}"
              }
            },
            {
              id: "tool_send",
              type: "function",
              function: {
                name: "Chat",
                arguments: "{\"action\":\"send\",\"type\":\"message\",\"content\":\"done\"}"
              }
            }
          ]
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
        calls.push(call.toolName);
        return { callId: call.id, ok: true, output: "ok" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  assert.deepEqual(calls, ["Chat", "Chat"]);
});

test("chat agent does not stream Chat when non-message type is explicit", async () => {
  const sentLines: string[] = [];
  const llm: LLMClient = {
    async chat(input) {
      return this.chatStream ? this.chatStream(input) : { message: { role: "assistant", content: "fallback" } };
    },
    async chatStream(input, handlers) {
      if (input.messages.some((message) => message.role === "tool")) {
        return { message: { role: "assistant", content: "done" } };
      }
      await handlers?.onToolCallDelta?.({
        index: 0,
        id: "tool_send",
        type: "function",
        function: {
          name: "Chat",
          arguments: "{\"action\":\"send\",\"type\":\"markdown\",\"content\":\"should not send\\n"
        }
      });
      assert.deepEqual(sentLines, []);
      await handlers?.onToolCallDelta?.({
        index: 0,
        function: {
          arguments: "\"}"
        }
      });
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "tool_send",
            type: "function",
            function: {
              name: "Chat",
              arguments: "{\"action\":\"send\",\"type\":\"markdown\",\"content\":\"should not send\\n\"}"
            }
          }]
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
        return [{
          name: "Chat",
          description: "send",
          inputSchema: { type: "object" }
        }];
      },
      async execute(call) {
        sentLines.push(`${call.input.type ?? "message"}:${call.input.content}`);
        return { callId: call.id, ok: true, output: `sent: ${call.input.content}` };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  assert.deepEqual(sentLines, ["markdown:should not send\n"]);
});

function textEvent(): AgentEvent {
  return {
    id: "evt_1",
    source: {
      plugin: "feishu",
      channelId: "chat-1",
      userId: "user-1",
      rawMessageId: "om_1"
    },
    externalSession: {
      scope: "dm",
      sessionId: "session-1"
    },
    type: "message.text",
    payload: { kind: "text", text: "what happened today?" },
    meta: {
      receivedAt: "2026-05-26T00:00:00.000Z",
      replyTo: "om_1"
    }
  };
}

function chatTestTools(onCall?: (call: ToolCall) => void) {
  return {
    id: "messaging",
    listTools() {
      return [
        { name: "Chat", description: "view", inputSchema: { type: "object" } },
        { name: "finish_and_wait", description: "wait", inputSchema: { type: "object" } },
        { name: "later_tool", description: "later", inputSchema: { type: "object" } }
      ];
    },
    async execute(call: ToolCall) {
      onCall?.(call);
      if (call.toolName === "finish_and_wait") {
        return {
          callId: call.id,
          ok: true,
          meta: { yieldReturn: true }
        };
      }
      if (call.toolName === "Chat") {
        return {
          callId: call.id,
          ok: true,
          messageCursorId: 7,
          output: "<chat-log>\nnew chat\n</chat-log>\n<now local=\"2026-05-26T00:05:00.000\"/>"
        };
      }
      if (call.toolName === "later_tool") {
        return { callId: call.id, ok: true, output: "later" };
      }
      return { callId: call.id, ok: false, error: `unknown tool ${call.toolName}` };
    }
  };
}

function memoryStore(initial?: string): AgentStateStore & { content?: string } {
  return {
    content: initial,
    read() {
      return this.content;
    },
    write(content) {
      this.content = content;
    }
  };
}

function messageContentText(content: LLMChatInput["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text" ? part.text : "[image]").join("\n");
}
