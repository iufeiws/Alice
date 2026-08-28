export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  passRenderText?: boolean;
  suppressExecutionCard?: boolean;
  /** 成功执行该工具即视为已向用户发送消息；当前按工具级别判断。 */
  sendsMessage?: boolean;
  /** 允许工具将图片作为附件回传给支持图片的 LLM；默认关闭。 */
  returnImageToLLM?: boolean;
};

export type ToolCallRequester = {
  plugin: "feishu" | "desktop-pet" | "web-admin" | string;
  accountId?: string;
  channelId?: string;
  userId?: string;
  rawMessageId?: string;
};

export type ToolCallExternalSession = {
  scope: "dm" | "group" | "topic" | "admin" | "desktop";
  sessionId: string;
  threadId?: string;
};

export type ToolCall = {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  requester?: ToolCallRequester;
  externalSession?: ToolCallExternalSession;
};

export type ToolResult = {
  callId: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  llmFollowupAttachments?: ToolResultLLMAttachment[];
  meta?: {
    yieldReturn?: boolean;
    yieldAction?: "schedule" | "await_chat";
    yieldSeconds?: number;
  };
  invalidateLLMSession?: boolean;
  llmSessionClearReason?: "yield_end";
  resetLLMSession?: boolean;
  continueAfterReset?: boolean;
  appendAlbertMessage?: { contentText: string };
  llmSessionMode?: string;
  llmSessionStaticMessages?: ToolResultLLMMessage[];
  fixedPrefixKind?: string;
  fixedPrefixTtlMs?: number;
  clearFixedPrefix?: boolean;
};

export type AppendAlbertMessageInput = {
  callId: string;
  requester?: ToolCallRequester;
  externalSession?: ToolCallExternalSession;
  contentText: string;
};

export type ToolResultLLMAttachment = {
  kind: "image";
  path?: string;
  assetId?: string;
  /** base64 编码的图像字节; 提供时优先于 path/assetId, 不再读盘。 */
  data?: string;
  mime?: string;
  toolNotice?: string;
  followupText?: string;
};

export type ToolResultLLMMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoningContent?: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

export type ToolExecutionContext = {
  signal?: AbortSignal;
  lastCompletedToolName?: string;
  agentLoopRunSeq?: number;
  llmSessionId?: number | string;
  llmCapabilities?: {
    supportsImage?: boolean;
    supportsAudio?: boolean;
  };
  reportProgress?(content: string): void;
  prepareProcessRestart?(): Promise<void>;
  cancelProcessRestart?(): Promise<void>;
};

export type ToolExecutionReporter = {
  begin(call: ToolCall): Promise<ToolExecutionReportSession | undefined> | ToolExecutionReportSession | undefined;
  endSequence(): Promise<void> | void;
};

export type ToolExecutionReportSession = {
  appendProgress(content: string): Promise<void> | void;
  finish(result: ToolResult): Promise<void> | void;
  fail(error: unknown): Promise<void> | void;
};

export interface ToolPlugin {
  id: string;
  listTools(): ToolDefinition[];
  execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult>;
}
