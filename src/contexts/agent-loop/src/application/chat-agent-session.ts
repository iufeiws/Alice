import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import {
  cloneLLMMessages,
  defaultChatAgentModeState,
  estimateMessagesTokens,
  type ChatAgentModeState
} from "./run-chat-loop.js";
import type { LLMSessionRecord, LLMSessionSnapshot } from "./chat-agent-types.js";
export function hydrateLLMSessionSnapshot(snapshot: LLMSessionSnapshot, nowMs: number): LLMSessionRecord {
  const modeStaticMessages = cloneLLMMessages(snapshot.modeStaticMessages ?? []);
  const mode = snapshot.mode || "normal";
  const parsedModeStartedAt = typeof snapshot.modeStartedAt === "string" ? Date.parse(snapshot.modeStartedAt) : NaN;
  const parsedModeExpiresAt = typeof snapshot.modeExpiresAt === "string" ? Date.parse(snapshot.modeExpiresAt) : NaN;
  return {
    id: Number.isFinite(snapshot.id) ? Number(snapshot.id) : nowMs,
    messages: cloneLLMMessages(snapshot.messages),
    staticPromptFingerprint: snapshot.staticPromptFingerprint ?? "",
    staticPromptMessageCount: typeof snapshot.staticPromptMessageCount === "number" && Number.isFinite(snapshot.staticPromptMessageCount)
      ? Math.max(0, Math.floor(snapshot.staticPromptMessageCount))
      : 0,
    requestTimestamps: (snapshot.requestTimestamps ?? [])
      .map((timestamp) => Date.parse(timestamp))
      .filter((timestamp) => Number.isFinite(timestamp)),
    agentLoopRunSeq: Number.isInteger(snapshot.agentLoopRunSeq) ? snapshot.agentLoopRunSeq : undefined,
    mode,
    modeStaticMessages,
    modeStaticTokenEstimate: Number.isFinite(snapshot.modeStaticTokenEstimate)
      ? Number(snapshot.modeStaticTokenEstimate)
      : estimateMessagesTokens(modeStaticMessages),
    modeStartedAt: mode === "normal"
      ? undefined
      : Number.isFinite(parsedModeStartedAt)
        ? parsedModeStartedAt
        : nowMs,
    modeExpiresAt: Number.isFinite(parsedModeExpiresAt) ? parsedModeExpiresAt : undefined,
    fixedPrefixKind: typeof snapshot.fixedPrefixKind === "string" ? snapshot.fixedPrefixKind : undefined,
    fixedPrefixStartedAt: typeof snapshot.fixedPrefixStartedAt === "string" ? snapshot.fixedPrefixStartedAt : undefined,
    loopStartedAt: typeof snapshot.loopStartedAt === "string" ? snapshot.loopStartedAt : undefined,
    waitChatStartedAt: typeof snapshot.waitChatStartedAt === "string" && Number.isFinite(Date.parse(snapshot.waitChatStartedAt))
      ? Date.parse(snapshot.waitChatStartedAt)
      : undefined,
    waitChatMode: snapshot.waitChatMode === "schedule" || snapshot.waitChatMode === "await_chat" ? snapshot.waitChatMode : undefined,
    waitChatUntil: typeof snapshot.waitChatUntil === "string" && Number.isFinite(Date.parse(snapshot.waitChatUntil))
      ? Date.parse(snapshot.waitChatUntil)
      : undefined,
    waitChatTarget: snapshot.waitChatTarget,
    skipNextAppendLayers: snapshot.skipNextAppendLayers === true ? true : undefined
  };
}

export function defaultModeState(): ChatAgentModeState {
  return defaultChatAgentModeState();
}

export function modeStateFromSession(session: LLMSessionRecord): ChatAgentModeState {
  return {
    mode: session.mode || "normal",
    modeStaticMessages: cloneLLMMessages(session.modeStaticMessages),
    modeStaticTokenEstimate: session.modeStaticTokenEstimate,
    modeStartedAt: session.modeStartedAt,
    modeExpiresAt: session.modeExpiresAt,
    fixedPrefixKind: session.fixedPrefixKind,
    fixedPrefixStartedAt: session.fixedPrefixStartedAt
  };
}

export function isModeExpired(session: LLMSessionRecord, nowMs: number): boolean {
  if (session.mode !== "fixed_prefix") return false;
  if (!Number.isFinite(session.modeExpiresAt)) return false;
  return nowMs >= Number(session.modeExpiresAt);
}

export function createLLMSessionSnapshot(session: LLMSessionRecord): LLMSessionSnapshot & { staticPromptFingerprint: string; requestTimestamps: string[] } {
  return {
    id: session.id,
    messages: cloneLLMMessages(session.messages),
    staticPromptFingerprint: session.staticPromptFingerprint,
    staticPromptMessageCount: session.staticPromptMessageCount,
    requestTimestamps: session.requestTimestamps.map((timestamp) => new Date(timestamp).toISOString()),
    agentLoopRunSeq: session.agentLoopRunSeq,
    mode: session.mode,
    modeStaticMessages: cloneLLMMessages(session.modeStaticMessages),
    modeStaticTokenEstimate: session.modeStaticTokenEstimate,
    modeStartedAt: typeof session.modeStartedAt === "number" ? new Date(session.modeStartedAt).toISOString() : undefined,
    modeExpiresAt: typeof session.modeExpiresAt === "number" ? new Date(session.modeExpiresAt).toISOString() : undefined,
    fixedPrefixKind: session.fixedPrefixKind,
    fixedPrefixStartedAt: session.fixedPrefixStartedAt,
    loopStartedAt: session.loopStartedAt,
    waitChatStartedAt: typeof session.waitChatStartedAt === "number" ? new Date(session.waitChatStartedAt).toISOString() : undefined,
    waitChatMode: session.waitChatMode,
    waitChatUntil: typeof session.waitChatUntil === "number" ? new Date(session.waitChatUntil).toISOString() : undefined,
    waitChatTarget: session.waitChatTarget,
    skipNextAppendLayers: session.skipNextAppendLayers === true ? true : undefined
  };
}
