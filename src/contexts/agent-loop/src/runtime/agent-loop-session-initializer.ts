import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import type { AgentLoopKind } from "./agent-loop-runtime.js";

export type AgentLoopTranscriptSession = {
  messages: LLMChatInput["messages"];
  staticPromptFingerprint?: string;
  staticPromptMessageCount?: number;
  requestTimestamps?: string[];
  lastTotalTokens?: number;
  lastInputTokens?: number;
  lastUsageModel?: string;
  mode?: string;
};

export type AgentLoopMessagePatch = {
  replaceFrom: number;
  messages: LLMChatInput["messages"];
};

export type AgentLoopSessionContextInput = {
  kind: AgentLoopKind;
  sessionId: string;
  loadTranscript(): AgentLoopTranscriptSession | undefined;
  buildInitialMessages(): Promise<LLMChatInput["messages"]> | LLMChatInput["messages"];
  buildMessagePatch(): Promise<AgentLoopMessagePatch> | AgentLoopMessagePatch;
  updateTranscript(session: AgentLoopTranscriptSession): void;
  onConversationStartIndex?(count: number): void;
  onPrefixMessageCount?(count: number): void;
};

export type AgentLoopPreparedSessionContext = {
  session: AgentLoopTranscriptSession;
  prefixMessageCount: number;
};

export type AgentLoopMutableSession = {
  messages: LLMChatInput["messages"];
};

export type AgentLoopAppendSessionContextInput<TSession extends AgentLoopMutableSession = AgentLoopMutableSession> = {
  session: TSession;
  messages: LLMChatInput["messages"];
  updateSession(session: TSession): void;
};

export type AgentLoopAppendSessionContextResult<TSession extends AgentLoopMutableSession = AgentLoopMutableSession> = {
  session: TSession;
  appended: boolean;
};

export type AgentLoopRequestWindowSession = {
  requestTimestamps: number[];
};

export type AgentLoopClaimRequestWindowInput<TSession extends AgentLoopRequestWindowSession = AgentLoopRequestWindowSession> = {
  session: TSession;
  nowMs: number;
  windowMs: number;
  maxRequests: number;
};

export type AgentLoopClaimRequestWindowResult<TSession extends AgentLoopRequestWindowSession = AgentLoopRequestWindowSession> = {
  session: TSession;
  allowed: boolean;
};

export type AgentLoopSetActiveSessionContextInput<TSession = unknown> = {
  kind: AgentLoopKind;
  session: TSession | undefined;
  setLocalSession(session: TSession | undefined): void;
};

export type AgentLoopClearActiveSessionContextInput<TSession = unknown> = {
  kind: AgentLoopKind;
  getLocalSession(): TSession | undefined;
  setLocalSession(session: TSession | undefined): void;
  onCleared?(): void;
};

export type AgentLoopCreateActiveSessionContextInput<TSession = unknown> = {
  kind: AgentLoopKind;
  session: TSession;
  setLocalSession(session: TSession): void;
  updateSession?(session: TSession): void;
};

export type AgentLoopPrepareChatSessionContextInput<TSession = unknown> = {
  buildMessages(): Promise<LLMChatInput["messages"]> | LLMChatInput["messages"];
  createSession(messages: LLMChatInput["messages"]): TSession;
  setLocalSession(session: TSession): void;
  updateSession?(session: TSession): void;
};

export type AgentLoopPrepareChatSessionContextResult<TSession = unknown> = {
  session: TSession;
  messages: LLMChatInput["messages"];
};

export type AgentLoopEnsureChatSessionContextInput<TSession = unknown, TMode = unknown> = {
  getSession(): TSession | undefined;
  getPendingMode(): TMode | undefined;
  setPendingMode(mode: TMode | undefined): void;
  defaultMode(): TMode;
  shouldClearForInitiatedBehavior(session: TSession): boolean;
  isModeExpired(session: TSession): boolean;
  isHydratedFixedPrefixPendingRebuild(session: TSession): boolean;
  isStaticPromptChanged(session: TSession): boolean;
  shouldResetForTokenPressure(session: TSession): Promise<boolean> | boolean;
  modeFromSession(session: TSession): TMode;
  clearSession(reason?: string): boolean;
  prepareSession(mode: TMode): Promise<TSession> | TSession;
};

export async function prepareAgentLoopSessionContext(input: AgentLoopSessionContextInput): Promise<AgentLoopPreparedSessionContext> {
  let session = input.loadTranscript();
  if (!session || session.messages.length === 0) {
    const initialMessages = await Promise.resolve(input.buildInitialMessages());
    session = {
      messages: initialMessages,
      staticPromptFingerprint: input.kind,
      staticPromptMessageCount: initialMessages.length,
      requestTimestamps: [],
      mode: "normal"
    };
    input.updateTranscript(session);
  }
  const prefixMessageCount = session.staticPromptMessageCount ?? session.messages.length;
  input.onConversationStartIndex?.(prefixMessageCount);
  input.onPrefixMessageCount?.(prefixMessageCount);
  const patch = await Promise.resolve(input.buildMessagePatch());
  session = {
    ...session,
    messages: [
      ...session.messages.slice(0, patch.replaceFrom),
      ...patch.messages
    ]
  };
  input.updateTranscript(session);
  return {
    session,
    prefixMessageCount
  };
}

export function appendAgentLoopSessionContext<TSession extends AgentLoopMutableSession>(
  input: AgentLoopAppendSessionContextInput<TSession>
): AgentLoopAppendSessionContextResult<TSession> {
  if (input.messages.length === 0) {
    return {
      session: input.session,
      appended: false
    };
  }
  input.session.messages = [
    ...input.session.messages,
    ...input.messages
  ];
  input.updateSession(input.session);
  return {
    session: input.session,
    appended: true
  };
}

export function claimAgentLoopRequestWindow<TSession extends AgentLoopRequestWindowSession>(
  input: AgentLoopClaimRequestWindowInput<TSession>
): AgentLoopClaimRequestWindowResult<TSession> {
  input.session.requestTimestamps = input.session.requestTimestamps
    .filter((timestamp) => input.nowMs - timestamp < input.windowMs);
  if (input.session.requestTimestamps.length >= input.maxRequests) {
    return {
      session: input.session,
      allowed: false
    };
  }
  input.session.requestTimestamps.push(input.nowMs);
  return {
    session: input.session,
    allowed: true
  };
}

export function setAgentLoopActiveSessionContext<TSession = unknown>(
  input: AgentLoopSetActiveSessionContextInput<TSession>
): void {
  input.setLocalSession(input.session);
}

export function clearAgentLoopActiveSessionContext<TSession = unknown>(
  input: AgentLoopClearActiveSessionContextInput<TSession>
): boolean {
  if (!input.getLocalSession()) return false;
  input.setLocalSession(undefined);
  input.onCleared?.();
  return true;
}

export function createAgentLoopActiveSessionContext<TSession = unknown>(
  input: AgentLoopCreateActiveSessionContextInput<TSession>
): TSession {
  input.setLocalSession(input.session);
  input.updateSession?.(input.session);
  return input.session;
}

export async function prepareAgentLoopChatSessionContext<TSession = unknown>(
  input: AgentLoopPrepareChatSessionContextInput<TSession>
): Promise<AgentLoopPrepareChatSessionContextResult<TSession>> {
  const messages = await Promise.resolve(input.buildMessages());
  const session = input.createSession(messages);
  createAgentLoopActiveSessionContext({
    kind: "chat",
    session,
    setLocalSession: input.setLocalSession,
    updateSession: input.updateSession
  });
  return {
    session,
    messages
  };
}

export async function ensureAgentLoopChatSessionContext<TSession = unknown, TMode = unknown>(
  input: AgentLoopEnsureChatSessionContextInput<TSession, TMode>
): Promise<TSession> {
  let session = input.getSession();
  if (session && input.shouldClearForInitiatedBehavior(session) && !input.getPendingMode()) {
    input.clearSession("mode_transition");
  }

  session = input.getSession();
  if (session && input.isModeExpired(session)) {
    input.clearSession("mode_timeout");
    input.setPendingMode(input.defaultMode());
  }

  session = input.getSession();
  if (session && input.isHydratedFixedPrefixPendingRebuild(session) && !input.getPendingMode()) {
    const mode = input.modeFromSession(session);
    input.clearSession();
    input.setPendingMode(mode);
  }

  session = input.getSession();
  if (session && input.isStaticPromptChanged(session)) {
    const mode = input.modeFromSession(session);
    input.clearSession("prompt_static_changed");
    input.setPendingMode(mode);
  }

  session = input.getSession();
  if (session && await Promise.resolve(input.shouldResetForTokenPressure(session))) {
    const mode = input.modeFromSession(session);
    input.clearSession("token_pressure");
    input.setPendingMode(mode);
  }

  session = input.getSession();
  if (!session) {
    const mode = input.getPendingMode() ?? input.defaultMode();
    input.setPendingMode(undefined);
    session = await Promise.resolve(input.prepareSession(mode));
  }
  if (!session) throw new Error("llm_session_unavailable");
  return session;
}
