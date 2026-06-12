import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentLoopRuntime } from "../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import type { AgentEvent } from "../src/contexts/agent-loop/src/contracts/agent-contracts.js";

test("agent loop runtime runs chat requests through configured runner and exposes active main session", async () => {
  const runtime = createAgentLoopRuntime();
  const observedGenerations: number[] = [];
  runtime.setRunners({
    runChat({ sessionId }) {
      const active = runtime.getActiveMainLLMSession();
      assert.equal(active?.id, sessionId);
      assert.equal(active?.agentId, "chat");
      assert.equal(active?.phase, "running");
      observedGenerations.push(active.generation);
      return [{
        id: "out_1",
        target: { plugin: "test", sessionId },
        content: { kind: "text", text: "ok" },
        meta: { createdAt: "2026-06-12T00:00:00.000Z", urgency: "normal" }
      }];
    }
  });

  const result = await runtime.requestRun({
    kind: "chat",
    sessionId: "session-1",
    reason: "test",
    event: textEvent("session-1")
  });

  assert.equal(result.started, true);
  assert.equal(result.outputs.length, 1);
  assert.deepEqual(observedGenerations, [1]);
  assert.equal(runtime.getActiveMainLLMSession()?.phase, "idle");
});

test("agent loop runtime rejects overlapping runs", async () => {
  let releaseRun: (() => void) | undefined;
  const runtime = createAgentLoopRuntime({
    runTalk() {
      return new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
    }
  });

  const first = runtime.requestRun({ kind: "talk", sessionId: "talk-1", reason: "first" });
  assert.equal(runtime.isRunning(), true);
  const second = await runtime.requestRun({ kind: "talk", sessionId: "talk-1", reason: "second" });
  assert.deepEqual(second, { started: false, outputs: [] });
  releaseRun?.();
  assert.deepEqual(await first, { started: true, outputs: [] });
});

test("agent loop runtime executes prepared chat runs before legacy runners", async () => {
  const runtime = createAgentLoopRuntime({
    runChat() {
      throw new Error("legacy chat runner should not be used when prepareChat is available");
    }
  });
  let prepareCalls = 0;
  runtime.setRunners({
    prepareChat({ sessionId }) {
      return {
        prepare() {
          prepareCalls += 1;
          const active = runtime.getActiveMainLLMSession();
          assert.equal(active?.phase, "running");
          assert.equal(active?.id, sessionId);
          return {
            initialMessages: [{ role: "user", content: "hello" }],
            buildRequest({ messages }) {
              return {
                agentId: "chat",
                messages,
                toolNames: []
              };
            },
            async sendRequest() {
              return { message: { role: "assistant", content: "prepared" }, finishReason: "stop" };
            },
            executeTool() {
              throw new Error("unexpected tool call");
            }
          };
        },
        complete(result) {
          assert.equal(result.finalMessage.content, "prepared");
          return [{
            id: "out_prepared",
            target: { plugin: "test", sessionId },
            content: { kind: "text", text: result.finalMessage.content ?? "" },
            meta: { createdAt: "2026-06-12T00:00:00.000Z", urgency: "normal" }
          }];
        }
      };
    }
  });

  const result = await runtime.requestRun({
    kind: "chat",
    sessionId: "session-prepared",
    reason: "test",
    event: textEvent("session-prepared")
  });

  assert.equal(result.started, true);
  assert.equal(prepareCalls, 1);
  assert.equal(result.outputs[0]?.id, "out_prepared");
});

test("agent loop runtime runs function-call specs through the shared tool loop", async () => {
  const runtime = createAgentLoopRuntime();
  const result = await runtime.runFunctionCallLoop({
    initialMessages: [{ role: "user", content: "hello" }],
    buildRequest({ messages }) {
      return {
        agentId: "chat",
        messages,
        toolNames: []
      };
    },
    async sendRequest() {
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    },
    executeTool() {
      throw new Error("unexpected tool call");
    }
  });

  assert.equal(result.stopReason, "completed");
  assert.equal(result.finalMessage.content, "done");
  assert.deepEqual(result.messages, [
    { role: "user", content: "hello", toolCalls: undefined },
    { role: "assistant", content: "done", reasoningContent: undefined }
  ]);
});

test("standalone agent function-call loop is exported for loop adapters", async () => {
  const { runAgentFunctionCallLoop } = await import("../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js");
  const calls: string[] = [];
  const result = await runAgentFunctionCallLoop({
    initialMessages: [{ role: "user", content: "use tool" }],
    buildRequest({ messages }) {
      return {
        agentId: "chat",
        messages,
        toolNames: ["test_tool"]
      };
    },
    async sendRequest({ round }) {
      if (round === 0) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "call_1",
              type: "function",
              function: { name: "test_tool", arguments: "{}" }
            }]
          },
          finishReason: "tool_calls"
        };
      }
      return { message: { role: "assistant", content: "finished" }, finishReason: "stop" };
    },
    executeTool(call) {
      calls.push(call.function.name);
      return {
        message: {
          role: "tool",
          toolCallId: call.id,
          name: call.function.name,
          content: "tool ok"
        }
      };
    }
  });

  assert.deepEqual(calls, ["test_tool"]);
  assert.equal(result.stopReason, "completed");
  assert.equal(result.rounds, 2);
});

function textEvent(sessionId: string): AgentEvent {
  return {
    id: "evt_1",
    type: "message.text",
    source: { plugin: "test", userId: "user-1" },
    session: { scope: "dm", sessionId },
    payload: { kind: "text", text: "hello" },
    meta: { receivedAt: "2026-06-12T00:00:00.000Z" }
  };
}
