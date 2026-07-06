import type { StoredConversationMessage } from '../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js';
import { registerLLMToolLoopTools, runLLMToolLoop } from '../../../contexts/llm-gateway/src/llm-tool-loop.js';
import type { MemoryInductionSession, MemoryRunResult, MemoryRunSummary, MemorySummaryDeps, MemoryTarget } from './model.js';
import { maxMessagesPerSummary, memoryInductionMaxAttempts, memoryToolRoundLimit, targetFiles, targetResultFiles } from './model.js';
import { latestMemorySleepWindow } from './sleep-window.js';
import { buildMemoryPromptMessages, readMemoryTargetForRun } from './prompt-build.js';
import { createMemoryInductionSession } from './session.js';
import { createMemoryLocalLLMRequestSender, createMemorySelfTalkToolPlugin, memoryToolDefinitions, memoryToolNames, memoryTools } from './tools.js';
import { lineCount, utf8ByteLength } from './text-utils.js';
import { createSandboxFileTools } from '../../../capabilities/tools/sandbox-files/src/index.js';
import { readFile, writeAtomic } from './store.js';

let memoryToolRegistrySeq = 0;
const memoryTargets: MemoryTarget[] = ["persistent", "userPreferences", "yesterdaySummary"];
const fs = await import('node:fs');
const path = await import('node:path');

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
  if (!deps.config.enabled) {
    return { ok: false, startedAt, windowStartAt: deps.windowStartAt, windowEndAt: deps.windowEndAt, messageCount: deps.messages.length, results: [] };
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
      results: memoryTargets.map((target) => ({ target, ok: false, edited: false, rounds: 0, error, toolCalls: [] }))
    };
  }

  const results = await runMemoryOrganizationInductionWithRetry(deps, targetFilter ?? "persistent");
  for (const entry of results) {
    if (entry.ok) deps.log("info", `Memorize ${entry.target} completed`);
    else deps.log("warn", `Memorize ${entry.target} failed: ${entry.error ?? "unknown"}`);
  }
  return {
    ok: results.length === memoryTargets.length && results.every((entry) => entry.ok),
    startedAt,
    windowStartAt: deps.windowStartAt,
    windowEndAt: deps.windowEndAt,
    messageCount: deps.messages.length,
    results
  };
}

async function runMemoryOrganizationInductionWithRetry(
  deps: Omit<MemorySummaryDeps, "messageStore" | "stateStore"> & {
    messages: StoredConversationMessage[];
    windowStartAt?: string;
    windowEndAt: string;
    memorySession?: MemoryInductionSession;
  },
  promptTarget: MemoryTarget
): Promise<MemoryRunResult[]> {
  let lastResults: MemoryRunResult[] | undefined;
  for (let attempt = 1; attempt <= memoryInductionMaxAttempts; attempt += 1) {
    try {
      const results = await runMemoryOrganizationInduction(deps, promptTarget);
      if (results.every((entry) => entry.ok) || attempt >= memoryInductionMaxAttempts) return results;
      lastResults = results;
      const reason = results.find((entry) => !entry.ok)?.error ?? "unknown Memorize failure";
      deps.log("warn", `Memorize attempt ${attempt}/${memoryInductionMaxAttempts} failed: ${reason}, retrying`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastResults = memoryTargets.map((target) => ({ target, ok: false, edited: false, rounds: 0, error: message, toolCalls: [] }));
      if (attempt >= memoryInductionMaxAttempts) return lastResults;
      deps.log("warn", `Memorize attempt ${attempt}/${memoryInductionMaxAttempts} failed: ${message}, retrying`);
    }
  }
  return lastResults ?? memoryTargets.map((target) => ({ target, ok: false, edited: false, rounds: 0, error: "unknown Memorize failure", toolCalls: [] }));
}

export async function runSleepMemoryBackfill(deps: MemorySummaryDeps): Promise<{ ok: boolean; segments: number; messages: number }> {
  const allMessages = deps.messageStore.listMessagesChronological(maxMessagesPerSummary);
  const result = await runMemoryInductionForMessages({
    memoryStore: deps.memoryStore,
    promptStore: deps.promptStore,
    promptContextRuntime: deps.promptContextRuntime,
    llm: deps.llm,
    sandbox: deps.sandbox,
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

type MemoryOrganizationWorkspace = {
  containerRoot: string;
  hostFiles: Record<MemoryTarget, string>;
  containerFiles: Record<MemoryTarget, string>;
  initialContent: Record<MemoryTarget, string>;
};

function createMemoryOrganizationWorkspace(
  deps: Omit<MemorySummaryDeps, "messageStore" | "stateStore"> & {
    windowEndAt: string;
  }
): MemoryOrganizationWorkspace {
  if (!deps.sandbox) throw new Error("memory_sandbox_required");
  const runId = sanitizeRunId(`${deps.windowEndAt}-${deps.nowIso()}`);
  const hostRoot = path.join(deps.sandbox.config.hostWorkspaceDir, "memory_organization", runId);
  const containerRoot = path.posix.join(deps.sandbox.config.workspaceDir, "memory_organization", runId);
  fs.mkdirSync(hostRoot, { recursive: true });

  const hostFiles = Object.fromEntries(memoryTargets.map((target) => [target, path.join(hostRoot, targetFiles[target])])) as Record<MemoryTarget, string>;
  const containerFiles = Object.fromEntries(memoryTargets.map((target) => [target, path.posix.join(containerRoot, targetFiles[target])])) as Record<MemoryTarget, string>;
  const initialContent = Object.fromEntries(memoryTargets.map((target) => [target, readMemoryTargetForRun(deps.memoryStore, target)])) as Record<MemoryTarget, string>;
  for (const target of memoryTargets) writeAtomic(hostFiles[target], initialContent[target]);

  return { containerRoot, hostFiles, containerFiles, initialContent };
}

function commitMemoryOrganizationWorkspace(
  deps: Omit<MemorySummaryDeps, "messageStore" | "stateStore"> & {
    windowStartAt?: string;
    windowEndAt: string;
  },
  workspace: MemoryOrganizationWorkspace,
  toolCalls: MemoryRunResult["toolCalls"],
  rounds: number,
  response: MemoryRunResult["response"],
  session: MemoryInductionSession
): MemoryRunResult[] {
  return memoryTargets.map((target) => {
    const content = readFile(workspace.hostFiles[target]);
    const edited = content !== workspace.initialContent[target];
    if (edited) {
      const written = deps.memoryStore.writeTarget(target, content, {
        now: deps.nowIso(),
        localDate: deps.windowEndAt.slice(0, 10),
        windowStartAt: deps.windowStartAt,
        windowEndAt: deps.windowEndAt
      });
      session.append?.({
        type: "memory_commit",
        file: targetResultFiles[target],
        sandboxPath: workspace.containerFiles[target],
        lines: lineCount(written),
        bytes: utf8ByteLength(written)
      });
    }
    return {
      target,
      ok: true,
      edited,
      rounds,
      toolCalls: toolCallsForTarget(toolCalls, target),
      response
    };
  });
}

function toolCallsForTarget(toolCalls: MemoryRunResult["toolCalls"], target: MemoryTarget): MemoryRunResult["toolCalls"] {
  const file = targetResultFiles[target];
  return toolCalls.filter((entry) => entry.file === file || entry.name === "self_talk");
}

function fileForSandboxPath(workspace: MemoryOrganizationWorkspace, filePath: string): MemoryRunResult["toolCalls"][number]["file"] {
  for (const target of memoryTargets) {
    if (filePath === workspace.containerFiles[target]) return targetResultFiles[target];
  }
  return targetResultFiles.persistent;
}

function withMemoryPromptPaths(runtime: MemorySummaryDeps["promptContextRuntime"], workspace: MemoryOrganizationWorkspace): MemorySummaryDeps["promptContextRuntime"] {
  const variables = Object.fromEntries(memoryTargets.map((target) => [`memorize/files/${target}/filePath`, workspace.containerFiles[target]])) as Record<string, string>;
  return {
    renderText(content, options) {
      return content.replace(/\{\{\s*([a-zA-Z0-9_/]+)\s*\}\}/g, (match, key: string) => {
        const value = variables[key] ?? runtime.getVariable(key, options);
        return value === undefined || value === null || typeof value === "object" ? match : String(value);
      });
    },
    getVariable(name, options) {
      return variables[name] ?? runtime.getVariable(name, options);
    },
    listVariables() {
      return [...new Set([...runtime.listVariables(), ...Object.keys(variables)])];
    }
  };
}

function sanitizeRunId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120) || "run";
}

async function runMemoryOrganizationInduction(
  deps: Omit<MemorySummaryDeps, "messageStore" | "stateStore"> & {
    messages: StoredConversationMessage[];
    windowStartAt?: string;
    windowEndAt: string;
    memorySession?: MemoryInductionSession;
  },
  promptTarget: MemoryTarget
): Promise<MemoryRunResult[]> {
  if (!deps.sandbox) throw new Error("memory_sandbox_required");
  const toolCalls: MemoryRunResult["toolCalls"] = [];
  const workspace = createMemoryOrganizationWorkspace(deps);
  const session = deps.memorySession ?? createMemoryInductionSession(deps.sessionRoot, deps.nowIso(), {
    name: "memory_organization",
    windowStartAt: deps.windowStartAt,
    windowEndAt: deps.windowEndAt,
    timezone: deps.timezone,
    nowIso: deps.nowIso
  });
  session.activeTarget = promptTarget;
  const promptRuntime = withMemoryPromptPaths(deps.promptContextRuntime, workspace);
  const promptMessages = buildMemoryPromptMessages({ ...deps, promptContextRuntime: promptRuntime, sandboxPaths: { workspacePath: workspace.containerRoot, files: workspace.containerFiles } }, promptTarget, {
    includeCommonLayers: session.messages.length === 0
  });
  const messages = session.messages.length > 0
    ? [...session.messages, ...promptMessages]
    : promptMessages;
  const toolRegistryName = `memory_organization_${memoryToolRegistrySeq += 1}`;
  const sandboxFileTools = createSandboxFileTools({
    runtime: deps.sandbox.runtime,
    config: deps.sandbox.config
  });
  const unregisterTools = registerLLMToolLoopTools(toolRegistryName, [
    sandboxFileTools,
    createMemorySelfTalkToolPlugin({ toolCalls })
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
          deps.onRound?.(promptTarget, round + 1);
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
            inlineTools: memoryToolDefinitions(),
            toolVariables: promptRuntime,
            stream: deps.config.stream === true,
            metadata: { target: promptTarget }
          };
        },
        sendRequest: deps.llmRequestSender ?? createMemoryLocalLLMRequestSender(deps.llm),
        afterRequest({ round, result }) {
          session.append?.({ type: "response", round: session.roundOffset + round, response: result });
        },
        beforeTool({ round, call }) {
          deps.onRound?.(promptTarget, round + 1, call.function.name);
        },
        afterToolResult({ call, toolInput, toolResult }) {
          if (call.function.name === "Read" || call.function.name === "Edit") {
            const file = fileForSandboxPath(workspace, typeof toolInput.file_path === "string" ? toolInput.file_path : "");
            toolCalls.push({
              name: call.function.name,
              file,
              input: toolInput,
              ok: toolResult.ok,
              output: typeof toolResult.output === "string" ? toolResult.output : undefined,
              error: toolResult.error
            });
          }
          return undefined;
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
  for (const target of memoryTargets) {
    if (!session.completedTargets.includes(target)) session.completedTargets.push(target);
  }
  session.activeTarget = undefined;

  if (loopResult.stopReason === "completed") {
    return commitMemoryOrganizationWorkspace(deps, workspace, toolCalls, loopResult.rounds, loopResult.finalResult?.message, session);
  }

  return memoryTargets.map((target) => ({
    target,
    ok: false,
    edited: false,
    rounds: loopResult.rounds,
    error: "model did not finish memory induction within tool round limit",
    toolCalls: toolCallsForTarget(toolCalls, target),
    response: loopResult.finalResult?.message
  }));
}
