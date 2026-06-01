import type { MemorySummaryConfig } from "../../../packages/config/src/index.js";
import { createDiaryStore, type DiaryStore } from "../../../packages/storage/src/diary-store.js";
import type { StoredConversationMessage } from "../../../packages/storage/src/sqlite-store.js";
import type { ToolDefinition } from "../../../packages/types/src/index.js";
import { formatCheckChatMessages } from "../../../plugins/messaging/src/index.js";
import type { LLMChatResult, LLMClient, LLMMessage, LLMToolSpec } from "../../llm/src/index.js";
import { buildLLMTextVariables, type LLMTextVariables } from "../../text-renderer/src/index.js";
import { createLLMSessionTranscriptLogger, relativeLLMSessionPath } from "./llm-session-log.js";
import { runLLMToolLoop, type LLMRequestSender, type LLMToolLoopExecution } from "./llm-tool-loop.js";
import { normalizePromptLayers, parsePromptToolArguments, promptLayerToMessage, type PromptLayer } from "./prompt-layer-parser.js";

const fs = await import("node:fs");
const path = await import("node:path");
const childProcess = await import("node:child_process");

export type MemoryTarget = "persistent" | "userPreferences" | "yesterdaySummary";

export type MemorySnapshot = {
  persistent: string;
  userPreferences: string;
  yesterdaySummary: string;
};

export type MemoryFileStats = {
  target: MemoryTarget;
  fileName: string;
  content: string;
  lines: number;
  bytes: number;
  maxLines: number;
  maxBytes: number;
};

export type MemoryPromptLayer = PromptLayer;

export type MemoryInductionPrompts = {
  commonLayers: MemoryPromptLayer[];
  persistentLayers: MemoryPromptLayer[];
  userPreferencesLayers: MemoryPromptLayer[];
  yesterdaySummaryLayers: MemoryPromptLayer[];
};

export type MemoryInductionPromptStore = {
  get(): MemoryInductionPrompts;
  save(prompts: Partial<MemoryInductionPrompts>): MemoryInductionPrompts;
};

export type SleepMemoryState = {
  lastInductionAt?: string;
  currentInductionAt?: string;
  lastBackfillAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailure?: string;
};

export type MemoryStore = {
  ensure(): void;
  read(): MemorySnapshot;
  readTarget(target: MemoryTarget): string;
  write(snapshot: MemorySnapshot): MemorySnapshot;
  writeTarget(target: MemoryTarget, content: string, options?: MemoryWriteOptions): string;
  createDiaryDraft(): string;
  commitDiaryDraft(draftPath: string, options?: MemoryWriteOptions): string;
  stats(): MemoryFileStats[];
};

export type MemoryWriteOptions = {
  now?: string;
  localDate?: string;
  windowStartAt?: string;
  windowEndAt?: string;
  diaryDraftPath?: string;
};

export type SleepMemoryStateStore = {
  read(): SleepMemoryState;
  write(state: SleepMemoryState): SleepMemoryState;
};

export type MemorySummaryDeps = {
  memoryStore: MemoryStore;
  promptStore: MemoryInductionPromptStore;
  stateStore: SleepMemoryStateStore;
  messageStore: {
    listMessagesByCreatedAtRange(startAt: string | undefined, endAt: string, limit?: number): StoredConversationMessage[];
    listMessagesChronological(limit?: number): StoredConversationMessage[];
  };
  llm?: LLMClient;
  llmRequestSender?: LLMRequestSender;
  config: MemorySummaryConfig;
  nowIso(): string;
  timezone: string;
  sleepWindowStartAt?: string;
  userName?: string;
  sessionRoot?: string;
  onRound?(target: MemoryTarget, rounds: number, status?: string): void;
  log(level: "info" | "warn" | "error", message: string): void;
};

export type MemoryRunResult = {
  target: MemoryTarget;
  ok: boolean;
  edited: boolean;
  rounds?: number;
  error?: string;
  toolCalls: Array<{ name: string; file: MemoryResultFile; input: Record<string, unknown>; ok: boolean; output?: string; error?: string }>;
  response?: LLMChatResult["message"];
};

export type MemoryRunSummary = {
  ok: boolean;
  startedAt: string;
  windowStartAt?: string;
  windowEndAt: string;
  messageCount: number;
  results: MemoryRunResult[];
};

export type MemoryPromptPreview = {
  target: MemoryTarget;
  file: MemoryResultFile;
  windowStartAt?: string;
  windowEndAt: string;
  messageCount: number;
    request: {
      model?: string;
      temperature?: number;
      maxTokens: number;
      extraParams?: Record<string, unknown>;
      followupExtraParams?: Record<string, unknown>;
      tools: LLMToolSpec[];
      messages: LLMMessage[];
    };
};

export type MemoryInductionSession = {
  messages: LLMMessage[];
  roundOffset: number;
  activeTarget?: MemoryTarget;
  completedTargets: MemoryTarget[];
  clearedAt?: string;
  clearReason?: string;
  append?(entry: unknown): void;
};

export const memoryFileLimits = {
  persistent: { lines: 100, bytes: 10 * 1024 },
  userPreferences: { lines: 80, bytes: 8 * 1024 },
  yesterdaySummary: { lines: 20, bytes: 2 * 1024 }
} as const;

const targetFiles: Record<MemoryTarget, string> = {
  persistent: "persistent-memory.md",
  userPreferences: "user-preferences.md",
  yesterdaySummary: "diary.sqlite"
};

type MemoryResultFile = "persistent-memory" | "user-preferences" | "diary";

const targetResultFiles: Record<MemoryTarget, MemoryResultFile> = {
  persistent: "persistent-memory",
  userPreferences: "user-preferences",
  yesterdaySummary: "diary"
};

const targetDirectories: Record<MemoryTarget, string> = {
  persistent: "long-term-memory",
  userPreferences: "long-term-memory",
  yesterdaySummary: "diary"
};

const targetTitles: Record<MemoryTarget, string> = {
  persistent: "持久记忆",
  userPreferences: "用户偏好",
  yesterdaySummary: "日记"
};

const maxMessagesPerSummary = 10_000;
const memoryToolRoundLimit = 20;
const memoryInductionMaxAttempts = 3;

const fullwidthLettersAndDigits = "ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ０１２３４５６７８９";
const halfwidthLettersAndDigits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export const commonHalfwidthNormalizationMap: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(Array.from(fullwidthLettersAndDigits).map((char, index) => [char, halfwidthLettersAndDigits[index]])),
  "　": " ",
  "，": ",",
  "。": ".",
  "．": ".",
  "：": ":",
  "；": ";",
  "？": "?",
  "！": "!",
  "（": "(",
  "）": ")",
  "【": "[",
  "】": "]",
  "［": "[",
  "］": "]",
  "｛": "{",
  "｝": "}",
  "“": "\"",
  "”": "\"",
  "‘": "'",
  "’": "'",
  "／": "/",
  "＼": "\\",
  "＿": "_",
  "－": "-",
  "～": "~",
  "｜": "|",
  "＃": "#",
  "＠": "@",
  "＆": "&",
  "＊": "*",
  "＋": "+",
  "＝": "=",
  "＜": "<",
  "＞": ">"
});

export function createMarkdownMemoryStore(root: string): MemoryStore {
  function filePath(target: MemoryTarget): string {
    return path.join(root, targetDirectories[target], targetFiles[target]);
  }
  const diaryStore = createOptionalDiaryStore(root);

  return {
    ensure() {
      fs.mkdirSync(root, { recursive: true });
      for (const target of ["persistent", "userPreferences"] as MemoryTarget[]) {
        const dir = path.join(root, targetDirectories[target]);
        fs.mkdirSync(dir, { recursive: true });
        const fullPath = path.join(dir, targetFiles[target]);
        if (!fs.existsSync(fullPath)) fs.writeFileSync(fullPath, "");
      }
      fs.mkdirSync(path.join(root, "diary"), { recursive: true });
      fs.mkdirSync(path.join(root, "diary", "tmp"), { recursive: true });
      ensureGitRepo(path.join(root, "long-term-memory"));
      commitLongTermMemoryBaseline(root);
    },
    read() {
      this.ensure();
      return {
        persistent: readFile(filePath("persistent")),
        userPreferences: readFile(filePath("userPreferences")),
        yesterdaySummary: diaryStore.latestEntry()?.content ?? ""
      };
    },
    readTarget(target) {
      this.ensure();
      if (target === "yesterdaySummary") return "";
      return readFile(filePath(target));
    },
    write(snapshot) {
      this.ensure();
      return {
        persistent: this.writeTarget("persistent", snapshot.persistent),
        userPreferences: this.writeTarget("userPreferences", snapshot.userPreferences),
        yesterdaySummary: this.writeTarget("yesterdaySummary", snapshot.yesterdaySummary)
      };
    },
    writeTarget(target, content, options) {
      this.ensure();
      const limited = enforceTargetLimit(target, content);
      if (target === "yesterdaySummary") {
        if (options?.diaryDraftPath) {
          writeAtomic(options.diaryDraftPath, limited);
          return limited;
        }
        const localDate = options?.localDate ?? options?.windowEndAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
        diaryStore.upsertEntry({
          localDate,
          content: limited,
          now: options?.now ?? new Date().toISOString(),
          windowStartAt: options?.windowStartAt,
          windowEndAt: options?.windowEndAt
        });
        return limited;
      }
      writeAtomic(filePath(target), limited);
      if (target === "persistent" || target === "userPreferences") {
        commitLongTermMemory(root, target, targetFiles[target]);
      }
      return limited;
    },
    createDiaryDraft() {
      this.ensure();
      const dir = path.join(root, "diary", "tmp");
      fs.mkdirSync(dir, { recursive: true });
      let draftPath = path.join(dir, `${Date.now()}-${process.pid}.md`);
      let suffix = 2;
      while (fs.existsSync(draftPath)) {
        draftPath = path.join(dir, `${Date.now()}-${process.pid}-${suffix}.md`);
        suffix += 1;
      }
      writeAtomic(draftPath, "");
      return draftPath;
    },
    commitDiaryDraft(draftPath, options) {
      this.ensure();
      const content = readFile(draftPath);
      const written = this.writeTarget("yesterdaySummary", content, options);
      try {
        fs.rmSync(draftPath);
      } catch {
        // Draft cleanup is best-effort after SQLite has the diary entry.
      }
      return written;
    },
    stats() {
      const snapshot = this.read();
      return (Object.keys(targetFiles) as MemoryTarget[]).map((target) => {
        const content = snapshot[target];
        return {
          target,
          fileName: path.join(targetDirectories[target], targetFiles[target]),
          content,
          lines: content.trim() ? content.trim().split(/\r?\n/).length : 0,
          bytes: utf8ByteLength(content),
          maxLines: memoryFileLimits[target].lines,
          maxBytes: memoryFileLimits[target].bytes
        };
      });
    }
  };
}

export function createMemoryInductionPromptStore(filePath: string): MemoryInductionPromptStore {
  let current = readMemoryInductionPrompts(filePath);
  if (!fs.existsSync(filePath)) writeMemoryInductionPrompts(filePath, current);
  return {
    get() {
      return { ...current };
    },
    save(prompts) {
      current = normalizeMemoryInductionPrompts({ ...current, ...prompts });
      writeMemoryInductionPrompts(filePath, current);
      return { ...current };
    }
  };
}

export function defaultMemoryInductionPrompts(): MemoryInductionPrompts {
  return {
    commonLayers: [
      layer("common_scope", "共同规则", "system", 10, [
        "你是 Alice 的记忆维护子系统。",
        "只通过 read_memory / apply_patch 工具工作。",
        "apply_patch 写入的是当前任务绑定文件，没有 file/path 参数。",
        "必须调用 apply_patch({ patch }) 提交 unified diff patch；普通回复不会保存。"
      ].join("\n")),
      layer("common_quality", "质量标准", "system", 20, [
        "保留明确、稳定、有未来价值的信息。",
        "删除重复、流水账、短期情绪噪声和已被新信息推翻的内容。",
        "内容使用简体中文，短句，结构清晰。"
      ].join("\n")),
      layer("common_messages", "当天消息记录", "user", 80, [
        "归纳窗口：{{memorize/window/startAt}} -> {{memorize/window/endAt}}",
        "时区：{{memorize/timezone}}",
        "",
        "聊天记录：",
        "{{memorize/messages/content}}"
      ].join("\n")),
      {
        id: "common_read_memory",
        title: "Fake read_memory",
        role: "tool_request",
        enabled: true,
        order: 90,
        content: "",
        toolName: "read_memory",
        toolArguments: "{}",
        thinking: "先读取当前绑定记忆目标，保持工具上下文一致。"
      }
    ],
    persistentLayers: [
      layer("persistent_goal", "长期记忆专属", "system", 10, [
        "维护持久记忆文件。",
        "只记录长期有效的事实、关系连续性、项目长期背景、用户明确要求长期保留的信息。",
        "不要把单日流水账写入持久记忆。"
      ].join("\n"))
    ],
    userPreferencesLayers: [
      layer("preferences_goal", "用户偏好专属", "system", 10, [
        "维护用户偏好文件。",
        "只记录稳定偏好：语言、语气、交互方式、实现习惯、明确禁忌、长期约束。",
        "不要把一次性任务需求误判为偏好。"
      ].join("\n"))
    ],
    yesterdaySummaryLayers: [
      layer("yesterday_goal", "日记专属", "system", 10, [
        "维护 agent 日记。",
        "只基于本次聊天记录写当天日记摘要。",
        "不要沿用旧日记内容。"
      ].join("\n"))
    ]
  };
}

export function createSleepMemoryStateStore(filePath: string): SleepMemoryStateStore {
  return {
    read() {
      if (!fs.existsSync(filePath)) return {};
      try {
        return normalizeSleepMemoryState(JSON.parse(fs.readFileSync(filePath, "utf8")) as SleepMemoryState);
      } catch {
        return {};
      }
    },
    write(state) {
      const normalized = normalizeSleepMemoryState(state);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writeAtomic(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
      return normalized;
    }
  };
}

export async function runSleepMemoryInduction(deps: MemorySummaryDeps): Promise<boolean> {
  const currentInductionAt = deps.nowIso();
  const existing = deps.stateStore.read();
  deps.stateStore.write({ ...existing, currentInductionAt });

  if (!deps.config.enabled) {
    deps.log("info", "sleep Memorize skipped: disabled");
    return false;
  }
  if (!deps.llm || !deps.config.apiKey) {
    deps.log("warn", "sleep Memorize skipped: missing Memorize API preset or API key");
    return false;
  }

  const windowStartAt = deps.sleepWindowStartAt ?? existing.lastInductionAt;
  const messages = deps.messageStore.listMessagesByCreatedAtRange(windowStartAt, currentInductionAt, maxMessagesPerSummary);
  if (messages.length === 0) {
    deps.stateStore.write({
      ...existing,
      currentInductionAt,
      lastInductionAt: currentInductionAt,
      lastSuccessAt: currentInductionAt,
      lastFailureAt: undefined,
      lastFailure: undefined
    });
    deps.log("info", `sleep Memorize advanced without messages: at=${currentInductionAt}`);
    return true;
  }

  const result = await runMemoryInductionForMessages({
    ...deps,
    messages,
    windowStartAt,
    windowEndAt: currentInductionAt
  });
  if (result.ok) {
    deps.stateStore.write({
      ...existing,
      currentInductionAt,
      lastInductionAt: currentInductionAt,
      lastSuccessAt: currentInductionAt,
      lastFailureAt: undefined,
      lastFailure: undefined
    });
    return true;
  }

  const reason = result.results.find((entry) => !entry.ok)?.error ?? "unknown Memorize failure";
  deps.stateStore.write({
    ...existing,
    currentInductionAt,
    lastFailureAt: currentInductionAt,
    lastFailure: reason
  });
  return false;
}

export async function runMemoryInductionForMessages(
  deps: Omit<MemorySummaryDeps, "messageStore" | "stateStore"> & {
    messages: StoredConversationMessage[];
    windowStartAt?: string;
    windowEndAt: string;
    memorySession?: MemoryInductionSession;
  },
  targetFilter?: MemoryTarget
): Promise<MemoryRunSummary> {
  const startedAt = deps.nowIso();
  const results: MemoryRunResult[] = [];
  if (!deps.config.enabled) {
    return { ok: false, startedAt, windowStartAt: deps.windowStartAt, windowEndAt: deps.windowEndAt, messageCount: deps.messages.length, results };
  }
  if (!deps.llm || !deps.config.apiKey) {
    const error = "missing Memorize API preset or API key";
    deps.log("warn", `Memorize skipped: ${error}`);
    return {
      ok: false,
      startedAt,
      windowStartAt: deps.windowStartAt,
      windowEndAt: deps.windowEndAt,
      messageCount: deps.messages.length,
      results: [{ target: "persistent", ok: false, edited: false, rounds: 0, error, toolCalls: [] }]
    };
  }

  const targets = targetFilter ? [targetFilter] : ["persistent", "userPreferences", "yesterdaySummary"] as MemoryTarget[];
  const memorySession = deps.memorySession ?? createMemoryInductionSession(deps.sessionRoot, deps.windowEndAt, {
    name: targetFilter ? targetFilter : "run",
    windowStartAt: deps.windowStartAt,
    windowEndAt: deps.windowEndAt
  });
  const ownsMemorySession = deps.memorySession === undefined;
  for (const target of targets) {
    const result = await runSingleMemoryInductionWithRetry({ ...deps, memorySession }, target);
    results.push(result);
    if (!result.ok) {
      deps.log("warn", `Memorize ${target} failed: ${result.error ?? "unknown"}`);
      break;
    }
    deps.log("info", `Memorize ${target} completed`);
  }
  if (ownsMemorySession) {
    clearMemoryInductionSession(memorySession, startedAt, results.every((entry) => entry.ok) ? "complete" : "failed");
  }

  return {
    ok: results.length === targets.length && results.every((entry) => entry.ok),
    startedAt,
    windowStartAt: deps.windowStartAt,
    windowEndAt: deps.windowEndAt,
    messageCount: deps.messages.length,
    results
  };
}

async function runSingleMemoryInductionWithRetry(
  deps: Omit<MemorySummaryDeps, "messageStore" | "stateStore"> & {
    messages: StoredConversationMessage[];
    windowStartAt?: string;
    windowEndAt: string;
    memorySession?: MemoryInductionSession;
  },
  target: MemoryTarget
): Promise<MemoryRunResult> {
  let lastResult: MemoryRunResult | undefined;
  for (let attempt = 1; attempt <= memoryInductionMaxAttempts; attempt += 1) {
    try {
      const result = await runSingleMemoryInduction(deps, target);
      if (result.ok || attempt >= memoryInductionMaxAttempts) return result;
      lastResult = result;
      deps.log("warn", `Memorize ${target} attempt ${attempt}/${memoryInductionMaxAttempts} failed: ${result.error ?? "unknown"}, retrying`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastResult = { target, ok: false, edited: false, rounds: 0, error: message, toolCalls: [] };
      if (attempt >= memoryInductionMaxAttempts) return lastResult;
      deps.log("warn", `Memorize ${target} attempt ${attempt}/${memoryInductionMaxAttempts} failed: ${message}, retrying`);
    }
  }
  return lastResult ?? { target, ok: false, edited: false, rounds: 0, error: "unknown Memorize failure", toolCalls: [] };
}

export async function runSleepMemoryBackfill(deps: MemorySummaryDeps): Promise<{ ok: boolean; segments: number; messages: number }> {
  const allMessages = deps.messageStore.listMessagesChronological(maxMessagesPerSummary);
  const result = await runMemoryInductionForMessages({
    memoryStore: deps.memoryStore,
    promptStore: deps.promptStore,
    llm: deps.llm,
    config: deps.config,
    nowIso: deps.nowIso,
    timezone: deps.timezone,
    sessionRoot: deps.sessionRoot,
    log: deps.log,
    messages: allMessages,
    windowStartAt: allMessages[0]?.createdAt,
    windowEndAt: allMessages.at(-1)?.createdAt ?? deps.nowIso()
  });
  if (result.ok) {
    const state = deps.stateStore.read();
    deps.stateStore.write({
      ...state,
      lastBackfillAt: result.startedAt,
      lastInductionAt: allMessages.at(-1)?.createdAt ?? state.lastInductionAt,
      lastSuccessAt: deps.nowIso(),
      lastFailureAt: undefined,
      lastFailure: undefined
    });
  }
  return { ok: result.ok, segments: 1, messages: allMessages.length };
}

export function splitMessagesByLongGaps(messages: StoredConversationMessage[], gapMs = 5 * 60 * 60 * 1000): StoredConversationMessage[][] {
  const segments: StoredConversationMessage[][] = [];
  let current: StoredConversationMessage[] = [];
  let previousAt: number | undefined;
  for (const message of messages) {
    const createdAt = Date.parse(message.createdAt);
    if (current.length > 0 && previousAt !== undefined && Number.isFinite(createdAt) && createdAt - previousAt > gapMs) {
      segments.push(current);
      current = [];
    }
    current.push(message);
    if (Number.isFinite(createdAt)) previousAt = createdAt;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

export function enforceMemoryLimits(snapshot: MemorySnapshot): MemorySnapshot {
  return {
    persistent: enforceTargetLimit("persistent", snapshot.persistent),
    userPreferences: enforceTargetLimit("userPreferences", snapshot.userPreferences),
    yesterdaySummary: enforceTargetLimit("yesterdaySummary", snapshot.yesterdaySummary)
  };
}

export function buildMemoryPromptPreview(
  deps: {
    memoryStore: MemoryStore;
    prompts: MemoryInductionPrompts;
    messages: StoredConversationMessage[];
    windowStartAt?: string;
    windowEndAt: string;
    timezone: string;
    userName?: string;
    config?: Partial<MemorySummaryConfig>;
  },
  target: MemoryTarget
): MemoryPromptPreview {
  const prompts = normalizeMemoryInductionPrompts(deps.prompts);
  const promptStore = { get: () => prompts, save: () => prompts };
  const messages = buildMemoryPromptMessages({
    memoryStore: deps.memoryStore,
    promptStore,
    messages: deps.messages,
    windowStartAt: deps.windowStartAt,
    windowEndAt: deps.windowEndAt,
    timezone: deps.timezone,
    userName: deps.userName
  }, target);
  return {
    target,
    file: targetResultFiles[target],
    windowStartAt: deps.windowStartAt,
    windowEndAt: deps.windowEndAt,
    messageCount: deps.messages.length,
    request: {
      model: deps.config?.model,
      temperature: deps.config?.temperature,
      maxTokens: 8192,
      extraParams: deps.config?.extraParams,
      followupExtraParams: deps.config?.followupExtraParams,
      tools: memoryTools(),
      messages
    }
  };
}

async function runSingleMemoryInduction(
  deps: Omit<MemorySummaryDeps, "messageStore" | "stateStore"> & {
    messages: StoredConversationMessage[];
    windowStartAt?: string;
    windowEndAt: string;
    memorySession?: MemoryInductionSession;
  },
  target: MemoryTarget
): Promise<MemoryRunResult> {
  const toolCalls: MemoryRunResult["toolCalls"] = [];
  const session = deps.memorySession ?? createMemoryInductionSession(deps.sessionRoot, deps.windowEndAt, {
    name: target,
    windowStartAt: deps.windowStartAt,
    windowEndAt: deps.windowEndAt
  });
  session.activeTarget = target;
  const diaryDraftPath = target === "yesterdaySummary" ? deps.memoryStore.createDiaryDraft() : undefined;
  const promptMessages = buildMemoryPromptMessages({ ...deps, diaryDraftPath }, target, {
    includeCommonLayers: session.messages.length === 0
  });
  const messages = session.messages.length > 0
    ? [...session.messages, ...promptMessages]
    : promptMessages;
  const stageLongTerm = isLongTermMemoryTarget(target);
  let stagedLongTermContent = stageLongTerm ? deps.memoryStore.readTarget(target) : undefined;
  let edited = false;

  const readCurrentMemoryContent = (): string => {
    if (stageLongTerm) return stagedLongTermContent ?? "";
    return readMemoryTargetForRun(deps.memoryStore, target, diaryDraftPath);
  };
  const writeMemoryContentForRun = (content: string): string => {
    if (stageLongTerm) {
      stagedLongTermContent = enforceTargetLimit(target, content);
      return stagedLongTermContent;
    }
    return deps.memoryStore.writeTarget(target, content, {
      now: deps.nowIso(),
      localDate: deps.windowEndAt.slice(0, 10),
      windowStartAt: deps.windowStartAt,
      windowEndAt: deps.windowEndAt,
      diaryDraftPath
    });
  };

  const loopResult = await runLLMToolLoop({
    initialMessages: messages,
    limits: { maxRounds: memoryToolRoundLimit, maxTotalToolCalls: memoryToolRoundLimit, maxRepeatedToolCalls: 3 },
    buildRequest({ round, messages }) {
      const request = {
        model: deps.config.model,
        temperature: deps.config.temperature,
        maxTokens: 8192,
        extraParams: round === 0 ? deps.config.extraParams : deps.config.followupExtraParams,
        tools: memoryTools(),
        messages
      };
      deps.onRound?.(target, round + 1);
      session.append?.({ type: "request", round: session.roundOffset + round, request });
      return {
        agentId: "memorize",
        client: deps.llm,
        messages,
        model: deps.config.model,
        temperature: deps.config.temperature,
        maxTokens: 8192,
        extraParams: round === 0 ? deps.config.extraParams : deps.config.followupExtraParams,
        toolNames: [...memoryToolNames],
        stream: deps.config.stream === true,
        metadata: { target }
      };
    },
    sendRequest: deps.llmRequestSender ?? createMemoryLocalLLMRequestSender(deps.llm),
    afterRequest({ round, result }) {
      session.append?.({ type: "response", round: session.roundOffset + round, response: result });
    },
    beforeTool({ round, call }) {
      deps.onRound?.(target, round + 1, call.function.name);
    },
    executeTool(call): LLMToolLoopExecution {
      const input = parsePromptToolArguments(call.function.arguments);
      if (call.function.name === "read_memory") {
        const output = formatReadMemoryResult(target, readCurrentMemoryContent());
        toolCalls.push({ name: "read_memory", file: targetResultFiles[target], input, ok: true, output });
        return { message: { role: "tool", name: "read_memory", toolCallId: call.id, content: output } };
      }
      if (call.function.name === "self_talk") {
        const content = typeof input.content === "string" ? input.content : "";
        const output = `你听到自己说:\n${content}`;
        toolCalls.push({ name: "self_talk", file: targetResultFiles[target], input, ok: true, output });
        return { message: { role: "tool", name: "self_talk", toolCallId: call.id, content: output } };
      }
      if (call.function.name === "apply_patch") {
        const patch = typeof input.patch === "string" ? input.patch : undefined;
        if (patch === undefined) {
          toolCalls.push({ name: "apply_patch", file: targetResultFiles[target], input, ok: false, error: "patch must be a string" });
          return { message: { role: "tool", name: "apply_patch", toolCallId: call.id, content: "error: patch must be a string" } };
        }
        let nextContent: string;
        try {
          nextContent = applyMemoryPatch(readCurrentMemoryContent(), patch);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid patch";
          toolCalls.push({ name: "apply_patch", file: targetResultFiles[target], input: { patch }, ok: false, error: message });
          return { message: { role: "tool", name: "apply_patch", toolCallId: call.id, content: `error: ${message}` } };
        }
        const written = writeMemoryContentForRun(nextContent);
        const writeMode = stageLongTerm ? "staged" : "wrote";
        const output = `ok: ${writeMode} ${targetResultFiles[target]}${diaryDraftPath ? " draft" : ""}, ${lineCount(written)} line(s), ${utf8ByteLength(written)} byte(s)`;
        toolCalls.push({ name: "apply_patch", file: targetResultFiles[target], input: { patch }, ok: true, output });
        edited = true;
        return { message: { role: "tool", name: "apply_patch", toolCallId: call.id, content: output } };
      }
      const error = `unknown tool: ${call.function.name}`;
      toolCalls.push({ name: call.function.name, file: targetResultFiles[target], input, ok: false, error });
      return { message: { role: "tool", name: call.function.name, toolCallId: call.id, content: `error: ${error}` } };
    },
    onMessagesChanged({ messages }) {
      session.messages = messages;
      session.append?.({ type: "final_messages", messages });
    }
  });
  session.roundOffset += loopResult.rounds;
  if (!session.completedTargets.includes(target)) session.completedTargets.push(target);
  session.activeTarget = undefined;

  if (loopResult.stopReason === "completed") {
    if (stageLongTerm && edited && stagedLongTermContent !== undefined) {
      deps.memoryStore.writeTarget(target, stagedLongTermContent, {
        now: deps.nowIso(),
        localDate: deps.windowEndAt.slice(0, 10),
        windowStartAt: deps.windowStartAt,
        windowEndAt: deps.windowEndAt
      });
    }
    if (diaryDraftPath && edited) {
      const written = deps.memoryStore.commitDiaryDraft(diaryDraftPath, {
        now: deps.nowIso(),
        localDate: deps.windowEndAt.slice(0, 10),
        windowStartAt: deps.windowStartAt,
        windowEndAt: deps.windowEndAt
      });
      session.append?.({
        type: "diary_commit",
        file: targetResultFiles[target],
        draftPath: diaryDraftPath,
        lines: lineCount(written),
        bytes: utf8ByteLength(written)
      });
    } else {
      cleanupDiaryDraft(diaryDraftPath);
    }
    return { target, ok: true, edited, rounds: loopResult.rounds, toolCalls, response: loopResult.finalResult?.message };
  }

  cleanupDiaryDraft(diaryDraftPath);
  return {
    target,
    ok: false,
    edited,
    rounds: loopResult.rounds,
    error: "model did not finish memory induction within tool round limit",
    toolCalls,
    response: loopResult.finalResult?.message
  };
}

function buildMemoryPromptMessages(
  deps: {
    memoryStore: MemoryStore;
    promptStore: Pick<MemoryInductionPromptStore, "get">;
    messages: StoredConversationMessage[];
    windowStartAt?: string;
    windowEndAt: string;
    timezone: string;
    userName?: string;
    diaryDraftPath?: string;
  },
  target: MemoryTarget,
  options?: { includeCommonLayers?: boolean }
): LLMMessage[] {
  const variables = memoryPromptVariables(deps, target);
  const layers = memoryPromptLayers(deps.promptStore.get(), target, options);
  const messages: LLMMessage[] = [];
  for (const layer of layers) {
    const message = promptLayerToMessage(layer, variables, {
      defaultToolName: "read_memory",
      toolCallIdPrefix: "memory_prompt",
      allowedToolNames: ["read_memory", "self_talk"]
    });
    messages.push(message);
    if (layer.role !== "tool_request") continue;
    const call = message.toolCalls?.[0];
    if (!call) continue;
    messages.push({
      role: "tool",
      name: call.function.name,
      toolCallId: call.id,
      content: memoryPromptToolResult(deps, target, call.function.name, call.function.arguments)
    });
  }
  return messages;
}

function memoryPromptLayers(
  prompts: MemoryInductionPrompts,
  target: MemoryTarget,
  options?: { includeCommonLayers?: boolean }
): MemoryPromptLayer[] {
  const targetLayers = target === "persistent"
    ? prompts.persistentLayers
    : target === "userPreferences"
      ? prompts.userPreferencesLayers
      : prompts.yesterdaySummaryLayers;
  const sortEnabled = (layers: MemoryPromptLayer[]) => layers
    .filter((item) => item.enabled !== false)
    .sort((left, right) => left.order - right.order);
  return [
    ...(options?.includeCommonLayers === false ? [] : sortEnabled(prompts.commonLayers)),
    ...sortEnabled(targetLayers)
  ];
}

function memoryPromptToolResult(
  deps: { memoryStore: MemoryStore; diaryDraftPath?: string },
  target: MemoryTarget,
  toolName: string,
  rawArguments = "{}"
): string {
  if (toolName === "self_talk") {
    const input = parsePromptToolArguments(rawArguments);
    const content = typeof input.content === "string" ? input.content : "";
    return `你听到自己说:\n${content}`;
  }
  if (toolName !== "read_memory") return `error: unsupported prompt tool ${toolName}`;
  return formatReadMemoryResult(target, readMemoryTargetForRun(deps.memoryStore, target, deps.diaryDraftPath));
}

function formatReadMemoryResult(target: MemoryTarget, content: string): string {
  const file = targetResultFiles[target];
  return [
    `<${file}>`,
    content.trimEnd(),
    `</${file}>`,
    `${lineCount(content)} line(s), ${utf8ByteLength(content)} byte(s)`
  ].join("\n");
}

function readMemoryTargetForRun(memoryStore: MemoryStore, target: MemoryTarget, diaryDraftPath?: string): string {
  if (target === "yesterdaySummary" && diaryDraftPath) return readFile(diaryDraftPath);
  return memoryStore.readTarget(target);
}

function isLongTermMemoryTarget(target: MemoryTarget): target is "persistent" | "userPreferences" {
  return target === "persistent" || target === "userPreferences";
}

function cleanupDiaryDraft(draftPath?: string): void {
  if (!draftPath) return;
  try {
    if (fs.existsSync(draftPath)) fs.rmSync(draftPath);
  } catch {
    // Temp draft cleanup is best-effort.
  }
}

function memoryPromptVariables(
  deps: {
    messages: StoredConversationMessage[];
    windowStartAt?: string;
    windowEndAt: string;
    timezone: string;
    userName?: string;
    memoryStore: MemoryStore;
    diaryDraftPath?: string;
  },
  target: MemoryTarget
): LLMTextVariables {
  const currentContent = readMemoryTargetForRun(deps.memoryStore, target, deps.diaryDraftPath);
  const limits = memoryFileLimits[target];
  const snapshot = deps.memoryStore.read();
  const memoryVariables = {
    persistent: {
      content: snapshot.persistent,
      limit: memoryLimitVariables("persistent")
    },
    userPreferences: {
      content: snapshot.userPreferences,
      limit: memoryLimitVariables("userPreferences")
    },
    yesterdaySummary: {
      content: snapshot.yesterdaySummary,
      limit: memoryLimitVariables("yesterdaySummary")
    }
  };
  const localDate = deps.windowEndAt.slice(0, 10);
  const localTime = deps.windowEndAt.match(/T(\d{2}:\d{2}:\d{2})/)?.[1] ?? "";
  const userName = deps.userName?.trim() || "user";
  return buildLLMTextVariables({
    userName,
    memory: snapshot,
    extra: {
      date: localDate,
      time: localTime,
      timezone: deps.timezone,
      memory: memoryVariables,
      memorize: {
        target: {
          key: target,
          title: targetTitles[target],
          fileName: target === "yesterdaySummary" ? "diary.sqlite" : targetFiles[target],
          currentContent: currentContent || ""
        },
        limit: {
          lines: limits.lines,
          bytes: limits.bytes,
          kib: Math.round(limits.bytes / 1024)
        },
        window: {
          startAt: deps.windowStartAt ?? "(beginning)",
          endAt: deps.windowEndAt
        },
        timezone: deps.timezone,
        messages: {
          count: deps.messages.length,
          content: formatCheckChatMessages(deps.messages, {
            timeZone: deps.timezone,
            userName
          })
        }
      }
    }
  });
}

function memoryLimitVariables(target: MemoryTarget): LLMTextVariables {
  const limit = memoryFileLimits[target];
  return {
    lines: limit.lines,
    bytes: limit.bytes,
    kib: Math.round(limit.bytes / 1024)
  };
}

export const memoryToolNames = ["read_memory", "self_talk", "apply_patch"] as const;

export function memoryToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "read_memory",
      description: "读取当前归纳任务绑定的记忆文件",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: "self_talk",
      description: "对自己说话",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "对自己说的话"
          }
        },
        required: ["content"],
        additionalProperties: false
      }
    },
    {
      name: "apply_patch",
      description: "把 unified diff patch 应用到当前归纳任务绑定的记忆文件",
      inputSchema: {
        type: "object",
        properties: {
          patch: {
            type: "string",
            description: "针对当前文件内容的 unified diff patch，例如包含 ---/+++ 与 @@ hunk 的补丁文本。"
          }
        },
        required: ["patch"],
        additionalProperties: false
      }
    }
  ];
}

function memoryTools(): LLMToolSpec[] {
  return memoryToolDefinitions().map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

function createMemoryLocalLLMRequestSender(llm: LLMClient | undefined): LLMRequestSender {
  return async (input) => {
    if (!llm) throw new Error("missing Memorize API preset or API key");
    const request = {
      messages: input.messages,
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      extraParams: input.extraParams,
      tools: memoryTools()
    };
    return input.stream === true && llm.chatStream
      ? llm.chatStream(request, input.streamHandlers)
      : llm.chat(request);
  };
}

function applyMemoryPatch(content: string, patch: string): string {
  const original = splitPatchContentLines(content);
  const output: string[] = [];
  const patchLines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let patchIndex = 0;
  let originalIndex = 0;
  let sawHunk = false;

  while (patchIndex < patchLines.length) {
    const header = patchLines[patchIndex];
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (!match) {
      patchIndex += 1;
      continue;
    }
    sawHunk = true;
    const oldStart = Number(match[1]);
    const hunkStart = oldStart === 0 ? 0 : oldStart - 1;
    if (hunkStart < originalIndex || hunkStart > original.length) {
      throw new Error("invalid patch hunk range");
    }
    output.push(...original.slice(originalIndex, hunkStart));
    originalIndex = hunkStart;
    patchIndex += 1;

    while (patchIndex < patchLines.length && !patchLines[patchIndex].startsWith("@@ ")) {
      const line = patchLines[patchIndex];
      patchIndex += 1;
      if (line === "\\ No newline at end of file") continue;
      if (line.length === 0 && patchIndex >= patchLines.length) break;
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " ") {
        assertPatchLine(original, originalIndex, text);
        output.push(text);
        originalIndex += 1;
        continue;
      }
      if (marker === "-") {
        assertPatchLine(original, originalIndex, text);
        originalIndex += 1;
        continue;
      }
      if (marker === "+") {
        output.push(text);
        continue;
      }
      throw new Error("invalid patch line");
    }
  }

  if (!sawHunk) throw new Error("patch must include at least one unified diff hunk");
  output.push(...original.slice(originalIndex));
  return output.length > 0 ? `${normalizeCommonHalfwidthCharacters(output.join("\n"))}\n` : "";
}

function splitPatchContentLines(content: string): string[] {
  if (!content) return [];
  return content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
}

function assertPatchLine(original: string[], index: number, expected: string): void {
  const actual = original[index];
  if (actual === expected) return;
  if (normalizeCommonHalfwidthCharacters(actual) === normalizeCommonHalfwidthCharacters(expected)) return;
  throw new Error("patch does not apply to current memory content");
}

export function normalizeCommonHalfwidthCharacters(text: string): string {
  return Array.from(text, (char) => commonHalfwidthNormalizationMap[char] ?? char).join("");
}

function enforceTargetLimit(target: MemoryTarget, text: string): string {
  const limit = memoryFileLimits[target];
  let output = text.split(/\r?\n/).slice(0, limit.lines).join("\n").trim();
  while (utf8ByteLength(output) > limit.bytes) {
    const next = output.split(/\r?\n/).slice(0, -1).join("\n").trim();
    if (!next || next === output) break;
    output = next;
  }
  while (utf8ByteLength(output) > limit.bytes && output.length > 0) output = output.slice(0, -1);
  return output ? `${output}\n` : "";
}

function readMemoryInductionPrompts(filePath: string): MemoryInductionPrompts {
  if (!fs.existsSync(filePath)) return defaultMemoryInductionPrompts();
  try {
    return normalizeMemoryInductionPrompts(JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<MemoryInductionPrompts>);
  } catch {
    return defaultMemoryInductionPrompts();
  }
}

function writeMemoryInductionPrompts(filePath: string, prompts: MemoryInductionPrompts): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeAtomic(filePath, `${JSON.stringify(prompts, null, 2)}\n`);
}

function normalizeMemoryInductionPrompts(value: Partial<MemoryInductionPrompts>): MemoryInductionPrompts {
  const fallback = defaultMemoryInductionPrompts();
  return {
    commonLayers: normalizePromptLayers(value.commonLayers, fallback.commonLayers),
    persistentLayers: normalizePromptLayers(value.persistentLayers, fallback.persistentLayers),
    userPreferencesLayers: normalizePromptLayers(value.userPreferencesLayers, fallback.userPreferencesLayers),
    yesterdaySummaryLayers: normalizePromptLayers(value.yesterdaySummaryLayers, fallback.yesterdaySummaryLayers)
  };
}

function layer(id: string, title: string, role: MemoryPromptLayer["role"], order: number, content: string): MemoryPromptLayer {
  return { id, title, role, enabled: true, order, content };
}

function readFile(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

function createOptionalDiaryStore(root: string): DiaryStore {
  return createDiaryStore(path.join(root, "diary", "diary.sqlite"));
}

function ensureGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (!fs.existsSync(path.join(dir, ".git"))) {
      gitExecFileSync(["init"], { cwd: dir });
    }
    gitExecFileSync(["config", "user.name", "Alice Memorize"], { cwd: dir });
    gitExecFileSync(["config", "user.email", "alice-memorize@example.local"], { cwd: dir });
  } catch {
    // Git history is best-effort; the memory files still remain readable.
  }
}

function commitLongTermMemory(root: string, target: MemoryTarget, fileName: string): void {
  const dir = path.join(root, "long-term-memory");
  try {
    gitExecFileSync(["add", fileName], { cwd: dir });
    const status = gitExecFileSync(["status", "--porcelain", "--", fileName], { cwd: dir, encoding: "utf8" });
    if (!status.trim()) return;
    gitExecFileSync(["commit", "-m", `memorize ${target}`], { cwd: dir });
  } catch {
    // Keep the write path non-fatal if git is unavailable or not configured.
  }
}

function commitLongTermMemoryBaseline(root: string): void {
  const dir = path.join(root, "long-term-memory");
  try {
    gitExecFileSync(["add", targetFiles.persistent, targetFiles.userPreferences], { cwd: dir });
    const status = gitExecFileSync(["status", "--porcelain", "--", targetFiles.persistent, targetFiles.userPreferences], { cwd: dir, encoding: "utf8" });
    if (!status.trim()) return;
    gitExecFileSync(["commit", "-m", "memory baseline"], { cwd: dir });
  } catch {
    // Keep the write path non-fatal if git is unavailable or not configured.
  }
}

function gitExecFileSync(args: string[], options: { cwd: string; encoding?: BufferEncoding }): string {
  const result = childProcess.spawnSync("git", args, {
    cwd: options.cwd,
    encoding: options.encoding ?? "utf8"
  });
  if (result.status !== 0) {
    const error = new Error(result.stderr?.toString() || result.error?.message || `git ${args.join(" ")} failed`);
    (error as Error & { status?: number }).status = result.status ?? undefined;
    throw error;
  }
  return result.stdout?.toString() ?? "";
}

export function createMemoryInductionSession(
  root: string | undefined,
  time: string,
  options: { name: string; windowStartAt?: string; windowEndAt: string }
): MemoryInductionSession {
  const session: MemoryInductionSession = {
    messages: [],
    roundOffset: 0,
    completedTargets: []
  };
  if (!root) return session;
  const logger = createLLMSessionTranscriptLogger({
    root,
    time,
    namespace: "memorize",
    name: options.name,
    metadata: (state) => {
      const last = state.messages.at(-1);
      return {
        type: "llm_session",
        schemaVersion: 1,
        sessionId: memorySessionId(root, state.filePath),
        agent: "memorize",
        target: session.activeTarget,
        targets: session.completedTargets,
        windowStartAt: options.windowStartAt,
        windowEndAt: options.windowEndAt,
        startedAt: time,
        updatedAt: state.updatedAt,
        requestCount: state.requestCount,
        responseCount: state.responseCount,
        currentRound: state.currentRound,
        latestRequest: state.latestRequest,
        latestResponse: state.latestResponse,
        messageCount: state.messages.length,
        lastMessageRole: last?.role,
        lastMessageAt: state.updatedAt,
        mode: "memorize",
        clearedAt: session.clearedAt,
        clearReason: session.clearReason
      };
    }
  });
  session.append = logger.append;
  return session;
}

export function clearMemoryInductionSession(session: MemoryInductionSession | undefined, time: string, reason: string): void {
  if (!session || session.clearedAt) return;
  session.clearedAt = time;
  session.clearReason = reason;
  session.activeTarget = undefined;
  session.append?.({ type: "final_messages", messages: session.messages });
}

function memorySessionId(root: string, filePath: string): string {
  return `memorize:${relativeLLMSessionPath(root, filePath)}`;
}

function normalizeSleepMemoryState(value: SleepMemoryState): SleepMemoryState {
  return {
    lastInductionAt: stringValue(value.lastInductionAt),
    currentInductionAt: stringValue(value.currentInductionAt),
    lastBackfillAt: stringValue(value.lastBackfillAt),
    lastSuccessAt: stringValue(value.lastSuccessAt),
    lastFailureAt: stringValue(value.lastFailureAt),
    lastFailure: stringValue(value.lastFailure)
  };
}

function lineCount(text: string): number {
  return text.trim() ? text.trim().split(/\r?\n/).length : 0;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
