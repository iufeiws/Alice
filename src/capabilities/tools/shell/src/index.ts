import type { ToolCall, ToolExecutionContext, ToolPlugin, ToolResult } from "../../../../contexts/tool-execution/src/index.js";
import type { PiWorkerRuntime } from "../../../../contexts/pi-worker/src/index.js";
import { piToolResultToToolResult } from "../../../../contexts/pi-worker/src/index.js";
import { bashPiToolName, bashTool, bashToolName } from "../profile.js";

export function createShellTools(input: { runtime: PiWorkerRuntime }): ToolPlugin {
  return {
    id: "shell",
    listTools() {
      return [bashTool];
    },
    async execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
      if (call.toolName !== bashToolName) throw new Error(`shell_tool_unavailable:${call.toolName}`);
      const result = await input.runtime.executeTool({ requestId: call.id, toolName: bashPiToolName, input: call.input, context });
      return piToolResultToToolResult(call.id, result);
    }
  };
}
