import type { AgentBehaviorState, AgentStateSnapshot, AgentStateStore } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";

export function memoryStore(initial?: string): AgentStateStore & { content?: string } {
  return {
    content: initial,
    read() {
      return this.content;
    },
    write(content) {
      this.content = content;
    }
  };
}

export function persistedSnapshot(input: Partial<AgentStateSnapshot> & { state: AgentBehaviorState }): string {
  return JSON.stringify({
    intimacy: 50,
    updatedAt: "2026-05-25T00:00:00.000",
    responseDelayMs: 1000,
    ...input
  });
}
