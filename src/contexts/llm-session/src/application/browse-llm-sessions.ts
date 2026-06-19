import fs from "node:fs";
import path from "node:path";

import { readLLMSessionJsonl } from "../adapters/jsonl-llm-session-log.js";
import { cloneLLMMessages } from "../adapters/jsonl-llm-session-log.js";
import type { ActiveLLMSession } from "../domain/llm-session.js";
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
  getActiveSession?(): ActiveLLMSession | undefined;
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
    for (const source of input.sources) {
      for (const session of collectSourceSessions(source, true)) {
        if ((session as any)?.id === id) return session;
      }
    }
    return undefined;
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
      const parsed = readLLMSessionJsonl(filePath);
      if (!parsed || parsed.metadata.type !== "llm_session" || !source.accept(parsed.metadata)) {
        return undefined;
      }
      const metadata = parsed.metadata;
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
        messageCount: parsed.messages.length,
        agentLoopRunSeq: typeof metadata.agentLoopRunSeq === "number" && Number.isFinite(metadata.agentLoopRunSeq) ? metadata.agentLoopRunSeq : undefined,
        currentRound: parseRoundInfo(metadata.currentRound),
        latestRequest: parseRequestInfo(metadata.latestRequest),
        latestResponse: parseResponseInfo(metadata.latestResponse),
        mode: source.mode?.(metadata) ?? (typeof metadata.mode === "string" ? metadata.mode : metadata.agent),
        archiveFilePath: filePath,
        archiveMetadata: metadata,
        messages: includeMessages ? parsed.messages : undefined
      };
      return includeMessages ? {
        ...session,
        jsonlEntries: [metadata, ...parsed.messages],
        turns: [{
          round: 0,
          latestRequest: session.latestRequest,
          latestResponse: session.latestResponse,
          messages: parsed.messages
        }]
      } : session;
    } catch {
      return undefined;
    }
  }

  function buildActiveSessionDetail(session: ActiveLLMSession): unknown {
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
