import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const checkChatTool: ToolDefinition = {
  name: "check_chat",
  description: "查看聊天记录。默认返回新增消息。",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

export const sendChatTool: ToolDefinition = {
  name: "send_chat",
  description: "发送消息到当前聊天会话。必须先提供 type，再提供 content；type=message 和 type=voice 会把 content 中的换行拆成多条消息并间隔发送；type=voice 会把每段文本合成为语音并发送。",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["message", "markdown", "image", "voice"] },
      content: { type: "string" }
    },
    required: ["type", "content"],
    additionalProperties: false
  }
};

export const waitChatTool: ToolDefinition = {
  name: "wait_chat",
  description: "等待聊天记录更新。当有新消息时会收到提醒并返回新消息。",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

export const searchMessagesTool: ToolDefinition = {
  name: "search_messages",
  description: "Search persisted messages in the current conversation and return contextual message blocks.",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string" },
      direction: {
        type: "string",
        enum: ["backward", "forward"],
        default: "backward"
      },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 3 },
      contextCount: { type: "integer", minimum: 1, maximum: 50, default: 10 }
    },
    required: ["content"],
    additionalProperties: false
  }
};

export const messagingToolText = {
  unknownTool: (toolName: string) => `Unknown messaging tool: ${toolName}`,
  noCurrentSession: "No current messaging session is available",
  contentRequired: "content is required",
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
  appendCurrentTime: (output: string, currentTime: string) => `<chat-log>\n${output}\n</chat-log>\n<time>${currentTime}<\\time>`,
  fallbackSentLine: (content: string, ok: boolean) => `Alice:${content}${ok ? "" : "[发送失败]"}`
};

export const messagingSystemPromptMessages = [
  "-少女拍照中-",
  "-大失败-",
  "-星界信号丢失-",
  "(少女拍照中...)",
  "(大失败...)"
];
