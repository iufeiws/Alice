import * as sqlite from "./sqlite-compat.js";

const fs = await import("node:fs");
const path = await import("node:path");

type DatabaseSync = any;

export type CalendarEntryKind = "holiday" | "birthday" | "reminder";
export type CalendarSystem = "gregorian" | "lunar";

export type CalendarEntry = {
  id: number;
  kind: CalendarEntryKind;
  title: string;
  note: string;
  source: string;
  calendarSystem: CalendarSystem;
  year?: number;
  month: number;
  day: number;
  isLeapMonth: boolean;
  time?: string;
  firedAt?: string;
  firedAtUtc?: string;
  createdAt: string;
  createdAtUtc?: string;
};

export type CalendarDueDate = {
  calendarSystem: CalendarSystem;
  year: number;
  month: number;
  day: number;
  isLeapMonth?: boolean;
  time: string;
};

export type CalendarStore = {
  addEntry(input: {
    kind: CalendarEntryKind;
    title: string;
    note?: string;
    source?: string;
    calendarSystem: CalendarSystem;
    year?: number;
    month: number;
    day: number;
    isLeapMonth?: boolean;
    time?: string;
    now: string;
    nowUtc?: string;
  }): CalendarEntry;
  removeEntry(id: number): CalendarEntry | undefined;
  replaceBirthday(input: {
    title: string;
    note?: string;
    calendarSystem: CalendarSystem;
    year?: number;
    month: number;
    day: number;
    isLeapMonth?: boolean;
    now: string;
    nowUtc?: string;
  }): CalendarEntry;
  latestBirthday(): CalendarEntry | undefined;
  listEntries(kind?: CalendarEntryKind): CalendarEntry[];
  consumeDueReminder(input: { dates: CalendarDueDate[]; firedAt: string; firedAtUtc?: string }): CalendarEntry | undefined;
};

export function createCalendarStore(dbPath: string): CalendarStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db: DatabaseSync = new sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  initialize(db);

  return {
    addEntry(input) {
      db.prepare(`
        INSERT INTO calendar_entries(kind, title, note, source, calendar_system, year, month, day, is_leap_month, time, created_at, created_at_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.kind,
        input.title,
        input.note ?? "",
        input.source ?? "",
        input.calendarSystem,
        input.year ?? null,
        input.month,
        input.day,
        input.calendarSystem === "lunar" && input.isLeapMonth ? 1 : 0,
        input.time ?? null,
        input.now,
        input.nowUtc ?? null
      );
      return normalizeCalendarEntry(db.prepare(`${selectCalendarEntrySql()} WHERE id = last_insert_rowid()`).get())!;
    },
    removeEntry(id) {
      const entry = normalizeCalendarEntry(db.prepare(`${selectCalendarEntrySql()} WHERE id = ?`).get(id));
      if (!entry) return undefined;
      db.prepare("DELETE FROM calendar_entries WHERE id = ?").run(id);
      return entry;
    },
    replaceBirthday(input) {
      db.prepare("DELETE FROM calendar_entries WHERE kind = 'birthday'").run();
      return this.addEntry({ ...input, kind: "birthday" });
    },
    latestBirthday() {
      return normalizeCalendarEntry(db.prepare(`
        ${selectCalendarEntrySql()}
        WHERE kind = 'birthday'
        ORDER BY id DESC
        LIMIT 1
      `).get());
    },
    listEntries(kind) {
      const where = kind ? "WHERE kind = ?" : "";
      const params = kind ? [kind] : [];
      return db.prepare(`
        ${selectCalendarEntrySql()}
        ${where}
        ORDER BY id ASC
      `).all(...params).map((row: unknown) => normalizeCalendarEntry(row)!).filter(Boolean);
    },
    consumeDueReminder(input) {
      if (input.dates.length === 0) return undefined;
      const clauses: string[] = [];
      const params: unknown[] = [input.firedAt, input.firedAtUtc ?? null];
      for (const date of input.dates) {
        clauses.push("(calendar_system = ? AND (year IS NULL OR year = ?) AND month = ? AND day = ? AND is_leap_month = ? AND time = ?)");
        params.push(date.calendarSystem, date.year, date.month, date.day, date.isLeapMonth ? 1 : 0, date.time);
      }
      return normalizeCalendarEntry(db.prepare(`
        UPDATE calendar_entries
        SET fired_at = ?, fired_at_utc = ?
        WHERE id = (
          SELECT id
          FROM calendar_entries
          WHERE kind = 'reminder'
            AND fired_at IS NULL
            AND (${clauses.join(" OR ")})
          ORDER BY id ASC
          LIMIT 1
        )
        RETURNING ${calendarEntryColumns()}
      `).get(...params));
    }
  };
}

function initialize(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('holiday', 'birthday', 'reminder')),
      title TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      calendar_system TEXT NOT NULL CHECK (calendar_system IN ('gregorian', 'lunar')),
      year INTEGER,
      month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
      day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
      is_leap_month INTEGER NOT NULL DEFAULT 0,
      time TEXT,
      fired_at TEXT,
      fired_at_utc TEXT,
      created_at TEXT NOT NULL,
      created_at_utc TEXT
    );
    CREATE INDEX IF NOT EXISTS calendar_entries_lookup_idx
      ON calendar_entries(kind, calendar_system, month, day, time);
  `);
  ensureColumn(db, "calendar_entries", "source", "TEXT NOT NULL DEFAULT ''");
}

function selectCalendarEntrySql(): string {
  return `SELECT ${calendarEntryColumns()} FROM calendar_entries`;
}

function calendarEntryColumns(): string {
  return [
    "id",
    "kind",
    "title",
    "note",
    "source",
    "calendar_system AS calendarSystem",
    "year",
    "month",
    "day",
    "is_leap_month AS isLeapMonth",
    "time",
    "fired_at AS firedAt",
    "fired_at_utc AS firedAtUtc",
    "created_at AS createdAt",
    "created_at_utc AS createdAtUtc"
  ].join(", ");
}

function normalizeCalendarEntry(row: unknown): CalendarEntry | undefined {
  if (!row || typeof row !== "object") return undefined;
  const value = row as CalendarEntry;
  return {
    id: Number(value.id),
    kind: value.kind,
    title: value.title,
    note: value.note,
    source: value.source,
    calendarSystem: value.calendarSystem,
    year: value.year === null || value.year === undefined ? undefined : Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
    isLeapMonth: Boolean(value.isLeapMonth),
    time: value.time || undefined,
    firedAt: value.firedAt || undefined,
    firedAtUtc: value.firedAtUtc || undefined,
    createdAt: value.createdAt,
    createdAtUtc: value.createdAtUtc || undefined
  };
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}
