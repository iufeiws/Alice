import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentLoopRuntime, runAgentFunctionCallLoop } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import { registerLLMToolLoopTools } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import { emptyPromptRenderer, textEvent } from "./agent-loop-runtime-helpers.js";

test("agent loop runtime returns chat outputs from the configured runner", async () => {
  const runtime = createAgentLoopRuntime();
  runtime.setRunners({
    prepareChat({ sessionId }) {
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
});

test("agent loop runtime exposes active main session during a chat run", async () => {
  const runtime = createAgentLoopRuntime();
  const observedRunSeqs: number[] = [];
  runtime.setRunners({
    prepareChat({ sessionId }) {
      const active = runtime.getActiveMainLLMSession();
      assert.equal(active?.id, sessionId);
      assert.equal(active?.agentId, "chat");
      assert.equal(active?.phase, "running");
      observedRunSeqs.push(active.agentLoopRunSeq);
      return [];
    }
  });

  const result = await runtime.requestRun({
    kind: "chat",
    sessionId: "session-1",
    reason: "test",
    event: textEvent("session-1")
  });

  assert.equal(result.started, true);
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

test("agent loop runtime appends pending interrupt after completed tool result batch", async () => {
  const runtime = createAgentLoopRuntime();
  const requests: any[][] = [];
  let releaseTool: (() => void) | undefined;
  let markToolStarted: (() => void) | undefined;
  const toolStarted = new Promise<void>((resolve) => {
    markToolStarted = resolve;
  });
  const toolReleased = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  registerLLMToolLoopTools("agent-loop-runtime-interrupt", [{
    id: "interrupt-test",
    listTools: () => [{ name: "test_tool", description: "test", inputSchema: { type: "object" } }],
    async execute(call) {
      markToolStarted?.();
      await toolReleased;
      return { callId: call.id, ok: true, output: "tool ok" };
    }
  }]);
  runtime.setRunners({
    prepareChat() {
      return {
        prepare() {
          return interruptTestSpec(requests, "agent-loop-runtime-interrupt", false);
        },
        complete: () => []
      };
    }
  });

  const run = runtime.requestRun({
    kind: "chat",
    sessionId: "session-1",
    reason: "test",
    event: textEvent("session-1")
  });
  await toolStarted;
  runtime.noteInboundUserMessageInterrupt("other-session");
  runtime.noteInboundUserMessageInterrupt("session-1");
  releaseTool?.();
  const result = await run;

  assert.equal(result.started, true);
  assert.equal(requests[1].at(-2).role, "tool");
  assert.equal(requests[1].at(-2).toolCallId, "call_1");
  assert.equal(requests[1].at(-1).role, "user");
});

test("pending inbound starts a fresh function-call loop budget after a single output", async () => {
  const runtime = createAgentLoopRuntime();
  const requests: any[][] = [];
  registerLLMToolLoopTools("agent-loop-runtime-interrupt-budget", [{
    id: "interrupt-budget-test",
    listTools: () => [{ name: "test_tool", description: "test", inputSchema: { type: "object" } }],
    async execute(call) {
      if (call.id === "call_2") runtime.noteInboundUserMessageInterrupt("session-budget");
      return { callId: call.id, ok: true, output: "tool ok" };
    }
  }]);
  runtime.setRunners({
    prepareChat() {
      return {
        prepare() {
          return {
            ...interruptTestSpec(requests, "agent-loop-runtime-interrupt-budget", false),
            limits: { maxRounds: 2, maxTotalToolCalls: 2 },
            transformAssistantMessage({ message }: { message: any }) {
              return {
                message,
                completeAfterToolCalls: message.toolCalls?.[0]?.id === "call_2"
              };
            },
            async sendRequest({ round }: { round: number }) {
              if (round < 3) {
                return {
                  message: {
                    role: "assistant" as const,
                    content: "",
                    toolCalls: [{
                      id: `call_${round + 1}`,
                      type: "function" as const,
                      function: { name: "test_tool", arguments: `{\"round\":${round}}` }
                    }]
                  },
                  finishReason: "tool_calls"
                };
              }
              return { message: { role: "assistant" as const, content: "finished" }, finishReason: "stop" };
            }
          };
        },
        complete: () => []
      };
    }
  });

  await runtime.requestRun({
    kind: "chat",
    sessionId: "session-budget",
    reason: "test",
    event: textEvent("session-budget")
  });

  assert.equal(requests.length, 4);
  assert.equal(requests[2].at(-1).role, "user");
  assert.equal(requests[2].at(-1).name, "Alert");
});

test("agent loop runtime resumes yield directly when a user message arrives during yield", async () => {
  const runtime = createAgentLoopRuntime();
  const requests: any[][] = [];
  let loopStopReason: string | undefined;
  let resumeCalls = 0;
  registerLLMToolLoopTools("agent-loop-runtime-yield-interrupt", [{
    id: "yield-test",
    listTools: () => [{ name: "Yield", description: "wait", inputSchema: { type: "object" } }],
    async execute(call) {
      runtime.noteInboundUserMessageInterrupt("session-yield");
      return { callId: call.id, ok: true, output: "yield", meta: { yieldReturn: true } };
    }
  }]);
  runtime.setRunners({
    prepareChat() {
      return {
        prepare() {
          return {
            ...interruptTestSpec(requests, "agent-loop-runtime-yield-interrupt", true),
            buildYieldResumeMessages() {
              resumeCalls += 1;
              return [{ role: "tool" as const, name: "Yield", toolCallId: "call_1", content: "resume" }];
            }
          };
        },
        complete(result) {
          loopStopReason = result.stopReason;
          return [];
        }
      };
    }
  });

  const result = await runtime.requestRun({
    kind: "chat",
    sessionId: "session-yield",
    reason: "test",
    event: textEvent("session-yield")
  });

  assert.equal(result.started, true);
  assert.equal(loopStopReason, "completed");
  assert.equal(resumeCalls, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].at(-1).role, "tool");
  assert.equal(requests[1].at(-1).toolCallId, "call_1");
  assert.equal(requests[1].some((message) => message.role === "user" && message.name === "Alert"), false);
});

test("pending inbound starts a fresh function-call loop budget after Yield", async () => {
  const runtime = createAgentLoopRuntime();
  const requests: any[][] = [];
  registerLLMToolLoopTools("agent-loop-runtime-yield-budget", [{
    id: "yield-budget-test",
    listTools: () => [{ name: "Yield", description: "wait", inputSchema: { type: "object" } }],
    async execute(call) {
      runtime.noteInboundUserMessageInterrupt("session-yield-budget");
      return { callId: call.id, ok: true, output: "yield", meta: { yieldReturn: true } };
    }
  }]);
  runtime.setRunners({
    prepareChat() {
      return {
        prepare() {
          return {
            ...interruptTestSpec(requests, "agent-loop-runtime-yield-budget", true),
            limits: { maxRounds: 1, maxTotalToolCalls: 1 },
            buildYieldResumeMessages() {
              return [{ role: "tool" as const, name: "Yield", toolCallId: "call_1", content: "resume" }];
            }
          };
        },
        complete: () => []
      };
    }
  });

  await runtime.requestRun({
    kind: "chat",
    sessionId: "session-yield-budget",
    reason: "test",
    event: textEvent("session-yield-budget")
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].at(-1).role, "tool");
  assert.equal(requests[1].at(-1).name, "Yield");
  assert.equal(requests[1].some((message) => message.role === "user" && message.name === "Alert"), false);
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
        toolNames: ["test_tool"],
        toolVariables: emptyPromptRenderer()
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

function interruptTestSpec(requests: any[][], toolRegistryName: string, yieldReturn: boolean) {
  return {
    initialMessages: [{ role: "user" as const, content: "use tool" }],
    promptProfile: {
      visibleTools: { feishu: true },
      layers: { meta: {}, messages: [] },
      interruptLayer: {
        meta: {},
        messages: [{
          meta: { title: "Interrupt Layer", enabled: true },
          role: "user" as const,
          name: "Alert",
          content: "<Alert info=\"have a new message\" />"
        }]
      }
    },
    buildRequest({ messages }: { messages: any[] }) {
      requests.push(messages);
      return {
        agentId: "chat",
        messages,
        toolNames: [yieldReturn ? "Yield" : "test_tool"],
        toolVariables: emptyPromptRenderer()
      };
    },
    async sendRequest({ round }: { round: number }) {
      if (round === 0) {
        return {
          message: {
            role: "assistant" as const,
            content: "",
            toolCalls: [{
              id: "call_1",
              type: "function" as const,
              function: { name: yieldReturn ? "Yield" : "test_tool", arguments: yieldReturn ? "{\"action\":\"poll\"}" : "{}" }
            }]
          },
          finishReason: "tool_calls"
        };
      }
      return { message: { role: "assistant" as const, content: "finished" }, finishReason: "stop" };
    },
    toolRegistryName
  };
}
