import type { AgentEvent, AgentOutput } from "../../../packages/types/src/index.js";

const sqlite = await import("node:sqlite");
const fs = await import("node:fs");
const path = await import("node:path");

type DatabaseSync = any;
const SCHEMA_VERSION = 3;

export type StoredMessageLog = {
  id: number;
  time: string;
  direction: "inbound" | "outbound";
  plugin: string;
  kind: string;
  target?: string;
  sessionId?: string;
  rawMessageId?: string;
  processedAt?: string;
  processedBatchId?: string;
  summary: string;
};

export type StoredMemory = {
  id: number;
  createdAt: string;
  kind: "episodic" | "semantic";
  source: string;
  content: string;
  score: number;
};

export type AliceStore = {
  insertMessageLog(input: Omit<StoredMessageLog, "id">): StoredMessageLog;
  listMessageLogs(limit: number): StoredMessageLog[];
  listMessageLogsForSession(sessionId: string, limit: number): StoredMessageLog[];
  listPendingInboundSessions(): Array<{ sessionId: string; latestMessageId: number; latestTime: string }>;
  listUnprocessedInboundForSession(sessionId: string, limit: number): StoredMessageLog[];
  markMessageLogsProcessed(ids: number[], processedAt: string, batchId: string): void;
  captureTurn(event: AgentEvent, outputs: AgentOutput[]): void;
  recallForEvent(event: AgentEvent, limit: number): StoredMemory[];
  listMemories(limit: number): StoredMemory[];
};

export function createAliceStore(dbPath: string): AliceStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db: DatabaseSync = new sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const currentVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      direction TEXT NOT NULL,
      plugin TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT,
      session_id TEXT,
      raw_message_id TEXT,
      processed_at TEXT,
      processed_batch_id TEXT,
      summary TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 1
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, source, content='memories', content_rowid='id');

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, source) VALUES (new.id, new.content, new.source);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, source) VALUES('delete', old.id, old.content, old.source);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, source) VALUES('delete', old.id, old.content, old.source);
      INSERT INTO memories_fts(rowid, content, source) VALUES (new.id, new.content, new.source);
    END;
  `);
  if (currentVersion < SCHEMA_VERSION) {
    db.exec("BEGIN");
    try {
      const columns = db.prepare("PRAGMA table_info(message_logs)").all().map((row: any) => row.name);
      addColumnIfMissing(db, columns, "session_id", "ALTER TABLE message_logs ADD COLUMN session_id TEXT");
      addColumnIfMissing(db, columns, "raw_message_id", "ALTER TABLE message_logs ADD COLUMN raw_message_id TEXT");
      addColumnIfMissing(db, columns, "processed_at", "ALTER TABLE message_logs ADD COLUMN processed_at TEXT");
      addColumnIfMissing(db, columns, "processed_batch_id", "ALTER TABLE message_logs ADD COLUMN processed_batch_id TEXT");
      if (currentVersion < 3) {
        db.exec("UPDATE message_logs SET processed_at = time, processed_batch_id = 'legacy' WHERE direction = 'inbound' AND processed_at IS NULL");
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    insertMessageLog(input) {
      const result = db.prepare("INSERT INTO message_logs(time, direction, plugin, kind, target, session_id, raw_message_id, processed_at, processed_batch_id, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(input.time, input.direction, input.plugin, input.kind, input.target ?? null, input.sessionId ?? null, input.rawMessageId ?? null, input.processedAt ?? null, input.processedBatchId ?? null, input.summary);
      return {
        id: Number(result.lastInsertRowid),
        ...input
      };
    },
    listMessageLogs(limit) {
      return db.prepare(messageLogSelect("ORDER BY id DESC LIMIT ?"))
        .all(limit)
        .reverse();
    },
    listMessageLogsForSession(sessionId, limit) {
      return db.prepare(messageLogSelect("WHERE session_id = ? ORDER BY id DESC LIMIT ?"))
        .all(sessionId, limit)
        .reverse();
    },
    listPendingInboundSessions() {
      return db.prepare(`
        SELECT session_id AS sessionId, MAX(id) AS latestMessageId, MAX(time) AS latestTime
        FROM message_logs
        WHERE direction = 'inbound' AND processed_at IS NULL AND session_id IS NOT NULL
        GROUP BY session_id
        ORDER BY latestMessageId ASC
      `).all();
    },
    listUnprocessedInboundForSession(sessionId, limit) {
      return db.prepare(messageLogSelect("WHERE session_id = ? AND direction = 'inbound' AND processed_at IS NULL ORDER BY id ASC LIMIT ?"))
        .all(sessionId, limit);
    },
    markMessageLogsProcessed(ids, processedAt, batchId) {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => "?").join(", ");
      db.prepare(`UPDATE message_logs SET processed_at = ?, processed_batch_id = ? WHERE id IN (${placeholders})`)
        .run(processedAt, batchId, ...ids);
    },
    captureTurn(event, outputs) {
      const now = new Date().toISOString();
      if (event.payload.kind === "text" && shouldCapture(event.payload.text)) {
        insertMemory(db, {
          createdAt: now,
          kind: "episodic",
          source: `${event.source.plugin}:${event.session.sessionId}:user`,
          content: `User said: ${event.payload.text}`,
          score: 1
        });
      }

      for (const output of outputs) {
        if (output.content.kind === "text" && shouldCapture(output.content.text)) {
          insertMemory(db, {
            createdAt: now,
            kind: "episodic",
            source: `${output.target.plugin}:${output.target.sessionId}:assistant`,
            content: `Assistant replied: ${output.content.text}`,
            score: 0.8
          });
        }
      }
    },
    recallForEvent(event, limit) {
      if (event.payload.kind !== "text") return [];
      const query = buildFtsQuery(event.payload.text);
      if (!query) return [];

      try {
        return db.prepare(`
          SELECT m.id, m.created_at AS createdAt, m.kind, m.source, m.content, m.score
          FROM memories_fts f
          JOIN memories m ON m.id = f.rowid
          WHERE memories_fts MATCH ?
          ORDER BY bm25(memories_fts), m.id DESC
          LIMIT ?
        `).all(query, limit);
      } catch {
        return db.prepare(`
          SELECT id, created_at AS createdAt, kind, source, content, score
          FROM memories
          WHERE content LIKE ?
          ORDER BY id DESC
          LIMIT ?
        `).all(`%${event.payload.text.slice(0, 40)}%`, limit);
      }
    },
    listMemories(limit) {
      return db.prepare("SELECT id, created_at AS createdAt, kind, source, content, score FROM memories ORDER BY id DESC LIMIT ?")
        .all(limit)
        .reverse();
    }
  };
}

function addColumnIfMissing(db: DatabaseSync, columns: string[], name: string, statement: string): void {
  if (!columns.includes(name)) {
    db.exec(statement);
    columns.push(name);
  }
}

function messageLogSelect(suffix: string): string {
  return `
    SELECT
      id,
      time,
      direction,
      plugin,
      kind,
      target,
      session_id AS sessionId,
      raw_message_id AS rawMessageId,
      processed_at AS processedAt,
      processed_batch_id AS processedBatchId,
      summary
    FROM message_logs
    ${suffix}
  `;
}

function insertMemory(db: DatabaseSync, input: Omit<StoredMemory, "id">): void {
  db.prepare("INSERT INTO memories(created_at, kind, source, content, score) VALUES (?, ?, ?, ?, ?)")
    .run(input.createdAt, input.kind, input.source, input.content, input.score);
}

function shouldCapture(content: string): boolean {
  const text = content.trim();
  if (text.length < 8) return false;
  if (text.startsWith("/")) return false;
  return true;
}

function buildFtsQuery(text: string): string {
  const terms = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5\s]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 2)
    .slice(0, 8);

  return terms.map((term) => `"${term.replace(/"/g, "")}"`).join(" OR ");
}
