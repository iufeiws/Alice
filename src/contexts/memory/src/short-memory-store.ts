import * as sqlite from "../../../platform/storage/src/sqlite-compat.js";
import {
  advanceAliceSchemaVersion,
  initializeShortMemorySchema
} from "../../../platform/storage/src/alice-database-schema.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type ShortMemoryEntry = {
  id: number;
  createdAt: string;
  createdAtUtc: string;
  content: string;
};

export type ShortMemoryTransaction = {
  insert(input: { createdAt: string; createdAtUtc: string; content: string }): ShortMemoryEntry;
  commit(): void;
  rollback(): void;
};

export type ShortMemoryStore = {
  beginWrite(): ShortMemoryTransaction;
  listLatest(limit: number): ShortMemoryEntry[];
  listByCreatedAtUtcRange(input: {
    startAtUtc: string;
    endAtUtc: string;
  }): ShortMemoryEntry[];
};

export function createShortMemoryStore(dbPath: string): ShortMemoryStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  migrateShortMemoryDatabase(db);
  const insertStatement = db.prepare(`
    INSERT INTO short_memory_entries(created_at, created_at_utc, content)
    VALUES (?, ?, ?)
  `);
  const latestStatement = db.prepare(`
    SELECT id, created_at AS createdAt, created_at_utc AS createdAtUtc, content
    FROM short_memory_entries
    ORDER BY created_at_utc DESC, id DESC
    LIMIT ?
  `);
  const rangeStatement = db.prepare(`
    SELECT id, created_at AS createdAt, created_at_utc AS createdAtUtc, content
    FROM short_memory_entries
    WHERE created_at_utc >= ? AND created_at_utc <= ?
    ORDER BY created_at_utc ASC, id ASC
  `);

  return {
    beginWrite() {
      db.exec("BEGIN IMMEDIATE");
      return createTransaction(db, insertStatement);
    },
    listLatest(limit) {
      assertPositiveIntegerLimit(limit);
      return (latestStatement.all(limit) as Array<Record<string, unknown>>).map(toEntry);
    },
    listByCreatedAtUtcRange(input) {
      return (rangeStatement.all(input.startAtUtc, input.endAtUtc) as Array<Record<string, unknown>>).map(toEntry);
    }
  };
}

/**
 * 幂等 additive 迁移：只创建新表/新索引，不删除或重写旧表数据。
 * 沿用现有 alice.sqlite 的 `PRAGMA user_version` 记录方式（见 sqlite-conversation-store / token-usage-store），
 * 仅在本模块版本低于目标时递增，重复打开不再次递增。
 */
function migrateShortMemoryDatabase(db: any): void {
  initializeShortMemorySchema(db);
  advanceAliceSchemaVersion(db);
}

function createTransaction(db: any, insertStatement: any): ShortMemoryTransaction {
  let settled = false;
  let inserted = false;
  return {
    insert(input) {
      if (settled) throw new Error("ShortMemoryTransaction 已终止，不能 insert");
      if (inserted) throw new Error("ShortMemoryTransaction 每个事务只能 insert 一次");
      inserted = true;
      const result = insertStatement.run(input.createdAt, input.createdAtUtc, input.content);
      return {
        id: Number(result.lastInsertRowid),
        createdAt: input.createdAt,
        createdAtUtc: input.createdAtUtc,
        content: input.content
      };
    },
    commit() {
      if (settled) throw new Error("ShortMemoryTransaction 已终止，commit 不能重复调用");
      db.exec("COMMIT");
      settled = true;
    },
    rollback() {
      if (settled) throw new Error("ShortMemoryTransaction 已终止，rollback 不能重复调用");
      db.exec("ROLLBACK");
      settled = true;
    }
  };
}

function toEntry(row: Record<string, unknown>): ShortMemoryEntry {
  return {
    id: Number(row.id),
    createdAt: String(row.createdAt),
    createdAtUtc: String(row.createdAtUtc),
    content: String(row.content)
  };
}

function assertPositiveIntegerLimit(limit: number): void {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    throw new Error(`listLatest limit 必须为正整数，收到: ${String(limit)}`);
  }
}
