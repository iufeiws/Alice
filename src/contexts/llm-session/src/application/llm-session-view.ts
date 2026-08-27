import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import { cloneLLMMessages } from "../adapters/jsonl-llm-session-log.js";
import type {
  LLMSessionRecord,
  LLMResponseLogEntry,
  LLMSessionResponseInfo,
  LLMSessionTurn
} from "../domain/llm-session.js";

export function summarizeLLMSession(session: LLMSessionRecord): unknown {
  const roundCount = llmSessionRoundCount(session);
  const latestMessage = session.messages.at(-1);
  return {
    id: session.id,
    agentId: session.agentId ?? "chat",
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    requestIds: session.requestIds,
    responseIds: session.responseIds,
    requestCount: session.requestIds.length,
    responseCount: session.responseIds.length,
    roundCount,
    messageCount: session.messages.length,
    agentLoopRunSeq: session.agentLoopRunSeq,
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
    fixedPrefixStartedAt: session.fixedPrefixStartedAt,
    loopStartedAt: session.loopStartedAt,
    waitChatStartedAt: session.waitChatStartedAt,
    waitChatMode: session.waitChatMode,
    waitChatUntil: session.waitChatUntil,
    waitChatTarget: session.waitChatTarget,
    skipNextAppendLayers: session.skipNextAppendLayers === true ? true : undefined,
    clearedAt: session.clearedAt,
    reason: session.reason,
    archiveFilePath: session.archiveFilePath
  };
}

export function buildLLMSessionTurns(session: LLMSessionRecord): LLMSessionTurn[] {
  return buildLLMSessionTurnsFromTranscript(session);
}

function llmSessionRoundCount(session: LLMSessionRecord): number {
  const rounds = [
    session.requestIds.length,
    session.responseIds.length,
    typeof session.currentRound?.round === "number" ? session.currentRound.round + 1 : 0,
    typeof session.latestRequestInfo?.round === "number" ? session.latestRequestInfo.round + 1 : 0,
    typeof session.latestResponseInfo?.round === "number" ? session.latestResponseInfo.round + 1 : 0
  ];
  return Math.max(0, ...rounds);
}

function buildLLMSessionTurnsFromTranscript(session: LLMSessionRecord): LLMSessionTurn[] {
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
      response: transcriptResponseEntry(session, responseIndex, messages[responseIndex], latestResponse)
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
  session: LLMSessionRecord,
  responseIndex: number,
  message: LLMChatInput["messages"][number],
  latestResponse: LLMSessionResponseInfo | undefined
): LLMResponseLogEntry {
  return {
    id: responseIndex,
    sessionId: session.id,
    time: latestResponse?.time ?? session.updatedAt,
    message,
    finishReason: latestResponse?.finishReason
  };
}
