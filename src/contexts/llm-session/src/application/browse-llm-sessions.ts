import fs from "node:fs";
import path from "node:path";

import { readLLMSessionJsonl, readLLMSessionJsonlMetadata } from "../adapters/jsonl-llm-session-log.js";
import { cloneLLMMessages } from "../adapters/jsonl-llm-session-log.js";
import type { LLMSessionRecord } from "../domain/llm-session.js";
import {
  parseRequestInfo,
  parseResponseInfo,
  parseRoundInfo
} from "../domain/llm-session-utils.js";
import { buildLLMSessionTurns, summarizeLLMSession } from "./llm-session-view.js";

export type LLMSessionBrowserSource = {
  name: string;
  subdir?: string;
  limit?: number;
  accept(metadata: any): boolean;
  id(input: { filePath: string; metadata: any; relativePath: string }): string;
  mode?(metadata: any): string;
};

export function createLLMSessionBrowserRuntime(input: {
  sessionRoot(): string;
  collectFiles(dir: string, files: string[]): void;
  relativePath(filePath: string): string;
  getActiveSession?(): LLMSessionRecord | undefined;
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
    const sessions = collectSourceSessions(source, false);
    return typeof source.limit === "number" ? sessions.slice(-source.limit) : sessions;
  }

  function getLLMSession(id: string): unknown {
    const activeSession = input.getActiveSession?.();
    if (activeSession && String(activeSession.id) === id) {
      return buildActiveSessionDetail(activeSession);
    }
    // 路径式查找(llm-chain 列表的 id 即相对路径): 只读取目标文件, 不做全量扫描。
    const resolved = resolveWithinRoot(id);
    if (resolved) {
      for (const source of input.sources) {
        const sourceRoot = source.subdir ? path.join(input.sessionRoot(), source.subdir) : input.sessionRoot();
        if (resolved === sourceRoot || resolved.startsWith(sourceRoot + path.sep)) {
          const session = readSourceSessionFile(resolved, source, true);
          if (session) return session;
        }
      }
    }
    // 兜底: 按会话 id 全量扫描(保留历史行为)。
    for (const source of input.sources) {
      for (const session of collectSourceSessions(source, true)) {
        if ((session as any)?.id === id) return session;
      }
    }
    return undefined;
  }

  function resolveWithinRoot(id: string): string | undefined {
    if (!id || id.includes("..")) return undefined;
    const resolved = path.resolve(input.sessionRoot(), id);
    const root = path.resolve(input.sessionRoot());
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
    return resolved;
  }

  function collectSourceSessions(source: LLMSessionBrowserSource, includeMessages: boolean): unknown[] {
    const root = source.subdir ? path.join(input.sessionRoot(), source.subdir) : input.sessionRoot();
    if (!fs.existsSync(root)) return [];
    const files: string[] = [];
    input.collectFiles(root, files);
    return files
      .map((filePath) => readSourceSessionFile(filePath, source, includeMessages))
      .filter(Boolean);
  }

  function readSourceSessionFile(
    filePath: string,
    source: LLMSessionBrowserSource,
    includeMessages: boolean
  ): unknown | undefined {
    try {
      // 列表场景(includeMessages=false)只读 metadata 首行, 避免全量解析消息。
      const parsed = includeMessages
        ? readLLMSessionJsonl(filePath)
        : readLLMSessionJsonlMetadata(filePath);
      if (!parsed || parsed.metadata.type !== "llm_session" || !source.accept(parsed.metadata)) {
        return undefined;
      }
      const metadata = parsed.metadata;
      const messages = parsed.messages;
      const relativePath = input.relativePath(filePath);
      const session = {
        id: source.id({ filePath, metadata, relativePath }),
        agent: typeof metadata.agent === "string" ? metadata.agent : undefined,
        agentId: typeof metadata.agent === "string" ? metadata.agent : undefined,
        target: typeof metadata.target === "string" ? metadata.target : undefined,
        startedAt: typeof metadata.startedAt === "string" ? metadata.startedAt : "",
        updatedAt: typeof metadata.updatedAt === "string" ? metadata.updatedAt : "",
        requestCount: typeof metadata.requestCount === "number" ? metadata.requestCount : 0,
        responseCount: typeof metadata.responseCount === "number" ? metadata.responseCount : 0,
        roundCount: Math.max(
          typeof metadata.requestCount === "number" ? metadata.requestCount : 0,
          typeof metadata.responseCount === "number" ? metadata.responseCount : 0,
          typeof (metadata.latestRequest as any)?.round === "number" ? (metadata.latestRequest as any).round + 1 : 0,
          typeof (metadata.latestResponse as any)?.round === "number" ? (metadata.latestResponse as any).round + 1 : 0
        ),
        messageCount: includeMessages ? messages.length : (typeof metadata.messageCount === "number" ? metadata.messageCount : 0),
        agentLoopRunSeq: typeof metadata.agentLoopRunSeq === "number" && Number.isFinite(metadata.agentLoopRunSeq) ? metadata.agentLoopRunSeq : undefined,
        currentRound: parseRoundInfo(metadata.currentRound),
        latestRequest: parseRequestInfo(metadata.latestRequest),
        latestResponse: parseResponseInfo(metadata.latestResponse),
        mode: source.mode?.(metadata) ?? (typeof metadata.mode === "string" ? metadata.mode : metadata.agent),
        archiveFilePath: filePath,
        archiveMetadata: metadata,
        messages: includeMessages ? messages : undefined
      };
      return includeMessages ? {
        ...session,
        jsonlEntries: [metadata, ...messages],
        turns: [{
          round: 0,
          latestRequest: session.latestRequest,
          latestResponse: session.latestResponse,
          messages
        }]
      } : session;
    } catch {
      return undefined;
    }
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
