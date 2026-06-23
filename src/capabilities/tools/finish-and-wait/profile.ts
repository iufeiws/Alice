import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const finishAndWaitTool: ToolDefinition = {
  name: "finish_and_wait",
  description: "结束当前回复并等待聊天记录更新。当有新消息时会收到提醒并返回新消息。没有的话就干自己的事情",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};
