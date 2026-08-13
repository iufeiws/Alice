import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as sqlite from "../../../src/platform/storage/src/sqlite-compat.js";
import { createMarkdownMemoryStore } from "../../../src/contexts/memory/src/memory.js";
import { createShortMemoryStore } from "../../../src/contexts/memory/src/short-memory-store.js";

const Database = sqlite.DatabaseSync;

function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dbPathFor(name: string): string {
  return path.join(makeTempDir(name), "alice.sqlite");
}

function userVersion(dbPath: string): number {
  const raw = new Database(dbPath);
  const row = raw.prepare("PRAGMA user_version").get() as { user_version: number };
  raw.close();
  return row.user_version;
}

// §12.1-1 新数据库建表和索引
test("shortMemoryStore creates the table and index on a new database", () => {
  const dbPath = dbPathFor("store-new");
  createShortMemoryStore(dbPath);
  const raw = new Database(dbPath);
  const table = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'short_memory_entries'")
    .get() as { sql: string } | undefined;
  assert.ok(table, "short_memory_entries 表必须存在");
  assert.match(table.sql, /AUTOINCREMENT/i);
  const columns = raw.prepare("PRAGMA table_info(short_memory_entries)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
  assert.deepEqual(columns.map((column) => column.name), ["id", "created_at", "created_at_utc", "content"]);
  assert.equal(columns[0].type, "INTEGER");
  assert.equal(columns[0].pk, 1);
  assert.equal(columns[1].type, "TEXT");
  assert.equal(columns[1].notnull, 1);
  assert.equal(columns[2].type, "TEXT");
  assert.equal(columns[2].notnull, 1);
  assert.equal(columns[3].type, "TEXT");
  assert.equal(columns[3].notnull, 1);
  const indexes = raw.prepare("PRAGMA index_list(short_memory_entries)").all() as Array<{ name: string; origin: string }>;
  assert.deepEqual(
    indexes.filter((index) => index.origin !== "pk").map((index) => index.name),
    ["short_memory_entries_created_at_utc_idx"]
  );
  const indexColumns = raw.prepare("PRAGMA index_info(short_memory_entries_created_at_utc_idx)").all()
    .map((row: any) => row.name);
  assert.deepEqual(indexColumns, ["created_at_utc", "id"]);
  raw.close();
});

// §12.1-2 已有 alice.sqlite 的幂等迁移（schema version 递增、旧数据保留）
test("shortMemoryStore migrates an existing alice.sqlite idempotently and keeps old data", () => {
  const root = makeTempDir("store-migrate");
  const legacy = createMarkdownMemoryStore(root);
  legacy.writeTarget("persistent", "旧记忆必须保留\n");
  legacy.writeTarget("userPreferences", "旧偏好保留\n");
  const dbPath = path.join(root, "alice.sqlite");
  const rawBefore = new Database(dbPath);
  rawBefore.exec("PRAGMA user_version = 9");
  rawBefore.close();
  const versionBefore = userVersion(dbPath);
  const store = createShortMemoryStore(dbPath);
  store.listLatest(10);
  const versionAfter = userVersion(dbPath);
  assert.ok(versionAfter > versionBefore, `schema version 必须递增（before=${versionBefore}, after=${versionAfter}）`);
  const raw = new Database(dbPath);
  assert.equal(
    raw.prepare("SELECT content FROM persistent_memory_entries ORDER BY id DESC LIMIT 1").get().content,
    "旧记忆必须保留\n",
    "旧表数据必须保留"
  );
  assert.equal(
    raw.prepare("SELECT content FROM user_preferences_entries ORDER BY id DESC LIMIT 1").get().content,
    "旧偏好保留\n",
    "旧表数据必须保留"
  );
  assert.ok(
    raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'short_memory_entries'").get(),
    "迁移后必须存在 short_memory_entries"
  );
  raw.close();
  // 幂等：同一库再次打开不报错、版本不再递增、旧数据仍在
  const reopened = createShortMemoryStore(dbPath);
  reopened.listLatest(10);
  assert.equal(userVersion(dbPath), versionAfter, "重复迁移不得再次递增版本");
  const raw2 = new Database(dbPath);
  assert.equal(
    raw2.prepare("SELECT content FROM persistent_memory_entries ORDER BY id DESC LIMIT 1").get().content,
    "旧记忆必须保留\n"
  );
  assert.ok(raw2.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'short_memory_entries'").get());
  raw2.close();
});

// §12.1-3 事务 insert/commit；insert 只在事务内，不得隐式提交
test("shortMemoryStore insert stays inside the transaction until commit", () => {
  const dbPath = dbPathFor("store-tx-invisible");
  const store = createShortMemoryStore(dbPath);
  const tx = store.beginWrite();
  const entry = tx.insert({
    createdAt: "2026-08-13T14:30:00.000",
    createdAtUtc: "2026-08-13T06:30:00.000Z",
    content: "first"
  });
  assert.equal(entry.id, 1);
  assert.equal(entry.content, "first");
  const raw = new Database(dbPath);
  assert.equal(
    raw.prepare("SELECT COUNT(*) AS count FROM short_memory_entries").get().count,
    0,
    "insert 不得隐式提交（另一连接在 commit 前看不到记录）"
  );
  tx.commit();
  assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM short_memory_entries").get().count, 1);
  raw.close();
  assert.deepEqual(store.listLatest(10).map((row) => row.content), ["first"]);
});

test("shortMemoryStore 每个事务只允许一次 insert", () => {
  const store = createShortMemoryStore(dbPathFor("store-single-insert"));
  const tx = store.beginWrite();
  tx.insert({
    createdAt: "2026-08-13T14:30:00.000",
    createdAtUtc: "2026-08-13T06:30:00.000Z",
    content: "first"
  });

  assert.throws(() => tx.insert({
    createdAt: "2026-08-13T14:31:00.000",
    createdAtUtc: "2026-08-13T06:31:00.000Z",
    content: "second"
  }), /只能 insert 一次/);
  tx.rollback();
});

// §12.1-4 rollback 后无新增记录
test("shortMemoryStore rollback leaves no rows", () => {
  const dbPath = dbPathFor("store-rollback");
  const store = createShortMemoryStore(dbPath);
  const tx = store.beginWrite();
  tx.insert({
    createdAt: "2026-08-13T14:30:00.000",
    createdAtUtc: "2026-08-13T06:30:00.000Z",
    content: "discarded"
  });
  tx.rollback();
  assert.deepEqual(store.listLatest(10), [], "rollback 后不得有任何记录");
  const tx2 = store.beginWrite();
  tx2.insert({
    createdAt: "2026-08-13T15:00:00.000",
    createdAtUtc: "2026-08-13T07:00:00.000Z",
    content: "kept"
  });
  tx2.commit();
  assert.deepEqual(store.listLatest(10).map((row) => row.content), ["kept"], "rollback 后必须能开启新事务");
});

// §4.2 commit/rollback 只能调用一次，重复调用抛错
test("shortMemoryStore commit and rollback are terminal and throw when repeated", () => {
  const dbPath = dbPathFor("store-terminal");
  const store = createShortMemoryStore(dbPath);
  const committed = store.beginWrite();
  committed.insert({ createdAt: "2026-08-13T14:30:00.000", createdAtUtc: "2026-08-13T06:30:00.000Z", content: "a" });
  committed.commit();
  assert.throws(() => committed.commit(), (error) => error instanceof Error, "commit 后再次 commit 必须抛错");
  assert.throws(() => committed.rollback(), (error) => error instanceof Error, "commit 后调用 rollback 必须抛错");
  const rolledBack = store.beginWrite();
  rolledBack.insert({ createdAt: "2026-08-13T14:30:00.000", createdAtUtc: "2026-08-13T06:30:00.000Z", content: "b" });
  rolledBack.rollback();
  assert.throws(() => rolledBack.rollback(), (error) => error instanceof Error, "rollback 后再次 rollback 必须抛错");
  assert.throws(() => rolledBack.commit(), (error) => error instanceof Error, "rollback 后调用 commit 必须抛错");
});

// §12.1-5 listLatest 的数量限制及倒序
test("shortMemoryStore listLatest caps at the limit and returns newest first", () => {
  const dbPath = dbPathFor("store-list-latest");
  const store = createShortMemoryStore(dbPath);
  for (let index = 0; index < 105; index += 1) {
    const utc = new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString();
    const tx = store.beginWrite();
    tx.insert({ createdAt: utc.replace(/Z$/, ""), createdAtUtc: utc, content: `row-${index}` });
    tx.commit();
  }
  const latest = store.listLatest(100);
  assert.equal(latest.length, 100, "listLatest(100) 最多返回 100 条");
  assert.deepEqual(latest.map((row) => row.content), Array.from({ length: 100 }, (_, offset) => `row-${104 - offset}`));
  const ids = latest.map((row) => row.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), "必须按 created_at_utc DESC, id DESC 倒序");
  assert.equal(store.listLatest(1000).length, 105, "记录数少于 limit 时返回全部");
});

// §12.1-6 时间相同记录使用 id 稳定排序
test("shortMemoryStore uses id as the stable tie-breaker for identical timestamps", () => {
  const dbPath = dbPathFor("store-tie");
  const store = createShortMemoryStore(dbPath);
  for (let index = 1; index <= 5; index += 1) {
    const tx = store.beginWrite();
    tx.insert({
      createdAt: "2026-08-01T00:00:00.000",
      createdAtUtc: "2026-08-01T00:00:00.000Z",
      content: `row-${index}`
    });
    tx.commit();
  }
  assert.deepEqual(
    store.listLatest(5).map((row) => row.id),
    [5, 4, 3, 2, 1],
    "相同时间 listLatest 必须按 id 倒序"
  );
  assert.deepEqual(
    store.listByCreatedAtUtcRange({ startAtUtc: "2026-08-01T00:00:00.000Z", endAtUtc: "2026-08-01T00:00:00.000Z" })
      .map((row) => row.id),
    [1, 2, 3, 4, 5],
    "相同时间范围查询必须按 id 正序"
  );
});

// §12.1-7 基于 created_at_utc 的闭区间时间范围查询
test("shortMemoryStore listByCreatedAtUtcRange is a closed interval in ascending order", () => {
  const dbPath = dbPathFor("store-range");
  const store = createShortMemoryStore(dbPath);
  const utcs = [
    "2026-08-01T00:00:00.000Z",
    "2026-08-02T00:00:00.000Z",
    "2026-08-03T00:00:00.000Z",
    "2026-08-04T00:00:00.000Z",
    "2026-08-05T00:00:00.000Z"
  ];
  utcs.forEach((utc, index) => {
    const tx = store.beginWrite();
    tx.insert({ createdAt: utc.replace(/Z$/, ""), createdAtUtc: utc, content: `day-${index + 1}` });
    tx.commit();
  });
  const middle = store.listByCreatedAtUtcRange({
    startAtUtc: "2026-08-02T00:00:00.000Z",
    endAtUtc: "2026-08-04T00:00:00.000Z"
  });
  assert.deepEqual(middle.map((row) => row.content), ["day-2", "day-3", "day-4"], "闭区间必须同时包含两端");
  const single = store.listByCreatedAtUtcRange({
    startAtUtc: "2026-08-03T00:00:00.000Z",
    endAtUtc: "2026-08-03T00:00:00.000Z"
  });
  assert.deepEqual(single.map((row) => row.content), ["day-3"]);
  const edge = store.listByCreatedAtUtcRange({
    startAtUtc: "2026-08-05T00:00:00.000Z",
    endAtUtc: "2026-08-05T00:00:00.000Z"
  });
  assert.deepEqual(edge.map((row) => row.content), ["day-5"]);
  const before = store.listByCreatedAtUtcRange({
    startAtUtc: "2026-07-31T00:00:00.000Z",
    endAtUtc: "2026-07-31T23:59:59.999Z"
  });
  assert.deepEqual(before, []);
});

// §12.1-8 非法 limit 抛错
test("shortMemoryStore listLatest rejects non-positive or non-integer limits", () => {
  const dbPath = dbPathFor("store-limit");
  const store = createShortMemoryStore(dbPath);
  const invalid = [
    0,
    -1,
    -100,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    undefined as unknown as number,
    "10" as unknown as number
  ];
  for (const limit of invalid) {
    assert.throws(
      () => store.listLatest(limit),
      (error: unknown) => {
        assert.ok(error instanceof Error, `limit ${String(limit)} 必须抛错`);
        return true;
      }
    );
  }
  assert.deepEqual(store.listLatest(1), [], "正整数 limit 可用");
});

// §12.1-9 created_at / created_at_utc 的写入与读取映射
test("shortMemoryStore round-trips createdAt and createdAtUtc exactly", () => {
  const dbPath = dbPathFor("store-dual-time");
  const store = createShortMemoryStore(dbPath);
  const first = store.beginWrite();
  first.insert({ createdAt: "2026-08-13T14:30:00.000", createdAtUtc: "2026-08-13T06:30:00.000Z", content: "alice" });
  first.commit();
  const second = store.beginWrite();
  second.insert({ createdAt: "2026-08-14T07:45:00.000", createdAtUtc: "2026-08-13T23:45:00.000Z", content: "bob" });
  second.commit();
  assert.deepEqual(store.listLatest(10), [
    { id: 2, createdAt: "2026-08-14T07:45:00.000", createdAtUtc: "2026-08-13T23:45:00.000Z", content: "bob" },
    { id: 1, createdAt: "2026-08-13T14:30:00.000", createdAtUtc: "2026-08-13T06:30:00.000Z", content: "alice" }
  ]);
  assert.deepEqual(
    store.listByCreatedAtUtcRange({
      startAtUtc: "2026-08-13T06:30:00.000Z",
      endAtUtc: "2026-08-13T23:45:00.000Z"
    }),
    [
      { id: 1, createdAt: "2026-08-13T14:30:00.000", createdAtUtc: "2026-08-13T06:30:00.000Z", content: "alice" },
      { id: 2, createdAt: "2026-08-14T07:45:00.000", createdAtUtc: "2026-08-13T23:45:00.000Z", content: "bob" }
    ]
  );
});
