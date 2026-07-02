import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const chatTool: ToolDefinition = {
  name: "Chat",
  description: "聊天工具。action=poll 查看新增聊天记录；action=send 给{{user}}发送消息。send 需要 type、alice、content，alice 省略时为 shell",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["poll", "send"], default: "poll" },
      type: { type: "string", enum: ["message", "markdown", "image", "voice"] },
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
  shellSwitch: (personalityName: string, relationshipName: string) => `-壳切换:切换为${personalityName}的${relationshipName}爱丽丝-`,
  haveNewMessage: "<have-new-message/>",
  sendChatFailed: (reason: string) => `<send-chat-failed reason="${reason}"/>`,
  appendCurrentTime: (output: string, currentTime: string, prefix?: string) => `${prefix ? `${prefix}\n` : ""}<chat-log>\n${output}\n</chat-log>\n<now local="${currentTime}"/>`,
  fallbackSentLine: (content: string, ok: boolean) => `Alice:${content}${ok ? "" : "[发送失败]"}`
};

export const messagingSystemPromptMessages = [
  "-少女拍照中-",
  "-大失败-",
  "-星界信号丢失-",
  "(少女拍照中...)",
  "(大失败...)"
];
