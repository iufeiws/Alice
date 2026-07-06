import type { AgentEvent, AgentOutput } from "../../../agent-loop/src/contracts/agent-contracts.js";
import { createAgentHeartbeatRuntime } from "../../../agent-loop/src/runtime/agent-heartbeat-runtime.js";
import { createAgentLoopRuntime } from "../../../agent-loop/src/runtime/agent-loop-runtime.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import type { AgentStateSnapshot } from "../../../../contexts/agent-loop/src/domain/agent-loop-state.js";
import { createCurrentTimeProvider, parseZonedIso } from "../../../../platform/time/src/index.js";
import { describeError } from "../../../../shared/errors/src/index.js";
import type { StoredConversationMessage } from "../../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { lifecycleSummary, normalizeInboundEvent, summarizeEventPayload, summarizeOutput } from "./message-content.js";
import {
  buildAgentEventFromMessageLog,
  buildManualProcessEvent,
  buildRandomizedInitiatedBehaviorEvent
} from "./message-event-builders.js";
import { persistInboundAttachment } from "./inbound-attachments.js";
import type { MessageRuntime, MessageRuntimeDeps } from "./message-runtime-contracts.js";
import { extractSentMessageCreatedAtUtc, extractSentMessageId, isPromise, safeJson } from "./message-runtime-utils.js";

export function createMessageRuntime(deps: MessageRuntimeDeps): MessageRuntime {
  const latestSessionEvents = new Map<string, AgentEvent>();
  const pendingSessions = new Set<string>();
  const processingSessions = new Set<string>();
  const time = deps.time ?? createCurrentTimeProvider("UTC", deps.now);
  const now = () => time.now().date;
  const random = deps.random ?? Math.random;
  const llmFailureNotice = "-星界信号丢失-";
  const agentLoopRuntime = deps.agentLoopRuntime ?? createAgentLoopRuntime({
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
      canRunHeartbeat,
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

  function ingestStoredEvent(event: AgentEvent): void {
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
    if (shouldProcessInboundWithCore(event)) {
      agentLoopRuntime.noteInboundUserMessageInterrupt(event.externalSession.sessionId);
    }
    latestSessionEvents.set(event.externalSession.sessionId, event);
    markPending(event.externalSession.sessionId);
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
    deps.appendLog("error", `chat agent failed; marked ${pending.length} inbound message(s) processed as failed, batch=${batchId}`);
  }
}
