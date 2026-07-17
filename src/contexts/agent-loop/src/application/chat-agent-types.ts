import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import type { ChatAgentLoopSession } from "./run-chat-loop.js";
import type { TokenPressurePreviewBaseline } from "./chat-agent-token-pressure.js";

export type LLMSessionClearReason = "prompt_static_changed" | "admin_clear" | "admin_cancel" | "shutdown" | "token_pressure" | "mode_transition" | "mode_timeout" | "yield_end";

export type LLMSessionSnapshot = {
  id?: number;
  messages: LLMChatInput["messages"];
  staticPromptFingerprint?: string;
  staticPromptMessageCount?: number;
  requestTimestamps?: string[];
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
  fixedPrefixStartedAt?: string;
  loopStartedAt?: string;
  waitChatStartedAt?: string;
  waitChatMode?: "wait";
  waitChatUntil?: string;
  waitChatTarget?: ChatAgentLoopSession["waitChatTarget"];
  skipNextAppendLayers?: boolean;
};

export type LLMSessionRecord = ChatAgentLoopSession & {
  id: number;
  messages: LLMChatInput["messages"];
  staticPromptFingerprint: string;
  staticPromptMessageCount: number;
  requestTimestamps: number[];
  lastTotalTokens?: number;
  lastInputTokens?: number;
  lastUsageModel?: string;
  tokenPressurePreviewBaselines: Record<string, TokenPressurePreviewBaseline>;
  mode: string;
  modeStaticMessages: LLMChatInput["messages"];
  modeStaticTokenEstimate: number;
  modeStartedAt?: number;
  modeExpiresAt?: number;
  fixedPrefixKind?: string;
  fixedPrefixStartedAt?: string;
  loopStartedAt?: string;
  waitChatStartedAt?: number;
  waitChatMode?: "wait" ;
  waitChatUntil?: number;
  waitChatTarget?: ChatAgentLoopSession["waitChatTarget"];
  skipNextAppendLayers?: boolean;
};
