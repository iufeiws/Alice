import type { TokenPressurePreviewBaseline } from "../agent/src/index.js";
import type { LLMChatInput, LLMChatResult } from "../llm/src/index.js";
import type { LLMRequestDiff } from "../llm/src/llm-request-diff.js";

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

export type ActiveLLMSession = {
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
};

export type LLMSessionRequestInfo = {
  time: string;
  timeUtc?: string;
  round: number;
  model?: string;
  temperature?: number;
  tools?: LLMChatInput["tools"];
  extraParams?: Record<string, unknown>;
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
