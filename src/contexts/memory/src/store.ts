import { createDiaryStore, type DiaryStore } from '../../../platform/storage/src/diary-store.js';
import * as sqlite from '../../../platform/storage/src/sqlite-compat.js';
import type { MemorySnapshot, MemoryStore, MemoryTarget, MemoryWriteOptions } from './model.js';
import { memoryFileLimits, targetDirectories, targetFiles } from './model.js';
import { enforceTargetLimit, utf8ByteLength } from './text-utils.js';

const fs = await import('node:fs');
const path = await import('node:path');
const childProcess = await import('node:child_process');

export function createMarkdownMemoryStore(root: string): MemoryStore {
  const longTermDbPath = memoryDatabasePath(root);
  let longTermDb: any | undefined;

  function db(): any {
    if (!longTermDb) {
      fs.mkdirSync(path.dirname(longTermDbPath), { recursive: true });
      longTermDb = new sqlite.DatabaseSync(longTermDbPath);
      longTermDb.exec("PRAGMA journal_mode = WAL");
      initializeLongTermMemoryDb(longTermDb);
    }
    return longTermDb;
  }

  function latestDiaryContent(): string {
    thisEnsure();
    const row = db().prepare(`
      SELECT content
      FROM diary_entries
      ORDER BY local_date DESC, id DESC
      LIMIT 1
    `).get() as { content?: string } | undefined;
    return row?.content ?? "";
  }

  function upsertDiaryContent(content: string, options?: MemoryWriteOptions): string {
    const limited = enforceTargetLimit("yesterdaySummary", content);
    const localDate = options?.localDate ?? options?.windowEndAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
    db().prepare(`
      INSERT INTO diary_entries(local_date, content, created_at, updated_at, window_start_at, window_end_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(local_date) DO UPDATE SET
        content = excluded.content,
        updated_at = excluded.updated_at,
        window_start_at = excluded.window_start_at,
        window_end_at = excluded.window_end_at
    `).run(
      localDate,
      limited,
      options?.now ?? new Date().toISOString(),
      options?.now ?? new Date().toISOString(),
      options?.windowStartAt ?? null,
      options?.windowEndAt ?? null
    );
    return limited;
  }

  function readLongTermTarget(target: "persistent" | "userPreferences"): string {
    thisEnsure();
    const tableName = longTermTableName(target);
    const row = db().prepare(`
      SELECT content
      FROM ${tableName}
      ORDER BY id DESC
      LIMIT 1
    `).get() as { content?: string } | undefined;
    return row?.content ?? "";
  }

  function appendLongTermTarget(target: "persistent" | "userPreferences", content: string, options?: MemoryWriteOptions & { runId?: string }): string {
    const limited = enforceTargetLimit(target, content);
    const tableName = longTermTableName(target);
    db().prepare(`
      INSERT INTO ${tableName}(content, created_at, window_start_at, window_end_at, run_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      limited,
      options?.now ?? new Date().toISOString(),
      options?.windowStartAt ?? null,
      options?.windowEndAt ?? null,
      options?.runId ?? null
    );
    return limited;
  }

  function thisEnsure(): void {
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(root, "long-term-memory"), { recursive: true });
    fs.mkdirSync(path.join(root, "diary"), { recursive: true });
    fs.mkdirSync(path.join(root, "diary", "tmp"), { recursive: true });
    db();
  }

  return {
    ensure() {
      thisEnsure();
    },
    read() {
      this.ensure();
      return {
        persistent: readLongTermTarget("persistent"),
        userPreferences: readLongTermTarget("userPreferences"),
        yesterdaySummary: latestDiaryContent()
      };
    },
    readTarget(target) {
      this.ensure();
      if (target === "yesterdaySummary") return "";
      return readLongTermTarget(target);
    },
    write(snapshot) {
      this.ensure();
      return {
        persistent: this.writeTarget("persistent", snapshot.persistent),
        userPreferences: this.writeTarget("userPreferences", snapshot.userPreferences),
        yesterdaySummary: this.writeTarget("yesterdaySummary", snapshot.yesterdaySummary)
      };
    },
    writeTarget(target, content, options) {
      this.ensure();
      const limited = enforceTargetLimit(target, content);
      if (target === "yesterdaySummary") {
        if (options?.diaryDraftPath) {
          writeAtomic(options.diaryDraftPath, limited);
          return limited;
        }
        return upsertDiaryContent(limited, options);
      }
      return appendLongTermTarget(target, limited, options);
    },
    deleteLatestEntry(target) {
      this.ensure();
      const database = db();
      const entry = target === "yesterdaySummary"
        ? database.prepare(`
          SELECT id, local_date AS localDate, content
          FROM diary_entries
          ORDER BY local_date DESC, id DESC
          LIMIT 1
        `).get() as { id: number; localDate?: string; content: string } | undefined
        : database.prepare(`
          SELECT id, content
          FROM ${longTermTableName(target)}
          ORDER BY id DESC
          LIMIT 1
        `).get() as { id: number; localDate?: string; content: string } | undefined;
      if (!entry) return undefined;
      const tableName = target === "yesterdaySummary" ? "diary_entries" : longTermTableName(target);
      database.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(entry.id);
      return { ...entry, target };
    },
    deleteLatestDiaryEntry() {
      const entry = this.deleteLatestEntry?.("yesterdaySummary");
      return entry ? { id: entry.id, localDate: entry.localDate ?? "", content: entry.content } : undefined;
    },
    createDiaryDraft() {
      this.ensure();
      const dir = path.join(root, "diary", "tmp");
      fs.mkdirSync(dir, { recursive: true });
      let draftPath = path.join(dir, `${Date.now()}-${process.pid}.md`);
      let suffix = 2;
      while (fs.existsSync(draftPath)) {
        draftPath = path.join(dir, `${Date.now()}-${process.pid}-${suffix}.md`);
        suffix += 1;
      }
      writeAtomic(draftPath, "");
      return draftPath;
    },
    commitDiaryDraft(draftPath, options) {
      this.ensure();
      const content = readFile(draftPath);
      const written = this.writeTarget("yesterdaySummary", content, options);
      try {
        fs.rmSync(draftPath);
      } catch {
        // Draft cleanup is best-effort after SQLite has the diary entry.
      }
      return written;
    },
    stats() {
      const snapshot = this.read();
      return (Object.keys(targetFiles) as MemoryTarget[]).map((target) => {
        const content = snapshot[target];
        return {
          target,
          fileName: path.join(targetDirectories[target], targetFiles[target]),
          tableName: target === "persistent"
            ? "persistent_memory_entries"
            : target === "userPreferences"
              ? "user_preferences_entries"
              : "diary_entries",
          content,
          lines: content.trim() ? content.trim().split(/\r?\n/).length : 0,
          bytes: utf8ByteLength(content),
          maxLines: memoryFileLimits[target].lines,
          maxBytes: memoryFileLimits[target].bytes
        };
      });
    }
  };
}

export function readFile(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function initializeLongTermMemoryDb(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS persistent_memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      window_start_at TEXT,
      window_end_at TEXT,
      run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS persistent_memory_entries_latest_idx
      ON persistent_memory_entries(id DESC);
    CREATE TABLE IF NOT EXISTS user_preferences_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      window_start_at TEXT,
      window_end_at TEXT,
      run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS user_preferences_entries_latest_idx
      ON user_preferences_entries(id DESC);
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
    CREATE INDEX IF NOT EXISTS sleep_boundaries_occurred_at_utc_idx ON sleep_boundaries(occurred_at_utc);
    CREATE TABLE IF NOT EXISTS sleep_preparation_boundaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      occurred_at_utc TEXT,
      created_at TEXT NOT NULL,
      created_at_utc TEXT
    );
    CREATE INDEX IF NOT EXISTS sleep_preparation_boundaries_occurred_at_idx ON sleep_preparation_boundaries(occurred_at);
    CREATE INDEX IF NOT EXISTS sleep_preparation_boundaries_occurred_at_utc_idx ON sleep_preparation_boundaries(occurred_at_utc);
    CREATE TABLE IF NOT EXISTS wake_boundaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL UNIQUE,
      occurred_at_utc TEXT,
      created_at TEXT NOT NULL,
      created_at_utc TEXT
    );
    CREATE INDEX IF NOT EXISTS wake_boundaries_occurred_at_idx ON wake_boundaries(occurred_at);
    CREATE INDEX IF NOT EXISTS wake_boundaries_occurred_at_utc_idx ON wake_boundaries(occurred_at_utc);
  `);
}

function longTermTableName(target: "persistent" | "userPreferences"): "persistent_memory_entries" | "user_preferences_entries" {
  return target === "persistent" ? "persistent_memory_entries" : "user_preferences_entries";
}

export function memoryDatabasePath(root: string): string {
  return path.join(root, "alice.sqlite");
}

export function createMemoryDiaryStore(root: string): DiaryStore {
  createMarkdownMemoryStore(root).ensure();
  return createDiaryStore(memoryDatabasePath(root));
}

function sanitizeRunId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120) || "run";
}

export function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

function createOptionalDiaryStore(root: string): DiaryStore {
  return createMemoryDiaryStore(root);
}

function ensureGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (!fs.existsSync(path.join(dir, ".git"))) {
      gitExecFileSync(["init"], { cwd: dir });
    }
    gitExecFileSync(["config", "user.name", "Alice Memorize"], { cwd: dir });
    gitExecFileSync(["config", "user.email", "alice-memorize@example.local"], { cwd: dir });
  } catch {
    // Git history is best-effort; the memory files still remain readable.
  }
}

function commitLongTermMemory(root: string, target: MemoryTarget, fileName: string): void {
  const dir = path.join(root, "long-term-memory");
  try {
    if (isLongTermMemoryGitOperationInProgress(dir)) return;
    gitExecFileSync(["add", fileName], { cwd: dir });
    const status = gitExecFileSync(["status", "--porcelain", "--", fileName], { cwd: dir, encoding: "utf8" });
    if (!status.trim()) return;
    gitExecFileSync(["commit", "-m", `memorize ${target}`], { cwd: dir });
  } catch {
    // Keep the write path non-fatal if git is unavailable or not configured.
  }
}

function commitLongTermMemoryBaseline(root: string): void {
  const dir = path.join(root, "long-term-memory");
  try {
    if (isLongTermMemoryGitOperationInProgress(dir)) return;
    gitExecFileSync(["add", targetFiles.persistent, targetFiles.userPreferences], { cwd: dir });
    const status = gitExecFileSync(["status", "--porcelain", "--", targetFiles.persistent, targetFiles.userPreferences], { cwd: dir, encoding: "utf8" });
    if (!status.trim()) return;
    gitExecFileSync(["commit", "-m", "memory baseline"], { cwd: dir });
  } catch {
    // Keep the write path non-fatal if git is unavailable or not configured.
  }
}

function isLongTermMemoryGitOperationInProgress(dir: string): boolean {
  const gitDir = path.join(dir, ".git");
  return [
    "MERGE_HEAD",
    "REVERT_HEAD",
    "CHERRY_PICK_HEAD",
    "REBASE_HEAD",
    "rebase-merge",
    "rebase-apply"
  ].some((name) => fs.existsSync(path.join(gitDir, name)));
}

function gitExecFileSync(args: string[], options: { cwd: string; encoding?: BufferEncoding }): string {
  const result = childProcess.spawnSync("git", args, {
    cwd: options.cwd,
    encoding: options.encoding ?? "utf8"
  });
  if (result.status !== 0) {
    const error = new Error(result.stderr?.toString() || result.error?.message || `git ${args.join(" ")} failed`);
    (error as Error & { status?: number }).status = result.status ?? undefined;
    throw error;
  }
  return result.stdout?.toString() ?? "";
}
