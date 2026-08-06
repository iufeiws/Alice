import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const subAgentToolName = "SubAgent";

const actionDescriptions = [
  "spawn：创建新的持久化 SubAgent session 并提交第一条任务消息，立即返回 sessionId，不等待任务完成。",
  "messages：先过滤指定 session 的可见 user/assistant 消息，再用 access 按 Python 索引或切片语义读取，例如 -1、:3、2:。",
  "send：向已有 session 提交一条新任务消息并立即返回原 sessionId；需要结果时再调用 wait 或 messages。",
  "status：非阻塞查询 session 的单一状态、最后更新时间和可见消息数量，状态包含 queued、running 及五种终态。",
  "wait：等待 session 当前任务结束；完成时返回最新 assistant 消息，等待结束时仍未完成则返回 running，其他终态只返回状态。",
  "cancel：请求取消 session 当前运行或排队的任务，成功返回 cancelled，session 保持可复用。",
  "fork：从指定 session 创建独立的新 session，可用 entryId 指定历史分支点，成功返回新 sessionId。"
];

export const subAgentTool: ToolDefinition = {
  name: subAgentToolName,
  description: actionDescriptions.join("\n"),
  inputSchema: {
    type: "object",
    oneOf: [
      { description: actionDescriptions[0], properties: { action: { const: "spawn" }, message: { type: "string", minLength: 1 }, timeoutSeconds: { type: "number", minimum: 1 } }, required: ["action", "message"], additionalProperties: false },
      { description: actionDescriptions[1], properties: { action: { const: "messages" }, sessionId: { type: "string", minLength: 1 }, access: { type: "string", minLength: 1 } }, required: ["action", "sessionId", "access"], additionalProperties: false },
      { description: actionDescriptions[2], properties: { action: { const: "send" }, sessionId: { type: "string", minLength: 1 }, message: { type: "string", minLength: 1 }, timeoutSeconds: { type: "number", minimum: 1 } }, required: ["action", "sessionId", "message"], additionalProperties: false },
      { description: actionDescriptions[3], properties: { action: { const: "status" }, sessionId: { type: "string", minLength: 1 } }, required: ["action", "sessionId"], additionalProperties: false },
      { description: actionDescriptions[4], properties: { action: { const: "wait" }, sessionId: { type: "string", minLength: 1 }, timeoutSeconds: { type: "number", minimum: 1 } }, required: ["action", "sessionId"], additionalProperties: false },
      { description: actionDescriptions[5], properties: { action: { const: "cancel" }, sessionId: { type: "string", minLength: 1 } }, required: ["action", "sessionId"], additionalProperties: false },
      { description: actionDescriptions[6], properties: { action: { const: "fork" }, sessionId: { type: "string", minLength: 1 }, entryId: { type: "string", minLength: 1 } }, required: ["action", "sessionId"], additionalProperties: false }
    ]
  }
};
