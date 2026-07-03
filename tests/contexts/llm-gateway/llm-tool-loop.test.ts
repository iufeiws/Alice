import { test } from "node:test";
import assert from "node:assert/strict";
import { runLLMToolLoop } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import type { LLMChatResult } from "../../../src/contexts/llm-gateway/src/index.js";

test("LLM tool loop throws on repeated assistant messages ignoring tool call id", async () => {
  let requests = 0;
  let toolExecutions = 0;
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
        return { agentId: "chat", messages, toolNames: [] };
      },
      async sendRequest() {
        requests += 1;
        return repeated();
      },
      async executeTool(call) {
        toolExecutions += 1;
        return {
          message: {
            role: "tool",
            toolCallId: call.id,
            name: call.function.name,
            content: `tool result ${toolExecutions}`
          }
        };
      }
    }),
    /llm_tool_loop_repeated_assistant_message/
  );

  assert.equal(requests, 2);
  assert.equal(toolExecutions, 1);
});
