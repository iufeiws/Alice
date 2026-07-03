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
