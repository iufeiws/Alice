import type { ToolExecutionContext, ToolResult } from "../../tool-execution/src/index.js";

export type PiToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** Pi 工具结果 content part。图片 part 由 Pi 原生返回: data 为 base64 编码的图像字节, mimeType 为图像 MIME。 */
export type PiContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

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
  /** sha256(relayToken) 指纹; 未配置过 relay 时为空。宿主用它判断 worker 凭证是否已失效。 */
  relayTokenFingerprint?: string;
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
  protocol?: "openai-chat-completions" | "openai-responses";
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
  nickname: string;
  status: PiInvocationStatus;
};

/** Lightweight runtime projection of a Pi session; not an Alice session mirror. */
export type PiSessionSnapshot = {
  sessionId: string;
  nickname?: string;
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
  nickname?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type PiVisibleMessage = { role: "user" | "assistant"; content: unknown };

export type PiRawMessage = Record<string, unknown>;

export type PiSubAgentStatus = {
  updatedAt: string;
  messages: number;
  status: PiInvocationStatus;
};

export type PiSubAgentResult =
  | { status: "running" }
  | { status: "completed"; message: PiVisibleMessage & { role: "assistant" } }
  | { status: Exclude<PiInvocationStatus, "queued" | "running" | "completed"> };

export type PiSubAgentWaitResult = PiSubAgentResult;

/** Completion payload produced when an invocation finishes. */
export type PiInvocationCompletion = {
  sessionId: string;
  nickname: string;
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
  sendInvocation(nickname: string, input: PiInvocationSendInput & { signal?: AbortSignal }): Promise<PiInvocation>;
  listSessions(signal?: AbortSignal): Promise<PiSessionListEntry[]>;
  sessionMessages(nickname: string, access: string, signal?: AbortSignal): Promise<PiRawMessage[]>;
  sessionStatus(nickname: string, signal?: AbortSignal): Promise<PiSessionSnapshot>;
  sessionStatusBySessionId(sessionId: string, signal?: AbortSignal): Promise<PiSessionSnapshot>;
  subAgentStatus(nickname: string, signal?: AbortSignal): Promise<PiSubAgentStatus>;
  resultSession(nickname: string, signal?: AbortSignal): Promise<PiSubAgentResult>;
  waitSession(nickname: string, timeoutSeconds?: number, signal?: AbortSignal): Promise<PiSubAgentWaitResult>;
  cancelSession(nickname: string, signal?: AbortSignal): Promise<"cancelled">;
  forkSession(nickname: string, entryId?: string, signal?: AbortSignal): Promise<{ sessionId: string; nickname: string }>;
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
   * 配置变更时调用, 由宿主 refreshAuthorization 执行一次握手。
   * 容器重建不是本运行时职责; worker 只在真实调用时被唤起(见 wakeIfNeeded)。
   */
  refresh(reason: "config"): Promise<void>;
  /** heartbeat 每轮后台非阻塞唤起: 30s 节流 + 去重, 失败留到下一轮。 */
  wakeIfNeeded(): Promise<void>;
  health(): Promise<PiWorkerHealth>;
  previewPrompt(input?: { presetName?: string; signal?: AbortSignal }): Promise<{ sessionId: string; systemPrompt: string }>;
  toolDefinitions(): PiToolDefinition[];
  executeTool(input: { requestId: string; toolName: string; input: Record<string, unknown>; context?: ToolExecutionContext }): Promise<PiToolExecutionResult>;
  startSubAgent(input: { message: string; timeoutSeconds?: number; messageTarget?: Record<string, unknown>; presetName?: string; signal?: AbortSignal }): Promise<PiInvocation>;
  listSubAgents(signal?: AbortSignal): Promise<PiSessionListEntry[]>;
  messagesSubAgent(nickname: string, access: string, signal?: AbortSignal): Promise<PiRawMessage[]>;
  sendSubAgent(nickname: string, input: { message: string; timeoutSeconds?: number; messageTarget?: Record<string, unknown>; presetName?: string; signal?: AbortSignal }): Promise<PiInvocation>;
  statusSubAgent(nickname: string, signal?: AbortSignal): Promise<PiSubAgentStatus>;
  resultSubAgent(nickname: string, signal?: AbortSignal): Promise<PiSubAgentResult>;
  waitSubAgent(nickname: string, timeoutSeconds?: number, signal?: AbortSignal): Promise<PiSubAgentWaitResult>;
  cancelSubAgent(nickname: string, signal?: AbortSignal): Promise<"cancelled">;
  forkSubAgent(nickname: string, entryId?: string, signal?: AbortSignal): Promise<{ sessionId: string; nickname: string }>;
  onInvocationCompleted(listener: (completion: PiInvocationCompletion) => Promise<void> | void): () => void;
};

export function piToolResultToToolResult(callId: string, result: PiToolExecutionResult): ToolResult {
  if (!result.ok) return { callId, ok: false, output: result.output, error: result.error };
  return { callId, ok: true, output: result.output ?? piContentText(result.content) };
}

function piContentText(content: PiContent[] | undefined): string {
  return content?.filter((part): part is Extract<PiContent, { type: "text" }> => part.type === "text").map((part) => part.text).join("") ?? "";
}
