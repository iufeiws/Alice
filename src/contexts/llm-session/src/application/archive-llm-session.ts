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

export type SessionFileEntry = {
  agentType: string;
  date: string;
  clock: string;
  filePath: string;
};

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
    listSessionFiles,
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
      fixedPrefixStartedAt: session.fixedPrefixStartedAt,
      loopStartedAt: session.loopStartedAt,
      waitChatStartedAt: session.waitChatStartedAt,
      waitChatMode: session.waitChatMode,
      waitChatUntil: session.waitChatUntil,
      waitChatTarget: session.waitChatTarget,
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
    const sessions: LLMSessionRecord[] = [];
    for (const filePath of files) {
      const session = readFile(filePath);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  function collectFiles(dir: string, files: string[]): void {
    // sub_agent 目录是 pi/subagent LLM 会话转录(llm_subagent_session),
    // 主会话列表从不展示它们, 全量扫描纯属浪费, 直接跳过。
    collectLLMSessionJsonlFiles(dir, files, { skipDirs: ["sub_agent"] });
  }

  /**
   * 纯文件名/路径扫描: 只枚举会话文件, 不读取任何内容。
   * 路径结构为 {agentType}/{date}/{clock}.jsonl, 列表据此展示时间与 agent 类型。
   */
  function listSessionFiles(): SessionFileEntry[] {
    const sessionRoot = root();
    if (!fs.existsSync(sessionRoot)) return [];
    const files: string[] = [];
    collectFiles(sessionRoot, files);
    return files.map((filePath) => {
      const relative = path.relative(sessionRoot, filePath).split(path.sep);
      return {
        agentType: relative[0] ?? "",
        date: relative[1] ?? "",
        clock: (relative[2] ?? "").replace(/\.jsonl$/, ""),
        filePath
      };
    });
  }

  function readFile(filePath: string): LLMSessionRecord | undefined {
    try {
      const parsed = readLLMSessionJsonl(filePath);
      if (!parsed) return undefined;
      return buildSessionRecord(filePath, parsed.metadata, parsed.messages);
    } catch {
      input.appendLog("warn", `llm session file parse failed: ${filePath}`);
      return undefined;
    }
  }

  function buildSessionRecord(
    filePath: string,
    metadata: Record<string, unknown>,
    messages: LLMChatInput["messages"]
  ): LLMSessionRecord | undefined {
    if (metadata.agent === "memorize") return undefined;
    if (metadata.type !== "llm_session" || typeof metadata.sessionId !== "number") return undefined;
    const agentId = metadata.agent === "talk" ? "talk" : "chat";
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
      messages,
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
      fixedPrefixStartedAt: typeof metadata.fixedPrefixStartedAt === "string" ? metadata.fixedPrefixStartedAt : undefined,
      loopStartedAt: typeof metadata.loopStartedAt === "string" ? metadata.loopStartedAt : undefined,
      waitChatStartedAt: typeof metadata.waitChatStartedAt === "string" ? metadata.waitChatStartedAt : undefined,
      waitChatMode: metadata.waitChatMode === "schedule" || metadata.waitChatMode === "await_chat" ? metadata.waitChatMode : undefined,
      waitChatUntil: typeof metadata.waitChatUntil === "string" ? metadata.waitChatUntil : undefined,
      waitChatTarget: parseWaitChatTarget(metadata.waitChatTarget),
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

function parseWaitChatTarget(value: unknown): LLMSessionRecord["waitChatTarget"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const target = value as NonNullable<LLMSessionRecord["waitChatTarget"]>;
  if (!target.source || typeof target.source.plugin !== "string") return undefined;
  if (!target.externalSession || typeof target.externalSession.sessionId !== "string") return undefined;
  if (!["dm", "group", "topic", "admin", "desktop"].includes(target.externalSession.scope)) return undefined;
  return target;
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
