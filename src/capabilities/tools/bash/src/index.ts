import type { BashSandboxRuntime } from "../../../../contexts/bash-sandbox/src/index.js";
import type { ToolPlugin } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { bashTool } from "../profile.js";

export function createBashTools(input: { runtime: BashSandboxRuntime }): ToolPlugin {
  return {
    id: "bash",
    listTools() {
      return [bashTool];
    },
    async execute(call) {
      if (call.toolName !== "bash") return { callId: call.id, ok: false, error: `Unknown bash tool: ${call.toolName}` };
      return {
        callId: call.id,
        ok: true,
        output: JSON.stringify(await input.runtime.run(call))
      };
    }
  };
}
