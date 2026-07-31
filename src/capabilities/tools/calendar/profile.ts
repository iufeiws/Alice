import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const calendarTool: ToolDefinition = {
  name: "calendar",
  suppressExecutionCard: true,
  description: "管理和查看日历。支持 action=add 添加 schedule，action=remove 按 title/datetime 删除 schedule，action=search 搜索，action=list 查看日历。",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "remove", "search", "list"] },
      title: { type: "string" },
      datetime: { type: "string" },
      note: { type: "string" },
      searchkey: {
        anyOf: [
          { type: "string" },
          { type: "array", items: { type: "string" }, minItems: 1 }
        ]
      },
      scope: { type: "string", enum: ["future", "past", "both"] },
      daysBefore: { type: "integer", minimum: 0, maximum: 30 },
      daysAfter: { type: "integer", minimum: 0, maximum: 30 }
    },
    required: ["action"],
    additionalProperties: false
  }
};

export const calendarToolText = {
  unknownTool: (toolName: string) => `Unknown calendar tool: ${toolName}`,
  unsupportedAction: "unsupported action",
  invalidType: "invalid type",
  invalidTitle: "invalid title",
  invalidDatetime: "invalid datetime",
  pastDatetime: "datetime must be now or future",
  duplicateSchedule: "duplicate schedule",
  invalidSearch: "invalid search",
  notFound: "not found"
};
