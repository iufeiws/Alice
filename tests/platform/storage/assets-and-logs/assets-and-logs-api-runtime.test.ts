import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiLogRuntime } from "../../../../src/apps/api/bootstrap/api-log-runtime.js";
import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";

test("api log runtime appends system logs to memory and configured storage", () => {
  const current = new Date("2026-05-23T00:00:00.000Z");
  const stored: Array<{ time: string; utcTime?: string; level: string; message: string }> = [];
  const runtime = createApiLogRuntime({
    time: createCurrentTimeProvider("UTC", () => current),
    getMessageStore: () => undefined,
    getSystemLogStore: () => ({
      append(input: { time: string; utcTime?: string; level: "info" | "warn" | "error"; message: string }) {
        stored.push(input);
        return { id: stored.length, ...input };
      },
      listRecent: () => [],
      cleanupOlderThan: () => 0
    })
  });

  runtime.appendLog("info", "ordinary log");

  assert.deepEqual(runtime.logs.map(({ id, level, message }) => ({ id, level, message })), [
    { id: 1, level: "info", message: "ordinary log" }
  ]);
  assert.deepEqual(stored.map(({ level, message }) => ({ level, message })), [
    { level: "info", message: "ordinary log" }
  ]);
  assert.equal(runtime.logs[0].time, stored[0].time);
  assert.equal(runtime.logs[0].utcTime, stored[0].utcTime);
});

test("api log runtime hydrates persisted log state before assigning new ids", () => {
  const runtime = createApiLogRuntime({
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-23T00:00:01.000Z")),
    getMessageStore: () => undefined,
    getSystemLogStore: () => undefined
  });

  runtime.hydrateSystemLogs([{ id: 7, time: "2026-05-23T00:00:00.000", utcTime: "2026-05-23T00:00:00.000Z", level: "warn", message: "persisted" }]);
  runtime.appendLog("error", "next");

  assert.deepEqual(runtime.logs.map(({ id, level, message }) => ({ id, level, message })), [
    { id: 7, level: "warn", message: "persisted" },
    { id: 8, level: "error", message: "next" }
  ]);
});

test("api log runtime appends message logs to memory and configured storage", () => {
  const stored: unknown[] = [];
  const runtime = createApiLogRuntime({
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-23T00:00:00.000Z")),
    getSystemLogStore: () => undefined,
    getMessageStore: () => ({
      insertMessageLog(input: unknown) {
        stored.push(input);
      }
    } as any)
  });

  const entry = runtime.appendMessageLog({
    direction: "inbound",
    plugin: "wechat",
    kind: "text",
    rawMessageId: "msg-1",
    status: "received",
    summary: "hello log"
  });

  assert.equal(entry.id, 1);
  assert.equal(runtime.messageLogs[0], entry);
  assert.deepEqual(stored, [{
    time: entry.time,
    timeUtc: entry.timeUtc,
    direction: "inbound",
    plugin: "wechat",
    kind: "text",
    target: undefined,
    sessionId: undefined,
    rawMessageId: "msg-1",
    processedAt: undefined,
    processedBatchId: undefined,
    externalEventId: undefined,
    parentRawMessageId: undefined,
    actorId: undefined,
    status: "received",
    rawJson: undefined,
    error: undefined,
    summary: "hello log"
  }]);
});
