export type AgentRunIndicatorBeginInput = {
  agentId?: string;
  round: number;
};

export type AgentRunIndicatorTypingInput = {
  typing: boolean;
};

export type AgentRunIndicator = {
  begin(input: AgentRunIndicatorBeginInput): Promise<AgentRunIndicatorSession | undefined>;
  ensureReady?(): Promise<void>;
  createFreshCard?(): Promise<void>;
  setTyping?(input: AgentRunIndicatorTypingInput): Promise<void>;
};

export type AgentRunIndicatorSession = {
  appendReasoningDelta(delta: string): Promise<void>;
  appendContentDelta(delta: string): Promise<void>;
  appendToolCall(input: Record<string, unknown>): Promise<void>;
  finish(): Promise<void>;
  fail(error: unknown): Promise<void>;
};
