import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const minYieldWaitSeconds = 10;
export const maxYieldWaitSeconds = 15 * 60;
/** await_chat 固定等待时长: 15 分钟。 */
export const awaitChatWaitSeconds = maxYieldWaitSeconds;
export const clearYieldAlbertContent = '<Alert info="上下文历史已清空" />';

export const finishAndWaitTool: ToolDefinition = {
  name: "Yield",
  suppressExecutionCard: true,
  // schedule 已禁用，不暴露给 LLM；保留原描述便于恢复时参考。
  // description: "等待回复或结束聊天。action=schedule 定时(秒)后再次返回, 中途有新消息时提前返回; action=await_chat 固定等待 15 分钟, 有新消息时提前返回, 超时无消息则结束; action=finish 直接结束",
  description: "等待回复、清空上下文或结束聊天。action=clear 清空当前对话上下文并开启新一轮; action=await_chat 固定等待 15 分钟, 有新消息时提前返回, 超时无消息则结束; action=finish 直接结束",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["clear", "await_chat", "finish"] }
    },
    required: ["action"],
    additionalProperties: false
  }
};
