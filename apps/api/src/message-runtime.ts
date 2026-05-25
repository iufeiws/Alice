import type { AgentEvent, AgentOutput } from "../../../packages/types/src/index.js";
import { createId } from "../../../packages/types/src/index.js";
import type { AgentStateController } from "../../../core/agent/src/state.js";
import { createCurrentTimeProvider, type CurrentTimeProvider } from "../../../core/time/src/index.js";
import type {
  InsertOutboundMessageInput,
  StoredConversationMessage,
  StoredMessageLog,
  UpdateMessageReactionInput,
  UpsertInboundMessageInput
} from "../../../packages/storage/src/sqlite-store.js";

export type MessageRuntimeDeps = {
  getDelayMs(): number;
  getHeartbeatIntervalMs?: () => number;
  now?: () => Date;
  time?: CurrentTimeProvider;
  store: {
    insertMessageLog(input: Omit<StoredMessageLog, "id">): StoredMessageLog;
    upsertInboundMessage(input: UpsertInboundMessageInput): StoredConversationMessage;
    insertOutboundMessage(input: InsertOutboundMessageInput): StoredConversationMessage;
    listMessagesForConversation(conversationId: string, limit: number): StoredConversationMessage[];
    listUnprocessedCoreMessagesForConversation(conversationId: string, limit: number): StoredConversationMessage[];
    listPendingCoreConversations(): Array<{ conversationId: string }>;
    markMessagesCoreProcessed(ids: number[], processedAt: string, batchId: string): void;
    markOutboundMessageSent(id: number, externalMessageId: string | undefined, sentAt: string): void;
    markOutboundMessageFailed(id: number, failedAt: string, failureReason: string): void;
    markMessageRead(plugin: string, externalMessageId: string, readAt: string): boolean;
    markMessageRecalled(plugin: string, externalMessageId: string, recalledAt: string): boolean;
    updateMessageReaction(input: UpdateMessageReactionInput): boolean;
  };
  core: {
    handleEvent(event: AgentEvent): Promise<AgentOutput[]>;
  };
  agentState?: Pick<
    AgentStateController,
    "canReplyToInbound" | "canRunHeartbeat" | "getInboundDelayMs" | "noteInboundMessage" | "onChange" | "tick"
  >;
  outputRouter: {
    sendAll(outputs: AgentOutput[]): Promise<unknown>;
  };
  appendLog(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog(input: Omit<StoredMessageLog, "id" | "time">): StoredMessageLog;
};

export type MessageRuntime = {
  ingestEvent(event: AgentEvent): void;
  ingestLifecycle(event: MessageLifecycleEvent): void;
  recoverPendingSessions(): void;
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
      raw?: unknown;
    };

export function createMessageRuntime(deps: MessageRuntimeDeps): MessageRuntime {
  const latestSessionEvents = new Map<string, AgentEvent>();
  const pendingSessions = new Set<string>();
  const processingSessions = new Set<string>();
  const time = deps.time ?? createCurrentTimeProvider("UTC", deps.now);
  const now = () => time.now().date;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribeState = deps.agentState?.onChange(() => scheduleHeartbeat(0));
  scheduleHeartbeat(0);

  return {
    ingestEvent(event) {
      deps.agentState?.noteInboundMessage();
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
        summary: summarizePayload(event.payload)
      });
      const receivedAt = event.meta.receivedAt;
      deps.store.upsertInboundMessage({
        plugin: event.source.plugin,
        externalMessageId: event.source.rawMessageId ?? event.id,
        conversationId: event.session.sessionId,
        senderId: event.source.userId,
        senderRole: "user",
        contentType: event.payload.kind,
        contentText: summarizePayload(event.payload),
        contentJson: safeJson(event.payload),
        createdAt: receivedAt,
        lastEventAt: receivedAt,
        coreProcessedAt: event.payload.kind === "text" ? undefined : receivedAt
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
        deps.store.markMessageRead(event.plugin, event.externalMessageId, event.occurredAt);
        return;
      }
      if (event.kind === "message.recalled") {
        deps.store.markMessageRecalled(event.plugin, event.externalMessageId, event.occurredAt);
        return;
      }
      if (event.kind === "reaction.created" || event.kind === "reaction.deleted") {
        deps.store.updateMessageReaction({
          plugin: event.plugin,
          externalMessageId: event.externalMessageId,
          emoji: event.emoji,
          actorId: event.actorId,
          op: event.kind === "reaction.created" ? "add" : "remove",
          at: event.occurredAt
        });
      }
    },
    recoverPendingSessions() {
      for (const session of deps.store.listPendingCoreConversations()) {
        markPending(session.conversationId);
      }
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

  function scheduleHeartbeat(delayMs = deps.getHeartbeatIntervalMs?.() ?? 1000): void {
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

  async function runHeartbeat(options: { force?: boolean } = {}): Promise<void> {
    const force = options.force ?? false;
    deps.agentState?.tick();
    if (!force && !canRunHeartbeat()) {
      scheduleHeartbeat();
      return;
    }
    const sessionIds = [...pendingSessions];
    for (const sessionId of sessionIds) {
      if (processingSessions.has(sessionId)) continue;
      const pending = deps.store.listUnprocessedCoreMessagesForConversation(sessionId, 50);
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
  }

  function canRunHeartbeat(): boolean {
    return deps.agentState?.canRunHeartbeat() ?? true;
  }

  function shouldProcessPending(pending: StoredConversationMessage[]): boolean {
    if (deps.agentState && !deps.agentState.canReplyToInbound()) return false;
    const latest = pending[pending.length - 1];
    const delayMs = deps.agentState?.getInboundDelayMs() ?? deps.getDelayMs();
    return now().getTime() - new Date(latest.createdAt).getTime() >= delayMs;
  }

  async function handleDirtySession(sessionId: string): Promise<void> {
    const pending = deps.store.listUnprocessedCoreMessagesForConversation(sessionId, 50);
    if (pending.length === 0) {
      deps.appendLog("info", `dirty session skipped: no pending inbound ${sessionId}`);
      return;
    }

    const agentEvent = buildAgentEventFromMessageLog(sessionId, pending);
    deps.appendLog("info", `feishu session processing from message log: ${sessionId} pending=${pending.length}`);

    const outputs = await deps.core.handleEvent(agentEvent);
    const outboundMessages = outputs.map((output) => deps.store.insertOutboundMessage({
      plugin: output.target.plugin,
      conversationId: output.target.sessionId,
      senderRole: "assistant",
      contentType: output.content.kind,
      contentText: summarizeOutput(output.content),
      contentJson: safeJson(output.content),
      createdAt: output.meta.createdAt
    }));
    try {
      const sendResults = await deps.outputRouter.sendAll(outputs);
      const sentAt = time.now().iso;
      const resultList = Array.isArray(sendResults) ? sendResults : [];
      for (const [index, message] of outboundMessages.entries()) {
        deps.store.markOutboundMessageSent(message.id, extractSentMessageId(resultList[index]), sentAt);
      }
    } catch (error) {
      const failedAt = time.now().iso;
      const reason = error instanceof Error ? error.message : String(error);
      for (const message of outboundMessages) {
        deps.store.markOutboundMessageFailed(message.id, failedAt, reason);
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
    deps.appendLog("info", `feishu session handled: ${outputs.length} output(s), batch=${batchId}`);
  }

  function buildAgentEventFromMessageLog(sessionId: string, pending: StoredConversationMessage[]): AgentEvent {
    const latestLog = pending[pending.length - 1];
    const latestEvent = latestSessionEvents.get(sessionId);
    const allSessionLogs = deps.store.listMessagesForConversation(sessionId, 30);
    const context = allSessionLogs
      .filter((entry) => entry.id < pending[0].id)
      .slice(-12)
      .map((entry) => formatContextLine(entry))
      .join("\n");
    const latestText = pending.map((entry) => entry.contentText).join("\n");
    const text = context
      ? `Conversation context:\n${context}\n\nLatest user messages:\n${latestText}`
      : latestText;

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
        channelId: latestLog.conversationId,
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
        replyTo: latestLog.externalMessageId,
        raw: {
          recoveredFromMessageLog: true,
          pendingIds: pending.map((entry) => entry.id)
        }
      }
    };
  }
}

export function summarizePayload(payload: { kind: string; text?: string; markdown?: string; assetId?: string; url?: string; filename?: string }): string {
  return payload.text ?? payload.markdown ?? payload.assetId ?? payload.url ?? payload.filename ?? payload.kind;
}

export function summarizeOutput(content: { kind: string; text?: string; markdown?: string; assetId?: string; filename?: string }): string {
  return content.text ?? content.markdown ?? content.assetId ?? content.filename ?? content.kind;
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
