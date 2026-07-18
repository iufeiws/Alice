import type { BashRuntimeResult, BashSandboxRuntime } from "../../../../contexts/bash-sandbox/src/index.js";
import type { ToolPlugin } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { bashTool } from "../profile.js";

export function createBashTools(input: {
  runtime: BashSandboxRuntime;
  handleResult?(result: BashRuntimeResult): Promise<unknown | undefined>;
}): ToolPlugin {
  return {
    id: "bash",
    listTools() {
      return [bashTool];
    },
    async execute(call) {
      if (call.toolName !== bashTool.name) return { callId: call.id, ok: false, error: `Unknown bash tool: ${call.toolName}` };
      const result = await input.runtime.run(call);
      const submission = await input.handleResult?.(result);
      return {
        callId: call.id,
        ok: true,
        output: JSON.stringify({ ...result, ...(submission === undefined ? {} : { submission }) })
      };
    }
  };
}
