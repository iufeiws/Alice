import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const subAgentToolName = "SubAgent";

const actionDescriptions = [
  "spawn：创建新的持久化 SubAgent session 并提交第一条任务消息，立即返回 nickname，不等待任务完成。",
  "messages：读取指定 nickname 对应 session 的 Pi 原始消息，并用 access 按 Python 索引或切片语义读取，例如 -1、:3、2:。",
  "result：读取指定 nickname 对应 session 当前任务的结果；完成时返回最新 assistant message，运行中返回 running，其他终态只返回状态。",
  "send：向指定 nickname 对应 session 提交一条新任务消息并立即返回原 nickname；需要结果时再调用 wait 或 result。",
  "status：非阻塞查询指定 nickname 对应 session 的单一状态、最后更新时间和可见消息数量，状态包含 queued、running 及五种终态。",
  "wait：等待指定 nickname 对应 session 当前任务结束；完成时返回最新 assistant 消息，等待结束时仍未完成则返回 running，其他终态只返回状态。",
  "cancel：请求取消指定 nickname 对应 session 当前运行或排队的任务，成功返回 cancelled，session 保持可复用。",
  "fork：从指定 nickname 对应 session 创建独立的新 session，可用 entryId 指定历史分支点，成功返回新 nickname。"
];

export const subAgentTool: ToolDefinition = {
  name: subAgentToolName,
  description: actionDescriptions.join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["spawn", "messages", "result", "send", "status", "wait", "cancel", "fork"] },
      message: { type: "string", minLength: 1 },
      nickname: { type: "string", minLength: 1 },
      access: { type: "string", minLength: 1 },
      timeoutSeconds: { type: "number", minimum: 1 },
      entryId: { type: "string", minLength: 1 }
    },
    required: ["action"],
    additionalProperties: false
  }
};
