import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const skillTool: ToolDefinition = {
  name: "Skill",
  passRenderText: true,
  description: "Load one available Skill by exact name.",
  inputSchema: {
    type: "object",
    properties: {
      skill: { type: "string" },
      args: { type: "string" }
    },
    required: ["skill"],
    additionalProperties: false
  }
};
