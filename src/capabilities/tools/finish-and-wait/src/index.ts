import type { ToolCall, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { finishAndWaitTool, maxYieldWaitSeconds, minYieldWaitSeconds } from "../profile.js";

export function createFinishAndWaitTools(): ToolPlugin {
  return {
    id: "finish-and-wait",
    listTools() {
      return [finishAndWaitTool];
    },
    async execute(call: ToolCall): Promise<ToolResult> {
      if (call.toolName !== finishAndWaitTool.name) {
        return { callId: call.id, ok: false, error: `Unknown finish-and-wait tool: ${call.toolName}` };
      }
      const error = validateYieldInput(call.input);
      if (error) return { callId: call.id, ok: false, error };
      const action = call.input.action as "wait" | "end";
      if (action === "end") {
        return {
          callId: call.id,
          ok: true,
          invalidateLLMSession: true,
          llmSessionClearReason: "yield_end"
        };
      }
      return {
        callId: call.id,
        ok: true,
        meta: {
          yieldReturn: true,
          yieldAction: action,
          yieldSeconds: action === "wait" ? call.input.timer as number : undefined
        }
      };
    }
  };
}

function validateYieldInput(input: Record<string, unknown>): string | undefined {
  const keys = Object.keys(input);
  if (input.action !== "wait" && input.action !== "end") return "Yield action must be wait or end";
  if ( input.action === "end") {
    return keys.length === 1 ? undefined : `Yield ${input.action} only accepts action`;
  }
  if (keys.length === 1 && input.action === "wait") return undefined

  if (keys.length !== 2 || !keys.includes("timer")) return "Yield wait requires only action and timer";
  if (!Number.isInteger(input.timer) || Number(input.timer) < minYieldWaitSeconds || Number(input.timer) > maxYieldWaitSeconds) {
    return `Yield seconds must be an integer from ${minYieldWaitSeconds} to ${maxYieldWaitSeconds}`;
  }
  return undefined;
}
