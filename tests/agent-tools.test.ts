import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentCore, type LLMSessionSnapshot } from "../core/agent/src/index.js";
import type { LLMChatInput, LLMClient } from "../core/llm/src/index.js";
import type { AgentEvent, ToolCall } from "../packages/types/src/index.js";
import { loadConfig } from "../packages/config/src/index.js";
import { createOutputRouter } from "../core/output-router/src/index.js";
import { createAllowAllPolicy } from "../core/policy/src/index.js";
import { createIntentRouter } from "../core/router/src/index.js";
import { createSessionResolver } from "../core/session/src/index.js";
import { createCurrentTimeProvider } from "../core/time/src/index.js";

test("agent core exposes platform-neutral tools and resolves tool calls before final reply", async () => {
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
                name: "check_chat",
                arguments: "{}"
              }
            }]
          }
        };
      }
      return { message: { role: "assistant", content: "final answer" } };
    }
  };
  const core = createAgentCore({
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
          name: "check_chat",
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

  const outputs = await core.handleEvent(textEvent());
  assert.deepEqual(outputs, []);
  assert.equal(requests[0].tools?.[0].function.name, "check_chat");
  assert.equal(toolCalls[0].toolName, "check_chat");
  assert.equal(toolCalls[0].session?.sessionId, "session-1");
  assert.equal(requests[1].messages.at(-1)?.role, "tool");
  assert.equal(requests[1].messages.at(-1)?.content, "history");
});

test("agent core appends assistant tool call and tool result before the next llm request", async () => {
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
                name: "check_chat",
                arguments: "{}"
              }
            }]
          },
          finishReason: "tool_calls"
        };
      }
      return { message: { role: "assistant", content: "done" } };
    }
  };
  const core = createAgentCore({
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
          name: "check_chat",
          description: "view",
          inputSchema: { type: "object" }
        }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "history result" };
      }
    }]
  });

  await core.handleEvent(textEvent());

  assert.equal(requests.length, 2);
  const toolCallIndex = requests[1].messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.id === "tool_1");
  assert.ok(toolCallIndex >= 0);
  assert.equal(requests[1].messages[toolCallIndex]?.content, "checking history");
  assert.equal(requests[1].messages[toolCallIndex]?.reasoningContent, "I should inspect messages first.");
  assert.equal(requests[1].messages[toolCallIndex]?.toolCalls?.[0].function.name, "check_chat");
  assert.equal(requests[1].messages[toolCallIndex + 1]?.role, "tool");
  assert.equal(requests[1].messages[toolCallIndex + 1]?.toolCallId, "tool_1");
  assert.equal(requests[1].messages[toolCallIndex + 1]?.content, "history result");
});

test("agent core stops before another llm request when a tool invalidates the session", async () => {
  const requests: LLMChatInput[] = [];
  const sessionUpdates: LLMChatInput["messages"][] = [];
  const clearedReasons: string[] = [];
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
  const core = createAgentCore({
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
    onLLMSessionUpdated(session) {
      sessionUpdates.push(session.messages);
    },
    onLLMSessionCleared(reason) {
      clearedReasons.push(reason);
    }
  });

  await core.handleEvent(textEvent());

  assert.equal(requests.length, 1);
  assert.equal(clearedReasons.at(-1), "prompt_static_changed");
  const latestMessages = sessionUpdates.at(-1) ?? [];
  assert.equal(latestMessages.at(-2)?.role, "assistant");
  assert.equal(latestMessages.at(-2)?.toolCalls?.[0].function.name, "bookcase");
  assert.equal(latestMessages.at(-1)?.role, "tool");
  assert.equal(latestMessages.at(-1)?.content, "{\"action\":\"return\"}");
});

test("agent core rebuilds fixed prefix session immediately after bookcase draw", async () => {
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
  const core = createAgentCore({
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
      appendLayers: [{ id: "append_check", title: "Append check", role: "tool_request", enabled: true, content: "", thinking: "check", toolName: "check_chat", toolArguments: "{}", order: 1 }]
    }),
    tools: [{
      id: "test-tools",
      listTools() {
        return [
          { name: "bookcase", description: "bookcase", inputSchema: { type: "object" } },
          { name: "check_chat", description: "view", inputSchema: { type: "object" } }
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
        if (call.toolName === "check_chat") checkChatInputs.push(call.input);
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

  await core.handleEvent(textEvent());

  assert.equal(requests.length, 2);
  const secondMessages = requests[1].messages;
  assert.equal(secondMessages.some((message) => message.content === "old context marker"), true);
  const bookcaseIndex = secondMessages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "bookcase");
  const checkChatIndex = secondMessages.map((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "check_chat").lastIndexOf(true);
  assert.ok(bookcaseIndex >= 0);
  assert.ok(checkChatIndex > bookcaseIndex);
  assert.equal(secondMessages[bookcaseIndex + 1]?.content, "<book>static story</book>");
  assert.equal(secondMessages[checkChatIndex]?.toolCalls?.[0]?.function.arguments, "{\"scope\":\"from_prefix\"}");
  assert.equal(secondMessages[checkChatIndex + 1]?.content, "recent chat");
  assert.equal(checkChatInputs.at(-1)?.__fromPrefixAfterMessageId, 42);
  assert.equal(checkChatCallsInSession, 1);
  assert.deepEqual([...new Set(sessionUpdates.map((update) => update.id))], [1, 2]);
  assert.equal(sessionUpdates.at(-1)?.id, 2);
  assert.equal(sessionUpdates.at(-1)?.mode, "fixed_prefix");

  await core.handleEvent(textEvent());

  assert.equal(requests.length, 3);
  const thirdMessages = requests[2].messages;
  const thirdCheckChatIndex = thirdMessages.map((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "check_chat").lastIndexOf(true);
  assert.ok(thirdCheckChatIndex > bookcaseIndex);
  assert.equal(thirdMessages[thirdCheckChatIndex]?.toolCalls?.[0]?.function.arguments, "{\"scope\":\"from_prefix\"}");
  assert.equal(thirdMessages[thirdCheckChatIndex + 1]?.content, "fresh chat after fixed prefix");
  const fromPrefixInputs = checkChatInputs.filter((input) => input.scope === "from_prefix");
  assert.equal(fromPrefixInputs.length, 2);
  assert.deepEqual(fromPrefixInputs.map((input) => input.__fromPrefixAfterMessageId), [42, 42]);
});

test("agent core appends sleep cocoon goodnight instruction from heartbeat event", async () => {
  const requests: LLMChatInput[] = [];
  const sessionUpdates: Array<{ mode?: string; messages: LLMChatInput["messages"] }> = [];
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
      raw: { sleepCocoonGoodnight: true }
    }
  };
  const core = createAgentCore({
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
        return { callId: call.id, ok: true, output: "ok" };
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
      sessionUpdates.push({ mode: session.mode, messages: session.messages });
    }
  });

  await core.handleEvent(event);

  assert.equal(requests.length, 1);
  assert.equal(sessionUpdates.at(-1)?.mode, "normal");
  assert.equal(requests[0].messages.some((message) => message.role === "user" && message.content.includes("对YY说晚安")), true);
  assert.equal(requests[0].messages.some((message) => message.content.includes("sleep_cocoon")), true);
});

test("agent core appends sleep cocoon morning instruction from heartbeat event", async () => {
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
      raw: { sleepCocoonMorning: true }
    }
  };
  const core = createAgentCore({
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

  await core.handleEvent(event);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages.some((message) => message.role === "user" && message.content.includes("早安")), true);
  assert.equal(requests[0].messages.some((message) => message.content.includes("sleep_cocoon")), false);
});

test("agent core keeps fixed prefix static messages when token pressure rebuilds the session", async () => {
  let capturedSession: LLMSessionSnapshot | undefined;
  const promptProfile = {
    userName: "user",
    visibleTools: { feishu: true },
    layers: [{ id: "static", title: "Static", role: "system" as const, enabled: true, content: "static prompt", order: 1 }],
    appendLayers: [{ id: "append_check", title: "Append check", role: "tool_request" as const, enabled: true, content: "", thinking: "check", toolName: "check_chat", toolArguments: "{}", order: 1 }]
  };
  const primerCore = createAgentCore({
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
        return [{ name: "check_chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "recent" };
      }
    }],
    onLLMSessionUpdated(session) {
      capturedSession = session;
    }
  });
  await primerCore.handleEvent(textEvent());
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
  const core = createAgentCore({
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
        return [{ name: "check_chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "recent" };
      }
    }],
    onLLMSessionCleared(reason) {
      clearedReasons.push(reason);
    }
  });

  await core.handleEvent(textEvent());

  assert.deepEqual(clearedReasons, []);
  assert.equal(requests.length, 1);
  const messages = requests[0].messages;
  assert.equal(messages.some((message) => message.content === "old session marker"), false);
  const bookcaseIndex = messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "bookcase");
  const checkChatIndex = messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "check_chat");
  assert.ok(bookcaseIndex >= 0);
  assert.ok(checkChatIndex > bookcaseIndex);
  assert.equal(messages[bookcaseIndex + 1]?.content, "<book>persistent story</book>");
  assert.equal(messages[checkChatIndex + 1]?.content, "recent");
});

test("agent core restores fixed prefix static messages from an initial session snapshot", async () => {
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
  const core = createAgentCore({
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
      appendLayers: [{ id: "append_check", title: "Append check", role: "tool_request", enabled: true, content: "", thinking: "check", toolName: "check_chat", toolArguments: "{}", order: 1 }]
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
        return [{ name: "check_chat", description: "view", inputSchema: { type: "object" } }];
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

  await core.handleEvent(textEvent());

  assert.deepEqual(clearedReasons, []);
  assert.equal(requests.length, 1);
  const messages = requests[0].messages;
  assert.equal(messages.some((message) => message.content === "old live context"), false);
  assert.equal(messages.some((message) => message.content === "old static prompt"), false);
  const bookcaseIndex = messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "bookcase");
  const checkChatIndex = messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "check_chat");
  assert.ok(bookcaseIndex >= 0);
  assert.ok(checkChatIndex > bookcaseIndex);
  assert.equal(messages[bookcaseIndex + 1]?.content, "<book>restored story</book>");
  assert.equal(messages[checkChatIndex + 1]?.content, "fresh chat after restore");
  assert.equal(sessionUpdates.at(-1)?.mode, "fixed_prefix");
  assert.equal(sessionUpdates.at(-1)?.modeStartedAt, modeStartedAt);
  assert.equal(sessionUpdates.at(-1)?.fixedPrefixKind, "bookcase");
});

test("agent core exits expired fixed prefix mode on the next request", async () => {
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
  const core = createAgentCore({
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
      appendLayers: [{ id: "append_check", title: "Append check", role: "tool_request", enabled: true, content: "", thinking: "check", toolName: "check_chat", toolArguments: "{}", order: 1 }]
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
        return [{ name: "check_chat", description: "view", inputSchema: { type: "object" } }];
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

  await core.handleEvent(textEvent());

  assert.deepEqual(clearedReasons, ["mode_timeout"]);
  assert.equal(requests.length, 1);
  const messages = requests[0].messages;
  assert.equal(messages.some((message) => message.content === "old live context"), false);
  assert.equal(messages.some((message) => message.content === "<book>expired story</book>"), false);
  assert.equal(messages.some((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "bookcase"), false);
  assert.equal(messages.at(-1)?.content, "fresh normal chat");
  assert.equal(sessionUpdates.at(-1)?.mode, "normal");
  assert.equal(sessionUpdates.at(-1)?.modeStartedAt, undefined);
});

test("agent core rejects two consecutive selfie tool calls", async () => {
  const requests: LLMChatInput[] = [];
  const executed: string[] = [];
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
                function: { name: "selfie", arguments: "{\"action\":\"first\"}" }
              },
              {
                id: "tool_selfie_2",
                type: "function",
                function: { name: "selfie", arguments: "{\"action\":\"second\"}" }
              }
            ]
          }
        };
      }
      return { message: { role: "assistant", content: "done" } };
    }
  };
  const core = createAgentCore({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [{
      id: "media",
      listTools() {
        return [{ name: "selfie", description: "selfie", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        executed.push(String(call.input.action));
        return { callId: call.id, ok: true, output: "sent" };
      }
    }]
  });

  await core.handleEvent(textEvent());

  assert.deepEqual(executed, ["first"]);
  assert.equal(requests[1].messages.at(-2)?.content, "sent");
  assert.equal(requests[1].messages.at(-1)?.content, "error: selfie cannot be called twice in a row");
});

test("agent core adds fallback reasoning content for tool requests when missing", async () => {
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
                name: "check_chat",
                arguments: "{}"
              }
            }]
          }
        };
      }
      return { message: { role: "assistant", content: "done" } };
    }
  };
  const core = createAgentCore({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [{
      id: "test-tools",
      listTools() {
        return [{ name: "check_chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "history result" };
      }
    }]
  });

  await core.handleEvent(textEvent());

  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-2)?.reasoningContent, "Need to call the requested tool.");
});

test("agent core filters messaging tools when feishu visibility is disabled", async () => {
  const requests: LLMChatInput[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "ok" } };
    }
  };
  const core = createAgentCore({
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
          name: "check_chat",
          description: "view",
          inputSchema: { type: "object" }
        }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "history" };
      }
    }]
  });

  await core.handleEvent(textEvent());
  assert.deepEqual(requests[0].tools, []);
});

test("agent core filters media tools when media visibility is disabled", async () => {
  const requests: LLMChatInput[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "ok" } };
    }
  };
  const core = createAgentCore({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true, media: false },
      layers: [{ id: "one", title: "One", role: "system", enabled: true, content: "system", order: 1 }]
    }),
    tools: [{
      id: "messaging",
      listTools() {
        return [{ name: "check_chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "history" };
      }
    }, {
      id: "media",
      listTools() {
        return [{ name: "selfie", description: "selfie", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "sent" };
      }
    }]
  });

  await core.handleEvent(textEvent());
  assert.deepEqual(requests[0].tools?.map((tool) => tool.function.name), ["check_chat"]);
});

test("agent core skips llm calls when prompt profile has no enabled messages", async () => {
  const requests: LLMChatInput[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "ok" } };
    }
  };
  const core = createAgentCore({
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

  const outputs = await core.handleEvent(textEvent());
  assert.deepEqual(outputs, []);
  assert.equal(requests.length, 0);
});

test("agent core renders prompt profile layers before user message", async () => {
  const requests: LLMChatInput[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "ok" } };
    }
  };
  const core = createAgentCore({
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
        { id: "usr", title: "Usr", role: "user", enabled: true, content: "session {{session}}", order: 2 }
      ]
    })
  });

  await core.handleEvent(textEvent());
  assert.equal(requests[0].messages[0].role, "system");
  assert.equal(requests[0].messages[0].content, "hello 小王");
  assert.equal(requests[0].messages[1].role, "user");
  assert.equal(requests[0].messages[1].content, "session session-1");
  assert.equal(requests[0].messages.length, 2);
});

test("agent core runs prompt tool request layers and appends actual tool result", async () => {
  const requests: LLMChatInput[] = [];
  const toolCalls: ToolCall[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "ok" } };
    }
  };
  const core = createAgentCore({
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
        toolName: "check_chat",
        toolCallId: "call_prompt_history",
        toolArguments: "{}",
        order: 1
      }]
    }),
    tools: [{
      id: "messaging",
      listTools() {
        return [{
          name: "check_chat",
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

  await core.handleEvent(textEvent());

  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].id, "call_prompt_history");
  assert.equal(toolCalls[0].toolName, "check_chat");
  assert.deepEqual(toolCalls[0].input, {});
  assert.equal(requests[0].messages[0].role, "assistant");
  assert.equal(requests[0].messages[0].toolCalls?.[0].id, "call_prompt_history");
  assert.equal(requests[0].messages[1].role, "tool");
  assert.equal(requests[0].messages[1].content, "actual history");
});

test("agent core streams send_chat message content on newlines before final tool JSON", async () => {
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
            name: "send_chat",
            arguments: "{\"type\":\"message\",\"content\":\"one\\n"
          }
        });
        assert.deepEqual(sentLines, ["one"]);
        await handlers?.onToolCallDelta?.({
          index: 0,
          function: {
            arguments: "two\\nthree\"}"
          }
        });
        assert.deepEqual(sentLines, ["one"]);
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "tool_send",
              type: "function",
              function: {
                name: "send_chat",
                arguments: "{\"type\":\"message\",\"content\":\"one\\ntwo\\nthree\"}"
              }
            }]
          }
        };
      }
      return { message: { role: "assistant", content: "done" } };
    }
  };
  const core = createAgentCore({
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
          name: "send_chat",
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

  const outputs = await core.handleEvent(textEvent());
  assert.deepEqual(outputs, []);
  assert.deepEqual(sentLines, ["one", "two", "three"]);
  assert.equal(requests.length, 2);
  assert.deepEqual(completed, [{ sentMessage: true }]);
});

test("agent core streams send_chat voice content on newlines before final tool JSON", async () => {
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
          name: "send_chat",
          arguments: "{\"type\":\"voice\",\"content\":\"第一句\\\\n"
        }
      });
      assert.deepEqual(sentLines, ["voice:第一句"]);
      await handlers?.onToolCallDelta?.({
        index: 0,
        function: {
          arguments: "第二句\\\\n第三句\"}"
        }
      });
      assert.deepEqual(sentLines, ["voice:第一句"]);
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "tool_send",
            type: "function",
            function: {
              name: "send_chat",
              arguments: "{\"type\":\"voice\",\"content\":\"第一句\\\\n第二句\\\\n第三句\"}"
            }
          }]
        }
      };
    }
  };
  const core = createAgentCore({
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
          name: "send_chat",
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

  await core.handleEvent(textEvent());
  assert.deepEqual(sentLines, ["voice:第一句", "voice:第二句", "voice:第三句"]);
});

test("agent core waits for final send_chat JSON when type is omitted", async () => {
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
          name: "send_chat",
          arguments: "{\"content\":\"one\\n"
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
              name: "send_chat",
              arguments: "{\"content\":\"one\\ntwo\"}"
            }
          }]
        }
      };
    }
  };
  const core = createAgentCore({
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
          name: "send_chat",
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

  await core.handleEvent(textEvent());
  assert.deepEqual(sentLines, ["one", "two"]);
});

test("agent core keeps streamed send_chat lines when tool metadata arrives after arguments", async () => {
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
          arguments: "{\"content\":\"对、对不起……主人不是在凶您。\\n只是上次您熬到凌晨五点，\\n主人有点担心……\",\"type\":\"message\"}"
        }
      });
      assert.deepEqual(sentLines, []);
      await handlers?.onToolCallDelta?.({
        index: 0,
        id: "tool_send",
        type: "function",
        function: {
          name: "send_chat"
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
              name: "send_chat",
              arguments: "{\"content\":\"对、对不起……主人不是在凶您。\\n只是上次您熬到凌晨五点，\\n主人有点担心……\",\"type\":\"message\"}"
            }
          }]
        }
      };
    }
  };
  const core = createAgentCore({
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
          name: "send_chat",
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

  await core.handleEvent(textEvent());
  assert.deepEqual(sentLines, [
    "对、对不起……主人不是在凶您。",
    "只是上次您熬到凌晨五点，",
    "主人有点担心……"
  ]);
});

test("agent core does not stream send_chat before type is known", async () => {
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
          name: "send_chat",
          arguments: "{\"content\":\"should not stream\\n"
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
              name: "send_chat",
              arguments: "{\"content\":\"should not stream\\n\",\"type\":\"markdown\"}"
            }
          }]
        }
      };
    }
  };
  const core = createAgentCore({
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
          name: "send_chat",
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

  await core.handleEvent(textEvent());
  assert.deepEqual(sentLines, ["markdown:should not stream\n"]);
});

test("agent core merges streamed send_chat chat outputs into one tool message", async () => {
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
          name: "send_chat",
          arguments: "{\"content\":\"one\\n"
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
              name: "send_chat",
              arguments: "{\"content\":\"one\\ntwo\"}"
            }
          }]
        }
      };
    }
  };
  const core = createAgentCore({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [{
      id: "messaging-test",
      listTools() {
        return [{ name: "send_chat", description: "send", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return {
          callId: call.id,
          ok: true,
          output: `<chat-log>\n[today 22:48]\nAlice:${String(call.input.content)}\n</chat-log>\n<time>2026-05-27 22:48:53<\\time>`
        };
      }
    }]
  });

  await core.handleEvent(textEvent());
  const toolMessage = requests[1].messages.find((message) => message.role === "tool");
  assert.equal(toolMessage?.content, "<chat-log>\n[today 22:48]\nAlice:one\n[today 22:48]\nAlice:two\n</chat-log>\n<time>2026-05-27 22:48:53<\\time>");
});

test("agent core can disable LLM streaming from config", async () => {
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
              name: "send_chat",
              arguments: "{\"type\":\"message\",\"content\":\"one\\ntwo\"}"
            }
          }]
        }
      };
    },
    async chatStream() {
      throw new Error("chatStream should not be called when streaming is disabled");
    }
  };
  const core = createAgentCore({
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
          name: "send_chat",
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

  await core.handleEvent(textEvent());
  assert.equal(chatCalls, 2);
  assert.deepEqual(sentLines, ["one\ntwo"]);
});

test("agent core emits llm lifecycle logs for streaming and non-streaming calls", async () => {
  const streamLogs: string[] = [];
  const streamCore = createAgentCore({
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

  await streamCore.handleEvent(textEvent());
  assert.deepEqual(streamLogs, ["call_start:true", "stream_start:true", "stream_end:true"]);

  const nonStreamLogs: string[] = [];
  const nonStreamCore = createAgentCore({
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

  await nonStreamCore.handleEvent(textEvent());
  assert.deepEqual(nonStreamLogs, ["call_start:false", "response_received:false"]);
});

test("agent core continues after send_chat until the next response has no tool calls", async () => {
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
                name: "check_chat",
                arguments: "{}"
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
                name: "send_chat",
                arguments: "{\"type\":\"message\",\"content\":\"final\"}"
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
  const core = createAgentCore({
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
          { name: "check_chat", description: "view", inputSchema: { type: "object" } },
          { name: "send_chat", description: "send", inputSchema: { type: "object" } }
        ];
      },
      async execute(call) {
        if (call.toolName === "send_chat") sent.push(String(call.input.content));
        return { callId: call.id, ok: true, output: call.toolName === "send_chat" ? "sent" : "history" };
      }
    }]
  });

  await core.handleEvent(textEvent());
  assert.deepEqual(sent, ["final"]);
  assert.equal(requests.length, 4);
});

test("agent core uses first-call and follow-up extra params", async () => {
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
                name: "check_chat",
                arguments: "{}"
              }
            }]
          }
        };
      }
      return { message: { role: "assistant", content: "done" } };
    }
  };
  const core = createAgentCore({
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
        return [{ name: "check_chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "history" };
      }
    }]
  });

  await core.handleEvent(textEvent());
  assert.deepEqual(requests.map((request) => request.extraParams), [
    { cache_prompt: true },
    { cache_prompt: false, reasoning_effort: "low" }
  ]);
});

test("agent core retries transient llm failures", async () => {
  const attempts: string[] = [];
  const retryLogs: Array<{ attempt?: number; delayMs?: number }> = [];
  const llm: LLMClient = {
    async chat() {
      throw new Error("chat should not be called");
    },
    async chatStream() {
      attempts.push("stream");
      if (attempts.length < 3) throw new Error("LLM request failed: 503 Service Unavailable service is too busy");
      return { message: { role: "assistant", content: "ok" } };
    }
  };
  const core = createAgentCore({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    onLLMLog(event) {
      if (event.kind === "retry") retryLogs.push({ attempt: event.attempt, delayMs: event.delayMs });
    }
  });

  await core.handleEvent(textEvent());

  assert.equal(attempts.length, 3);
  assert.deepEqual(retryLogs, [
    { attempt: 1, delayMs: 1000 },
    { attempt: 2, delayMs: 1000 }
  ]);
});

test("agent core does not retry non-transient llm failures", async () => {
  let attempts = 0;
  const llm: LLMClient = {
    async chat() {
      attempts += 1;
      throw new Error("LLM request failed: 400 Bad Request invalid tool_call");
    }
  };
  const core = createAgentCore({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy()
  });

  await assert.rejects(() => core.handleEvent(textEvent()), /400 Bad Request/);
  assert.equal(attempts, 1);
});

test("agent core keeps an active transcript and appends fake check_chat on the next heartbeat", async () => {
  const requests: LLMChatInput[] = [];
  let appendCheckCount = 0;
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: `final ${requests.length}` } };
    }
  };
  const core = createAgentCore({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true },
      layers: [{ id: "one", title: "One", role: "system", enabled: true, content: "system", order: 1 }],
      appendLayers: [{ id: "append_check", title: "Append check", role: "tool_request", enabled: true, content: "", thinking: "fake reason", toolName: "check_chat", toolArguments: "{}", order: 1 }]
    }),
    tools: [{
      id: "messaging-test",
      listTools() {
        return [{ name: "check_chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        appendCheckCount += 1;
        return { callId: call.id, ok: true, output: appendCheckCount === 1 ? "recent" : "new" };
      }
    }]
  });

  await core.handleEvent(textEvent());
  await core.handleEvent(textEvent());

  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages.at(-2)?.toolCalls?.[0].function.name, "check_chat");
  assert.equal(requests[0].messages.at(-2)?.reasoningContent, "fake reason");
  assert.equal(requests[0].messages.at(-1)?.content, "recent");
  assert.equal(requests[1].messages.some((message) => message.role === "assistant" && message.content === "final 1"), true);
  assert.equal(requests[1].messages.at(-1)?.content, "new");
});

test("agent core clears session before the next request when cached input cost exceeds check chat miss cost", async () => {
  const requests: LLMChatInput[] = [];
  const events: string[] = [];
  const previewCalls: Array<Record<string, unknown>> = [];
  const normalCheckCalls: Array<Record<string, unknown>> = [];
  let persistedSession: LLMSessionSnapshot | undefined;
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
              function: { name: "check_chat", arguments: "{}" }
            }]
          },
          usage: { inputTokens: 999, totalTokens: 999 }
        };
      }
      return {
        message: { role: "assistant", content: `final ${requests.length}` },
        usage: { inputTokens: 999, totalTokens: 999 }
      };
    }
  };
  const core = createAgentCore({
    config: loadConfig({ LLM_MODEL: "test-model" }),
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
        return [{ name: "check_chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        if (call.input.__preview === true) previewCalls.push(call.input);
        else normalCheckCalls.push(call.input);
        return { callId: call.id, ok: true, output: "0123456789" };
      }
    }]
  });

  await core.handleEvent(textEvent());
  assert.deepEqual(events, ["completed"]);
  assert.deepEqual(normalCheckCalls, [{}]);
  assert.deepEqual(previewCalls, []);

  await core.handleEvent(textEvent());

  assert.deepEqual(events, ["completed", "cleared:token_pressure", "completed"]);
  assert.deepEqual(previewCalls, [
    { __preview: true, __scope: "today" },
    { __preview: true, __scope: "today" }
  ]);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].messages.some((message) => message.content === "final 2"), false);
});

test("agent core restores token pressure baseline from persisted session snapshot", async () => {
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
        usage: { inputTokens: 101, totalTokens: 101 }
      };
    }
  };
  const baseDeps = {
    config: loadConfig({ LLM_MODEL: "deepseek-v4-flash" }),
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
        return [{ name: "check_chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call: ToolCall) {
        if (call.input.__preview === true) previewCalls.push(call.input);
        return { callId: call.id, ok: true, output: "abcdef" };
      }
    }]
  };
  const firstCore = createAgentCore(baseDeps);

  await firstCore.handleEvent(textEvent());
  assert.ok(persistedSession);
  persistedSession = {
    ...persistedSession,
    lastInputTokens: 101,
    lastUsageModel: "deepseek-v4-flash",
    tokenPressurePreviewBaselines: { "deepseek-v4-flash|normal|today|": 1 }
  };

  const restartedCore = createAgentCore(baseDeps);
  await restartedCore.handleEvent(textEvent());

  assert.deepEqual(previewCalls, [{ __preview: true, __scope: "today" }]);
  assert.deepEqual(events, ["cleared:token_pressure"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.some((message) => message.content === "final 1"), false);
});

test("agent core uses fixed prefix check chat preview scope for token pressure baseline", async () => {
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
  const core = createAgentCore({
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
      appendLayers: [{ id: "append_check", title: "Append check", role: "tool_request", enabled: true, content: "", toolName: "check_chat", toolArguments: "{}", order: 1 }]
    }),
    tools: [{
      id: "test-tools",
      listTools() {
        return [
          { name: "bookcase", description: "bookcase", inputSchema: { type: "object" } },
          { name: "check_chat", description: "view", inputSchema: { type: "object" } }
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

  await core.handleEvent(textEvent());
  await core.handleEvent(textEvent());

  assert.deepEqual(previewCalls.at(0), { __preview: true, __scope: "from_prefix", __fromPrefixAfterMessageId: 42 });
});

test("agent core token pressure comparison uses model-specific prices", async () => {
  async function run(model: string): Promise<string[]> {
    const events: string[] = [];
    let persistedSession: LLMSessionSnapshot | undefined;
    const llm: LLMClient = {
      async chat() {
        return {
          message: { role: "assistant", content: "final" },
          model,
          usage: { inputTokens: 101, totalTokens: 101 }
        };
      }
    };
    const core = createAgentCore({
      config: loadConfig({ LLM_MODEL: model }),
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
          lastTotalTokens: 101,
          lastInputTokens: 101,
          lastUsageModel: model,
          tokenPressurePreviewBaselines: { [`${model}|normal|today|`]: 1 }
        };
      },
      onLLMSessionCleared(reason) {
        events.push(reason);
        persistedSession = undefined;
      },
      tools: [{
        id: "messaging-test",
        listTools() {
          return [{ name: "check_chat", description: "view", inputSchema: { type: "object" } }];
        },
        async execute(call) {
          return { callId: call.id, ok: true, output: "abcdef" };
        }
      }]
    });

    await core.handleEvent(textEvent());
    await core.handleEvent(textEvent());
    return events;
  }

  assert.deepEqual(await run("deepseek-v4-flash"), ["token_pressure"]);
  assert.deepEqual(await run("deepseek-v4-pro"), []);
});

test("agent core clears only when static prompt fingerprint changes", async () => {
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
  const core = createAgentCore({
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
        return [{ name: "check_chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "history" };
      }
    }]
  });

  await core.handleEvent(textEvent());
  appendContent = "append two";
  await core.handleEvent(textEvent());
  staticContent = "static two";
  await core.handleEvent(textEvent());

  assert.deepEqual(clears, ["prompt_static_changed"]);
  assert.equal(requests[1].messages.some((message) => message.content === "ok"), true);
  assert.equal(requests[1].messages.some((message) => message.content === "append two"), true);
  assert.equal(requests[2].messages.some((message) => message.content === "ok"), false);
});

test("agent core rechecks static prompt before each LLM request", async () => {
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
  const core = createAgentCore({
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

  await core.handleEvent(textEvent());

  assert.deepEqual(clears, ["prompt_static_changed"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages.some((message) => message.content === "shell one"), true);
  assert.equal(requests[1].messages.some((message) => message.content === "shell two"), true);
  assert.equal(requests[1].messages.some((message) => message.content === "switched"), false);
  assert.equal(sessionUpdates.some((messages) => messages.some((message) => message.role === "tool" && message.content === "switched")), true);
  assert.equal(sessionUpdates.at(-1)?.some((message) => message.content === "switched"), false);
});

test("agent core stops after three consecutive identical tool calls", async () => {
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
              name: "check_chat",
              arguments: "{}"
            }
          }]
        }
      };
    }
  };
  const core = createAgentCore({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [{
      id: "messaging-test",
      listTools() {
        return [{ name: "check_chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        calls.push(call.id);
        return { callId: call.id, ok: true, output: "history" };
      }
    }]
  });

  await core.handleEvent(textEvent());
  assert.equal(requests.length, 3);
  assert.deepEqual(calls.filter((id) => !id.startsWith("append_append_check_chat_")), ["tool_view_1", "tool_view_2", "tool_view_3"]);
});

test("agent core falls back after max llm requests when tool calls alternate", async () => {
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
              name: useSearch ? "search_messages" : "check_chat",
              arguments: useSearch ? "{\"content\":\"loop\"}" : "{}"
            }
          }]
        }
      };
    }
  };
  const core = createAgentCore({
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
          { name: "check_chat", description: "view", inputSchema: { type: "object" } },
          { name: "search_messages", description: "search", inputSchema: { type: "object" } }
        ];
      },
      async execute(call) {
        calls.push(call.toolName);
        return { callId: call.id, ok: true, output: "ok" };
      }
    }]
  });

  await core.handleEvent(textEvent());
  assert.equal(requests.length, 10);
  assert.equal(calls.filter((name, index) => !(index === 0 && name === "check_chat")).length, 10);
});

test("agent core stops after three consecutive identical send_chat calls", async () => {
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
              name: "send_chat",
              arguments: "{\"type\":\"message\",\"content\":\"same\"}"
            }
          }]
        }
      };
    }
  };
  const core = createAgentCore({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [{
      id: "messaging-test",
      listTools() {
        return [{ name: "send_chat", description: "send", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        sent.push(`${call.id}:${String(call.input.content)}`);
        return { callId: call.id, ok: true, output: "sent" };
      }
    }]
  });

  await core.handleEvent(textEvent());
  assert.equal(requests.length, 3);
  assert.deepEqual(sent, [
    "tool_send_1:same",
    "tool_send_2:same",
    "tool_send_3:same"
  ]);
});

test("agent core stops after five total send_chat calls even when not consecutive identical", async () => {
  const requests: LLMChatInput[] = [];
  const sent: string[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      const content = requests.length % 2 === 0 ? "even" : "odd";
      return {
        message: {
          role: "assistant",
          content: "still sending",
          toolCalls: [{
            id: `tool_send_${requests.length}`,
            type: "function",
            function: {
              name: "send_chat",
              arguments: `{"type":"message","content":"${content}"}`
            }
          }]
        }
      };
    }
  };
  const core = createAgentCore({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: [{
      id: "messaging-test",
      listTools() {
        return [{ name: "send_chat", description: "send", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        sent.push(`${call.id}:${String(call.input.content)}`);
        return { callId: call.id, ok: true, output: "sent" };
      }
    }]
  });

  await core.handleEvent(textEvent());
  assert.equal(requests.length, 5);
  assert.deepEqual(sent, [
    "tool_send_1:odd",
    "tool_send_2:even",
    "tool_send_3:odd",
    "tool_send_4:even",
    "tool_send_5:odd"
  ]);
});

test("agent core skips non-send tools when send_chat appears in the same round", async () => {
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
                name: "check_chat",
                arguments: "{}"
              }
            },
            {
              id: "tool_send",
              type: "function",
              function: {
                name: "send_chat",
                arguments: "{\"type\":\"message\",\"content\":\"done\"}"
              }
            }
          ]
        }
      };
    }
  };
  const core = createAgentCore({
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
          { name: "check_chat", description: "view", inputSchema: { type: "object" } },
          { name: "send_chat", description: "send", inputSchema: { type: "object" } }
        ];
      },
      async execute(call) {
        calls.push(call.toolName);
        return { callId: call.id, ok: true, output: "ok" };
      }
    }]
  });

  await core.handleEvent(textEvent());
  assert.deepEqual(calls.filter((name, index) => !(index === 0 && name === "check_chat")), ["send_chat"]);
});

test("agent core does not stream send_chat when non-message type is explicit", async () => {
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
          name: "send_chat",
          arguments: "{\"type\":\"markdown\",\"content\":\"should not send\\n"
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
              name: "send_chat",
              arguments: "{\"type\":\"markdown\",\"content\":\"should not send\\n\"}"
            }
          }]
        }
      };
    }
  };
  const core = createAgentCore({
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
          name: "send_chat",
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

  await core.handleEvent(textEvent());
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
    session: {
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
