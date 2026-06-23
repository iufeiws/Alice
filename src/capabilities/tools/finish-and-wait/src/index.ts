import type { ToolCall, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { finishAndWaitTool } from "../profile.js";

export function createFinishAndWaitTools(): ToolPlugin {
  return {
    id: "finish-and-wait",
    listTools() {
      return [finishAndWaitTool];
    },
    async execute(call: ToolCall): Promise<ToolResult> {
      if (call.toolName !== "finish_and_wait") {
        return { callId: call.id, ok: false, error: `Unknown finish-and-wait tool: ${call.toolName}` };
      }
      return {
        callId: call.id,
        ok: true,
        meta: { yieldReturn: true }
      };
    }
  };
}
