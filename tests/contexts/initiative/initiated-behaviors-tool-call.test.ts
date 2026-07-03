import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentInitiatedBehaviorMessages } from "../../../src/contexts/initiative/src/domain/initiated-behavior.js";
import type { ToolCall } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import {
  initiatedBehaviorPlan,
  promptRenderContext,
  visiblePromptProfile,
  writeInitiatedBehaviorProfile
} from "./initiated-behaviors-helpers.js";

test("initiated behavior prompt layers use enabled order", async () => {
  const filePath = writeInitiatedBehaviorProfile("initiated-behavior-order", {
    layers: [
      { id: "second", title: "Second", role: "user", enabled: true, content: "", order: 20 },
      { id: "disabled", title: "Disabled", role: "user", enabled: false, content: "", order: 5 },
      { id: "first", title: "First", role: "system", enabled: true, content: "", order: 10 }
    ]
  });

  const messages = await buildAgentInitiatedBehaviorMessages(
    initiatedBehaviorPlan(filePath),
    visiblePromptProfile(),
    promptRenderContext(),
    async (_layer, call) => {
      throw new Error(`unexpected tool request: ${call.toolName}`);
    }
  );

  assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
});

test("initiated behavior prompt layers execute assistant tool request layers", async () => {
  const filePath = writeInitiatedBehaviorProfile("initiated-behavior-tool", {
    layers: [{
      id: "fake_tool",
      title: "Fake Tool",
      role: "tool_request",
      enabled: true,
      content: "",
      toolCalls: [{
        toolName: "Chat",
        toolCallId: "call_Chat",
        toolArguments: "{\"target\":\"{{user}}\"}"
      }],
      order: 10
    }]
  });
  const toolCalls: ToolCall[] = [];
  const messages = await buildAgentInitiatedBehaviorMessages(
    initiatedBehaviorPlan(filePath),
    visiblePromptProfile(),
    promptRenderContext(),
    async (_layer, call) => {
      toolCalls.push(call);
      return { callId: call.id, ok: true, output: "tool-output" };
    }
  );

  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].id, "call_Chat");
  assert.equal(toolCalls[0].toolName, "Chat");
  assert.deepEqual(toolCalls[0].input, { target: "YY" });
  assert.ok(messages.some((message) => message.role === "tool" && message.toolCallId === "call_Chat" && message.content === "tool-output"));
});

test("initiated behavior prompt layers execute every assistant tool call", async () => {
  const filePath = writeInitiatedBehaviorProfile("initiated-behavior-tools", {
    layers: [{
      id: "fake_tools",
      title: "Fake Tools",
      role: "tool_request",
      enabled: true,
      content: "",
      toolCalls: [
        { toolName: "Chat", toolCallId: "call_one", toolArguments: "{\"target\":\"{{user}}\"}" },
        { toolName: "Chat", toolCallId: "call_two", toolArguments: "{\"query\":\"{{user}}\"}" }
      ],
      order: 10
    }]
  });
  const toolCalls: ToolCall[] = [];
  const messages = await buildAgentInitiatedBehaviorMessages(
    initiatedBehaviorPlan(filePath),
    visiblePromptProfile(),
    promptRenderContext(),
    async (_layer, call) => {
      toolCalls.push(call);
      return { callId: call.id, ok: true, output: "tool-output" };
    }
  );

  assert.deepEqual(toolCalls.map((call) => call.id).sort(), ["call_one", "call_two"]);
  assert.deepEqual(messages.flatMap((message) => message.role === "tool" ? [message.toolCallId] : []).sort(), ["call_one", "call_two"]);
});
