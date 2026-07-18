import { test } from "node:test";
import assert from "node:assert/strict";
import { executeRegisteredLLMTool, registerLLMToolLoopTools, runLLMToolLoop, setLLMToolExecutionReporter } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import type { LLMChatResult } from "../../../src/contexts/llm-gateway/src/index.js";
import { finishAndWaitTool } from "../../../src/capabilities/tools/finish-and-wait/profile.js";
import { chatTool } from "../../../src/capabilities/tools/messaging/profile.js";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";

test("Chat and Yield profiles suppress execution cards", () => {
  assert.equal(chatTool.suppressExecutionCard, true);
  assert.equal(finishAndWaitTool.suppressExecutionCard, true);
});

test("registered tool execution reports progress unless its profile suppresses the card", async () => {
  const events: string[] = [];
  setLLMToolExecutionReporter({
    endSequence() {},
    begin(call) {
      events.push(`begin:${call.toolName}`);
      return {
        appendProgress(content) { events.push(`progress:${content}`); },
        finish(result) { events.push(`finish:${result.callId}`); },
        fail(error) { events.push(`fail:${String(error)}`); }
      };
    }
  });
  registerLLMToolLoopTools("tool-report-test", [{
    id: "test",
    listTools: () => [
      { name: "Visible", description: "visible", inputSchema: {} },
      { name: "Hidden", description: "hidden", inputSchema: {}, suppressExecutionCard: true }
    ],
    async execute(call, context) {
      context?.reportProgress?.("working");
      return { callId: call.id, ok: true };
    }
  }]);

  try {
    await executeRegisteredLLMTool("tool-report-test", { id: "visible", toolName: "Visible", input: {} });
    await executeRegisteredLLMTool("tool-report-test", { id: "hidden", toolName: "Hidden", input: {} });
  } finally {
    setLLMToolExecutionReporter(undefined);
  }

  assert.deepEqual(events, ["begin:Visible", "progress:working", "finish:visible"]);
});

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

test("LLM tool loop returns tool execution errors to the LLM and continues", async () => {
  let requests = 0;
  registerLLMToolLoopTools("llm-tool-loop-tool-error-test", [{
    id: "test",
    listTools: () => [{ name: "Bash", description: "bash", inputSchema: { type: "object" } }],
    async execute() {
      throw new Error("sandbox failed");
    }
  }]);

  const result = await runLLMToolLoop({
    initialMessages: [{ role: "user", content: "run it" }],
    buildRequest({ messages }) {
      return { agentId: "chat", messages, toolNames: ["Bash"], toolVariables: testPromptRuntime() };
    },
    async sendRequest(input) {
      requests += 1;
      if (input.round === 0) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "bash_1",
              type: "function",
              function: { name: "Bash", arguments: "{}" }
            }]
          }
        };
      }
      return { message: { role: "assistant", content: "I got the tool error." } };
    },
    toolRegistryName: "llm-tool-loop-tool-error-test"
  });

  assert.equal(requests, 2);
  assert.equal(result.stopReason, "completed");
});
