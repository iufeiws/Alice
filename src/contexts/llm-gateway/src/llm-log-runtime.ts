import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import type { LLMChatInput, LLMChatResult } from "./index.js";
import type { LLMRequestLogEntry, LLMResponseLogEntry, LLMResponseLogInfo } from "../../../contexts/llm-session/src/index.js";

type AgentId = "chat" | "talk";

export function createLLMLogRuntime(input: {
  time: CurrentTimeProvider;
  requestLogs: LLMRequestLogEntry[];
  responseLogs: LLMResponseLogInfo[];
  ensureActiveSession(time: string, agentId: AgentId): { id: number };
  getActiveSession(): { id: number | string; requestIds?: number[] } | undefined;
  noteRequest(entry: LLMRequestLogEntry, agentId: AgentId, transcriptMessages: LLMChatInput["messages"]): void;
  noteResponse(entry: LLMResponseLogEntry): void;
  resolveModel(agentId: AgentId): string | undefined;
}) {
  let nextRequestId = 1;
  let nextResponseId = 1;

  return {
    appendRequestLog,
    appendResponseLog
  };

  function appendRequestLog(
    request: LLMChatInput,
    agentId: AgentId,
    transcriptMessages: LLMChatInput["messages"]
  ): LLMRequestLogEntry {
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
      maxTokens: request.maxTokens,
      messageCount: transcriptMessages.length,
      tools: request.tools?.map((tool) => ({ ...tool, function: { ...tool.function } })),
      extraParams: request.extraParams,
      presetName: request.presetName
    } satisfies LLMRequestLogEntry;
    input.requestLogs.push(entry);
    input.noteRequest(entry, agentId, transcriptMessages);
    nextRequestId += 1;
    if (input.requestLogs.length > 50) {
      input.requestLogs.splice(0, input.requestLogs.length - 50);
    }
    return entry;
  }

  function appendResponseLog(result: LLMChatResult, agentId: AgentId = "chat", request?: LLMRequestLogEntry): LLMResponseLogEntry {
    const now = input.time.now();
    const activeSession = request ? undefined : input.getActiveSession();
    const activeSessionId = typeof activeSession?.id === "number" ? activeSession.id : undefined;
    const entry = {
      id: nextResponseId,
      agentId,
      sessionId: request?.sessionId ?? activeSessionId,
      requestId: request?.id ?? activeSession?.requestIds?.at(-1),
      time: now.iso,
      timeUtc: now.date.toISOString(),
      message: { ...result.message },
      finishReason: result.finishReason,
      usage: result.usage,
      raw: result.raw
    } satisfies LLMResponseLogEntry;
    input.responseLogs.push({
      id: entry.id,
      agentId: entry.agentId,
      sessionId: entry.sessionId,
      requestId: entry.requestId,
      time: entry.time,
      timeUtc: entry.timeUtc,
      finishReason: entry.finishReason,
      toolCallCount: entry.message.toolCalls?.length ?? 0
    });
    input.noteResponse(entry);
    nextResponseId += 1;
    if (input.responseLogs.length > 50) {
      input.responseLogs.splice(0, input.responseLogs.length - 50);
    }
    return entry;
  }
}
