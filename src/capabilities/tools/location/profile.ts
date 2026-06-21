import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const checkLocationToolName = "check_location";

export const checkLocationTool: ToolDefinition = {
  name: checkLocationToolName,
  description: "查看当前所在的历史记录是现实中的哪个位置",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

export const locationToolText = {
  unknownTool: (toolName: string) => `Unknown location tool: ${toolName}`,
  unavailable: "location_unavailable",
  addressUnavailable: "location_address_unavailable"
};
