import { createLLMRequests } from "./llm-requests.js";
import { createLLMSessionTranscriptLogger } from "../../../contexts/llm-session/src/adapters/jsonl-llm-session-log.js";
import type { LLMRequestLogEntry } from "../../../contexts/llm-session/src/index.js";

export function createLLMRequestsRuntime(input: {
  getTool(name: string): any;
  appendLLMRequestLog(request: any, agentId?: "chat" | "talk"): LLMRequestLogEntry | undefined;
  appendLLMResponseLog(result: any, agentId?: "chat" | "talk", request?: LLMRequestLogEntry): void;
  appendLLMUsageLog(result: any, model?: string): void;
  recordTokenUsageEvent(event: any): void;
  time: any;
  resolvePromptApiPreset(agentId: "chat" | "talk" | "memorize"): any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  subagentSessionRoot?: string;
}) {
  const requestLogEntries = new WeakMap<object, LLMRequestLogEntry>();
  const subagentRequestSessions = new WeakMap<object, ReturnType<typeof createLLMSessionTranscriptLogger>>();
  return createLLMRequests({
    getTool: input.getTool,
    onRequestPrepared(requestInput, request) {
      if (requestInput.agentId === "chat" || requestInput.agentId === "talk") {
        const entry = input.appendLLMRequestLog(request, requestInput.agentId);
        if (entry) requestLogEntries.set(requestInput, entry);
        return;
      }
      const session = createSubagentSession(requestInput, requestInput.agentId, requestInput.metadata);
      session?.append({ type: "request", round: requestInput.round, request });
    },
    onResponseReceived(requestInput, request, result) {
      if (requestInput.agentId === "chat" || requestInput.agentId === "talk") {
        input.appendLLMResponseLog(result, requestInput.agentId, requestLogEntries.get(requestInput));
        return;
      }
      subagentRequestSessions.get(requestInput)?.append({ type: "response", round: requestInput.round, response: result });
      clearSubagentSession(requestInput);
      input.appendLLMUsageLog(result, result.model ?? request.model);
      const createdTime = input.time.now();
      input.recordTokenUsageEvent({
        createdAt: createdTime.iso,
        createdAtUtc: createdTime.date.toISOString(),
        agentId: requestInput.agentId,
        model: result.model ?? request.model,
        result
      });
    },
    onRequestSettled(requestInput) {
      if (requestInput.agentId !== "chat" && requestInput.agentId !== "talk") clearSubagentSession(requestInput);
    },
    onLog(event) {
      const mode = event.stream ? "stream" : "non-stream";
      const fallbackModel = event.agentId === "memorize"
        ? input.resolvePromptApiPreset("memorize")?.model
        : input.resolvePromptApiPreset("chat")?.model;
      if (event.kind === "call_start") {
        input.appendLog("info", `llm call start: agent=${event.agentId} round=${event.round} mode=${mode} model=${event.model ?? fallbackModel}`);
      }
      if (event.kind === "stream_start") input.appendLog("info", `llm stream start: agent=${event.agentId} round=${event.round} model=${event.model ?? fallbackModel}`);
      if (event.kind === "stream_end") input.appendLog("info", `llm stream end: agent=${event.agentId} round=${event.round} model=${event.model ?? fallbackModel}`);
      if (event.kind === "response_received") input.appendLog("info", `llm response received: agent=${event.agentId} round=${event.round} mode=${mode} model=${event.model ?? fallbackModel}`);
    }
  });

  function createSubagentSession(requestInput: object, agentId: string, metadata: Record<string, unknown> | undefined): ReturnType<typeof createLLMSessionTranscriptLogger> | undefined {
    if (!input.subagentSessionRoot) return undefined;
    const existing = subagentRequestSessions.get(requestInput);
    if (existing) return existing;
    const started = input.time.now();
    const logger = createLLMSessionTranscriptLogger({
      root: input.subagentSessionRoot,
      time: started.iso,
      timeUtc: started.date.toISOString(),
      now: () => {
        const current = input.time.now();
        return { time: current.iso, timeUtc: current.date.toISOString() };
      },
      namespace: agentId,
      metadata: (state) => ({
        type: "llm_subagent_session",
        schemaVersion: 1,
        agent: agentId,
        startedAt: state.startedAt,
        startedAtUtc: state.startedAtUtc,
        updatedAt: state.updatedAt,
        updatedAtUtc: state.updatedAtUtc,
        requestCount: state.requestCount,
        responseCount: state.responseCount,
        currentRound: state.currentRound,
        latestRequest: state.latestRequest,
        latestResponse: state.latestResponse,
        metadata: metadata ?? {}
      })
    });
    subagentRequestSessions.set(requestInput, logger);
    return logger;
  }

  function clearSubagentSession(requestInput: object): void {
    const logger = subagentRequestSessions.get(requestInput);
    if (!logger) return;
    subagentRequestSessions.delete(requestInput);
  }
}
