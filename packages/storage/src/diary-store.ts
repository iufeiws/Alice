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
  occurredAtUtc?: string;
  source: "sleep" | "inferred_gap" | "inferred_start";
  createdAt: string;
  createdAtUtc?: string;
};

export type SleepPreparationBoundary = {
  id: number;
  occurredAt: string;
  occurredAtUtc?: string;
  createdAt: string;
  createdAtUtc?: string;
};

export type WakeBoundary = {
  id: number;
  occurredAt: string;
  occurredAtUtc?: string;
  createdAt: string;
  createdAtUtc?: string;
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
  deleteLatestEntry(): DiaryEntry | undefined;
  recordSleepBoundary(input: { occurredAt: string; occurredAtUtc?: string; source: SleepBoundary["source"]; now: string; nowUtc?: string }): SleepBoundary;
  listSleepBoundaries(limit?: number): SleepBoundary[];
  recordSleepPreparationBoundary(input: { occurredAt: string; occurredAtUtc?: string; now: string; nowUtc?: string }): SleepPreparationBoundary;
  deleteLatestSleepPreparationBoundary(): SleepPreparationBoundary | undefined;
  latestSleepPreparationBoundary(): SleepPreparationBoundary | undefined;
  listSleepPreparationBoundaries(limit?: number): SleepPreparationBoundary[];
  recordWakeBoundary(input: { occurredAt: string; occurredAtUtc?: string; now: string; nowUtc?: string }): WakeBoundary;
  latestWakeBoundary(): WakeBoundary | undefined;
  listWakeBoundaries(limit?: number): WakeBoundary[];
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
    deleteLatestEntry() {
      const entry = this.latestEntry();
      if (!entry) return undefined;
      db.prepare("DELETE FROM diary_entries WHERE id = ?").run(entry.id);
      return entry;
    },
    recordSleepBoundary(input) {
      db.prepare(`
        INSERT OR IGNORE INTO sleep_boundaries(occurred_at, occurred_at_utc, source, created_at, created_at_utc)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.occurredAt, input.occurredAtUtc ?? null, input.source, input.now, input.nowUtc ?? null);
      return normalizeSleepBoundary(db.prepare(`
        SELECT id, occurred_at AS occurredAt, occurred_at_utc AS occurredAtUtc, source, created_at AS createdAt, created_at_utc AS createdAtUtc
        FROM sleep_boundaries
        WHERE occurred_at = ?
        LIMIT 1
      `).get(input.occurredAt))!;
    },
    listSleepBoundaries(limit = 10_000) {
      return db.prepare(`
        SELECT id, occurred_at AS occurredAt, occurred_at_utc AS occurredAtUtc, source, created_at AS createdAt, created_at_utc AS createdAtUtc
        FROM sleep_boundaries
        ORDER BY COALESCE(occurred_at_utc, occurred_at) ASC, id ASC
        LIMIT ?
      `).all(limit).map((row: unknown) => normalizeSleepBoundary(row)!).filter(Boolean);
    },
    recordSleepPreparationBoundary(input) {
      db.prepare(`
        INSERT INTO sleep_preparation_boundaries(occurred_at, occurred_at_utc, created_at, created_at_utc)
        VALUES (?, ?, ?, ?)
      `).run(input.occurredAt, input.occurredAtUtc ?? null, input.now, input.nowUtc ?? null);
      return normalizeSleepPreparationBoundary(db.prepare(`
        SELECT id, occurred_at AS occurredAt, occurred_at_utc AS occurredAtUtc, created_at AS createdAt, created_at_utc AS createdAtUtc
        FROM sleep_preparation_boundaries
        ORDER BY id DESC
        LIMIT 1
      `).get())!;
    },
    deleteLatestSleepPreparationBoundary() {
      const boundary = this.latestSleepPreparationBoundary();
      if (!boundary) return undefined;
      db.prepare("DELETE FROM sleep_preparation_boundaries WHERE id = ?").run(boundary.id);
      return boundary;
    },
    latestSleepPreparationBoundary() {
      return normalizeSleepPreparationBoundary(db.prepare(`
        SELECT id, occurred_at AS occurredAt, occurred_at_utc AS occurredAtUtc, created_at AS createdAt, created_at_utc AS createdAtUtc
        FROM sleep_preparation_boundaries
        ORDER BY id DESC
        LIMIT 1
      `).get());
    },
    listSleepPreparationBoundaries(limit = 10_000) {
      return db.prepare(`
        SELECT id, occurred_at AS occurredAt, occurred_at_utc AS occurredAtUtc, created_at AS createdAt, created_at_utc AS createdAtUtc
        FROM sleep_preparation_boundaries
        ORDER BY id ASC
        LIMIT ?
      `).all(limit).map((row: unknown) => normalizeSleepPreparationBoundary(row)!).filter(Boolean);
    },
    recordWakeBoundary(input) {
      db.prepare(`
        INSERT OR IGNORE INTO wake_boundaries(occurred_at, occurred_at_utc, created_at, created_at_utc)
        VALUES (?, ?, ?, ?)
      `).run(input.occurredAt, input.occurredAtUtc ?? null, input.now, input.nowUtc ?? null);
      return normalizeWakeBoundary(db.prepare(`
        SELECT id, occurred_at AS occurredAt, occurred_at_utc AS occurredAtUtc, created_at AS createdAt, created_at_utc AS createdAtUtc
        FROM wake_boundaries
        WHERE occurred_at = ?
        LIMIT 1
      `).get(input.occurredAt))!;
    },
    latestWakeBoundary() {
      return normalizeWakeBoundary(db.prepare(`
        SELECT id, occurred_at AS occurredAt, occurred_at_utc AS occurredAtUtc, created_at AS createdAt, created_at_utc AS createdAtUtc
        FROM wake_boundaries
        ORDER BY COALESCE(occurred_at_utc, occurred_at) DESC, id DESC
        LIMIT 1
      `).get());
    },
    listWakeBoundaries(limit = 10_000) {
      return db.prepare(`
        SELECT id, occurred_at AS occurredAt, occurred_at_utc AS occurredAtUtc, created_at AS createdAt, created_at_utc AS createdAtUtc
        FROM wake_boundaries
        ORDER BY COALESCE(occurred_at_utc, occurred_at) ASC, id ASC
        LIMIT ?
      `).all(limit).map((row: unknown) => normalizeWakeBoundary(row)!).filter(Boolean);
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
      occurred_at_utc TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_utc TEXT
    );
    CREATE INDEX IF NOT EXISTS sleep_boundaries_occurred_at_idx ON sleep_boundaries(occurred_at);
    CREATE TABLE IF NOT EXISTS sleep_preparation_boundaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      occurred_at_utc TEXT,
      created_at TEXT NOT NULL,
      created_at_utc TEXT
    );
    CREATE INDEX IF NOT EXISTS sleep_preparation_boundaries_occurred_at_idx ON sleep_preparation_boundaries(occurred_at);
    CREATE TABLE IF NOT EXISTS wake_boundaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL UNIQUE,
      occurred_at_utc TEXT,
      created_at TEXT NOT NULL,
      created_at_utc TEXT
    );
    CREATE INDEX IF NOT EXISTS wake_boundaries_occurred_at_idx ON wake_boundaries(occurred_at);
  `);
  const columns = db.prepare("PRAGMA table_info(sleep_boundaries)").all().map((row: any) => row.name);
  addColumnIfMissing(db, columns, "occurred_at_utc", "ALTER TABLE sleep_boundaries ADD COLUMN occurred_at_utc TEXT");
  addColumnIfMissing(db, columns, "created_at_utc", "ALTER TABLE sleep_boundaries ADD COLUMN created_at_utc TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS sleep_boundaries_occurred_at_utc_idx ON sleep_boundaries(occurred_at_utc)");
  const preparationColumns = db.prepare("PRAGMA table_info(sleep_preparation_boundaries)").all().map((row: any) => row.name);
  addColumnIfMissing(db, preparationColumns, "occurred_at_utc", "ALTER TABLE sleep_preparation_boundaries ADD COLUMN occurred_at_utc TEXT");
  addColumnIfMissing(db, preparationColumns, "created_at_utc", "ALTER TABLE sleep_preparation_boundaries ADD COLUMN created_at_utc TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS sleep_preparation_boundaries_occurred_at_utc_idx ON sleep_preparation_boundaries(occurred_at_utc)");
  const wakeColumns = db.prepare("PRAGMA table_info(wake_boundaries)").all().map((row: any) => row.name);
  addColumnIfMissing(db, wakeColumns, "occurred_at_utc", "ALTER TABLE wake_boundaries ADD COLUMN occurred_at_utc TEXT");
  addColumnIfMissing(db, wakeColumns, "created_at_utc", "ALTER TABLE wake_boundaries ADD COLUMN created_at_utc TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS wake_boundaries_occurred_at_utc_idx ON wake_boundaries(occurred_at_utc)");
}

function addColumnIfMissing(db: DatabaseSync, columns: string[], name: string, statement: string): void {
  if (!columns.includes(name)) db.exec(statement);
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
    occurredAtUtc: value.occurredAtUtc || undefined,
    source: value.source,
    createdAt: value.createdAt,
    createdAtUtc: value.createdAtUtc || undefined
  };
}

function normalizeSleepPreparationBoundary(row: unknown): SleepPreparationBoundary | undefined {
  if (!row || typeof row !== "object") return undefined;
  const value = row as SleepPreparationBoundary;
  return {
    id: Number(value.id),
    occurredAt: value.occurredAt,
    occurredAtUtc: value.occurredAtUtc || undefined,
    createdAt: value.createdAt,
    createdAtUtc: value.createdAtUtc || undefined
  };
}

function normalizeWakeBoundary(row: unknown): WakeBoundary | undefined {
  if (!row || typeof row !== "object") return undefined;
  const value = row as WakeBoundary;
  return {
    id: Number(value.id),
    occurredAt: value.occurredAt,
    occurredAtUtc: value.occurredAtUtc || undefined,
    createdAt: value.createdAt,
    createdAtUtc: value.createdAtUtc || undefined
  };
}
