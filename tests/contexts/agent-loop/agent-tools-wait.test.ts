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

test("chat agent resumes pending finish_and_wait with Chat result on new message", async () => {
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
              function: { name: "Yield", arguments: "{\"action\":\"schedule\",\"timer\":10}" }
            }]
          },
          finishReason: "tool_calls"
        };
      }
      return { message: { role: "assistant", content: "" } };
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
  nowMs = Date.parse("2026-05-26T00:04:00.000Z");
  await runPreparedChatEvent(core, { ...textEvent(), id: "evt_heartbeat", type: "system.heartbeat" });
  assert.equal(requests.length, 1);
  nowMs = Date.parse("2026-05-26T00:05:00.000Z");
  await runPreparedChatEvent(core, { ...textEvent(), id: "evt_2" });

  assert.equal(requests.length, 2);
  assert.deepEqual(checkInputs, [{ action: "poll" }]);
  const secondMessages = requests[1].messages;
  const waitToolMessages = secondMessages.filter((message) => message.role === "tool" && message.name === "Yield");
  assert.equal(waitToolMessages.length, 1);
  assert.equal(waitToolMessages.at(-1)?.content, "<chat-log>\nnew chat\n</chat-log>\n<wait-duration>5m</wait-duration>\n<now local=\"2026-05-26T00:05:00.000\"/>");
  const waitIndex = secondMessages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Yield");
  const checkChatAfterWait = secondMessages.slice(waitIndex + 1).find((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Chat");
  assert.equal(checkChatAfterWait, undefined);
  assert.equal(sessionUpdates.at(-1)?.waitChatStartedAt, undefined);
});

test("chat agent resumes wait once after its deadline", async () => {
  const requests: LLMChatInput[] = [];
  const sessionUpdates: LLMSessionSnapshot[] = [];
  let persistedSession: LLMSessionSnapshot | undefined;
  let nowMs = Date.parse("2026-05-26T00:00:00.000Z");
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
                function: { name: "Yield", arguments: "{\"action\":\"schedule\",\"timer\":10}" }
              }]
            }
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
      sessionUpdates.push(session);
    },
    loadLLMSession() {
      return persistedSession;
    }
  });

  await runPreparedChatEvent(core, textEvent());
  assert.equal(sessionUpdates.at(-1)?.waitChatMode, "schedule");
  assert.equal(sessionUpdates.at(-1)?.waitChatUntil, "2026-05-26T00:00:10.000Z");
  assert.equal(sessionUpdates.at(-1)?.waitChatTarget?.externalSession.sessionId, "session-1");

  nowMs += 9_000;
  await runPreparedChatEvent(core, timedYieldEvent());
  assert.equal(requests.length, 1);

  nowMs += 1_000;
  await runPreparedChatEvent(core, timedYieldEvent());
  assert.equal(requests.length, 2);
  assert.match(String(requests[1].messages.find((message) => message.name === "Yield")?.content), /<wait-duration>10s<\/wait-duration>/);
  assert.equal(sessionUpdates.at(-1)?.waitChatUntil, undefined);
  assert.equal(sessionUpdates.at(-1)?.waitChatTarget, undefined);
});

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

test("chat agent ends session when await_chat times out without new messages", async () => {
  const requests: LLMChatInput[] = [];
  const sessionUpdates: LLMSessionSnapshot[] = [];
  const clearReasons: string[] = [];
  let persistedSession: LLMSessionSnapshot | undefined;
  let nowMs = Date.parse("2026-05-26T00:00:00.000Z");
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
      sessionUpdates.push(session);
    },
    onLLMSessionCleared(reason) {
      clearReasons.push(reason);
    },
    loadLLMSession() {
      return persistedSession;
    }
  });

  await runPreparedChatEvent(core, textEvent());
  assert.equal(sessionUpdates.at(-1)?.waitChatMode, "await_chat");
  assert.equal(sessionUpdates.at(-1)?.waitChatUntil, "2026-05-26T00:15:00.000Z");

  nowMs = Date.parse("2026-05-26T00:15:01.000Z");
  await runPreparedChatEvent(core, timedYieldEvent());
  assert.equal(requests.length, 1);
  assert.deepEqual(clearReasons, ["yield_end"]);
});

test("chat agent resumes await_chat on new message before deadline", async () => {
  const requests: LLMChatInput[] = [];
  const sessionUpdates: LLMSessionSnapshot[] = [];
  let persistedSession: LLMSessionSnapshot | undefined;
  let nowMs = Date.parse("2026-05-26T00:00:00.000Z");
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    time: createCurrentTimeProvider("UTC", () => new Date(nowMs)),
    llm: {
      async chat(input) {
        requests.push(input);
        if (requests.length > 1) return { message: { role: "assistant", content: "" } };
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
      sessionUpdates.push(session);
    },
    loadLLMSession() {
      return persistedSession;
    }
  });

  await runPreparedChatEvent(core, textEvent());
  nowMs = Date.parse("2026-05-26T00:10:00.000Z");
  await runPreparedChatEvent(core, { ...textEvent(), id: "evt_resume" });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.some((message) => message.role === "tool" && message.toolCallId === "tool_wait"), true);
  assert.equal(sessionUpdates.at(-1)?.waitChatUntil, undefined);
});

test("chat agent executes same-round tools when finish_and_wait appears", async () => {
  const requests: LLMChatInput[] = [];
  const calls: string[] = [];
  const sessionUpdates: LLMSessionSnapshot[] = [];
  let persistedSession: LLMSessionSnapshot | undefined;
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length > 1) return { message: { role: "assistant", content: "" } };
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
              function: { name: "Yield", arguments: "{\"action\":\"schedule\",\"timer\":10}" }
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

  assert.deepEqual(calls, ["Chat", "Yield", "later_tool"]);
  const latestMessages = sessionUpdates.at(-1)?.messages ?? [];
  const assistant = latestMessages.find((message) => message.role === "assistant" && message.toolCalls?.some((call) => call.function.name === "Yield"));
  assert.deepEqual(assistant?.toolCalls?.map((call) => call.function.name), ["Chat", "Yield", "later_tool"]);
  assert.equal(latestMessages.some((message) => message.role === "tool" && message.toolCallId === "tool_wait"), false);
  assert.equal(latestMessages.some((message) => message.role === "tool" && message.toolCallId === "tool_check"), true);
  assert.equal(latestMessages.some((message) => message.role === "tool" && message.toolCallId === "tool_later"), true);
});

test("chat agent resumes same-round finish_and_wait result on new message", async () => {
  const requests: LLMChatInput[] = [];
  let persistedSession: LLMSessionSnapshot | undefined;
  let nowMs = Date.parse("2026-05-26T00:00:00.000Z");
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length > 1) return { message: { role: "assistant", content: "" } };
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
              function: { name: "Yield", arguments: "{\"action\":\"schedule\",\"timer\":10}" }
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
    tools: [chatTestTools()],
    onLLMSessionUpdated(session) {
      persistedSession = session;
    },
    loadLLMSession() {
      return persistedSession;
    }
  });

  await runPreparedChatEvent(core, textEvent());

  nowMs = Date.parse("2026-05-26T00:05:00.000Z");
  await runPreparedChatEvent(core, { ...textEvent(), id: "evt_resume" });

  const resumedMessages = requests[1].messages;
  assert.equal(resumedMessages.some((message) => message.role === "tool" && message.toolCallId === "tool_wait"), true);
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
            content: "",
            toolCalls: [{
              id: "tool_draw",
              type: "function",
              function: {
                name: "Bookcase",
                arguments: "{\"action\":\"draw\"}"
              }
            }]
          },
          finishReason: "tool_calls"
        };
      }
      return { message: { role: "assistant", content: "" } };
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
          { name: "Bookcase", description: "bookcase", inputSchema: { type: "object" } },
          { name: "Chat", description: "view", inputSchema: { type: "object" } }
        ];
      },
      async execute(call) {
        if (call.toolName === "Bookcase") {
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
  assert.equal(secondMessages.length > 0, true);
  const bookcaseIndex = secondMessages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Bookcase");
  const checkChatIndex = secondMessages.map((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Chat").lastIndexOf(true);
  assert.ok(bookcaseIndex >= 0);
  assert.equal(checkChatIndex, -1);
  assert.equal(secondMessages[bookcaseIndex + 1]?.content, "<book>static story</book>");
  assert.equal(checkChatInputs.length, 0);
  assert.equal(checkChatCallsInSession, 0);
  assert.deepEqual([...new Set(sessionUpdates.map((update) => update.id))], [1, 2]);
  assert.equal(sessionUpdates.at(-1)?.id, 2);
  assert.equal(sessionUpdates.at(-1)?.mode, "fixed_prefix");

  await runPreparedChatEvent(core, textEvent());

  assert.equal(requests.length, 3);
  const thirdMessages = requests[2].messages;
  const thirdCheckChatIndex = thirdMessages.map((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Chat").lastIndexOf(true);
  assert.ok(thirdCheckChatIndex > bookcaseIndex);
  assert.equal(thirdMessages[thirdCheckChatIndex]?.toolCalls?.[0]?.function.arguments, "{\"action\":\"poll\"}");
  assert.equal(thirdMessages[thirdCheckChatIndex + 1]?.content, "recent chat");
  assert.equal(checkChatInputs.length, 1);

  await runPreparedChatEvent(core, textEvent());

  assert.equal(requests.length, 4);
  const fourthMessages = requests[3].messages;
  const fourthCheckChatIndex = fourthMessages.map((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Chat").lastIndexOf(true);
  assert.equal(fourthMessages[fourthCheckChatIndex]?.toolCalls?.[0]?.function.arguments, "{\"action\":\"poll\"}");
  assert.equal(fourthMessages[fourthCheckChatIndex + 1]?.content, "fresh chat after fixed prefix");
  assert.equal(checkChatInputs.length, 2);
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
        function: { name: "Bookcase", arguments: "{\"action\":\"draw\"}" }
      }]
    },
    { role: "tool", name: "Bookcase", toolCallId: "tool_draw", content: "<book>fixed story</book>" }
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
      fixedPrefixStartedAt: "2026-05-30T00:00:00.000"
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

  assert.equal(requests.length, 1);
  const messages = requests[0].messages;
  assert.equal(messages.length > 0, true);
  assert.equal(messages.filter((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Bookcase").length, 1);
  assert.equal(messages.filter((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Chat").length, 0);
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
          if (requests.length > 1) return { message: { role: "assistant", content: "" } };
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
        fixedPrefixStartedAt: "2026-05-30T00:00:00.000"
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
    const clearIndex = latest?.messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.id === scenario.clearCallId) ?? -1;
    assert.ok(clearIndex >= 0);
    assert.equal(latest?.messages[clearIndex + 1]?.role, "tool");
    assert.equal(latest?.messages[clearIndex + 1]?.toolCallId, scenario.clearCallId);
  });
}
