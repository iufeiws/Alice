import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const chatTool: ToolDefinition = {
  name: "Chat",
  suppressExecutionCard: true,
  description: "聊天工具。action=poll 查看新增聊天记录；action=send 给${{user}}发送消息。send 需要 type、alice、content，alice 省略时为 shell。type=file 时 content 为沙盒内文件路径，图片会按图片发送，其他文件按文件发送",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["poll", "send"], default: "poll" },
      type: { type: "string", enum: ["message", "markdown", "image", "voice", "file"] },
      alice: { type: "string", enum: ["core", "shell"] },
      content: { type: "string" }
    },
    required: ["action"],
    additionalProperties: false
  }
};

export const messagingToolText = {
  unknownTool: (toolName: string) => `Unknown messaging tool: ${toolName}`,
  unsupportedAction: "unsupported Chat action",
  noCurrentSession: "No current messaging session is available",
  contentRequired: "content is required",
  waitForUserReplyBeforeSending: "Chat action=send blocked: 你已经连续发送了多条消息且用户尚未回复。请先等待用户回复，再继续发送。",
  unsupportedMessageType: "unsupported message type",
  nothingNew: "nothing new",
  nothingFound: "nothing found",
  sendFailedTag: "[发送失败]",
  sendingTag: "[发送中]",
  recalledTag: "[已撤回]",
  recalledMessage: "(message recalled)",
  imageMessage: "发送了一张图片",
  fileMessage: (filePath: string) => `发送了文件[${filePath}]`,
  voiceCallStarted: "-已接通-",
  voiceCallEnded: "-已挂断-",
  assistantSpeakerLabels: { core: "里", shell: "壳" },
  shellSwitch: (personalityName: string, relationshipName: string) => `-壳切换:切换为${personalityName}的${relationshipName}爱丽丝-`,
  haveNewMessage: "<have-new-message/>",
  sendChatFailed: (reason: string) => `<send-chat-failed reason="${reason}"/>`,
  sandboxSendDisabled: "Chat action=send type=file 不可用：沙盒未配置",
  sandboxPathOutside: (filePath: string) => `沙盒文件路径不在允许的挂载目录内: ${filePath}`,
  sandboxFileNotFound: (filePath: string) => `沙盒文件不存在: ${filePath}`,
  sandboxNotAFile: (filePath: string) => `沙盒路径不是文件: ${filePath}`,
  sandboxFileStageFailed: (filePath: string) => `沙盒文件暂存到 assets 失败: ${filePath}`,
  appendCurrentTime: (output: string, currentTime: string, prefix?: string) => `${prefix ? `${prefix}\n` : ""}<chat-log>\n${output}\n</chat-log>\n<now local="${currentTime}"/>`,
  fallbackSentLine: (content: string, ok: boolean) => `Alice:${content}${ok ? "" : "[发送失败]"}`
};

export const messagingSystemPromptMessages = [
  "少女拍照中",
  "大失败",
  "星界信号丢失",
  "少女已入眠",
  "记忆整理大失败",
  "少女已更衣",
  "少女已取书",
  "少女已还书",
  "少女就寝中",
  "少女起床"
];
