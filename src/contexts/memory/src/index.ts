import type { MemorySummaryConfig } from "./contracts/memory-config.js";
import { createDiaryStore, type DiaryStore, type SleepBoundary } from "../../../platform/storage/src/diary-store.js";
import * as sqlite from "../../../platform/storage/src/sqlite-compat.js";
import type { StoredConversationMessage } from "../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { ToolDefinition, ToolPlugin } from "../../agent-loop/src/contracts/agent-contracts.js";
import type { LLMChatResult, LLMClient, LLMMessage, LLMToolSpec } from "../../../contexts/llm-gateway/src/index.js";
import type { PromptContextRuntime } from "../../../contexts/prompt-context/src/index.js";
import { formatZonedIso, parseZonedIso } from "../../../platform/time/src/index.js";
import { createLLMSessionTranscriptLogger } from "../../llm-session/src/adapters/jsonl-llm-session-log.js";
import { registerLLMToolLoopTools, runLLMToolLoop, type LLMRequestSender } from "../../../contexts/llm-gateway/src/llm-tool-loop.js";
import { normalizePromptLayers, parsePromptToolArguments, promptLayerToMessage, type PromptLayer } from "../../../contexts/agent-profile/src/domain/prompt-layer.js";

const fs = await import("node:fs");
const path = await import("node:path");
const childProcess = await import("node:child_process");
let memoryToolRegistrySeq = 0;

export type MemoryTarget = "persistent" | "userPreferences" | "yesterdaySummary";

export type MemorySnapshot = {
  persistent: string;
  userPreferences: string;
  yesterdaySummary: string;
};

export type MemoryFileStats = {
  target: MemoryTarget;
  fileName: string;
  tableName: string;
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
  deleteLatestEntry?(target: MemoryTarget): { id: number; target: MemoryTarget; localDate?: string; content: string } | undefined;
  deleteLatestDiaryEntry?(): { id: number; localDate: string; content: string } | undefined;
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
  promptContextRuntime: PromptContextRuntime;
  stateStore: SleepMemoryStateStore;
  diaryStore?: Pick<DiaryStore, "listSleepBoundaries" | "recordSleepBoundary">;
  messageStore: {
    listMessagesByCreatedAtRange(startAt: string | undefined, endAt: string, limit?: number): StoredConversationMessage[];
    listMessagesChronological(limit?: number): StoredConversationMessage[];
  };
  llm?: LLMClient;
  llmRequestSender?: LLMRequestSender;
  config: MemorySummaryConfig;
  nowIso(): string;
  timezone: string;
  userName?: string;
  sessionRoot?: string;
  onRound?(target: MemoryTarget, rounds: number, status?: string): void;
  log(level: "info" | "warn" | "error", message: string): void;
};

export type MemorySleepWindow = {
  date: string;
  startAt?: string;
  endAt: string;
  startAtUtc?: string;
  endAtUtc?: string;
  source: SleepBoundary["source"] | "calendar";
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
  generatedAt: string;
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
  yesterdaySummary: "diary.md"
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

const maxMessagesPerSummary = 10_000;
const memoryToolRoundLimit = 30;
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
  const longTermDbPath = memoryDatabasePath(root);
  let longTermDb: any | undefined;

  function db(): any {
    if (!longTermDb) {
      fs.mkdirSync(path.dirname(longTermDbPath), { recursive: true });
      longTermDb = new sqlite.DatabaseSync(longTermDbPath);
      longTermDb.exec("PRAGMA journal_mode = WAL");
      initializeLongTermMemoryDb(longTermDb);
    }
    return longTermDb;
  }

  function latestDiaryContent(): string {
    thisEnsure();
    const row = db().prepare(`
      SELECT content
      FROM diary_entries
      ORDER BY local_date DESC, id DESC
      LIMIT 1
    `).get() as { content?: string } | undefined;
    return row?.content ?? "";
  }

  function upsertDiaryContent(content: string, options?: MemoryWriteOptions): string {
    const limited = enforceTargetLimit("yesterdaySummary", content);
    const localDate = options?.localDate ?? options?.windowEndAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
    db().prepare(`
      INSERT INTO diary_entries(local_date, content, created_at, updated_at, window_start_at, window_end_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(local_date) DO UPDATE SET
        content = excluded.content,
        updated_at = excluded.updated_at,
        window_start_at = excluded.window_start_at,
        window_end_at = excluded.window_end_at
    `).run(
      localDate,
      limited,
      options?.now ?? new Date().toISOString(),
      options?.now ?? new Date().toISOString(),
      options?.windowStartAt ?? null,
      options?.windowEndAt ?? null
    );
    return limited;
  }

  function readLongTermTarget(target: "persistent" | "userPreferences"): string {
    thisEnsure();
    const tableName = longTermTableName(target);
    const row = db().prepare(`
      SELECT content
      FROM ${tableName}
      ORDER BY id DESC
      LIMIT 1
    `).get() as { content?: string } | undefined;
    return row?.content ?? "";
  }

  function appendLongTermTarget(target: "persistent" | "userPreferences", content: string, options?: MemoryWriteOptions & { runId?: string }): string {
    const limited = enforceTargetLimit(target, content);
    const tableName = longTermTableName(target);
    db().prepare(`
      INSERT INTO ${tableName}(content, created_at, window_start_at, window_end_at, run_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      limited,
      options?.now ?? new Date().toISOString(),
      options?.windowStartAt ?? null,
      options?.windowEndAt ?? null,
      options?.runId ?? null
    );
    return limited;
  }

  function thisEnsure(): void {
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(root, "long-term-memory"), { recursive: true });
    fs.mkdirSync(path.join(root, "diary"), { recursive: true });
    fs.mkdirSync(path.join(root, "diary", "tmp"), { recursive: true });
    db();
  }

  return {
    ensure() {
      thisEnsure();
    },
    read() {
      this.ensure();
      return {
        persistent: readLongTermTarget("persistent"),
        userPreferences: readLongTermTarget("userPreferences"),
        yesterdaySummary: latestDiaryContent()
      };
    },
    readTarget(target) {
      this.ensure();
      if (target === "yesterdaySummary") return "";
      return readLongTermTarget(target);
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
        return upsertDiaryContent(limited, options);
      }
      return appendLongTermTarget(target, limited, options);
    },
    deleteLatestEntry(target) {
      this.ensure();
      const database = db();
      const entry = target === "yesterdaySummary"
        ? database.prepare(`
          SELECT id, local_date AS localDate, content
          FROM diary_entries
          ORDER BY local_date DESC, id DESC
          LIMIT 1
        `).get() as { id: number; localDate?: string; content: string } | undefined
        : database.prepare(`
          SELECT id, content
          FROM ${longTermTableName(target)}
          ORDER BY id DESC
          LIMIT 1
        `).get() as { id: number; localDate?: string; content: string } | undefined;
      if (!entry) return undefined;
      const tableName = target === "yesterdaySummary" ? "diary_entries" : longTermTableName(target);
      database.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(entry.id);
      return { ...entry, target };
    },
    deleteLatestDiaryEntry() {
      const entry = this.deleteLatestEntry?.("yesterdaySummary");
      return entry ? { id: entry.id, localDate: entry.localDate ?? "", content: entry.content } : undefined;
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
          tableName: target === "persistent"
            ? "persistent_memory_entries"
            : target === "userPreferences"
              ? "user_preferences_entries"
              : "diary_entries",
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
        "只通过 Read / self_talk 工具工作。",
        "普通回复不会保存。",
        "本轮目标：{{memorize/target/fileName}}",
        "写入边界：",
        "- 记忆：长期有效的事实、关系连续性、项目长期背景、用户明确要求长期保留的信息；不要写单日流水账。",
        "- 用户记忆：稳定偏好、语言/语气/交互方式/实现习惯/明确禁忌/长期约束；不要把一次性任务需求误判为偏好。",
        "- 日记：只基于本次聊天记录写当天日记摘要，不沿用旧日记内容。",
        currentMemoryEditInstructions()
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
        id: "common_read",
        title: "Fake Read",
        role: "tool_request",
        enabled: true,
        order: 90,
        content: "",
        toolCalls: [{
          toolName: "Read",
          toolArguments: "{\"file_path\":\"{{memorize/target/fileName}}\"}"
        }],
        thinking: "先读取长期记忆文件，保持工具上下文一致。"
      }
    ],
    persistentLayers: [],
    userPreferencesLayers: [],
    yesterdaySummaryLayers: []
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

export function listMemorySleepWindows(input: {
  diaryStore: Pick<DiaryStore, "listSleepBoundaries" | "recordSleepBoundary">;
  timeZone: string;
  messages?: StoredConversationMessage[];
  now?: () => { iso: string; utcIso?: string };
}): MemorySleepWindow[] {
  const boundaries = input.diaryStore.listSleepBoundaries();
  if (boundaries.length === 1) {
    const boundary = boundaries[0];
    const end = memoryBoundaryInstant(boundary, input.timeZone);
    return [{
      date: memorySleepBoundaryLocalDate(boundary, input.timeZone),
      endAt: formatZonedIso(end, input.timeZone),
      endAtUtc: end.toISOString(),
      source: boundary.source
    }];
  }
  return boundaries.slice(1).map((boundary, index) => {
    const previous = boundaries[index];
    const start = memoryBoundaryInstant(previous, input.timeZone);
    const end = memoryBoundaryInstant(boundary, input.timeZone);
    return {
      date: memorySleepBoundaryLocalDate(boundary, input.timeZone),
      startAt: formatZonedIso(start, input.timeZone),
      endAt: formatZonedIso(end, input.timeZone),
      startAtUtc: start.toISOString(),
      endAtUtc: end.toISOString(),
      source: boundary.source
    };
  }).reverse();
}

export function latestMemorySleepWindow(input: {
  diaryStore: Pick<DiaryStore, "listSleepBoundaries" | "recordSleepBoundary">;
  timeZone: string;
  messages?: StoredConversationMessage[];
  now?: () => { iso: string; utcIso?: string };
}): MemorySleepWindow | undefined {
  return listMemorySleepWindows(input)[0];
}

export function resolveMemorySleepWindowForDate(input: {
  diaryStore: Pick<DiaryStore, "listSleepBoundaries" | "recordSleepBoundary">;
  date: string;
  timeZone: string;
  messages?: StoredConversationMessage[];
  now?: () => { iso: string; utcIso?: string };
}): MemorySleepWindow | undefined {
  return listMemorySleepWindows(input).find((window) => window.date === input.date);
}

function memorySleepBoundaryLocalDate(boundary: SleepBoundary, timeZone: string): string {
  return formatZonedIso(memoryBoundaryInstant(boundary, timeZone), timeZone).slice(0, 10);
}

function memoryBoundaryInstant(boundary: SleepBoundary, timeZone: string): Date {
  return boundary.occurredAtUtc ? new Date(boundary.occurredAtUtc) : new Date(parseMemoryMessageCreatedAt(boundary.occurredAt, timeZone));
}

function parseMemoryMessageCreatedAt(value: string, timeZone: string): number {
  return /Z$|[+-]\d{2}:\d{2}$/.test(value) ? new Date(value).getTime() : parseZonedIso(value, timeZone).getTime();
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

  const sleepWindow = deps.diaryStore ? latestMemorySleepWindow({
    diaryStore: deps.diaryStore,
    timeZone: deps.timezone,
    messages: deps.messageStore.listMessagesChronological(10_000),
    now: () => ({ iso: deps.nowIso() })
  }) : undefined;
  if (!sleepWindow) {
    const reason = "sleep_window_not_found";
    deps.stateStore.write({
      ...existing,
      currentInductionAt,
      lastFailureAt: currentInductionAt,
      lastFailure: reason
    });
    deps.log("warn", `sleep Memorize skipped: ${reason}`);
    return false;
  }
  const windowStartAt = sleepWindow.startAt;
  const windowEndAt = sleepWindow.endAt;
  const messages = deps.messageStore.listMessagesByCreatedAtRange(windowStartAt, windowEndAt, maxMessagesPerSummary);
  if (messages.length === 0) {
    deps.stateStore.write({
      ...existing,
      currentInductionAt,
      lastInductionAt: windowEndAt,
      lastSuccessAt: currentInductionAt,
      lastFailureAt: undefined,
      lastFailure: undefined
    });
    deps.log("info", `sleep Memorize advanced without messages: window=${windowStartAt ?? "(beginning)"} -> ${windowEndAt}`);
    return true;
  }

  const result = await runMemoryInductionForMessages({
    ...deps,
    messages,
    windowStartAt,
    windowEndAt
  });
  if (result.ok) {
    deps.stateStore.write({
      ...existing,
      currentInductionAt,
      lastInductionAt: windowEndAt,
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
  const error = "Memorize temporary workspace induction has been removed";
  results.push(...targets.map((target) => ({ target, ok: false, edited: false, rounds: 0, error, toolCalls: [] })));
  for (const entry of results) {
    if (entry.ok) deps.log("info", `Memorize ${entry.target} completed`);
    else deps.log("warn", `Memorize ${entry.target} failed: ${entry.error ?? "unknown"}`);
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
    promptContextRuntime: deps.promptContextRuntime,
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
    promptContextRuntime: PromptContextRuntime;
    generatedAt?: string;
  },
  target: MemoryTarget
): MemoryPromptPreview {
  const prompts = normalizeMemoryInductionPrompts(deps.prompts);
  const promptStore = { get: () => prompts, save: () => prompts };
  const messages = buildMemoryPromptMessages({
    memoryStore: deps.memoryStore,
    promptStore,
    promptContextRuntime: deps.promptContextRuntime,
    messages: deps.messages,
    windowStartAt: deps.windowStartAt,
    windowEndAt: deps.windowEndAt,
    timezone: deps.timezone,
    userName: deps.userName
  }, target);
  return {
    target,
    file: targetResultFiles[target],
    generatedAt: deps.generatedAt ?? new Date().toISOString(),
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
  const session = deps.memorySession ?? createMemoryInductionSession(deps.sessionRoot, deps.nowIso(), {
    name: target,
    windowStartAt: deps.windowStartAt,
    windowEndAt: deps.windowEndAt,
    timezone: deps.timezone,
    nowIso: deps.nowIso
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
  const toolRegistryName = `memory_single_${memoryToolRegistrySeq += 1}_${target}`;
  const unregisterTools = registerLLMToolLoopTools(toolRegistryName, [
    createMemorySingleTargetToolPlugin({
      target,
      readCurrentMemoryContent,
      writeMemoryContentForRun,
      diaryDraftPath,
      stageLongTerm,
      toolCalls,
      setEdited() {
        edited = true;
      }
    })
  ]);

  const loopResult = await (async () => {
    try {
      return await runLLMToolLoop({
        initialMessages: messages,
        toolRegistryName,
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
            toolVariables: deps.promptContextRuntime,
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
        onMessagesChanged({ messages }) {
          session.messages = messages;
          session.append?.({ type: "final_messages", messages });
        }
      });
    } finally {
      unregisterTools();
    }
  })();
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
    promptContextRuntime: PromptContextRuntime;
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
  const layers = memoryPromptLayers(deps.promptStore.get(), target, options);
  const messages: LLMMessage[] = [];
  for (const layer of layers) {
    const message = promptLayerToMessage(layer, deps.promptContextRuntime, {
      defaultToolName: "Read",
      toolCallIdPrefix: "memory_prompt",
      allowedToolNames: ["Read", "self_talk"]
    });
    messages.push(message);
    if (layer.role !== "tool_request") continue;
    for (const call of message.toolCalls ?? []) {
      messages.push({
        role: "tool",
        name: call.function.name,
        toolCallId: call.id,
        content: memoryPromptToolResult(deps, target, call.function.name, call.function.arguments)
      });
    }
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
    return `爱丽丝听到自己说:\n${content}`;
  }
  if (toolName !== "Read") return `error: unsupported prompt tool ${toolName}`;
  return formatReadMemoryResult(target, readMemoryTargetForRun(deps.memoryStore, target, deps.diaryDraftPath));
}

function formatReadMemoryResult(target: MemoryTarget, content: string): string {
  const file = targetResultFiles[target];
  return [
    `<${file}>`,
    content.endsWith("\n") ? content.slice(0, -1) : content,
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

export const memoryToolNames = ["Read", "self_talk"] as const;

function currentMemoryEditInstructions(): string {
  return [
    "记忆工具规则：",
    "- Read({ file_path, offset?, limit? }) 读取当前记忆目标。",
    "- self_talk({ content }) 记录中间思考。"
  ].join("\n");
}

export function memoryToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "Read",
      description: "Read the current memory file.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" }
        },
        required: ["file_path"],
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
    }
  ];
}

function createMemorySingleTargetToolPlugin(input: {
  target: MemoryTarget;
  readCurrentMemoryContent(): string;
  writeMemoryContentForRun(content: string): string;
  diaryDraftPath?: string;
  stageLongTerm: boolean;
  toolCalls: MemoryRunResult["toolCalls"];
  setEdited(): void;
}): ToolPlugin {
  return {
    id: `memory_${input.target}`,
    listTools: () => memorySingleTargetToolDefinitions(),
    async execute(call) {
      if (call.toolName === "Read") {
        const output = formatReadMemoryResult(input.target, input.readCurrentMemoryContent());
        input.toolCalls.push({ name: "Read", file: targetResultFiles[input.target], input: call.input, ok: true, output });
        return { callId: call.id, ok: true, output };
      }
      if (call.toolName === "self_talk") {
        const content = typeof call.input.content === "string" ? call.input.content : "";
        const output = `爱丽丝听到自己说:\n${content}`;
        input.toolCalls.push({ name: "self_talk", file: targetResultFiles[input.target], input: call.input, ok: true, output });
        return { callId: call.id, ok: true, output };
      }
      throw new Error(`unknown tool: ${call.toolName}`);
    }
  };
}

function memorySingleTargetToolDefinitions(): ToolDefinition[] {
  return memoryToolDefinitions();
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

function initializeLongTermMemoryDb(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS persistent_memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      window_start_at TEXT,
      window_end_at TEXT,
      run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS persistent_memory_entries_latest_idx
      ON persistent_memory_entries(id DESC);
    CREATE TABLE IF NOT EXISTS user_preferences_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      window_start_at TEXT,
      window_end_at TEXT,
      run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS user_preferences_entries_latest_idx
      ON user_preferences_entries(id DESC);
    CREATE TABLE IF NOT EXISTS diary_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_date TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      window_start_at TEXT,
      window_end_at TEXT
    );
    CREATE INDEX IF NOT EXISTS diary_entries_local_date_idx ON diary_entries(local_date);
    CREATE TABLE IF NOT EXISTS sleep_boundaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL UNIQUE,
      occurred_at_utc TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_utc TEXT
    );
    CREATE INDEX IF NOT EXISTS sleep_boundaries_occurred_at_idx ON sleep_boundaries(occurred_at);
    CREATE INDEX IF NOT EXISTS sleep_boundaries_occurred_at_utc_idx ON sleep_boundaries(occurred_at_utc);
    CREATE TABLE IF NOT EXISTS sleep_preparation_boundaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      occurred_at_utc TEXT,
      created_at TEXT NOT NULL,
      created_at_utc TEXT
    );
    CREATE INDEX IF NOT EXISTS sleep_preparation_boundaries_occurred_at_idx ON sleep_preparation_boundaries(occurred_at);
    CREATE INDEX IF NOT EXISTS sleep_preparation_boundaries_occurred_at_utc_idx ON sleep_preparation_boundaries(occurred_at_utc);
    CREATE TABLE IF NOT EXISTS wake_boundaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL UNIQUE,
      occurred_at_utc TEXT,
      created_at TEXT NOT NULL,
      created_at_utc TEXT
    );
    CREATE INDEX IF NOT EXISTS wake_boundaries_occurred_at_idx ON wake_boundaries(occurred_at);
    CREATE INDEX IF NOT EXISTS wake_boundaries_occurred_at_utc_idx ON wake_boundaries(occurred_at_utc);
  `);
}

function longTermTableName(target: "persistent" | "userPreferences"): "persistent_memory_entries" | "user_preferences_entries" {
  return target === "persistent" ? "persistent_memory_entries" : "user_preferences_entries";
}

export function memoryDatabasePath(root: string): string {
  return path.join(root, "alice.sqlite");
}

export function createMemoryDiaryStore(root: string): DiaryStore {
  createMarkdownMemoryStore(root).ensure();
  return createDiaryStore(memoryDatabasePath(root));
}

function sanitizeRunId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120) || "run";
}

function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

function createOptionalDiaryStore(root: string): DiaryStore {
  return createMemoryDiaryStore(root);
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
    if (isLongTermMemoryGitOperationInProgress(dir)) return;
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
    if (isLongTermMemoryGitOperationInProgress(dir)) return;
    gitExecFileSync(["add", targetFiles.persistent, targetFiles.userPreferences], { cwd: dir });
    const status = gitExecFileSync(["status", "--porcelain", "--", targetFiles.persistent, targetFiles.userPreferences], { cwd: dir, encoding: "utf8" });
    if (!status.trim()) return;
    gitExecFileSync(["commit", "-m", "memory baseline"], { cwd: dir });
  } catch {
    // Keep the write path non-fatal if git is unavailable or not configured.
  }
}

function isLongTermMemoryGitOperationInProgress(dir: string): boolean {
  const gitDir = path.join(dir, ".git");
  return [
    "MERGE_HEAD",
    "REVERT_HEAD",
    "CHERRY_PICK_HEAD",
    "REBASE_HEAD",
    "rebase-merge",
    "rebase-apply"
  ].some((name) => fs.existsSync(path.join(gitDir, name)));
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
  options: { name: string; windowStartAt?: string; windowEndAt: string; timezone: string; nowIso: () => string }
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
    timeUtc: parseZonedIso(time, options.timezone).toISOString(),
    now: () => {
      const current = options.nowIso();
      return { time: current, timeUtc: parseZonedIso(current, options.timezone).toISOString() };
    },
    namespace: "memorize",
    name: options.name,
    metadata: (state) => {
      const last = state.messages.at(-1);
      return {
        type: "llm_session",
        schemaVersion: 1,
        sessionId: Date.parse(state.startedAtUtc ?? time),
        sessionCreatedAtUtc: state.startedAtUtc,
        agent: "memorize",
        target: session.activeTarget,
        targets: session.completedTargets,
        windowStartAt: options.windowStartAt,
        windowEndAt: options.windowEndAt,
        startedAt: time,
        startedAtUtc: state.startedAtUtc,
        updatedAt: state.updatedAt,
        updatedAtUtc: state.updatedAtUtc,
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
        clearedAtUtc: session.clearedAt ? parseZonedIso(session.clearedAt, options.timezone).toISOString() : undefined,
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
