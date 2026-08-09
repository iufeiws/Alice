import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const minYieldWaitSeconds = 10;
export const maxYieldWaitSeconds = 15 * 60;
/** await_chat 固定等待时长: 15 分钟。 */
export const awaitChatWaitSeconds = maxYieldWaitSeconds;

export const finishAndWaitTool: ToolDefinition = {
  name: "Yield",
  suppressExecutionCard: true,
  description: "等待回复或结束聊天。action=schedule 定时(秒)后再次返回, 中途有新消息时提前返回; action=await_chat 固定等待 15 分钟, 有新消息时提前返回, 超时无消息则结束; action=finish 直接结束",
  inputSchema: {
    type: "object",
    oneOf: [
      {
        description: "schedule: 定时(秒)后再次返回, 中途有新消息时提前返回",
        properties: {
          action: { const: "schedule" },
          timer: { type: "integer", minimum: minYieldWaitSeconds, maximum: maxYieldWaitSeconds }
        },
        required: ["action", "timer"],
        additionalProperties: false
      },
      {
        description: "await_chat: 固定等待 15 分钟, 有新消息时提前返回, 超时无消息则结束",
        properties: { action: { const: "await_chat" } },
        required: ["action"],
        additionalProperties: false
      },
      {
        description: "finish: 直接结束",
        properties: { action: { const: "finish" } },
        required: ["action"],
        additionalProperties: false
      }
    ]
  }
};
