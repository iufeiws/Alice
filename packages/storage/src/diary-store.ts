import * as sqlite from "./sqlite-compat.js";

const fs = await import("node:fs");
const path = await import("node:path");

type DatabaseSync = any;

export type DiaryEntry = {
  id: number;
  localDate: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  windowStartAt?: string;
  windowEndAt?: string;
};

export type SleepBoundary = {
  id: number;
  occurredAt: string;
  source: "sleep" | "inferred_gap" | "inferred_start";
  createdAt: string;
};

export type DiaryStore = {
  upsertEntry(input: {
    localDate: string;
    content: string;
    now: string;
    windowStartAt?: string;
    windowEndAt?: string;
  }): DiaryEntry;
  latestEntry(): DiaryEntry | undefined;
  getEntry(localDate: string): DiaryEntry | undefined;
  listEntries(limit: number): DiaryEntry[];
  recordSleepBoundary(input: { occurredAt: string; source: SleepBoundary["source"]; now: string }): SleepBoundary;
  listSleepBoundaries(limit?: number): SleepBoundary[];
};

export function createDiaryStore(dbPath: string): DiaryStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db: DatabaseSync = new sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  initialize(db);

  return {
    upsertEntry(input) {
      db.prepare(`
        INSERT INTO diary_entries(local_date, content, created_at, updated_at, window_start_at, window_end_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(local_date) DO UPDATE SET
          content = excluded.content,
          updated_at = excluded.updated_at,
          window_start_at = excluded.window_start_at,
          window_end_at = excluded.window_end_at
      `).run(
        input.localDate,
        input.content,
        input.now,
        input.now,
        input.windowStartAt ?? null,
        input.windowEndAt ?? null
      );
      return this.getEntry(input.localDate)!;
    },
    latestEntry() {
      return normalizeEntry(db.prepare(`
        SELECT id, local_date AS localDate, content, created_at AS createdAt, updated_at AS updatedAt,
               window_start_at AS windowStartAt, window_end_at AS windowEndAt
        FROM diary_entries
        ORDER BY local_date DESC, id DESC
        LIMIT 1
      `).get());
    },
    getEntry(localDate) {
      return normalizeEntry(db.prepare(`
        SELECT id, local_date AS localDate, content, created_at AS createdAt, updated_at AS updatedAt,
               window_start_at AS windowStartAt, window_end_at AS windowEndAt
        FROM diary_entries
        WHERE local_date = ?
        LIMIT 1
      `).get(localDate));
    },
    listEntries(limit) {
      return db.prepare(`
        SELECT id, local_date AS localDate, content, created_at AS createdAt, updated_at AS updatedAt,
               window_start_at AS windowStartAt, window_end_at AS windowEndAt
        FROM diary_entries
        ORDER BY local_date DESC, id DESC
        LIMIT ?
      `).all(limit).map((row: unknown) => normalizeEntry(row)!).filter(Boolean);
    },
    recordSleepBoundary(input) {
      db.prepare(`
        INSERT OR IGNORE INTO sleep_boundaries(occurred_at, source, created_at)
        VALUES (?, ?, ?)
      `).run(input.occurredAt, input.source, input.now);
      return normalizeSleepBoundary(db.prepare(`
        SELECT id, occurred_at AS occurredAt, source, created_at AS createdAt
        FROM sleep_boundaries
        WHERE occurred_at = ?
        LIMIT 1
      `).get(input.occurredAt))!;
    },
    listSleepBoundaries(limit = 10_000) {
      return db.prepare(`
        SELECT id, occurred_at AS occurredAt, source, created_at AS createdAt
        FROM sleep_boundaries
        ORDER BY occurred_at ASC, id ASC
        LIMIT ?
      `).all(limit).map((row: unknown) => normalizeSleepBoundary(row)!).filter(Boolean);
    }
  };
}

function initialize(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS diary_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_date TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      window_start_at TEXT,
      window_end_at TEXT
    );
    CREATE INDEX IF NOT EXISTS diary_entries_local_date_idx ON diary_entries(local_date);
    CREATE TABLE IF NOT EXISTS sleep_boundaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sleep_boundaries_occurred_at_idx ON sleep_boundaries(occurred_at);
  `);
}

function normalizeEntry(row: unknown): DiaryEntry | undefined {
  if (!row || typeof row !== "object") return undefined;
  const value = row as DiaryEntry;
  return {
    id: Number(value.id),
    localDate: value.localDate,
    content: value.content,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    windowStartAt: value.windowStartAt || undefined,
    windowEndAt: value.windowEndAt || undefined
  };
}

function normalizeSleepBoundary(row: unknown): SleepBoundary | undefined {
  if (!row || typeof row !== "object") return undefined;
  const value = row as SleepBoundary;
  return {
    id: Number(value.id),
    occurredAt: value.occurredAt,
    source: value.source,
    createdAt: value.createdAt
  };
}
