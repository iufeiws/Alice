import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const wardrobeTool: ToolDefinition = {
  name: "Wardrobe",
  description: "查看或切换爱丽丝的服装。action=list: name 为空返回 groups, name 非空按服装 name/id/group/content 模糊过滤；action=mirror 返回当前服装；action=switch 根据服装 name 切换服装；action=random 随机切换匹配到的服装, name 为空则从全部服装随机。",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "mirror", "switch", "random"] },
      name: { type: "string" }
    },
    required: ["action"],
    additionalProperties: false
  }
};

export const shellToolText = {
  unknownTool: (toolName: string) => `Unknown shell tool: ${toolName}`,
  unsupportedAction: "unsupported action",
  noCurrentSession: "No current messaging session is available",
  nameRequired: "name is required",
  unknownOutfitName: "unknown outfit name",
  ambiguousOutfitName: (name: string) => `ambiguous outfit name: ${name}`,
  switched: "success",
  changingNotice: "-少女已更衣-"
};
