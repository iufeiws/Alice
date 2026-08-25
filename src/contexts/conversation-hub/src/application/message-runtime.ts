import type { AgentEvent, AgentOutput } from "../../../agent-loop/src/contracts/agent-contracts.js";
import { createAgentHeartbeatRuntime } from "../../../agent-loop/src/runtime/agent-heartbeat-runtime.js";
import { createAgentLoopRuntime } from "../../../agent-loop/src/runtime/agent-loop-runtime.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import type { AgentStateSnapshot } from "../../../../contexts/agent-loop/src/domain/agent-loop-state.js";
import { createCurrentTimeProvider, parseZonedIso } from "../../../../platform/time/src/index.js";
import { describeError, formatErrorNotice } from "../../../../shared/errors/src/index.js";
import type { StoredConversationMessage } from "../../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { lifecycleSummary, normalizeInboundEvent, summarizeEventPayload, summarizeOutput } from "./message-content.js";
import {
  buildAgentEventFromMessageLog,
  buildManualProcessEvent,
  buildRandomizedInitiatedBehaviorEvent,
  buildTimedYieldEvent
} from "./message-event-builders.js";
import { persistInboundAttachment } from "./inbound-attachments.js";
import type { AppendAlbertMessageInput, MessageRuntime, MessageRuntimeDeps, DeliverPiInvocationCompletionInput, SendSystemNoticeInput, SystemNoticeTarget } from "./message-runtime-contracts.js";
import { extractSentMessageCreatedAtUtc, extractSentMessageId, isPromise, safeJson } from "./message-runtime-utils.js";

export type SystemNoticeStore = {
  insertOutboundMessage(input: {
    plugin: string;
    conversationId: string;
    senderRole: "system";
    contentType: "text";
    contentText: string;
    contentJson: string;
    createdAt: string;
    createdAtUtc?: string;
  }): { id: number };
  markOutboundMessageSent(id: number, externalMessageId: string | undefined, sentAtUtc: string, createdAtUtc?: string): void;
  markOutboundMessageFailed(id: number, failedAt: string, failureReason: string, failedAtUtc?: string): void;
};

type SendSystemNoticeDeps = {
  time: { now(): { iso: string; date: Date } };
  store: SystemNoticeStore;
  send(output: AgentOutput): Promise<unknown>;
  appendMessageLog?(input: {
    direction: "outbound";
    plugin: string;
    kind: string;
    target?: string;
    sessionId?: string;
    status?: string;
    processedAt?: string;
    processedBatchId?: string;
    error?: string;
    summary: string;
  }): unknown;
};

export function normalizeSystemNoticeText(value: string): string {
  const text = value.trim();
  const dashed = /^-(.+)-$/.exec(text);
  if (dashed) return dashed[1].trim();
  const parenthetical = /^\((.+?)(?:\.\.\.|…)\)$/.exec(text);
  return parenthetical ? parenthetical[1].trim() : text;
}

export function formatSystemNoticeForSend(text: string): string {
  return `<-${normalizeSystemNoticeText(text)}->`;
}

export async function sendSystemNoticeFromRuntime(deps: SendSystemNoticeDeps, input: SendSystemNoticeInput): Promise<void> {
  const text = normalizeSystemNoticeText(input.text);
  if (!text) return;
  const now = deps.time.now();
  const output: AgentOutput = {
    id: createId("out"),
    target: input.target,
    content: { kind: "text", text: formatSystemNoticeForSend(text) },
    meta: {
      createdAt: now.iso,
      createdAtUtc: now.date.toISOString(),
      urgency: "normal",
      allowStreaming: false
    }
  };
  const stored = deps.store.insertOutboundMessage({
    plugin: output.target.plugin,
    conversationId: output.target.sessionId,
    senderRole: "system",
    contentType: "text",
    contentText: text,
    contentJson: JSON.stringify({ kind: "text", text }),
    createdAt: output.meta.createdAt,
    createdAtUtc: output.meta.createdAtUtc
  });
  try {
    const sent = await deps.send(output);
    deps.store.markOutboundMessageSent(stored.id, extractSentMessageId(sent), deps.time.now().date.toISOString(), extractSentMessageCreatedAtUtc(sent));
    if (input.writeLog !== false) {
      deps.appendMessageLog?.({
        direction: "outbound",
        plugin: output.target.plugin,
        kind: output.content.kind,
        target: output.target.channelId ?? output.target.userId,
        sessionId: output.target.sessionId,
        status: "sent",
        summary: text
      });
    }
  } catch (error) {
    const failedTime = deps.time.now();
    const failedAt = failedTime.iso;
    const failedAtUtc = failedTime.date.toISOString();
    const reason = error instanceof Error ? error.message : String(error);
    deps.store.markOutboundMessageFailed(stored.id, failedAt, reason, failedAtUtc);
    if (input.writeLog !== false) {
      deps.appendMessageLog?.({
        direction: "outbound",
        plugin: output.target.plugin,
        kind: output.content.kind,
        target: output.target.channelId ?? output.target.userId,
        sessionId: output.target.sessionId,
        status: "send_failed",
        processedAt: failedAt,
        processedBatchId: "send_failed",
        error: reason,
        summary: text
      });
    }
  }
}

export function createMessageRuntime(deps: MessageRuntimeDeps): MessageRuntime {
  const latestSessionEvents = new Map<string, AgentEvent>();
  const pendingSessions = new Set<string>();
  const processingSessions = new Set<string>();
  let failedAgentSessionEvent: AgentEvent | undefined;
  const time = deps.time ?? createCurrentTimeProvider("UTC", deps.now);
  const now = () => time.now().date;
  const random = deps.random ?? Math.random;
  const agentLoopRuntime = deps.agentLoopRuntime ?? createAgentLoopRuntime();
  // §7.1: 无论 runtime 由调用方注入还是本 runtime 自建, 都把 chat/talk 的 prepare 跑者
  // 接到本 runtime 的 deps(测试注入裸 runtime 时同样可用; 生产值与 root 注入一致)。
  agentLoopRuntime.setRunners({
    prepareChat: ({ event, agentLoopRunSeq }) => deps.chatAgent.prepareEventRun(event, { agentLoopRunSeq }),
    prepareTalk: ({ sessionId, signal, agentLoopRunSeq }) => deps.talkRuntime?.prepareReadyAgentLoopSession?.(sessionId, { signal, agentLoopRunSeq })
  });
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => deps.getHeartbeatIntervalMs?.() ?? 1000,
    startPaused: deps.startHeartbeatPaused,
    tasks: {
      isIdleTransitionDue: () => isIdleTransitionDue(deps.agentState?.getSnapshot?.()),
      getIdleTransitionDelayMs: () => idleTransitionDelayMs(deps.agentState?.getSnapshot?.(), time.timeZone),
      onIdleTimerTransition: deps.onIdleTimerTransition,
      isMainAgentBusy: () => agentLoopRuntime.isMainAgentBusy() || deps.isLLMSessionActive?.() === true,
      canRunHeartbeat,
      retryFailedSessionBeforeStateSwitch,
      tickAgentState: () => {
        deps.agentState?.tick();
      },
      onHeartbeatTick: deps.onHeartbeatTick,
      hasPendingUserMessages,
      buildRandomizedInitiatedBehaviorEvent: () => buildRandomizedInitiatedBehaviorEvent({ deps, now, random, time }),
      runGeneratedSession,
      runManualSession,
      setAgentWaiting: (reason) => {
        deps.agentState?.setState?.("waiting", { reason });
      },
      claimReadyTalkSession: () => deps.talkRuntime?.claimReadyAgentLoopSession?.(),
      runTalkSession: runTalkSession,
      markTalkSessionReady: (sessionId) => {
        deps.talkRuntime?.markAgentLoopReady?.(sessionId);
      },
      getPendingSessionIds: () => [...pendingSessions],
      isProcessingSession: (sessionId) => processingSessions.has(sessionId),
      beginProcessingSession: (sessionId) => {
        processingSessions.add(sessionId);
      },
      finishProcessingSession: (sessionId) => {
        processingSessions.delete(sessionId);
      },
      getPendingMessageCount: (sessionId) => deps.store.listUnprocessedCoreMessagesForConversation(sessionId, Number.MAX_SAFE_INTEGER).length,
      shouldProcessPendingSession: (sessionId) => {
        const pending = deps.store.listUnprocessedCoreMessagesForConversation(sessionId, Number.MAX_SAFE_INTEGER);
        return pending.length > 0 && shouldProcessPending(pending);
      },
      markSessionNotPending: (sessionId) => {
        pendingSessions.delete(sessionId);
      },
      processPendingSession: handleDirtySession,
      getSleepCocoonWakeEvent: () => deps.getSleepCocoonWakeEvent?.() ?? deps.getSleepCocoonMorningEvent?.(),
      beforeSleepCocoonWakeSession: (event) => deps.beforeSleepCocoonWakeSession?.(event as AgentEvent),
      getSleepCocoonGoodnightEvent: deps.getSleepCocoonGoodnightEvent,
      getCalendarReminderEvent: deps.getCalendarReminderEvent,
      getTimedYieldEvent: () => buildTimedYieldEvent(agentLoopRuntime.getCurrentLLMSessionSnapshot(), time),
      appendLog: deps.appendLog
    },
    onPausedChange: deps.onHeartbeatPausedChange,
    appendLog: deps.appendLog
  });
  let previousAgentState = deps.agentState?.getSnapshot?.().state;
  // §11.2/问题 3: 状态监听器驱动 heartbeat(等待→idle 过渡清除完成才调度);
  // flushAll 必须退订监听器(恢复 HEAD 行为), 已 flush 的 runtime 不因状态变化复活;
  // 正常运行时监听器保持注册(既有行为不变)。门控来自 Main Agent activity 占用,
  // 不依赖监听器 await; 监听器 fire-and-forget 调度的 heartbeat 在占用释放后恢复执行。
  let registeredStateListener: ((snapshot: AgentStateSnapshot | undefined) => Promise<void> | void) | undefined;
  const stateListener = async (snapshot: AgentStateSnapshot | undefined): Promise<void> => {
    if (!snapshot) return;
    // 问题 3: 记录本次调用发起时是否仍为已注册监听器——退订前发出的 in-flight
    // 调用在退订后不得复活 runtime(其 schedule 落在 flushAll 之后); 退订后才被
    // 直接调用的监听器(外部持有原始引用)仍可驱动心跳(不依赖 flushAll 退订行为)。
    const startedWhileRegistered = registeredStateListener === stateListener;
    if (previousAgentState === "waiting" && snapshot.state === "idle" && snapshot.reason === "inactive") {
      // §7.1: mode_transition 清除(含 Short Memory 采集)必须完成后才进入后续 heartbeat;
      // §10/§11.2: 清除失败时不得调度后续 heartbeat(loop 停止, 会话保持未清除), 只记录错误。
      try {
        await deps.clearLLMSession("mode_transition");
      } catch (error) {
        deps.appendLog("error", `idle transition llm session clear failed: ${error instanceof Error ? error.message : String(error)}`);
        previousAgentState = snapshot.state;
        return;
      }
    }
    previousAgentState = snapshot.state;
    if (startedWhileRegistered && registeredStateListener !== stateListener) {
      return;
    }
    heartbeat.schedule(0);
  };
  const unsubscribeState = deps.agentState?.onChange(stateListener);
  registeredStateListener = stateListener;
  heartbeat.schedule(0);

  return {
    ingestEvent(event) {
      event = normalizeInboundEvent(event);
      const persisted = persistInboundAttachment(event, deps);
      if (isPromise(persisted)) return persisted.then(ingestStoredEvent);
      ingestStoredEvent(persisted);
      return Promise.resolve();
    },
    ingestLifecycle(event) {
      deps.appendMessageLog({
        direction: "inbound",
        plugin: event.plugin,
        kind: event.kind,
        target: event.conversationId,
        rawMessageId: event.externalMessageId,
        parentRawMessageId: event.externalMessageId,
        actorId: event.actorId,
        externalEventId: event.externalEventId,
        processedAt: event.occurredAt,
        processedBatchId: "lifecycle",
        status: "received",
        rawJson: safeJson(event.raw),
        summary: lifecycleSummary(event)
      });

      if (event.kind === "message.read") {
        deps.store.markMessageRead(event.plugin, event.externalMessageId, event.occurredAt, event.occurredAtUtc);
        return;
      }
      if (event.kind === "message.recalled") {
        deps.store.markMessageRecalled(event.plugin, event.externalMessageId, event.occurredAt, event.occurredAtUtc);
        return;
      }
      if (event.kind === "reaction.created" || event.kind === "reaction.deleted") {
        deps.store.updateMessageReaction({
          plugin: event.plugin,
          externalMessageId: event.externalMessageId,
          emoji: event.emoji,
          actorId: event.actorId,
          op: event.kind === "reaction.created" ? "add" : "remove",
          at: event.occurredAt,
          atUtc: event.occurredAtUtc
        });
      }
    },
    appendAlbertMessage,
    sendSystemNotice,
    deliverPiInvocationCompletion,
    recoverPendingSessions() {
      recoverPendingSessionsFromStore();
    },
    async recoverProcessRestartContinuation() {
      const record = deps.processRestartContinuationStore?.read();
      if (!record) return;
      const recovered = await runGeneratedSession(record.event, "process restart recovery");
      if (!recovered) return;
      const pendingIds = pendingMessageIds(record.event);
      if (pendingIds.length > 0) {
        const processedAt = time.now().iso;
        deps.store.markMessagesCoreProcessed(pendingIds, processedAt, createId("restart_recovery"));
        deps.agentState?.noteInboundProcessed?.();
      }
    },
    pauseHeartbeat() {
      heartbeat.pause();
    },
    resumeHeartbeat() {
      heartbeat.resume();
    },
    async processNow() {
      recoverPendingSessionsFromStore();
      await heartbeat.run({ force: true, runManualSessionWhenIdle: true });
    },
    getStatus() {
      return {
        heartbeatPaused: heartbeat.isPaused(),
        pendingSessions: [...pendingSessions],
        processingSessions: [...processingSessions],
        heartbeatScheduled: heartbeat.isScheduled()
      };
    },
    async flushAll() {
      // 问题 3: 恢复 HEAD 行为——flushAll 同时退订状态监听器,
      // 已 flush 的 runtime 不因状态变化复活(计时器与监听器一并停止)。
      heartbeat.flush();
      unsubscribeState?.();
      registeredStateListener = undefined;
    }
  };

  async function ingestStoredEvent(event: AgentEvent): Promise<void> {
    deps.agentState?.noteInboundMessage();
    const contentText = summarizeEventPayload(event);
    deps.appendMessageLog({
      direction: "inbound",
      plugin: event.source.plugin,
      kind: event.payload.kind,
      target: event.source.channelId ?? event.source.userId,
      sessionId: event.externalSession.sessionId,
      rawMessageId: event.source.rawMessageId,
      externalEventId: event.id,
      status: "received",
      rawJson: safeJson(event.meta.raw),
      summary: contentText
    });
    if (event.payload.kind === "text" && event.payload.text.trim() === "/force_wake") {
      const wasSleeping = deps.agentState?.getSnapshot?.().state === "sleeping";
      // §7.1/§10: force_wake 先获取 clearing 占用，再改变状态并清除会话。
      // 已占用时拒绝本次唤醒，不得提前切换 waiting 或清除 sleep cocoon。
      const acquisition = agentLoopRuntime.beginClearSession({
        kind: "chat",
        sessionId: event.externalSession.sessionId
      });
      if (!acquisition.acquired) {
        deps.appendLog("warn", `force wake skipped: main agent busy ${event.externalSession.sessionId}`);
        return;
      }
      try {
        await deps.clearLLMSession("force_wake");
      } catch (error) {
        deps.appendLog("error", `force wake llm session clear failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      } finally {
        acquisition.release();
      }
      deps.agentState?.setState?.("waiting", { reason: "force_wake", clearSleepCocoon: true });
      const wakeReady = wasSleeping ? deps.agentState?.waitForWake?.() : undefined;
      void Promise.resolve(wakeReady).then(
        () => deps.onForceWake?.(),
        (error) => deps.appendLog("error", `sandbox restart on force wake failed: ${error instanceof Error ? error.message : String(error)}`)
      );
      deps.appendLog("info", `force wake command handled: ${event.externalSession.sessionId}`);
      return;
    }
    const receivedAt = event.meta.receivedAt;
    const receivedAtUtc = event.meta.receivedAtUtc;
    deps.store.upsertInboundMessage({
      plugin: event.source.plugin,
      externalMessageId: event.source.rawMessageId ?? event.id,
      conversationId: event.externalSession.sessionId,
      senderId: event.source.userId,
      senderRole: "user",
      contentType: event.payload.kind,
      contentText,
      contentJson: safeJson({ ...event.payload, quotedMessage: event.meta.quotedMessage }),
      createdAt: receivedAt,
      createdAtUtc: receivedAtUtc,
      lastEventAt: receivedAt,
      lastEventAtUtc: receivedAtUtc,
      coreProcessedAt: shouldProcessInboundWithCore(event) ? undefined : receivedAt
    });
    deps.onInboundUserMessage?.({
      sessionId: event.externalSession.sessionId,
      receivedAt,
      receivedAtUtc
    });
    if (shouldProcessInboundWithCore(event)) {
      agentLoopRuntime.noteInboundUserMessageInterrupt(event.externalSession.sessionId);
    }
    latestSessionEvents.set(event.externalSession.sessionId, event);
    // §11.2: 每次事件入库都同步恢复 store 中已有的 pending 会话标记,
    // 保证清除占用期间到达的消息与既有 pending 会话一并保持 pending(不丢失)。
    // 先标记事件自身会话、再恢复 store 会话: 后续 run 按集合顺序先处理新会话。
    markPending(event.externalSession.sessionId);
    recoverPendingSessionsFromStore();
  }

  function markPending(sessionId: string): void {
    pendingSessions.add(sessionId);
    heartbeat.schedule(0);
  }

  function shouldProcessInboundWithCore(event: AgentEvent): boolean {
    if (event.payload.kind === "text") return true;
    return event.payload.kind === "audio" && typeof event.payload.transcript === "string" && event.payload.transcript.trim().length > 0;
  }

  function recoverPendingSessionsFromStore(): void {
    for (const session of deps.store.listPendingCoreConversations()) {
      markPending(session.conversationId);
    }
  }

  async function runManualSession(): Promise<boolean> {
    const target = deps.getProcessNowTarget?.();
    if (!target) {
      deps.appendLog("warn", "process now skipped: no default messaging target");
      return false;
    }
    if (processingSessions.has(target.sessionId)) {
      deps.appendLog("warn", `manual process now skipped: session already processing ${target.sessionId}`);
      return false;
    }
    processingSessions.add(target.sessionId);
    try {
      await setTypingIndicator({ ...target, typing: true });
      const event = buildManualProcessEvent(target, time);
      deps.appendLog("info", `manual process now session started: ${target.sessionId}`);
      const outputs = await runChatEvent(event, "manual_process_now");
      const outboundMessages = outputs.map((output) => deps.store.insertOutboundMessage({
        plugin: output.target.plugin,
        conversationId: output.target.sessionId,
        senderRole: "assistant",
        contentType: output.content.kind,
        contentText: summarizeOutput(output.content),
        contentJson: safeJson(output.content),
        createdAt: output.meta.createdAt,
        createdAtUtc: output.meta.createdAtUtc
      }));
      try {
        const sendResults = await deps.outputRouter.sendAll(outputs);
        const sentAtUtc = time.now().date.toISOString();
        const resultList = Array.isArray(sendResults) ? sendResults : [];
        for (const [index, message] of outboundMessages.entries()) {
          deps.store.markOutboundMessageSent(message.id, extractSentMessageId(resultList[index]), sentAtUtc, extractSentMessageCreatedAtUtc(resultList[index]));
        }
      } catch (error) {
        const failedTime = time.now();
        const failedAt = failedTime.iso;
        const failedAtUtc = failedTime.date.toISOString();
        const reason = error instanceof Error ? error.message : String(error);
        for (const message of outboundMessages) {
          deps.store.markOutboundMessageFailed(message.id, failedAt, reason, failedAtUtc);
        }
        throw error;
      }
      for (const output of outputs) {
        deps.appendMessageLog({
          direction: "outbound",
          plugin: output.target.plugin,
          kind: output.content.kind,
          target: output.target.channelId ?? output.target.userId,
          sessionId: output.target.sessionId,
          status: "sent",
          summary: summarizeOutput(output.content)
        });
      }
      deps.appendLog("info", `manual process now session handled: ${outputs.length} output(s)`);
      return true;
    } catch (error) {
      const errorText = formatErrorNotice(error);
      await sendSystemNotice({
        target: {
          plugin: target.plugin,
          accountId: target.accountId,
          channelId: target.channelId,
          userId: target.userId,
          sessionId: target.sessionId
        },
        text: errorText
      });
      deps.appendLog("error", `manual process now failed: ${describeError(error)}`);
      return false;
    } finally {
      await setTypingIndicator({ ...target, typing: false });
      processingSessions.delete(target.sessionId);
    }
  }

  async function runGeneratedSession(event: AgentEvent, label: string): Promise<boolean> {
    if (processingSessions.has(event.externalSession.sessionId)) return false;
    processingSessions.add(event.externalSession.sessionId);
    try {
      await setTypingIndicator({ ...event.source, sessionId: event.externalSession.sessionId, typing: true });
      deps.appendLog("info", `${label} session started: ${event.externalSession.sessionId}`);
      const outputs = await runChatEvent(event, label);
      const outboundMessages = outputs.map((output) => deps.store.insertOutboundMessage({
        plugin: output.target.plugin,
        conversationId: output.target.sessionId,
        senderRole: "assistant",
        contentType: output.content.kind,
        contentText: summarizeOutput(output.content),
        contentJson: safeJson(output.content),
        createdAt: output.meta.createdAt,
        createdAtUtc: output.meta.createdAtUtc
      }));
      try {
        const sendResults = await deps.outputRouter.sendAll(outputs);
        const sentAtUtc = time.now().date.toISOString();
        const resultList = Array.isArray(sendResults) ? sendResults : [];
        for (const [index, message] of outboundMessages.entries()) {
          deps.store.markOutboundMessageSent(message.id, extractSentMessageId(resultList[index]), sentAtUtc, extractSentMessageCreatedAtUtc(resultList[index]));
        }
      } catch (error) {
        const failedTime = time.now();
        const failedAt = failedTime.iso;
        const failedAtUtc = failedTime.date.toISOString();
        const reason = error instanceof Error ? error.message : String(error);
        for (const message of outboundMessages) {
          deps.store.markOutboundMessageFailed(message.id, failedAt, reason, failedAtUtc);
        }
        throw error;
      }
      for (const output of outputs) {
        deps.appendMessageLog({
          direction: "outbound",
          plugin: output.target.plugin,
          kind: output.content.kind,
          target: output.target.channelId ?? output.target.userId,
          sessionId: output.target.sessionId,
          status: "sent",
          summary: summarizeOutput(output.content)
        });
      }
      deps.appendLog("info", `${label} session handled: ${outputs.length} output(s)`);
      return true;
    } catch (error) {
      deps.appendLog("error", `${label} session failed: ${describeError(error)}`);
      return false;
    } finally {
      await setTypingIndicator({ ...event.source, sessionId: event.externalSession.sessionId, typing: false });
      processingSessions.delete(event.externalSession.sessionId);
    }
  }

  function canRunHeartbeat(): boolean {
    // §11.2: 门控来自 Main Agent 统一占用(running 与 clearing 同权), 不依赖状态监听器 await;
    // isLLMSessionActive 为生产 wiring 双保险(与 isMainAgentBusy 同源)。
    if (agentLoopRuntime.isMainAgentBusy()) return false;
    if (deps.isLLMSessionActive?.()) return false;
    return deps.agentState?.canRunHeartbeat() ?? true;
  }

  async function retryFailedSessionBeforeStateSwitch(): Promise<boolean> {
    const event = failedAgentSessionEvent;
    const snapshot = deps.agentState?.getSnapshot?.();
    if (!event || snapshot?.state !== "waiting" || !snapshot.nextTransitionAt) return false;
    if (parseZonedIso(snapshot.nextTransitionAt, time.timeZone).getTime() > now().getTime()) return false;
    if (!canRunHeartbeat()) return true;
    await runGeneratedSession(event, "failed agent retry");
    return true;
  }

  async function runTalkSession(sessionId: number): Promise<boolean> {
    const result = await agentLoopRuntime.requestRun({
      kind: "talk",
      sessionId,
      reason: "heartbeat_talk_ready"
    });
    return result.started;
  }

  async function runChatEvent(event: AgentEvent, reason: string): Promise<AgentOutput[]> {
    let result;
    try {
      result = await agentLoopRuntime.requestRun({
        kind: "chat",
        sessionId: event.externalSession.sessionId,
        reason,
        event
      });
    } catch (error) {
      failedAgentSessionEvent = event;
      throw error;
    }
    if (!result.started) throw new Error("agent_loop_busy");
    failedAgentSessionEvent = undefined;
    return result.outputs;
  }

  function isAgentLoopBusyError(error: unknown): boolean {
    return error instanceof Error && error.message === "agent_loop_busy";
  }

  function hasPendingUserMessages(): boolean {
    return pendingSessions.size > 0
      || processingSessions.size > 0
      || deps.store.listPendingCoreConversations().length > 0;
  }

  function isIdleTransitionDue(snapshot: AgentStateSnapshot | undefined): boolean {
    if (snapshot?.state !== "idle" || !snapshot.nextTransitionAt) return false;
    return parseZonedIso(snapshot.nextTransitionAt, time.timeZone).getTime() <= now().getTime();
  }

  function idleTransitionDelayMs(snapshot: AgentStateSnapshot | undefined, timeZone: string): number | undefined {
    if (snapshot?.state !== "idle" || !snapshot.updatedAt || !snapshot.nextTransitionAt) return undefined;
    return Math.max(0, parseZonedIso(snapshot.nextTransitionAt, timeZone).getTime() - parseZonedIso(snapshot.updatedAt, timeZone).getTime());
  }

  function shouldProcessPending(pending: StoredConversationMessage[]): boolean {
    if (deps.agentState && !deps.agentState.canReplyToInbound()) return false;
    const latest = pending[pending.length - 1];
    const delayMs = deps.agentState?.getInboundDelayMs() ?? deps.getDelayMs();
    return now().getTime() - parseZonedIso(latest.createdAt, time.timeZone).getTime() >= delayMs;
  }

  async function handleDirtySession(sessionId: string): Promise<void> {
    const pending = deps.store.listUnprocessedCoreMessagesForConversation(sessionId, Number.MAX_SAFE_INTEGER);
    if (pending.length === 0) {
      deps.appendLog("info", `dirty session skipped: no pending inbound ${sessionId}`);
      return;
    }

    const agentEvent = buildAgentEventFromMessageLog({
      sessionId,
      pending,
      latestEvent: latestSessionEvents.get(sessionId),
      allSessionLogs: deps.store.listMessagesForConversation(sessionId, 30)
    });
    deps.appendLog("info", `chat session processing from message log: ${sessionId} pending=${pending.length}`);

    await setTypingIndicator(typingTargetFromPending(sessionId, pending, agentEvent, true));
    try {
      let outputs: AgentOutput[];
      try {
        outputs = await runChatEvent(agentEvent, "dirty_session");
      } catch (error) {
        if (isAgentLoopBusyError(error)) {
          deps.appendLog("warn", `chat session skipped: agent loop busy ${sessionId}`);
          return;
        }
        const errorText = formatErrorNotice(error);
        await sendSystemNotice({ target: typingTargetFromPending(sessionId, pending, agentEvent, false), text: errorText });
        markPendingCoreFailed(pending, error);
        throw error;
      }
      const outboundMessages = outputs.map((output) => deps.store.insertOutboundMessage({
        plugin: output.target.plugin,
        conversationId: output.target.sessionId,
        senderRole: "assistant",
        contentType: output.content.kind,
        contentText: summarizeOutput(output.content),
        contentJson: safeJson(output.content),
        createdAt: output.meta.createdAt,
        createdAtUtc: output.meta.createdAtUtc
      }));
      try {
        const sendResults = await deps.outputRouter.sendAll(outputs);
        const sentAtUtc = time.now().date.toISOString();
        const resultList = Array.isArray(sendResults) ? sendResults : [];
        for (const [index, message] of outboundMessages.entries()) {
          deps.store.markOutboundMessageSent(message.id, extractSentMessageId(resultList[index]), sentAtUtc, extractSentMessageCreatedAtUtc(resultList[index]));
        }
      } catch (error) {
        const failedTime = time.now();
        const failedAt = failedTime.iso;
        const failedAtUtc = failedTime.date.toISOString();
        const reason = error instanceof Error ? error.message : String(error);
        for (const message of outboundMessages) {
          deps.store.markOutboundMessageFailed(message.id, failedAt, reason, failedAtUtc);
        }
        for (const output of outputs) {
          deps.appendMessageLog({
            direction: "outbound",
            plugin: output.target.plugin,
            kind: output.content.kind,
            target: output.target.channelId ?? output.target.userId,
            sessionId: output.target.sessionId,
            status: "send_failed",
            processedAt: failedAt,
            processedBatchId: "send_failed",
            error: reason,
            summary: summarizeOutput(output.content)
          });
        }
        throw error;
      }
      for (const output of outputs) {
        deps.appendMessageLog({
          direction: "outbound",
          plugin: output.target.plugin,
          kind: output.content.kind,
          target: output.target.channelId ?? output.target.userId,
          sessionId: output.target.sessionId,
          status: "sent",
          summary: summarizeOutput(output.content)
        });
      }

      const processedAt = time.now().iso;
      const batchId = createId("batch");
      deps.store.markMessagesCoreProcessed(pending.map((entry) => entry.id), processedAt, batchId);
      deps.agentState?.noteInboundProcessed?.();
      deps.appendLog("info", `chat session handled: ${outputs.length} output(s), batch=${batchId}`);
    } finally {
      await setTypingIndicator(typingTargetFromPending(sessionId, pending, agentEvent, false));
    }
  }

  async function setTypingIndicator(input: {
    plugin: string;
    accountId?: string;
    channelId?: string;
    userId?: string;
    sessionId: string;
    typing: boolean;
  }): Promise<void> {
    if (!deps.setTypingIndicator) return;
    try {
      await deps.setTypingIndicator(input);
    } catch (error) {
      deps.appendLog("warn", `typing indicator ${input.typing ? "start" : "stop"} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function sendSystemNotice(input: { target: SystemNoticeTarget; text: string; writeLog?: boolean }): Promise<void> {
    return sendSystemNoticeFromRuntime({
      time,
      store: deps.store,
      send: async (output) => {
        const sendResults = await deps.outputRouter.sendAll([output]);
        return Array.isArray(sendResults) ? sendResults[0] : sendResults;
      },
      appendMessageLog: deps.appendMessageLog
    }, input);
  }

  function appendAlbertMessage(input: AppendAlbertMessageInput): void {
    const plugin = input.requester?.plugin;
    const sessionId = input.externalSession?.sessionId;
    if (!plugin || !sessionId) throw new Error("yield_clear_albert_target_required");
    const receivedTime = time.now();
    const externalMessageId = `yield-clear:${input.callId}`;
    deps.store.upsertInboundMessage({
      plugin,
      externalMessageId,
      conversationId: sessionId,
      senderId: input.requester?.userId,
      senderRole: "user",
      contentType: "text",
      contentText: input.contentText,
      contentJson: safeJson({ kind: "text", text: input.contentText }),
      createdAt: receivedTime.iso,
      createdAtUtc: receivedTime.date.toISOString(),
      coreProcessedAt: receivedTime.iso
    });
    deps.appendMessageLog({
      direction: "inbound",
      plugin,
      kind: "text",
      target: sessionId,
      sessionId,
      rawMessageId: externalMessageId,
      externalEventId: externalMessageId,
      status: "received",
      processedAt: receivedTime.iso,
      processedBatchId: "yield_clear",
      summary: input.contentText
    });
  }

  async function deliverPiInvocationCompletion(input: DeliverPiInvocationCompletionInput): Promise<void> {
    const receivedTime = time.now();
    const message = deps.store.upsertBothMessage({
      plugin: input.plugin,
      conversationId: input.conversationId,
      piSessionId: input.piSessionId,
      piInvocationId: input.piInvocationId,
      senderId: input.senderId,
      senderName: input.senderName,
      contentType: "text",
      contentText: input.alertText,
      contentJson: safeJson({ kind: "text", text: input.alertText }),
      createdAt: receivedTime.iso,
      createdAtUtc: receivedTime.date.toISOString()
    });
    const target: SystemNoticeTarget = {
      plugin: input.plugin,
      accountId: input.accountId,
      channelId: input.channelId,
      userId: input.userId,
      sessionId: input.conversationId
    };
    // User-facing system notice delivery, reusing the existing notice send path
    // without inserting a second outbound/system message.
    if (message.status === "sending") {
      const text = normalizeSystemNoticeText(input.noticeText);
      if (text) {
        const output: AgentOutput = {
          id: createId("out"),
          target,
          content: { kind: "text", text: formatSystemNoticeForSend(text) },
          meta: {
            createdAt: receivedTime.iso,
            createdAtUtc: receivedTime.date.toISOString(),
            urgency: "normal",
            allowStreaming: false
          }
        };
        try {
          const sendResults = await deps.outputRouter.sendAll([output]);
          const resultList = Array.isArray(sendResults) ? sendResults : [];
          const sentAtUtc = time.now().date.toISOString();
          deps.store.markOutboundMessageSent(message.id, extractSentMessageId(resultList[0]), sentAtUtc, extractSentMessageCreatedAtUtc(resultList[0]));
          deps.appendMessageLog({
            direction: "outbound",
            plugin: input.plugin,
            kind: "text",
            target: input.conversationId,
            sessionId: input.conversationId,
            status: "sent",
            summary: text
          });
        } catch (error) {
          const failedTime = time.now();
          const reason = error instanceof Error ? error.message : String(error);
          deps.store.markOutboundMessageFailed(message.id, failedTime.iso, reason, failedTime.date.toISOString());
          deps.appendMessageLog({
            direction: "outbound",
            plugin: input.plugin,
            kind: "text",
            target: input.conversationId,
            sessionId: input.conversationId,
            status: "send_failed",
            processedAt: failedTime.iso,
            processedBatchId: "send_failed",
            error: reason,
            summary: text
          });
        }
      }
    }
    // Alice/Core pending: the both message enters the Core queue independently
    // of the user-facing send status.
    if (!message.coreProcessedAt) {
      deps.agentState?.noteInboundMessage();
      agentLoopRuntime.noteInboundUserMessageInterrupt(input.conversationId);
      markPending(input.conversationId);
    }
    deps.appendMessageLog({
      direction: "inbound",
      plugin: input.plugin,
      kind: "text",
      target: input.conversationId,
      sessionId: input.conversationId,
      rawMessageId: `pi:${input.piSessionId}:${input.piInvocationId}`,
      externalEventId: `pi:${input.piSessionId}:${input.piInvocationId}`,
      status: "received",
      summary: input.noticeText
    });
  }

  function typingTargetFromPending(sessionId: string, pending: StoredConversationMessage[], event: AgentEvent, typing: boolean) {
    const latest = pending[pending.length - 1];
    return {
      plugin: latest.plugin,
      accountId: event.source.accountId,
      channelId: event.source.channelId,
      userId: event.source.userId,
      sessionId,
      typing
    };
  }

  function markPendingCoreFailed(pending: StoredConversationMessage[], error: unknown): void {
    const failedAt = time.now().iso;
    const batchId = createId("core_failed");
    const reason = describeError(error);
    deps.store.markMessagesCoreProcessed(pending.map((entry) => entry.id), failedAt, batchId);
    for (const entry of pending) {
      deps.appendMessageLog({
        direction: "inbound",
        plugin: entry.plugin,
        kind: entry.contentType,
        target: entry.conversationId,
        sessionId: entry.conversationId,
        rawMessageId: entry.externalMessageId,
        status: "core_failed",
        processedAt: failedAt,
        processedBatchId: batchId,
        error: reason,
        summary: entry.contentText
      });
    }
    deps.appendLog("error", `chat agent failed; marked ${pending.length} inbound message(s) processed as failed, batch=${batchId}`);
  }
}

function pendingMessageIds(event: AgentEvent): number[] {
  if (!event.meta.raw || typeof event.meta.raw !== "object") return [];
  const value = (event.meta.raw as { pendingIds?: unknown }).pendingIds;
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is number => Number.isInteger(id));
}
