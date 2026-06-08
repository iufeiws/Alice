import type { CurrentTimeProvider } from "../../../../core/time/src/index.js";
import type { createAliceStore } from "../../../../packages/storage/src/sqlite-store.js";
import type { createFileLogStore } from "../../../../packages/storage/src/file-log-store.js";

export type LogLevel = "info" | "warn" | "error";

export type LogEntry = {
  id: number;
  time: string;
  utcTime?: string;
  level: LogLevel;
  message: string;
};

export type MessageLogEntry = {
  id: number;
  time: string;
  timeUtc?: string;
  direction: "inbound" | "outbound";
  plugin: string;
  kind: string;
  target?: string;
  sessionId?: string;
  rawMessageId?: string;
  processedAt?: string;
  processedBatchId?: string;
  externalEventId?: string;
  parentRawMessageId?: string;
  actorId?: string;
  status?: string;
  rawJson?: string;
  error?: string;
  summary: string;
};

type AliceStore = ReturnType<typeof createAliceStore>;
type FileLogStore = ReturnType<typeof createFileLogStore>;

export function createApiLogRuntime(input: {
  time: CurrentTimeProvider;
  getMessageStore(): AliceStore | undefined;
  getSystemLogStore(): FileLogStore | undefined;
}) {
  const logs: LogEntry[] = [];
  const messageLogs: MessageLogEntry[] = [];
  let nextLogId = 1;
  let nextMessageLogId = 1;

  return {
    logs,
    messageLogs,
    appendLog,
    appendMessageLog,
    formatLogArg,
    hydrateSystemLogs(entries: LogEntry[]) {
      for (const entry of entries) {
        logs.push(entry);
        nextLogId = Math.max(nextLogId, entry.id + 1);
      }
    },
    hydrateMessageLogs(entries: MessageLogEntry[]) {
      for (const entry of entries) {
        messageLogs.push(entry);
        nextMessageLogId = Math.max(nextMessageLogId, entry.id + 1);
      }
    }
  };

  function appendLog(level: LogLevel, message: string): void {
    const now = input.time.now();
    const entry = {
      id: nextLogId,
      time: now.iso,
      utcTime: now.date.toISOString(),
      level,
      message
    };
    logs.push(entry);
    nextLogId += 1;
    input.getSystemLogStore()?.append({
      time: entry.time,
      utcTime: entry.utcTime,
      level: entry.level,
      message: entry.message
    });

    if (logs.length > 500) {
      logs.splice(0, logs.length - 500);
    }
  }

  function appendMessageLog(entryInput: Omit<MessageLogEntry, "id" | "time" | "timeUtc">): MessageLogEntry {
    const now = input.time.now();
    const entry = {
      id: nextMessageLogId,
      time: now.iso,
      timeUtc: now.date.toISOString(),
      ...entryInput,
      summary: entryInput.summary.length > 500 ? `${entryInput.summary.slice(0, 500)}...` : entryInput.summary
    };
    messageLogs.push(entry);
    nextMessageLogId += 1;
    input.getMessageStore()?.insertMessageLog({
      time: entry.time,
      timeUtc: entry.timeUtc,
      direction: entry.direction,
      plugin: entry.plugin,
      kind: entry.kind,
      target: entry.target,
      sessionId: entry.sessionId,
      rawMessageId: entry.rawMessageId,
      processedAt: entry.processedAt,
      processedBatchId: entry.processedBatchId,
      externalEventId: entry.externalEventId,
      parentRawMessageId: entry.parentRawMessageId,
      actorId: entry.actorId,
      status: entry.status,
      rawJson: entry.rawJson,
      error: entry.error,
      summary: entry.summary
    });

    if (messageLogs.length > 500) {
      messageLogs.splice(0, messageLogs.length - 500);
    }
    return entry;
  }
}

export function formatLogArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
