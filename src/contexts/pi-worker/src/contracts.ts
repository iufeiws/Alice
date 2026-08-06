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
  version: string;
  toolDefinitionGeneration: string;
  cwd: string;
  relayReachable: boolean;
  toolDefinitions: PiToolDefinition[];
};

export type PiSessionStatus = "queued" | "running" | "completed" | "failed" | "timed_out" | "aborted" | "interrupted";

export type PiSessionEvent = {
  cursor: string;
  type: "status" | "tool_call" | "tool_result" | "assistant" | "usage" | "terminal" | "completion_delivered";
  at: string;
  data: Record<string, unknown>;
};

export type PiSession = {
  sessionId: string;
  status: PiSessionStatus;
  task: string;
  createdAt: string;
  updatedAt: string;
  terminalResult?: string;
  terminalError?: string;
  completionDelivered?: boolean;
  requester?: Record<string, unknown>;
  notificationTarget?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  transcript?: unknown[];
  systemPrompt?: string;
  events?: PiSessionEvent[];
};

export type PiWorkerClient = {
  health(signal?: AbortSignal): Promise<PiWorkerHealth>;
  executeTool(input: { requestId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }): Promise<PiToolExecutionResult>;
  createSession(input: { task: string; timeoutSeconds?: number; requester?: Record<string, unknown>; notificationTarget?: Record<string, unknown>; presetName?: string; signal?: AbortSignal }): Promise<Pick<PiSession, "sessionId" | "status">>;
  startSession(sessionId: string, input?: { model?: string; temperature?: number; maxTokens?: number; extraParams?: Record<string, unknown>; supportsImage?: boolean; reasoning?: boolean; signal?: AbortSignal }): Promise<Pick<PiSession, "sessionId" | "status">>;
  previewSession(input: { sessionId: string; model?: string; temperature?: number; maxTokens?: number; extraParams?: Record<string, unknown>; supportsImage?: boolean; reasoning?: boolean; signal?: AbortSignal }): Promise<{ sessionId: string; systemPrompt: string }>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<PiSession>;
  listSessions(signal?: AbortSignal): Promise<PiSession[]>;
  listSessionEvents(sessionId: string, cursor?: string, signal?: AbortSignal): Promise<{ events: PiSessionEvent[]; nextCursor?: string }>;
  cancelSession(sessionId: string, signal?: AbortSignal): Promise<PiSession>;
  markInterrupted(sessionId: string, signal?: AbortSignal): Promise<PiSession>;
  markCompletionDelivered(sessionId: string, signal?: AbortSignal): Promise<PiSession>;
};

export type PiSandboxRuntime = {
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(reason: "mount_changed" | "admin" | "wake" | "config"): Promise<void>;
  health(): Promise<PiWorkerHealth>;
  previewPrompt(input?: { presetName?: string; signal?: AbortSignal }): Promise<{ sessionId: string; systemPrompt: string }>;
  toolDefinitions(): PiToolDefinition[];
  executeTool(input: { requestId: string; toolName: string; input: Record<string, unknown>; context?: ToolExecutionContext }): Promise<PiToolExecutionResult>;
  startSubAgent(input: { task: string; timeoutSeconds?: number; requester?: Record<string, unknown>; notificationTarget?: Record<string, unknown>; presetName?: string; signal?: AbortSignal }): Promise<Pick<PiSession, "sessionId" | "status">>;
  statusSubAgent(sessionId: string, cursor?: string, signal?: AbortSignal): Promise<PiSession & { nextCursor?: string }>;
  cancelSubAgent(sessionId: string, signal?: AbortSignal): Promise<PiSession>;
  reconcileInterrupted(signal?: AbortSignal): Promise<PiSession[]>;
  onTerminal(listener: (session: PiSession) => Promise<void> | void): () => void;
};

export type PiCompletionMessage = {
  sessionId: string;
  status: Exclude<PiSessionStatus, "queued" | "running">;
  text: string;
  target?: Record<string, unknown>;
};

export function piToolResultToToolResult(callId: string, result: PiToolExecutionResult): ToolResult {
  if (!result.ok) return { callId, ok: false, output: result.output, error: result.error };
  return { callId, ok: true, output: result.output ?? result.content ?? "" };
}
