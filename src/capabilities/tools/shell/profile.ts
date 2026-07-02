import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const wardrobeTool: ToolDefinition = {
  name: "Wardrobe",
  description: "查看或切换爱丽丝的服装。action=list 返回可用衣橱，可用 name 按服装 name/id/group/content 模糊过滤；action=mirror 照镜子,看看爱丽丝当前穿的是什么服装；action=switch 根据服装 name 切换服装。",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "mirror", "switch"] },
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
  mirror: (name: string, content: string) => `你看到镜子中的自己穿着: \n 服装：${name}\n${content}`,
  switched: (name: string) => `服装已切换为${name}`,
  changingNotice: "-少女已更衣-"
};
