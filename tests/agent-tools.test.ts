import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentCore } from "../core/agent/src/index.js";
import type { LLMChatInput, LLMClient } from "../core/llm/src/index.js";
import type { AgentEvent, ToolCall } from "../packages/types/src/index.js";
import { loadConfig } from "../packages/config/src/index.js";
import { createOutputRouter } from "../core/output-router/src/index.js";
import { createAllowAllPolicy } from "../core/policy/src/index.js";
import { createIntentRouter } from "../core/router/src/index.js";
import { createSessionResolver } from "../core/session/src/index.js";

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
                name: "view_messages",
                arguments: "{\"scope\":\"today\"}"
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
          name: "view_messages",
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
  assert.equal(outputs[0].content.kind, "text");
  assert.equal(outputs[0].content.kind === "text" ? outputs[0].content.text : "", "final answer");
  assert.equal(requests[0].tools?.[0].function.name, "view_messages");
  assert.equal(toolCalls[0].toolName, "view_messages");
  assert.equal(toolCalls[0].session?.sessionId, "session-1");
  assert.equal(requests[1].messages.at(-1)?.role, "tool");
  assert.equal(requests[1].messages.at(-1)?.content, "history");
});

test("agent core streams send_message message content on newlines before final tool JSON", async () => {
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
          id: "tool_send",
          type: "function",
          function: {
            name: "send_message",
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
                name: "send_message",
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
    tools: [{
      id: "messaging-test",
      listTools() {
        return [{
          name: "send_message",
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
  assert.equal(outputs[0].content.kind, "text");
  assert.equal(outputs[0].content.kind === "text" ? outputs[0].content.text : "", "done");
  assert.deepEqual(sentLines, ["one", "two", "three"]);
  const toolMessage = requests[1].messages.find((message) => message.role === "tool");
  assert.match(toolMessage?.content ?? "", /sent: one/);
  assert.match(toolMessage?.content ?? "", /sent: three/);
});

test("agent core does not stream send_message before confirming non-message type", async () => {
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
          name: "send_message",
          arguments: "{\"content\":\"should not send\\n"
        }
      });
      assert.deepEqual(sentLines, []);
      await handlers?.onToolCallDelta?.({
        index: 0,
        function: {
          arguments: "\",\"type\":\"markdown\"}"
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
              name: "send_message",
              arguments: "{\"content\":\"should not send\\n\",\"type\":\"markdown\"}"
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
          name: "send_message",
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
