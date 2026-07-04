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
  agentLoopRunSeq: number;
  phase: AgentLoopPhase;
};

export type LLMSessionRuntimePort = {
  ensureCurrentLLMSession(time: string, agentId?: AgentLoopKind): { id: number | string };
  createTalkLLMSession(time: string): { id: number | string };
  noteLLMRequest(entry: unknown, agentId?: AgentLoopKind): void;
  noteLLMResponse(entry: unknown): void;
  isActiveTalkLLMSession(sessionId: number): boolean;
  loadCurrentLLMSessionTranscript(): unknown;
  updateCurrentLLMSessionTranscript(session: unknown): void;
  updateActiveTalkLLMSessionTranscript(session: unknown): void;
  rewriteActiveTalkLLMSessionFromRuntime(sessionId: number): void;
  clearCurrentLLMSession(reason: unknown): void;
  getCurrentLLMSessionSnapshot?(): unknown;
};

export type AgentLoopChatRunRequest = {
  kind: "chat";
  sessionId: string;
  reason: string;
  event: AgentEvent;
};

export type AgentLoopTalkRunRequest = {
  kind: "talk";
  sessionId: number;
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
  prepareChat(input: { event: AgentEvent; sessionId: string; reason: string; signal: AbortSignal; agentLoopRunSeq: number }): Promise<PreparedAgentLoopRun | AgentOutput[]> | PreparedAgentLoopRun | AgentOutput[];
  prepareTalk(input: { sessionId: number; reason: string; signal: AbortSignal; agentLoopRunSeq: number }): Promise<PreparedAgentLoopRun | void> | PreparedAgentLoopRun | void;
};

export type AgentLoopRunSpec = {
  kind: AgentLoopKind;
  agentId: AgentLoopKind;
  sessionId: string | number;
  messages: LLMChatInput["messages"];
};

export type AgentLoopRuntime = {
  getActiveMainLLMSession(): ActiveMainLLMSessionState | undefined;
  noteInboundUserMessageInterrupt(sessionId: string): void;
  setLLMSessionRuntime(runtime: LLMSessionRuntimePort | undefined): void;
  ensureCurrentLLMSession(time: string, agentId?: AgentLoopKind): { id: number | string };
  createTalkLLMSession(time: string): { id: number | string };
  noteLLMRequest(entry: unknown, agentId?: AgentLoopKind): void;
  noteLLMResponse(entry: unknown): void;
  isActiveTalkLLMSession(sessionId: number): boolean;
  loadCurrentLLMSessionTranscript(): unknown;
  updateCurrentLLMSessionTranscript(session: unknown): void;
  updateActiveTalkLLMSessionTranscript(session: unknown): void;
  rewriteActiveTalkLLMSessionFromRuntime(sessionId: number): void;
  clearCurrentLLMSession(reason: unknown): void;
  getCurrentLLMSessionSnapshot(): unknown;
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
  let agentLoopRunSeq = 0;
  let abortController: AbortController | undefined;
  let runners: Partial<AgentLoopRunners> = { ...input };
  let llmSessionRuntime: LLMSessionRuntimePort | undefined;
  const pendingUserMessageInterrupts = new Set<string>();

  return {
    getActiveMainLLMSession() {
      return activeMainLLMSession ? { ...activeMainLLMSession } : undefined;
    },
    noteInboundUserMessageInterrupt(sessionId) {
      if (!activeMainLLMSession || activeMainLLMSession.phase !== "running") return;
      if (String(activeMainLLMSession.id) !== sessionId) return;
      pendingUserMessageInterrupts.add(sessionId);
    },
    setLLMSessionRuntime(runtime) {
      llmSessionRuntime = runtime;
    },
    ensureCurrentLLMSession(time, agentId) {
      return requireLLMSessionRuntime().ensureCurrentLLMSession(time, agentId);
    },
    createTalkLLMSession(time) {
      return requireLLMSessionRuntime().createTalkLLMSession(time);
    },
    noteLLMRequest(entry, agentId) {
      requireLLMSessionRuntime().noteLLMRequest(entry, agentId);
    },
    noteLLMResponse(entry) {
      requireLLMSessionRuntime().noteLLMResponse(entry);
    },
    isActiveTalkLLMSession(sessionId) {
      return llmSessionRuntime?.isActiveTalkLLMSession(sessionId) ?? false;
    },
    loadCurrentLLMSessionTranscript() {
      return llmSessionRuntime?.loadCurrentLLMSessionTranscript();
    },
    updateCurrentLLMSessionTranscript(session) {
      requireLLMSessionRuntime().updateCurrentLLMSessionTranscript(session);
    },
    updateActiveTalkLLMSessionTranscript(session) {
      requireLLMSessionRuntime().updateActiveTalkLLMSessionTranscript(session);
    },
    rewriteActiveTalkLLMSessionFromRuntime(sessionId) {
      requireLLMSessionRuntime().rewriteActiveTalkLLMSessionFromRuntime(sessionId);
    },
    clearCurrentLLMSession(reason) {
      requireLLMSessionRuntime().clearCurrentLLMSession(reason);
    },
    getCurrentLLMSessionSnapshot() {
      return llmSessionRuntime?.getCurrentLLMSessionSnapshot?.();
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
    },
    clearActiveSessionContext(input) {
      return clearAgentLoopActiveSessionContext(input);
    },
    createActiveSessionContext(input) {
      return createAgentLoopActiveSessionContext(input);
    },
    prepareChatSessionContext(input) {
      return prepareAgentLoopChatSessionContext({
        ...input,
        updateSession: (session) => {
          input.updateSession?.(session);
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
      agentLoopRunSeq += 1;
      const runSeq = agentLoopRunSeq;
      running = true;
      abortController = new AbortController();
      activeMainLLMSession = {
        id: request.sessionId,
        agentId: request.kind,
        agentLoopRunSeq: runSeq,
        phase: "running"
      };
      try {
        const outputs = await executeRequest(request, abortController.signal, runSeq);
        return { started: true, outputs };
      } finally {
        running = false;
        abortController = undefined;
        if (activeMainLLMSession?.agentLoopRunSeq === runSeq) {
          activeMainLLMSession = {
            ...activeMainLLMSession,
            phase: "idle"
          };
        }
        pendingUserMessageInterrupts.delete(String(request.sessionId));
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

  async function executeRequest(request: AgentLoopRunRequest, signal: AbortSignal, agentLoopRunSeq: number): Promise<AgentOutput[]> {
    if (request.kind === "chat") {
      if (!runners.prepareChat) throw new Error("agent_loop_chat_runner_unavailable");
      return await executePreparedOrOutputs(await runners.prepareChat({
        event: request.event,
        sessionId: request.sessionId,
        reason: request.reason,
        signal,
        agentLoopRunSeq
      }), request);
    }
    if (!runners.prepareTalk) throw new Error("agent_loop_talk_runner_unavailable");
    const prepared = await runners.prepareTalk({
      sessionId: request.sessionId,
      reason: request.reason,
      signal,
      agentLoopRunSeq
    });
    if (!prepared) return [];
    return await executePreparedOrOutputs(prepared, request);
  }

  async function executePreparedOrOutputs(prepared: PreparedAgentLoopRun | AgentOutput[], request: AgentLoopRunRequest): Promise<AgentOutput[]> {
    if (Array.isArray(prepared)) return prepared;
    try {
      const spec = await Promise.resolve(prepared.prepare ? prepared.prepare() : prepared.spec);
      if (!spec) return [];
      if (Array.isArray(spec)) return spec;
      const result = await runAgentFunctionCallLoop({
        ...spec,
        runtimeInterrupts: {
          ...spec.runtimeInterrupts,
          hasPendingUserMessage() {
            const sessionId = String(request.sessionId);
            return pendingUserMessageInterrupts.has(sessionId)
              || spec.runtimeInterrupts?.hasPendingUserMessage() === true;
          },
          consumePendingUserMessage() {
            const sessionId = String(request.sessionId);
            return pendingUserMessageInterrupts.delete(sessionId)
              || spec.runtimeInterrupts?.consumePendingUserMessage() === true;
          }
        }
      });
      return await Promise.resolve(prepared.complete(result)) ?? [];
    } catch (error) {
      await prepared.onError?.(error);
      throw error;
    } finally {
      await prepared.dispose?.();
    }
  }

  function requireLLMSessionRuntime(): LLMSessionRuntimePort {
    if (!llmSessionRuntime) throw new Error("llm_session_runtime_unavailable");
    return llmSessionRuntime;
  }
}

export function runAgentFunctionCallLoop(spec: AgentFunctionCallLoopSpec): Promise<AgentFunctionCallLoopResult> {
  return runLLMToolLoop(spec);
}

export * from "./agent-loop-session-initializer.js";
