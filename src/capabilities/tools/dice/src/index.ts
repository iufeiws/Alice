import type { ToolCall, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { diceTool, diceToolName, diceToolText } from "../profile.js";

export type DiceToolsDeps = {
  random?(): number;
};

export function createDiceTools(deps: DiceToolsDeps = {}): ToolPlugin {
  const random = deps.random ?? Math.random;
  return {
    id: "dice",
    listTools() {
      return [diceTool];
    },
    async execute(call) {
      if (call.toolName !== diceToolName) return toolError(call, diceToolText.unknownTool(call.toolName));
      const sides = integerInput(call.input.sides, 6);
      if (sides === undefined || sides <= 1) return toolError(call, diceToolText.invalidSides);
      const count = integerInput(call.input.count, 1);
      if (count === undefined || count <= 0) return toolError(call, diceToolText.invalidCount);

      const points = Array.from({ length: count }, () => Math.floor(random() * sides) + 1);
      return {
        callId: call.id,
        ok: true,
        output: `<dice point="${count === 1 ? points[0] : `${points.join("+")} = ${points.reduce((sum, point) => sum + point, 0)}`}"/>`
      };
    }
  };
}

function integerInput(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function toolError(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, ok: false, error };
}
