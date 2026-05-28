export type AgentPayload =
  | { kind: "text"; text: string }
  | { kind: "markdown"; markdown: string }
  | { kind: "image"; assetId: string; alt?: string }
  | { kind: "audio"; assetId: string; transcript?: string }
  | { kind: "file"; assetId: string; filename: string; mime?: string }
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
  session: {
    scope: "dm" | "group" | "topic" | "admin" | "desktop";
    sessionId: string;
    threadId?: string;
  };
  type: AgentEventType;
  payload: AgentPayload;
  meta: {
    receivedAt: string;
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

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  requester?: AgentEvent["source"];
  session?: AgentEvent["session"];
};

export type ToolResult = {
  callId: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  invalidateLLMSession?: boolean;
};

export interface ToolPlugin {
  id: string;
  listTools(): ToolDefinition[];
  execute(call: ToolCall): Promise<ToolResult>;
}

export type AgentContext = {
  sessionId: string;
  userId?: string;
  timezone?: string;
};

export type AgentResponse = {
  outputs: AgentOutput[];
};

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
