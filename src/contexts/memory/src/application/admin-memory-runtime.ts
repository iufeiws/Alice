import { formatCheckChatMessages } from "../../../../capabilities/tools/messaging/src/index.js";
import { createLLMClientFromPreset } from "../../../llm-gateway/src/llm-api-profile.js";
import type { PromptContextRuntime } from "../../../prompt-context/src/index.js";
import type { BashSandboxConfig, BashSandboxRuntime } from "../../../bash-sandbox/src/index.js";
import type { MemorySummaryConfig } from "../contracts/memory-config.js";
import {
  buildMemoryPromptPreview,
  latestMemorySleepWindow,
  listMemorySleepWindows,
  resolveMemorySleepWindowForDate,
  runMemoryInductionForMessages,
  type MemoryInductionPromptStore,
  type MemoryRunSummary,
  type MemorySleepWindow,
  type MemoryStore,
  type MemoryTarget
} from "../memory.js";
import { targetFiles } from "../model.js";

const fs = await import("node:fs");
const path = await import("node:path");
const childProcess = await import("node:child_process");

export type MemoryAdminLLMApiPreset = {
  name: string;
  baseURL: string;
  apiKey?: string;
  model: string;
  temperature: number;
  maxTokens?: number;
  timeoutMs: number;
  stream: boolean;
  extraParams: Record<string, unknown>;
  followupExtraParams: Record<string, unknown>;
};

type MemoryRunProgress = {
  id: string;
  date: string;
  target?: MemoryTarget;
  status: "running" | "complete" | "failed" | "rejected";
  rounds: Partial<Record<MemoryTarget, number>>;
  tools: Partial<Record<MemoryTarget, string>>;
  roundStartedAt: Partial<Record<MemoryTarget, string>>;
  updatedAt: string;
};

type MemoryAdminRuntimeInput = {
  config: {
    project: { username: string };
    memoryFiles: { root: string };
    memorySummary: MemorySummaryConfig;
    bashSandbox?: BashSandboxConfig;
  };
  store?: {
    listMessagesByCreatedAtRange?(startAt: string | undefined, endAt: string, limit?: number): any[];
    listMessagesChronological?(limit?: number): any[];
  };
  memoryStore: MemoryStore;
  diaryStore: any;
  memoryInductionPromptStore: MemoryInductionPromptStore;
  promptContextRuntime: PromptContextRuntime;
  sandbox?: {
    config: BashSandboxConfig;
    runtime: BashSandboxRuntime;
  };
  agentState: { getSnapshot(): { state: string } };
  isHeartbeatPaused?: () => boolean;
  time: { timeZone: string; now(): { iso: string; date: Date } };
  llmRequests: { send(input: any): Promise<any> };
  llmSessionRoot(): string;
  ensureMemoryConsoleSession(windowEndAt: string, windowStartAt?: string): any;
  resolveMemorizeApiPreset(): MemoryAdminLLMApiPreset | undefined;
  runMemoryInductionForMessages?(
    messages: any[],
    windowStartAt: string | undefined,
    windowEndAt: string,
    apiPreset: MemoryAdminLLMApiPreset,
    target?: MemoryTarget,
    onRound?: (target: MemoryTarget, rounds: number, status?: string) => void
  ): Promise<MemoryRunSummary>;
  appendLog(level: "info" | "warn" | "error", message: string): void;
};

export function createAdminMemoryRuntime(input: MemoryAdminRuntimeInput) {
  const memoryRunProgress = new Map<string, MemoryRunProgress>();
  let memoryAdminRunActive = false;

  return {
    listSleepDays,
    saveFile,
    listDayMessages,
    runDay,
    runTarget,
    getRunProgress,
    undoLastGitCommit,
    redoLastGitCommit,
    deleteLatestSqlRecord,
    previewPrompts
  };

  function listSleepDays(): MemorySleepWindow[] {
    return ensureMemorySleepBoundaries();
  }

  function saveFile(target: MemoryTarget, content: string) {
    input.memoryStore.writeTarget(target, content);
    input.appendLog("info", `memory file saved: ${target}`);
    return { ok: true, files: input.memoryStore.stats() };
  }

  function listDayMessages(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { status: 400, body: { ok: false, error: "invalid_date" } };
    if (!input.store?.listMessagesByCreatedAtRange) return { status: 500, body: { ok: false, error: "message_store_unavailable" } };
    const window = resolveMemorySleepWindow(date);
    if (!window) return { status: 404, body: { ok: false, error: "sleep_window_not_found" } };
    const { startAt, endAt } = window;
    const messages = input.store.listMessagesByCreatedAtRange(startAt, endAt, 10_000);
    const content = formatCheckChatMessages(messages, {
      timeZone: input.time.timeZone,
      userName: input.config.project.username
    });
    return {
      status: 200,
      body: {
        ok: true,
        date,
        startAt,
        endAt,
        startAtUtc: window.startAtUtc,
        endAtUtc: window.endAtUtc,
        source: window.source,
        content,
        messages
      }
    };
  }

  async function runDay(date: string, runId?: string, apiPreset?: MemoryAdminLLMApiPreset) {
    return runMemoryForDate(date, undefined, runId, apiPreset);
  }

  async function runTarget(date: string, target: MemoryTarget, runId?: string, apiPreset?: MemoryAdminLLMApiPreset) {
    return runMemoryForDate(date, target, runId, apiPreset);
  }

  function getRunProgress(id: string) {
    const progress = memoryRunProgress.get(id);
    if (!progress) return { status: 404, body: { ok: false, error: "memory_run_progress_not_found" } };
    return { status: 200, body: { ok: true, progress } };
  }

  function undoLastGitCommit() {
    const dir = path.join(input.config.memoryFiles.root, "long-term-memory");
    try {
      const unavailable = validateMemoryGitRepo(dir);
      if (unavailable) return { status: 400, body: { ok: false, error: unavailable } };
      const target = findLatestActiveMemoryCommit(dir);
      if (!target) return { status: 400, body: { ok: false, error: "no_memorize_commit_to_undo" } };
      removeEmptyUntrackedMemoryFiles(dir);
      ensureMemoryGitClean(dir);
      revertMemoryGitCommit(dir, target.commit);
      input.appendLog("info", `memory git undo: reverted ${target.shortCommit} ${target.subject}`);
      return { status: 200, body: { ok: true, commit: target.shortCommit, message: target.subject, files: input.memoryStore.stats() } };
    } catch (error) {
      return { status: 500, body: { ok: false, error: error instanceof Error ? error.message : "memory_git_undo_failed" } };
    }
  }

  function redoLastGitCommit() {
    const dir = path.join(input.config.memoryFiles.root, "long-term-memory");
    try {
      const unavailable = validateMemoryGitRepo(dir);
      if (unavailable) return { status: 400, body: { ok: false, error: unavailable } };
      const target = findLatestActiveMemoryRevertCommit(dir);
      if (!target) return { status: 400, body: { ok: false, error: "no_memorize_revert_to_redo" } };
      removeEmptyUntrackedMemoryFiles(dir);
      ensureMemoryGitClean(dir);
      revertMemoryGitCommit(dir, target.commit);
      input.appendLog("info", `memory git redo: reverted ${target.shortCommit} ${target.subject}`);
      return { status: 200, body: { ok: true, commit: target.shortCommit, message: target.subject, files: input.memoryStore.stats() } };
    } catch (error) {
      return { status: 500, body: { ok: false, error: error instanceof Error ? error.message : "memory_git_redo_failed" } };
    }
  }

  function deleteLatestSqlRecord(target: MemoryTarget) {
    const entry = input.memoryStore.deleteLatestEntry?.(target);
    if (!entry) return { status: 400, body: { ok: false, error: "no_memory_sql_record_to_delete" } };
    input.appendLog("info", `memory sql delete latest ${target} entry: ${entry.localDate ?? entry.id}`);
    return { status: 200, body: { ok: true, entry, files: input.memoryStore.stats() } };
  }

  function previewPrompts(target: MemoryTarget, prompts?: ReturnType<MemoryInductionPromptStore["get"]>, apiPreset?: MemoryAdminLLMApiPreset) {
    if (!input.store?.listMessagesByCreatedAtRange) return { status: 500, body: { ok: false, error: "message_store_unavailable" } };
    const window = latestMemoryWindow();
    if (!window) return { status: 404, body: { ok: false, error: "sleep_window_not_found" } };
    const messages = input.store.listMessagesByCreatedAtRange(window.startAt, window.endAt, 10_000);
    const preview = buildMemoryPromptPreview({
      memoryStore: input.memoryStore,
      prompts: prompts ?? input.memoryInductionPromptStore.get(),
      promptContextRuntime: input.promptContextRuntime,
      messages,
      windowStartAt: window.startAt,
      windowEndAt: window.endAt,
      timezone: input.time.timeZone,
      userName: input.config.project.username,
      config: memorySummaryConfigForPreset(apiPreset ?? input.resolveMemorizeApiPreset()),
      sandboxPaths: memoryPreviewSandboxPaths(input.config.bashSandbox),
      generatedAt: input.time.now().iso
    }, target);
    return { status: 200, body: { ok: true, date: window.date, source: window.source, preview } };
  }

  function memoryPreviewSandboxPaths(config: BashSandboxConfig | undefined) {
    if (!config) return undefined;
    const workspacePath = path.posix.join(config.workspaceDir, "memory_organization");
    return {
      workspacePath,
      files: {
        persistent: path.posix.join(workspacePath, targetFiles.persistent),
        userPreferences: path.posix.join(workspacePath, targetFiles.userPreferences),
        yesterdaySummary: path.posix.join(workspacePath, targetFiles.yesterdaySummary)
      }
    };
  }

  async function runMemoryForDate(date: string, target?: MemoryTarget, runId?: string, resolvedApiPreset?: MemoryAdminLLMApiPreset) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { status: 400, body: { ok: false, error: "invalid_date" } };
    if (!input.store?.listMessagesByCreatedAtRange) return { status: 500, body: { ok: false, error: "message_store_unavailable" } };
    const window = resolveMemorySleepWindow(date);
    if (!window) return { status: 404, body: { ok: false, error: "sleep_window_not_found" } };
    const { startAt, endAt } = window;
    const messages = input.store.listMessagesByCreatedAtRange(startAt, endAt, 10_000);
    const apiPreset = resolvedApiPreset ?? input.resolveMemorizeApiPreset();
    if (!apiPreset) return { status: 400, body: { ok: false, error: "memorize_preset_required" } };
    const manualRunGate = memoryManualRunGate();
    if (input.config.memorySummary.manualRunRequiresSleeping !== false && !manualRunGate.allowed) {
      updateMemoryRunProgress(runId, date, target, "rejected");
      return { status: 409, body: { ok: false, error: "memory_manual_run_requires_paused_or_sleeping", gate: manualRunGate } };
    }
    if (memoryAdminRunActive) {
      updateMemoryRunProgress(runId, date, target, "rejected");
      return { status: 409, body: { ok: false, error: "memory_run_already_running" } };
    }
    memoryAdminRunActive = true;
    updateMemoryRunProgress(runId, date, target, "running");
    try {
      const result = await runInduction(messages, startAt, endAt, apiPreset, target, (roundTarget, rounds, toolStatus) => {
        updateMemoryRunProgress(runId, date, target, "running", roundTarget, rounds, toolStatus);
      });
      updateMemoryRunProgress(runId, date, target, result.ok ? "complete" : "failed");
      input.appendLog(result.ok ? "info" : "warn", `memorize ${target ?? "day"} ${date}: ${result.ok ? "ok" : "failed"} messages=${messages.length}`);
      return { status: result.ok ? 200 : 400, body: { ok: result.ok, result, files: input.memoryStore.stats() } };
    } finally {
      memoryAdminRunActive = false;
    }
  }

  async function runInduction(
    messages: any[],
    windowStartAt: string | undefined,
    windowEndAt: string,
    apiPreset: MemoryAdminLLMApiPreset,
    target?: MemoryTarget,
    onRound?: (target: MemoryTarget, rounds: number, status?: string) => void
  ): Promise<MemoryRunSummary> {
    if (input.runMemoryInductionForMessages) {
      return input.runMemoryInductionForMessages(messages, windowStartAt, windowEndAt, apiPreset, target, onRound);
    }
    const memoryConfig = memorySummaryConfigForPreset(apiPreset);
    const memoryLLM = createLLMClientFromPreset(apiPreset as any);
    const memorySession = target ? input.ensureMemoryConsoleSession(windowEndAt, windowStartAt) : undefined;
    return await runMemoryInductionForMessages({
      memoryStore: input.memoryStore,
      promptStore: input.memoryInductionPromptStore,
      promptContextRuntime: input.promptContextRuntime,
      sandbox: input.sandbox,
      messages,
      windowStartAt,
      windowEndAt,
      llm: memoryLLM,
      llmRequestSender: input.llmRequests.send,
      config: memoryConfig,
      nowIso: () => input.time.now().iso,
      timezone: input.time.timeZone,
      userName: input.config.project.username,
      sessionRoot: input.llmSessionRoot(),
      memorySession,
      onRound,
      log: input.appendLog
    }, target);
  }

  function memorySummaryConfigForPreset(preset: MemoryAdminLLMApiPreset | undefined) {
    if (!preset) return { ...input.config.memorySummary, enabled: false, apiKey: undefined };
    return {
      ...input.config.memorySummary,
      baseURL: preset.baseURL,
      apiKey: preset.apiKey,
      model: preset.model,
      temperature: preset.temperature,
      maxTokens: preset.maxTokens,
      timeoutMs: preset.timeoutMs,
      stream: preset.stream,
      extraParams: preset.extraParams,
      followupExtraParams: preset.followupExtraParams
    };
  }

  function updateMemoryRunProgress(
    runId: string | undefined,
    date: string,
    target: MemoryTarget | undefined,
    status: MemoryRunProgress["status"],
    roundTarget?: MemoryTarget,
    rounds?: number,
    toolStatus?: string
  ): void {
    if (!runId) return;
    const previous = memoryRunProgress.get(runId);
    const next: MemoryRunProgress = previous ?? {
      id: runId,
      date,
      target,
      status,
      rounds: {},
      tools: {},
      roundStartedAt: {},
      updatedAt: new Date().toISOString()
    };
    next.status = status;
    next.updatedAt = new Date().toISOString();
    if (roundTarget && rounds !== undefined) {
      if (next.rounds[roundTarget] !== rounds) {
        next.roundStartedAt[roundTarget] = next.updatedAt;
        delete next.tools[roundTarget];
      }
      next.rounds[roundTarget] = rounds;
    }
    if (roundTarget && toolStatus) next.tools[roundTarget] = toolStatus;
    if (status === "complete" && target) next.tools[target] = "ok";
    memoryRunProgress.set(runId, next);
  }

  function resolveMemorySleepWindow(date: string): MemorySleepWindow | undefined {
    return resolveMemorySleepWindowForDate({
      diaryStore: input.diaryStore,
      date,
      timeZone: input.time.timeZone,
      messages: input.store?.listMessagesChronological?.(10_000) ?? [],
      now: () => {
        const now = input.time.now();
        return { iso: now.iso, utcIso: now.date.toISOString() };
      }
    });
  }

  function ensureMemorySleepBoundaries(): MemorySleepWindow[] {
    return listMemorySleepWindows({
      diaryStore: input.diaryStore,
      timeZone: input.time.timeZone,
      messages: input.store?.listMessagesChronological?.(10_000) ?? [],
      now: () => {
        const now = input.time.now();
        return { iso: now.iso, utcIso: now.date.toISOString() };
      }
    });
  }

  function latestMemoryWindow(): MemorySleepWindow | undefined {
    return latestMemorySleepWindow({
      diaryStore: input.diaryStore,
      timeZone: input.time.timeZone,
      messages: input.store?.listMessagesChronological?.(10_000) ?? [],
      now: () => {
        const now = input.time.now();
        return { iso: now.iso, utcIso: now.date.toISOString() };
      }
    });
  }

  function memoryManualRunGate() {
    const agentState = input.agentState.getSnapshot().state;
    const heartbeatPaused = input.isHeartbeatPaused?.() === true;
    return { allowed: agentState === "sleeping" || heartbeatPaused, agentState, heartbeatPaused };
  }
}

type MemoryGitLogEntry = {
  commit: string;
  shortCommit: string;
  subject: string;
  body: string;
  originalMemoryCommit?: string;
};

function validateMemoryGitRepo(dir: string): string | undefined {
  if (!fs.existsSync(path.join(dir, ".git"))) return "memory_git_unavailable";
  try {
    gitExecFileSync(["rev-parse", "--verify", "HEAD"], { cwd: dir });
    return undefined;
  } catch {
    return "memory_git_empty";
  }
}

function findLatestActiveMemoryCommit(dir: string): MemoryGitLogEntry | undefined {
  const log = readMemoryGitLog(dir);
  const activeOriginals = activeOriginalMemoryCommits(log);
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const entry = log[index];
    if (isMemorizeSubject(entry.subject) && activeOriginals.has(entry.commit)) return entry;
  }
  return undefined;
}

function findLatestActiveMemoryRevertCommit(dir: string): MemoryGitLogEntry | undefined {
  const log = readMemoryGitLog(dir);
  const activeOriginals = activeOriginalMemoryCommits(log);
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const entry = log[index];
    if (!isMemorizeRevertSubject(entry.subject) || !entry.originalMemoryCommit) continue;
    if (!activeOriginals.has(entry.originalMemoryCommit)) return entry;
  }
  return undefined;
}

function activeOriginalMemoryCommits(log: MemoryGitLogEntry[]): Set<string> {
  const active = new Set<string>();
  const originalsByCommit = new Map<string, string>();
  for (const entry of log) {
    if (isMemorizeSubject(entry.subject)) {
      active.add(entry.commit);
      originalsByCommit.set(entry.commit, entry.commit);
      entry.originalMemoryCommit = entry.commit;
      continue;
    }
    const reverted = revertedCommitFromBody(entry.body);
    const original = reverted ? originalsByCommit.get(reverted) : undefined;
    if (!original) continue;
    entry.originalMemoryCommit = original;
    originalsByCommit.set(entry.commit, original);
    if (active.has(original)) active.delete(original);
    else active.add(original);
  }
  return active;
}

function readMemoryGitLog(dir: string): MemoryGitLogEntry[] {
  const output = gitExecFileSync(["log", "--reverse", "--format=%H%x00%h%x00%s%x00%b%x1e"], { cwd: dir, encoding: "utf8" });
  return output
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [commit = "", shortCommit = "", subject = "", ...bodyParts] = chunk.split("\x00");
      return { commit, shortCommit, subject, body: bodyParts.join("\x00") };
    })
    .filter((entry) => entry.commit);
}

function isMemorizeSubject(subject: string): boolean {
  return subject.startsWith("memorize ");
}

function isMemorizeRevertSubject(subject: string): boolean {
  return subject.startsWith('Revert "memorize ');
}

function revertedCommitFromBody(body: string): string | undefined {
  return body.match(/This reverts commit ([0-9a-f]{40})\./)?.[1];
}

function removeEmptyUntrackedMemoryFiles(dir: string): void {
  for (const fileName of ["persistent-memory.md", "user-preferences.md"]) {
    const filePath = path.join(dir, fileName);
    if (!fs.existsSync(filePath) || fs.readFileSync(filePath, "utf8") !== "") continue;
    try {
      gitExecFileSync(["ls-files", "--error-unmatch", fileName], { cwd: dir });
    } catch {
      fs.rmSync(filePath);
    }
  }
}

function ensureMemoryGitClean(dir: string): void {
  const status = gitExecFileSync(["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim();
  if (!status) return;
  throw new Error("memory_git_worktree_dirty");
}

function revertMemoryGitCommit(dir: string, commit: string): void {
  try {
    gitExecFileSync(["revert", "--no-edit", commit], { cwd: dir });
  } catch (error) {
    abortMemoryGitRevert(dir);
    throw error;
  }
}

function abortMemoryGitRevert(dir: string): void {
  if (!fs.existsSync(path.join(dir, ".git", "REVERT_HEAD"))) return;
  try {
    gitExecFileSync(["revert", "--abort"], { cwd: dir });
  } catch {
    // Preserve the original revert error for the API response.
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
