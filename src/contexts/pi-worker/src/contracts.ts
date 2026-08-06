import type { ToolExecutionContext, ToolResult } from "../../agent-loop/src/contracts/agent-contracts.js";

export type PiToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type PiContent =
  | { type: "text"; text: string }
  | { type: "image"; path: string; mime?: string };

export type PiToolExecutionResult = {
  ok: boolean;
  content?: PiContent[];
  output?: unknown;
  error?: string;
  details?: unknown;
};

export type PiWorkerHealth = {
  ready: boolean;
  /** Subagent invocations currently queued or running inside the worker. */
  activeRuns: number;
  version: string;
  toolDefinitionGeneration: string;
  cwd: string;
  relayReachable: boolean;
  toolDefinitions: PiToolDefinition[];
};

/**
 * Invocation status. queued/running belong to a live invocation; the terminal
 * statuses are the last observed outcome of an invocation. A Pi session itself
 * has no terminal state and can be invoked again after it is idle.
 */
export type PiInvocationStatus = "queued" | "running" | "completed" | "failed" | "interrupted" | "timed_out" | "aborted";

/** Model runtime fields the container accepts; sampling stays on the relay. */
export type PiModelConfig = {
  model: string;
  maxTokens?: number;
  supportsImage: boolean;
  reasoning: boolean;
};

/**
 * One invocation on a persistent Pi session. `invocationId` is the stable
 * Pi JSONL entry id of the `alice_pi_invocation` custom entry that represents
 * the invocation; it never comes from an Alice-generated id.
 */
export type PiInvocation = {
  invocationId: string;
  sessionId: string;
  status: PiInvocationStatus;
};

/** Lightweight runtime projection of a Pi session; not an Alice session mirror. */
export type PiSessionSnapshot = {
  sessionId: string;
  idle: boolean;
  invocationStatus?: PiInvocationStatus;
  createdAt: string;
  updatedAt: string;
  /** All terminal invocations observed so far; the host watcher deduplicates. */
  terminalCompletions?: PiInvocationCompletion[];
  /** Latest terminal invocation payload, used by the host completion watcher. */
  lastInvocation?: PiInvocationCompletion;
};

export type PiSessionListEntry = {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type PiVisibleMessage = { role: "user" | "assistant"; content: unknown };

export type PiSubAgentStatus = {
  updatedAt: string;
  messages: number;
  status: PiInvocationStatus;
};

export type PiSubAgentWaitResult =
  | { status: "running" }
  | { status: "completed"; message: PiVisibleMessage & { role: "assistant" } }
  | { status: Exclude<PiInvocationStatus, "queued" | "running" | "completed"> };

/** Completion payload produced when an invocation finishes. */
export type PiInvocationCompletion = {
  sessionId: string;
  invocationId: string;
  status: Exclude<PiInvocationStatus, "queued" | "running">;
  /** Final assistant content, or the accurate error text for failed statuses. */
  text: string;
  /** Invocation-time message target saved in the Pi custom entry. */
  messageTarget?: Record<string, unknown>;
};

export type PiWorkerClient = {
  configure(input: { relayUrl: string; relayToken: string }): Promise<{ ok: true }>;
  health(signal?: AbortSignal): Promise<PiWorkerHealth>;
  executeTool(input: { requestId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }): Promise<PiToolExecutionResult>;
  startInvocation(input: PiInvocationStartInput & { signal?: AbortSignal }): Promise<PiInvocation>;
  sendInvocation(sessionId: string, input: PiInvocationSendInput & { signal?: AbortSignal }): Promise<PiInvocation>;
  listSessions(signal?: AbortSignal): Promise<PiSessionListEntry[]>;
  sessionMessages(sessionId: string, access: string, signal?: AbortSignal): Promise<PiVisibleMessage[]>;
  sessionStatus(sessionId: string, signal?: AbortSignal): Promise<PiSessionSnapshot>;
  subAgentStatus(sessionId: string, signal?: AbortSignal): Promise<PiSubAgentStatus>;
  waitSession(sessionId: string, timeoutSeconds?: number, signal?: AbortSignal): Promise<PiSubAgentWaitResult>;
  cancelSession(sessionId: string, signal?: AbortSignal): Promise<"cancelled">;
  forkSession(sessionId: string, entryId?: string, signal?: AbortSignal): Promise<{ sessionId: string }>;
  previewSession(input: PiModelConfig & { signal?: AbortSignal }): Promise<{ sessionId: string; systemPrompt: string }>;
};

export type PiInvocationStartInput = {
  message: string;
  timeoutSeconds?: number;
  messageTarget?: Record<string, unknown>;
} & PiModelConfig;

export type PiInvocationSendInput = {
  message: string;
  timeoutSeconds?: number;
  messageTarget?: Record<string, unknown>;
} & PiModelConfig;

export type PiWorkerRuntime = {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * 更新 worker 授权: 状态切换(wake)或配置变更(config)时调用。
   * 由宿主 refreshAuthorization 执行一次握手; 容器重建不是本运行时职责。
   */
  refresh(reason: "wake" | "config"): Promise<void>;
  health(): Promise<PiWorkerHealth>;
  previewPrompt(input?: { presetName?: string; signal?: AbortSignal }): Promise<{ sessionId: string; systemPrompt: string }>;
  toolDefinitions(): PiToolDefinition[];
  executeTool(input: { requestId: string; toolName: string; input: Record<string, unknown>; context?: ToolExecutionContext }): Promise<PiToolExecutionResult>;
  startSubAgent(input: { message: string; timeoutSeconds?: number; messageTarget?: Record<string, unknown>; presetName?: string; signal?: AbortSignal }): Promise<PiInvocation>;
  listSubAgents(signal?: AbortSignal): Promise<PiSessionListEntry[]>;
  messagesSubAgent(sessionId: string, access: string, signal?: AbortSignal): Promise<PiVisibleMessage[]>;
  sendSubAgent(sessionId: string, input: { message: string; timeoutSeconds?: number; messageTarget?: Record<string, unknown>; presetName?: string; signal?: AbortSignal }): Promise<PiInvocation>;
  statusSubAgent(sessionId: string, signal?: AbortSignal): Promise<PiSubAgentStatus>;
  waitSubAgent(sessionId: string, timeoutSeconds?: number, signal?: AbortSignal): Promise<PiSubAgentWaitResult>;
  cancelSubAgent(sessionId: string, signal?: AbortSignal): Promise<"cancelled">;
  forkSubAgent(sessionId: string, entryId?: string, signal?: AbortSignal): Promise<{ sessionId: string }>;
  onInvocationCompleted(listener: (completion: PiInvocationCompletion) => Promise<void> | void): () => void;
};

export function piToolResultToToolResult(callId: string, result: PiToolExecutionResult): ToolResult {
  if (!result.ok) return { callId, ok: false, output: result.output, error: result.error };
  return { callId, ok: true, output: result.output ?? piContentText(result.content) };
}

function piContentText(content: PiContent[] | undefined): string {
  return content?.filter((part): part is Extract<PiContent, { type: "text" }> => part.type === "text").map((part) => part.text).join("") ?? "";
}
