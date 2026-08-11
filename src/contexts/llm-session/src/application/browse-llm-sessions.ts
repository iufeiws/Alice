import { cloneLLMMessages } from "../adapters/jsonl-llm-session-log.js";
import type { LLMSessionListItem, StoredLLMSession } from "../adapters/sqlite-llm-session-store.js";
import type { LLMSessionRecord } from "../domain/llm-session.js";
import { restoreLLMSessionRecord } from "./archive-llm-session.js";
import { buildLLMSessionTurns, summarizeLLMSession } from "./llm-session-view.js";

export type LLMSessionBrowserSource = {
  name: string;
  agentTypes: string[];
  limit?: number;
  mode?: string | ((agentType: string) => string);
};

/**
 * 会话浏览: 全部从 SQLite 主库查询(list + read), 不再做任何文件扫描。
 * 列表条目以存储 sessionId 作为 id; 列表只读总表(list + readMeta, 不访问 messages 分表),
 * 详情按 sessionId 单次读取(总表 + 目标 agent 分表)。
 */
export function createLLMSessionBrowserRuntime(input: {
  getActiveSession?(): LLMSessionRecord | undefined;
  listSessions(agentType: string, limit?: number): LLMSessionListItem[];
  readSession(sessionId: string): StoredLLMSession | undefined;
  readSessionMeta(sessionId: string): Record<string, unknown> | undefined;
  sources: LLMSessionBrowserSource[];
}) {
  return {
    listSessions,
    getLLMSession,
    getMemoryLLMSessions: () => listSessions("memorize")
  };

  function listSessions(sourceName: string): unknown[] {
    const source = input.sources.find((candidate) => candidate.name === sourceName);
    if (!source) return [];
    const sessions: unknown[] = [];
    for (const agentType of source.agentTypes) {
      for (const item of input.listSessions(agentType, source.limit)) {
        const meta = input.readSessionMeta(item.sessionId) ?? {};
        sessions.push(buildListItem(item, meta, source));
      }
    }
    return sessions;
  }

  function getLLMSession(id: string): unknown {
    const activeSession = input.getActiveSession?.();
    if (activeSession && String(activeSession.id) === id) {
      return buildActiveSessionDetail(activeSession);
    }
    const stored = input.readSession(id);
    if (!stored) return undefined;
    return buildStoredSessionDetail(stored);
  }

  function buildListItem(item: LLMSessionListItem, meta: Record<string, unknown>, source: LLMSessionBrowserSource): unknown {
    const requests = Array.isArray(meta.requests) ? meta.requests as unknown[] : [];
    const responses = Array.isArray(meta.responses) ? meta.responses as unknown[] : [];
    // 兼容旧 meta 字段名: 旧格式用 latestRequest/latestResponse 存 info, 新格式用 latestRequestInfo/latestResponseInfo。
    const latestRequest = meta.latestRequestInfo ?? meta.latestRequest;
    const latestResponse = meta.latestResponseInfo ?? meta.latestResponse;
    return {
      id: item.sessionId,
      agent: item.agentType,
      agentId: item.agentType,
      startedAt: item.startedAt,
      updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : item.startedAt,
      requestCount: requests.length,
      responseCount: responses.length,
      roundCount: Math.max(
        requests.length,
        responses.length,
        typeof (latestRequest as { round?: unknown } | undefined)?.round === "number" ? (latestRequest as { round: number }).round + 1 : 0,
        typeof (latestResponse as { round?: unknown } | undefined)?.round === "number" ? (latestResponse as { round: number }).round + 1 : 0
      ),
      messageCount: item.messageCount,
      agentLoopRunSeq: typeof meta.agentLoopRunSeq === "number" && Number.isFinite(meta.agentLoopRunSeq) ? meta.agentLoopRunSeq : undefined,
      currentRound: meta.currentRound,
      latestRequest,
      latestResponse,
      mode: typeof source.mode === "function"
        ? source.mode(item.agentType)
        : (source.mode ?? (typeof meta.mode === "string" ? meta.mode : item.agentType)),
      archiveFilePath: item.sessionId,
      archiveMetadata: meta,
      messages: undefined
    };
  }

  function buildStoredSessionDetail(stored: StoredLLMSession): unknown {
    const session = restoreLLMSessionRecord(stored);
    return {
      ...(summarizeLLMSession(session) as Record<string, unknown>),
      messages: cloneLLMMessages(session.messages),
      jsonlEntries: [stored.meta, ...cloneLLMMessages(session.messages)],
      turns: buildLLMSessionTurns(session)
    };
  }

  function buildActiveSessionDetail(session: LLMSessionRecord): unknown {
    const metadata = session.archiveMetadata ?? {
      type: "llm_session",
      sessionId: session.id,
      agent: session.agentId,
      sessionCreatedAtUtc: session.startedAtUtc,
      updatedAtUtc: session.updatedAtUtc,
      messageCount: session.messages.length
    };
    return {
      ...(summarizeLLMSession(session) as Record<string, unknown>),
      messages: cloneLLMMessages(session.messages),
      jsonlEntries: [metadata, ...cloneLLMMessages(session.messages)],
      turns: buildLLMSessionTurns(session)
    };
  }
}
