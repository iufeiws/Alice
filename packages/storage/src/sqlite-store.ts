import { createCurrentTimeProvider, type CurrentTimeProvider } from "../../../core/time/src/index.js";

const sqlite = await import("node:sqlite");
const fs = await import("node:fs");
const path = await import("node:path");

type DatabaseSync = any;
const SCHEMA_VERSION = 6;

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
  externalEventId?: string;
  parentRawMessageId?: string;
  actorId?: string;
  status?: string;
  rawJson?: string;
  error?: string;
};

export type MessageStatus = "sending" | "sent" | "send_failed";

export type StoredConversationMessage = {
  id: number;
  plugin: string;
  externalMessageId?: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  senderId?: string;
  senderRole: "user" | "assistant" | "system";
  contentType: string;
  contentText: string;
  contentJson?: string;
  createdAt: string;
  status: MessageStatus;
  isRead: boolean;
  readAt?: string;
  isRecalled: boolean;
  recalledAt?: string;
  reactionsJson: string;
  lastEventAt: string;
  coreProcessedAt?: string;
  coreBatchId?: string;
  sendFailureReason?: string;
};

export type AliceStore = {
  insertMessageLog(input: Omit<StoredMessageLog, "id">): StoredMessageLog;
  listMessageLogs(limit: number): StoredMessageLog[];
  listMessageLogsForSession(sessionId: string, limit: number): StoredMessageLog[];
  listPendingInboundSessions(): Array<{ sessionId: string; latestMessageId: number; latestTime: string }>;
  listUnprocessedInboundForSession(sessionId: string, limit: number): StoredMessageLog[];
  markMessageLogsProcessed(ids: number[], processedAt: string, batchId: string): void;
  upsertInboundMessage(input: UpsertInboundMessageInput): StoredConversationMessage;
  insertOutboundMessage(input: InsertOutboundMessageInput): StoredConversationMessage;
  listMessages(limit: number): StoredConversationMessage[];
  listMessagesForConversation(conversationId: string, limit: number): StoredConversationMessage[];
  searchMessages(input: SearchMessagesInput): StoredConversationMessage[];
  listPendingCoreConversations(): Array<{ conversationId: string; latestMessageId: number; latestTime: string }>;
  listUnprocessedCoreMessagesForConversation(conversationId: string, limit: number): StoredConversationMessage[];
  markMessagesCoreProcessed(ids: number[], processedAt: string, batchId: string): void;
  markMessagesReadAndCoreProcessed(ids: number[], readAt: string, batchId: string): void;
  listPendingOutboundMessages(plugin: string, limit: number): StoredConversationMessage[];
  markOutboundMessageSent(id: number, externalMessageId: string | undefined, sentAt: string): void;
  markOutboundMessageFailed(id: number, failedAt: string, failureReason: string): void;
  markMessageRead(plugin: string, externalMessageId: string, readAt: string): boolean;
  markMessageRecalled(plugin: string, externalMessageId: string, recalledAt: string): boolean;
  updateMessageReaction(input: UpdateMessageReactionInput): boolean;
};

export type SearchMessagesInput = {
  plugin?: string;
  conversationId?: string;
  query: string;
  direction?: "forward" | "backward";
  limit: number;
};

export type UpsertInboundMessageInput = {
  plugin: string;
  externalMessageId: string;
  conversationId: string;
  senderId?: string;
  senderRole?: "user" | "assistant" | "system";
  contentType: string;
  contentText: string;
  contentJson?: string;
  createdAt: string;
  lastEventAt?: string;
  coreProcessedAt?: string;
};

export type InsertOutboundMessageInput = {
  plugin: string;
  conversationId: string;
  senderId?: string;
  senderRole?: "user" | "assistant" | "system";
  contentType: string;
  contentText: string;
  contentJson?: string;
  createdAt: string;
};

export type UpdateMessageReactionInput = {
  plugin: string;
  externalMessageId: string;
  emoji: string;
  actorId?: string;
  op: "add" | "remove";
  at: string;
};

export function createAliceStore(dbPath: string, options: { time?: CurrentTimeProvider; messageDbPath?: string; messageLogDbPath?: string } = {}): AliceStore {
  const time = options.time ?? createCurrentTimeProvider("UTC");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db: DatabaseSync = new sqlite.DatabaseSync(dbPath);
  const messageDbPath = options.messageDbPath ?? dbPath;
  const messageDb = path.resolve(messageDbPath) === path.resolve(dbPath)
    ? db
    : openDatabase(messageDbPath);
  const messageLogDbPath = options.messageLogDbPath ?? dbPath;
  const logDb = path.resolve(messageLogDbPath) === path.resolve(dbPath)
    ? db
    : openDatabase(messageLogDbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  if (messageDb !== db) {
    messageDb.exec("PRAGMA journal_mode = WAL");
    messageDb.exec("PRAGMA foreign_keys = ON");
  }
  if (logDb !== db && logDb !== messageDb) {
    logDb.exec("PRAGMA journal_mode = WAL");
    logDb.exec("PRAGMA foreign_keys = ON");
  }
  const currentVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  dropLegacyMainTables(db);
  initializeMessageLogDatabase(logDb);
  initializeMessageDatabase(messageDb);
  if (currentVersion < SCHEMA_VERSION) {
    db.exec("BEGIN");
    try {
      const columns = logDb.prepare("PRAGMA table_info(message_logs)").all().map((row: any) => row.name);
      addColumnIfMissing(logDb, columns, "session_id", "ALTER TABLE message_logs ADD COLUMN session_id TEXT");
      addColumnIfMissing(logDb, columns, "raw_message_id", "ALTER TABLE message_logs ADD COLUMN raw_message_id TEXT");
      addColumnIfMissing(logDb, columns, "processed_at", "ALTER TABLE message_logs ADD COLUMN processed_at TEXT");
      addColumnIfMissing(logDb, columns, "processed_batch_id", "ALTER TABLE message_logs ADD COLUMN processed_batch_id TEXT");
      addColumnIfMissing(logDb, columns, "external_event_id", "ALTER TABLE message_logs ADD COLUMN external_event_id TEXT");
      addColumnIfMissing(logDb, columns, "parent_raw_message_id", "ALTER TABLE message_logs ADD COLUMN parent_raw_message_id TEXT");
      addColumnIfMissing(logDb, columns, "actor_id", "ALTER TABLE message_logs ADD COLUMN actor_id TEXT");
      addColumnIfMissing(logDb, columns, "status", "ALTER TABLE message_logs ADD COLUMN status TEXT");
      addColumnIfMissing(logDb, columns, "raw_json", "ALTER TABLE message_logs ADD COLUMN raw_json TEXT");
      addColumnIfMissing(logDb, columns, "error", "ALTER TABLE message_logs ADD COLUMN error TEXT");
      if (currentVersion < 3) {
        logDb.exec("UPDATE message_logs SET processed_at = time, processed_batch_id = 'legacy' WHERE direction = 'inbound' AND processed_at IS NULL");
      }
      if (currentVersion < 5 && messageDb === db && logDb === db) {
        backfillMessagesFromEventLogs(db);
      }
      if (currentVersion < 6 && messageDb === db) {
        messageDb.prepare("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')").run();
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  logDb.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS message_logs_external_event_id_idx
      ON message_logs(plugin, external_event_id)
      WHERE external_event_id IS NOT NULL;
  `);
  messageDb.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS messages_external_message_id_idx
      ON messages(plugin, external_message_id)
      WHERE external_message_id IS NOT NULL;
  `);
  if (messageDb !== db) migrateLegacyMessagesToMessageDb(db, messageDb);
  if (logDb !== db) migrateLegacyMessageLogsToLogDb(db, logDb);
  return {
    insertMessageLog(input) {
      const result = logDb.prepare(`
        INSERT OR IGNORE INTO message_logs(
          time, direction, plugin, kind, target, session_id, raw_message_id,
          processed_at, processed_batch_id, summary, external_event_id,
          parent_raw_message_id, actor_id, status, raw_json, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          input.time,
          input.direction,
          input.plugin,
          input.kind,
          input.target ?? null,
          input.sessionId ?? null,
          input.rawMessageId ?? null,
          input.processedAt ?? null,
          input.processedBatchId ?? null,
          input.summary,
          input.externalEventId ?? null,
          input.parentRawMessageId ?? null,
          input.actorId ?? null,
          input.status ?? null,
          input.rawJson ?? null,
          input.error ?? null
        );
      if (Number(result.changes) === 0 && input.externalEventId) {
        const existing = logDb.prepare(messageLogSelect("WHERE plugin = ? AND external_event_id = ? LIMIT 1"))
          .get(input.plugin, input.externalEventId);
        if (existing) return existing;
      }
      return {
        id: Number(result.lastInsertRowid),
        ...input
      };
    },
    listMessageLogs(limit) {
      return logDb.prepare(messageLogSelect("ORDER BY id DESC LIMIT ?"))
        .all(limit)
        .reverse();
    },
    listMessageLogsForSession(sessionId, limit) {
      return logDb.prepare(messageLogSelect("WHERE session_id = ? ORDER BY id DESC LIMIT ?"))
        .all(sessionId, limit)
        .reverse();
    },
    listPendingInboundSessions() {
      return logDb.prepare(`
        SELECT session_id AS sessionId, MAX(id) AS latestMessageId, MAX(time) AS latestTime
        FROM message_logs
        WHERE direction = 'inbound' AND processed_at IS NULL AND session_id IS NOT NULL
        GROUP BY session_id
        ORDER BY latestMessageId ASC
      `).all();
    },
    listUnprocessedInboundForSession(sessionId, limit) {
      return logDb.prepare(messageLogSelect("WHERE session_id = ? AND direction = 'inbound' AND processed_at IS NULL ORDER BY id ASC LIMIT ?"))
        .all(sessionId, limit);
    },
    markMessageLogsProcessed(ids, processedAt, batchId) {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => "?").join(", ");
      logDb.prepare(`UPDATE message_logs SET processed_at = ?, processed_batch_id = ? WHERE id IN (${placeholders})`)
        .run(processedAt, batchId, ...ids);
    },
    upsertInboundMessage(input) {
      const existing = messageDb.prepare(conversationMessageSelect("WHERE plugin = ? AND external_message_id = ? LIMIT 1"))
        .get(input.plugin, input.externalMessageId);
      if (existing) {
        messageDb.prepare(`
          UPDATE messages
          SET conversation_id = ?, sender_id = ?, sender_role = ?, content_type = ?,
            content_text = ?, content_json = ?, created_at = ?, last_event_at = ?,
            core_processed_at = COALESCE(core_processed_at, ?)
          WHERE id = ?
        `).run(
          input.conversationId,
          input.senderId ?? null,
          input.senderRole ?? "user",
          input.contentType,
          input.contentText,
          input.contentJson ?? null,
          input.createdAt,
          input.lastEventAt ?? input.createdAt,
          input.coreProcessedAt ?? null,
          existing.id
        );
        return messageDb.prepare(conversationMessageSelect("WHERE id = ?")).get(existing.id);
      }

      const result = messageDb.prepare(`
        INSERT INTO messages(
          plugin, external_message_id, conversation_id, direction, sender_id,
          sender_role, content_type, content_text, content_json, created_at,
          status, is_read, is_recalled, reactions_json, last_event_at,
          core_processed_at
        ) VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, 'sent', 0, 0, '{}', ?, ?)
      `).run(
        input.plugin,
        input.externalMessageId,
        input.conversationId,
        input.senderId ?? null,
        input.senderRole ?? "user",
        input.contentType,
        input.contentText,
        input.contentJson ?? null,
        input.createdAt,
        input.lastEventAt ?? input.createdAt,
        input.coreProcessedAt ?? null
      );
      return messageDb.prepare(conversationMessageSelect("WHERE id = ?")).get(Number(result.lastInsertRowid));
    },
    insertOutboundMessage(input) {
      const result = messageDb.prepare(`
        INSERT INTO messages(
          plugin, conversation_id, direction, sender_id, sender_role,
          content_type, content_text, content_json, created_at, status,
          is_read, is_recalled, reactions_json, last_event_at
        ) VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, 'sending', 0, 0, '{}', ?)
      `).run(
        input.plugin,
        input.conversationId,
        input.senderId ?? null,
        input.senderRole ?? "assistant",
        input.contentType,
        input.contentText,
        input.contentJson ?? null,
        input.createdAt,
        input.createdAt
      );
      return messageDb.prepare(conversationMessageSelect("WHERE id = ?")).get(Number(result.lastInsertRowid));
    },
    listMessages(limit) {
      return messageDb.prepare(conversationMessageSelect("ORDER BY id DESC LIMIT ?"))
        .all(limit)
        .reverse();
    },
    listMessagesForConversation(conversationId, limit) {
      return messageDb.prepare(conversationMessageSelect("WHERE conversation_id = ? ORDER BY id DESC LIMIT ?"))
        .all(conversationId, limit)
        .reverse();
    },
    searchMessages(input) {
      const query = buildMessageFtsQuery(input.query);
      if (!query) return [];
      const clauses = ["messages_fts MATCH ?"];
      const values: unknown[] = [query];
      if (input.plugin) {
        clauses.push("m.plugin = ?");
        values.push(input.plugin);
      }
      if (input.conversationId) {
        clauses.push("m.conversation_id = ?");
        values.push(input.conversationId);
      }
      const direction = input.direction === "forward" ? "ASC" : "DESC";
      const fallbackLike = () => {
        const likeClauses = ["m.content_text LIKE ?"];
        const likeValues: unknown[] = [`%${input.query}%`];
        if (input.plugin) {
          likeClauses.push("m.plugin = ?");
          likeValues.push(input.plugin);
        }
        if (input.conversationId) {
          likeClauses.push("m.conversation_id = ?");
          likeValues.push(input.conversationId);
        }
        return messageDb.prepare(conversationMessageSelect(`WHERE ${likeClauses.join(" AND ")} ORDER BY id ${direction} LIMIT ?`))
          .all(...likeValues, input.limit);
      };
      try {
        const rows = db.prepare(`
          SELECT
            m.id,
            m.plugin,
            m.external_message_id AS externalMessageId,
            m.conversation_id AS conversationId,
            m.direction,
            m.sender_id AS senderId,
            m.sender_role AS senderRole,
            m.content_type AS contentType,
            m.content_text AS contentText,
            m.content_json AS contentJson,
            m.created_at AS createdAt,
            m.status,
            m.is_read AS isRead,
            m.read_at AS readAt,
            m.is_recalled AS isRecalled,
            m.recalled_at AS recalledAt,
            m.reactions_json AS reactionsJson,
            m.last_event_at AS lastEventAt,
            m.core_processed_at AS coreProcessedAt,
            m.core_batch_id AS coreBatchId,
            m.send_failure_reason AS sendFailureReason
          FROM messages_fts f
          JOIN messages m ON m.id = f.rowid
          WHERE ${clauses.join(" AND ")}
          ORDER BY m.id ${direction}
          LIMIT ?
        `).all(...values, input.limit);
        return rows.length > 0 ? rows : fallbackLike();
      } catch {
        return fallbackLike();
      }
    },
    listPendingCoreConversations() {
      return messageDb.prepare(`
        SELECT conversation_id AS conversationId, MAX(id) AS latestMessageId, MAX(created_at) AS latestTime
        FROM messages
        WHERE direction = 'inbound' AND core_processed_at IS NULL AND is_read = 0
        GROUP BY conversation_id
        ORDER BY latestMessageId ASC
      `).all();
    },
    listUnprocessedCoreMessagesForConversation(conversationId, limit) {
      return messageDb.prepare(conversationMessageSelect("WHERE conversation_id = ? AND direction = 'inbound' AND core_processed_at IS NULL AND is_read = 0 ORDER BY id ASC LIMIT ?"))
        .all(conversationId, limit);
    },
    markMessagesCoreProcessed(ids, processedAt, batchId) {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => "?").join(", ");
      messageDb.prepare(`UPDATE messages SET core_processed_at = ?, core_batch_id = ? WHERE id IN (${placeholders})`)
        .run(processedAt, batchId, ...ids);
    },
    markMessagesReadAndCoreProcessed(ids, readAt, batchId) {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => "?").join(", ");
      messageDb.prepare(`
        UPDATE messages
        SET is_read = 1,
          read_at = COALESCE(read_at, ?),
          last_event_at = CASE WHEN is_read = 0 THEN ? ELSE last_event_at END,
          core_processed_at = COALESCE(core_processed_at, ?),
          core_batch_id = COALESCE(core_batch_id, ?)
        WHERE id IN (${placeholders})
      `).run(readAt, readAt, readAt, batchId, ...ids);
    },
    listPendingOutboundMessages(plugin, limit) {
      return messageDb.prepare(conversationMessageSelect("WHERE plugin = ? AND direction = 'outbound' AND status = 'sending' ORDER BY id ASC LIMIT ?"))
        .all(plugin, limit);
    },
    markOutboundMessageSent(id, externalMessageId, sentAt) {
      messageDb.prepare("UPDATE messages SET external_message_id = COALESCE(?, external_message_id), status = 'sent', last_event_at = ?, send_failure_reason = NULL WHERE id = ?")
        .run(externalMessageId ?? null, sentAt, id);
    },
    markOutboundMessageFailed(id, failedAt, failureReason) {
      messageDb.prepare("UPDATE messages SET status = 'send_failed', last_event_at = ?, send_failure_reason = ? WHERE id = ?")
        .run(failedAt, failureReason, id);
    },
    markMessageRead(plugin, externalMessageId, readAt) {
      const result = messageDb.prepare("UPDATE messages SET is_read = 1, read_at = COALESCE(read_at, ?), last_event_at = ? WHERE plugin = ? AND external_message_id = ?")
        .run(readAt, readAt, plugin, externalMessageId);
      return Number(result.changes) > 0;
    },
    markMessageRecalled(plugin, externalMessageId, recalledAt) {
      const result = messageDb.prepare("UPDATE messages SET is_recalled = 1, recalled_at = COALESCE(recalled_at, ?), last_event_at = ? WHERE plugin = ? AND external_message_id = ?")
        .run(recalledAt, recalledAt, plugin, externalMessageId);
      return Number(result.changes) > 0;
    },
    updateMessageReaction(input) {
      const existing = messageDb.prepare(conversationMessageSelect("WHERE plugin = ? AND external_message_id = ? LIMIT 1"))
        .get(input.plugin, input.externalMessageId);
      if (!existing) return false;
      const reactions = updateReactionJson(existing.reactionsJson, input.emoji, input.actorId, input.op);
      messageDb.prepare("UPDATE messages SET reactions_json = ?, last_event_at = ? WHERE id = ?")
        .run(JSON.stringify(reactions), input.at, existing.id);
      return true;
    }
  };
}

function addColumnIfMissing(db: DatabaseSync, columns: string[], name: string, statement: string): void {
  if (!columns.includes(name)) {
    db.exec(statement);
    columns.push(name);
  }
}

function dropLegacyMainTables(db: DatabaseSync): void {
  db.exec(`
    DROP TRIGGER IF EXISTS memories_ai;
    DROP TRIGGER IF EXISTS memories_ad;
    DROP TRIGGER IF EXISTS memories_au;
    DROP TABLE IF EXISTS memories_fts;
    DROP TABLE IF EXISTS memories;
    DROP TABLE IF EXISTS tool_cursors;
  `);
}

function openDatabase(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return new sqlite.DatabaseSync(dbPath);
}

function initializeMessageLogDatabase(db: DatabaseSync): void {
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
      summary TEXT NOT NULL,
      external_event_id TEXT,
      parent_raw_message_id TEXT,
      actor_id TEXT,
      status TEXT,
      raw_json TEXT,
      error TEXT
    );
  `);
}

function initializeMessageDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin TEXT NOT NULL,
      external_message_id TEXT,
      conversation_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      sender_id TEXT,
      sender_role TEXT NOT NULL,
      content_type TEXT NOT NULL,
      content_text TEXT NOT NULL,
      content_json TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      read_at TEXT,
      is_recalled INTEGER NOT NULL DEFAULT 0,
      recalled_at TEXT,
      reactions_json TEXT NOT NULL DEFAULT '{}',
      last_event_at TEXT NOT NULL,
      core_processed_at TEXT,
      core_batch_id TEXT,
      send_failure_reason TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content_text,
      plugin UNINDEXED,
      conversation_id UNINDEXED,
      content='messages',
      content_rowid='id',
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content_text, plugin, conversation_id) VALUES (new.id, new.content_text, new.plugin, new.conversation_id);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text, plugin, conversation_id) VALUES('delete', old.id, old.content_text, old.plugin, old.conversation_id);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text, plugin, conversation_id) VALUES('delete', old.id, old.content_text, old.plugin, old.conversation_id);
      INSERT INTO messages_fts(rowid, content_text, plugin, conversation_id) VALUES (new.id, new.content_text, new.plugin, new.conversation_id);
    END;
  `);
}

function migrateLegacyMessagesToMessageDb(legacyDb: DatabaseSync, messageDb: DatabaseSync): void {
  if (!tableExists(legacyDb, "messages")) return;
  const rows = legacyDb.prepare(conversationMessageSelect("ORDER BY id ASC")).all();
  if (rows.length > 0) {
    const insert = messageDb.prepare(`
      INSERT OR IGNORE INTO messages(
        id, plugin, external_message_id, conversation_id, direction, sender_id,
        sender_role, content_type, content_text, content_json, created_at, status,
        is_read, read_at, is_recalled, recalled_at, reactions_json, last_event_at,
        core_processed_at, core_batch_id, send_failure_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    messageDb.exec("BEGIN");
    try {
      for (const row of rows) {
        insert.run(
          row.id,
          row.plugin,
          row.externalMessageId ?? null,
          row.conversationId,
          row.direction,
          row.senderId ?? null,
          row.senderRole,
          row.contentType,
          row.contentText,
          row.contentJson ?? null,
          row.createdAt,
          row.status,
          row.isRead ? 1 : 0,
          row.readAt ?? null,
          row.isRecalled ? 1 : 0,
          row.recalledAt ?? null,
          row.reactionsJson,
          row.lastEventAt,
          row.coreProcessedAt ?? null,
          row.coreBatchId ?? null,
          row.sendFailureReason ?? null
        );
      }
      messageDb.prepare("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')").run();
      messageDb.exec("COMMIT");
    } catch (error) {
      messageDb.exec("ROLLBACK");
      throw error;
    }
  }
  dropLegacyMessageTables(legacyDb);
}

function migrateLegacyMessageLogsToLogDb(legacyDb: DatabaseSync, logDb: DatabaseSync): void {
  if (!tableExists(legacyDb, "message_logs")) return;
  const rows = legacyDb.prepare(messageLogSelect("ORDER BY id ASC")).all();
  if (rows.length > 0) {
    const insert = logDb.prepare(`
      INSERT OR IGNORE INTO message_logs(
        id, time, direction, plugin, kind, target, session_id, raw_message_id,
        processed_at, processed_batch_id, summary, external_event_id,
        parent_raw_message_id, actor_id, status, raw_json, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    logDb.exec("BEGIN");
    try {
      for (const row of rows) {
        insert.run(
          row.id,
          row.time,
          row.direction,
          row.plugin,
          row.kind,
          row.target ?? null,
          row.sessionId ?? null,
          row.rawMessageId ?? null,
          row.processedAt ?? null,
          row.processedBatchId ?? null,
          row.summary,
          row.externalEventId ?? null,
          row.parentRawMessageId ?? null,
          row.actorId ?? null,
          row.status ?? null,
          row.rawJson ?? null,
          row.error ?? null
        );
      }
      logDb.exec("COMMIT");
    } catch (error) {
      logDb.exec("ROLLBACK");
      throw error;
    }
  }
  dropLegacyMessageLogTables(legacyDb);
}

function dropLegacyMessageLogTables(db: DatabaseSync): void {
  db.exec(`
    DROP INDEX IF EXISTS message_logs_external_event_id_idx;
    DROP TABLE IF EXISTS message_logs;
  `);
}

function dropLegacyMessageTables(db: DatabaseSync): void {
  db.exec(`
    DROP INDEX IF EXISTS messages_external_message_id_idx;
    DROP TRIGGER IF EXISTS messages_ai;
    DROP TRIGGER IF EXISTS messages_ad;
    DROP TRIGGER IF EXISTS messages_au;
    DROP TABLE IF EXISTS messages_fts;
    DROP TABLE IF EXISTS messages;
  `);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1")
    .get(name);
  return Boolean(row?.ok);
}

function backfillMessagesFromEventLogs(db: DatabaseSync): void {
  db.prepare(`
    INSERT OR IGNORE INTO messages(
      plugin,
      external_message_id,
      conversation_id,
      direction,
      sender_id,
      sender_role,
      content_type,
      content_text,
      content_json,
      created_at,
      status,
      is_read,
      is_recalled,
      reactions_json,
      last_event_at,
      core_processed_at,
      core_batch_id,
      send_failure_reason
    )
    SELECT
      plugin,
      raw_message_id,
      COALESCE(session_id, target, raw_message_id, 'unknown'),
      direction,
      actor_id,
      CASE WHEN direction = 'outbound' THEN 'assistant' ELSE 'user' END,
      kind,
      summary,
      raw_json,
      time,
      CASE
        WHEN direction = 'outbound' AND status = 'send_failed' THEN 'send_failed'
        WHEN direction = 'outbound' AND status = 'sending' THEN 'sending'
        ELSE 'sent'
      END,
      0,
      0,
      '{}',
      time,
      CASE WHEN direction = 'inbound' THEN processed_at ELSE NULL END,
      CASE WHEN direction = 'inbound' THEN processed_batch_id ELSE NULL END,
      error
    FROM message_logs
    WHERE kind NOT IN ('reaction.created', 'reaction.deleted', 'message.read', 'message.recalled')
      AND summary IS NOT NULL
      AND COALESCE(session_id, target, raw_message_id) IS NOT NULL
  `).run();

  db.prepare(`
    UPDATE messages
    SET is_read = 1,
      read_at = COALESCE(read_at, (
        SELECT MAX(message_logs.time)
        FROM message_logs
        WHERE message_logs.plugin = messages.plugin
          AND message_logs.kind = 'message.read'
          AND COALESCE(message_logs.parent_raw_message_id, message_logs.raw_message_id) = messages.external_message_id
      )),
      last_event_at = COALESCE((
        SELECT MAX(message_logs.time)
        FROM message_logs
        WHERE message_logs.plugin = messages.plugin
          AND message_logs.kind = 'message.read'
          AND COALESCE(message_logs.parent_raw_message_id, message_logs.raw_message_id) = messages.external_message_id
      ), last_event_at)
    WHERE EXISTS (
      SELECT 1
      FROM message_logs
      WHERE message_logs.plugin = messages.plugin
        AND message_logs.kind = 'message.read'
        AND COALESCE(message_logs.parent_raw_message_id, message_logs.raw_message_id) = messages.external_message_id
    )
  `).run();

  db.prepare(`
    UPDATE messages
    SET is_recalled = 1,
      recalled_at = COALESCE(recalled_at, (
        SELECT MAX(message_logs.time)
        FROM message_logs
        WHERE message_logs.plugin = messages.plugin
          AND message_logs.kind = 'message.recalled'
          AND COALESCE(message_logs.parent_raw_message_id, message_logs.raw_message_id) = messages.external_message_id
      )),
      last_event_at = COALESCE((
        SELECT MAX(message_logs.time)
        FROM message_logs
        WHERE message_logs.plugin = messages.plugin
          AND message_logs.kind = 'message.recalled'
          AND COALESCE(message_logs.parent_raw_message_id, message_logs.raw_message_id) = messages.external_message_id
      ), last_event_at)
    WHERE EXISTS (
      SELECT 1
      FROM message_logs
      WHERE message_logs.plugin = messages.plugin
        AND message_logs.kind = 'message.recalled'
        AND COALESCE(message_logs.parent_raw_message_id, message_logs.raw_message_id) = messages.external_message_id
    )
  `).run();

  const reactionLogs = db.prepare(`
    SELECT plugin, kind, raw_message_id AS rawMessageId, parent_raw_message_id AS parentRawMessageId,
      actor_id AS actorId, summary, raw_json AS rawJson, time
    FROM message_logs
    WHERE kind IN ('reaction.created', 'reaction.deleted')
  `).all();
  for (const log of reactionLogs) {
    const externalMessageId = log.parentRawMessageId ?? log.rawMessageId;
    const emoji = extractReactionEmoji(log.rawJson, log.summary);
    if (!externalMessageId || !emoji) continue;
    const existing = db.prepare(conversationMessageSelect("WHERE plugin = ? AND external_message_id = ? LIMIT 1"))
      .get(log.plugin, externalMessageId);
    if (!existing) continue;
    const reactions = updateReactionJson(
      existing.reactionsJson,
      emoji,
      log.actorId ?? undefined,
      log.kind === "reaction.created" ? "add" : "remove"
    );
    db.prepare("UPDATE messages SET reactions_json = ?, last_event_at = ? WHERE id = ?")
      .run(JSON.stringify(reactions), log.time, existing.id);
  }
}

function extractReactionEmoji(rawJson: string | undefined, summary: string | undefined): string | undefined {
  if (rawJson) {
    try {
      const raw = JSON.parse(rawJson) as any;
      const event = raw?.event ?? raw;
      const emoji = event?.reaction?.emoji_type ?? event?.reaction?.emoji ?? event?.reaction?.reaction_type ?? event?.emoji_type ?? event?.emoji;
      if (typeof emoji === "string" && emoji) return emoji;
    } catch {
      // Fall through to summary parsing.
    }
  }
  const match = summary?.match(/^reaction\.(?:created|deleted)\s+(\S+)/);
  return match?.[1] === "on" ? undefined : match?.[1];
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
      summary,
      external_event_id AS externalEventId,
      parent_raw_message_id AS parentRawMessageId,
      actor_id AS actorId,
      status,
      raw_json AS rawJson,
      error
    FROM message_logs
    ${suffix}
  `;
}

function conversationMessageSelect(suffix: string): string {
  return `
    SELECT
      id,
      plugin,
      external_message_id AS externalMessageId,
      conversation_id AS conversationId,
      direction,
      sender_id AS senderId,
      sender_role AS senderRole,
      content_type AS contentType,
      content_text AS contentText,
      content_json AS contentJson,
      created_at AS createdAt,
      status,
      is_read AS isRead,
      read_at AS readAt,
      is_recalled AS isRecalled,
      recalled_at AS recalledAt,
      reactions_json AS reactionsJson,
      last_event_at AS lastEventAt,
      core_processed_at AS coreProcessedAt,
      core_batch_id AS coreBatchId,
      send_failure_reason AS sendFailureReason
    FROM messages
    ${suffix}
  `;
}

function updateReactionJson(raw: string, emoji: string, actorId: string | undefined, op: "add" | "remove"): Record<string, { count: number; users: string[] }> {
  const parsed = parseReactionJson(raw);
  const entry = parsed[emoji] ?? { count: 0, users: [] };
  if (op === "add") {
    if (actorId) {
      if (!entry.users.includes(actorId)) entry.users.push(actorId);
      entry.count = entry.users.length;
    } else {
      entry.count += 1;
    }
  } else if (actorId) {
    entry.users = entry.users.filter((user) => user !== actorId);
    entry.count = entry.users.length;
  } else {
    entry.count = Math.max(0, entry.count - 1);
  }

  if (entry.count <= 0) {
    delete parsed[emoji];
  } else {
    parsed[emoji] = entry;
  }
  return parsed;
}

function parseReactionJson(raw: string): Record<string, { count: number; users: string[] }> {
  try {
    const parsed = JSON.parse(raw) as Record<string, { count?: unknown; users?: unknown }>;
    const result: Record<string, { count: number; users: string[] }> = {};
    for (const [emoji, value] of Object.entries(parsed)) {
      const users = Array.isArray(value.users) ? value.users.filter((user): user is string => typeof user === "string") : [];
      const count = typeof value.count === "number" ? value.count : users.length;
      if (count > 0 || users.length > 0) {
        result[emoji] = { count: Math.max(count, users.length), users };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function buildMessageFtsQuery(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const normalized = trimmed.replace(/"/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return `"${normalized}"`;
}
