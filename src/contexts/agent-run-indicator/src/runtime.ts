import type { AgentRunIndicator, AgentRunIndicatorBeginInput, AgentRunIndicatorSession, AgentRunIndicatorTypingInput } from "./ports.js";

export type AgentRunIndicatorRuntime = AgentRunIndicator & {
  setDelegate(indicator: AgentRunIndicator | undefined): void;
};

export function createAgentRunIndicatorRuntime(): AgentRunIndicatorRuntime {
  let delegate: AgentRunIndicator | undefined;

  return {
    setDelegate(indicator) {
      delegate = indicator;
    },
    begin(input: AgentRunIndicatorBeginInput): Promise<AgentRunIndicatorSession | undefined> {
      return delegate?.begin(input) ?? Promise.resolve(undefined);
    },
    ensureReady(): Promise<void> {
      return delegate?.ensureReady?.() ?? Promise.resolve();
    },
    setTyping(input: AgentRunIndicatorTypingInput): Promise<void> {
      return delegate?.setTyping?.(input) ?? Promise.resolve();
    }
  };
}
