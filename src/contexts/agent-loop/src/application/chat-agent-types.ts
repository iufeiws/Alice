import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import type { ChatAgentLoopSession } from "./run-chat-loop.js";

export type LLMSessionClearReason = "prompt_static_changed" | "admin_clear" | "admin_cancel" | "mode_transition" | "mode_timeout" | "yield_end" | "process_restart_recovery_failed" | "force_wake" | "force_clear";

export type LLMSessionSnapshot = {
  id?: number;
  messages: LLMChatInput["messages"];
  staticPromptFingerprint?: string;
  staticPromptMessageCount?: number;
  requestTimestamps?: string[];
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
  waitChatMode?: "schedule" | "await_chat";
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
  mode: string;
  modeStaticMessages: LLMChatInput["messages"];
  modeStaticTokenEstimate: number;
  modeStartedAt?: number;
  modeExpiresAt?: number;
  fixedPrefixKind?: string;
  fixedPrefixStartedAt?: string;
  loopStartedAt?: string;
  waitChatStartedAt?: number;
  waitChatMode?: "schedule" | "await_chat" ;
  waitChatUntil?: number;
  waitChatTarget?: ChatAgentLoopSession["waitChatTarget"];
  skipNextAppendLayers?: boolean;
};
