import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const minYieldWaitSeconds = 10;
export const maxYieldWaitSeconds = 15 * 60;

export const finishAndWaitTool: ToolDefinition = {
  name: "Yield",
  suppressExecutionCard: true,
  description: "等待回复或结束聊天。action=wait 等待新消息, 有新消息时提醒, timer接受秒数, 如果设定timer则没有收到新消息时在时间到时提醒；action=end 结束聊天",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["wait", "end"], default: "wait" },
      timer: { type: "integer", minimum: minYieldWaitSeconds, maximum: maxYieldWaitSeconds},
    },
    required: ["action"],
    additionalProperties: false
  }
};
