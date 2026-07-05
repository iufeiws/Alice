import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatAgentLoop } from "../../../src/contexts/agent-loop/src/application/run-chat-loop.js";
import { runAgentFunctionCallLoop } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import { registerLLMToolLoopTools } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import type { ToolPlugin } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { emptyPromptRenderer, fakeTime, textEvent } from "./agent-loop-runtime-helpers.js";

test("chat loop exposes visible tools to LLM requests", async () => {
  const session = {
    messages: [{ role: "user" as const, content: "go" }],
    requestTimestamps: [],
    mode: "normal"
  };
  const tools: ToolPlugin[] = [{
    id: "messaging",
    listTools() {
      return [
        { name: "Chat", description: "send", inputSchema: {} },
        { name: "test_tool", description: "test", inputSchema: {} }
      ];
    },
    async execute(call) {
      return { callId: call.id, ok: true, output: "ok" };
    }
  }];
  registerLLMToolLoopTools("default", tools);
  const exposedToolNames: string[][] = [];
  const loop = buildChatAgentLoop({
    llmInput: { messages: session.messages, toolNames: ["Chat", "test_tool"] },
    event: textEvent("session-content-send"),
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
            content: "",
            toolCalls: [{
              id: "call_test",
              type: "function",
              function: { name: "test_tool", arguments: "{\"action\":\"poll\"}" }
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
    applyModeStateToNewSession: () => {}
  });

  loop.complete(await runAgentFunctionCallLoop(loop.spec));

  assert.deepEqual(exposedToolNames, [["Chat", "test_tool"], ["Chat", "test_tool"]]);
});

test("chat loop sends chat blocks through ToolPlugin.execute", async () => {
  const session = {
    messages: [{ role: "user" as const, content: "go" }],
    requestTimestamps: [],
    mode: "normal"
  };
  const sent: string[] = [];
  const tools: ToolPlugin[] = [{
    id: "messaging",
    listTools() {
      return [{ name: "Chat", description: "send", inputSchema: {} }];
    },
    async execute(call) {
      if (call.toolName === "Chat") sent.push(`${call.input.alice ?? ""}:${call.input.type ?? ""}:${call.input.content ?? ""}`);
      return { callId: call.id, ok: true, output: "ok" };
    }
  }];
  registerLLMToolLoopTools("default", tools);
  const loop = buildChatAgentLoop({
    llmInput: { messages: session.messages, toolNames: ["Chat"] },
    event: textEvent("session-content-send"),
    session,
    ensureSession: async () => session,
    appendSessionContext: async () => {},
    llm: { async chat() { throw new Error("unused"); } },
    async llmRequestSender() {
      return {
        message: {
          role: "assistant",
          content: [
            "before",
            "<chat alice='core' type='voice'>",
            "prefix",
            "</chat ignored>"
          ].join("\n")
        },
        finishReason: "stop"
      };
    },
    time: fakeTime(),
    buildTextVariables: emptyPromptRenderer,
    noteSessionUpdated: () => {},
    getLastCompletedToolName: () => undefined,
    setLastCompletedToolName: () => {},
    applyModeStateToNewSession: () => {}
  });

  loop.complete(await runAgentFunctionCallLoop(loop.spec));

  assert.deepEqual(sent, ["core:voice:prefix"]);
});
