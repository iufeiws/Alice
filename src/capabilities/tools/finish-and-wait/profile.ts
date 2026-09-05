import type { ToolDefinition } from "../../../contexts/tool-execution/src/index.js";

export const minYieldWaitSeconds = 10;
export const maxYieldWaitSeconds = 15 * 60;
/** await 固定等待时长: 15 分钟。 */
export const awaitChatWaitSeconds = maxYieldWaitSeconds;
export const clearYieldAlbertContent = '<Alert info="上下文历史已清空" />';

const actionDescriptions = [
  "new：清空当前的工具调用和思考等上下文，然后重新进入 agent loop。",
  "await：固定等待 15 分钟；有新消息时提前返回，超时无消息则结束。",
  "finish：直接结束当前对话。"
];

export const finishAndWaitTool: ToolDefinition = {
  name: "Yield",
  passRenderText: true,
  suppressExecutionCard: true,
  description: actionDescriptions.join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["new", "await", "finish"] }
    },
    required: ["action"],
    additionalProperties: false
  }
};
