import type { LLMSessionClearReason, LLMSessionSnapshot } from "../domain/llm-session.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { parseZonedIso } from "../../../../platform/time/src/index.js";
import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import { cloneLLMMessages } from "../adapters/jsonl-llm-session-log.js";
import type { LLMSessionRecord, LLMRequestLogEntry, LLMResponseLogEntry } from "../domain/llm-session.js";
import { summarizeLLMSession } from "./llm-session-view.js";
import { cloneJsonObject, cloneLLMTools } from "../domain/llm-session-utils.js";
import type { SessionClearCoordinator, SessionClearResult } from "./session-clear-coordinator.js";

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

/**
 * LLM 会话运行时: 主会话的唯一内存所有者和唯一数据库写入口。
 *
 * 写操作一律"构造新值 -> SQLite 同步事务 -> 替换内存值":
 * 事务失败抛错且内存权威对象保持原值; 不引入 revision/CAS/并发协议。
 * current 只由外部指针决定, 启动时恢复一次, 运行期间不重新从 SQLite 构造会话。
 */
export function createLLMSessionRuntime(input: {
  time: CurrentTimeProvider;
  archive: any;
  getConversationStartIndex(sessionId: number): number | undefined;
  buildTalkRuntimeMessages(sessionId: number): LLMChatInput["messages"];
  appendLog: AppendLog;
  /**
   * 统一 Session Clear 协调器（§6 / §7.1）。必填依赖:
   * clearCurrentLLMSession 一律走 coordinator 串行队列,
   * 在 Short Memory 采集成功后才清除会话(§10); 未注入由类型系统阻止。
   */
  sessionClearCoordinator: SessionClearCoordinator;
}) {
  let nextSessionId = 1;
  /** 内存权威当前会话(与指针指向的会话一致)。 */
  let currentSession: LLMSessionRecord | undefined;

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
    clearCurrentLLMSessionDirect,
    getCurrentLLMSessionSnapshot,
    loadCurrentLLMSessionTranscript,
    restorePersistedCurrentLLMSession
  };

  /**
   * 取当前会话; pointer agent 与请求不一致或没有 current 时创建新会话。
   * 创建顺序(§7): 先提交 SQLite 新会话, 再原子写 pointer。
   */
  function ensureCurrentLLMSession(time: string, agentId: "chat" | "talk" = "chat"): LLMSessionRecord {
    if (currentSession && (currentSession.agentId ?? "chat") === agentId) return currentSession;
    let session = input.archive.readCurrent();
    if (session && (session.agentId ?? "chat") !== agentId) session = undefined;
    if (!session) {
      session = createNewSession(time, agentId);
      input.archive.writeFile(session);
      input.archive.writeCurrentPointer(session);
    }
    currentSession = session;
    return session;
  }

  function createTalkLLMSession(time: string): LLMSessionRecord {
    const session = createNewSession(time, "talk");
    input.archive.writeFile(session);
    input.archive.writeCurrentPointer(session);
    currentSession = session;
    return session;
  }

  /**
   * 发送 LLM 请求前提交:
   * entry.messages 是清洗后的实际 transport payload, 仅用于请求审计;
   * transcriptMessages 是 agent loop 的权威历史, 必须是当前 transcript 的追加或相等。
   */
  function noteLLMRequest(
    entry: Omit<LLMRequestLogEntry, "agentId"> & { agentId?: string },
    agentId: "chat" | "talk",
    transcriptMessages: LLMChatInput["messages"]
  ): void {
    const session = ensureCurrentLLMSession(entry.time, agentId);
    entry.sessionId = session.id;
    const previousMessages = session.messages;
    const commonPrefix = commonMessagePrefixLength(previousMessages, transcriptMessages);
    if (commonPrefix !== previousMessages.length) {
      throw new Error(`llm current session transcript divergence: session=${session.id} common_prefix=${commonPrefix} next_messages=${transcriptMessages.length}`);
    }
    const delta = transcriptMessages.slice(previousMessages.length);
    const round = session.requestIds.length;
    const next: LLMSessionRecord = {
      ...session,
      updatedAt: entry.time,
      updatedAtUtc: entry.timeUtc,
      requestIds: [...session.requestIds, entry.id],
      currentRound: {
        status: "running",
        round,
        startedAt: entry.time,
        startedAtUtc: entry.timeUtc,
        model: entry.model,
        temperature: entry.temperature,
        tools: cloneLLMTools(entry.tools),
        extraParams: cloneJsonObject(entry.extraParams),
        presetName: entry.presetName
      },
      latestRequestInfo: {
        time: entry.time,
        timeUtc: entry.timeUtc,
        round,
        model: entry.model,
        temperature: entry.temperature,
        tools: cloneLLMTools(entry.tools),
        extraParams: cloneJsonObject(entry.extraParams),
        presetName: entry.presetName,
        messageCount: transcriptMessages.length
      },
      messages: cloneLLMMessages(transcriptMessages)
    };
    if (delta.length > 0) input.archive.appendMessages(next, delta);
    input.archive.writeMetadata(next);
    currentSession = next;
  }

  /** 收到 assistant response 后、执行 tool 前同步追加。 */
  function noteLLMResponse(entry: LLMResponseLogEntry): void {
    const session = currentSession ?? input.archive.readCurrent();
    if (!session) return;
    if (entry.sessionId !== undefined && session.id !== entry.sessionId) {
      input.appendLog("warn", `llm response skipped: session mismatch response_session=${entry.sessionId} current_session=${session.id}`);
      return;
    }
    const round = session.currentRound?.round ?? Math.max(0, session.requestIds.length - 1);
    const next: LLMSessionRecord = {
      ...session,
      updatedAt: entry.time,
      updatedAtUtc: entry.timeUtc,
      responseIds: [...session.responseIds, entry.id],
      currentRound: {
        ...(session.currentRound ?? { round, startedAt: entry.time }),
        status: "finished",
        round,
        finishedAt: entry.time,
        finishedAtUtc: entry.timeUtc
      },
      latestResponseInfo: {
        time: entry.time,
        timeUtc: entry.timeUtc,
        round,
        finishReason: entry.finishReason,
        toolCallCount: entry.message.toolCalls?.length ?? 0
      },
      messages: [...session.messages, cloneLLMMessages([entry.message])[0]]
    };
    input.archive.appendMessages(next, [entry.message]);
    input.archive.writeMetadata(next);
    currentSession = next;
  }

  /** Talk 显式完整替换(原因 talk_interrupt): 只允许从 talk runtime 重建。 */
  function rewriteActiveTalkLLMSessionFromRuntime(talkSessionId: number | string): void {
    const session = currentSession ?? input.archive.readCurrent();
    if (!session || session.agentId !== "talk" || session.id !== Number(talkSessionId)) return;
    const conversationStartIndex = input.getConversationStartIndex(Number(talkSessionId));
    if (conversationStartIndex === undefined) return;
    const preservedPrefix = session.messages.slice(0, conversationStartIndex);
    const runtimeMessages = input.buildTalkRuntimeMessages(Number(talkSessionId));
    const current = input.time.now();
    const next: LLMSessionRecord = {
      ...session,
      updatedAt: current.iso,
      updatedAtUtc: current.date.toISOString(),
      messages: cloneLLMMessages([
        ...preservedPrefix,
        ...runtimeMessages
      ]),
      currentRound: session.currentRound
        ? {
          ...session.currentRound,
          status: "interrupted",
          finishedAt: current.iso,
          finishedAtUtc: current.date.toISOString()
        }
        : session.currentRound,
      reason: "talk_interrupt"
    };
    input.archive.replaceTranscript(next, "talk_interrupt");
    currentSession = next;
  }

  function isActiveTalkLLMSession(sessionId: number): boolean {
    return currentSession?.agentId === "talk" && currentSession.id === sessionId;
  }

  /**
   * 普通 Chat 更新: 只允许 meta 改变或尾部追加。
   * 非追加(第二份内存历史/错误覆盖)是违反单一内存所有权的程序错误,
   * 抛出明确错误并中止, 不覆盖 SQLite、不自动创建新会话(§5.2)。
   */
  function updateCurrentLLMSessionTranscript(sessionInput: LLMSessionSnapshot & { staticPromptFingerprint: string; requestTimestamps: string[] }): void {
    const current = input.time.now();
    const now = current.iso;
    const nowUtc = current.date.toISOString();
    const session = currentSession ?? input.archive.readCurrent() ?? ensureCurrentLLMSession(now);
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
    const nextWaitChatMode = sessionInput.waitChatMode;
    const nextWaitChatUntil = sessionInput.waitChatUntil;
    const nextWaitChatTarget = sessionInput.waitChatTarget;
    const nextSkipNextAppendLayers = sessionInput.skipNextAppendLayers === true ? true : undefined;
    const agentLoopRunSeqChanged = session.agentLoopRunSeq !== sessionInput.agentLoopRunSeq;
    const modeChanged = session.mode !== nextMode
      || session.modeStaticTokenEstimate !== nextModeStaticTokenEstimate
      || session.modeStartedAt !== nextModeStartedAt
      || session.modeExpiresAt !== nextModeExpiresAt
      || session.fixedPrefixKind !== nextFixedPrefixKind
      || session.fixedPrefixStartedAt !== nextFixedPrefixStartedAt
      || session.loopStartedAt !== nextLoopStartedAt
      || session.waitChatStartedAt !== nextWaitChatStartedAt
      || session.waitChatMode !== nextWaitChatMode
      || session.waitChatUntil !== nextWaitChatUntil
      || stableStringify(session.waitChatTarget) !== stableStringify(nextWaitChatTarget)
      || session.skipNextAppendLayers !== nextSkipNextAppendLayers
      || stableStringify(session.modeStaticMessages ?? []) !== stableStringify(nextModeStaticMessages);
    if (!isAppend) {
      throw new Error(`llm current session transcript divergence: session=${session.id} common_prefix=${commonPrefix} next_messages=${sessionInput.messages.length}`);
    }
    const next: LLMSessionRecord = {
      ...session,
      updatedAt: now,
      updatedAtUtc: nowUtc,
      messages: cloneLLMMessages(sessionInput.messages),
      staticPromptFingerprint: sessionInput.staticPromptFingerprint,
      staticPromptMessageCount: sessionInput.staticPromptMessageCount,
      requestTimestamps: sessionInput.requestTimestamps,
      agentLoopRunSeq: sessionInput.agentLoopRunSeq,
      mode: nextMode,
      modeStaticMessages: nextModeStaticMessages,
      modeStaticTokenEstimate: nextModeStaticTokenEstimate,
      modeStartedAt: nextModeStartedAt,
      modeExpiresAt: nextModeExpiresAt,
      fixedPrefixKind: nextFixedPrefixKind,
      fixedPrefixStartedAt: nextFixedPrefixStartedAt,
      loopStartedAt: nextLoopStartedAt,
      waitChatStartedAt: nextWaitChatStartedAt,
      waitChatMode: nextWaitChatMode,
      waitChatUntil: nextWaitChatUntil,
      waitChatTarget: nextWaitChatTarget,
      skipNextAppendLayers: nextSkipNextAppendLayers
    };
    if (delta.length > 0) input.archive.appendMessages(next, delta);
    if (delta.length > 0 || agentLoopRunSeqChanged || modeChanged) input.archive.writeMetadata(next);
    currentSession = next;
  }

  /** Talk 更新: 追加场景走 store.append, 重建场景走显式 store.replace(原因 talk_rebuild)。 */
  function updateActiveTalkLLMSessionTranscript(sessionInput: LLMSessionSnapshot): void {
    const current = input.time.now();
    const now = current.iso;
    const nowUtc = current.date.toISOString();
    const session = ensureCurrentLLMSession(now, "talk");
    const previousMessages = session.messages;
    const next: LLMSessionRecord = {
      ...session,
      updatedAt: now,
      updatedAtUtc: nowUtc,
      messages: cloneLLMMessages(sessionInput.messages),
      staticPromptFingerprint: sessionInput.staticPromptFingerprint,
      staticPromptMessageCount: sessionInput.staticPromptMessageCount,
      requestTimestamps: sessionInput.requestTimestamps ?? session.requestTimestamps ?? [],
      agentLoopRunSeq: sessionInput.agentLoopRunSeq,
      mode: sessionInput.mode ?? "normal",
      modeStaticMessages: sessionInput.modeStaticMessages ?? [],
      modeStaticTokenEstimate: sessionInput.modeStaticTokenEstimate ?? 0,
      modeStartedAt: sessionInput.modeStartedAt,
      modeExpiresAt: sessionInput.modeExpiresAt,
      fixedPrefixKind: sessionInput.fixedPrefixKind,
      fixedPrefixStartedAt: sessionInput.fixedPrefixStartedAt,
      loopStartedAt: sessionInput.loopStartedAt,
      waitChatStartedAt: sessionInput.waitChatStartedAt,
      waitChatMode: sessionInput.waitChatMode,
      waitChatUntil: sessionInput.waitChatUntil,
      waitChatTarget: sessionInput.waitChatTarget,
      skipNextAppendLayers: sessionInput.skipNextAppendLayers === true ? true : undefined
    };
    if (commonMessagePrefixLength(previousMessages, next.messages) === previousMessages.length) {
      const delta = next.messages.slice(previousMessages.length);
      if (delta.length > 0) input.archive.appendMessages(next, delta);
      input.archive.writeMetadata(next);
    } else {
      next.reason = "talk_rebuild";
      input.archive.replaceTranscript(next, "talk_rebuild");
    }
    currentSession = next;
  }

  /**
   * clear: 作为 coordinator 的 clear() 回调执行(Short Memory 采集成功后才调用),
   * 先提交完整新 meta(clearedAt/clearedAtUtc/reason), 再删除指针(§7)。
   * 一律经过统一 coordinator, 不存在不经 coordinator 的同步清除路径。
   */
  function clearCurrentLLMSession(reason: LLMSessionClearReason): Promise<SessionClearResult> {
    const session = currentSession ?? input.archive.readCurrent();
    return input.sessionClearCoordinator.clearSession({
      kind: "chat",
      sessionId: String(session?.id ?? "none"),
      reason,
      exists: currentLLMSessionExists,
      clear: () => clearCurrentSessionRecord(reason)
    });
  }

  /**
   * 直接清除(不经 coordinator、不采集 Short Memory): 设计上的有意豁免——
   * 仅供已处于协调器 clear() 回调内部的场景使用, 例如 Talk 正常关闭的
   * clear() 回调中把对应 LLM session 标记为 cleared 并清 current pointer
   * (§7.2 步骤②)。再次进入 coordinator 会造成队列自等待死锁, 因此
   * Talk 路径必须使用本入口。
   */
  function clearCurrentLLMSessionDirect(reason: string): void {
    clearCurrentSessionRecord(reason);
  }

  /** current session 真实存在且未清除(§3.2): coordinator 在轮到请求执行时求值。 */
  function currentLLMSessionExists(): boolean {
    const session = currentSession ?? input.archive.readCurrent();
    return Boolean(session && !session.clearedAt);
  }

  function clearCurrentSessionRecord(reason: string): void {
    const session = currentSession ?? input.archive.readCurrent();
    if (!session) {
      input.archive.clearCurrentPointer();
      return;
    }
    const sessionId = session.id;
    const requestCount = session.requestIds.length;
    const clearedTime = input.time.now();
    const next: LLMSessionRecord = {
      ...session,
      clearedAt: clearedTime.iso,
      clearedAtUtc: clearedTime.date.toISOString(),
      reason
    };
    input.archive.writeMetadata(next);
    input.archive.clearCurrentPointer();
    currentSession = undefined;
    input.appendLog("info", `llm current session cleared: session=${sessionId} reason=${reason} requests=${requestCount}`);
  }

  function getCurrentLLMSessionSnapshot(): unknown {
    const session = currentSession ?? input.archive.readCurrent();
    if (!session) return undefined;
    return summarizeLLMSession(session);
  }

  function loadCurrentLLMSessionTranscript(): LLMSessionSnapshot | undefined {
    const session = currentSession ?? input.archive.readCurrent();
    if (!session) return undefined;
    const latest = session;
    if (latest.clearedAt) return undefined;
    return {
      id: latest.id,
      messages: latest.messages ?? [],
      staticPromptFingerprint: latest.staticPromptFingerprint,
      staticPromptMessageCount: latest.staticPromptMessageCount,
      requestTimestamps: latest.requestTimestamps,
      agentLoopRunSeq: latest.agentLoopRunSeq,
      currentRound: latest.currentRound?.round,
      mode: latest.mode ?? "normal",
      modeStaticMessages: latest.modeStaticMessages ?? [],
      modeStaticTokenEstimate: latest.modeStaticTokenEstimate ?? 0,
      modeStartedAt: latest.modeStartedAt,
      modeExpiresAt: latest.modeExpiresAt,
      fixedPrefixKind: latest.fixedPrefixKind,
      fixedPrefixStartedAt: latest.fixedPrefixStartedAt,
      loopStartedAt: latest.loopStartedAt,
      waitChatStartedAt: latest.waitChatStartedAt,
      waitChatMode: latest.waitChatMode,
      waitChatUntil: latest.waitChatUntil,
      waitChatTarget: latest.waitChatTarget,
      skipNextAppendLayers: latest.skipNextAppendLayers === true ? true : undefined
    };
  }

  function restorePersistedCurrentLLMSession(): LLMSessionRecord | undefined {
    const session = input.archive.restorePersistedActive();
    if (session) {
      nextSessionId = Math.max(nextSessionId, session.id + 1);
      currentSession = session;
    }
    return session;
  }

  function createNewSession(time: string, agentId: "chat" | "talk"): LLMSessionRecord {
    const timeUtc = parseZonedIso(time, input.time.timeZone).toISOString();
    // session_id 为 UTC 毫秒时间戳(单一互斥 worker 下同一毫秒不会创建两个会话);
    // 时间解析失败时回退到递增备用 ID。
    const sessionId = utcTimestamp(timeUtc) ?? nextSessionId;
    nextSessionId = Math.max(nextSessionId, sessionId + 1);
    return {
      id: sessionId,
      agentId,
      startedAt: time,
      startedAtUtc: timeUtc,
      updatedAt: time,
      updatedAtUtc: timeUtc,
      requestIds: [],
      responseIds: [],
      messages: [],
      staticPromptMessageCount: 0,
      requestTimestamps: []
    };
  }
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
