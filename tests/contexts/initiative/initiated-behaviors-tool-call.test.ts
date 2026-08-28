import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentInitiatedBehaviorMessages } from "../../../src/contexts/initiative/src/domain/initiated-behavior.js";
import type { ToolCall } from "../../../src/contexts/tool-execution/src/index.js";
import {
  initiatedBehaviorPlan,
  promptRenderContext,
  visiblePromptProfile,
  writeInitiatedBehaviorProfile
} from "./initiated-behaviors-helpers.js";

test("initiated behavior messages use array order and meta enabled", async () => {
  const filePath = writeInitiatedBehaviorProfile("initiated-behavior-order", {
    meta: {},
    messages: [
      { meta: { title: "First", enabled: true }, role: "system", content: "" },
      { meta: { title: "Disabled", enabled: false }, role: "user", content: "" },
      { meta: { title: "Second", enabled: true }, role: "user", content: "" }
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

test("initiated behavior assistant messages execute tool calls", async () => {
  const filePath = writeInitiatedBehaviorProfile("initiated-behavior-tool", {
    meta: {},
    messages: [{
      meta: { title: "Fake Tool", enabled: true },
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call_Chat",
        type: "function",
        function: { name: "Chat", arguments: "{\"target\":\"${{user}}\"}" }
      }]
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
    meta: {},
    messages: [{
      meta: { title: "Fake Tools", enabled: true },
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call_one", type: "function", function: { name: "Chat", arguments: "{\"target\":\"${{user}}\"}" } },
        { id: "call_two", type: "function", function: { name: "Chat", arguments: "{\"query\":\"${{user}}\"}" } }
      ]
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
