import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import { cloneLLMMessages } from "../adapters/jsonl-llm-session-log.js";
import { createLLMSessionStore, type LLMSessionStore, type StoredLLMSession } from "../adapters/sqlite-llm-session-store.js";
import { clearLLMSessionPointer, pointerFilePath, readLLMSessionPointer, writeLLMSessionPointer } from "../adapters/llm-session-pointer.js";
import type { LLMSessionRecord } from "../domain/llm-session.js";

const path = await import("node:path");

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

export type SessionFileEntry = {
  agentType: string;
  date: string;
  clock: string;
  filePath: string;
};

/** readAll / listSessionFiles 使用的全量列表上限。 */
const UNLIMITED_LIST_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * LLM 会话归档: SQLite 主库(llm-sessions.sqlite) + current 指针(current.json)。
 *
 * 完整会话对象(除 messages 与固定列外的全部字段)序列化进 meta_json,
 * 读取时 JSON.parse 直接作为 meta 返回, 不从普通列重建、不丢弃未知字段。
 * store 可选注入: 测试注入包装 store 模拟提交失败, 因此所有写路径必须经过 store 实例。
 */
export function createLLMSessionArchive(input: {
  memoryRoot: string;
  time: CurrentTimeProvider;
  appendLog: AppendLog;
  store?: LLMSessionStore;
}) {
  const store = input.store ?? createLLMSessionStore(path.join(input.memoryRoot, "llm-sessions.sqlite"));

  return {
    root,
    currentPointerPath,
    writeCurrentPointer,
    clearCurrentPointer,
    writeFile,
    writeMetadata,
    appendMessages,
    replaceTranscript,
    readCurrent,
    restorePersistedActive,
    readAll,
    listSessionFiles,
    listSessions,
    readSession,
    readSessionMeta,
    close
  };

  function root(): string {
    return path.join(input.memoryRoot, "llm-sessions");
  }

  function currentPointerPath(): string {
    return pointerFilePath(root());
  }

  function writeCurrentPointer(session: LLMSessionRecord): void {
    writeLLMSessionPointer(root(), { sessionId: session.id, agentType: session.agentId ?? "chat" });
  }

  function clearCurrentPointer(): void {
    clearLLMSessionPointer(root());
  }

  /** 完整 meta: 整个可变会话对象, 排除 messages 与固定列/派生字段。 */
  function sessionMetadata(session: LLMSessionRecord): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(session)) {
      if (key === "messages" || key === "id" || key === "agentId" || key === "startedAt"
        || key === "startedAtUtc" || key === "archiveFilePath" || key === "archiveMetadata") {
        continue;
      }
      meta[key] = value;
    }
    return meta;
  }

  /** 新会话: store.create(重复 sessionId 会抛错)。 */
  function writeFile(session: LLMSessionRecord): void {
    const meta = sessionMetadata(session);
    session.archiveMetadata = meta;
    store.create({
      sessionId: String(session.id),
      agentType: session.agentId ?? "chat",
      startedAt: session.startedAt,
      startedAtUtc: session.startedAtUtc ?? session.startedAt,
      meta,
      messages: cloneLLMMessages(session.messages)
    });
  }

  /** 只更新 meta_json(不动 started_at 列与分表)。 */
  function writeMetadata(session: LLMSessionRecord): void {
    const meta = sessionMetadata(session);
    session.archiveMetadata = meta;
    store.updateMeta({ sessionId: String(session.id), meta });
  }

  /** 追加消息并同步 message_count 列; meta_json 由 writeMetadata 单独更新。 */
  function appendMessages(session: LLMSessionRecord, messages: LLMChatInput["messages"]): void {
    if (messages.length === 0) return;
    store.append({ sessionId: String(session.id), messages: cloneLLMMessages(messages) });
  }

  /** 显式完整替换(Talk 重建): 事务内删除分表消息并重写, reason 由调用方说明。 */
  function replaceTranscript(session: LLMSessionRecord, reason: string): void {
    const meta = sessionMetadata(session);
    session.archiveMetadata = meta;
    store.replace({ sessionId: String(session.id), messages: cloneLLMMessages(session.messages), meta, reason });
  }

  /** 读取 current: 只从外部指针定位, 绝不扫描表推断; 已 cleared 时清理陈旧指针。 */
  function readCurrent(): LLMSessionRecord | undefined {
    const pointer = readLLMSessionPointer(root());
    if (!pointer) return undefined;
    const stored = store.read(String(pointer.sessionId));
    if (!stored) {
      input.appendLog("warn", `llm session pointer target missing: session=${pointer.sessionId} agent=${pointer.agentType}`);
      return undefined;
    }
    if (stored.agentType !== pointer.agentType) {
      input.appendLog("warn", `llm session pointer agent mismatch: pointer_agent=${pointer.agentType} stored_agent=${stored.agentType} session=${pointer.sessionId}`);
      return undefined;
    }
    const session = restoreLLMSessionRecord(stored);
    if (session.clearedAt) {
      clearLLMSessionPointer(root());
      return undefined;
    }
    return session;
  }

  /** 启动恢复: 指针 + 主库; 无指针/目标缺失/agent 不一致返回 undefined。 */
  function restorePersistedActive(): LLMSessionRecord | undefined {
    const pointer = readLLMSessionPointer(root());
    if (!pointer) return undefined;
    try {
      const stored = store.read(String(pointer.sessionId));
      if (!stored) {
        input.appendLog("warn", `llm session pointer target missing: session=${pointer.sessionId} agent=${pointer.agentType}`);
        return undefined;
      }
      if (stored.agentType !== pointer.agentType) {
        input.appendLog("warn", `llm session pointer agent mismatch: pointer_agent=${pointer.agentType} stored_agent=${stored.agentType} session=${pointer.sessionId}`);
        return undefined;
      }
      const session = restoreLLMSessionRecord(stored);
      if (session.clearedAt || !session.staticPromptFingerprint || session.messages.length === 0) {
        clearLLMSessionPointer(root());
        return undefined;
      }
      if (session.currentRound?.status === "running") {
        session.currentRound = {
          ...session.currentRound,
          status: "interrupted",
          finishedAt: input.time.now().iso
        };
        writeMetadata(session);
      }
      return session;
    } catch (error) {
      input.appendLog("warn", `llm session pointer restore failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** 主库 chat/talk/memorize 三 agent 的全量浏览(管理后台行为)。 */
  function readAll(): LLMSessionRecord[] {
    const sessions: LLMSessionRecord[] = [];
    for (const agentType of ["chat", "talk", "memorize"]) {
      for (const item of store.list({ agentType, limit: UNLIMITED_LIST_LIMIT })) {
        const stored = store.read(item.sessionId);
        if (stored) sessions.push(restoreLLMSessionRecord(stored));
      }
    }
    return sessions;
  }

  /**
   * 会话列表条目: 从 store.list 派生(只查总表, 不解析 meta_json、不读分表)。
   * filePath 携带存储 sessionId, 供列表以存储 id 定位详情。
   */
  function listSessionFiles(): SessionFileEntry[] {
    const entries: SessionFileEntry[] = [];
    for (const agentType of ["chat", "talk", "memorize"]) {
      for (const item of store.list({ agentType, limit: UNLIMITED_LIST_LIMIT })) {
        entries.push({
          agentType: item.agentType,
          date: item.startedAt.slice(0, 10),
          clock: item.startedAt.slice(11, 23).replace(/[:.]/g, "-"),
          filePath: item.sessionId
        });
      }
    }
    return entries;
  }

  /** 按 agent 类型列出会话(只查总表)。 */
  function listSessions(agentType: string, limit?: number): ReturnType<LLMSessionStore["list"]> {
    return store.list({ agentType, limit: limit ?? UNLIMITED_LIST_LIMIT });
  }

  /** 按存储 id 读取完整会话(总表 + 目标 agent 分表)。 */
  function readSession(sessionId: string): StoredLLMSession | undefined {
    return store.read(sessionId);
  }

  /** 只读总表 meta(不访问 messages 分表), 供列表展示使用。 */
  function readSessionMeta(sessionId: string): Record<string, unknown> | undefined {
    return store.readMeta(sessionId);
  }

  function close(): void {
    store.close();
  }
}

/** 从 StoredLLMSession 恢复内存会话记录: meta 原样展开 + 固定列覆盖。 */
export function restoreLLMSessionRecord(stored: StoredLLMSession): LLMSessionRecord {
  const meta = stored.meta as Record<string, unknown>;
  const agentId = stored.agentType === "chat" || stored.agentType === "talk" || stored.agentType === "memorize"
    ? stored.agentType
    : undefined;
  const reason = typeof meta.reason === "string" ? meta.reason : (typeof meta.clearReason === "string" ? meta.clearReason : undefined);
  const modeStaticMessages = Array.isArray(meta.modeStaticMessages)
    ? meta.modeStaticMessages as LLMChatInput["messages"]
    : (typeof meta.modeStaticMessageCount === "number" && Number.isFinite(meta.modeStaticMessageCount)
      ? cloneLLMMessages(stored.messages.slice(0, Math.max(0, Math.min(stored.messages.length, meta.modeStaticMessageCount))))
      : []);
  return {
    ...(meta as Record<string, unknown>),
    id: Number(stored.sessionId),
    agentId,
    startedAt: stored.startedAt,
    startedAtUtc: stored.startedAtUtc,
    updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : stored.startedAt,
    requestIds: Array.isArray(meta.requestIds) ? meta.requestIds as number[] : [],
    responseIds: Array.isArray(meta.responseIds) ? meta.responseIds as number[] : [],
    requestTimestamps: Array.isArray(meta.requestTimestamps) ? meta.requestTimestamps as string[] : [],
    messages: stored.messages,
    reason,
    modeStaticMessages,
    archiveMetadata: stored.meta
  } as LLMSessionRecord;
}
