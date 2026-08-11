import type { LLMMessage } from "../../../llm-gateway/src/index.js";
import { DatabaseSync } from "../../../../platform/storage/src/sqlite-compat.js";

const fs = await import("node:fs");
const path = await import("node:path");

/**
 * LLM 会话 SQLite 主库存储。
 *
 * 总表 llm_session_meta 只有六列(session_id/agent_type/started_at/started_at_utc/
 * message_count/meta_json), 可变业务 meta 完整序列化进 meta_json, 不做字段展开。
 * 每个 agent_type 一张 messages 分表, 表名由 agent_type 可逆安全编码得到,
 * 原始 agent 名绝不直接拼入 SQL。
 *
 * 所有写操作都在 BEGIN IMMEDIATE 事务内执行, 失败整体回滚。
 */

export type StoredLLMSession = {
  sessionId: string;
  agentType: string;
  startedAt: string;
  startedAtUtc: string;
  meta: Record<string, unknown>;
  messages: LLMMessage[];
};

export type LLMSessionListItem = {
  sessionId: string;
  agentType: string;
  startedAt: string;
  startedAtUtc: string;
  messageCount: number;
};

export type LLMSessionStore = {
  create(session: StoredLLMSession): void;
  read(sessionId: string): StoredLLMSession | undefined;
  /** 只读总表 meta_json, 不访问 messages 分表; 供列表展示, 避免列表路径读取分表。 */
  readMeta(sessionId: string): Record<string, unknown> | undefined;
  /** 追加消息并同步 message_count 列; meta_json 由 updateMeta 单独维护。 */
  append(input: { sessionId: string; messages: LLMMessage[] }): void;
  updateMeta(input: { sessionId: string; meta: Record<string, unknown> }): void;
  replace(input: { sessionId: string; messages: LLMMessage[]; meta: Record<string, unknown>; reason: string }): void;
  list(input: { agentType: string; limit: number }): LLMSessionListItem[];
  close(): void;
};

/** 主库预建的三张分表对应的 agent 类型。 */
const PRE_CREATED_AGENT_TYPES = ["chat", "talk", "memorize"];

/** 表名固定前缀。 */
const TABLE_PREFIX = "llm_messages_";

/**
 * agent_type -> 分表名 的可逆安全编码:
 * 小写 ASCII 字母(a-z)与数字(0-9)原样保留, 其余 UTF-8 字节编码为 _xHH(两位小写十六进制)。
 * 示例: chat -> llm_messages_chat; Research_Agent -> llm_messages__x52esearch_x5f_x41gent。
 */
export function agentMessagesTableName(agentType: string): string {
  const bytes = Buffer.from(agentType, "utf8");
  let tableName = TABLE_PREFIX;
  for (const byte of bytes) {
    if ((byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)) {
      tableName += String.fromCharCode(byte);
    } else {
      tableName += `_x${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return tableName;
}

/**
 * agentMessagesTableName 的逆操作: 分表名 -> agent_type。
 * 非本编码产生的表名返回 undefined。
 */
export function decodeAgentMessagesTableName(tableName: string): string | undefined {
  if (!tableName.startsWith(TABLE_PREFIX)) return undefined;
  const encoded = tableName.slice(TABLE_PREFIX.length);
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length;) {
    if (encoded[index] === "_" && encoded[index + 1] === "x") {
      const hex = encoded.slice(index + 2, index + 4);
      if (!/^[0-9a-f]{2}$/.test(hex)) return undefined;
      bytes.push(parseInt(hex, 16));
      index += 4;
    } else {
      const code = encoded.charCodeAt(index);
      if (code < 0x61 || code > 0x7a) {
        if (code < 0x30 || code > 0x39) return undefined;
      }
      bytes.push(code);
      index += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export function createLLMSessionStore(dbPath: string): LLMSessionStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initializeSchema(db);

  return {
    create(session) {
      ensureAgentMessagesTable(db, session.agentType);
      transaction(db, () => {
        db.prepare(`
          INSERT INTO llm_session_meta(session_id, agent_type, started_at, started_at_utc, message_count, meta_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          session.sessionId,
          session.agentType,
          session.startedAt,
          session.startedAtUtc,
          session.messages.length,
          json(session.meta)
        );
        insertMessages(db, session.agentType, session.sessionId, session.messages, 0);
      });
    },
    read(sessionId) {
      const row = db.prepare(`
        SELECT session_id AS sessionId, agent_type AS agentType, started_at AS startedAt,
               started_at_utc AS startedAtUtc, meta_json AS metaJson
        FROM llm_session_meta
        WHERE session_id = ?
        LIMIT 1
      `).get(sessionId) as Row | undefined;
      if (!row) return undefined;
      const agentType = row.agentType;
      // 分表可能尚未创建(例如只迁移了总表), 惰性补齐, 保证 read 稳定可用。
      ensureAgentMessagesTable(db, agentType);
      const messages = db.prepare(`
        SELECT message_json AS messageJson
        FROM "${agentMessagesTableName(agentType)}"
        WHERE session_id = ?
        ORDER BY ordinal ASC
      `).all(sessionId) as Array<{ messageJson: string }>;
      return {
        sessionId: row.sessionId,
        agentType,
        startedAt: row.startedAt,
        startedAtUtc: row.startedAtUtc,
        meta: parseJson(row.metaJson as string),
        messages: messages.map((entry) => parseJson(entry.messageJson) as LLMMessage)
      };
    },
    readMeta(sessionId) {
      const row = db.prepare(`
        SELECT meta_json AS metaJson
        FROM llm_session_meta
        WHERE session_id = ?
        LIMIT 1
      `).get(sessionId) as { metaJson: string } | undefined;
      return row ? parseJson(row.metaJson) : undefined;
    },
    append(input) {
      transaction(db, () => {
        const current = db.prepare(`
          SELECT agent_type AS agentType, message_count AS messageCount
          FROM llm_session_meta
          WHERE session_id = ?
          LIMIT 1
        `).get(input.sessionId) as { agentType: string; messageCount: number } | undefined;
        if (!current) throw new Error(`llm session not found: ${input.sessionId}`);
        const agentType = current.agentType;
        const maxOrdinal = db.prepare(`
          SELECT COALESCE(MAX(ordinal), -1) AS value
          FROM "${agentMessagesTableName(agentType)}"
          WHERE session_id = ?
        `).get(input.sessionId) as { value: number };
        insertMessages(db, agentType, input.sessionId, input.messages, Number(maxOrdinal.value) + 1);
        // append 只追加消息并同步 message_count 列; meta_json 由 updateMeta 单独维护。
        db.prepare(`
          UPDATE llm_session_meta
          SET message_count = ?
          WHERE session_id = ?
        `).run(
          Number(maxOrdinal.value) + 1 + input.messages.length,
          input.sessionId
        );
      });
    },
    updateMeta(input) {
      transaction(db, () => {
        const result = db.prepare(`
          UPDATE llm_session_meta
          SET meta_json = ?
          WHERE session_id = ?
        `).run(json(input.meta), input.sessionId);
        if (result.changes === 0) throw new Error(`llm session not found: ${input.sessionId}`);
      });
    },
    replace(input) {
      transaction(db, () => {
        const current = db.prepare(`
          SELECT agent_type AS agentType
          FROM llm_session_meta
          WHERE session_id = ?
          LIMIT 1
        `).get(input.sessionId) as { agentType: string } | undefined;
        if (!current) throw new Error(`llm session not found: ${input.sessionId}`);
        const agentType = current.agentType;
        db.prepare(`
          DELETE FROM "${agentMessagesTableName(agentType)}"
          WHERE session_id = ?
        `).run(input.sessionId);
        insertMessages(db, agentType, input.sessionId, input.messages, 0);
        db.prepare(`
          UPDATE llm_session_meta
          SET message_count = ?, meta_json = ?
          WHERE session_id = ?
        `).run(input.messages.length, json(input.meta), input.sessionId);
      });
    },
    list(input) {
      return (db.prepare(`
        SELECT session_id AS sessionId, agent_type AS agentType, started_at AS startedAt,
               started_at_utc AS startedAtUtc, message_count AS messageCount
        FROM llm_session_meta
        WHERE agent_type = ?
        ORDER BY started_at DESC, session_id ASC
        LIMIT ?
      `).all(input.agentType, input.limit) as Row[]).map((row) => ({
        sessionId: row.sessionId,
        agentType: row.agentType,
        startedAt: row.startedAt,
        startedAtUtc: row.startedAtUtc,
        messageCount: Number(row.messageCount)
      }));
    },
    close() {
      db.close();
    }
  };
}

type Row = {
  sessionId: string;
  agentType: string;
  startedAt: string;
  startedAtUtc: string;
  messageCount?: number;
  metaJson?: string;
};

function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_session_meta (
      session_id TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL,
      started_at TEXT NOT NULL,
      started_at_utc TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0
        CHECK (message_count >= 0),
      meta_json TEXT NOT NULL
        CHECK (json_valid(meta_json))
    );

    CREATE INDEX IF NOT EXISTS llm_session_meta_agent_started_idx
      ON llm_session_meta(agent_type, started_at DESC, session_id DESC);
  `);
  for (const agentType of PRE_CREATED_AGENT_TYPES) {
    ensureAgentMessagesTable(db, agentType);
  }
}

/** 惰性创建 agent messages 分表(幂等)。 */
function ensureAgentMessagesTable(db: DatabaseSync, agentType: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "${agentMessagesTableName(agentType)}" (
      session_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      message_json TEXT NOT NULL CHECK (json_valid(message_json)),
      PRIMARY KEY (session_id, ordinal),
      FOREIGN KEY (session_id)
        REFERENCES llm_session_meta(session_id)
        ON DELETE CASCADE
    );
  `);
}

/** 在分表内从 startOrdinal 起连续写入消息; 消息序列化失败时整体回滚。 */
function insertMessages(db: DatabaseSync, agentType: string, sessionId: string, messages: LLMMessage[], startOrdinal: number): void {
  if (messages.length === 0) return;
  const insert = db.prepare(`
    INSERT INTO "${agentMessagesTableName(agentType)}"(session_id, ordinal, message_json)
    VALUES (?, ?, ?)
  `);
  messages.forEach((message, index) => {
    insert.run(sessionId, startOrdinal + index, json(message));
  });
}

function transaction(db: DatabaseSync, fn: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}
