import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatAgent as createChatAgentUnderTest, type LLMSessionSnapshot } from "../../../src/contexts/agent-loop/src/application/chat-agent.js";
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

test("chat agent filters messaging tools when feishu visibility is disabled", async () => {
  const requests: LLMChatInput[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "" } };
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
        return [{ name: "Selfie", description: "selfie", inputSchema: { type: "object" } }];
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
    config: loadConfig({ LLM_MODEL: "test-model", PROJECT_USERNAME: "小王" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      visibleTools: { feishu: true },
      layers: [
        { id: "sys", title: "Sys", role: "system", enabled: true, content: "hello ${{user}}", order: 1 },
        { id: "usr", title: "Usr", role: "user", enabled: true, content: "timezone ${{timezone}}", order: 2 }
      ]
    })
  });

  await runPreparedChatEvent(core, textEvent());
  assert.equal(requests[0].messages[0].role, "system");
  assert.equal(requests[0].messages[1].role, "user");
  assert.equal(requests[0].messages.length, 2);
});

test("chat agent runs prompt tool request layers and appends actual tool result", async () => {
  const requests: LLMChatInput[] = [];
  const toolCalls: ToolCall[] = [];
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "" } };
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

  const promptToolCall = toolCalls.find((call) => call.id === "call_prompt_history");
  assert.equal(promptToolCall?.toolName, "Chat");
  assert.deepEqual(promptToolCall?.input, { action: "poll" });
  assert.equal(requests[0].messages[0].role, "assistant");
  assert.equal(requests[0].messages[0].toolCalls?.[0].id, "call_prompt_history");
  assert.equal(requests[0].messages[1].role, "tool");
});

test("chat agent waits for final Chat JSON and sends newline message content once", async () => {
  const requests: LLMChatInput[] = [];
  const sentLines: string[] = [];
  let completed = 0;
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
      return { message: { role: "assistant", content: "" } };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    onLLMSessionCompleted() {
      completed += 1;
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
  assert.equal(sentLines.length >= 1, true);
  assert.equal(requests.length, 2);
  assert.equal(completed, 1);
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
        assert.equal(toolMessage?.role, "tool");
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
      return { message: { role: "assistant", content: "" } };
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
  assert.equal(sentLines.length >= 2, true);
});
