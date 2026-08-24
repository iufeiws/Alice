export type AgentAttachmentResource = {
  id: string;
  filename?: string;
  mime?: string;
};

export type AgentPayload =
  | { kind: "text"; text: string }
  | { kind: "markdown"; markdown: string }
  | { kind: "image"; assetId?: string; alt?: string; resource?: AgentAttachmentResource }
  | { kind: "audio"; assetId: string; transcript?: string }
  | { kind: "file"; assetId?: string; filename?: string; mime?: string; resource?: AgentAttachmentResource }
  | { kind: "link"; url: string; title?: string; description?: string }
  | { kind: "card_action"; actionId: string; values: Record<string, unknown> };

export type AgentEventType =
  | "message.text"
  | "message.markdown"
  | "message.image"
  | "message.audio"
  | "message.file"
  | "message.link"
  | "message.card_action"
  | "system.heartbeat"
  | "job.completed"
  | "job.failed";

export type AgentEvent = {
  id: string;
  source: {
    plugin: "feishu" | "desktop-pet" | "web-admin" | string;
    accountId?: string;
    channelId?: string;
    userId?: string;
    rawMessageId?: string;
  };
  externalSession: {
    scope: "dm" | "group" | "topic" | "admin" | "desktop";
    sessionId: string;
    threadId?: string;
  };
  type: AgentEventType;
  payload: AgentPayload;
  meta: {
    receivedAt: string;
    receivedAtUtc?: string;
    locale?: string;
    timezone?: string;
    mentionsBot?: boolean;
    replyTo?: string;
    quotedMessage?: {
      rawMessageId?: string;
      senderId?: string;
      text?: string;
    };
    raw?: unknown;
  };
};

export type InboundAudioStreamFrame =
  | InboundAudioStreamStartFrame
  | InboundAudioStreamChunkFrame
  | InboundAudioStreamEndFrame
  | InboundAudioStreamAbortFrame;

export type InboundAudioStreamStartFrame = {
  type: "start";
  streamId: string;
  audio: {
    filename?: string;
    mimeType?: string;
    sampleRateHz?: number;
    channels?: number;
    encoding?: string;
  };
  language?: string;
  provider?: "tencent" | "openai_compatible" | "multimodal_llm";
  prompt?: string;
  metadata?: Record<string, unknown>;
};

export type InboundAudioStreamChunkFrame = {
  type: "chunk";
  streamId: string;
  sequence: number;
  bytes: Uint8Array;
  timing?: {
    startMs?: number;
    endMs?: number;
    durationMs?: number;
  };
  metadata?: Record<string, unknown>;
};

export type InboundAudioStreamEndFrame = {
  type: "end";
  streamId: string;
  metadata?: Record<string, unknown>;
};

export type InboundAudioStreamAbortFrame = {
  type: "abort";
  streamId: string;
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type InternalCard = {
  title: string;
  body?: string;
  fields?: Array<{ label: string; value: string }>;
  actions?: Array<{ id: string; label: string; style?: "default" | "primary" | "danger" }>;
};

export type AgentOutput = {
  id: string;
  target: {
    plugin: string;
    accountId?: string;
    channelId?: string;
    userId?: string;
    sessionId: string;
    replyTo?: string;
  };
  content:
    | { kind: "text"; text: string }
    | { kind: "markdown"; markdown: string }
    | { kind: "html"; htmlAssetId: string; fallbackMarkdown?: string }
    | { kind: "card"; card: InternalCard }
    | { kind: "image"; assetId: string }
    | { kind: "audio"; assetId: string; transcript?: string }
    | { kind: "file"; assetId: string; filename: string };
  meta: {
    createdAt: string;
    createdAtUtc?: string;
    senderName?: string;
    urgency: "silent" | "normal" | "important";
    allowStreaming?: boolean;
  };
};

export interface ChannelPlugin {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(output: AgentOutput): Promise<unknown>;
}

export function sanitizeMessageText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => stripLeadingTransportMetadata(line))
    .join("\n")
    .trim();
}

export function sanitizeAudioTranscript(value: string | undefined): string {
  return sanitizeMessageText(value ?? "");
}

export function summarizeAudioText(transcript: string | undefined, fallback?: string): string {
  const text = sanitizeAudioTranscript(transcript);
  return text ? `[语音]${text}` : fallback ?? "语音";
}

function stripLeadingTransportMetadata(value: string): string {
  let text = value.trim();
  for (let index = 0; index < 10; index += 1) {
    const next = text
      .replace(/^\[(?:语音|音频|voice|audio)\]\s*/i, "")
      .replace(/^\[\s*(?:\d+(?::\d+)*(?:\.\d+)?\s*[,，-]\s*)+\d+(?::\d+)*(?:\.\d+)?\s*\]\s*/, "")
      .replace(/^(?:start|end|duration|时长|开始|结束)\s*[:：]\s*\d+(?::\d+)*(?:\.\d+)?\s*(?:[,，-]\s*)?/i, "")
      .trim();
    if (next === text) return text;
    text = next;
  }
  return text;
}

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  suppressExecutionCard?: boolean;
};

export type ToolCall = {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  requester?: AgentEvent["source"];
  externalSession?: AgentEvent["externalSession"];
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
  requester?: AgentEvent["source"];
  externalSession?: AgentEvent["externalSession"];
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

export type AgentContext = {
  sessionId: string;
  userId?: string;
  timezone?: string;
};

export type AgentResponse = {
  outputs: AgentOutput[];
};
