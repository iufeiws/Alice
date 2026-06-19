import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import {
  runLLMToolLoop,
  type LLMToolLoopExecution,
  type LLMToolLoopInput,
  type LLMToolLoopResult
} from "../../../llm-gateway/src/llm-tool-loop.js";
import type { AgentEvent, AgentOutput } from "../contracts/agent-contracts.js";
import {
  appendAgentLoopSessionContext,
  clearAgentLoopActiveSessionContext,
  createAgentLoopActiveSessionContext,
  ensureAgentLoopChatSessionContext,
  prepareAgentLoopChatSessionContext,
  prepareAgentLoopSessionContext,
  setAgentLoopActiveSessionContext,
  type AgentLoopAppendSessionContextInput,
  type AgentLoopAppendSessionContextResult,
  type AgentLoopClearActiveSessionContextInput,
  type AgentLoopCreateActiveSessionContextInput,
  type AgentLoopEnsureChatSessionContextInput,
  type AgentLoopMutableSession,
  type AgentLoopPreparedSessionContext,
  type AgentLoopPrepareChatSessionContextInput,
  type AgentLoopPrepareChatSessionContextResult,
  type AgentLoopSessionContextInput,
  type AgentLoopSetActiveSessionContextInput,
  type AgentLoopTranscriptSession
} from "./agent-loop-session-initializer.js";

export type AgentLoopKind = "chat" | "talk";

export type AgentLoopPhase = "idle" | "running" | "cancelled";

export type ActiveMainLLMSessionState = {
  id: number | string;
  agentId: AgentLoopKind;
  generation: number;
  phase: AgentLoopPhase;
};

export type ActiveMainSessionContext<TState = unknown> = {
  kind: AgentLoopKind;
  session: TState;
};

export type ActiveLLMSessionRuntimePort = {
  ensureActiveLLMSession(time: string, agentId?: AgentLoopKind): { id: number | string };
  createTalkLLMSession(time: string): { id: number | string };
  noteActiveLLMRequest(entry: unknown, agentId?: AgentLoopKind): void;
  noteActiveLLMResponse(entry: unknown): void;
  isActiveTalkLLMSession(sessionId: number): boolean;
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

export type AgentLoopRuntime = {
  getActiveMainLLMSession(): ActiveMainLLMSessionState | undefined;
  setActiveLLMSessionRuntime(runtime: ActiveLLMSessionRuntimePort | undefined): void;
  ensureActiveLLMSession(time: string, agentId?: AgentLoopKind): { id: number | string };
  createTalkLLMSession(time: string): { id: number | string };
  noteActiveLLMRequest(entry: unknown, agentId?: AgentLoopKind): void;
  noteActiveLLMResponse(entry: unknown): void;
  isActiveTalkLLMSession(sessionId: number): boolean;
  loadActiveLLMSessionTranscript(): unknown;
  updateActiveLLMSessionTranscript(session: unknown): void;
  updateActiveTalkLLMSessionTranscript(session: unknown): void;
  rewriteActiveTalkLLMSessionFromRuntime(sessionId: string): void;
  clearActiveLLMSession(reason: unknown): void;
  getActiveLLMSessionSnapshot(): unknown;
  getActiveMainSessionContext<T = unknown>(): ActiveMainSessionContext<T> | undefined;
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
  let activeMainSessionContext: ActiveMainSessionContext | undefined;

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
    getActiveMainSessionContext() {
      return activeMainSessionContext
        ? { ...activeMainSessionContext } as never
        : undefined;
    },
    getLoopSessionState(kind) {
      return activeMainSessionContext?.kind === kind
        ? activeMainSessionContext.session as never
        : undefined;
    },
    setLoopSessionState(kind, state) {
      if (state === undefined) {
        if (activeMainSessionContext?.kind === kind) activeMainSessionContext = undefined;
        return;
      }
      activeMainSessionContext = { kind, session: state };
    },
    clearLoopSessionState(kind) {
      if (activeMainSessionContext?.kind === kind) activeMainSessionContext = undefined;
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
      setAgentLoopActiveSessionContext(input);
      this.setLoopSessionState(input.kind, input.session);
    },
    clearActiveSessionContext(input) {
      const cleared = clearAgentLoopActiveSessionContext(input);
      if (cleared) this.clearLoopSessionState(input.kind);
      return cleared;
    },
    createActiveSessionContext(input) {
      const session = createAgentLoopActiveSessionContext(input);
      this.setLoopSessionState(input.kind, session);
      return session;
    },
    prepareChatSessionContext(input) {
      return prepareAgentLoopChatSessionContext({
        ...input,
        updateSession: (session) => {
          input.updateSession?.(session);
          this.setLoopSessionState("chat", session);
        }
      });
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

export * from "./agent-loop-session-initializer.js";
