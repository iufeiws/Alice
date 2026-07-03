import type { AgentStateStore } from "../../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";

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
