import { test } from "node:test";
import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { migrateLLMSessionsToSQLite } from "../../scripts/migrate-llm-sessions-sqlite.js";
import type { LLMSessionMigrationReport } from "../../scripts/migrate-llm-sessions-sqlite.js";
import { createLLMSessionStore } from "../../src/contexts/llm-session/src/adapters/sqlite-llm-session-store.js";
import { fs, path, makeTempDir } from "../contexts/llm-gateway/llm-and-storage-helpers.js";

const Database = BetterSqlite3 as any;

function openDb(dbPath: string) {
  const db = new Database(dbPath);
  return {
    db,
    query(sql: string, ...params: unknown[]) {
      return db.prepare(sql).all(...params) as any[];
    },
    get(sql: string, ...params: unknown[]) {
      return db.prepare(sql).get(...params) as any;
    },
    close() {
      db.close();
    }
  };
}

function sessionFilePath(memoryRoot: string, agentType: string, date: string, clock: string, subAgentType?: string): string {
  return path.join(memoryRoot, "llm-sessions", agentType, ...(subAgentType ? [subAgentType] : []), date, `${clock}.jsonl`);
}

function writeJsonl(filePath: string, meta: Record<string, unknown>, messages: unknown[]): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = [JSON.stringify(meta), ...messages.map((message) => JSON.stringify(message))].join("\n") + "\n";
  fs.writeFileSync(filePath, text);
  return text;
}

function mainMeta(sessionId: string | number, agentType: string, extra: Record<string, unknown> = {}) {
  return {
    type: "llm_session",
    schemaVersion: 1,
    agent: agentType,
    sessionId,
    startedAt: "2026-06-14T01:00:00.000",
    startedAtUtc: "2026-06-14T01:00:00.000Z",
    messageCount: 1,
    ...extra
  };
}

function subagentMeta(agentType: string, extra: Record<string, unknown> = {}) {
  return {
    type: "llm_subagent_session",
    schemaVersion: 1,
    agent: agentType,
    startedAt: "2026-06-14T02:00:00.000",
    startedAtUtc: "2026-06-14T02:00:00.000Z",
    ...extra
  };
}

function legacyPointer(memoryRoot: string, pathInRoot: string, sessionId: number | string) {
  fs.mkdirSync(path.join(memoryRoot, "llm-sessions"), { recursive: true });
  fs.writeFileSync(path.join(memoryRoot, "llm-sessions", "current.json"), JSON.stringify({ path: pathInRoot, sessionId }));
}

async function migrate(memoryRoot: string): Promise<{ main: LLMSessionMigrationReport; subagent: LLMSessionMigrationReport }> {
  return await migrateLLMSessionsToSQLite({ memoryRoot });
}

function legacyDir(memoryRoot: string): string {
  const names = fs.readdirSync(memoryRoot).filter((name) => name.startsWith("llm-sessions-jsonl-legacy-"));
  assert.equal(names.length, 1, `expected exactly one legacy directory, got: ${names.join(", ")}`);
  return path.join(memoryRoot, names[0]);
}

test("migrates one raw metadata row per valid jsonl", async () => {
  const root = makeTempDir("migrate-meta-rows");
  writeJsonl(sessionFilePath(root, "chat", "2026-06-14", "01-00-00-000"), mainMeta(1, "chat"), [{ role: "user", content: "a" }]);
  writeJsonl(sessionFilePath(root, "chat", "2026-06-14", "02-00-00-000"), mainMeta(2, "chat"), []);
  writeJsonl(sessionFilePath(root, "talk", "2026-06-13", "03-00-00-000"), mainMeta(3, "talk"), [{ role: "user", content: "b" }]);
  writeJsonl(sessionFilePath(root, "memorize", "2026-06-12", "04-00-00-000"), mainMeta(4, "memorize"), []);
  const report = await migrate(root);
  assert.equal(report.main.discoveredSessions, 4);
  assert.equal(report.main.importedSessions, 4);
  assert.equal(report.main.skippedSessions, 0);
  assert.equal(report.main.discoveredSessions, report.main.importedSessions + report.main.skippedSessions);
  const main = openDb(path.join(root, "llm-sessions.sqlite"));
  const rows = main.query("SELECT session_id, agent_type FROM llm_session_meta ORDER BY session_id");
  assert.deepEqual(rows.map((row: any) => row.session_id), ["1", "2", "3", "4"]);
  assert.deepEqual(rows.map((row: any) => row.agent_type), ["chat", "chat", "talk", "memorize"]);
  main.close();
});

test("migrates one raw message row per non-empty line", async () => {
  const root = makeTempDir("migrate-message-rows");
  const filePath = sessionFilePath(root, "chat", "2026-06-14", "01-00-00-000");
  const meta = mainMeta(11, "chat");
  const m1 = JSON.stringify({ role: "user", content: "a" });
  const m2 = JSON.stringify({ role: "assistant", content: "b" });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(meta)}\n\n${m1}\n\n${m2}\n\n`); // blank lines are ignored
  const report = await migrate(root);
  assert.equal(report.main.importedMessages, 2);
  const main = openDb(path.join(root, "llm-sessions.sqlite"));
  const rows = main.query("SELECT ordinal, message_json FROM llm_messages_chat WHERE session_id = ? ORDER BY ordinal", "11");
  assert.deepEqual(rows.map((row: any) => row.ordinal), [0, 1]);
  assert.deepEqual(rows.map((row: any) => row.message_json), [m1, m2]);
  const metaRow = main.get("SELECT message_count FROM llm_session_meta WHERE session_id = ?", "11");
  assert.equal(metaRow.message_count, 2);
  main.close();
});

test("preserves metadata and message json text", async () => {
  const root = makeTempDir("migrate-raw-text");
  const filePath = sessionFilePath(root, "chat", "2026-06-14", "01-00-00-000");
  const meta = mainMeta(21, "chat", { someUnknown: { nested: [1] } });
  const messages = [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }];
  const metaText = JSON.stringify(meta);
  const messageTexts = messages.map((message) => JSON.stringify(message));
  writeJsonl(filePath, meta, messages);
  const report = await migrate(root);
  assert.equal(report.main.importedMessages, 2);
  const main = openDb(path.join(root, "llm-sessions.sqlite"));
  const metaRow = main.get("SELECT meta_json FROM llm_session_meta WHERE session_id = ?", "21");
  assert.equal(metaRow.meta_json, metaText, "meta_json must be the raw first line text");
  const rows = main.query("SELECT message_json FROM llm_messages_chat WHERE session_id = ? ORDER BY ordinal", "21");
  assert.deepEqual(rows.map((row: any) => row.message_json), messageTexts);
  // parsed round trip stays deep-equal
  const store = createLLMSessionStore(path.join(root, "llm-sessions.sqlite"));
  const loaded = store.read("21");
  assert.deepEqual(loaded?.meta, meta);
  assert.deepEqual(loaded?.messages, messages as any);
  store.close();
  main.close();
});

test("uses sessionId as the only persistent session identity", async () => {
  const root = makeTempDir("migrate-identity");
  writeJsonl(sessionFilePath(root, "chat", "2026-06-14", "01-00-00-000"), mainMeta(123, "chat"), []);
  writeJsonl(sessionFilePath(root, "talk", "2026-06-13", "02-00-00-000"), mainMeta("abc-456", "talk"), []);
  await migrate(root);
  const main = openDb(path.join(root, "llm-sessions.sqlite"));
  const metaColumns = main.query("PRAGMA table_info(llm_session_meta)").map((row: any) => row.name);
  assert.deepEqual(metaColumns, ["session_id", "agent_type", "started_at", "started_at_utc", "message_count", "meta_json"]);
  assert.ok(!metaColumns.includes("runtime_session_id"));
  assert.ok(!metaColumns.includes("record_type"));
  assert.ok(!metaColumns.includes("revision"));
  const chatRow = main.get("SELECT session_id FROM llm_session_meta WHERE agent_type = 'chat'");
  assert.equal(chatRow.session_id, "123");
  const talkRow = main.get("SELECT session_id FROM llm_session_meta WHERE agent_type = 'talk'");
  assert.equal(talkRow.session_id, "abc-456");
  main.close();
});

test("rejects duplicate main session ids", async () => {
  const root = makeTempDir("migrate-duplicate");
  writeJsonl(sessionFilePath(root, "chat", "2026-06-14", "01-00-00-000"), mainMeta(31, "chat"), [{ role: "user", content: "first" }]);
  writeJsonl(sessionFilePath(root, "talk", "2026-06-14", "02-00-00-000"), mainMeta(31, "talk"), [{ role: "user", content: "second" }]);
  const report = await migrate(root);
  assert.equal(report.main.importedSessions, 1);
  assert.equal(report.main.skippedSessions, 1);
  assert.equal(report.main.discoveredSessions, 2);
  assert.ok(report.main.errors.some((error) => error.path.endsWith("02-00-00-000.jsonl")), "the conflict must be reported as an error");
  const main = openDb(path.join(root, "llm-sessions.sqlite"));
  const rows = main.query("SELECT session_id, agent_type FROM llm_session_meta");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, "31");
  assert.equal(rows[0].agent_type, "chat", "the first successfully imported session wins");
  main.close();
});

test("generates a unique subagent session id when legacy metadata has none", async () => {
  const root = makeTempDir("migrate-subagent-uuid");
  writeJsonl(sessionFilePath(root, "sub_agent", "asr", "2026-06-14", "01-00-00-000"), subagentMeta("asr"), [{ role: "user", content: "audio" }]);
  const report = await migrate(root);
  assert.equal(report.subagent.importedSessions, 1);
  const sub = openDb(path.join(root, "llm-subagent-sessions.sqlite"));
  const row = sub.get("SELECT session_id FROM llm_session_meta");
  assert.match(row.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "generated subagent session id must be a UUID");
  sub.close();
});

test("does not add the generated id to raw subagent metadata json", async () => {
  const root = makeTempDir("migrate-subagent-raw-meta");
  const meta = subagentMeta("asr");
  const metaText = JSON.stringify(meta);
  writeJsonl(sessionFilePath(root, "sub_agent", "asr", "2026-06-14", "01-00-00-000"), meta, [{ role: "user", content: "audio" }]);
  await migrate(root);
  const sub = openDb(path.join(root, "llm-subagent-sessions.sqlite"));
  const row = sub.get("SELECT meta_json FROM llm_session_meta");
  assert.equal(row.meta_json, metaText, "the generated session id must not be written back into raw metadata json");
  assert.equal(JSON.parse(row.meta_json).sessionId, undefined);
  sub.close();
});

test("rolls back the whole session when one message is malformed", async () => {
  const root = makeTempDir("migrate-malformed");
  writeJsonl(sessionFilePath(root, "chat", "2026-06-14", "01-00-00-000"), mainMeta(41, "chat"), [{ role: "user", content: "ok" }]);
  const badPath = sessionFilePath(root, "chat", "2026-06-14", "02-00-00-000");
  fs.mkdirSync(path.dirname(badPath), { recursive: true });
  fs.writeFileSync(badPath, `${JSON.stringify(mainMeta(42, "chat"))}\n{"role":"user","content":"fine"}\nthis is not json\n`);
  const report = await migrate(root);
  assert.equal(report.main.importedSessions, 1);
  assert.equal(report.main.skippedSessions, 1);
  assert.ok(report.main.errors.some((error) => error.path.endsWith("02-00-00-000.jsonl")), "malformed session must be reported as an error");
  const main = openDb(path.join(root, "llm-sessions.sqlite"));
  const badMeta = main.query("SELECT session_id FROM llm_session_meta WHERE session_id = ?", "42");
  assert.equal(badMeta.length, 0, "session with a malformed message must be rolled back entirely");
  const badMessages = main.query("SELECT message_json FROM llm_messages_chat WHERE session_id = ?", "42");
  assert.equal(badMessages.length, 0, "no partial message rows may remain");
  const goodRow = main.get("SELECT message_count FROM llm_session_meta WHERE session_id = ?", "41");
  assert.equal(goodRow.message_count, 1, "other sessions must still import");
  main.close();
});

test("reports stale metadata messageCount without rewriting metadata json", async () => {
  const root = makeTempDir("migrate-stale-count");
  const meta = mainMeta(51, "chat", { messageCount: 5 }); // stale: the file has only 2 messages
  const metaText = JSON.stringify(meta);
  writeJsonl(sessionFilePath(root, "chat", "2026-06-14", "01-00-00-000"), meta, [{ role: "user", content: "a" }, { role: "assistant", content: "b" }]);
  const report = await migrate(root);
  assert.equal(report.main.importedMessages, 2);
  assert.ok(report.main.warnings.some((warning) => warning.path.endsWith("01-00-00-000.jsonl")), "the stale count must be reported as a warning");
  const main = openDb(path.join(root, "llm-sessions.sqlite"));
  const row = main.get("SELECT message_count, meta_json FROM llm_session_meta WHERE session_id = ?", "51");
  assert.equal(row.message_count, 2, "message_count column must reflect the actual row count");
  assert.equal(row.meta_json, metaText, "raw metadata json must stay untouched");
  main.close();
});

test("main migration never descends into sub_agent", async () => {
  const root = makeTempDir("migrate-no-subagent-descent");
  writeJsonl(sessionFilePath(root, "chat", "2026-06-14", "01-00-00-000"), mainMeta(61, "chat"), []);
  writeJsonl(sessionFilePath(root, "sub_agent", "asr", "2026-06-14", "02-00-00-000"), subagentMeta("asr"), [{ role: "user", content: "audio" }]);
  const report = await migrate(root);
  assert.equal(report.main.discoveredSessions, 1, "main must not count sub_agent sessions");
  assert.equal(report.main.importedSessions, 1);
  assert.equal(report.subagent.importedSessions, 1);
  const main = openDb(path.join(root, "llm-sessions.sqlite"));
  const agents = main.query("SELECT DISTINCT agent_type FROM llm_session_meta");
  assert.deepEqual(agents.map((row: any) => row.agent_type), ["chat"]);
  main.close();
});

test("subagent migration failure does not invalidate the main database", async () => {
  const root = makeTempDir("migrate-subagent-failure");
  writeJsonl(sessionFilePath(root, "chat", "2026-06-14", "01-00-00-000"), mainMeta(71, "chat"), [{ role: "user", content: "main" }]);
  const badPath = sessionFilePath(root, "sub_agent", "asr", "2026-06-14", "02-00-00-000");
  fs.mkdirSync(path.dirname(badPath), { recursive: true });
  fs.writeFileSync(badPath, "{not valid json\n");
  const report = await migrate(root);
  assert.equal(report.main.importedSessions, 1);
  assert.ok(report.subagent.errors.length >= 1, "subagent failure must be visible in the subagent report");
  const main = openDb(path.join(root, "llm-sessions.sqlite"));
  const integrity = main.query("PRAGMA integrity_check");
  assert.equal(integrity[0].integrity_check, "ok");
  const store = createLLMSessionStore(path.join(root, "llm-sessions.sqlite"));
  const loaded = store.read("71");
  assert.deepEqual(loaded?.messages.map((message: any) => message.content), ["main"]);
  store.close();
  main.close();
});

test("subagent database hard failure still completes the main migration", async () => {
  const root = makeTempDir("migrate-subagent-hard-failure");
  writeJsonl(sessionFilePath(root, "chat", "2026-06-14", "01-00-00-000"), mainMeta(72, "chat"), [{ role: "user", content: "main" }]);
  // sub_agent 是一个普通文件: collectJsonlFiles 对其 readdir 会抛出 ENOTDIR,
  // 模拟 SubAgent 临时库构建阶段的硬失败, 主库迁移必须照常完成。
  fs.writeFileSync(path.join(root, "llm-sessions", "sub_agent"), "not a directory");
  const report = await migrate(root);
  assert.equal(report.main.importedSessions, 1, "main migration must complete despite subagent hard failure");
  assert.equal(report.main.integrityCheck, "ok");
  assert.equal(report.subagent.integrityCheck, "failed", "subagent hard failure must surface as a failed report");
  assert.ok(report.subagent.errors.some((error) => error.code === "SUBAGENT_DATABASE_FAILED"));
  assert.equal(fs.existsSync(path.join(root, "llm-subagent-sessions.sqlite")), false, "failed subagent database must not be promoted");
  const main = openDb(path.join(root, "llm-sessions.sqlite"));
  const store = createLLMSessionStore(path.join(root, "llm-sessions.sqlite"));
  const loaded = store.read("72");
  assert.deepEqual(loaded?.messages.map((message: any) => message.content), ["main"]);
  store.close();
  main.close();
});

test("migrates current pointer through an in-memory path mapping", async () => {
  const root = makeTempDir("migrate-pointer");
  const filePath = sessionFilePath(root, "talk", "2026-06-13", "05-10-00-000");
  writeJsonl(filePath, mainMeta(82, "talk"), [{ role: "user", content: "talk" }]);
  // legacy pointer references the old relative file path
  legacyPointer(root, "talk/2026-06-13/05-10-00-000.jsonl", 82);
  const report = await migrate(root);
  assert.equal(report.main.currentPointer, "migrated");
  const newPointer = JSON.parse(fs.readFileSync(path.join(root, "llm-sessions", "current.json"), "utf8"));
  assert.deepEqual(newPointer, { sessionId: 82, agentType: "talk" }, "the new pointer must contain only sessionId and agentType");
  // the new pointer resolves to the migrated session
  const store = createLLMSessionStore(path.join(root, "llm-sessions.sqlite"));
  const loaded = store.read(String(newPointer.sessionId));
  assert.deepEqual(loaded?.messages.map((message: any) => message.content), ["talk"]);
  store.close();
});

test("does not persist legacy source paths", async () => {
  const root = makeTempDir("migrate-no-legacy-paths");
  writeJsonl(sessionFilePath(root, "chat", "2026-06-14", "01-00-00-000"), mainMeta(91, "chat"), []);
  await migrate(root);
  const main = openDb(path.join(root, "llm-sessions.sqlite"));
  const schemaRows = main.query("SELECT name, sql FROM sqlite_master");
  for (const row of schemaRows) {
    assert.ok(!/legacy|jsonl|\.path/i.test(String(row.sql ?? row.name)), `legacy source path leaked into schema: ${row.sql}`);
  }
  main.close();
});

test("refuses to overwrite an existing database", async () => {
  const root = makeTempDir("migrate-refuse-overwrite");
  writeJsonl(sessionFilePath(root, "chat", "2026-06-14", "01-00-00-000"), mainMeta(101, "chat"), []);
  const mainStore = createLLMSessionStore(path.join(root, "llm-sessions.sqlite"));
  mainStore.close();
  await assert.rejects(async () => migrate(root), /overwrite|exist|already/i);
  // nothing was renamed or removed
  assert.ok(fs.existsSync(path.join(root, "llm-sessions", "chat", "2026-06-14", "01-00-00-000.jsonl")));
  assert.ok(fs.existsSync(path.join(root, "llm-sessions.sqlite")));
  // an existing subagent database is refused the same way
  const root2 = makeTempDir("migrate-refuse-subagent");
  writeJsonl(sessionFilePath(root2, "sub_agent", "asr", "2026-06-14", "01-00-00-000"), subagentMeta("asr"), []);
  const subStore = createLLMSessionStore(path.join(root2, "llm-subagent-sessions.sqlite"));
  subStore.close();
  await assert.rejects(async () => migrate(root2), /overwrite|exist|already/i);
});

test("keeps original files in the renamed legacy directory", async () => {
  const root = makeTempDir("migrate-legacy-dir");
  const originals: Array<{ relative: string; text: string }> = [];
  const write = (agentType: string, date: string, clock: string, meta: Record<string, unknown>, messages: unknown[], subAgentType?: string) => {
    const filePath = sessionFilePath(root, agentType, date, clock, subAgentType);
    const text = writeJsonl(filePath, meta, messages);
    originals.push({ relative: path.relative(path.join(root, "llm-sessions"), filePath), text });
  };
  write("chat", "2026-06-14", "01-00-00-000", mainMeta(111, "chat"), [{ role: "user", content: "a" }]);
  write("sub_agent", "2026-06-14", "02-00-00-000", subagentMeta("asr"), [{ role: "user", content: "b" }], "asr");
  write("memorize", "2026-06-12", "03-00-00-000", mainMeta(112, "memorize"), []);
  legacyPointer(root, "chat/2026-06-14/01-00-00-000.jsonl", 111);
  await migrate(root);
  const legacy = legacyDir(root);
  for (const original of originals) {
    const migratedPath = path.join(legacy, original.relative);
    assert.equal(fs.existsSync(migratedPath), true, `missing original file in legacy directory: ${original.relative}`);
    assert.equal(fs.readFileSync(migratedPath, "utf8"), original.text, "original file content must be preserved byte-for-byte");
  }
  // the llm-sessions directory is recreated and holds only the new pointer
  const newSessionRoot = path.join(root, "llm-sessions");
  assert.deepEqual(fs.readdirSync(newSessionRoot), ["current.json"]);
  const pointer = JSON.parse(fs.readFileSync(path.join(newSessionRoot, "current.json"), "utf8"));
  assert.deepEqual(pointer, { sessionId: 111, agentType: "chat" });
});
