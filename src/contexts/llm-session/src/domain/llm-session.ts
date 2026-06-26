import type { LLMChatInput, LLMChatResult } from "../../../llm-gateway/src/index.js";
import type { LLMRequestDiff } from "../../../llm-gateway/src/llm-request-diff.js";

export type LLMSessionClearReason = "prompt_static_changed" | "admin_clear" | "admin_cancel" | "shutdown" | "token_pressure" | "mode_transition" | "mode_timeout";
export type LLMSessionSnapshot = {
  id?: number;
  messages: LLMChatInput["messages"];
  staticPromptFingerprint?: string;
  staticPromptMessageCount?: number;
  requestTimestamps?: string[];
  agentLoopRunSeq?: number;
  currentRound?: number;
  lastTotalTokens?: number;
  lastInputTokens?: number;
  lastUsageModel?: string;
  tokenPressurePreviewBaselines?: Record<string, TokenPressurePreviewBaseline>;
  mode?: string;
  modeStaticMessages?: LLMChatInput["messages"];
  modeStaticTokenEstimate?: number;
  modeStartedAt?: string;
  modeExpiresAt?: string;
  fixedPrefixKind?: string;
  fixedPrefixCursorMessageId?: number;
  waitChatStartedAt?: string;
};

export type TokenPressurePreviewBaseline = {
  inputTokens: number;
  previewTokens: number;
};

export type LLMRequestLogEntry = {
  id: number;
  agentId?: "chat" | "talk";
  sessionId?: number;
  time: string;
  timeUtc?: string;
  model?: string;
  temperature?: number;
  messages: LLMChatInput["messages"];
  tools?: LLMChatInput["tools"];
  extraParams?: Record<string, unknown>;
  presetName?: string;
  rawRequest?: unknown;
  diffFromPrevious?: LLMRequestDiff;
};

export type LLMRequestPreview = LLMRequestLogEntry & {
  source: "preview" | "actual";
  conversationId?: string;
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
  agentId?: "chat" | "talk";
  startedAt: string;
  startedAtUtc?: string;
  updatedAt: string;
  updatedAtUtc?: string;
  archiveFilePath?: string;
  archiveMetadata?: Record<string, unknown>;
  requestIds: number[];
  responseIds: number[];
  messages: LLMChatInput["messages"];
  latestRequest?: unknown;
  staticPromptFingerprint?: string;
  staticPromptMessageCount?: number;
  requestTimestamps: string[];
  agentLoopRunSeq?: number;
  lastTotalTokens?: number;
  lastInputTokens?: number;
  lastUsageModel?: string;
  tokenPressurePreviewBaselines?: Record<string, TokenPressurePreviewBaseline>;
  mode?: string;
  modeStaticMessages?: LLMChatInput["messages"];
  modeStaticTokenEstimate?: number;
  modeStartedAt?: string;
  modeExpiresAt?: string;
  fixedPrefixKind?: string;
  fixedPrefixCursorMessageId?: number;
  waitChatStartedAt?: string;
  currentRound?: LLMSessionRoundInfo;
  latestRequestInfo?: LLMSessionRequestInfo;
  latestResponseInfo?: LLMSessionResponseInfo;
  clearedAt?: string;
  clearedAtUtc?: string;
  reason?: string;
  requests?: LLMRequestLogEntry[];
  responses?: LLMResponseLogEntry[];
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
  usage?: LLMChatResult["usage"];
  toolCallCount: number;
};
