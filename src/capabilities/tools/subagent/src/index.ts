import type { ToolCall, ToolDefinition, ToolExecutionContext, ToolPlugin } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { PiSandboxRuntime, PiSession } from "../../../../contexts/pi-sandbox/src/index.js";

export type SubAgentInput =
  | { action: "start"; task: string; timeout?: number }
  | { action: "status"; taskId: string; cursor?: string }
  | { action: "cancel"; taskId: string };

export function createSubAgentTool(input: { runtime: PiSandboxRuntime; agentState?: { acquirePiSubAgentHold(): unknown; releasePiSubAgentHold(): unknown } }): ToolPlugin {
  const activeTasks = new Set<string>();
  input.runtime.onTerminal((session) => {
    if (!activeTasks.delete(session.sessionId)) return;
    input.agentState?.releasePiSubAgentHold();
  });
  return {
    id: "subagent",
    listTools(): ToolDefinition[] {
      return [{
        name: "SubAgent",
        description: "Start, inspect, or cancel a persistent sandbox Pi agent session.",
        inputSchema: {
          type: "object",
          oneOf: [
            { properties: { action: { const: "start" }, task: { type: "string", minLength: 1 }, timeout: { type: "number", minimum: 1 } }, required: ["action", "task"], additionalProperties: false },
            { properties: { action: { const: "status" }, taskId: { type: "string", minLength: 1 }, cursor: { type: "string" } }, required: ["action", "taskId"], additionalProperties: false },
            { properties: { action: { const: "cancel" }, taskId: { type: "string", minLength: 1 } }, required: ["action", "taskId"], additionalProperties: false }
          ]
        }
      }];
    },
    async execute(call, context) {
      const value = parseInput(call);
      if (value.action === "start") {
        const task = await input.runtime.startSubAgent({ task: value.task, timeoutSeconds: value.timeout, requester: call.requester, notificationTarget: call.externalSession, signal: context?.signal });
        activeTasks.add(task.sessionId);
        input.agentState?.acquirePiSubAgentHold();
        return { callId: call.id, ok: true, output: task };
      }
      if (value.action === "status") return { callId: call.id, ok: true, output: await input.runtime.statusSubAgent(value.taskId, value.cursor, context?.signal) };
      return { callId: call.id, ok: true, output: await input.runtime.cancelSubAgent(value.taskId, context?.signal) };
    }
  };
}

function parseInput(call: ToolCall): SubAgentInput {
  const input = call.input as Record<string, unknown>;
  const action = input.action;
  if (action === "start" && typeof input.task === "string" && input.task.trim()) {
    return { action, task: input.task, ...(typeof input.timeout === "number" ? { timeout: input.timeout } : {}) };
  }
  if (action === "status" && typeof input.taskId === "string" && input.taskId.trim()) {
    return { action, taskId: input.taskId, ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}) };
  }
  if (action === "cancel" && typeof input.taskId === "string" && input.taskId.trim()) return { action, taskId: input.taskId };
  throw new Error("invalid_subagent_input");
}
