import type { LLMSessionClearReason, LLMSessionSnapshot, TokenPressurePreviewBaseline } from "../domain/llm-session.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { parseZonedIso } from "../../../../platform/time/src/index.js";
import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import { cloneLLMMessages } from "../adapters/jsonl-llm-session-log.js";
import { buildRawLLMRequest } from "../../../llm-gateway/src/llm-request-shape.js";
import type { LLMSessionRecord, LLMRequestLogEntry, LLMResponseLogEntry } from "../domain/llm-session.js";
import { summarizeLLMSession } from "./llm-session-view.js";
import { cloneJsonObject, cloneLLMTools, cloneTokenPressurePreviewBaselines } from "../domain/llm-session-utils.js";

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

export function createLLMSessionRuntime(input: {
  time: CurrentTimeProvider;
  archive: any;
  getConversationStartIndex(sessionId: number): number | undefined;
  buildTalkRuntimeMessages(sessionId: number): LLMChatInput["messages"];
  appendLog: AppendLog;
}) {
  let nextSessionId = 1;

  return {
    ensureCurrentLLMSession,
    createTalkLLMSession,
    noteLLMRequest,
    noteLLMResponse,
    rewriteActiveTalkLLMSessionFromRuntime,
    isActiveTalkLLMSession,
    updateCurrentLLMSessionTranscript,
    updateActiveTalkLLMSessionTranscript,
    clearCurrentLLMSession,
    getCurrentLLMSessionSnapshot,
    loadCurrentLLMSessionTranscript,
    readLatestLLMSessionSnapshot,
    restorePersistedCurrentLLMSession
  };

  function ensureCurrentLLMSession(time: string, agentId: "chat" | "talk" = "chat"): LLMSessionRecord {
    let currentSession = input.archive.readCurrent();
    if (currentSession && (currentSession.agentId ?? "chat") !== agentId) {
      currentSession = undefined;
    }
    if (!currentSession) {
      currentSession = createNewSession(time, agentId);
      input.archive.writeFile(currentSession);
      input.archive.writeCurrentPointer(currentSession);
    }
    currentSession.agentId = agentId;
    return currentSession;
  }

  function createTalkLLMSession(time: string): LLMSessionRecord {
    const session = createNewSession(time, "talk");
    input.archive.writeFile(session);
    input.archive.writeCurrentPointer(session);
    return session;
  }

  function noteLLMRequest(entry: LLMRequestLogEntry, agentId: "chat" | "talk" = "chat"): void {
    const session = ensureCurrentLLMSession(entry.time, agentId);
    entry.sessionId = session.id;
    session.updatedAt = entry.time;
    session.updatedAtUtc = entry.timeUtc;
    session.requestIds.push(entry.id);
    session.latestRequest = entry.rawRequest;
    session.requests = [...(session.requests ?? []), archiveRequestEntry(entry)];
    const round = session.requestIds.length - 1;
    session.currentRound = {
      status: "running",
      round,
      startedAt: entry.time,
      startedAtUtc: entry.timeUtc,
      model: entry.model,
      temperature: entry.temperature,
      tools: cloneLLMTools(entry.tools),
      extraParams: cloneJsonObject(entry.extraParams),
      presetName: entry.presetName
    };
    session.latestRequestInfo = {
      time: entry.time,
      timeUtc: entry.timeUtc,
      round,
      model: entry.model,
      temperature: entry.temperature,
      tools: cloneLLMTools(entry.tools),
      extraParams: cloneJsonObject(entry.extraParams),
      presetName: entry.presetName,
      messageCount: entry.messages.length
    };
    session.messages = cloneLLMMessages(entry.messages);
    input.archive.writeFile(session);
    input.archive.writeCurrentPointer(session);
  }

  function noteLLMResponse(entry: LLMResponseLogEntry): void {
    const currentSession = entry.sessionId === undefined
      ? input.archive.readCurrent()
      : readLatestLLMSessionSnapshot(entry.sessionId, entry.agentId);
    if (!currentSession) return;
    if (entry.sessionId !== undefined && currentSession.id !== entry.sessionId) {
      input.appendLog("warn", `llm response skipped: session mismatch response_session=${entry.sessionId} current_session=${currentSession.id}`);
      return;
    }
    currentSession.updatedAt = entry.time;
    currentSession.updatedAtUtc = entry.timeUtc;
    currentSession.responseIds.push(entry.id);
    currentSession.responses = [...(currentSession.responses ?? []), entry];
    const round = currentSession.currentRound?.round ?? Math.max(0, currentSession.requestIds.length - 1);
    currentSession.currentRound = {
      ...(currentSession.currentRound ?? { round, startedAt: entry.time }),
      status: "finished",
      round,
      finishedAt: entry.time,
      finishedAtUtc: entry.timeUtc
    };
    currentSession.latestResponseInfo = {
      time: entry.time,
      timeUtc: entry.timeUtc,
      round,
      finishReason: entry.finishReason,
      usage: entry.usage,
      toolCallCount: entry.message.toolCalls?.length ?? 0
    };
    currentSession.messages = [...currentSession.messages, cloneLLMMessages([entry.message])[0]];
    input.archive.appendMessages(currentSession, [entry.message]);
    input.archive.writeMetadata(currentSession);
    input.archive.writeCurrentPointer(currentSession);
  }

  function rewriteActiveTalkLLMSessionFromRuntime(talkSessionId: number): void {
    const session = input.archive.readCurrent();
    if (!session || session.agentId !== "talk" || session.id !== talkSessionId) return;
    const conversationStartIndex = input.getConversationStartIndex(talkSessionId);
    if (conversationStartIndex === undefined) return;
    const preservedPrefix = session.messages.slice(0, conversationStartIndex);
    const runtimeMessages = input.buildTalkRuntimeMessages(talkSessionId);
    const current = input.time.now();
    session.updatedAt = current.iso;
    session.updatedAtUtc = current.date.toISOString();
    session.messages = cloneLLMMessages([
      ...preservedPrefix,
      ...runtimeMessages
    ]);
    session.currentRound = session.currentRound
      ? {
        ...session.currentRound,
        status: "interrupted",
        finishedAt: current.iso,
        finishedAtUtc: current.date.toISOString()
      }
      : session.currentRound;
    session.reason = "talk_interrupt";
    input.archive.writeFile(session);
    input.archive.writeMetadata(session);
    input.archive.writeCurrentPointer(session);
  }

  function isActiveTalkLLMSession(sessionId: number): boolean {
    const session = input.archive.readCurrent();
    return session?.agentId === "talk" && session.id === sessionId;
  }

  function updateCurrentLLMSessionTranscript(sessionInput: LLMSessionSnapshot & { staticPromptFingerprint: string; requestTimestamps: string[] }): void {
    const current = input.time.now();
    const now = current.iso;
    const nowUtc = current.date.toISOString();
    const session = ensureCurrentLLMSession(now);
    session.updatedAt = now;
    session.updatedAtUtc = nowUtc;
    const commonPrefix = commonMessagePrefixLength(session.messages, sessionInput.messages);
    const isAppend = commonPrefix === session.messages.length;
    const delta = sessionInput.messages.slice(commonPrefix);
    const nextMode = sessionInput.mode ?? "normal";
    const nextModeStaticMessages = sessionInput.modeStaticMessages ?? [];
    const nextModeStaticTokenEstimate = sessionInput.modeStaticTokenEstimate ?? 0;
    const nextModeStartedAt = nextMode === "normal" ? undefined : sessionInput.modeStartedAt;
    const nextModeExpiresAt = nextMode === "fixed_prefix" ? sessionInput.modeExpiresAt : undefined;
    const nextFixedPrefixKind = nextMode === "fixed_prefix" ? sessionInput.fixedPrefixKind : undefined;
    const nextFixedPrefixStartedAt = nextMode === "fixed_prefix" ? sessionInput.fixedPrefixStartedAt : undefined;
    const nextLoopStartedAt = sessionInput.loopStartedAt;
    const nextWaitChatStartedAt = sessionInput.waitChatStartedAt;
    const nextSkipNextAppendLayers = sessionInput.skipNextAppendLayers === true ? true : undefined;
    const nextTokenPressurePreviewBaselines = cloneTokenPressurePreviewBaselines(sessionInput.tokenPressurePreviewBaselines);
    const tokenUsageChanged = session.lastTotalTokens !== sessionInput.lastTotalTokens
      || session.lastInputTokens !== sessionInput.lastInputTokens
      || session.lastUsageModel !== sessionInput.lastUsageModel
      || stableStringify(session.tokenPressurePreviewBaselines ?? {}) !== stableStringify(nextTokenPressurePreviewBaselines);
    const agentLoopRunSeqChanged = session.agentLoopRunSeq !== sessionInput.agentLoopRunSeq;
    const modeChanged = session.mode !== nextMode
      || session.modeStaticTokenEstimate !== nextModeStaticTokenEstimate
      || session.modeStartedAt !== nextModeStartedAt
      || session.modeExpiresAt !== nextModeExpiresAt
      || session.fixedPrefixKind !== nextFixedPrefixKind
      || session.fixedPrefixStartedAt !== nextFixedPrefixStartedAt
      || session.loopStartedAt !== nextLoopStartedAt
      || session.waitChatStartedAt !== nextWaitChatStartedAt
      || session.skipNextAppendLayers !== nextSkipNextAppendLayers
      || stableStringify(session.modeStaticMessages ?? []) !== stableStringify(nextModeStaticMessages);
    if (!isAppend) {
      session.clearedAt = now;
      session.clearedAtUtc = nowUtc;
      session.reason = "transcript_replaced";
      input.archive.writeMetadata(session);
      input.archive.clearCurrentPointer();
      input.appendLog("warn", `llm current session archived without transcript rewrite: session=${session.id} common_prefix=${commonPrefix} next_messages=${sessionInput.messages.length}`);
      return;
    }
    session.messages = sessionInput.messages;
    session.staticPromptFingerprint = sessionInput.staticPromptFingerprint;
    session.staticPromptMessageCount = sessionInput.staticPromptMessageCount;
    session.requestTimestamps = sessionInput.requestTimestamps;
    session.agentLoopRunSeq = sessionInput.agentLoopRunSeq;
    session.lastTotalTokens = sessionInput.lastTotalTokens;
    session.lastInputTokens = sessionInput.lastInputTokens;
    session.lastUsageModel = sessionInput.lastUsageModel;
    session.tokenPressurePreviewBaselines = nextTokenPressurePreviewBaselines;
    session.mode = nextMode;
    session.modeStaticMessages = nextModeStaticMessages;
    session.modeStaticTokenEstimate = nextModeStaticTokenEstimate;
    session.modeStartedAt = nextModeStartedAt;
    session.modeExpiresAt = nextModeExpiresAt;
    session.fixedPrefixKind = nextFixedPrefixKind;
    session.fixedPrefixStartedAt = nextFixedPrefixStartedAt;
    session.loopStartedAt = nextLoopStartedAt;
    session.waitChatStartedAt = nextWaitChatStartedAt;
    session.skipNextAppendLayers = nextSkipNextAppendLayers;
    if (delta.length > 0) input.archive.appendMessages(session, delta);
    if (delta.length > 0 || agentLoopRunSeqChanged || tokenUsageChanged || modeChanged) input.archive.writeMetadata(session);
    input.archive.writeCurrentPointer(session);
  }

  function updateActiveTalkLLMSessionTranscript(sessionInput: LLMSessionSnapshot): void {
    const current = input.time.now();
    const now = current.iso;
    const nowUtc = current.date.toISOString();
    const session = ensureCurrentLLMSession(now, "talk");
    const previousMessages = session.messages;
    session.updatedAt = now;
    session.updatedAtUtc = nowUtc;
    session.messages = cloneLLMMessages(sessionInput.messages);
    session.staticPromptFingerprint = sessionInput.staticPromptFingerprint;
    session.staticPromptMessageCount = sessionInput.staticPromptMessageCount;
    session.requestTimestamps = sessionInput.requestTimestamps ?? session.requestTimestamps ?? [];
    session.agentLoopRunSeq = sessionInput.agentLoopRunSeq;
    session.lastTotalTokens = sessionInput.lastTotalTokens;
    session.lastInputTokens = sessionInput.lastInputTokens;
    session.lastUsageModel = sessionInput.lastUsageModel;
    session.tokenPressurePreviewBaselines = cloneTokenPressurePreviewBaselines(sessionInput.tokenPressurePreviewBaselines);
    session.mode = sessionInput.mode ?? "normal";
    session.modeStaticMessages = sessionInput.modeStaticMessages ?? [];
    session.modeStaticTokenEstimate = sessionInput.modeStaticTokenEstimate ?? 0;
    session.modeStartedAt = sessionInput.modeStartedAt;
    session.modeExpiresAt = sessionInput.modeExpiresAt;
    session.fixedPrefixKind = sessionInput.fixedPrefixKind;
    session.fixedPrefixStartedAt = sessionInput.fixedPrefixStartedAt;
    session.loopStartedAt = sessionInput.loopStartedAt;
    session.waitChatStartedAt = sessionInput.waitChatStartedAt;
    session.skipNextAppendLayers = sessionInput.skipNextAppendLayers === true ? true : undefined;
    if (commonMessagePrefixLength(previousMessages, session.messages) === previousMessages.length) {
      const delta = session.messages.slice(previousMessages.length);
      if (delta.length > 0) input.archive.appendMessages(session, delta);
      input.archive.writeMetadata(session);
      input.archive.writeCurrentPointer(session);
      return;
    }
    input.archive.writeFile(session);
    input.archive.writeMetadata(session);
    input.archive.writeCurrentPointer(session);
  }

  function clearCurrentLLMSession(reason: LLMSessionClearReason): void {
    const currentSession = input.archive.readCurrent();
    if (!currentSession) {
      input.archive.clearCurrentPointer();
      return;
    }
    const sessionId = currentSession.id;
    const requestCount = currentSession.requestIds.length;
    const clearedTime = input.time.now();
    currentSession.clearedAt = clearedTime.iso;
    currentSession.clearedAtUtc = clearedTime.date.toISOString();
    currentSession.reason = reason;
    input.archive.writeMetadata(currentSession);
    input.archive.clearCurrentPointer();
    input.appendLog("info", `llm current session cleared: session=${sessionId} reason=${reason} requests=${requestCount}`);
  }

  function getCurrentLLMSessionSnapshot(): unknown {
    const currentSession = input.archive.readCurrent();
    if (!currentSession) return undefined;
    return summarizeLLMSession(currentSession);
  }

  function loadCurrentLLMSessionTranscript(): LLMSessionSnapshot | undefined {
    const currentSession = input.archive.readCurrent();
    if (!currentSession) return undefined;
    const latest = currentSession;
    if (latest.clearedAt) return undefined;
    return {
      id: latest.id,
      messages: latest.messages ?? [],
      staticPromptFingerprint: latest.staticPromptFingerprint,
      staticPromptMessageCount: latest.staticPromptMessageCount,
      requestTimestamps: latest.requestTimestamps,
      agentLoopRunSeq: latest.agentLoopRunSeq,
      currentRound: latest.currentRound?.round,
      lastTotalTokens: latest.lastTotalTokens,
      lastInputTokens: latest.lastInputTokens,
      lastUsageModel: latest.lastUsageModel,
      tokenPressurePreviewBaselines: cloneTokenPressurePreviewBaselines(latest.tokenPressurePreviewBaselines),
      mode: latest.mode ?? "normal",
      modeStaticMessages: latest.modeStaticMessages ?? [],
      modeStaticTokenEstimate: latest.modeStaticTokenEstimate ?? 0,
      modeStartedAt: latest.modeStartedAt,
      modeExpiresAt: latest.modeExpiresAt,
      fixedPrefixKind: latest.fixedPrefixKind,
      fixedPrefixStartedAt: latest.fixedPrefixStartedAt,
      loopStartedAt: latest.loopStartedAt,
      waitChatStartedAt: latest.waitChatStartedAt,
      skipNextAppendLayers: latest.skipNextAppendLayers === true ? true : undefined
    };
  }

  function readLatestLLMSessionSnapshot(id: number, agentId?: "chat" | "talk"): LLMSessionRecord | undefined {
    return selectLatestSessionSnapshot(input.archive.readAll()
      .filter((session: LLMSessionRecord) => session.id === id && (!agentId || (session.agentId ?? "chat") === agentId)));
  }

  function restorePersistedCurrentLLMSession(): LLMSessionRecord | undefined {
    const session = input.archive.restorePersistedActive();
    if (session) nextSessionId = Math.max(nextSessionId, session.id + 1);
    return session;
  }

  function createNewSession(time: string, agentId: "chat" | "talk"): LLMSessionRecord {
    const timeUtc = parseZonedIso(time, input.time.timeZone).toISOString();
    const sessionId = utcTimestamp(timeUtc) ?? nextSessionId;
    nextSessionId += 1;
    return {
      id: sessionId,
      agentId,
      startedAt: time,
      startedAtUtc: timeUtc,
      updatedAt: time,
      updatedAtUtc: timeUtc,
      archiveFilePath: input.archive.createFilePath(timeUtc, agentId),
      requestIds: [],
      responseIds: [],
      messages: [],
      latestRequest: undefined,
      staticPromptMessageCount: 0,
      requestTimestamps: []
    };
  }
}

function selectLatestSessionSnapshot(sessions: LLMSessionRecord[]): LLMSessionRecord | undefined {
  return sessions
    .sort((left, right) => sessionSnapshotRank(left) - sessionSnapshotRank(right))
    .at(-1);
}

function sessionSnapshotRank(session: LLMSessionRecord): number {
  const updatedAt = Date.parse(session.updatedAtUtc ?? session.updatedAt);
  return (Number.isFinite(updatedAt) ? updatedAt : 0)
    + (session.latestResponseInfo ? 4 : 0)
    + (session.latestRequestInfo ? 2 : 0)
    + (session.currentRound ? 1 : 0)
    + session.messages.length / 1_000_000;
}

function archiveRequestEntry(entry: LLMRequestLogEntry): LLMRequestLogEntry {
  return {
    ...entry,
    messages: cloneLLMMessages(entry.messages),
    tools: cloneLLMTools(entry.tools),
    rawRequest: entry.rawRequest ?? buildRawLLMRequest(entry)
  };
}

function commonMessagePrefixLength(left: LLMChatInput["messages"], right: LLMChatInput["messages"]): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && stableStringify(left[index]) === stableStringify(right[index])) index += 1;
  return index;
}

function utcTimestamp(timeUtc: string | undefined): number | undefined {
  if (!timeUtc) return undefined;
  const timestamp = Date.parse(timeUtc);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, Object.keys(value as any).sort());
  } catch {
    return String(value);
  }
}
