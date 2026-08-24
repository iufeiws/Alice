import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const restartToolName = "restart";
export const restartSuccessOutput = "服务已重启，代码更新已加载";

export const restartTool: ToolDefinition = {
  name: restartToolName,
  passRenderText: true,
  description: "重启 Alice 服务, 能够加载代码更新, 也可能导致无法恢复",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};
