import type { LLMChatInput } from "../../../llm-gateway/src/index.js";

export type AgentLoopKind = "chat" | "talk";

export type AgentLoopPhase = "idle" | "running" | "cancelled";

export type ActiveMainLLMSessionState = {
  id: number | string;
  agentId: AgentLoopKind;
  generation: number;
  phase: AgentLoopPhase;
};

export type AgentLoopRunRequest = {
  kind: AgentLoopKind;
  sessionId: string;
  reason: string;
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
  requestRun(request: AgentLoopRunRequest): Promise<void>;
  interrupt(reason: string): void;
};

export function createAgentLoopRuntime(): AgentLoopRuntime {
  let activeMainLLMSession: ActiveMainLLMSessionState | undefined;
  let running = false;
  let generation = 0;
  let abortController: AbortController | undefined;

  return {
    getActiveMainLLMSession() {
      return activeMainLLMSession ? { ...activeMainLLMSession } : undefined;
    },
    isRunning() {
      return running;
    },
    async requestRun(request) {
      if (running) return;
      generation += 1;
      running = true;
      abortController = new AbortController();
      activeMainLLMSession = {
        id: request.sessionId,
        agentId: request.kind,
        generation,
        phase: "running"
      };
      try {
        // Execution will move here after chat/talk loop inputs are split into run specs.
      } finally {
        running = false;
        abortController = undefined;
        if (activeMainLLMSession?.generation === generation) {
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
}
