import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatAgent as createChatAgentUnderTest, type LLMSessionSnapshot } from "../../../src/contexts/agent-loop/src/application/chat-agent.js";
import type { LLMRequestSenderInput } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import type { LLMChatInput, LLMClient } from "../../../src/contexts/llm-gateway/src/index.js";
import type { AgentEvent } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import type { ToolCall } from "../../../src/contexts/tool-execution/src/index.js";
import { loadConfig } from "../../../src/apps/api/bootstrap/app-config-runtime.js";
import { createOutputRouter } from "../../../src/platform/output-router/src/index.js";
import { createAllowAllPolicy } from "../../../src/contexts/agent-loop/src/ports/policy.js";
import { createIntentRouter } from "../../../src/contexts/agent-loop/src/application/intent-router.js";
import { createSessionResolver } from "../../../src/contexts/agent-loop/src/application/session-resolver.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createAgentStateController, type AgentBehaviorState } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { createChatAgent, runPreparedChatEvent, textEvent, chatTestTools, memoryStore, messageContentText } from "./agent-tools-helpers.js";

test("chat agent waits for final Chat JSON and sends newline voice content once", async () => {
  const sentLines: string[] = [];
  const llm: LLMClient = {
    async chat(input) {
      return this.chatStream ? this.chatStream(input) : { message: { role: "assistant", content: "fallback" } };
    },
    async chatStream(input, handlers) {
      if (input.messages.some((message) => message.role === "tool")) {
        return { message: { role: "assistant", content: "" } };
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
        return { message: { role: "assistant", content: "" } };
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
        return { message: { role: "assistant", content: "" } };
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
        return { message: { role: "assistant", content: "" } };
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
        return { message: { role: "assistant", content: "" } };
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
  assert.equal(toolMessage?.role, "tool");
});

test("chat agent can disable LLM streaming from config", async () => {
  const sentLines: string[] = [];
  let chatCalls = 0;
  const llm: LLMClient = {
    async chat(input) {
      chatCalls += 1;
      if (input.messages.some((message) => message.role === "tool")) {
        return { message: { role: "assistant", content: "" } };
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
  assert.deepEqual(sentLines, ["one\ntwo"]);
});

test("chat agent emits llm lifecycle logs for streaming calls", async () => {
  const logs: string[] = [];
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm: {
      async chat() {
        throw new Error("chat should not be called");
      },
      async chatStream() {
        return { message: { role: "assistant", content: "" } };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    onLLMLog(event) {
      logs.push(`${event.kind}:${event.stream}`);
    }
  });

  await runPreparedChatEvent(core, textEvent());
});

test("chat agent emits llm lifecycle logs for non-streaming calls", async () => {
  const logs: string[] = [];
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_STREAM_ENABLED: "false" }),
    llm: {
      async chat() {
        return { message: { role: "assistant", content: "" } };
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
      logs.push(`${event.kind}:${event.stream}`);
    }
  });

  await runPreparedChatEvent(core, textEvent());
});
