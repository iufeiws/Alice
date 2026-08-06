import { test } from "node:test";
import assert from "node:assert/strict";
import { createAliceStore, type AliceStore } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";

const path = await import("node:path");
const os = await import("node:os");

function makeTempDir(name: string): string {
  return path.join(os.tmpdir(), `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function upsertBoth(store: AliceStore, overrides: Partial<Parameters<AliceStore["upsertBothMessage"]>[0]> = {}) {
  return store.upsertBothMessage({
    plugin: "feishu",
    conversationId: "session-1",
    piSessionId: "pi-session-1",
    piInvocationId: "pi-inv-1",
    contentType: "text",
    contentText: "Pi result",
    createdAt: "2026-08-05T12:00:00.000",
    createdAtUtc: "2026-08-05T04:00:00.000Z",
    ...overrides
  });
}

test("upsertBothMessage creates one both message facing Alice as a user message", () => {
  const store = createAliceStore(path.join(makeTempDir("both-create"), "alice.sqlite"));
  const message = upsertBoth(store);

  assert.equal(message.direction, "both");
  assert.equal(message.senderRole, "user");
  assert.equal(message.status, "sending");
  assert.ok(!message.isRead);
  assert.equal(message.coreProcessedAt, null);
  assert.equal(message.piSessionId, "pi-session-1");
  assert.equal(message.piInvocationId, "pi-inv-1");
  assert.equal(store.listMessagesForConversation("session-1", 10).length, 1);
});

test("same piSessionId+piInvocationId never creates a second logical message", () => {
  const store = createAliceStore(path.join(makeTempDir("both-dedupe"), "alice.sqlite"));
  const first = upsertBoth(store);
  const second = upsertBoth(store, { contentText: "re-delivered" });
  const third = upsertBoth(store, { piInvocationId: "pi-inv-2", contentText: "second invocation" });

  assert.equal(second.id, first.id);
  assert.equal(second.contentText, "Pi result");
  assert.notEqual(third.id, first.id);
  assert.equal(store.listMessagesForConversation("session-1", 10).length, 2);
});

test("external read receipts never mark direction=both messages as read", () => {
  const store = createAliceStore(path.join(makeTempDir("both-read-receipt"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_user",
    conversationId: "session-1",
    senderRole: "user",
    contentType: "text",
    contentText: "hello",
    createdAt: "2026-08-05T11:00:00.000",
    createdAtUtc: "2026-08-05T03:00:00.000Z"
  });
  const both = upsertBoth(store);

  store.markMessageRead("feishu", "om_user", "2026-08-05T13:00:00.000", "2026-08-05T05:00:00.000Z");
  const readInbound = store.listMessagesForConversation("session-1", 10).find((entry) => entry.direction === "inbound");
  assert.ok(readInbound?.isRead);

  store.markMessageRead("feishu", "pi-missing", "2026-08-05T13:00:00.000", "2026-08-05T05:00:00.000Z");
  const bothAfter = store.listMessagesForConversation("session-1", 10).find((entry) => entry.id === both.id);
  assert.ok(!bothAfter?.isRead);
});

test("unprocessed both messages enter the Core pending queue regardless of send status", () => {
  const store = createAliceStore(path.join(makeTempDir("both-pending"), "alice.sqlite"));
  upsertBoth(store);

  assert.deepEqual(store.listPendingCoreConversations(), [{ conversationId: "session-1", latestMessageId: 1, latestTime: "2026-08-05T04:00:00.000" }]);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 1);

  store.markOutboundMessageSent(1, "om_pi", "2026-08-05T12:01:00.000Z");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 1, "user-facing send state does not consume the Core queue");

  store.markMessagesCoreProcessed([1], "2026-08-05T12:02:00.000", "batch-1");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
});

test("markMessagesReadAndCoreProcessed sets both fields on both messages independently", () => {
  const store = createAliceStore(path.join(makeTempDir("both-read-core"), "alice.sqlite"));
  const both = upsertBoth(store);
  const inbound = store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_user",
    conversationId: "session-1",
    senderRole: "user",
    contentType: "text",
    contentText: "hello",
    createdAt: "2026-08-05T11:00:00.000",
    createdAtUtc: "2026-08-05T03:00:00.000Z"
  });

  store.markMessagesReadAndCoreProcessed([both.id, inbound.id], "2026-08-05T13:00:00.000", "batch-1");
  const messages = store.listMessagesForConversation("session-1", 10);
  for (const entry of messages) {
    assert.ok(entry.isRead);
    assert.equal(entry.coreProcessedAt, "2026-08-05T13:00:00.000");
  }
});

test("migration adds pi columns to an existing message database without touching data", () => {
  const dir = makeTempDir("both-migrate");
  const dbPath = path.join(dir, "alice.sqlite");
  const legacy = createAliceStore(dbPath);
  legacy.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session-1",
    senderRole: "assistant",
    contentType: "text",
    contentText: "legacy",
    createdAt: "2026-08-01T12:00:00.000",
    createdAtUtc: "2026-08-01T04:00:00.000Z"
  });

  const migrated = createAliceStore(dbPath);
  const message = migrated.upsertBothMessage({
    plugin: "feishu",
    conversationId: "session-1",
    piSessionId: "pi-session-1",
    piInvocationId: "pi-inv-1",
    contentType: "text",
    contentText: "after migration",
    createdAt: "2026-08-05T12:00:00.000",
    createdAtUtc: "2026-08-05T04:00:00.000Z"
  });
  assert.equal(message.piSessionId, "pi-session-1");
  assert.equal(migrated.listMessagesForConversation("session-1", 10).length, 2);

  // The unique pi invocation index survives reopening; a duplicate upsert is still idempotent.
  const duplicate = migrated.upsertBothMessage({
    plugin: "feishu",
    conversationId: "session-1",
    piSessionId: "pi-session-1",
    piInvocationId: "pi-inv-1",
    contentType: "text",
    contentText: "duplicate",
    createdAt: "2026-08-05T12:00:00.000",
    createdAtUtc: "2026-08-05T04:00:00.000Z"
  });
  assert.equal(duplicate.id, message.id);
});
