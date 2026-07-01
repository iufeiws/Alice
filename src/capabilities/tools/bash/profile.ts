import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const bashTool: ToolDefinition = {
  name: "bash",
  description: "Execute a non-interactive Bash command inside the configured Docker sandbox.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeoutMs: { type: "number" },
      reason: { type: "string" }
    },
    required: ["command"],
    additionalProperties: false
  }
};
