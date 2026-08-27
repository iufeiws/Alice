import { test } from "node:test";
import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import {
  agentMessagesTableName,
  createLLMSessionStore
} from "../../../src/contexts/llm-session/src/adapters/sqlite-llm-session-store.js";
import type { StoredLLMSession } from "../../../src/contexts/llm-session/src/adapters/sqlite-llm-session-store.js";
import { fs, path, makeTempDir } from "../llm-gateway/llm-and-storage-helpers.js";

const Database = BetterSqlite3 as any;

function dbFile(name: string): string {
  return path.join(makeTempDir(name), "sessions.sqlite");
}

function openRaw(dbPath: string) {
  const db = new Database(dbPath);
  return {
    db,
    tableInfo(table: string): Array<{ name: string; type: string; notnull: number; pk: number; dflt_value: unknown }> {
      return db.prepare(`PRAGMA table_info(${table})`).all();
    },
    close() {
      db.close();
    }
  };
}

function session(overrides: Partial<StoredLLMSession> = {}): StoredLLMSession {
  return {
    sessionId: "s1",
    agentType: "chat",
    startedAt: "2026-06-14T01:00:00.000",
    startedAtUtc: "2026-06-14T01:00:00.000Z",
    meta: { type: "llm_session", agent: "chat" },
    messages: [],
    ...overrides
  };
}

test("creates the exact six-column metadata table", () => {
  const dbPath = dbFile("store-six-columns");
  const store = createLLMSessionStore(dbPath);
  store.close();
  const raw = openRaw(dbPath);
  const columns = raw.tableInfo("llm_session_meta");
  assert.deepEqual(columns.map((column) => column.name), [
    "session_id",
    "agent_type",
    "started_at",
    "started_at_utc",
    "message_count",
    "meta_json"
  ], "llm_session_meta must have exactly the six fixed columns");
  const byName = new Map(columns.map((column) => [column.name, column]));
  assert.equal(byName.get("session_id")?.type, "TEXT");
  assert.equal(byName.get("session_id")?.pk, 1);
  assert.equal(byName.get("agent_type")?.type, "TEXT");
  assert.equal(byName.get("agent_type")?.notnull, 1);
  assert.equal(byName.get("started_at")?.notnull, 1);
  assert.equal(byName.get("started_at_utc")?.notnull, 1);
  assert.equal(byName.get("message_count")?.type, "INTEGER");
  assert.equal(byName.get("message_count")?.notnull, 1);
  assert.equal(byName.get("message_count")?.dflt_value, "0");
  assert.equal(byName.get("meta_json")?.type, "TEXT");
  assert.equal(byName.get("meta_json")?.notnull, 1);
  const tableSql = raw.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='llm_session_meta'").get().sql;
  assert.match(tableSql, /json_valid\(meta_json\)/);
  assert.match(tableSql, /message_count\s*>=\s*0/);
  const indexes = raw.db.prepare("PRAGMA index_list(llm_session_meta)").all() as Array<{ name: string; origin: string }>;
  const namedIndexes = indexes.filter((index) => index.origin !== "pk").map((index) => index.name);
  assert.deepEqual(namedIndexes, ["llm_session_meta_agent_started_idx"]);
  const indexColumns = raw.db.prepare("PRAGMA index_info(llm_session_meta_agent_started_idx)").all()
    .map((row: any) => row.name);
  assert.deepEqual(indexColumns, ["agent_type", "started_at", "session_id"]);
  raw.close();
});

test("migrates request audit payloads out of main session metadata", () => {
  const dbPath = dbFile("store-remove-request-audit");
  const raw = openRaw(dbPath);
  raw.db.exec(`
    CREATE TABLE llm_session_meta (
      session_id TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL,
      started_at TEXT NOT NULL,
      started_at_utc TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
      meta_json TEXT NOT NULL CHECK (json_valid(meta_json))
    );
  `);
  raw.db.prepare(`
    INSERT INTO llm_session_meta(session_id, agent_type, started_at, started_at_utc, message_count, meta_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("legacy", "chat", "2026-06-14T01:00:00.000", "2026-06-14T01:00:00.000Z", 0, JSON.stringify({
    updatedAt: "2026-06-14T01:00:00.000",
    requestIds: [1],
    responseIds: [2],
    latestRequest: { messages: [{ role: "user", content: "duplicate" }] },
    latestResponse: { message: { role: "assistant", content: "duplicate" } },
    requests: [{ rawRequest: { messages: [{ role: "user", content: "duplicate" }] } }],
    responses: [{ message: { role: "assistant", content: "duplicate" } }]
  }));
  raw.close();

  const store = createLLMSessionStore(dbPath);
  assert.deepEqual(store.readMeta("legacy"), {
    updatedAt: "2026-06-14T01:00:00.000",
    requestIds: [1],
    responseIds: [2]
  });
  store.close();

  const migrated = openRaw(dbPath);
  assert.equal((migrated.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
  migrated.close();
});

test("creates exact three-column agent message tables", () => {
  const dbPath = dbFile("store-message-tables");
  const store = createLLMSessionStore(dbPath);
  store.create(session({ sessionId: "c1", agentType: "chat" }));
  store.create(session({ sessionId: "r1", agentType: "Research_Agent" }));
  store.close();
  const raw = openRaw(dbPath);
  const tables = raw.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row: any) => row.name);
  assert.ok(tables.includes("llm_messages_chat"));
  assert.ok(tables.includes("llm_messages__x52esearch_x5f_x41gent"), "agent type must be encoded into the table name");
  for (const table of ["llm_messages_chat", "llm_messages__x52esearch_x5f_x41gent"]) {
    const columns = raw.tableInfo(table);
    assert.deepEqual(columns.map((column) => column.name), ["session_id", "ordinal", "message_json"]);
    assert.equal(columns[0].type, "TEXT");
    assert.equal(columns[1].type, "INTEGER");
    assert.equal(columns[2].type, "TEXT");
    assert.ok(columns.every((column) => column.notnull === 1));
    const pk = columns.filter((column) => column.pk > 0).map((column) => column.name);
    assert.deepEqual(pk, ["session_id", "ordinal"], "primary key must be (session_id, ordinal)");
    const foreignKeys = raw.db.prepare(`PRAGMA foreign_key_list(${table})`).all() as any[];
    assert.equal(foreignKeys.length, 1);
    assert.equal(foreignKeys[0].table, "llm_session_meta");
    assert.equal(foreignKeys[0].on_delete, "CASCADE");
  }
  raw.close();
});

test("encodes agent type into a safe reversible table name", () => {
  assert.equal(agentMessagesTableName("chat"), "llm_messages_chat");
  assert.equal(agentMessagesTableName("talk"), "llm_messages_talk");
  assert.equal(agentMessagesTableName("memorize"), "llm_messages_memorize");
  assert.equal(agentMessagesTableName("Research_Agent"), "llm_messages__x52esearch_x5f_x41gent");
});

test("rejects duplicate session ids", () => {
  const store = createLLMSessionStore(dbFile("store-duplicate"));
  store.create(session({ sessionId: "dup", messages: [{ role: "user", content: "first" }] as any }));
  assert.throws(() => store.create(session({ sessionId: "dup", messages: [{ role: "user", content: "second" }] as any })));
  const loaded = store.read("dup");
  assert.deepEqual(loaded?.messages.map((message: any) => message.content), ["first"], "original session must be unchanged");
  store.close();
});

test("round trips mutable metadata without dropping unknown fields", () => {
  const store = createLLMSessionStore(dbFile("store-meta-roundtrip"));
  const meta = {
    type: "llm_session",
    agent: "chat",
    unknownField: { nested: [1, 2, { deep: true }] },
    futureFlag: true
  };
  store.create(session({ sessionId: "m1", meta }));
  assert.deepEqual(store.read("m1")?.meta, meta);
  const nextMeta = { ...meta, extra: "added later", unknownField: { nested: [3] } };
  store.updateMeta({ sessionId: "m1", meta: nextMeta });
  assert.deepEqual(store.read("m1")?.meta, nextMeta, "unknown fields must survive updateMeta untouched");
  store.close();
});

test("round trips complete message json in ordinal order", () => {
  const store = createLLMSessionStore(dbFile("store-message-roundtrip"));
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", type: "function", function: { name: "search", arguments: "{\"q\":\"x\"}" } }]
    },
    { role: "tool", toolCallId: "call_1", content: "result" }
  ];
  store.create(session({ sessionId: "m2", messages: messages as any }));
  const loaded = store.read("m2");
  assert.deepEqual(loaded?.messages, messages as any, "complete message json must round trip in ordinal order");
  store.append({
    sessionId: "m2",
    messages: [{ role: "assistant", content: "final" }] as any
  });
  const loaded2 = store.read("m2");
  assert.equal(loaded2?.messages.length, 5);
  assert.deepEqual(loaded2?.messages.slice(0, 4), messages as any);
  assert.equal((loaded2?.messages[4] as any).content, "final");
  store.close();
});

test("stores matching local and utc session start times", () => {
  const dbPath = dbFile("store-start-times");
  const store = createLLMSessionStore(dbPath);
  store.create(session({ sessionId: "t1", startedAt: "2026-06-14T09:19:01.271", startedAtUtc: "2026-06-14T01:19:01.271Z" }));
  store.close();
  const loaded = createLLMSessionStore(dbPath);
  assert.equal(loaded.read("t1")?.startedAt, "2026-06-14T09:19:01.271");
  assert.equal(loaded.read("t1")?.startedAtUtc, "2026-06-14T01:19:01.271Z");
  loaded.close();
  const raw = openRaw(dbPath);
  const row = raw.db.prepare("SELECT started_at, started_at_utc FROM llm_session_meta WHERE session_id = ?").get("t1");
  assert.deepEqual(row, { started_at: "2026-06-14T09:19:01.271", started_at_utc: "2026-06-14T01:19:01.271Z" });
  raw.close();
});

test("updates raw metadata without changing session start columns", () => {
  const dbPath = dbFile("store-start-frozen");
  const store = createLLMSessionStore(dbPath);
  store.create(session({ sessionId: "u1", startedAt: "2026-06-14T01:00:00.000", startedAtUtc: "2026-06-14T01:00:00.000Z", meta: { v: 1 } }));
  store.updateMeta({ sessionId: "u1", meta: { v: 2, agent: "chat" } });
  store.close();
  const loaded = createLLMSessionStore(dbPath);
  assert.equal(loaded.read("u1")?.startedAt, "2026-06-14T01:00:00.000");
  assert.equal(loaded.read("u1")?.startedAtUtc, "2026-06-14T01:00:00.000Z");
  assert.deepEqual(loaded.read("u1")?.meta, { v: 2, agent: "chat" });
  loaded.close();
  const raw = openRaw(dbPath);
  const row = raw.db.prepare("SELECT started_at, started_at_utc FROM llm_session_meta WHERE session_id = ?").get("u1");
  assert.equal(row.started_at, "2026-06-14T01:00:00.000");
  assert.equal(row.started_at_utc, "2026-06-14T01:00:00.000Z");
  raw.close();
});

test("appends messages and message count atomically", () => {
  const dbPath = dbFile("store-append");
  const store = createLLMSessionStore(dbPath);
  store.create(session({ sessionId: "a1", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] as any }));
  store.append({ sessionId: "a1", messages: [{ role: "user", content: "c" }, { role: "assistant", content: "d" }] as any });
  const loaded = store.read("a1");
  assert.equal(loaded?.messages.length, 4);
  assert.deepEqual(loaded?.messages.map((message: any) => message.content), ["a", "b", "c", "d"]);
  const items = store.list({ agentType: "chat", limit: 10 });
  assert.equal(items[0].messageCount, 4, "list messageCount must reflect the append");
  store.close();
  const raw = openRaw(dbPath);
  const row = raw.db.prepare("SELECT message_count FROM llm_session_meta WHERE session_id = ?").get("a1");
  assert.equal(row.message_count, 4);
  raw.close();
});

test("replaces messages and metadata atomically", () => {
  const dbPath = dbFile("store-replace");
  const store = createLLMSessionStore(dbPath);
  store.create(session({ sessionId: "r1", messages: [{ role: "user", content: "old" }] as any, meta: { v: 1 } }));
  store.replace({
    sessionId: "r1",
    messages: [{ role: "user", content: "only" }] as any,
    meta: { v: 2, replaced: true },
    reason: "talk_rebuild"
  });
  const loaded = store.read("r1");
  assert.deepEqual(loaded?.messages.map((message: any) => message.content), ["only"]);
  assert.deepEqual(loaded?.meta, { v: 2, replaced: true });
  assert.equal(store.list({ agentType: "chat", limit: 10 })[0].messageCount, 1);
  store.close();
  const raw = openRaw(dbPath);
  const rows = raw.db.prepare("SELECT ordinal FROM llm_messages_chat WHERE session_id = ?").all("r1");
  assert.deepEqual(rows.map((row: any) => row.ordinal), [0]);
  raw.close();
});

test("rolls back all database changes when a write fails", () => {
  const dbPath = dbFile("store-rollback");
  const store = createLLMSessionStore(dbPath);
  store.create(session({ sessionId: "rb1", messages: [{ role: "user", content: "keep me" }] as any }));
  // JSON.stringify cannot serialize BigInt, so the append fails part-way through writing.
  assert.throws(() => store.append({
    sessionId: "rb1",
    messages: [
      { role: "user", content: "will fail" },
      { role: "user", content: 1n }
    ] as any
  }));
  const loaded = store.read("rb1");
  assert.deepEqual(loaded?.messages.map((message: any) => message.content), ["keep me"], "failed append must not touch existing messages");
  assert.equal(store.list({ agentType: "chat", limit: 10 })[0].messageCount, 1);
  // a write after close must also fail without corrupting the database
  store.close();
  assert.throws(() => store.append({ sessionId: "rb1", messages: [{ role: "user", content: "late" }] as any }));
  const reopened = createLLMSessionStore(dbPath);
  assert.deepEqual(reopened.read("rb1")?.messages.map((message: any) => message.content), ["keep me"]);
  reopened.close();
});

test("lists sessions without reading metadata json or message tables", () => {
  const dbPath = dbFile("store-list-isolation");
  const store = createLLMSessionStore(dbPath);
  store.create(session({ sessionId: "l1", agentType: "chat", startedAt: "2026-06-14T01:00:00.000", messages: [{ role: "user", content: "x" }] as any }));
  store.create(session({ sessionId: "l2", agentType: "chat", startedAt: "2026-06-14T02:00:00.000", messages: [{ role: "user", content: "y" }, { role: "assistant", content: "z" }] as any }));
  store.create(session({ sessionId: "l3", agentType: "talk", startedAt: "2026-06-14T03:00:00.000" }));
  const raw = openRaw(dbPath);
  // replace meta_json so any parse would produce wrong data, then drop the message table:
  // list must still work purely off the fixed columns.
  raw.db.prepare("UPDATE llm_session_meta SET meta_json = ? WHERE session_id = ?").run("{\"agent\":\"corrupted\"}", "l2");
  raw.db.prepare("DROP TABLE llm_messages_chat").run();
  const items = store.list({ agentType: "chat", limit: 10 });
  assert.deepEqual(items.map((item) => item.sessionId), ["l2", "l1"], "list must order by started_at DESC");
  assert.deepEqual(items.map((item) => item.messageCount), [2, 1], "messageCount comes from the column, not meta_json");
  assert.deepEqual(items.map((item) => item.startedAt), ["2026-06-14T02:00:00.000", "2026-06-14T01:00:00.000"]);
  assert.deepEqual(items.map((item) => item.agentType), ["chat", "chat"]);
  const talkItems = store.list({ agentType: "talk", limit: 10 });
  assert.equal(talkItems.length, 1);
  assert.equal(talkItems[0].sessionId, "l3");
  assert.equal(store.list({ agentType: "chat", limit: 1 }).length, 1, "limit must be honored");
  store.close();
  raw.close();
});

test("loads only the selected agent message table", () => {
  const dbPath = dbFile("store-read-isolation");
  const store = createLLMSessionStore(dbPath);
  const chatMessage = { role: "user", content: "chat only" };
  store.create(session({ sessionId: "c1", agentType: "chat", messages: [chatMessage] as any }));
  store.create(session({ sessionId: "t1", agentType: "talk", messages: [{ role: "user", content: "talk only" }] as any }));
  const raw = openRaw(dbPath);
  // dropping the talk table must not affect reading the chat session
  raw.db.prepare("DROP TABLE llm_messages_talk").run();
  const loaded = store.read("c1");
  assert.deepEqual(loaded?.messages, [chatMessage] as any);
  assert.equal(loaded?.agentType, "chat");
  store.close();
  raw.close();
});

test("readMeta reads only the metadata row without message tables", () => {
  const dbPath = dbFile("store-readmeta-isolation");
  const store = createLLMSessionStore(dbPath);
  const meta = { type: "llm_session", agent: "chat", unknownField: { nested: true } };
  store.create(session({ sessionId: "rm1", meta, messages: [{ role: "user", content: "x" }] as any }));
  const raw = openRaw(dbPath);
  raw.db.prepare("DROP TABLE llm_messages_chat").run();
  assert.deepEqual(store.readMeta("rm1"), meta, "readMeta must return the full meta json without touching message tables");
  assert.equal(store.readMeta("missing"), undefined);
  store.close();
  raw.close();
});
