import type { AgentEvent, AgentOutput } from "../../../packages/types/src/index.js";
import { createId } from "../../../packages/types/src/index.js";
import { createSessionDirtyFlagger, type SessionDirtyFlagger } from "../../../core/input-buffer/src/index.js";
import type { StoredMessageLog } from "../../../packages/storage/src/sqlite-store.js";

export type MessageRuntimeDeps = {
  getDelayMs(): number;
  store: {
    insertMessageLog(input: Omit<StoredMessageLog, "id">): StoredMessageLog;
    listMessageLogsForSession(sessionId: string, limit: number): StoredMessageLog[];
    listUnprocessedInboundForSession(sessionId: string, limit: number): StoredMessageLog[];
    listPendingInboundSessions(): Array<{ sessionId: string }>;
    markMessageLogsProcessed(ids: number[], processedAt: string, batchId: string): void;
  };
  core: {
    handleEvent(event: AgentEvent): Promise<AgentOutput[]>;
  };
  outputRouter: {
    sendAll(outputs: AgentOutput[]): Promise<void>;
  };
  appendLog(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog(input: Omit<StoredMessageLog, "id" | "time">): StoredMessageLog;
};

export type MessageRuntime = {
  ingestEvent(event: AgentEvent): void;
  recoverPendingSessions(): void;
  flushAll(): Promise<void>;
};

export function createMessageRuntime(deps: MessageRuntimeDeps): MessageRuntime {
  const latestSessionEvents = new Map<string, AgentEvent>();
  const dirtyFlagger: SessionDirtyFlagger = createSessionDirtyFlagger(
    deps.getDelayMs,
    async (sessionId) => {
      try {
        await handleDirtySession(sessionId);
      } catch (error) {
        deps.appendLog("error", `agent session failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  return {
    ingestEvent(event) {
      deps.appendMessageLog({
        direction: "inbound",
        plugin: event.source.plugin,
        kind: event.payload.kind,
        target: event.source.channelId ?? event.source.userId,
        sessionId: event.session.sessionId,
        rawMessageId: event.source.rawMessageId,
        summary: summarizePayload(event.payload)
      });
      latestSessionEvents.set(event.session.sessionId, event);
      dirtyFlagger.markDirty(event.session.sessionId);
    },
    recoverPendingSessions() {
      for (const session of deps.store.listPendingInboundSessions()) {
        dirtyFlagger.markDirty(session.sessionId);
      }
    },
    flushAll() {
      return dirtyFlagger.flushAll();
    }
  };

  async function handleDirtySession(sessionId: string): Promise<void> {
    const pending = deps.store.listUnprocessedInboundForSession(sessionId, 50);
    if (pending.length === 0) {
      deps.appendLog("info", `dirty session skipped: no pending inbound ${sessionId}`);
      return;
    }

    const agentEvent = buildAgentEventFromMessageLog(sessionId, pending);
    deps.appendLog("info", `feishu session processing from message log: ${sessionId} pending=${pending.length}`);

    const outputs = await deps.core.handleEvent(agentEvent);
    await deps.outputRouter.sendAll(outputs);
    for (const output of outputs) {
      deps.appendMessageLog({
        direction: "outbound",
        plugin: output.target.plugin,
        kind: output.content.kind,
        target: output.target.channelId ?? output.target.userId,
        sessionId: output.target.sessionId,
        summary: summarizeOutput(output.content)
      });
    }

    const processedAt = new Date().toISOString();
    const batchId = createId("batch");
    deps.store.markMessageLogsProcessed(pending.map((entry) => entry.id), processedAt, batchId);
    deps.appendLog("info", `feishu session handled: ${outputs.length} output(s), batch=${batchId}`);
  }

  function buildAgentEventFromMessageLog(sessionId: string, pending: StoredMessageLog[]): AgentEvent {
    const latestLog = pending[pending.length - 1];
    const latestEvent = latestSessionEvents.get(sessionId);
    const allSessionLogs = deps.store.listMessageLogsForSession(sessionId, 30);
    const context = allSessionLogs
      .filter((entry) => entry.id < pending[0].id)
      .slice(-12)
      .map((entry) => `${entry.direction === "inbound" ? "User" : "Assistant"}: ${entry.summary}`)
      .join("\n");
    const latestText = pending.map((entry) => entry.summary).join("\n");
    const text = context
      ? `Conversation context:\n${context}\n\nLatest user messages:\n${latestText}`
      : latestText;

    if (latestEvent) {
      return {
        ...latestEvent,
        id: latestEvent.id,
        source: {
          ...latestEvent.source,
          rawMessageId: latestLog.rawMessageId ?? latestEvent.source.rawMessageId
        },
        payload: { kind: "text", text },
        meta: {
          ...latestEvent.meta,
          replyTo: latestLog.rawMessageId ?? latestEvent.meta.replyTo,
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
        channelId: latestLog.target,
        rawMessageId: latestLog.rawMessageId
      },
      session: {
        scope: "dm",
        sessionId
      },
      type: "message.text",
      payload: { kind: "text", text },
      meta: {
        receivedAt: latestLog.time,
        replyTo: latestLog.rawMessageId,
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
