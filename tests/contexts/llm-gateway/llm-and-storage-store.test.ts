import { test } from "node:test";
import assert from "node:assert/strict";
import { createAliceStore } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { createTokenUsageStore } from "../../../src/platform/storage/src/token-usage-store.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import * as sqlite from "../../../src/platform/storage/src/sqlite-compat.js";
import { path, makeTempDir } from "./llm-and-storage-helpers.js";

test("token usage store aggregates cache hit rate by hour", () => {
  const dir = makeTempDir("token-usage");
  const store = createTokenUsageStore(path.join(dir, "logs", "token_usage", "token-usage.sqlite"));
  store.insert({
    createdAt: "2026-05-30T10:05:00.000",
    agentId: "chat",
    model: "deepseek-chat",
    sessionId: 1,
    requestId: 1,
    responseId: 1,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cacheHitTokens: 60,
    cacheMissTokens: 40,
    rawUsageJson: "{\"prompt_tokens\":100}"
  });
  store.insert({
    createdAt: "2026-05-30T10:35:00.000",
    agentId: "chat",
    model: "deepseek-chat",
    inputTokens: 50,
    outputTokens: 10,
    totalTokens: 60,
    cacheHitTokens: 25
  });
  store.insert({
    createdAt: "2026-05-30T11:00:00.000",
    agentId: "side",
    model: "other",
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15
  });

  const report = store.report({
    since: "2026-05-30T10:00:00.000",
    bucket: "hour",
    agentId: "chat",
    model: "deepseek-chat"
  });
  assert.equal(report.summary.requests, 2);
  assert.equal(report.summary.totalTokens, 180);
  assert.equal(report.summary.cacheHitTokens, 85);
  assert.equal(report.summary.cacheMissTokens, 40);
  assert.equal(Math.round((report.summary.cacheHitRate ?? 0) * 1000) / 1000, 0.68);
  assert.deepEqual(report.buckets.map((bucket) => bucket.bucket), ["2026-05-30T10:00"]);
});

test("token usage store aggregates by day", () => {
  const dir = makeTempDir("token-usage-empty");
  const store = createTokenUsageStore(path.join(dir, "token-usage.sqlite"));
  store.insert({
    createdAt: "2026-05-29T23:59:00.000",
    agentId: "chat",
    model: "unknown-usage",
    finishReason: "stop"
  });
  store.insert({
    createdAt: "2026-05-30T00:01:00.000",
    agentId: "chat",
    model: "unknown-usage",
    outputTokens: 3
  });

  const report = store.report({ bucket: "day" });
  assert.deepEqual(report.buckets.map((bucket) => bucket.bucket), ["2026-05-29", "2026-05-30"]);
});

test("token usage store keeps unknown usage rows", () => {
  const dir = makeTempDir("token-usage-unknown");
  const store = createTokenUsageStore(path.join(dir, "token-usage.sqlite"));
  store.insert({
    createdAt: "2026-05-29T23:59:00.000",
    agentId: "chat",
    model: "unknown-usage",
    finishReason: "stop"
  });
  store.insert({
    createdAt: "2026-05-30T00:01:00.000",
    agentId: "chat",
    model: "unknown-usage",
    outputTokens: 3
  });

  const report = store.report({ bucket: "day" });
  assert.equal(report.summary.requests, 2);
  assert.equal(report.summary.outputTokens, 3);
  assert.equal(report.summary.cacheHitRate, undefined);
  assert.equal(report.latest[0].model, "unknown-usage");
});

test("sqlite store preserves existing message logs after schema initialization", () => {
  const { reopened } = createStoreWithInboundLog("db-preserve-logs");
  assert.equal(reopened.listMessageLogs(10).length, 1);
  assert.equal(reopened.listMessageLogsForSession("session-1", 10)[0].summary, "hello");
});

test("sqlite store lists pending inbound sessions after schema initialization", () => {
  const { reopened } = createStoreWithInboundLog("db-pending-inbound");
  assert.equal(reopened.listUnprocessedInboundForSession("session-1", 10).length, 1);
  const pending = reopened.listPendingInboundSessions();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sessionId, "session-1");
});

test("sqlite store marks initialized inbound logs processed", () => {
  const { reopened } = createStoreWithInboundLog("db-processed-inbound");
  reopened.markMessageLogsProcessed([reopened.listMessageLogsForSession("session-1", 10)[0].id], "2026-05-24T00:01:00.000Z", "batch_1");
  assert.equal(reopened.listUnprocessedInboundForSession("session-1", 10).length, 0);
});

test("sqlite store initializes schema version", () => {
  const { dbPath } = createStoreWithInboundLog("db-schema-version");
  const db: any = new sqlite.DatabaseSync(dbPath);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 10);
});

test("sqlite store inserts inbound core-facing message state", () => {
  const { message } = createCoreMessageStore("messages-inbound");
  assert.equal(message.contentText, "hello");
});

test("sqlite store inserts outbound core-facing message state", () => {
  const { store } = createCoreMessageStore("messages-outbound");
  const outbound = store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "feishu:dm:ou_user",
    senderName: "shell",
    contentType: "text",
    contentText: "from shell",
    createdAt: "2026-05-24T00:01:00.000Z"
  });
  assert.equal(outbound.senderName, "shell");
});

test("sqlite store clears pending core conversation after message read", () => {
  const { store, message } = createCoreMessageStore("messages-pending");
  assert.equal(store.listPendingCoreConversations()[0].conversationId, "feishu:dm:ou_user");
  store.markMessagesReadAndCoreProcessed([message.id], "2026-05-24T00:04:00.000Z", "check_read_later");
  assert.deepEqual(store.listPendingCoreConversations(), []);
  assert.deepEqual(store.listUnprocessedCoreMessagesForConversation("feishu:dm:ou_user", 10), []);
});

test("sqlite store updates core-facing message reactions", () => {
  const { store } = createCoreMessageStore("messages-reaction");
  assert.equal(store.updateMessageReaction({
    plugin: "feishu",
    externalMessageId: "om_1",
    emoji: "thumbsup",
    actorId: "ou_other",
    op: "add",
    at: "2026-05-24T00:01:00.000Z"
  }), true);

  const updated = store.listMessagesForConversation("feishu:dm:ou_user", 10)[0];
  assert.deepEqual(JSON.parse(updated.reactionsJson), { thumbsup: { count: 1, users: ["ou_other"] } });
});

test("sqlite store updates core-facing message read state", () => {
  const { store } = createCoreMessageStore("messages-read");
  assert.equal(store.markMessageRead("feishu", "om_1", "2026-05-24T00:02:00.000Z"), true);

  const updated = store.listMessagesForConversation("feishu:dm:ou_user", 10)[0];
  assert.equal(Boolean(updated.isRead), true);
  assert.equal(updated.readAt, "2026-05-24T00:02:00.000");
});

test("sqlite store updates core-facing message recalled state", () => {
  const { store } = createCoreMessageStore("messages-recall");
  assert.equal(store.markMessageRecalled("feishu", "om_1", "2026-05-24T00:03:00.000Z"), true);

  const updated = store.listMessagesForConversation("feishu:dm:ou_user", 10)[0];
  assert.equal(Boolean(updated.isRecalled), true);
});

function createCoreMessageStore(name: string) {
  const dir = makeTempDir(name);
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  const message = store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "feishu:dm:ou_user",
    senderId: "ou_user",
    contentType: "text",
    contentText: "hello",
    contentJson: JSON.stringify({ text: "hello" }),
    createdAt: "2026-05-24T00:00:00.000Z"
  });
  return { store, message };
}

test("sqlite store lists messages chronologically", () => {
  const dir = makeTempDir("message-range");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session",
    contentType: "text",
    contentText: "one",
    createdAt: "2026-05-24T00:00:00.000Z"
  });
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session",
    contentType: "text",
    contentText: "two",
    createdAt: "2026-05-24T01:00:00.000Z"
  });
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_3",
    conversationId: "session",
    contentType: "text",
    contentText: "three",
    createdAt: "2026-05-24T07:00:00.000Z"
  });

  assert.deepEqual(store.listMessagesChronological().map((message) => message.contentText), ["one", "two", "three"]);
});

test("sqlite store lists messages by created range", () => {
  const dir = makeTempDir("message-created-range");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session",
    contentType: "text",
    contentText: "one",
    createdAt: "2026-05-24T00:00:00.000Z"
  });
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session",
    contentType: "text",
    contentText: "two",
    createdAt: "2026-05-24T01:00:00.000Z"
  });
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_3",
    conversationId: "session",
    contentType: "text",
    contentText: "three",
    createdAt: "2026-05-24T07:00:00.000Z"
  });

  assert.deepEqual(
    store.listMessagesByCreatedAtRange("2026-05-24T00:30:00.000Z", "2026-05-24T07:00:00.000Z").map((message) => message.contentText),
    ["two"]
  );
  assert.deepEqual(
    store.listMessagesByCreatedAtRange("2026-05-24T00:00:00.000Z", "2026-05-24T01:00:00.000Z").map((message) => message.contentText),
    ["one"]
  );
});

test("sqlite store derives local message log time from UTC source time", () => {
  const store = createUtcSourceStore("message-log-utc-source");
  const log = store.insertMessageLog({
    time: "ignored-local",
    timeUtc: "2026-06-02T15:26:34.819Z",
    direction: "inbound",
    plugin: "feishu",
    kind: "text",
    summary: "hello"
  });
  assert.equal(log.timeUtc, "2026-06-02T15:26:34.819Z");
  assert.equal(log.time, "2026-06-02T23:26:34.819");
});

test("sqlite store derives local inbound message time from UTC source time", () => {
  const store = createUtcSourceStore("inbound-utc-source");
  const inbound = store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_utc",
    conversationId: "session",
    contentType: "text",
    contentText: "one",
    createdAt: "ignored-local",
    createdAtUtc: "2026-06-02T15:26:34.819Z"
  });
  assert.equal(inbound.createdAtUtc, "2026-06-02T15:26:34.819Z");
  assert.equal(inbound.createdAt, "2026-06-02T23:26:34.819");
});

test("sqlite store derives local outbound sent time from UTC source time", () => {
  const store = createUtcSourceStore("outbound-utc-source");
  const outbound = store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session",
    contentType: "text",
    contentText: "two",
    createdAt: "ignored-local",
    createdAtUtc: "2026-06-02T15:29:58.129Z"
  });
  store.markOutboundMessageSent(outbound.id, "om_sent", "2026-06-02T15:29:59.326Z", "2026-06-02T15:29:58.129Z");
  const sent = store.listMessagesForConversation("session", 10).find((message) => message.id === outbound.id);
  assert.equal(sent?.createdAtUtc, "2026-06-02T15:29:58.129Z");
  assert.equal(sent?.createdAt, "2026-06-02T23:29:58.129");
  assert.equal(sent?.lastEventAtUtc, "2026-06-02T15:29:59.326Z");
  assert.equal(sent?.lastEventAt, "2026-06-02T23:29:59.326");
});

function createUtcSourceStore(name: string) {
  const dir = makeTempDir(name);
  return createAliceStore(path.join(dir, "alice.sqlite"), {
    time: createCurrentTimeProvider("Asia/Shanghai")
  });
}

function createStoreWithInboundLog(name: string) {
  const dir = makeTempDir(name);
  const dbPath = path.join(dir, "alice.sqlite");
  const store = createAliceStore(dbPath);
  store.insertMessageLog({
    time: "2026-05-24T00:00:00.000Z",
    direction: "inbound",
    plugin: "feishu",
    kind: "text",
    target: "chat",
    sessionId: "session-1",
    rawMessageId: "om_1",
    summary: "hello"
  });
  return { dbPath, reopened: createAliceStore(dbPath) };
}
