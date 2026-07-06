import { test } from "node:test";
import assert from "node:assert/strict";
import { registerLLMToolLoopTools, runLLMToolLoop } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import type { LLMChatResult } from "../../../src/contexts/llm-gateway/src/index.js";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";

test("LLM tool loop throws on repeated assistant messages ignoring tool call id", async () => {
  let requests = 0;
  let toolExecutions = 0;
  registerLLMToolLoopTools("llm-tool-loop-test", [{
    id: "test",
    listTools: () => [{ name: "Chat", description: "chat", inputSchema: { type: "object" } }],
    async execute(call) {
      toolExecutions += 1;
      return { callId: call.id, ok: true, output: `tool result ${toolExecutions}` };
    }
  }]);
  const repeated = (): LLMChatResult => ({
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: `call_${requests}`,
        type: "function",
        function: {
          name: "Chat",
          arguments: "{\"action\":\"poll\"}"
        }
      }]
    }
  });

  await assert.rejects(
    runLLMToolLoop({
      initialMessages: [{ role: "user", content: "start" }],
      buildRequest({ messages }) {
        return { agentId: "chat", messages, toolNames: [], toolVariables: testPromptRuntime() };
      },
      async sendRequest() {
        requests += 1;
        return repeated();
      },
      toolRegistryName: "llm-tool-loop-test"
    }),
    /llm_tool_loop_repeated_assistant_message/
  );

  assert.equal(requests, 2);
  assert.equal(toolExecutions, 1);
});

test("LLM tool loop transforms assistant content before tool execution", async () => {
  const calls: string[] = [];
  registerLLMToolLoopTools("llm-tool-loop-transform-test", [{
    id: "test",
    listTools: () => [
      { name: "Chat", description: "chat", inputSchema: { type: "object" } },
      { name: "Later", description: "later", inputSchema: { type: "object" } }
    ],
    async execute(call) {
      calls.push(`${call.toolName}:${JSON.stringify(call.input)}`);
      return { callId: call.id, ok: true, output: "ok" };
    }
  }]);

  const result = await runLLMToolLoop({
    initialMessages: [{ role: "user", content: "start" }],
    buildRequest({ messages }) {
      return { agentId: "chat", messages, toolNames: [], toolVariables: testPromptRuntime() };
    },
    async sendRequest(input) {
      return input.round === 0
        ? {
          message: {
            role: "assistant",
            content: "hello",
            toolCalls: [{
              id: "later_1",
              type: "function",
              function: { name: "Later", arguments: "{\"value\":1}" }
            }]
          }
        }
        : { message: { role: "assistant", content: "" } };
    },
    transformAssistantMessage({ round, message }) {
      const content = typeof message.content === "string" ? message.content.trim() : "";
      if (!content) return message;
      return {
        ...message,
        content: "",
        toolCalls: [{
          id: `assistant_content_${round + 1}`,
          type: "function",
          function: { name: "Chat", arguments: JSON.stringify({ action: "send", content }) }
        }, ...(message.toolCalls ?? [])]
      };
    },
    toolRegistryName: "llm-tool-loop-transform-test"
  });

  assert.deepEqual(calls, [
    "Chat:{\"action\":\"send\",\"content\":\"hello\"}",
    "Later:{\"value\":1}"
  ]);
  const assistantMessage = result.messages.find((message) => message.role === "assistant" && message.toolCalls?.length);
  assert.equal(assistantMessage?.content, "");
  assert.equal(assistantMessage?.toolCalls?.[0]?.function.name, "Chat");
  assert.equal(assistantMessage?.toolCalls?.[1]?.function.name, "Later");
});
