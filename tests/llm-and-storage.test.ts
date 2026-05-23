import { test } from "node:test";
import assert from "node:assert/strict";
import { createMutableLLMClient, type LLMClient } from "../core/llm/src/index.js";
import { createAliceStore } from "../packages/storage/src/sqlite-store.js";

const fs = await import("node:fs");
const path = await import("node:path");
const sqlite = await import("node:sqlite");

test("mutable LLM client delegates to the latest configured client", async () => {
  const first = namedClient("first");
  const second = namedClient("second");
  const client = createMutableLLMClient(first);

  assert.equal((await client.chat({ messages: [] })).message.content, "first");
  client.setClient(second);
  assert.equal((await client.chat({ messages: [] })).message.content, "second");
  assert.deepEqual(await client.listModels?.(), [{ id: "second" }]);
});

test("sqlite store initializes schema version without losing existing logs", () => {
  const dir = makeTempDir("db");
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

  const reopened = createAliceStore(dbPath);
  assert.equal(reopened.listMessageLogs(10).length, 1);
  assert.equal(reopened.listMessageLogsForSession("session-1", 10)[0].summary, "hello");
  assert.equal(reopened.listUnprocessedInboundForSession("session-1", 10).length, 1);
  const pending = reopened.listPendingInboundSessions();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sessionId, "session-1");
  reopened.markMessageLogsProcessed([reopened.listMessageLogsForSession("session-1", 10)[0].id], "2026-05-24T00:01:00.000Z", "batch_1");
  assert.equal(reopened.listUnprocessedInboundForSession("session-1", 10).length, 0);

  const db: any = new sqlite.DatabaseSync(dbPath);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
});

test("sqlite migration marks legacy inbound logs processed", () => {
  const dir = makeTempDir("legacy-db");
  const dbPath = path.join(dir, "alice.sqlite");
  const db: any = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    PRAGMA user_version = 2;
    CREATE TABLE message_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      direction TEXT NOT NULL,
      plugin TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT,
      session_id TEXT,
      summary TEXT NOT NULL
    );
    INSERT INTO message_logs(time, direction, plugin, kind, target, session_id, summary)
    VALUES ('2026-05-24T00:00:00.000Z', 'inbound', 'feishu', 'text', 'chat', 'session-legacy', 'old');
  `);

  const store = createAliceStore(dbPath);
  assert.equal(store.listUnprocessedInboundForSession("session-legacy", 10).length, 0);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
});

function namedClient(name: string): LLMClient {
  return {
    async chat() {
      return { message: { role: "assistant", content: name } };
    },
    async listModels() {
      return [{ id: name }];
    }
  };
}

function makeTempDir(name: string): string {
  const dir = path.join("/tmp", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
