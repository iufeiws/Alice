export type AgentRunIndicatorBeginInput = {
  agentId?: string;
  round: number;
  /** 触发该 run 的消息来源账户；无账户上下文（如心跳触发）时为空。 */
  accountId?: string;
};

export type AgentRunIndicatorTypingInput = {
  typing: boolean;
};

export type AgentRunIndicatorToolCall = {
  id?: string;
  name: string;
  arguments: string;
};

export type AgentRunIndicatorToolCallDelta = {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
};

export type AgentRunIndicatorOutput = {
  reasoning: string;
  content: string;
  toolCalls: AgentRunIndicatorToolCall[];
};

export type AgentRunIndicator = {
  begin(input: AgentRunIndicatorBeginInput): Promise<AgentRunIndicatorSession | undefined>;
  ensureReady?(): Promise<void>;
  createFreshCard?(): Promise<void>;
  setTyping?(input: AgentRunIndicatorTypingInput): Promise<void>;
  fail?(error?: unknown): Promise<void>;
};

export type AgentRunIndicatorSession = {
  appendReasoningDelta(delta: string): Promise<void>;
  appendContentDelta(delta: string): Promise<void>;
  appendToolCallDelta(delta: AgentRunIndicatorToolCallDelta): Promise<void>;
  finish(output: AgentRunIndicatorOutput): Promise<void>;
  fail(error: unknown): Promise<void>;
};
