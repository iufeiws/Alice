import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentLoopRuntime, runAgentFunctionCallLoop } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import { registerLLMToolLoopTools } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import { textEvent } from "./agent-loop-runtime-helpers.js";

test("agent loop runtime runs chat requests through configured runner and exposes active main session", async () => {
  const runtime = createAgentLoopRuntime();
  const observedRunSeqs: number[] = [];
  runtime.setRunners({
    prepareChat({ sessionId }) {
      const active = runtime.getActiveMainLLMSession();
      assert.equal(active?.id, sessionId);
      assert.equal(active?.agentId, "chat");
      assert.equal(active?.phase, "running");
      observedRunSeqs.push(active.agentLoopRunSeq);
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
  assert.deepEqual(observedRunSeqs, [1]);
  assert.equal(runtime.getActiveMainLLMSession()?.phase, "idle");
});

test("agent loop runtime rejects overlapping runs", async () => {
  let releaseRun: (() => void) | undefined;
  const runtime = createAgentLoopRuntime({
    prepareTalk() {
      return new Promise((resolve) => {
        releaseRun = () => resolve({
          prepare: () => [],
          complete: () => []
        });
      });
    }
  });

  const first = runtime.requestRun({ kind: "talk", sessionId: 1780830000101, reason: "first" });
  assert.equal(runtime.isRunning(), true);
  const second = await runtime.requestRun({ kind: "talk", sessionId: 1780830000101, reason: "second" });
  assert.deepEqual(second, { started: false, outputs: [] });
  releaseRun?.();
  assert.deepEqual(await first, { started: true, outputs: [] });
});

test("agent loop runtime tracks pending user message interrupt for active chat session only", async () => {
  let releaseRun: (() => void) | undefined;
  let startedRun: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedRun = resolve;
  });
  let runs = 0;
  const runtime = createAgentLoopRuntime({
    prepareChat() {
      runs += 1;
      if (runs > 1) {
        return {
          prepare: () => [],
          complete: () => []
        };
      }
      startedRun?.();
      return new Promise((resolve) => {
        releaseRun = () => resolve({
          prepare: () => [],
          complete: () => []
        });
      });
    }
  });

  const run = runtime.requestRun({
    kind: "chat",
    sessionId: "session-1",
    reason: "test",
    event: textEvent("session-1")
  });
  await started;

  runtime.noteInboundUserMessageInterrupt("other-session");
  assert.equal(runtime.consumePendingUserMessageInterrupt("session-1"), false);
  runtime.noteInboundUserMessageInterrupt("session-1");
  assert.equal(runtime.consumePendingUserMessageInterrupt("session-1"), true);
  assert.equal(runtime.consumePendingUserMessageInterrupt("session-1"), false);

  releaseRun?.();
  await run;
  runtime.noteInboundUserMessageInterrupt("session-1");
  assert.equal(runtime.consumePendingUserMessageInterrupt("session-1"), false);
});

test("agent loop runtime drops unconsumed user message interrupt when chat run exits", async () => {
  let releaseRun: (() => void) | undefined;
  let startedRun: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedRun = resolve;
  });
  let runs = 0;
  const runtime = createAgentLoopRuntime({
    prepareChat() {
      runs += 1;
      if (runs > 1) {
        return {
          prepare: () => [],
          complete: () => []
        };
      }
      startedRun?.();
      return new Promise((resolve) => {
        releaseRun = () => resolve({
          prepare: () => [],
          complete: () => []
        });
      });
    }
  });

  const first = runtime.requestRun({
    kind: "chat",
    sessionId: "session-1",
    reason: "test",
    event: textEvent("session-1")
  });
  await started;
  runtime.noteInboundUserMessageInterrupt("session-1");
  releaseRun?.();
  await first;

  assert.equal(runtime.consumePendingUserMessageInterrupt("session-1"), false);
  const second = await runtime.requestRun({
    kind: "chat",
    sessionId: "session-1",
    reason: "next",
    event: textEvent("session-1")
  });
  assert.equal(second.started, true);
  assert.equal(runtime.consumePendingUserMessageInterrupt("session-1"), false);
});

test("agent loop runtime executes prepared chat runs through the function-call loop", async () => {
  const runtime = createAgentLoopRuntime();
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

test("standalone agent function-call loop writes tool result back into the next request", async () => {
  const requests: unknown[][] = [];
  registerLLMToolLoopTools("agent-loop-runtime-test", [{
    id: "test",
    listTools: () => [{ name: "test_tool", description: "test", inputSchema: { type: "object" } }],
    async execute(call) {
      return { callId: call.id, ok: true, output: "tool ok" };
    }
  }]);
  const result = await runAgentFunctionCallLoop({
    initialMessages: [{ role: "user", content: "use tool" }],
    buildRequest({ messages }) {
      requests.push(messages);
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
              function: { name: "test_tool", arguments: "{\"action\":\"poll\"}" }
            }]
          },
          finishReason: "tool_calls"
        };
      }
      return { message: { role: "assistant", content: "finished" }, finishReason: "stop" };
    },
    toolRegistryName: "agent-loop-runtime-test"
  });

  assert.equal(result.stopReason, "completed");
  assert.equal(result.rounds, 2);
  assert.equal((requests[1].at(-1) as { role?: string; toolCallId?: string; content?: string }).role, "tool");
  assert.equal((requests[1].at(-1) as { role?: string; toolCallId?: string; content?: string }).toolCallId, "call_1");
  assert.equal((requests[1].at(-1) as { role?: string; toolCallId?: string; content?: string }).content, "tool ok");
});
