import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatAgentLoop } from "../../../src/contexts/agent-loop/src/application/run-chat-loop.js";
import { runAgentFunctionCallLoop } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import type { ToolPlugin } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { emptyPromptRenderer, fakeTime, textEvent } from "./agent-loop-runtime-helpers.js";

test("chat loop inserts interrupt user message after next tool result", async () => {
  const session = {
    messages: [{ role: "user" as const, content: "go" }],
    requestTimestamps: [],
    mode: "normal"
  };
  let consumeInterrupt = true;
  const requests: any[] = [];
  const executedTools: string[] = [];
  const tools: ToolPlugin[] = [{
    id: "tools",
    listTools() {
      return [{ name: "test_tool", description: "test", inputSchema: {} }];
    },
    async execute(call) {
      executedTools.push(call.toolName);
      return { callId: call.id, ok: true, output: "tool ok" };
    }
  }];
  const loop = buildChatAgentLoop({
    llmInput: { messages: session.messages, toolNames: ["test_tool"] },
    event: textEvent("session-interrupt"),
    toolPlugins: tools,
    session,
    ensureSession: async () => session,
    appendSessionContext: async () => {},
    llm: { async chat() { throw new Error("unused"); } },
    async llmRequestSender({ round, messages }) {
      requests.push(messages);
      if (round === 0) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "call_test",
              type: "function",
              function: { name: "test_tool", arguments: "{}" }
            }]
          },
          finishReason: "tool_calls"
        };
      }
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    },
    time: fakeTime(),
    buildTextVariables: emptyPromptRenderer,
    noteSessionUpdated: () => {},
    getLastCompletedToolName: () => undefined,
    setLastCompletedToolName: () => {},
    applyModeStateToNewSession: () => {},
    interruptLayer: {
      id: "interrupt",
      title: "Interrupt Layer",
      role: "user",
      name: "ConfiguredInterrupt",
      enabled: true,
      content: "configured interrupt content",
      order: 0
    },
    consumePendingUserMessageInterrupt: () => {
      const current = consumeInterrupt;
      consumeInterrupt = false;
      return current;
    }
  });

  const result = loop.complete(await runAgentFunctionCallLoop(loop.spec));

  assert.equal(result.finalResult?.message.content, "done");
  assert.deepEqual(executedTools, ["test_tool"]);
  assert.equal(requests[1].at(-2).role, "tool");
  assert.equal(requests[1].at(-2).toolCallId, "call_test");
  assert.equal(requests[1].at(-2).content, "tool ok");
  assert.equal(requests[1].at(-1).role, "user");
});

test("chat loop exposes visible tools and sends chat blocks through ToolPlugin.execute", async () => {
  const session = {
    messages: [{ role: "user" as const, content: "go" }],
    requestTimestamps: [],
    mode: "normal"
  };
  const sent: string[] = [];
  const executedTools: string[] = [];
  const tools: ToolPlugin[] = [{
    id: "messaging",
    listTools() {
      return [
        { name: "Chat", description: "send", inputSchema: {} },
        { name: "test_tool", description: "test", inputSchema: {} }
      ];
    },
    async execute(call) {
      executedTools.push(call.toolName);
      if (call.toolName === "Chat") sent.push(`${call.input.alice ?? ""}:${call.input.type ?? ""}:${call.input.content ?? ""}`);
      return { callId: call.id, ok: true, output: "ok" };
    }
  }];
  const exposedToolNames: string[][] = [];
  const loop = buildChatAgentLoop({
    llmInput: { messages: session.messages, toolNames: ["Chat", "test_tool"] },
    event: textEvent("session-content-send"),
    toolPlugins: tools,
    session,
    ensureSession: async () => session,
    appendSessionContext: async () => {},
    llm: { async chat() { throw new Error("unused"); } },
    async llmRequestSender({ round, toolNames }) {
      exposedToolNames.push(toolNames);
      if (round === 0) {
        return {
          message: {
            role: "assistant",
            content: [
              "before",
              "<chat alice='core' type='voice'>",
              "prefix",
              "</chat ignored>",
            ].join("\n"),
            toolCalls: [{
              id: "call_test",
              type: "function",
              function: { name: "test_tool", arguments: "{\"action\":\"poll\"}" }
            }]
          },
          finishReason: "tool_calls"
        };
      }
      return { message: { role: "assistant", content: "<chat type=\"bad\" alice=\"bad\">done" }, finishReason: "stop" };
    },
    time: fakeTime(),
    buildTextVariables: emptyPromptRenderer,
    noteSessionUpdated: () => {},
    getLastCompletedToolName: () => undefined,
    setLastCompletedToolName: () => {},
    applyModeStateToNewSession: () => {}
  });

  const result = loop.complete(await runAgentFunctionCallLoop(loop.spec));

  assert.equal(result.sentMessage, true);
  assert.deepEqual(exposedToolNames, [["Chat", "test_tool"], ["Chat", "test_tool"]]);
  assert.deepEqual(executedTools, ["Chat", "test_tool", "Chat"]);
  assert.deepEqual(sent, ["core:voice:prefix", "shell:message:done"]);
});
