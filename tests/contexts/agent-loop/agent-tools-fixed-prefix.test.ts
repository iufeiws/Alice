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
        function: { name: "Bookcase", arguments: "{\"action\":\"draw\"}" }
      }]
    },
    { role: "tool", name: "Bookcase", toolCallId: "tool_draw", content: "<book>persistent story</book>" }
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
      fixedPrefixStartedAt: "2026-05-30T00:00:00.000"
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
  const checkChatIndex = messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Chat");
  assert.ok(checkChatIndex >= 0);
  assert.equal(messages[checkChatIndex + 1]?.role, "tool");
});

test("chat agent uses fixed prefix transcript from an initial session snapshot", async () => {
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
    { role: "tool", name: "Bookcase", toolCallId: "tool_draw", content: "<book>restored story</book>" }
  ];
  const requests: LLMChatInput[] = [];
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
      appendLayers: []
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
      fixedPrefixStartedAt: "2026-05-30T00:00:00.000"
    },
    tools: []
  });

  await runPreparedChatEvent(core, textEvent());

  assert.equal(requests.length, 1);
  const messages = requests[0].messages;
  const bookcaseIndex = messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Bookcase");
  assert.ok(bookcaseIndex >= 0);
  assert.equal(messages[bookcaseIndex + 1]?.role, "tool");
});

test("chat agent exits expired fixed prefix mode on the next request", async () => {
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
    { role: "tool", name: "Bookcase", toolCallId: "tool_draw", content: "<book>expired story</book>" }
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
      fixedPrefixStartedAt: "2026-05-30T00:00:00.000"
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
  assert.equal(messages.some((message) => message.role === "assistant" && message.toolCalls?.[0]?.function.name === "Bookcase"), false);
  assert.equal(sessionUpdates.at(-1)?.mode, "normal");
  assert.equal(sessionUpdates.at(-1)?.modeStartedAt, undefined);
});

test("chat agent passes agent loop run context to exposed selfie tool calls", async () => {
  const requests: LLMChatInput[] = [];
  const executed: string[] = [];
  const contexts: Array<{ agentLoopRunSeq?: number; llmSessionId?: number | string }> = [];
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
                function: { name: "Selfie", arguments: "{\"pose\":\"first\"}" }
              },
              {
                id: "tool_selfie_2",
                type: "function",
                function: { name: "Selfie", arguments: "{\"pose\":\"second\"}" }
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
        return [{ name: "Selfie", description: "selfie", inputSchema: { type: "object" } }];
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
