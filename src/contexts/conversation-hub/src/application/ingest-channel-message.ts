import type { AgentEvent, AgentOutput } from "../../../agent-loop/src/contracts/agent-contracts.js";
import { createAgentHeartbeatRuntime } from "../../../agent-loop/src/runtime/agent-heartbeat-runtime.js";
import { createAgentLoopRuntime, type AgentLoopRuntime, type PreparedAgentLoopRun } from "../../../agent-loop/src/runtime/agent-loop-runtime.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import { sanitizeAudioTranscript, sanitizeMessageText, summarizeAudioText } from "../../../agent-loop/src/contracts/agent-contracts.js";
import type { AgentStateController, AgentStateSnapshot } from "../../../../contexts/agent-loop/src/domain/agent-loop-state.js";
import {
  defaultAgentInitiatedBehaviorPlans,
  hasRandomizedAgentInitiatedBehaviorPlan,
  type AgentInitiatedBehaviorPlan
} from "../../../../contexts/initiative/src/domain/initiated-behavior.js";
import { createCurrentTimeProvider, parseZonedIso } from "../../../../platform/time/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { describeError } from "../../../../shared/errors/src/index.js";
import type {
  InsertOutboundMessageInput,
  StoredConversationMessage,
  StoredMessageLog,
  UpdateMessageReactionInput,
  UpsertInboundMessageInput
} from "../../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";

export type MessageRuntimeDeps = {
  getDelayMs(): number;
  getHeartbeatIntervalMs?: () => number;
  startHeartbeatPaused?: boolean;
  onHeartbeatTick?: () => void;
  onIdleTimerTransition?: (input: { delayMs: number }) => Promise<void> | void;
  getSleepCocoonGoodnightEvent?: () => AgentEvent | undefined;
  getSleepCocoonWakeEvent?: () => AgentEvent | undefined;
  getSleepCocoonMorningEvent?: () => AgentEvent | undefined;
  getCalendarReminderEvent?: () => AgentEvent | undefined;
  getAgentInitiatedBehaviorPlans?: () => AgentInitiatedBehaviorPlan[];
  getRandomInitiatedBehaviorTarget?: () => {
    plugin: string;
    accountId?: string;
    channelId?: string;
    userId?: string;
    sessionId: string;
  } | undefined;
  onForceWake?: () => void;
  onInboundUserMessage?: (input: { sessionId: string; receivedAt: string; receivedAtUtc?: string }) => void;
  clearLLMSession?(reason: string): void;
  isLLMSessionActive?: () => boolean;
  agentLoopRuntime?: AgentLoopRuntime;
  talkRuntime?: {
    markAgentLoopReady?(sessionId: number): void;
    claimReadyAgentLoopSession?(): number | undefined;
    prepareReadyAgentLoopSession?(sessionId: number, options?: { signal?: AbortSignal; agentLoopRunSeq?: number }): Promise<PreparedAgentLoopRun | undefined> | PreparedAgentLoopRun | undefined;
  };
  setTypingIndicator?(input: {
    plugin: string;
    accountId?: string;
    channelId?: string;
    userId?: string;
    sessionId: string;
    typing: boolean;
  }): Promise<void>;
  getProcessNowTarget?(): {
    plugin: string;
    accountId?: string;
    channelId?: string;
    userId?: string;
    sessionId: string;
  } | undefined;
  now?: () => Date;
  time?: CurrentTimeProvider;
  random?: () => number;
  store: {
    insertMessageLog(input: Omit<StoredMessageLog, "id">): StoredMessageLog;
    upsertInboundMessage(input: UpsertInboundMessageInput): StoredConversationMessage;
    insertOutboundMessage(input: InsertOutboundMessageInput): StoredConversationMessage;
    listMessages(limit: number): StoredConversationMessage[];
    listMessagesForConversation(conversationId: string, limit: number): StoredConversationMessage[];
    listUnprocessedCoreMessagesForConversation(conversationId: string, limit: number): StoredConversationMessage[];
    listPendingCoreConversations(): Array<{ conversationId: string }>;
    markMessagesCoreProcessed(ids: number[], processedAt: string, batchId: string): void;
    markOutboundMessageSent(id: number, externalMessageId: string | undefined, sentAtUtc: string, createdAtUtc?: string): void;
    markOutboundMessageFailed(id: number, failedAt: string, failureReason: string, failedAtUtc?: string): void;
    markMessageRead(plugin: string, externalMessageId: string, readAt: string, readAtUtc?: string): boolean;
    markMessageRecalled(plugin: string, externalMessageId: string, recalledAt: string, recalledAtUtc?: string): boolean;
    updateMessageReaction(input: UpdateMessageReactionInput): boolean;
  };
  core: {
    prepareEventRun(event: AgentEvent, options?: { agentLoopRunSeq?: number }): Promise<PreparedAgentLoopRun | AgentOutput[]> | PreparedAgentLoopRun | AgentOutput[];
  };
  agentState?: Pick<
    AgentStateController,
    "canReplyToInbound" | "canRunHeartbeat" | "getInboundDelayMs" | "noteInboundMessage" | "onChange" | "tick"
  > & Partial<Pick<AgentStateController, "getSnapshot" | "noteInboundProcessed" | "setState">>;
  outputRouter: {
    sendAll(outputs: AgentOutput[]): Promise<unknown>;
  };
  appendLog(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog(input: Omit<StoredMessageLog, "id" | "time" | "timeUtc">): StoredMessageLog;
  onHeartbeatPausedChange?: (paused: boolean) => void;
};

export type MessageRuntime = {
  ingestEvent(event: AgentEvent): void;
  ingestLifecycle(event: MessageLifecycleEvent): void;
  recoverPendingSessions(): void;
  pauseHeartbeat(): void;
  resumeHeartbeat(): void;
  processNow(): Promise<void>;
  getStatus(): {
    heartbeatPaused: boolean;
    pendingSessions: string[];
    processingSessions: string[];
    heartbeatScheduled: boolean;
  };
  flushAll(): Promise<void>;
};

export type MessageLifecycleEvent =
  | {
      kind: "reaction.created" | "reaction.deleted";
      plugin: string;
      externalEventId?: string;
      externalMessageId: string;
      conversationId?: string;
      actorId?: string;
      emoji: string;
      occurredAt: string;
      occurredAtUtc?: string;
      raw?: unknown;
    }
  | {
      kind: "message.read" | "message.recalled";
      plugin: string;
      externalEventId?: string;
      externalMessageId: string;
      conversationId?: string;
      actorId?: string;
      occurredAt: string;
      occurredAtUtc?: string;
      raw?: unknown;
    };

export function createMessageRuntime(deps: MessageRuntimeDeps): MessageRuntime {
  const latestSessionEvents = new Map<string, AgentEvent>();
  const pendingSessions = new Set<string>();
  const processingSessions = new Set<string>();
  const time = deps.time ?? createCurrentTimeProvider("UTC", deps.now);
  const now = () => time.now().date;
  const random = deps.random ?? Math.random;
  const llmFailureNotice = "-星界信号丢失-";
  const agentLoopRuntime = deps.agentLoopRuntime ?? createAgentLoopRuntime({
    prepareChat: ({ event, agentLoopRunSeq }) => deps.core.prepareEventRun(event, { agentLoopRunSeq }),
    prepareTalk: ({ sessionId, signal, agentLoopRunSeq }) => deps.talkRuntime?.prepareReadyAgentLoopSession?.(sessionId, { signal, agentLoopRunSeq })
  });
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => deps.getHeartbeatIntervalMs?.() ?? 1000,
    startPaused: deps.startHeartbeatPaused,
    tasks: {
      isIdleTransitionDue: () => isIdleTransitionDue(deps.agentState?.getSnapshot?.()),
      getIdleTransitionDelayMs: () => idleTransitionDelayMs(deps.agentState?.getSnapshot?.(), time.timeZone),
      onIdleTimerTransition: deps.onIdleTimerTransition,
      canRunHeartbeat,
      tickAgentState: () => {
        deps.agentState?.tick();
      },
      onHeartbeatTick: deps.onHeartbeatTick,
      hasPendingUserMessages,
      buildRandomizedInitiatedBehaviorEvent,
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
      getSleepCocoonGoodnightEvent: deps.getSleepCocoonGoodnightEvent,
      getCalendarReminderEvent: deps.getCalendarReminderEvent,
      appendLog: deps.appendLog
    },
    onPausedChange: deps.onHeartbeatPausedChange,
    appendLog: deps.appendLog
  });
  let previousAgentState = deps.agentState?.getSnapshot?.().state;
  const unsubscribeState = deps.agentState?.onChange((snapshot: AgentStateSnapshot | undefined) => {
    if (!snapshot) return;
    if (previousAgentState === "waiting" && snapshot.state === "idle" && snapshot.reason === "inactive") {
      deps.clearLLMSession?.("mode_transition");
    }
    previousAgentState = snapshot.state;
    heartbeat.schedule(0);
  });
  heartbeat.schedule(0);

  return {
    ingestEvent(event) {
      event = normalizeInboundEvent(event);
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
        deps.agentState?.setState?.("waiting", { reason: "force_wake", clearSleepCocoon: true });
        deps.clearLLMSession?.("force_wake");
        deps.onForceWake?.();
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
      latestSessionEvents.set(event.externalSession.sessionId, event);
      markPending(event.externalSession.sessionId);
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
    recoverPendingSessions() {
      recoverPendingSessionsFromStore();
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
      heartbeat.flush();
      unsubscribeState?.();
    }
  };

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
      const event = buildManualProcessEvent(target);
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
      await sendSystemNotice({
        plugin: target.plugin,
        accountId: target.accountId,
        channelId: target.channelId,
        userId: target.userId,
        sessionId: target.sessionId
      }, llmFailureNotice);
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
    if (agentLoopRuntime.isRunning()) return false;
    if (deps.isLLMSessionActive?.()) return false;
    return deps.agentState?.canRunHeartbeat() ?? true;
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
    const result = await agentLoopRuntime.requestRun({
      kind: "chat",
      sessionId: event.externalSession.sessionId,
      reason,
      event
    });
    if (!result.started) throw new Error("agent_loop_busy");
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

  function buildRandomizedInitiatedBehaviorEvent(): AgentEvent | undefined {
    const lastMessage = deps.store.listMessages(1).at(-1);
    if (!lastMessage) return undefined;
    const lastMessageAt = messageTimestamp(lastMessage);
    if (lastMessageAt === undefined) return undefined;
    const elapsedMs = Math.max(0, now().getTime() - lastMessageAt);
    const probability = Math.min(elapsedMs / (4 * 60 * 60 * 1000), 1) / 2;
    if (random() >= probability) return undefined;
    if (!hasRandomizedAgentInitiatedBehaviorPlan(deps.getAgentInitiatedBehaviorPlans?.() ?? defaultAgentInitiatedBehaviorPlans)) return undefined;
    const target = deps.getRandomInitiatedBehaviorTarget?.() ?? deps.getProcessNowTarget?.();
    if (!target) return undefined;
    const receivedTime = time.now();
    return {
      id: createId("evt"),
      source: {
        plugin: target.plugin,
        accountId: target.accountId,
        channelId: target.channelId,
        userId: target.userId
      },
      externalSession: {
        scope: "dm",
        sessionId: target.sessionId
      },
      type: "system.heartbeat",
      payload: {
        kind: "text",
        text: "A randomized proactive event was triggered. Use messaging tools to inspect context before sending a short, low-interruption message."
      },
      meta: {
        receivedAt: receivedTime.iso,
        receivedAtUtc: receivedTime.date.toISOString(),
        raw: {
          agentInitiatedTriggerEvent: "randomized"
        }
      }
    };
  }

  function messageTimestamp(message: StoredConversationMessage): number | undefined {
    const utcTimestamp = message.createdAtUtc ? Date.parse(message.createdAtUtc) : Number.NaN;
    if (Number.isFinite(utcTimestamp)) return utcTimestamp;
    const localTimestamp = parseZonedIso(message.createdAt, time.timeZone).getTime();
    return Number.isFinite(localTimestamp) ? localTimestamp : undefined;
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

    const agentEvent = buildAgentEventFromMessageLog(sessionId, pending);
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
        await sendSystemNotice(typingTargetFromPending(sessionId, pending, agentEvent, false), llmFailureNotice);
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

  async function sendSystemNotice(target: {
    plugin: string;
    accountId?: string;
    channelId?: string;
    userId?: string;
    sessionId: string;
  }, text: string): Promise<void> {
    const now = time.now();
    const output: AgentOutput = {
      id: createId("out"),
      target,
      content: { kind: "text", text },
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
      contentType: output.content.kind,
      contentText: summarizeOutput(output.content),
      contentJson: safeJson(output.content),
      createdAt: output.meta.createdAt,
      createdAtUtc: output.meta.createdAtUtc
    });
    try {
      const sendResults = await deps.outputRouter.sendAll([output]);
      const resultList = Array.isArray(sendResults) ? sendResults : [];
      deps.store.markOutboundMessageSent(stored.id, extractSentMessageId(resultList[0]), time.now().date.toISOString(), extractSentMessageCreatedAtUtc(resultList[0]));
      deps.appendMessageLog({
        direction: "outbound",
        plugin: output.target.plugin,
        kind: output.content.kind,
        target: output.target.channelId ?? output.target.userId,
        sessionId: output.target.sessionId,
        status: "sent",
        summary: summarizeOutput(output.content)
      });
    } catch (error) {
      const failedTime = time.now();
      const failedAt = failedTime.iso;
      const failedAtUtc = failedTime.date.toISOString();
      const reason = error instanceof Error ? error.message : String(error);
      deps.store.markOutboundMessageFailed(stored.id, failedAt, reason, failedAtUtc);
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
    deps.appendLog("error", `core failed; marked ${pending.length} inbound message(s) processed as failed, batch=${batchId}`);
  }

  function buildAgentEventFromMessageLog(sessionId: string, pending: StoredConversationMessage[]): AgentEvent {
    const latestLog = pending[pending.length - 1];
    const latestEvent = latestSessionEvents.get(sessionId);
    const allSessionLogs = deps.store.listMessagesForConversation(sessionId, 30);
    const text = "A chat message event was received. Use messaging tools to inspect conversation history before replying.";

    if (latestEvent) {
      return {
        ...latestEvent,
        id: latestEvent.id,
        source: {
          ...latestEvent.source,
          rawMessageId: latestLog.externalMessageId ?? latestEvent.source.rawMessageId
        },
        payload: { kind: "text", text },
        meta: {
          ...latestEvent.meta,
          replyTo: latestLog.externalMessageId ?? latestEvent.meta.replyTo,
          raw: {
            batchedFromMessageLog: true,
            pendingIds: pending.map((entry) => entry.id),
            contextCount: allSessionLogs.length,
            originalRaw: latestEvent.meta.raw
          }
        }
      };
    }

    return {
      id: createId("evt"),
      source: {
        plugin: latestLog.plugin,
        channelId: channelIdFromRecoveredMessage(latestLog),
        userId: userIdFromRecoveredMessage(latestLog),
        rawMessageId: latestLog.externalMessageId
      },
      externalSession: {
        scope: "dm",
        sessionId
      },
      type: "message.text",
      payload: { kind: "text", text },
      meta: {
        receivedAt: latestLog.createdAt,
        receivedAtUtc: latestLog.createdAtUtc,
        replyTo: latestLog.externalMessageId,
        raw: {
          recoveredFromMessageLog: true,
          pendingIds: pending.map((entry) => entry.id)
        }
      }
    };
  }

  function buildManualProcessEvent(target: NonNullable<ReturnType<NonNullable<MessageRuntimeDeps["getProcessNowTarget"]>>>): AgentEvent {
    const receivedTime = time.now();
    const receivedAt = receivedTime.iso;
    const receivedAtUtc = receivedTime.date.toISOString();
    return {
      id: createId("evt"),
      source: {
        plugin: target.plugin,
        accountId: target.accountId,
        channelId: target.channelId,
        userId: target.userId
      },
      externalSession: {
        scope: "dm",
        sessionId: target.sessionId
      },
      type: "message.text",
      payload: {
        kind: "text",
        text: "A manual process-now event was requested from the admin panel. Use messaging tools to inspect conversation history before replying."
      },
      meta: {
        receivedAt,
        receivedAtUtc,
        raw: {
          adminProcessNow: true
        }
      }
    };
  }

  function channelIdFromRecoveredMessage(message: StoredConversationMessage): string {
    if (message.plugin === "wechat") return userIdFromWechatConversationId(message.conversationId);
    return message.conversationId;
  }

  function userIdFromRecoveredMessage(message: StoredConversationMessage): string | undefined {
    if (message.plugin === "wechat") return userIdFromWechatConversationId(message.conversationId);
    return message.senderId;
  }

  function userIdFromWechatConversationId(conversationId: string): string {
    return conversationId.startsWith("wechat:dm:") ? conversationId.slice("wechat:dm:".length) : conversationId;
  }
}

export function summarizePayload(payload: { kind: string; text?: string; markdown?: string; assetId?: string; url?: string; filename?: string; transcript?: string }): string {
  if (payload.kind === "audio") return summarizeAudioText(payload.transcript, payload.assetId);
  if (payload.kind === "text" && payload.text) return sanitizeMessageText(payload.text);
  return payload.text ?? payload.markdown ?? payload.assetId ?? payload.url ?? payload.filename ?? payload.kind;
}

function summarizeEventPayload(event: AgentEvent): string {
  const content = summarizePayload(event.payload);
  const quote = event.meta.quotedMessage;
  if (!quote) return content;
  const parts = [
    quote.senderId ? `from ${quote.senderId}` : undefined,
    quote.rawMessageId ? `#${quote.rawMessageId}` : undefined,
    quote.text
  ].filter((part): part is string => Boolean(part));
  return `-引用:${parts.join(" ")}-\n${content}`;
}

export function summarizeOutput(content: { kind: string; text?: string; markdown?: string; assetId?: string; filename?: string; transcript?: string }): string {
  if (content.kind === "audio") return summarizeAudioText(content.transcript, content.assetId);
  if (content.kind === "text" && content.text) return sanitizeMessageText(content.text);
  return content.text ?? content.markdown ?? content.assetId ?? content.filename ?? content.kind;
}

function normalizeInboundEvent(event: AgentEvent): AgentEvent {
  if (event.payload.kind === "audio") {
    return {
      ...event,
      payload: {
        ...event.payload,
        transcript: sanitizeAudioTranscript(event.payload.transcript)
      }
    };
  }
  if (event.payload.kind === "text") {
    return {
      ...event,
      payload: {
        ...event.payload,
        text: sanitizeMessageText(event.payload.text)
      }
    };
  }
  return event;
}

function formatContextLine(entry: StoredConversationMessage): string {
  const speaker = entry.direction === "inbound" ? "User" : "Assistant";
  const recalled = entry.isRecalled ? " [recalled]" : "";
  const read = entry.isRead ? " [read]" : "";
  const reactions = summarizeReactions(entry.reactionsJson);
  return `${speaker}${recalled}${read}${reactions ? ` [reactions: ${reactions}]` : ""}: ${entry.isRecalled ? "(message recalled)" : entry.contentText}`;
}

function summarizeReactions(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, { count?: unknown }>;
    return Object.entries(parsed)
      .map(([emoji, value]) => `${emoji}:${typeof value.count === "number" ? value.count : 0}`)
      .filter((part) => !part.endsWith(":0"))
      .join(", ");
  } catch {
    return "";
  }
}

function lifecycleSummary(event: MessageLifecycleEvent): string {
  if (event.kind === "reaction.created" || event.kind === "reaction.deleted") {
    return `${event.kind} ${event.emoji} on ${event.externalMessageId}`;
  }
  return `${event.kind} ${event.externalMessageId}`;
}

function safeJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function extractSentMessageId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { messageId?: unknown };
  return typeof record.messageId === "string" ? record.messageId : undefined;
}

function extractSentMessageCreatedAtUtc(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { createdAtUtc?: unknown };
  return typeof record.createdAtUtc === "string" ? record.createdAtUtc : undefined;
}
