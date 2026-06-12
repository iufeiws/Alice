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
  runChat(input: { event: AgentEvent; sessionId: string; reason: string; signal: AbortSignal }): Promise<AgentOutput[]> | AgentOutput[];
  runTalk(input: { sessionId: string; reason: string; signal: AbortSignal }): Promise<void> | void;
};

export type AgentLoopRunSpec = {
  kind: AgentLoopKind;
  agentId: AgentLoopKind;
  sessionId: string;
  messages: LLMChatInput["messages"];
};

export type AgentLoopRuntime = {
  getActiveMainLLMSession(): ActiveMainLLMSessionState | undefined;
  getLoopSessionState<T = unknown>(kind: AgentLoopKind): T | undefined;
  setLoopSessionState<T = unknown>(kind: AgentLoopKind, state: T | undefined): void;
  clearLoopSessionState(kind: AgentLoopKind): void;
  isRunning(): boolean;
  setRunners(runners: Partial<AgentLoopRunners>): void;
  runFunctionCallLoop(spec: AgentFunctionCallLoopSpec): Promise<AgentFunctionCallLoopResult>;
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
  const loopSessionStates = new Map<AgentLoopKind, unknown>();

  return {
    getActiveMainLLMSession() {
      return activeMainLLMSession ? { ...activeMainLLMSession } : undefined;
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
    runFunctionCallLoop(spec) {
      return runAgentFunctionCallLoop(spec);
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
      if (runners.prepareChat) {
        return await executePreparedOrOutputs(await runners.prepareChat({
          event: request.event,
          sessionId: request.sessionId,
          reason: request.reason,
          signal
        }));
      }
      if (!runners.runChat) throw new Error("agent_loop_chat_runner_unavailable");
      return await runners.runChat({
        event: request.event,
        sessionId: request.sessionId,
        reason: request.reason,
        signal
      });
    }
    if (runners.prepareTalk) {
      const prepared = await runners.prepareTalk({
        sessionId: request.sessionId,
        reason: request.reason,
        signal
      });
      if (!prepared) return [];
      return await executePreparedOrOutputs(prepared);
    }
    if (!runners.runTalk) throw new Error("agent_loop_talk_runner_unavailable");
    await runners.runTalk({
      sessionId: request.sessionId,
      reason: request.reason,
      signal
    });
    return [];
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
}

export function runAgentFunctionCallLoop(spec: AgentFunctionCallLoopSpec): Promise<AgentFunctionCallLoopResult> {
  return runLLMToolLoop(spec);
}
