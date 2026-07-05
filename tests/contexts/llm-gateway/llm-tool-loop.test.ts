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
