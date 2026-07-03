import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatAgentLoop } from "../../../src/contexts/agent-loop/src/application/run-chat-loop.js";
import { runAgentFunctionCallLoop } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import type { AgentRunIndicator, AgentRunIndicatorSession } from "../../../src/contexts/agent-run-indicator/src/index.js";
import { demoToolPlugin, loopInput } from "./agent-run-indicator-helpers.js";

test("chat loop behaves unchanged when no agent run indicator is configured", async () => {
  const sentRequests: string[] = [];
  const loop = buildChatAgentLoop(loopInput({
    llmRequestSender: async (request) => {
      sentRequests.push(request.agentId);
      return { message: { role: "assistant", content: "ok" } };
    }
  }));

  const result = await runAgentFunctionCallLoop(loop.spec);

  assert.equal(result.finalMessage.content, "ok");
  assert.deepEqual(sentRequests, ["chat"]);
});

test("chat loop forwards stream deltas to indicator and preserves existing stream handler", async () => {
  const calls: string[] = [];
  const indicator: AgentRunIndicator = {
    async begin(input) {
      calls.push(`begin:${input.agentId}:${input.round}`);
      return {
        async appendReasoningDelta(delta) {
          calls.push(`reasoning:${delta}`);
        },
        async appendContentDelta(delta) {
          calls.push(`indicator:${delta}`);
        },
        async appendToolCall(input) {
          calls.push(`tool:${JSON.stringify(input)}`);
        },
        async finish() {
          calls.push("finish");
        },
        async fail(error) {
          calls.push(`fail:${error instanceof Error ? error.message : String(error)}`);
        }
      };
    }
  };
  const loop = buildChatAgentLoop(loopInput({
    agentRunIndicator: indicator,
    llmInput: {
      streamHandlers: {
        onContentDelta(delta) {
          calls.push(`existing:${delta}`);
        }
      }
    },
    llmRequestSender: async (request) => {
      await request.streamHandlers?.onReasoningDelta?.("think");
      await request.streamHandlers?.onContentDelta?.("he");
      await request.streamHandlers?.onContentDelta?.("llo");
      return { message: { role: "assistant", content: "hello" } };
    }
  }));

  const result = await runAgentFunctionCallLoop(loop.spec);

  assert.equal(result.finalMessage.content, "hello");
  assert.equal(calls[0], "begin:chat:0");
  assert.deepEqual(calls.filter((call) => call.startsWith("existing:")), ["existing:he", "existing:llo"]);
  assert.deepEqual(calls.filter((call) => call.startsWith("indicator:")), ["indicator:he", "indicator:llo"]);
  assert.ok(calls.includes("reasoning:think"));
  assert.ok(calls.includes("finish"));
});

test("chat loop forwards tool call argument values to indicator without dedupe", async () => {
  const toolPayloads: string[] = [];
  const indicator: AgentRunIndicator = {
    async begin() {
      return {
        async appendReasoningDelta() {},
        async appendContentDelta() {},
        async appendToolCall(input) {
          toolPayloads.push(JSON.stringify(input));
        },
        async finish() {},
        async fail() {}
      };
    }
  };
  let requestCount = 0;
  const loop = buildChatAgentLoop(loopInput({
    agentRunIndicator: indicator,
    toolPlugins: [demoToolPlugin()],
    llmInput: { toolNames: ["Demo"] },
    llmRequestSender: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "call_1", type: "function", function: { name: "Demo", arguments: "{\"short\":\"abc\",\"long\":\"123456789\",\"n\":7}" } },
              { id: "call_2", type: "function", function: { name: "Demo", arguments: "{\"short\":\"abc\"}" } }
            ]
          }
        };
      }
      return { message: { role: "assistant", content: "done" } };
    }
  }));

  const result = await runAgentFunctionCallLoop(loop.spec);

  assert.equal(result.finalMessage.content, "done");
  assert.deepEqual(toolPayloads, [
    "{\"short\":\"abc\",\"long\":\"123456789\",\"n\":7}",
    "{\"short\":\"abc\"}"
  ]);
});

test("chat loop disables current indicator session after indicator delta failure", async () => {
  const errors: string[] = [];
  const calls: string[] = [];
  const session: AgentRunIndicatorSession = {
    async appendReasoningDelta(delta) {
      calls.push(`reasoning:${delta}`);
    },
    async appendContentDelta(delta) {
      calls.push(`delta:${delta}`);
      throw new Error("indicator_down");
    },
    async appendToolCall() {},
    async finish() {
      calls.push("finish");
    },
    async fail(error) {
      calls.push(`fail:${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const loop = buildChatAgentLoop(loopInput({
    agentRunIndicator: {
      async begin() {
        return session;
      }
    },
    onAgentRunIndicatorError(error) {
      errors.push(error instanceof Error ? error.message : String(error));
    },
    llmRequestSender: async (request) => {
      await request.streamHandlers?.onContentDelta?.("a");
      await request.streamHandlers?.onContentDelta?.("b");
      return { message: { role: "assistant", content: "ab" } };
    }
  }));

  await runAgentFunctionCallLoop(loop.spec);

  assert.deepEqual(calls, ["delta:a", "fail:indicator_down"]);
  assert.deepEqual(errors, ["indicator_down"]);
});
