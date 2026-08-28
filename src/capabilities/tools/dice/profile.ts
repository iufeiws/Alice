import type { ToolDefinition } from "../../../contexts/tool-execution/src/index.js";

export const diceToolName = "Dice";

export const diceTool: ToolDefinition = {
  name: diceToolName,
  passRenderText: true,
  description: "投掷骰子。sides > 1, 默认 6；count > 0 默认 1；",
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "integer", minimum: 2 },
      count: { type: "integer", minimum: 1 }
    },
    additionalProperties: false
  }
};

export const diceToolText = {
  unknownTool: (toolName: string) => `Unknown dice tool: ${toolName}`,
  invalidSides: "sides must be an integer > 1",
  invalidCount: "count must be an integer > 0"
};
