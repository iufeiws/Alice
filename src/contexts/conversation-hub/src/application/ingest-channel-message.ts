import type { AgentEvent, AgentOutput } from "../../../../packages/types/src/index.js";
import { createId, sanitizeAudioTranscript, sanitizeMessageText, summarizeAudioText } from "../../../../packages/types/src/index.js";
import type { AgentStateController, AgentStateSnapshot } from "../../../../core/agent/src/state.js";
import {
  defaultAgentInitiatedBehaviorPlans,
  selectRandomizedAgentInitiatedBehaviorPlan,
  type AgentInitiatedBehaviorPlan
} from "../../../../core/agent/src/initiated-behaviors.js";
import { createCurrentTimeProvider, parseZonedIso, type CurrentTimeProvider } from "../../../../core/time/src/index.js";
import type {
  InsertOutboundMessageInput,
  StoredConversationMessage,
  StoredMessageLog,
  UpdateMessageReactionInput,
  UpsertInboundMessageInput
} from "../../../../packages/storage/src/sqlite-store.js";

export type MessageRuntimeDeps = {
  getDelayMs(): number;
  getHeartbeatIntervalMs?: () => number;
  startHeartbeatPaused?: boolean;
  onHeartbeatTick?: () => void;
  getSleepCocoonGoodnightEvent?: () => AgentEvent | undefined;
  getSleepCocoonWakeEvent?: () => AgentEvent | undefined;
  getSleepCocoonMorningEvent?: () => AgentEvent | undefined;
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
    handleEvent(event: AgentEvent): Promise<AgentOutput[]>;
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
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatPaused = deps.startHeartbeatPaused === true;
  let previousAgentState = deps.agentState?.getSnapshot?.().state;
  const unsubscribeState = deps.agentState?.onChange((snapshot: AgentStateSnapshot | undefined) => {
    if (!snapshot) return;
    if (previousAgentState === "waiting" && snapshot.state === "idle" && snapshot.reason === "inactive") {
      deps.clearLLMSession?.("mode_transition");
    }
    previousAgentState = snapshot.state;
    scheduleHeartbeat(0);
  });
  scheduleHeartbeat(0);

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
        sessionId: event.session.sessionId,
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
        deps.appendLog("info", `force wake command handled: ${event.session.sessionId}`);
        return;
      }
      const receivedAt = event.meta.receivedAt;
      const receivedAtUtc = event.meta.receivedAtUtc;
      deps.store.upsertInboundMessage({
        plugin: event.source.plugin,
        externalMessageId: event.source.rawMessageId ?? event.id,
        conversationId: event.session.sessionId,
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
        sessionId: event.session.sessionId,
        receivedAt,
        receivedAtUtc
      });
      latestSessionEvents.set(event.session.sessionId, event);
      markPending(event.session.sessionId);
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
      heartbeatPaused = true;
      persistHeartbeatPaused();
      clearHeartbeat();
      deps.appendLog("info", "message runtime heartbeat paused");
    },
    resumeHeartbeat() {
      heartbeatPaused = false;
      persistHeartbeatPaused();
      deps.appendLog("info", "message runtime heartbeat resumed");
      scheduleHeartbeat(0);
    },
    async processNow() {
      recoverPendingSessionsFromStore();
      const processed = await runHeartbeat({ force: true });
      if (processed === 0) await runManualSession();
    },
    getStatus() {
      return {
        heartbeatPaused,
        pendingSessions: [...pendingSessions],
        processingSessions: [...processingSessions],
        heartbeatScheduled: Boolean(heartbeatTimer)
      };
    },
    async flushAll() {
      clearHeartbeat();
      unsubscribeState?.();
    }
  };

  function markPending(sessionId: string): void {
    pendingSessions.add(sessionId);
    scheduleHeartbeat(0);
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

  function scheduleHeartbeat(delayMs = deps.getHeartbeatIntervalMs?.() ?? 1000): void {
    if (heartbeatPaused) return;
    if (heartbeatTimer) return;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined;
      void runHeartbeat();
    }, Math.max(0, delayMs));
    (heartbeatTimer as { unref?: () => void }).unref?.();
  }

  function clearHeartbeat(): void {
    if (!heartbeatTimer) return;
    clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  function persistHeartbeatPaused(): void {
    try {
      deps.onHeartbeatPausedChange?.(heartbeatPaused);
    } catch (error) {
      deps.appendLog("warn", `message runtime heartbeat state persist failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function runHeartbeat(options: { force?: boolean } = {}): Promise<number> {
    const force = options.force ?? false;
    const beforeTick = deps.agentState?.getSnapshot?.();
    let processed = 0;
    const randomizedInitiatedEvent = !force
      && isIdleTransitionDue(beforeTick)
      && canRunHeartbeat()
      && !hasPendingUserMessages()
      ? buildRandomizedInitiatedBehaviorEvent()
      : undefined;
    if (randomizedInitiatedEvent) {
      const handled = await runGeneratedSession(randomizedInitiatedEvent, "randomized initiated behavior");
      if (handled) processed += 1;
      deps.agentState?.setState?.("waiting", { reason: "randomized_initiated_behavior" });
      if (!force) scheduleHeartbeat();
      return processed;
    }
    deps.agentState?.tick();
    if (!force && !canRunHeartbeat()) {
      scheduleHeartbeat();
      return 0;
    }
    if (canRunHeartbeat()) deps.onHeartbeatTick?.();
    const sleepCocoonWakeEvent = !force && canRunHeartbeat()
      ? (deps.getSleepCocoonWakeEvent?.() ?? deps.getSleepCocoonMorningEvent?.())
      : undefined;
    if (sleepCocoonWakeEvent) {
      const handled = await runGeneratedSession(sleepCocoonWakeEvent, "sleep cocoon wake");
      if (handled) processed += 1;
    }
    const sleepCocoonGoodnightEvent = !force && canRunHeartbeat() && !hasPendingUserMessages()
      ? deps.getSleepCocoonGoodnightEvent?.()
      : undefined;
    if (sleepCocoonGoodnightEvent) {
      const handled = await runGeneratedSession(sleepCocoonGoodnightEvent, "sleep cocoon goodnight");
      if (handled) processed += 1;
    }
    const sessionIds = [...pendingSessions];
    for (const sessionId of sessionIds) {
      if (processingSessions.has(sessionId)) continue;
      const pending = deps.store.listUnprocessedCoreMessagesForConversation(sessionId, Number.MAX_SAFE_INTEGER);
      if (pending.length === 0) {
        pendingSessions.delete(sessionId);
        continue;
      }
      if (!force && !shouldProcessPending(pending)) {
        continue;
      }

      processingSessions.add(sessionId);
      try {
        await handleDirtySession(sessionId);
        processed += 1;
        if (deps.store.listUnprocessedCoreMessagesForConversation(sessionId, 1).length === 0) {
          pendingSessions.delete(sessionId);
        }
      } catch (error) {
        deps.appendLog("error", `agent session failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        processingSessions.delete(sessionId);
      }
    }

    if (!force) scheduleHeartbeat();
    return processed;
  }

  async function runManualSession(): Promise<void> {
    const target = deps.getProcessNowTarget?.();
    if (!target) {
      deps.appendLog("warn", "process now skipped: no default messaging target");
      return;
    }
    if (processingSessions.has(target.sessionId)) {
      deps.appendLog("warn", `manual process now skipped: session already processing ${target.sessionId}`);
      return;
    }
    processingSessions.add(target.sessionId);
    try {
      await setTypingIndicator({ ...target, typing: true });
      const event = buildManualProcessEvent(target);
      deps.appendLog("info", `manual process now session started: ${target.sessionId}`);
      const outputs = await deps.core.handleEvent(event);
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
    } catch (error) {
      await sendSystemNotice({
        plugin: target.plugin,
        accountId: target.accountId,
        channelId: target.channelId,
        userId: target.userId,
        sessionId: target.sessionId
      }, llmFailureNotice);
      deps.appendLog("error", `manual process now failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await setTypingIndicator({ ...target, typing: false });
      processingSessions.delete(target.sessionId);
    }
  }

  async function runGeneratedSession(event: AgentEvent, label: string): Promise<boolean> {
    if (processingSessions.has(event.session.sessionId)) return false;
    processingSessions.add(event.session.sessionId);
    try {
      await setTypingIndicator({ ...event.source, sessionId: event.session.sessionId, typing: true });
      deps.appendLog("info", `${label} session started: ${event.session.sessionId}`);
      const outputs = await deps.core.handleEvent(event);
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
      deps.appendLog("error", `${label} session failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      await setTypingIndicator({ ...event.source, sessionId: event.session.sessionId, typing: false });
      processingSessions.delete(event.session.sessionId);
    }
  }

  function canRunHeartbeat(): boolean {
    if (deps.isLLMSessionActive?.()) return false;
    return deps.agentState?.canRunHeartbeat() ?? true;
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

  function buildRandomizedInitiatedBehaviorEvent(): AgentEvent | undefined {
    const lastMessage = deps.store.listMessages(1).at(-1);
    if (!lastMessage) return undefined;
    const lastMessageAt = messageTimestamp(lastMessage);
    if (lastMessageAt === undefined) return undefined;
    const elapsedMs = Math.max(0, now().getTime() - lastMessageAt);
    const probability = Math.min(elapsedMs / (4 * 60 * 60 * 1000), 1) / 2;
    if (random() >= probability) return undefined;
    const plan = selectRandomizedAgentInitiatedBehaviorPlan(
      deps.getAgentInitiatedBehaviorPlans?.() ?? defaultAgentInitiatedBehaviorPlans,
      random
    );
    if (!plan) return undefined;
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
      session: {
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
          agentInitiatedBehaviorId: plan.id,
          randomizedInitiatedBehavior: true
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
        outputs = await deps.core.handleEvent(agentEvent);
      } catch (error) {
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
    const reason = error instanceof Error ? error.message : String(error);
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
      session: {
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
      session: {
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
