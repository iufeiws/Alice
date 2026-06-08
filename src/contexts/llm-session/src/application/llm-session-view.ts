import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import { cloneLLMMessages } from "../adapters/jsonl-llm-session-log.js";
import type {
  ActiveLLMSession,
  LLMRequestLogEntry,
  LLMResponseLogEntry,
  LLMSessionRequestInfo,
  LLMSessionResponseInfo,
  LLMSessionTurn
} from "../domain/llm-session.js";

export function summarizeLLMSession(session: ActiveLLMSession): unknown {
  const roundCount = llmSessionRoundCount(session);
  const latestMessage = session.messages.at(-1);
  return {
    id: session.id,
    agentId: session.agentId ?? "chat",
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    requestIds: session.requestIds,
    responseIds: session.responseIds,
    requestCount: session.requests?.length ?? session.requestIds.length,
    responseCount: session.responses?.length ?? session.responseIds.length,
    roundCount,
    messageCount: session.messages.length,
    currentRound: session.currentRound,
    latestRequest: session.latestRequestInfo,
    latestResponse: session.latestResponseInfo,
    latestMessage: latestMessage ? cloneLLMMessages([latestMessage])[0] : undefined,
    staticPromptMessageCount: session.staticPromptMessageCount ?? 0,
    mode: session.mode ?? "normal",
    modeStaticMessageCount: session.modeStaticMessages?.length ?? 0,
    modeStaticTokenEstimate: session.modeStaticTokenEstimate ?? 0,
    modeStartedAt: session.modeStartedAt,
    modeExpiresAt: session.modeExpiresAt,
    fixedPrefixKind: session.fixedPrefixKind,
    fixedPrefixCursorMessageId: session.fixedPrefixCursorMessageId,
    waitChatStartedAt: session.waitChatStartedAt,
    clearedAt: session.clearedAt,
    reason: session.reason,
    archiveFilePath: session.archiveFilePath
  };
}

export function buildLLMSessionTurns(session: ActiveLLMSession): LLMSessionTurn[] {
  const requests = [...(session.requests ?? [])].sort(compareLLMLogEntries);
  const responses = [...(session.responses ?? [])].sort(compareLLMLogEntries);
  if (requests.length === 0 && responses.length === 0) {
    return buildLLMSessionTurnsFromTranscript(session);
  }
  const count = Math.max(llmSessionRoundCount(session), 1);
  const turns: LLMSessionTurn[] = [];
  for (let index = 0; index < count; index += 1) {
    const request = requests[index];
    const response = responses.find((entry) => entry.requestId === request?.id) ?? responses[index];
    const latestRequest = session.latestRequestInfo?.round === index ? session.latestRequestInfo : undefined;
    const latestResponse = session.latestResponseInfo?.round === index ? session.latestResponseInfo : undefined;
    turns.push({
      round: index,
      request,
      response,
      latestRequest,
      latestResponse,
      messages: messagesForLLMSessionTurn(session, index, request, response, latestRequest)
    });
  }
  return turns;
}

export function compareLLMLogEntries(left: { time?: string; id?: number }, right: { time?: string; id?: number }): number {
  const byTime = String(left.time || "").localeCompare(String(right.time || ""));
  if (byTime) return byTime;
  return Number(left.id || 0) - Number(right.id || 0);
}

function llmSessionRoundCount(session: ActiveLLMSession): number {
  const rounds = [
    session.requests?.length ?? 0,
    session.responses?.length ?? 0,
    session.requestIds.length,
    session.responseIds.length,
    typeof session.currentRound?.round === "number" ? session.currentRound.round + 1 : 0,
    typeof session.latestRequestInfo?.round === "number" ? session.latestRequestInfo.round + 1 : 0,
    typeof session.latestResponseInfo?.round === "number" ? session.latestResponseInfo.round + 1 : 0
  ];
  return Math.max(0, ...rounds);
}

function buildLLMSessionTurnsFromTranscript(session: ActiveLLMSession): LLMSessionTurn[] {
  const messages = cloneLLMMessages(session.messages);
  const staticCount = Math.max(0, Math.min(messages.length, session.staticPromptMessageCount ?? 0));
  const responseIndexes: number[] = [];
  for (let index = staticCount; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (isSyntheticPromptToolRequest(message)) continue;
    responseIndexes.push(index);
  }
  if (responseIndexes.length === 0) {
    return [{
      round: 0,
      latestRequest: session.latestRequestInfo,
      latestResponse: session.latestResponseInfo,
      messages
    }];
  }
  return responseIndexes.map((responseIndex, round) => {
    const latestRequest = session.latestRequestInfo?.round === round ? session.latestRequestInfo : undefined;
    const latestResponse = session.latestResponseInfo?.round === round ? session.latestResponseInfo : undefined;
    return {
      round,
      latestRequest,
      latestResponse,
      messages: messages.slice(0, responseIndex),
      response: transcriptResponseEntry(session, round, responseIndex, messages[responseIndex], latestResponse)
    };
  });
}

function isSyntheticPromptToolRequest(message: LLMChatInput["messages"][number]): boolean {
  const calls = message.toolCalls ?? [];
  return calls.length > 0 && calls.every((call) => (
    call.id.startsWith("append_")
    || call.id.startsWith("fixed_prefix_")
    || call.id.startsWith("call_prompt_")
  ));
}

function transcriptResponseEntry(
  session: ActiveLLMSession,
  round: number,
  responseIndex: number,
  message: LLMChatInput["messages"][number],
  latestResponse: LLMSessionResponseInfo | undefined
): LLMResponseLogEntry {
  return {
    id: responseIndex,
    sessionId: session.id,
    time: latestResponse?.time ?? session.updatedAt,
    message,
    finishReason: latestResponse?.finishReason,
    usage: latestResponse?.usage
  };
}

function messagesForLLMSessionTurn(
  session: ActiveLLMSession,
  index: number,
  request: LLMRequestLogEntry | undefined,
  response: LLMResponseLogEntry | undefined,
  latestRequest: LLMSessionRequestInfo | undefined
): LLMChatInput["messages"] {
  if (request?.messages?.length) return cloneLLMMessages(request.messages);
  if (latestRequest?.messageCount) return cloneLLMMessages(session.messages.slice(0, latestRequest.messageCount));
  if (index === llmSessionRoundCount(session) - 1) return cloneLLMMessages(session.messages);
  return response ? [{ ...response.message }] : [];
}
