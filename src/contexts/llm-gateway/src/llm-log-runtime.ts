import type { CurrentTimeProvider } from "../../../core/time/src/index.js";
import type { LLMChatInput, LLMChatResult } from "./index.js";
import { buildRawLLMRequest } from "./llm-request-shape.js";
import { diffRequests } from "./llm-request-diff.js";
import type { LLMRequestLogEntry, LLMResponseLogEntry } from "../../../core/session/index.js";

type AgentId = "chat" | "talk";

export function createLLMLogRuntime(input: {
  time: CurrentTimeProvider;
  requestLogs: LLMRequestLogEntry[];
  responseLogs: LLMResponseLogEntry[];
  ensureActiveSession(time: string, agentId: AgentId): { id: number };
  getActiveSession(): { id: number; requestIds: number[] } | undefined;
  noteRequest(entry: LLMRequestLogEntry, agentId: AgentId): void;
  noteResponse(entry: LLMResponseLogEntry): void;
  appendUsageLog(result: LLMChatResult, modelFallback: string | undefined): void;
  resolveModel(agentId: AgentId): string | undefined;
  recordTokenUsage(entry: LLMResponseLogEntry, result: LLMChatResult, agentId: AgentId): void;
}) {
  let nextRequestId = 1;
  let nextResponseId = 1;

  return {
    appendRequestLog,
    appendResponseLog
  };

  function appendRequestLog(request: LLMChatInput, agentId: AgentId = "chat"): void {
    const rawRequest = buildRawLLMRequest(request);
    const previous = input.requestLogs[input.requestLogs.length - 1]?.rawRequest;
    const diffFromPrevious = previous === undefined ? undefined : diffRequests(previous, rawRequest);
    const now = input.time.now();
    const sessionId = input.ensureActiveSession(now.iso, agentId).id;
    const entry = {
      id: nextRequestId,
      agentId,
      sessionId,
      time: now.iso,
      timeUtc: now.date.toISOString(),
      model: request.model,
      temperature: request.temperature,
      messages: request.messages.map((message) => ({ ...message })),
      tools: request.tools?.map((tool) => ({ ...tool, function: { ...tool.function } })),
      extraParams: request.extraParams,
      rawRequest,
      diffFromPrevious
    };
    input.requestLogs.push(entry);
    input.noteRequest(entry, agentId);
    nextRequestId += 1;
    if (input.requestLogs.length > 50) {
      input.requestLogs.splice(0, input.requestLogs.length - 50);
    }
  }

  function appendResponseLog(result: LLMChatResult, agentId: AgentId = "chat"): void {
    input.appendUsageLog(result, result.model ?? input.resolveModel(agentId));
    const now = input.time.now();
    const activeSession = input.getActiveSession();
    const entry = {
      id: nextResponseId,
      agentId,
      sessionId: activeSession?.id,
      requestId: activeSession?.requestIds.at(-1),
      time: now.iso,
      timeUtc: now.date.toISOString(),
      message: { ...result.message },
      finishReason: result.finishReason,
      usage: result.usage,
      raw: result.raw
    };
    input.responseLogs.push(entry);
    input.noteResponse(entry);
    input.recordTokenUsage(entry, result, agentId);
    nextResponseId += 1;
    if (input.responseLogs.length > 50) {
      input.responseLogs.splice(0, input.responseLogs.length - 50);
    }
  }
}
