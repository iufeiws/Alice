import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatAgentLoop } from "../../../src/contexts/agent-loop/src/application/run-chat-loop.js";
import { runAgentFunctionCallLoop } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import type { ToolCall, ToolPlugin } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { registerLLMToolLoopTools, type LLMToolLoopContinuation } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import { defaultPromptProfile } from "../../../src/contexts/agent-profile/src/application/build-system-prompt.js";
import { emptyPromptRenderer, fakeTime, textEvent } from "./agent-loop-runtime-helpers.js";

const consecutiveToolReminderContent = "configured consecutive tool reminder";
const silentEndingReminderContent = "configured silent ending reminder";

test("raw assistant content receives one user reminder and is not rewritten as Chat", async () => {
  const seenRequests: Array<Array<{ role: string; content?: unknown }>> = [];
  const calls: ToolCall[] = [];
  const loop = createReminderLoop({
    tools: reminderTools(calls),
    async respond(round, messages) {
      seenRequests.push(messages);
      return { message: { role: "assistant", content: round === 0 ? "raw first" : "raw second" } };
    }
  });

  const result = await runAgentFunctionCallLoop(loop.spec);

  assert.equal(result.stopReason, "completed");
  assert.equal(calls.length, 0);
  assert.equal(seenRequests.length, 2);
  assert.deepEqual(seenRequests[1].slice(-2).map(({ role, content }) => ({ role, content })), [
    { role: "assistant", content: "raw first" },
    { role: "user", content: silentEndingReminderContent }
  ]);
  assert.equal(result.messages.filter((message) => message.content === silentEndingReminderContent).length, 1);
});

test("empty assistant response without tool calls receives the reminder once", async () => {
  let requests = 0;
  const loop = createReminderLoop({
    tools: reminderTools([]),
    async respond() {
      requests += 1;
      return { message: { role: "assistant", content: "" } };
    }
  });

  const result = await runAgentFunctionCallLoop(loop.spec);

  assert.equal(requests, 2);
  assert.equal(result.messages.filter((message) => message.content === silentEndingReminderContent).length, 1);
});

test("six consecutive non-sending tools append the reminder after the complete tool batch", async () => {
  const seenRequests: Array<Array<{ role: string; content?: unknown }>> = [];
  const calls: ToolCall[] = [];
  const loop = createReminderLoop({
    tools: reminderTools(calls),
    async respond(round, messages) {
      seenRequests.push(messages);
      if (round < 6) return toolCallResult(`work_${round}`, "Work", { round });
      return { message: { role: "assistant", content: "silent ending" } };
    }
  });

  const result = await runAgentFunctionCallLoop(loop.spec);

  assert.equal(result.stopReason, "completed");
  assert.equal(calls.filter((call) => call.toolName === "Work").length, 6);
  assert.equal(seenRequests[5].some((message) => message.content === consecutiveToolReminderContent), false);
  assert.equal(seenRequests[6].at(-1)?.content, consecutiveToolReminderContent);
  assert.equal(result.messages.filter((message) => message.content === consecutiveToolReminderContent).length, 1);
});

test("threshold reminder follows every tool result in a multi-call assistant response", async () => {
  const seenRequests: Array<Array<{ role: string; content?: unknown; name?: string }>> = [];
  const calls: ToolCall[] = [];
  const loop = createReminderLoop({
    tools: reminderTools(calls),
    async respond(round, messages) {
      seenRequests.push(messages);
      if (round > 0) return { message: { role: "assistant", content: "done" } };
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: Array.from({ length: 6 }, (_, index) => ({
            id: `batch_${index}`,
            type: "function",
            function: { name: "Work", arguments: JSON.stringify({ index }) }
          }))
        }
      };
    }
  });

  await runAgentFunctionCallLoop(loop.spec);

  const followup = seenRequests[1];
  assert.deepEqual(followup.slice(-7).map((message) => message.role), [
    "tool", "tool", "tool", "tool", "tool", "tool", "user"
  ]);
  assert.equal(followup.at(-1)?.content, consecutiveToolReminderContent);
});

test("consecutive-tool reminder can be followed by one silent-ending reminder", async () => {
  const loop = createReminderLoop({
    tools: reminderTools([]),
    async respond(round) {
      if (round < 6) return toolCallResult(`work_${round}`, "Work", { round });
      return { message: { role: "assistant", content: "still silent" } };
    }
  });

  const result = await runAgentFunctionCallLoop(loop.spec);
  const reminderMessages = result.messages.filter((message) =>
    message.content === consecutiveToolReminderContent || message.content === silentEndingReminderContent
  );

  assert.deepEqual(reminderMessages.map((message) => message.content), [
    consecutiveToolReminderContent,
    silentEndingReminderContent
  ]);
});

test("successful sending-class tool call suppresses the reminder regardless of action", async () => {
  const seenRequests: Array<Array<{ role: string; content?: unknown }>> = [];
  const calls: ToolCall[] = [];
  const loop = createReminderLoop({
    tools: reminderTools(calls),
    async respond(round, messages) {
      seenRequests.push(messages);
      return round === 0
        ? toolCallResult("chat_poll", "Chat", { action: "poll" })
        : { message: { role: "assistant", content: "raw ending" } };
    }
  });

  const result = await runAgentFunctionCallLoop(loop.spec);

  assert.equal(result.stopReason, "completed");
  assert.equal(calls[0]?.input.action, "poll");
  assert.equal(seenRequests.length, 2);
  assert.equal(result.messages.some((message) =>
    message.content === consecutiveToolReminderContent || message.content === silentEndingReminderContent
  ), false);
});

test("failed sending-class tool call does not suppress the reminder", async () => {
  const loop = createReminderLoop({
    tools: reminderTools([], { failChat: true }),
    async respond(round) {
      return round === 0
        ? toolCallResult("chat_failed", "Chat", { action: "message" })
        : { message: { role: "assistant", content: "raw ending" } };
    }
  });

  const result = await runAgentFunctionCallLoop(loop.spec);

  assert.equal(result.messages.filter((message) => message.content === silentEndingReminderContent).length, 1);
});

test("restored continuation state keeps the reminder deduplicated", async () => {
  const continuation = continuationWithReminderInjected();
  const loop = createReminderLoop({
    tools: reminderTools([]),
    continuation,
    async respond() {
      return { message: { role: "assistant", content: "raw ending" } };
    }
  });

  const result = await runAgentFunctionCallLoop(loop.spec);

  assert.equal(result.messages.some((message) =>
    message.content === consecutiveToolReminderContent || message.content === silentEndingReminderContent
  ), false);
});

for (const action of ["finish", "await_chat"] as const) {
  test(`Yield ${action} is deferred once for the user reminder`, async () => {
    const seenRequests: Array<Array<{ role: string; content?: unknown }>> = [];
    const calls: ToolCall[] = [];
    const loop = createReminderLoop({
      tools: reminderTools(calls),
      async respond(round, messages) {
        seenRequests.push(messages);
        return round === 0
          ? toolCallResult(`yield_${action}`, "Yield", { action })
          : { message: { role: "assistant", content: "still silent" } };
      }
    });

    const result = await runAgentFunctionCallLoop(loop.spec);

    assert.equal(result.stopReason, "completed");
    assert.equal(result.invalidateSession, false);
    assert.equal(seenRequests.length, 2);
    assert.equal(seenRequests[1].at(-1)?.content, silentEndingReminderContent);
    assert.equal(result.messages.filter((message) => message.content === silentEndingReminderContent).length, 1);
  });
}

function createReminderLoop(input: {
  tools: ToolPlugin[];
  respond(round: number, messages: Array<{ role: string; content?: unknown }>): Promise<any>;
  continuation?: LLMToolLoopContinuation;
}) {
  registerLLMToolLoopTools("default", input.tools);
  const session = {
    messages: [{ role: "user" as const, content: "start" }],
    requestTimestamps: [],
    mode: "normal"
  };
  return buildChatAgentLoop({
    llmInput: {
      messages: session.messages,
      toolNames: input.tools.flatMap((plugin) => plugin.listTools().map((tool) => tool.name))
    },
    event: textEvent("message-delivery-reminder"),
    session,
    ensureSession: async () => session,
    appendSessionContext: async () => {},
    llm: { async chat() { throw new Error("unused"); } },
    llmRequestSender: ({ round, messages }) => input.respond(round, messages),
    time: fakeTime(),
    buildTextVariables: emptyPromptRenderer,
    noteSessionUpdated: () => {},
    getLastCompletedToolName: () => undefined,
    setLastCompletedToolName: () => {},
    applyModeStateToNewSession: () => {},
    promptProfile: {
      ...defaultPromptProfile(),
      consecutiveToolReminderLayer: {
        meta: {},
        messages: [{
          meta: { title: "Consecutive Tool Reminder", enabled: true },
          role: "user",
          content: consecutiveToolReminderContent
        }]
      },
      silentEndingReminderLayer: {
        meta: {},
        messages: [{
          meta: { title: "Silent Ending Reminder", enabled: true },
          role: "user",
          content: silentEndingReminderContent
        }]
      }
    },
    processRestartContinuation: input.continuation
      ? { snapshot: input.continuation, interruptedToolResult: { callId: "restored", ok: true, output: "ok" } }
      : undefined
  });
}

function reminderTools(calls: ToolCall[], options: { failChat?: boolean } = {}): ToolPlugin[] {
  return [{
    id: "reminder-tools",
    listTools() {
      return [
        { name: "Chat", description: "chat", inputSchema: {}, sendsMessage: true },
        { name: "Work", description: "work", inputSchema: {} },
        { name: "Yield", description: "yield", inputSchema: {} }
      ];
    },
    async execute(call) {
      calls.push(call);
      if (call.toolName === "Chat" && options.failChat) {
        return { callId: call.id, ok: false, error: "send failed" };
      }
      if (call.toolName === "Yield" && call.input.action === "finish") {
        return { callId: call.id, ok: true, invalidateLLMSession: true, llmSessionClearReason: "yield_end" };
      }
      if (call.toolName === "Yield" && call.input.action === "await_chat") {
        return {
          callId: call.id,
          ok: true,
          meta: { yieldReturn: true, yieldAction: "await_chat", yieldSeconds: 900 }
        };
      }
      return { callId: call.id, ok: true, output: "ok" };
    }
  }];
}

function continuationWithReminderInjected(): LLMToolLoopContinuation {
  const restoredCall = {
    id: "restored",
    type: "function" as const,
    function: { name: "Work", arguments: "{}" }
  };
  return {
    version: 1,
    messages: [{ role: "user", content: "start" }],
    round: 0,
    replyRound: 0,
    totalToolCallCount: 1,
    replyToolCallCount: 1,
    invalidateSession: false,
    result: { message: { role: "assistant", content: "", toolCalls: [restoredCall] }, finishReason: "tool_calls" },
    completeAfterToolCalls: false,
    interruptedCallIndex: 0,
    executedCalls: [restoredCall],
    toolMessages: [],
    reachedToolCallLimit: false,
    resetSession: false,
    continueAfterReset: false,
    yieldReturn: false,
    extensionState: {
      messageDeliveryReminder: {
        successfulSendSeen: false,
        consecutiveNonSendingToolCalls: 1,
        consecutiveToolReminderInjected: true,
        consecutiveToolReminderPending: false,
        silentEndingReminderInjected: true,
        silentEndingReminderPending: false
      }
    }
  };
}

function toolCallResult(id: string, name: string, args: Record<string, unknown> = {}) {
  return {
    message: {
      role: "assistant" as const,
      content: "",
      toolCalls: [{
        id,
        type: "function" as const,
        function: { name, arguments: JSON.stringify(args) }
      }]
    },
    finishReason: "tool_calls"
  };
}
