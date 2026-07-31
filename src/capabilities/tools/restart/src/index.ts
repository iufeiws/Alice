import type { ToolCall, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { restartSuccessOutput, restartTool, restartToolName } from "../profile.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RestartController = {
  restart(): Promise<void>;
};

export function createSystemdRestartController(input: {
  runCommand?(file: string, args: string[]): Promise<unknown>;
} = {}): RestartController {
  const runCommand = input.runCommand ?? execFileAsync;
  return {
    async restart() {
      await runCommand("systemctl", ["--user", "restart", "alice-agent-tmux.service"]);
    }
  };
}

export function createRestartTools(controller: RestartController): ToolPlugin {
  return {
    id: "restart",
    listTools() {
      return [restartTool];
    },
    async execute(call, context): Promise<ToolResult> {
      if (call.toolName !== restartToolName) return toolError(call, `Unknown restart tool: ${call.toolName}`);
      if (Object.keys(call.input).length > 0) return toolError(call, "restart does not accept arguments");
      if (!context?.prepareProcessRestart || !context.cancelProcessRestart) {
        return toolError(call, "restart continuation is unavailable");
      }
      await context.prepareProcessRestart();
      try {
        await controller.restart();
      } catch (error) {
        await context.cancelProcessRestart();
        return toolError(call, error instanceof Error ? error.message : String(error));
      }
      return {
        callId: call.id,
        ok: true,
        output: restartSuccessOutput
      };
    }
  };
}

function toolError(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, ok: false, error };
}
