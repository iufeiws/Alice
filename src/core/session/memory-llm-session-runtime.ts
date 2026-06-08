import { readLLMSessionJsonl } from "../agent/src/llm-session-log.js";
import {
  parseRequestInfo,
  parseResponseInfo,
  parseRoundInfo
} from "../../contexts/llm-session/src/domain/llm-session-utils.js";

const fs = await import("node:fs");
const path = await import("node:path");

export function createMemoryLLMSessionRuntime(input: {
  sessionRoot(): string;
  collectFiles(dir: string, files: string[]): void;
  relativePath(filePath: string): string;
}) {
  return {
    getMemoryLLMSessions,
    getMemoryLLMSession
  };

  function getMemoryLLMSessions(): unknown[] {
    const root = path.join(input.sessionRoot(), "memorize");
    if (!fs.existsSync(root)) return [];
    const files: string[] = [];
    input.collectFiles(root, files);
    return files
      .map((filePath) => readMemoryLLMSessionFile(filePath, false))
      .filter(Boolean)
      .slice(-100);
  }

  function getMemoryLLMSession(id: string): unknown {
    const root = path.join(input.sessionRoot(), "memorize");
    if (!fs.existsSync(root)) return undefined;
    const files: string[] = [];
    input.collectFiles(root, files);
    for (const filePath of files) {
      const session = readMemoryLLMSessionFile(filePath, true);
      if (session?.id === id) return session;
    }
    return undefined;
  }

  function readMemoryLLMSessionFile(filePath: string, includeTurns: boolean): any | undefined {
    try {
      const parsed = readLLMSessionJsonl(filePath);
      if (!parsed || parsed.metadata.type !== "llm_session" || parsed.metadata.agent !== "memorize") return undefined;
      const metadata = parsed.metadata;
      const id = typeof metadata.sessionId === "string"
        ? metadata.sessionId
        : `memorize:${input.relativePath(filePath)}`;
      const session = {
        id,
        agent: "memorize",
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
        currentRound: parseRoundInfo(metadata.currentRound),
        latestRequest: parseRequestInfo(metadata.latestRequest),
        latestResponse: parseResponseInfo(metadata.latestResponse),
        mode: typeof metadata.mode === "string" ? metadata.mode : "memorize",
        archiveFilePath: filePath,
        archiveMetadata: metadata,
        messages: includeTurns ? parsed.messages : undefined
      };
      return includeTurns ? {
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
}
