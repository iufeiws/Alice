import { createCurrentTimeProvider, formatZonedIso, parseZonedIso } from "../../../../platform/time/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import * as sqlite from "../../../../platform/storage/src/sqlite-compat.js";
import {
  advanceAliceSchemaVersion,
  initializeShortMemorySchema
} from "../../../../platform/storage/src/alice-database-schema.js";

const fs = await import("node:fs");
const path = await import("node:path");

type DatabaseSync = any;

export type MessageDirection = "inbound" | "outbound" | "both";

export type StoredMessageLog = {
  id: number;
  time: string;
  timeUtc?: string;
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
  direction: MessageDirection;
  senderId?: string;
  senderRole: "user" | "assistant" | "system";
  senderName?: string;
  contentType: string;
  contentText: string;
  contentJson?: string;
  createdAt: string;
  createdAtUtc?: string;
  status: MessageStatus;
  isRead: boolean;
  readAt?: string;
  isRecalled: boolean;
  recalledAt?: string;
  reactionsJson: string;
  lastEventAt: string;
  lastEventAtUtc?: string;
  coreProcessedAt?: string;
  coreBatchId?: string;
  sendFailureReason?: string;
  piSessionId?: string;
  piInvocationId?: string;
};

export type AliceStore = {
  insertMessageLog(input: Omit<StoredMessageLog, "id">): StoredMessageLog;
  listMessageLogs(limit: number): StoredMessageLog[];
  listMessageLogsForSession(sessionId: string, limit: number): StoredMessageLog[];
  listPendingInboundSessions(): Array<{ sessionId: string; latestMessageId: number; latestTime: string }>;
  listUnprocessedInboundForSession(sessionId: string, limit: number): StoredMessageLog[];
  markMessageLogsProcessed(ids: number[], processedAt: string, batchId: string): void;
  upsertInboundMessage(input: UpsertInboundMessageInput): StoredConversationMessage;
  upsertBothMessage(input: UpsertBothMessageInput): StoredConversationMessage;
  insertOutboundMessage(input: InsertOutboundMessageInput): StoredConversationMessage;
  listMessages(limit: number): StoredConversationMessage[];
  listMessagesChronological(limit?: number): StoredConversationMessage[];
  listMessagesByCreatedAtRange(startAt: string | undefined, endAt: string, limit?: number): StoredConversationMessage[];
  listMessagesForConversation(conversationId: string, limit: number): StoredConversationMessage[];
  findLatestToolCardBoundaryMessageId(): number | null;
  searchMessages(input: SearchMessagesInput): StoredConversationMessage[];
  listPendingCoreConversations(): Array<{ conversationId: string; latestMessageId: number; latestTime: string }>;
  listUnprocessedCoreMessagesForConversation(conversationId: string, limit: number): StoredConversationMessage[];
  markMessagesCoreProcessed(ids: number[], processedAt: string, batchId: string): void;
  markMessagesReadAndCoreProcessed(ids: number[], readAt: string, batchId: string): void;
  listPendingOutboundMessages(plugin: string, limit: number): StoredConversationMessage[];
  markOutboundMessageSent(id: number, externalMessageId: string | undefined, sentAtUtc: string, createdAtUtc?: string): void;
  markOutboundMessageFailed(id: number, failedAt: string, failureReason: string, failedAtUtc?: string): void;
  markMessageRead(plugin: string, externalMessageId: string, readAt: string, readAtUtc?: string): boolean;
  markMessageRecalled(plugin: string, externalMessageId: string, recalledAt: string, recalledAtUtc?: string): boolean;
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
  senderName?: string;
  contentType: string;
  contentText: string;
  contentJson?: string;
  createdAt: string;
  createdAtUtc?: string;
  lastEventAt?: string;
  lastEventAtUtc?: string;
  coreProcessedAt?: string;
};

/**
 * One logical message that faces both Alice and the user: it enters the Alice
 * conversation context / Core pending queue as a user (Albert) message and is
 * also delivered to the user as a system notice. `piSessionId + piInvocationId`
 * deduplicates re-delivery after Worker/Alice reconnects.
 */
export type UpsertBothMessageInput = {
  plugin: string;
  conversationId: string;
  piSessionId: string;
  piInvocationId: string;
  senderId?: string;
  senderName?: string;
  contentType: string;
  contentText: string;
  contentJson?: string;
  createdAt: string;
  createdAtUtc?: string;
};

export type InsertOutboundMessageInput = {
  plugin: string;
  conversationId: string;
  senderId?: string;
  senderRole?: "user" | "assistant" | "system";
  senderName?: string;
  contentType: string;
  contentText: string;
  contentJson?: string;
  createdAt: string;
  createdAtUtc?: string;
};

export type UpdateMessageReactionInput = {
  plugin: string;
  externalMessageId: string;
  emoji: string;
  actorId?: string;
  op: "add" | "remove";
  at: string;
  atUtc?: string;
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
  initializeMessageLogDatabase(logDb);
  initializeMessageDatabase(messageDb);
  migrateMessageDatabase(messageDb);
  initializeShortMemorySchema(db);
  advanceAliceSchemaVersion(db);
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
  messageDb.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS messages_pi_invocation_idx
      ON messages(pi_session_id, pi_invocation_id)
      WHERE pi_session_id IS NOT NULL AND pi_invocation_id IS NOT NULL;
  `);
  return {
    insertMessageLog(input) {
      const timeUtc = input.timeUtc ?? toUtcIso(input.time, time.timeZone);
      const localTime = localIsoFromUtc(timeUtc, time.timeZone);
      const result = logDb.prepare(`
        INSERT OR IGNORE INTO message_logs(
          time, time_utc, direction, plugin, kind, target, session_id, raw_message_id,
          processed_at, processed_batch_id, summary, external_event_id,
          parent_raw_message_id, actor_id, status, raw_json, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          localTime,
          timeUtc,
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
        ...input,
        time: localTime,
        timeUtc
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
      const createdAtUtc = input.createdAtUtc ?? toUtcIso(input.createdAt, time.timeZone);
      const createdAt = localIsoFromUtc(createdAtUtc, time.timeZone);
      const lastEventAtUtc = input.lastEventAtUtc ?? (input.lastEventAt ? toUtcIso(input.lastEventAt, time.timeZone) : createdAtUtc);
      const lastEventAt = localIsoFromUtc(lastEventAtUtc, time.timeZone);
      const existing = messageDb.prepare(conversationMessageSelect("WHERE plugin = ? AND external_message_id = ? LIMIT 1"))
        .get(input.plugin, input.externalMessageId);
      if (existing) {
        messageDb.prepare(`
          UPDATE messages
          SET conversation_id = ?, sender_id = ?, sender_role = ?, sender_name = ?, content_type = ?,
            content_text = ?, content_json = ?, created_at = ?, created_at_utc = ?, last_event_at = ?, last_event_at_utc = ?,
            core_processed_at = COALESCE(core_processed_at, ?)
          WHERE id = ?
        `).run(
          input.conversationId,
          input.senderId ?? null,
          input.senderRole ?? "user",
          input.senderName ?? null,
          input.contentType,
          input.contentText,
          input.contentJson ?? null,
          createdAt,
          createdAtUtc,
          lastEventAt,
          lastEventAtUtc,
          input.coreProcessedAt ?? null,
          existing.id
        );
        return messageDb.prepare(conversationMessageSelect("WHERE id = ?")).get(existing.id);
      }

      const result = messageDb.prepare(`
        INSERT INTO messages(
          plugin, external_message_id, conversation_id, direction, sender_id,
          sender_role, sender_name, content_type, content_text, content_json, created_at, created_at_utc,
          status, is_read, is_recalled, reactions_json, last_event_at, last_event_at_utc,
          core_processed_at
        ) VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, 'sent', 0, 0, '{}', ?, ?, ?)
      `).run(
        input.plugin,
        input.externalMessageId,
        input.conversationId,
        input.senderId ?? null,
        input.senderRole ?? "user",
        input.senderName ?? null,
        input.contentType,
        input.contentText,
        input.contentJson ?? null,
        createdAt,
        createdAtUtc,
        lastEventAt,
        lastEventAtUtc,
        input.coreProcessedAt ?? null
      );
      return messageDb.prepare(conversationMessageSelect("WHERE id = ?")).get(Number(result.lastInsertRowid));
    },
    upsertBothMessage(input) {
      const createdAtUtc = input.createdAtUtc ?? toUtcIso(input.createdAt, time.timeZone);
      const createdAt = localIsoFromUtc(createdAtUtc, time.timeZone);
      const existing = messageDb.prepare(conversationMessageSelect("WHERE pi_session_id = ? AND pi_invocation_id = ? LIMIT 1"))
        .get(input.piSessionId, input.piInvocationId);
      if (existing) return existing;
      messageDb.prepare(`
        INSERT OR IGNORE INTO messages(
          plugin, conversation_id, direction, sender_id, sender_role, sender_name,
          content_type, content_text, content_json, created_at, created_at_utc, status,
          is_read, is_recalled, reactions_json, last_event_at, last_event_at_utc,
          pi_session_id, pi_invocation_id
        ) VALUES (?, ?, 'both', ?, 'user', ?, ?, ?, ?, ?, ?, 'sending', 0, 0, '{}', ?, ?, ?, ?)
      `).run(
        input.plugin,
        input.conversationId,
        input.senderId ?? null,
        input.senderName ?? null,
        input.contentType,
        input.contentText,
        input.contentJson ?? null,
        createdAt,
        createdAtUtc,
        createdAt,
        createdAtUtc,
        input.piSessionId,
        input.piInvocationId
      );
      return messageDb.prepare(conversationMessageSelect("WHERE pi_session_id = ? AND pi_invocation_id = ?"))
        .get(input.piSessionId, input.piInvocationId);
    },
    insertOutboundMessage(input) {
      const createdAtUtc = input.createdAtUtc ?? toUtcIso(input.createdAt, time.timeZone);
      const createdAt = localIsoFromUtc(createdAtUtc, time.timeZone);
      const result = messageDb.prepare(`
        INSERT INTO messages(
          plugin, conversation_id, direction, sender_id, sender_role, sender_name,
          content_type, content_text, content_json, created_at, created_at_utc, status,
          is_read, is_recalled, reactions_json, last_event_at, last_event_at_utc
        ) VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, 'sending', 0, 0, '{}', ?, ?)
      `).run(
        input.plugin,
        input.conversationId,
        input.senderId ?? null,
        input.senderRole ?? "assistant",
        input.senderName ?? null,
        input.contentType,
        input.contentText,
        input.contentJson ?? null,
        createdAt,
        createdAtUtc,
        createdAt,
        createdAtUtc,
      );
      return messageDb.prepare(conversationMessageSelect("WHERE id = ?")).get(Number(result.lastInsertRowid));
    },
    listMessages(limit) {
      return messageDb.prepare(conversationMessageSelect("ORDER BY id DESC LIMIT ?"))
        .all(limit)
        .reverse();
    },
    listMessagesChronological(limit = 10_000) {
      return messageDb.prepare(conversationMessageSelect("ORDER BY created_at ASC, id ASC LIMIT ?"))
        .all(limit);
    },
    listMessagesByCreatedAtRange(startAt, endAt, limit) {
      const normalizedStartAt = startAt ? normalizeQueryTimeUtc(startAt, time.timeZone) : undefined;
      const normalizedEndAt = normalizeQueryTimeUtc(endAt, time.timeZone);
      const hasLimit = typeof limit === "number" && Number.isFinite(limit);
      const suffix = hasLimit ? " LIMIT ?" : "";
      const where = startAt
        ? `WHERE COALESCE(created_at_utc, created_at) >= ? AND COALESCE(created_at_utc, created_at) < ? ORDER BY created_at ASC, id ASC${suffix}`
        : `WHERE COALESCE(created_at_utc, created_at) < ? ORDER BY created_at ASC, id ASC${suffix}`;
      return startAt
        ? hasLimit
          ? messageDb.prepare(conversationMessageSelect(where)).all(normalizedStartAt, normalizedEndAt, limit)
          : messageDb.prepare(conversationMessageSelect(where)).all(normalizedStartAt, normalizedEndAt)
        : hasLimit
          ? messageDb.prepare(conversationMessageSelect(where)).all(normalizedEndAt, limit)
          : messageDb.prepare(conversationMessageSelect(where)).all(normalizedEndAt);
    },
    listMessagesForConversation(conversationId, limit) {
      return messageDb.prepare(conversationMessageSelect("WHERE conversation_id = ? ORDER BY id DESC LIMIT ?"))
        .all(conversationId, limit)
        .reverse();
    },
    findLatestToolCardBoundaryMessageId() {
      const row = messageDb.prepare(`
        SELECT id
        FROM messages
        WHERE (direction = 'outbound' AND sender_role = 'assistant' AND status = 'sent')
          OR (direction IN ('inbound', 'both') AND sender_role = 'user' AND is_read = 1)
        ORDER BY id DESC
        LIMIT 1
      `).get() as { id: number } | undefined;
      return row ? Number(row.id) : null;
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
            m.created_at_utc AS createdAtUtc,
            m.status,
            m.is_read AS isRead,
            m.read_at AS readAt,
            m.is_recalled AS isRecalled,
            m.recalled_at AS recalledAt,
            m.reactions_json AS reactionsJson,
            m.last_event_at AS lastEventAt,
            m.last_event_at_utc AS lastEventAtUtc,
            m.core_processed_at AS coreProcessedAt,
            m.core_batch_id AS coreBatchId,
            m.send_failure_reason AS sendFailureReason,
            m.pi_session_id AS piSessionId,
            m.pi_invocation_id AS piInvocationId
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
        WHERE direction IN ('inbound', 'both') AND core_processed_at IS NULL AND is_read = 0
        GROUP BY conversation_id
        ORDER BY latestMessageId ASC
      `).all();
    },
    listUnprocessedCoreMessagesForConversation(conversationId, limit) {
      return messageDb.prepare(conversationMessageSelect("WHERE conversation_id = ? AND direction IN ('inbound', 'both') AND core_processed_at IS NULL AND is_read = 0 ORDER BY id ASC LIMIT ?"))
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
      const readAtUtc = toUtcIso(readAt, time.timeZone);
      messageDb.prepare(`
        UPDATE messages
        SET is_read = 1,
          read_at = COALESCE(read_at, ?),
          last_event_at = CASE WHEN is_read = 0 THEN ? ELSE last_event_at END,
          last_event_at_utc = CASE WHEN is_read = 0 THEN ? ELSE last_event_at_utc END,
          core_processed_at = CASE WHEN direction IN ('inbound', 'both') AND sender_role = 'user' THEN COALESCE(core_processed_at, ?) ELSE core_processed_at END,
          core_batch_id = CASE WHEN direction IN ('inbound', 'both') AND sender_role = 'user' THEN COALESCE(core_batch_id, ?) ELSE core_batch_id END
        WHERE id IN (${placeholders})
      `).run(readAt, readAt, readAtUtc, readAt, batchId, ...ids);
    },
    listPendingOutboundMessages(plugin, limit) {
      return messageDb.prepare(conversationMessageSelect("WHERE plugin = ? AND direction = 'outbound' AND status = 'sending' ORDER BY id ASC LIMIT ?"))
        .all(plugin, limit);
    },
    markOutboundMessageSent(id, externalMessageId, sentAtUtc, createdAtUtc) {
      const createdAt = createdAtUtc ? localIsoFromUtc(createdAtUtc, time.timeZone) : undefined;
      const sentAt = localIsoFromUtc(sentAtUtc, time.timeZone);
      messageDb.prepare("UPDATE messages SET external_message_id = COALESCE(?, external_message_id), status = 'sent', created_at = COALESCE(?, created_at), created_at_utc = COALESCE(?, created_at_utc), last_event_at = ?, last_event_at_utc = ?, send_failure_reason = NULL WHERE id = ?")
        .run(externalMessageId ?? null, createdAt ?? null, createdAtUtc ?? null, sentAt, sentAtUtc, id);
    },
    markOutboundMessageFailed(id, failedAt, failureReason, failedAtUtc) {
      const lastEventAtUtc = failedAtUtc ?? toUtcIso(failedAt, time.timeZone);
      const lastEventAt = localIsoFromUtc(lastEventAtUtc, time.timeZone);
      messageDb.prepare("UPDATE messages SET status = 'send_failed', last_event_at = ?, last_event_at_utc = ?, send_failure_reason = ? WHERE id = ?")
        .run(lastEventAt, lastEventAtUtc, failureReason, id);
    },
    markMessageRead(plugin, externalMessageId, readAt, readAtUtc) {
      const lastEventAtUtc = readAtUtc ?? toUtcIso(readAt, time.timeZone);
      const lastEventAt = localIsoFromUtc(lastEventAtUtc, time.timeZone);
      // External read receipts never mark direction='both' messages as read;
      // only Alice's own read flow can set isRead on those.
      const result = messageDb.prepare("UPDATE messages SET is_read = 1, read_at = COALESCE(read_at, ?), last_event_at = ?, last_event_at_utc = ? WHERE plugin = ? AND external_message_id = ? AND direction <> 'both'")
        .run(lastEventAt, lastEventAt, lastEventAtUtc, plugin, externalMessageId);
      return Number(result.changes) > 0;
    },
    markMessageRecalled(plugin, externalMessageId, recalledAt, recalledAtUtc) {
      const lastEventAtUtc = recalledAtUtc ?? toUtcIso(recalledAt, time.timeZone);
      const lastEventAt = localIsoFromUtc(lastEventAtUtc, time.timeZone);
      const result = messageDb.prepare("UPDATE messages SET is_recalled = 1, recalled_at = COALESCE(recalled_at, ?), last_event_at = ?, last_event_at_utc = ? WHERE plugin = ? AND external_message_id = ?")
        .run(lastEventAt, lastEventAt, lastEventAtUtc, plugin, externalMessageId);
      return Number(result.changes) > 0;
    },
    updateMessageReaction(input) {
      const existing = messageDb.prepare(conversationMessageSelect("WHERE plugin = ? AND external_message_id = ? LIMIT 1"))
        .get(input.plugin, input.externalMessageId);
      if (!existing) return false;
      const reactions = updateReactionJson(existing.reactionsJson, input.emoji, input.actorId, input.op);
      const lastEventAtUtc = input.atUtc ?? toUtcIso(input.at, time.timeZone);
      const lastEventAt = localIsoFromUtc(lastEventAtUtc, time.timeZone);
      messageDb.prepare("UPDATE messages SET reactions_json = ?, last_event_at = ?, last_event_at_utc = ? WHERE id = ?")
        .run(JSON.stringify(reactions), lastEventAt, lastEventAtUtc, existing.id);
      return true;
    }
  };
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
      time_utc TEXT,
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
      sender_name TEXT,
      content_type TEXT NOT NULL,
      content_text TEXT NOT NULL,
      content_json TEXT,
      created_at TEXT NOT NULL,
      created_at_utc TEXT,
      status TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      read_at TEXT,
      is_recalled INTEGER NOT NULL DEFAULT 0,
      recalled_at TEXT,
      reactions_json TEXT NOT NULL DEFAULT '{}',
      last_event_at TEXT NOT NULL,
      last_event_at_utc TEXT,
      core_processed_at TEXT,
      core_batch_id TEXT,
      send_failure_reason TEXT,
      pi_session_id TEXT,
      pi_invocation_id TEXT
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

/** Additive migration for existing message databases (schema version 9). */
function migrateMessageDatabase(db: DatabaseSync): void {
  const columns = new Set((db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((entry) => entry.name));
  if (!columns.has("pi_session_id")) db.exec("ALTER TABLE messages ADD COLUMN pi_session_id TEXT");
  if (!columns.has("pi_invocation_id")) db.exec("ALTER TABLE messages ADD COLUMN pi_invocation_id TEXT");
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
      sender_name AS senderName,
      content_type AS contentType,
      content_text AS contentText,
      content_json AS contentJson,
      created_at AS createdAt,
      created_at_utc AS createdAtUtc,
      status,
      is_read AS isRead,
      read_at AS readAt,
      is_recalled AS isRecalled,
      recalled_at AS recalledAt,
      reactions_json AS reactionsJson,
      last_event_at AS lastEventAt,
      last_event_at_utc AS lastEventAtUtc,
      core_processed_at AS coreProcessedAt,
      core_batch_id AS coreBatchId,
      send_failure_reason AS sendFailureReason,
      pi_session_id AS piSessionId,
      pi_invocation_id AS piInvocationId
    FROM messages
    ${suffix}
  `;
}

function toUtcIso(value: string, timeZone: string): string {
  return parseZonedIso(value, timeZone).toISOString();
}

function localIsoFromUtc(value: string, timeZone: string): string {
  return formatZonedIso(new Date(value), timeZone);
}

function normalizeQueryTimeUtc(value: string, timeZone: string): string {
  return parseZonedIso(value, timeZone).toISOString();
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
