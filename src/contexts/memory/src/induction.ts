import type { StoredConversationMessage } from '../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js';
import { registerLLMToolLoopTools, runLLMToolLoop } from '../../../contexts/llm-gateway/src/llm-tool-loop.js';
import type { LLMRequestSenderInput } from '../../../contexts/llm-gateway/src/llm-tool-loop.js';
import type { LLMToolSpec } from '../../../contexts/llm-gateway/src/index.js';
import type { ToolDefinition } from '../../../contexts/agent-loop/src/contracts/agent-contracts.js';
import type { MemoryInductionSession, MemoryRunResult, MemoryRunSummary, MemorySummaryDeps, MemoryTarget } from './model.js';
import { maxMessagesPerSummary, memoryFileLimits, targetFiles, targetResultFiles } from './model.js';
import { latestMemorySleepWindow } from './sleep-window.js';
import { buildMemoryErrorMessages, buildMemoryPromptMessages, readMemoryTargetForRun } from './prompt-build.js';
import { createMemoryInductionSession } from './session.js';
import { lineCount, utf8ByteLength } from './text-utils.js';
import { createFileTools } from '../../../capabilities/tools/file/src/index.js';
import { createMemorySelfTalkToolPlugin, memorySelfTalkDefinition, memorySelfTalkSpec, memorySelfTalkToolName } from './self-talk-tool.js';
import { readFile, writeAtomic } from './store.js';

let memoryToolRegistrySeq = 0;
const memoryTargets: MemoryTarget[] = ["persistent", "userPreferences", "yesterdaySummary"];
const emptyDiaryPlaceholder = "# ___ 日记\n";
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

  let results: MemoryRunResult[];
  try {
    results = await runMemoryOrganizationInduction(deps, targetFilter ?? "persistent");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results = memoryTargets.map((target) => ({ target, ok: false, edited: false, rounds: 0, error: message, toolCalls: [] }));
  }
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
  hostRoot: string;
  containerRoot: string;
  hostFiles: Record<MemoryTarget, string>;
  containerFiles: Record<MemoryTarget, string>;
  initialContent: Record<MemoryTarget, string>;
};

type MemoryFileLimitViolation = {
  path: string;
  lines: number;
  maxLines: number;
  bytes: number;
  maxBytes: number;
};

function createMemoryOrganizationWorkspace(
  deps: Omit<MemorySummaryDeps, "messageStore" | "stateStore"> & {
    windowEndAt: string;
  }
): MemoryOrganizationWorkspace {
  if (!deps.sandbox) throw new Error("memory_sandbox_required");
  const hostRoot = path.join(deps.sandbox.hostRoot, "memory_organization");
  const containerRoot = path.posix.join(deps.sandbox.containerRoot, "memory_organization");
  fs.rmSync(hostRoot, { recursive: true, force: true });
  fs.mkdirSync(hostRoot, { recursive: true });

  const hostFiles = Object.fromEntries(memoryTargets.map((target) => [target, path.join(hostRoot, targetFiles[target])])) as Record<MemoryTarget, string>;
  const containerFiles = Object.fromEntries(memoryTargets.map((target) => [target, path.posix.join(containerRoot, targetFiles[target])])) as Record<MemoryTarget, string>;
  const initialContent = Object.fromEntries(memoryTargets.map((target) => {
    const content = readMemoryTargetForRun(deps.memoryStore, target);
    return [target, target === "yesterdaySummary" && content === "" ? emptyDiaryPlaceholder : content];
  })) as Record<MemoryTarget, string>;
  for (const target of memoryTargets) writeAtomic(hostFiles[target], initialContent[target]);

  return { hostRoot, containerRoot, hostFiles, containerFiles, initialContent };
}

function cleanupMemoryOrganizationWorkspace(workspace: MemoryOrganizationWorkspace): void {
  fs.rmSync(workspace.hostRoot, { recursive: true, force: true });
}

function memoryWorkspaceLimitViolations(workspace: MemoryOrganizationWorkspace): MemoryFileLimitViolation[] {
  return memoryTargets.flatMap((target) => {
    const content = readFile(workspace.hostFiles[target]);
    const limit = memoryFileLimits[target];
    const lines = lineCount(content);
    const bytes = utf8ByteLength(content);
    return lines > limit.lines || bytes > limit.bytes
      ? [{ path: workspace.containerFiles[target], lines, maxLines: limit.lines, bytes, maxBytes: limit.bytes }]
      : [];
  });
}

function formatMemoryLimitError(violations: MemoryFileLimitViolation[]): string {
  return violations.map((violation) => {
    const issues = [
      violation.lines > violation.maxLines ? `lines=${violation.lines} > ${violation.maxLines}` : undefined,
      violation.bytes > violation.maxBytes ? `bytes=${violation.bytes} > ${violation.maxBytes}` : undefined
    ].filter(Boolean).join(", ");
    return `${violation.path}: ${issues}`;
  }).join("\n");
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
  return toolCalls.filter((entry) => entry.file === file);
}

function fileForSandboxPath(workspace: MemoryOrganizationWorkspace, filePath: string): MemoryRunResult["toolCalls"][number]["file"] {
  for (const target of memoryTargets) {
    if (filePath === workspace.containerFiles[target]) return targetResultFiles[target];
  }
  return targetResultFiles.persistent;
}

function withMemoryPromptPaths(runtime: MemorySummaryDeps["promptContextRuntime"], workspace: MemoryOrganizationWorkspace): MemorySummaryDeps["promptContextRuntime"] {
  const variables = Object.fromEntries(memoryTargets.map((target) => [`memorize/files/${target}/filePath`, workspace.containerFiles[target]])) as Record<string, string>;
  return runtime.withVariables(variables);
}

/** Read/Edit definitions come from the same Pi adapter that executes them. */
function memoryToolsToSpecs(definitions: ToolDefinition[]): LLMToolSpec[] {
  return definitions.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
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
  try {
    const session = deps.memorySession ?? createMemoryInductionSession(deps.sessionRoot, deps.nowIso(), {
      name: "memory_organization",
      windowStartAt: deps.windowStartAt,
      windowEndAt: deps.windowEndAt,
      timezone: deps.timezone,
      nowIso: deps.nowIso
    });
    session.activeTarget = promptTarget;
    const promptRuntime = withMemoryPromptPaths(deps.promptContextRuntime, workspace);
    const promptMessages = session.messages.length === 0
      ? buildMemoryPromptMessages({ ...deps, promptContextRuntime: promptRuntime, sandboxPaths: { workspacePath: workspace.containerRoot, files: workspace.containerFiles } }, promptTarget)
      : [];
    const messages = session.messages.length > 0
      ? [...session.messages, ...promptMessages]
      : promptMessages;
    const toolRegistryName = `memory_organization_${memoryToolRegistrySeq += 1}`;
    const piAdapter = createFileTools({ piWorker: deps.sandbox.runtime });
    const memoryDefinitions = piAdapter.listTools().filter((tool) => tool.name === "Read" || tool.name === "Edit");
    const selfTalkPlugin = createMemorySelfTalkToolPlugin({ toolCalls });
    const memoryToolNames = [...memoryDefinitions.map((tool) => tool.name), memorySelfTalkToolName];
    const unregisterTools = registerLLMToolLoopTools(toolRegistryName, [piAdapter, selfTalkPlugin]);

    let currentMessages = messages;
    let totalRounds = 0;
    let response: MemoryRunResult["response"];
    try {
      while (true) {
        const roundBase = totalRounds;
        const loopResult = await runLLMToolLoop({
          initialMessages: currentMessages,
          toolRegistryName,
          buildRequest({ round, messages }) {
            const absoluteRound = roundBase + round;
            const extraParams = absoluteRound === 0 ? deps.config.extraParams : deps.config.followupExtraParams;
            const request = {
              model: deps.config.model,
              temperature: deps.config.temperature,
              maxTokens: deps.config.maxTokens,
              extraParams,
              tools: [...memoryToolsToSpecs(memoryDefinitions), memorySelfTalkSpec],
              messages
            };
            deps.onRound?.(promptTarget, absoluteRound + 1);
            session.append?.({ type: "request", round: session.roundOffset + absoluteRound, request });
            return {
              agentId: "memorize",
              client: deps.llm,
              messages,
              model: deps.config.model,
              temperature: deps.config.temperature,
              maxTokens: deps.config.maxTokens,
              extraParams,
              toolNames: [...memoryToolNames],
              inlineTools: [...memoryDefinitions, memorySelfTalkDefinition],
              toolVariables: promptRuntime,
              stream: deps.config.stream === true,
              metadata: { target: promptTarget }
            };
          },
          sendRequest: deps.llmRequestSender ?? ((input) => sendMemoryLLMRequest(input, deps.llm, [...memoryToolsToSpecs(memoryDefinitions), memorySelfTalkSpec])),
          afterRequest({ round, result }) {
            session.append?.({ type: "response", round: session.roundOffset + roundBase + round, response: result });
          },
          beforeTool({ round, call }) {
            deps.onRound?.(promptTarget, roundBase + round + 1, call.function.name);
          },
          afterToolResult({ call, toolInput, toolResult }) {
            if (call.function.name === "Read" || call.function.name === "Edit") {
              const file = fileForSandboxPath(workspace, typeof toolInput.path === "string" ? toolInput.path : "");
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
        totalRounds += loopResult.rounds;
        response = loopResult.finalResult?.message;
        currentMessages = loopResult.messages;
        if (loopResult.stopReason !== "completed") break;

        const violations = memoryWorkspaceLimitViolations(workspace);
        if (violations.length === 0) {
          session.roundOffset += totalRounds;
          for (const target of memoryTargets) {
            if (!session.completedTargets.includes(target)) session.completedTargets.push(target);
          }
          session.activeTarget = undefined;
          return commitMemoryOrganizationWorkspace(deps, workspace, toolCalls, totalRounds, response, session);
        }

        const errorDetail = formatMemoryLimitError(violations);
        const errorMessages = buildMemoryErrorMessages(errorDetail);
        currentMessages = [...currentMessages, ...errorMessages];
        session.messages = currentMessages;
        session.append?.({ type: "memory_limit_error", error: errorDetail });
        session.append?.({ type: "final_messages", messages: currentMessages });
      }
    } finally {
      unregisterTools();
    }
    session.roundOffset += totalRounds;
    session.activeTarget = undefined;
    return memoryTargets.map((target) => ({
      target,
      ok: false,
      edited: false,
      rounds: totalRounds,
      error: "model did not finish memory induction within tool round limit",
      toolCalls: toolCallsForTarget(toolCalls, target),
      response
    }));
  } finally {
    cleanupMemoryOrganizationWorkspace(workspace);
  }
}

async function sendMemoryLLMRequest(input: LLMRequestSenderInput, llm: MemorySummaryDeps["llm"], tools: LLMToolSpec[]) {
  if (!llm) throw new Error("missing Memorize API preset or API key");
  const request = {
    messages: input.messages,
    model: input.model,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    extraParams: input.extraParams,
    tools
  };
  return input.stream === true && llm.chatStream
    ? llm.chatStream(request, input.streamHandlers)
    : llm.chat(request);
}
