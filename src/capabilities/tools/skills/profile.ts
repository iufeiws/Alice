import type { ToolDefinition } from "../../../contexts/tool-execution/src/index.js";

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
