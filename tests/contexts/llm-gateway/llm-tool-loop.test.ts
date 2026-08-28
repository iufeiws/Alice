import { test } from "node:test";
import assert from "node:assert/strict";
import { runLLMToolLoop } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import { registerToolPlugins } from "../../../src/contexts/tool-execution/src/index.js";
import type { LLMChatResult } from "../../../src/contexts/llm-gateway/src/index.js";
import { finishAndWaitTool } from "../../../src/capabilities/tools/finish-and-wait/profile.js";
import { chatTool } from "../../../src/capabilities/tools/messaging/profile.js";
import { bookcaseTool } from "../../../src/capabilities/tools/bookcase/profile.js";
import { calendarTool } from "../../../src/capabilities/tools/calendar/profile.js";
import { diceTool } from "../../../src/capabilities/tools/dice/profile.js";
import { editTool, globTool, readTool, writeTool } from "../../../src/capabilities/tools/file/profile.js";
import { panoramaTool } from "../../../src/capabilities/tools/location/profile.js";
import { selfieTool } from "../../../src/capabilities/tools/photo/profile.js";
import { restartTool } from "../../../src/capabilities/tools/restart/profile.js";
import { bashTool } from "../../../src/capabilities/tools/shell/profile.js";
import { skillTool } from "../../../src/capabilities/tools/skills/profile.js";
import { sleepCocoonTool } from "../../../src/capabilities/tools/sleep-cocoon/profile.js";
import { subAgentTool } from "../../../src/capabilities/tools/subagent/profile.js";
import { wardrobeTool } from "../../../src/capabilities/tools/wardrobe/profile.js";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";

test("Chat and Yield profiles suppress execution cards", () => {
  assert.equal(chatTool.suppressExecutionCard, true);
  assert.equal(chatTool.sendsMessage, true);
  assert.equal(finishAndWaitTool.suppressExecutionCard, true);
});

test("tool profiles explicitly configure whether results pass through renderText", () => {
  assert.deepEqual([
    bookcaseTool,
    calendarTool,
    diceTool,
    finishAndWaitTool,
    panoramaTool,
    chatTool,
    selfieTool,
    restartTool,
    skillTool,
    sleepCocoonTool,
    wardrobeTool
  ].map((tool) => tool.passRenderText), Array(11).fill(true));
  assert.deepEqual([
    readTool,
    writeTool,
    editTool,
    globTool,
    bashTool,
    subAgentTool
  ].map((tool) => tool.passRenderText), Array(6).fill(undefined));
});

test("LLM tool loop throws on repeated assistant messages ignoring tool call id", async () => {
  let requests = 0;
  let toolExecutions = 0;
  registerToolPlugins("llm-tool-loop-test", [{
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
  registerToolPlugins("llm-tool-loop-transform-test", [{
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
  registerToolPlugins("llm-tool-loop-tool-error-test", [{
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

test("LLM tool loop returns an unavailable tool result to the LLM and continues", async () => {
  let requests = 0;
  const result = await runLLMToolLoop({
    initialMessages: [{ role: "user", content: "run it" }],
    buildRequest({ messages }) {
      return { agentId: "memorize", messages, toolNames: [], toolVariables: testPromptRuntime() };
    },
    async sendRequest(input) {
      requests += 1;
      if (input.round === 0) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "unknown_1",
              type: "function",
              function: { name: "self_tool", arguments: "{}" }
            }]
          }
        };
      }
      const toolMessage = input.messages.at(-1);
      assert.equal(toolMessage?.role, "tool");
      assert.equal(toolMessage?.toolCallId, "unknown_1");
      assert.equal(toolMessage?.name, "self_tool");
      assert.equal(toolMessage?.content, "<error type=\"tool unavailable\">llm_tool_unavailable:self_tool</error>");
      return { message: { role: "assistant", content: "I will use an available tool." } };
    },
    toolRegistryName: "llm-tool-loop-unknown-tool-test"
  });

  assert.equal(requests, 2);
  assert.equal(result.stopReason, "completed");
});

test("LLM tool loop preserves legacy mustache text returned by a tool", async () => {
  registerToolPlugins("llm-tool-loop-legacy-mustache-test", [{
    id: "test",
    listTools: () => [{ name: "External", description: "external", inputSchema: { type: "object" } }],
    async execute(call) {
      return { callId: call.id, ok: true, output: "external result: {{message}}" };
    }
  }]);

  const result = await runLLMToolLoop({
    initialMessages: [{ role: "user", content: "run it" }],
    buildRequest({ messages }) {
      return { agentId: "chat", messages, toolNames: ["External"], toolVariables: testPromptRuntime() };
    },
    async sendRequest(input) {
      if (input.round === 0) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "external_1",
              type: "function",
              function: { name: "External", arguments: "{}" }
            }]
          }
        };
      }
      return { message: { role: "assistant", content: "done" } };
    },
    toolRegistryName: "llm-tool-loop-legacy-mustache-test"
  });

  const toolMessage = result.messages.find((message) => message.role === "tool");
  assert.equal(toolMessage?.content, "external result: {{message}}");
});

test("LLM tool loop only passes tool result text through renderText when the profile enables it", async () => {
  registerToolPlugins("llm-tool-loop-pass-render-text-test", [{
    id: "test",
    listTools: () => [
      { name: "Raw", description: "raw", inputSchema: {} },
      { name: "Rendered", description: "rendered", inputSchema: {}, passRenderText: true }
    ],
    async execute(call) {
      return { callId: call.id, ok: true, output: `${call.toolName}: \${{user}}` };
    }
  }]);

  async function run(toolName: string) {
    return runLLMToolLoop({
      initialMessages: [{ role: "user", content: "run it" }],
      buildRequest({ messages }) {
        return { agentId: "chat", messages, toolNames: [toolName], toolVariables: testPromptRuntime({ user: "小王" }) };
      },
      async sendRequest(input) {
        return input.round === 0
          ? {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{
                id: `${toolName}_1`,
                type: "function",
                function: { name: toolName, arguments: "{}" }
              }]
            }
          }
          : { message: { role: "assistant", content: "done" } };
      },
      toolRegistryName: "llm-tool-loop-pass-render-text-test"
    });
  }

  const rawResult = await run("Raw");
  const renderedResult = await run("Rendered");
  assert.equal(rawResult.messages.find((message) => message.role === "tool")?.content, "Raw: ${{user}}");
  assert.equal(renderedResult.messages.find((message) => message.role === "tool")?.content, "Rendered: 小王");
});
