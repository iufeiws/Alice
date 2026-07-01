import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const listSkillsTool: ToolDefinition = {
  name: "list_skills",
  description: "List available Skills metadata.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

export const loadSkillTool: ToolDefinition = {
  name: "load_skill",
  description: "Load one Skill's full instructions and container resource root.",
  inputSchema: {
    type: "object",
    properties: {
      skill: { type: "string" }
    },
    required: ["skill"],
    additionalProperties: false
  }
};
