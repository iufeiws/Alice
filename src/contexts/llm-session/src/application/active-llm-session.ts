import type { LLMSessionClearReason, LLMSessionSnapshot, TokenPressurePreviewBaseline } from "../domain/llm-session.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { parseZonedIso } from "../../../../platform/time/src/index.js";
import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import { cloneLLMMessages } from "../adapters/jsonl-llm-session-log.js";
import { buildRawLLMRequest } from "../../../llm-gateway/src/llm-request-shape.js";
import type { ActiveLLMSession, LLMRequestLogEntry, LLMResponseLogEntry } from "../domain/llm-session.js";
import { summarizeLLMSession } from "./llm-session-view.js";
import { cloneJsonObject, cloneLLMTools, cloneTokenPressurePreviewBaselines } from "../domain/llm-session-utils.js";

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

export function createActiveLLMSessionRuntime(input: {
  time: CurrentTimeProvider;
  archive: any;
  getSession(): ActiveLLMSession | undefined;
  setSession(session: ActiveLLMSession | undefined): void;
  getConversationStartIndex(sessionId: string): number | undefined;
  buildTalkRuntimeMessages(sessionId: string): LLMChatInput["messages"];
  appendLog: AppendLog;
}) {
  let nextSessionId = 1;

  return {
    ensureActiveLLMSession,
    createTalkLLMSession,
    noteActiveLLMRequest,
    noteActiveLLMResponse,
    rewriteActiveTalkLLMSessionFromRuntime,
    isActiveTalkLLMSession,
    updateActiveLLMSessionTranscript,
    updateActiveTalkLLMSessionTranscript,
    clearActiveLLMSession,
    getActiveLLMSessionSnapshot,
    loadActiveLLMSessionTranscript,
    readLatestLLMSessionSnapshot,
    restorePersistedActiveLLMSession
  };

  function ensureActiveLLMSession(time: string, agentId: "chat" | "talk" = "chat"): ActiveLLMSession {
    let activeSession = input.getSession();
    if (activeSession && (activeSession.agentId ?? "chat") !== agentId) {
      activeSession = undefined;
      input.setSession(undefined);
    }
    if (!activeSession) {
      const timeUtc = parseZonedIso(time, input.time.timeZone).toISOString();
      const sessionId = utcTimestamp(timeUtc) ?? nextSessionId;
      activeSession = {
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
      nextSessionId += 1;
      input.archive.writeFile(activeSession);
      input.archive.writeCurrentPointer(activeSession);
      input.setSession(activeSession);
    }
    activeSession.agentId = agentId;
    return activeSession;
  }

  function createTalkLLMSession(time: string): ActiveLLMSession {
    input.setSession(undefined);
    return ensureActiveLLMSession(time, "talk");
  }

  function noteActiveLLMRequest(entry: LLMRequestLogEntry, agentId: "chat" | "talk" = "chat"): void {
    const session = ensureActiveLLMSession(entry.time, agentId);
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
    if (agentId === "talk") {
      session.messages = cloneLLMMessages(entry.messages);
      input.archive.writeFile(session);
    } else {
      input.archive.writeMetadata(session);
    }
  }

  function noteActiveLLMResponse(entry: LLMResponseLogEntry): void {
    const activeSession = entry.sessionId === undefined
      ? input.getSession()
      : readLatestLLMSessionSnapshot(entry.sessionId, entry.agentId);
    if (!activeSession) return;
    if (entry.sessionId !== undefined && activeSession.id !== entry.sessionId) {
      input.appendLog("warn", `llm response skipped: session mismatch response_session=${entry.sessionId} active_session=${activeSession.id}`);
      return;
    }
    activeSession.updatedAt = entry.time;
    activeSession.updatedAtUtc = entry.timeUtc;
    activeSession.responseIds.push(entry.id);
    activeSession.responses = [...(activeSession.responses ?? []), entry];
    const round = activeSession.currentRound?.round ?? Math.max(0, activeSession.requestIds.length - 1);
    activeSession.currentRound = {
      ...(activeSession.currentRound ?? { round, startedAt: entry.time }),
      status: "finished",
      round,
      finishedAt: entry.time,
      finishedAtUtc: entry.timeUtc
    };
    activeSession.latestResponseInfo = {
      time: entry.time,
      timeUtc: entry.timeUtc,
      round,
      finishReason: entry.finishReason,
      usage: entry.usage,
      toolCallCount: entry.message.toolCalls?.length ?? 0
    };
    if (entry.agentId === "talk") {
      activeSession.messages = [...activeSession.messages, cloneLLMMessages([entry.message])[0]];
      input.archive.appendMessages(activeSession, [entry.message]);
    }
    input.archive.writeMetadata(activeSession);
  }

  function rewriteActiveTalkLLMSessionFromRuntime(talkSessionId: string): void {
    const session = input.getSession();
    if (!session || session.agentId !== "talk" || String(session.id) !== talkSessionId) return;
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
  }

  function isActiveTalkLLMSession(sessionId: number): boolean {
    const session = input.getSession();
    return session?.agentId === "talk" && session.id === sessionId;
  }

  function updateActiveLLMSessionTranscript(sessionInput: LLMSessionSnapshot & { staticPromptFingerprint: string; requestTimestamps: string[] }): void {
    const current = input.time.now();
    const now = current.iso;
    const nowUtc = current.date.toISOString();
    const session = ensureActiveLLMSession(now);
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
    const nextFixedPrefixCursorMessageId = nextMode === "fixed_prefix" ? sessionInput.fixedPrefixCursorMessageId : undefined;
    const nextWaitChatStartedAt = sessionInput.waitChatStartedAt;
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
      || session.fixedPrefixCursorMessageId !== nextFixedPrefixCursorMessageId
      || session.waitChatStartedAt !== nextWaitChatStartedAt
      || stableStringify(session.modeStaticMessages ?? []) !== stableStringify(nextModeStaticMessages);
    if (!isAppend) {
      session.clearedAt = now;
      session.clearedAtUtc = nowUtc;
      session.reason = "transcript_replaced";
      input.archive.writeMetadata(session);
      input.archive.clearCurrentPointer();
      input.setSession(undefined);
      input.appendLog("warn", `llm active session archived without transcript rewrite: session=${session.id} common_prefix=${commonPrefix} next_messages=${sessionInput.messages.length}`);
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
    session.fixedPrefixCursorMessageId = nextFixedPrefixCursorMessageId;
    session.waitChatStartedAt = nextWaitChatStartedAt;
    if (delta.length > 0) input.archive.appendMessages(session, delta);
    if (delta.length > 0 || agentLoopRunSeqChanged || tokenUsageChanged || modeChanged) input.archive.writeMetadata(session);
  }

  function updateActiveTalkLLMSessionTranscript(sessionInput: LLMSessionSnapshot): void {
    const current = input.time.now();
    const now = current.iso;
    const nowUtc = current.date.toISOString();
    const session = ensureActiveLLMSession(now, "talk");
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
    session.fixedPrefixCursorMessageId = sessionInput.fixedPrefixCursorMessageId;
    session.waitChatStartedAt = sessionInput.waitChatStartedAt;
    if (commonMessagePrefixLength(previousMessages, session.messages) === previousMessages.length) {
      const delta = session.messages.slice(previousMessages.length);
      if (delta.length > 0) input.archive.appendMessages(session, delta);
      input.archive.writeMetadata(session);
      return;
    }
    input.archive.writeFile(session);
    input.archive.writeMetadata(session);
  }

  function clearActiveLLMSession(reason: LLMSessionClearReason): void {
    const activeSession = input.getSession();
    if (!activeSession) {
      input.archive.clearCurrentPointer();
      return;
    }
    const sessionId = activeSession.id;
    const requestCount = activeSession.requestIds.length;
    const clearedTime = input.time.now();
    activeSession.clearedAt = clearedTime.iso;
    activeSession.clearedAtUtc = clearedTime.date.toISOString();
    activeSession.reason = reason;
    input.archive.writeMetadata(activeSession);
    input.archive.clearCurrentPointer();
    input.setSession(undefined);
    input.appendLog("info", `llm active session cleared: session=${sessionId} reason=${reason} requests=${requestCount}`);
  }

  function getActiveLLMSessionSnapshot(): unknown {
    const activeSession = input.getSession();
    if (!activeSession) return undefined;
    return summarizeLLMSession(readLatestLLMSessionSnapshot(activeSession.id) ?? activeSession);
  }

  function loadActiveLLMSessionTranscript(): LLMSessionSnapshot | undefined {
    const activeSession = input.getSession();
    if (!activeSession) return undefined;
    const latest = readLatestLLMSessionSnapshot(activeSession.id);
    if (!latest || latest.clearedAt) return undefined;
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
      fixedPrefixCursorMessageId: latest.fixedPrefixCursorMessageId,
      waitChatStartedAt: latest.waitChatStartedAt
    };
  }

  function readLatestLLMSessionSnapshot(id: number, agentId?: "chat" | "talk"): ActiveLLMSession | undefined {
    const activeSession = input.getSession();
    if (activeSession?.id === id && (!agentId || (activeSession.agentId ?? "chat") === agentId)) return activeSession;
    return selectLatestSessionSnapshot(input.archive.readAll()
      .filter((session: ActiveLLMSession) => session.id === id && (!agentId || (session.agentId ?? "chat") === agentId)));
  }

  function restorePersistedActiveLLMSession(): ActiveLLMSession | undefined {
    const session = input.archive.restorePersistedActive();
    if (session) nextSessionId = Math.max(nextSessionId, session.id + 1);
    input.setSession(session);
    return session;
  }
}

function selectLatestSessionSnapshot(sessions: ActiveLLMSession[]): ActiveLLMSession | undefined {
  return sessions
    .sort((left, right) => sessionSnapshotRank(left) - sessionSnapshotRank(right))
    .at(-1);
}

function sessionSnapshotRank(session: ActiveLLMSession): number {
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
