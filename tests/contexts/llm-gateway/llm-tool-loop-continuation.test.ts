import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerLLMToolLoopTools,
  runLLMToolLoop,
  type LLMToolLoopContinuation
} from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";

test("LLM tool loop resumes a multi-tool response after a process restart without repeating completed tools", async () => {
  const executions: string[] = [];
  let captured: LLMToolLoopContinuation | undefined;
  let checkpointReady: (() => void) | undefined;
  const checkpoint = new Promise<void>((resolve) => {
    checkpointReady = resolve;
  });
  registerLLMToolLoopTools("continuation-test", [{
    id: "continuation-test",
    listTools: () => ["Before", "Restart", "After"].map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
    async execute(call, context) {
      executions.push(call.toolName);
      if (call.toolName === "Restart") {
        await context?.prepareProcessRestart?.();
        return await new Promise(() => {});
      }
      return { callId: call.id, ok: true, output: `${call.toolName} done` };
    }
  }]);

  void runLLMToolLoop({
    initialMessages: [{ role: "user", content: "deploy" }],
    buildRequest({ messages }) {
      return { agentId: "chat", messages, toolNames: [], toolVariables: testPromptRuntime() };
    },
    async sendRequest() {
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: ["Before", "Restart", "After"].map((name, index) => ({
            id: `call_${index}`,
            type: "function" as const,
            function: { name, arguments: "{}" }
          }))
        }
      };
    },
    toolRegistryName: "continuation-test",
    async onProcessRestartCheckpoint(value) {
      captured = value;
      checkpointReady?.();
    }
  });

  await checkpoint;
  assert.deepEqual(executions, ["Before", "Restart"]);
  assert.equal(captured?.interruptedCallIndex, 1);

  let followupMessages: unknown;
  const progress: LLMToolLoopContinuation[] = [];
  const resumed = await runLLMToolLoop({
    initialMessages: [],
    continuation: {
      snapshot: captured!,
      interruptedToolResult: {
        callId: "call_1",
        ok: true,
        output: "服务已重启，代码更新已加载"
      }
    },
    onProcessRestartProgress(value) {
      progress.push(value);
    },
    buildRequest({ messages }) {
      return { agentId: "chat", messages, toolNames: [], toolVariables: testPromptRuntime() };
    },
    async sendRequest(input) {
      followupMessages = input.messages;
      return { message: { role: "assistant", content: "restart observed" } };
    },
    toolRegistryName: "continuation-test"
  });

  assert.deepEqual(executions, ["Before", "Restart", "After"]);
  assert.equal(resumed.finalMessage.content, "restart observed");
  assert.deepEqual(progress.map((entry) => entry.interruptedCallIndex), [2, 3]);
  assert.deepEqual((followupMessages as Array<{ role: string; toolCallId?: string }>).filter((message) => message.role === "tool").map((message) => message.toolCallId), [
    "call_0",
    "call_1",
    "call_2"
  ]);

  executions.length = 0;
  await runLLMToolLoop({
    initialMessages: [],
    continuation: { snapshot: progress[0] },
    buildRequest({ messages }) {
      return { agentId: "chat", messages, toolNames: [], toolVariables: testPromptRuntime() };
    },
    async sendRequest() {
      return { message: { role: "assistant", content: "continued again" } };
    },
    toolRegistryName: "continuation-test"
  });

  assert.deepEqual(executions, ["After"]);
});
