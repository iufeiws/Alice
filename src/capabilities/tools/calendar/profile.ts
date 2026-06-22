import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const calendarTool: ToolDefinition = {
  name: "calendar",
  description: "管理日历事实和一次性定时提醒。支持 action=add 添加 holiday/reminder，action=remove 按 id 删除。",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "remove"] },
      type: { type: "string", enum: ["holiday", "reminder"] },
      calendarSystem: { type: "string", enum: ["gregorian", "lunar"] },
      title: { type: "string" },
      note: { type: "string" },
      year: { type: "integer" },
      month: { type: "integer", minimum: 1, maximum: 12 },
      day: { type: "integer", minimum: 1, maximum: 31 },
      isLeapMonth: { type: "boolean" },
      time: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
      id: { type: "integer", minimum: 1 }
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
  invalidCalendarSystem: "invalid calendar system",
  invalidDate: "invalid date",
  invalidTime: "invalid time",
  invalidId: "invalid id",
  notFound: "not found"
};
