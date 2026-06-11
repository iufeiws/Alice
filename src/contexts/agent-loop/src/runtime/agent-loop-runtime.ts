import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
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

export type AgentLoopRunners = {
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
  isRunning(): boolean;
  setRunners(runners: Partial<AgentLoopRunners>): void;
  requestRun(request: AgentLoopRunRequest): Promise<AgentLoopRunResult>;
  interrupt(reason: string): void;
};

export function createAgentLoopRuntime(input: Partial<AgentLoopRunners> = {}): AgentLoopRuntime {
  let activeMainLLMSession: ActiveMainLLMSessionState | undefined;
  let running = false;
  let generation = 0;
  let abortController: AbortController | undefined;
  let runners: Partial<AgentLoopRunners> = { ...input };

  return {
    getActiveMainLLMSession() {
      return activeMainLLMSession ? { ...activeMainLLMSession } : undefined;
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
      if (!runners.runChat) throw new Error("agent_loop_chat_runner_unavailable");
      return await runners.runChat({
        event: request.event,
        sessionId: request.sessionId,
        reason: request.reason,
        signal
      });
    }
    if (!runners.runTalk) throw new Error("agent_loop_talk_runner_unavailable");
    await runners.runTalk({
      sessionId: request.sessionId,
      reason: request.reason,
      signal
    });
    return [];
  }
}
