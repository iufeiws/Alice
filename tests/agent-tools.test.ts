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
                name: "check_feishu",
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
          name: "check_feishu",
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
  assert.equal(requests[0].tools?.[0].function.name, "check_feishu");
  assert.equal(toolCalls[0].toolName, "check_feishu");
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
                name: "check_feishu",
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
          name: "check_feishu",
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
  assert.equal(requests[1].messages.at(-2)?.role, "assistant");
  assert.equal(requests[1].messages.at(-2)?.content, "checking history");
  assert.equal(requests[1].messages.at(-2)?.reasoningContent, "I should inspect messages first.");
  assert.equal(requests[1].messages.at(-2)?.toolCalls?.[0].function.name, "check_feishu");
  assert.equal(requests[1].messages.at(-1)?.role, "tool");
  assert.equal(requests[1].messages.at(-1)?.toolCallId, "tool_1");
  assert.equal(requests[1].messages.at(-1)?.content, "history result");
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
          name: "check_feishu",
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
        toolName: "check_feishu",
        toolCallId: "call_prompt_history",
        toolArguments: "{}",
        order: 1
      }]
    }),
    tools: [{
      id: "messaging",
      listTools() {
        return [{
          name: "check_feishu",
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
  assert.equal(toolCalls[0].toolName, "check_feishu");
  assert.deepEqual(toolCalls[0].input, {});
  assert.equal(requests[0].messages[0].role, "assistant");
  assert.equal(requests[0].messages[0].toolCalls?.[0].id, "call_prompt_history");
  assert.equal(requests[0].messages[1].role, "tool");
  assert.equal(requests[0].messages[1].content, "actual history");
});

test("agent core streams send_feishu message content on newlines before final tool JSON", async () => {
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
            name: "send_feishu",
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
                name: "send_feishu",
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
          name: "send_feishu",
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

test("agent core waits for final send_feishu JSON when type is omitted", async () => {
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
          name: "send_feishu",
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
              name: "send_feishu",
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
          name: "send_feishu",
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

test("agent core does not stream send_feishu before type is known", async () => {
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
          name: "send_feishu",
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
              name: "send_feishu",
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
          name: "send_feishu",
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

test("agent core merges streamed send_feishu chat outputs into one tool message", async () => {
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
          name: "send_feishu",
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
              name: "send_feishu",
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
        return [{ name: "send_feishu", description: "send", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return {
          callId: call.id,
          ok: true,
          output: `<chat>\n[22:48]\nAlice:${String(call.input.content)}\n</chat>\nCurrent time is [2026-05-27 22:48:53]`
        };
      }
    }]
  });

  await core.handleEvent(textEvent());
  const toolMessage = requests[1].messages.find((message) => message.role === "tool");
  assert.equal(toolMessage?.content, "<chat>\n[22:48]\nAlice:one\n[22:48]\nAlice:two\n</chat>\nCurrent time is [2026-05-27 22:48:53]");
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
              name: "send_feishu",
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
          name: "send_feishu",
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

test("agent core continues after send_feishu until the next response has no tool calls", async () => {
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
                name: "check_feishu",
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
                name: "send_feishu",
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
          { name: "check_feishu", description: "view", inputSchema: { type: "object" } },
          { name: "send_feishu", description: "send", inputSchema: { type: "object" } }
        ];
      },
      async execute(call) {
        if (call.toolName === "send_feishu") sent.push(String(call.input.content));
        return { callId: call.id, ok: true, output: call.toolName === "send_feishu" ? "sent" : "history" };
      }
    }]
  });

  await core.handleEvent(textEvent());
  assert.deepEqual(sent, ["final"]);
  assert.equal(requests.length, 4);
});

test("agent core stops after five llm requests when tool calls continue", async () => {
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
              name: "check_feishu",
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
        return [{ name: "check_feishu", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        calls.push(call.id);
        return { callId: call.id, ok: true, output: "history" };
      }
    }]
  });

  await core.handleEvent(textEvent());
  assert.equal(requests.length, 5);
  assert.deepEqual(calls, ["tool_view_1", "tool_view_2", "tool_view_3", "tool_view_4", "tool_view_5"]);
});

test("agent core skips non-send tools when send_feishu appears in the same round", async () => {
  const calls: string[] = [];
  const llm: LLMClient = {
    async chat(input) {
      if (input.messages.some((message) => message.role === "tool")) {
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
                name: "check_feishu",
                arguments: "{}"
              }
            },
            {
              id: "tool_send",
              type: "function",
              function: {
                name: "send_feishu",
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
          { name: "check_feishu", description: "view", inputSchema: { type: "object" } },
          { name: "send_feishu", description: "send", inputSchema: { type: "object" } }
        ];
      },
      async execute(call) {
        calls.push(call.toolName);
        return { callId: call.id, ok: true, output: "ok" };
      }
    }]
  });

  await core.handleEvent(textEvent());
  assert.deepEqual(calls, ["send_feishu"]);
});

test("agent core does not stream send_feishu when non-message type is explicit", async () => {
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
          name: "send_feishu",
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
              name: "send_feishu",
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
          name: "send_feishu",
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
