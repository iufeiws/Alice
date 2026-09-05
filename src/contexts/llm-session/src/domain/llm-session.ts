import type { LLMChatInput, LLMChatResult } from "../../../llm-gateway/src/index.js";

export type LLMSessionClearReason = "prompt_static_changed" | "admin_clear" | "admin_cancel" | "mode_transition" | "mode_timeout" | "yield_end" | "process_restart_recovery_failed" | "force_wake" | "force_clear";
export type LLMSessionSnapshot = {
  id?: number;
  messages: LLMChatInput["messages"];
  staticPromptFingerprint?: string;
  staticPromptMessageCount?: number;
  requestTimestamps?: string[];
  agentLoopRunSeq?: number;
  currentRound?: number;
  mode?: string;
  modeStaticMessages?: LLMChatInput["messages"];
  modeStaticTokenEstimate?: number;
  modeStartedAt?: string;
  modeExpiresAt?: string;
  fixedPrefixKind?: string;
  fixedPrefixStartedAt?: string;
  loopStartedAt?: string;
  waitChatStartedAt?: string;
  waitChatMode?: "schedule" | "await";
  waitChatUntil?: string;
  waitChatTarget?: {
    source: { plugin: string; accountId?: string; channelId?: string; userId?: string; rawMessageId?: string };
    externalSession: { scope: "dm" | "group" | "topic" | "admin" | "desktop"; sessionId: string; threadId?: string };
  };
  skipNextAppendLayers?: boolean;
};

export type LLMRequestLogEntry = {
  protocol?: "openai-chat-completions" | "openai-responses";
  stream?: boolean;
  id: number;
  agentId?: "chat" | "talk";
  sessionId?: number;
  time: string;
  timeUtc?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  messageCount: number;
  tools?: LLMChatInput["tools"];
  extraParams?: Record<string, unknown>;
  presetName?: string;
};

export type LLMRequestPreview = LLMRequestLogEntry & {
  source: "preview" | "actual";
  conversationId?: string;
  messages: LLMChatInput["messages"];
  rawRequest?: unknown;
};

export type LLMResponseLogEntry = {
  id: number;
  agentId?: "chat" | "talk";
  sessionId?: number;
  requestId?: number;
  time: string;
  timeUtc?: string;
  message: LLMChatResult["message"];
  finishReason?: string;
  usage?: LLMChatResult["usage"];
  raw?: unknown;
};

export type LLMResponseLogInfo = Omit<LLMResponseLogEntry, "message" | "usage" | "raw"> & {
  toolCallCount: number;
};

export type LLMSessionTurn = {
  round: number;
  request?: LLMRequestLogEntry;
  response?: LLMResponseLogEntry;
  latestRequest?: LLMSessionRequestInfo;
  latestResponse?: LLMSessionResponseInfo;
  messages: LLMChatInput["messages"];
};

export type LLMSessionRecord = {
  id: number;
  agentId?: "chat" | "talk" | "memorize";
  startedAt: string;
  startedAtUtc?: string;
  updatedAt: string;
  updatedAtUtc?: string;
  archiveFilePath?: string;
  archiveMetadata?: Record<string, unknown>;
  requestIds: number[];
  responseIds: number[];
  messages: LLMChatInput["messages"];
  staticPromptFingerprint?: string;
  staticPromptMessageCount?: number;
  requestTimestamps: string[];
  agentLoopRunSeq?: number;
  mode?: string;
  modeStaticMessages?: LLMChatInput["messages"];
  modeStaticTokenEstimate?: number;
  modeStartedAt?: string;
  modeExpiresAt?: string;
  fixedPrefixKind?: string;
  fixedPrefixStartedAt?: string;
  loopStartedAt?: string;
  waitChatStartedAt?: string;
  waitChatMode?: "schedule" | "await";
  waitChatUntil?: string;
  waitChatTarget?: LLMSessionSnapshot["waitChatTarget"];
  skipNextAppendLayers?: boolean;
  currentRound?: LLMSessionRoundInfo;
  latestRequestInfo?: LLMSessionRequestInfo;
  latestResponseInfo?: LLMSessionResponseInfo;
  clearedAt?: string;
  clearedAtUtc?: string;
  reason?: string;
};

export type LLMSessionRoundInfo = {
  status: "running" | "finished" | "interrupted";
  round: number;
  startedAt: string;
  startedAtUtc?: string;
  finishedAt?: string;
  finishedAtUtc?: string;
  model?: string;
  temperature?: number;
  tools?: LLMChatInput["tools"];
  extraParams?: Record<string, unknown>;
  presetName?: string;
};

export type LLMSessionRequestInfo = {
  time: string;
  timeUtc?: string;
  round: number;
  model?: string;
  temperature?: number;
  tools?: LLMChatInput["tools"];
  extraParams?: Record<string, unknown>;
  presetName?: string;
  messageCount: number;
};

export type LLMSessionResponseInfo = {
  time: string;
  timeUtc?: string;
  round: number;
  finishReason?: string;
  toolCallCount: number;
};
