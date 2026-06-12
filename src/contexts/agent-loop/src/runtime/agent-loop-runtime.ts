import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import {
  runLLMToolLoop,
  type LLMToolLoopExecution,
  type LLMToolLoopInput,
  type LLMToolLoopResult
} from "../../../llm-gateway/src/llm-tool-loop.js";
import type { AgentEvent, AgentOutput } from "../contracts/agent-contracts.js";

export type AgentLoopKind = "chat" | "talk";

export type AgentLoopPhase = "idle" | "running" | "cancelled";

export type ActiveMainLLMSessionState = {
  id: number | string;
  agentId: AgentLoopKind;
  generation: number;
  phase: AgentLoopPhase;
};

export type ActiveLLMSessionRuntimePort = {
  ensureActiveLLMSession(time: string, agentId?: AgentLoopKind): { id: number | string };
  createTalkLLMSession(time: string): { id: number | string };
  noteActiveLLMRequest(entry: unknown, agentId?: AgentLoopKind): void;
  noteActiveLLMResponse(entry: unknown): void;
  isActiveTalkLLMSession(sessionId: string): boolean;
  loadActiveLLMSessionTranscript(): unknown;
  updateActiveLLMSessionTranscript(session: unknown): void;
  updateActiveTalkLLMSessionTranscript(session: unknown): void;
  rewriteActiveTalkLLMSessionFromRuntime(sessionId: string): void;
  clearActiveLLMSession(reason: unknown): void;
  getActiveLLMSessionSnapshot?(): unknown;
};

export type AgentLoopChatRunRequest = {
  kind: "chat";
  sessionId: string;
  reason: string;
  event: AgentEvent;
};

export type AgentLoopTalkRunRequest = {
  kind: "talk";
  sessionId: string;
  reason: string;
};

export type AgentLoopRunRequest = AgentLoopChatRunRequest | AgentLoopTalkRunRequest;

export type AgentLoopRunResult = {
  started: boolean;
  outputs: AgentOutput[];
};

export type PreparedAgentLoopRun = {
  spec?: AgentFunctionCallLoopSpec;
  prepare?(): Promise<AgentFunctionCallLoopSpec | AgentOutput[] | void> | AgentFunctionCallLoopSpec | AgentOutput[] | void;
  complete(result: AgentFunctionCallLoopResult): Promise<AgentOutput[] | void> | AgentOutput[] | void;
  onError?(error: unknown): Promise<void> | void;
  dispose?(): Promise<void> | void;
};

export type AgentLoopRunners = {
  prepareChat(input: { event: AgentEvent; sessionId: string; reason: string; signal: AbortSignal }): Promise<PreparedAgentLoopRun | AgentOutput[]> | PreparedAgentLoopRun | AgentOutput[];
  prepareTalk(input: { sessionId: string; reason: string; signal: AbortSignal }): Promise<PreparedAgentLoopRun | void> | PreparedAgentLoopRun | void;
};

export type AgentLoopRunSpec = {
  kind: AgentLoopKind;
  agentId: AgentLoopKind;
  sessionId: string;
  messages: LLMChatInput["messages"];
};

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

export type AgentLoopRuntime = {
  getActiveMainLLMSession(): ActiveMainLLMSessionState | undefined;
  setActiveLLMSessionRuntime(runtime: ActiveLLMSessionRuntimePort | undefined): void;
  ensureActiveLLMSession(time: string, agentId?: AgentLoopKind): { id: number | string };
  createTalkLLMSession(time: string): { id: number | string };
  noteActiveLLMRequest(entry: unknown, agentId?: AgentLoopKind): void;
  noteActiveLLMResponse(entry: unknown): void;
  isActiveTalkLLMSession(sessionId: string): boolean;
  loadActiveLLMSessionTranscript(): unknown;
  updateActiveLLMSessionTranscript(session: unknown): void;
  updateActiveTalkLLMSessionTranscript(session: unknown): void;
  rewriteActiveTalkLLMSessionFromRuntime(sessionId: string): void;
  clearActiveLLMSession(reason: unknown): void;
  getActiveLLMSessionSnapshot(): unknown;
  getLoopSessionState<T = unknown>(kind: AgentLoopKind): T | undefined;
  setLoopSessionState<T = unknown>(kind: AgentLoopKind, state: T | undefined): void;
  clearLoopSessionState(kind: AgentLoopKind): void;
  isRunning(): boolean;
  setRunners(runners: Partial<AgentLoopRunners>): void;
  setActiveSessionContext<TSession = unknown>(input: AgentLoopSetActiveSessionContextInput<TSession>): void;
  clearActiveSessionContext<TSession = unknown>(input: AgentLoopClearActiveSessionContextInput<TSession>): boolean;
  createActiveSessionContext<TSession = unknown>(input: AgentLoopCreateActiveSessionContextInput<TSession>): TSession;
  prepareChatSessionContext<TSession = unknown>(input: AgentLoopPrepareChatSessionContextInput<TSession>): Promise<AgentLoopPrepareChatSessionContextResult<TSession>>;
  ensureChatSessionContext<TSession = unknown, TMode = unknown>(input: AgentLoopEnsureChatSessionContextInput<TSession, TMode>): Promise<TSession>;
  prepareSessionContext(input: AgentLoopSessionContextInput): Promise<AgentLoopPreparedSessionContext>;
  appendSessionContext<TSession extends AgentLoopMutableSession>(input: AgentLoopAppendSessionContextInput<TSession>): AgentLoopAppendSessionContextResult<TSession>;
  requestRun(request: AgentLoopRunRequest): Promise<AgentLoopRunResult>;
  interrupt(reason: string): void;
};

export type AgentFunctionCallLoopSpec = LLMToolLoopInput;
export type AgentFunctionCallLoopResult = LLMToolLoopResult;
export type AgentFunctionCallToolExecution = LLMToolLoopExecution;

export function createAgentLoopRuntime(input: Partial<AgentLoopRunners> = {}): AgentLoopRuntime {
  let activeMainLLMSession: ActiveMainLLMSessionState | undefined;
  let running = false;
  let generation = 0;
  let abortController: AbortController | undefined;
  let runners: Partial<AgentLoopRunners> = { ...input };
  let activeLLMSessionRuntime: ActiveLLMSessionRuntimePort | undefined;
  const loopSessionStates = new Map<AgentLoopKind, unknown>();

  return {
    getActiveMainLLMSession() {
      return activeMainLLMSession ? { ...activeMainLLMSession } : undefined;
    },
    setActiveLLMSessionRuntime(runtime) {
      activeLLMSessionRuntime = runtime;
    },
    ensureActiveLLMSession(time, agentId) {
      return requireActiveLLMSessionRuntime().ensureActiveLLMSession(time, agentId);
    },
    createTalkLLMSession(time) {
      return requireActiveLLMSessionRuntime().createTalkLLMSession(time);
    },
    noteActiveLLMRequest(entry, agentId) {
      requireActiveLLMSessionRuntime().noteActiveLLMRequest(entry, agentId);
    },
    noteActiveLLMResponse(entry) {
      requireActiveLLMSessionRuntime().noteActiveLLMResponse(entry);
    },
    isActiveTalkLLMSession(sessionId) {
      return activeLLMSessionRuntime?.isActiveTalkLLMSession(sessionId) ?? false;
    },
    loadActiveLLMSessionTranscript() {
      return activeLLMSessionRuntime?.loadActiveLLMSessionTranscript();
    },
    updateActiveLLMSessionTranscript(session) {
      requireActiveLLMSessionRuntime().updateActiveLLMSessionTranscript(session);
    },
    updateActiveTalkLLMSessionTranscript(session) {
      requireActiveLLMSessionRuntime().updateActiveTalkLLMSessionTranscript(session);
    },
    rewriteActiveTalkLLMSessionFromRuntime(sessionId) {
      requireActiveLLMSessionRuntime().rewriteActiveTalkLLMSessionFromRuntime(sessionId);
    },
    clearActiveLLMSession(reason) {
      requireActiveLLMSessionRuntime().clearActiveLLMSession(reason);
    },
    getActiveLLMSessionSnapshot() {
      return activeLLMSessionRuntime?.getActiveLLMSessionSnapshot?.();
    },
    getLoopSessionState(kind) {
      return loopSessionStates.get(kind) as never;
    },
    setLoopSessionState(kind, state) {
      if (state === undefined) {
        loopSessionStates.delete(kind);
        return;
      }
      loopSessionStates.set(kind, state);
    },
    clearLoopSessionState(kind) {
      loopSessionStates.delete(kind);
    },
    isRunning() {
      return running;
    },
    setRunners(nextRunners) {
      runners = {
        ...runners,
        ...nextRunners
      };
    },
    setActiveSessionContext(input) {
      setAgentLoopActiveSessionContext(input, loopSessionStates);
    },
    clearActiveSessionContext(input) {
      return clearAgentLoopActiveSessionContext(input, loopSessionStates);
    },
    createActiveSessionContext(input) {
      return createAgentLoopActiveSessionContext(input, loopSessionStates);
    },
    prepareChatSessionContext(input) {
      return prepareAgentLoopChatSessionContext(input, loopSessionStates);
    },
    ensureChatSessionContext(input) {
      return ensureAgentLoopChatSessionContext(input);
    },
    prepareSessionContext(input) {
      return prepareAgentLoopSessionContext(input);
    },
    appendSessionContext(input) {
      return appendAgentLoopSessionContext(input);
    },
    async requestRun(request) {
      if (running) return { started: false, outputs: [] };
      generation += 1;
      const runGeneration = generation;
      running = true;
      abortController = new AbortController();
      activeMainLLMSession = {
        id: request.sessionId,
        agentId: request.kind,
        generation: runGeneration,
        phase: "running"
      };
      try {
        const outputs = await executeRequest(request, abortController.signal);
        return { started: true, outputs };
      } finally {
        running = false;
        abortController = undefined;
        if (activeMainLLMSession?.generation === runGeneration) {
          activeMainLLMSession = {
            ...activeMainLLMSession,
            phase: "idle"
          };
        }
      }
    },
    interrupt() {
      abortController?.abort();
      if (activeMainLLMSession) {
        activeMainLLMSession = {
          ...activeMainLLMSession,
          phase: "cancelled"
        };
      }
    }
  };

  async function executeRequest(request: AgentLoopRunRequest, signal: AbortSignal): Promise<AgentOutput[]> {
    if (request.kind === "chat") {
      if (!runners.prepareChat) throw new Error("agent_loop_chat_runner_unavailable");
      return await executePreparedOrOutputs(await runners.prepareChat({
        event: request.event,
        sessionId: request.sessionId,
        reason: request.reason,
        signal
      }));
    }
    if (!runners.prepareTalk) throw new Error("agent_loop_talk_runner_unavailable");
    const prepared = await runners.prepareTalk({
      sessionId: request.sessionId,
      reason: request.reason,
      signal
    });
    if (!prepared) return [];
    return await executePreparedOrOutputs(prepared);
  }

  async function executePreparedOrOutputs(prepared: PreparedAgentLoopRun | AgentOutput[]): Promise<AgentOutput[]> {
    if (Array.isArray(prepared)) return prepared;
    try {
      const spec = await Promise.resolve(prepared.prepare ? prepared.prepare() : prepared.spec);
      if (!spec) return [];
      if (Array.isArray(spec)) return spec;
      const result = await runAgentFunctionCallLoop(spec);
      return await Promise.resolve(prepared.complete(result)) ?? [];
    } catch (error) {
      await prepared.onError?.(error);
      throw error;
    } finally {
      await prepared.dispose?.();
    }
  }

  function requireActiveLLMSessionRuntime(): ActiveLLMSessionRuntimePort {
    if (!activeLLMSessionRuntime) throw new Error("active_llm_session_runtime_unavailable");
    return activeLLMSessionRuntime;
  }
}

export function runAgentFunctionCallLoop(spec: AgentFunctionCallLoopSpec): Promise<AgentFunctionCallLoopResult> {
  return runLLMToolLoop(spec);
}

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

export function setAgentLoopActiveSessionContext<TSession = unknown>(
  input: AgentLoopSetActiveSessionContextInput<TSession>,
  holder?: Map<AgentLoopKind, unknown>
): void {
  input.setLocalSession(input.session);
  if (!holder) return;
  if (input.session === undefined) {
    holder.delete(input.kind);
    return;
  }
  holder.set(input.kind, input.session);
}

export function clearAgentLoopActiveSessionContext<TSession = unknown>(
  input: AgentLoopClearActiveSessionContextInput<TSession>,
  holder?: Map<AgentLoopKind, unknown>
): boolean {
  if (!input.getLocalSession()) return false;
  input.setLocalSession(undefined);
  holder?.delete(input.kind);
  input.onCleared?.();
  return true;
}

export function createAgentLoopActiveSessionContext<TSession = unknown>(
  input: AgentLoopCreateActiveSessionContextInput<TSession>,
  holder?: Map<AgentLoopKind, unknown>
): TSession {
  input.setLocalSession(input.session);
  holder?.set(input.kind, input.session);
  input.updateSession?.(input.session);
  return input.session;
}

export async function prepareAgentLoopChatSessionContext<TSession = unknown>(
  input: AgentLoopPrepareChatSessionContextInput<TSession>,
  holder?: Map<AgentLoopKind, unknown>
): Promise<AgentLoopPrepareChatSessionContextResult<TSession>> {
  const messages = await Promise.resolve(input.buildMessages());
  const session = input.createSession(messages);
  createAgentLoopActiveSessionContext({
    kind: "chat",
    session,
    setLocalSession: input.setLocalSession,
    updateSession: input.updateSession
  }, holder);
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
