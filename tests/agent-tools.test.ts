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
  assert.equal(requests[1].messages.at(-2)?.role, "assistant");
  assert.equal(requests[1].messages.at(-2)?.content, "checking history");
  assert.equal(requests[1].messages.at(-2)?.reasoningContent, "I should inspect messages first.");
  assert.equal(requests[1].messages.at(-2)?.toolCalls?.[0].function.name, "check_chat");
  assert.equal(requests[1].messages.at(-1)?.role, "tool");
  assert.equal(requests[1].messages.at(-1)?.toolCallId, "tool_1");
  assert.equal(requests[1].messages.at(-1)?.content, "history result");
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
