import type { MemorySummaryConfig } from './contracts/memory-config.js';
import type { DiaryStore, SleepBoundary } from '../../../platform/storage/src/diary-store.js';
import type { StoredConversationMessage } from '../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js';
import type { LLMChatResult, LLMClient, LLMMessage, LLMToolSpec } from '../../../contexts/llm-gateway/src/index.js';
import type { LLMRequestSender } from '../../../contexts/llm-gateway/src/llm-tool-loop.js';
import type { PromptContextRuntime } from '../../../contexts/prompt-context/src/index.js';
import type { PromptLayer } from '../../../contexts/agent-profile/src/domain/prompt-layer.js';
import type { BashSandboxConfig, BashSandboxRuntime } from '../../../contexts/bash-sandbox/src/index.js';

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
  sandbox?: {
    config: BashSandboxConfig;
    runtime: BashSandboxRuntime;
  };
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

export const targetFiles: Record<MemoryTarget, string> = {
  persistent: "persistent-memory.md",
  userPreferences: "user-preferences.md",
  yesterdaySummary: "diary.md"
};

export type MemoryResultFile = "persistent-memory" | "user-preferences" | "diary";

export const targetResultFiles: Record<MemoryTarget, MemoryResultFile> = {
  persistent: "persistent-memory",
  userPreferences: "user-preferences",
  yesterdaySummary: "diary"
};

export const targetDirectories: Record<MemoryTarget, string> = {
  persistent: "long-term-memory",
  userPreferences: "long-term-memory",
  yesterdaySummary: "diary"
};

export const maxMessagesPerSummary = 10_000;
export const memoryToolRoundLimit = 30;
