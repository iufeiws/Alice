import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const finishAndWaitTool: ToolDefinition = {
  name: "Yield",
  description: "结束当前回复并等待聊天记录更新。当有新消息时会收到提醒并返回新消息；如果等待过一段时间，返回内容会包含 <wait-duration>...</wait-duration> 表示等待时长。没有新消息的话就干自己的事情",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};
