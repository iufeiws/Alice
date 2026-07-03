import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import { staticPromptFingerprintForMessages, staticPromptFingerprintForText } from "../../../../contexts/agent-profile/src/application/build-system-prompt.js";
import {
  absoluteLLMSessionPath as absoluteLLMSessionJsonlPath,
  appendLLMSessionJsonlMessages,
  cloneLLMMessages,
  collectLLMSessionFiles as collectLLMSessionJsonlFiles,
  createLLMSessionFilePath as createLLMSessionJsonlFilePath,
  readLLMSessionJsonl,
  relativeLLMSessionPath as relativeLLMSessionJsonlPath,
  writeLLMSessionJsonl,
  writeLLMSessionJsonlMetadata
} from "../adapters/jsonl-llm-session-log.js";
import type { LLMSessionRecord } from "../domain/llm-session.js";
import {
  parseRequestInfo,
  parseResponseInfo,
  parseRoundInfo,
  parseTokenPressurePreviewBaselines,
  stringArray
} from "../domain/llm-session-utils.js";

const fs = await import("node:fs");
const path = await import("node:path");

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

export function createLLMSessionArchive(input: {
  memoryRoot: string;
  time: CurrentTimeProvider;
  appendLog: AppendLog;
}) {
  return {
    root,
    currentPointerPath,
    createFilePath,
    relativePath,
    absolutePath,
    writeCurrentPointer,
    clearCurrentPointer,
    sessionMetadata,
    writeFile,
    writeMetadata,
    appendMessages,
    readCurrent,
    restorePersistedActive,
    readAll,
    collectFiles,
    readFile
  };

  function root(): string {
    return path.join(input.memoryRoot, "llm-sessions");
  }

  function currentPointerPath(): string {
    return path.join(root(), "current.json");
  }

  function createFilePath(time: string, agentId: "chat" | "talk" = "chat"): string {
    return createLLMSessionJsonlFilePath(root(), time || input.time.now().iso, { type: agentId });
  }

  function relativePath(filePath: string): string {
    return relativeLLMSessionJsonlPath(root(), filePath);
  }

  function absolutePath(relativePath: string): string {
    return absoluteLLMSessionJsonlPath(root(), relativePath);
  }

  function writeCurrentPointer(session: LLMSessionRecord): void {
    if (!session.archiveFilePath) return;
    fs.mkdirSync(root(), { recursive: true });
    fs.writeFileSync(currentPointerPath(), `${JSON.stringify({
      path: relativePath(session.archiveFilePath),
      sessionId: session.id
    }, null, 2)}\n`);
  }

  function clearCurrentPointer(): void {
    try {
      fs.rmSync(currentPointerPath(), { force: true });
    } catch {
      // Ignore pointer cleanup errors; the archived session metadata is still written.
    }
  }

  function sessionMetadata(session: LLMSessionRecord): Record<string, unknown> {
    const agentId = session.agentId ?? "chat";
    const last = session.messages.at(-1);
    return {
      type: "llm_session",
      agent: agentId,
      schemaVersion: 1,
      sessionId: session.id,
      sessionCreatedAtUtc: session.startedAtUtc,
      startedAt: session.startedAt,
      startedAtUtc: session.startedAtUtc,
      updatedAt: session.updatedAt,
      updatedAtUtc: session.updatedAtUtc,
      staticPromptFingerprint: session.staticPromptFingerprint,
      staticPromptMessageCount: session.staticPromptMessageCount ?? 0,
      requestTimestamps: session.requestTimestamps,
      lastTotalTokens: session.lastTotalTokens,
      lastInputTokens: session.lastInputTokens,
      lastUsageModel: session.lastUsageModel,
      tokenPressurePreviewBaselines: session.tokenPressurePreviewBaselines ?? {},
      mode: session.mode ?? "normal",
      modeStartedAt: session.modeStartedAt,
      modeExpiresAt: session.modeExpiresAt,
      modeStaticMessageCount: session.modeStaticMessages?.length ?? 0,
      modeStaticTokenEstimate: session.modeStaticTokenEstimate ?? 0,
      fixedPrefixKind: session.fixedPrefixKind,
      fixedPrefixCursorMessageId: session.fixedPrefixCursorMessageId,
      waitChatStartedAt: session.waitChatStartedAt,
      skipNextAppendLayers: session.skipNextAppendLayers === true ? true : undefined,
      agentLoopRunSeq: session.agentLoopRunSeq,
      currentRound: session.currentRound,
      latestRequest: session.latestRequestInfo,
      latestResponse: session.latestResponseInfo,
      requestIds: session.requestIds,
      responseIds: session.responseIds,
      messageCount: session.messages.length,
      lastMessageRole: last?.role,
      lastMessageAt: session.updatedAt,
      clearedAt: session.clearedAt,
      clearedAtUtc: session.clearedAtUtc,
      clearReason: session.reason
    };
  }

  function writeFile(session: LLMSessionRecord): void {
    const filePath = session.archiveFilePath ?? createFilePath(session.startedAtUtc ?? session.startedAt, session.agentId ?? "chat");
    session.archiveFilePath = filePath;
    session.archiveMetadata = sessionMetadata(session);
    writeLLMSessionJsonl(filePath, session.archiveMetadata, session.messages);
  }

  function writeMetadata(session: LLMSessionRecord): void {
    session.archiveMetadata = sessionMetadata(session);
    if (!session.archiveFilePath || !fs.existsSync(session.archiveFilePath)) {
      writeFile(session);
      return;
    }
    writeLLMSessionJsonlMetadata(session.archiveFilePath, session.archiveMetadata);
  }

  function appendMessages(session: LLMSessionRecord, messages: LLMChatInput["messages"]): void {
    if (messages.length === 0) return;
    if (!session.archiveFilePath || !fs.existsSync(session.archiveFilePath)) {
      writeFile(session);
      return;
    }
    appendLLMSessionJsonlMessages(session.archiveFilePath, messages);
  }

  function readCurrent(): LLMSessionRecord | undefined {
    const pointer = currentPointerPath();
    if (!fs.existsSync(pointer)) return undefined;
    const parsedPointer = JSON.parse(fs.readFileSync(pointer, "utf8")) as { path?: unknown };
    if (typeof parsedPointer.path !== "string") return undefined;
    return readFile(absolutePath(parsedPointer.path));
  }

  function restorePersistedActive(): LLMSessionRecord | undefined {
    const pointer = currentPointerPath();
    if (!fs.existsSync(pointer)) return undefined;
    try {
      const parsedPointer = JSON.parse(fs.readFileSync(pointer, "utf8")) as { path?: unknown; sessionId?: unknown };
      if (typeof parsedPointer.path !== "string") return undefined;
      const filePath = absolutePath(parsedPointer.path);
      const session = readFile(filePath);
      if (!session || session.clearedAt || session.messages.length === 0 || !session.staticPromptFingerprint) return undefined;
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

  function readAll(): LLMSessionRecord[] {
    const sessionRoot = root();
    if (!fs.existsSync(sessionRoot)) return [];
    const files: string[] = [];
    collectFiles(sessionRoot, files);
    return files
      .map((filePath) => readFile(filePath))
      .filter((session): session is LLMSessionRecord => Boolean(session));
  }

  function collectFiles(dir: string, files: string[]): void {
    collectLLMSessionJsonlFiles(dir, files);
  }

  function readFile(filePath: string): LLMSessionRecord | undefined {
    try {
      const parsed = readLLMSessionJsonl(filePath);
      if (!parsed) return undefined;
      const metadata = parsed.metadata;
      if (metadata.agent === "memorize") return undefined;
      if (metadata.type !== "llm_session" || typeof metadata.sessionId !== "number") return undefined;
      const agentId = metadata.agent === "talk" ? "talk" : "chat";
      const messages = parsed.messages;
      const staticPromptMessageCount = messageCountFromMetadata(metadata.staticPromptMessageCount, messages.length);
      const modeStaticMessages = modeStaticMessagesFromMetadata(metadata, messages);
      return {
        id: metadata.sessionId,
        agentId,
        startedAt: typeof metadata.startedAt === "string" ? metadata.startedAt : "",
        startedAtUtc: typeof metadata.startedAtUtc === "string" ? metadata.startedAtUtc : undefined,
        updatedAt: typeof metadata.updatedAt === "string" ? metadata.updatedAt : "",
        updatedAtUtc: typeof metadata.updatedAtUtc === "string" ? metadata.updatedAtUtc : undefined,
        archiveFilePath: filePath,
        archiveMetadata: metadata,
        requestIds: numberArray(metadata.requestIds),
        responseIds: numberArray(metadata.responseIds),
        messages: cloneLLMMessages(messages),
        latestRequest: undefined,
        staticPromptFingerprint: staticPromptFingerprintFromMetadata(metadata, messages, staticPromptMessageCount),
        staticPromptMessageCount,
        requestTimestamps: stringArray(metadata.requestTimestamps),
        agentLoopRunSeq: typeof metadata.agentLoopRunSeq === "number" && Number.isFinite(metadata.agentLoopRunSeq) ? metadata.agentLoopRunSeq : undefined,
        lastTotalTokens: typeof metadata.lastTotalTokens === "number" && Number.isFinite(metadata.lastTotalTokens) ? metadata.lastTotalTokens : undefined,
        lastInputTokens: typeof metadata.lastInputTokens === "number" && Number.isFinite(metadata.lastInputTokens) ? metadata.lastInputTokens : undefined,
        lastUsageModel: typeof metadata.lastUsageModel === "string" ? metadata.lastUsageModel : undefined,
        tokenPressurePreviewBaselines: parseTokenPressurePreviewBaselines(metadata.tokenPressurePreviewBaselines),
        mode: typeof metadata.mode === "string" ? metadata.mode : "normal",
        modeStaticMessages,
        modeStaticTokenEstimate: typeof metadata.modeStaticTokenEstimate === "number" && Number.isFinite(metadata.modeStaticTokenEstimate) ? metadata.modeStaticTokenEstimate : 0,
        modeStartedAt: typeof metadata.modeStartedAt === "string" ? metadata.modeStartedAt : undefined,
        modeExpiresAt: typeof metadata.modeExpiresAt === "string" ? metadata.modeExpiresAt : undefined,
        fixedPrefixKind: typeof metadata.fixedPrefixKind === "string" ? metadata.fixedPrefixKind : undefined,
        fixedPrefixCursorMessageId: typeof metadata.fixedPrefixCursorMessageId === "number" && Number.isFinite(metadata.fixedPrefixCursorMessageId) ? metadata.fixedPrefixCursorMessageId : undefined,
        waitChatStartedAt: typeof metadata.waitChatStartedAt === "string" ? metadata.waitChatStartedAt : undefined,
        skipNextAppendLayers: metadata.skipNextAppendLayers === true ? true : undefined,
        currentRound: parseRoundInfo(metadata.currentRound),
        latestRequestInfo: parseRequestInfo(metadata.latestRequest),
        latestResponseInfo: parseResponseInfo(metadata.latestResponse),
        clearedAt: typeof metadata.clearedAt === "string" ? metadata.clearedAt : undefined,
        clearedAtUtc: typeof metadata.clearedAtUtc === "string" ? metadata.clearedAtUtc : undefined,
        reason: typeof metadata.clearReason === "string" ? metadata.clearReason : undefined,
        requests: [],
        responses: []
      };
    } catch {
      input.appendLog("warn", `llm session file parse failed: ${filePath}`);
      return undefined;
    }
  }
}

function messageCountFromMetadata(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, Math.floor(value)));
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    : [];
}

function staticPromptFingerprintFromMetadata(
  metadata: Record<string, unknown>,
  messages: LLMChatInput["messages"],
  staticPromptMessageCount: number
): string {
  if (typeof metadata.staticPromptFingerprint === "string") {
    return metadata.staticPromptFingerprint.startsWith("sha256:")
      ? metadata.staticPromptFingerprint
      : staticPromptFingerprintForText(metadata.staticPromptFingerprint);
  }
  return staticPromptFingerprintForMessages(messages.slice(0, staticPromptMessageCount));
}

function modeStaticMessagesFromMetadata(metadata: Record<string, unknown>, messages: LLMChatInput["messages"]): LLMChatInput["messages"] {
  const count = messageCountFromMetadata(metadata.modeStaticMessageCount, messages.length);
  if (typeof metadata.modeStaticMessageCount === "number" && Number.isFinite(metadata.modeStaticMessageCount)) {
    return cloneLLMMessages(messages.slice(0, count));
  }
  return Array.isArray(metadata.modeStaticMessages)
    ? cloneLLMMessages(metadata.modeStaticMessages as LLMChatInput["messages"])
    : [];
}
