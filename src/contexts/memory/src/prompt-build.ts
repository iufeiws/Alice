import type { StoredConversationMessage } from '../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js';
import type { LLMMessage } from '../../../contexts/llm-gateway/src/index.js';
import type { PromptContextPrimitive, PromptContextRuntime } from '../../../contexts/prompt-context/src/index.js';
import type { MemorySummaryConfig } from './contracts/memory-config.js';
import { parsePromptToolArguments, promptMessageToMessage } from '../../../contexts/agent-profile/src/domain/prompt-layer.js';
import type { MemoryInductionPrompts, MemoryInductionPromptStore, MemoryPromptPreview, MemoryStore, MemoryTarget } from './model.js';
import { memoryFileLimits, targetResultFiles } from './model.js';
import { memoryTools } from './tools.js';
import { normalizeMemoryInductionPrompts } from './prompt-store.js';
import { readFile } from './store.js';
import { lineCount, utf8ByteLength } from './text-utils.js';
import { formatCheckChatMessages } from '../../../capabilities/tools/messaging/src/index.js';

const fs = await import('node:fs');

export type MemorySandboxPromptPaths = {
  workspacePath: string;
  files: Record<MemoryTarget, string>;
};

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
    sandboxPaths?: MemorySandboxPromptPaths;
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
    userName: deps.userName,
    sandboxPaths: deps.sandboxPaths
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

export function buildMemoryPromptMessages(
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
    sandboxPaths?: MemorySandboxPromptPaths;
  },
  target: MemoryTarget
): LLMMessage[] {
  return buildMemoryLayerMessages(deps.promptStore.get(), memoryPromptRuntime(deps, target), deps, target);
}

function buildMemoryLayerMessages(
  layer: MemoryInductionPrompts,
  promptContextRuntime: PromptContextRuntime,
  deps: { memoryStore: MemoryStore; diaryDraftPath?: string },
  target: MemoryTarget
): LLMMessage[] {
  const messages: LLMMessage[] = [];
  for (const promptMessage of layer.messages.filter((message) => message.meta.enabled !== false)) {
    const message = promptMessageToMessage(promptMessage, promptContextRuntime);
    messages.push(message);
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

export function buildMemoryErrorMessages(errorDetail: string): LLMMessage[] {
  return [{
    role: "user",
    name: "Cheshire Cat",
    content: `<Error>\n${errorDetail}\n</Error>`
  }];
}

function memoryPromptRuntime(
  deps: {
    promptContextRuntime: PromptContextRuntime;
    messages: StoredConversationMessage[];
    windowStartAt?: string;
    windowEndAt: string;
    timezone: string;
    userName?: string;
    sandboxPaths?: MemorySandboxPromptPaths;
  },
  target: MemoryTarget
): PromptContextRuntime {
  return deps.promptContextRuntime.withVariables(memoryPromptVariables(deps, target));
}

function memoryPromptVariables(
  deps: {
    messages: StoredConversationMessage[];
    windowStartAt?: string;
    windowEndAt: string;
    timezone: string;
    userName?: string;
    sandboxPaths?: MemorySandboxPromptPaths;
  },
  target: MemoryTarget
): Record<string, PromptContextPrimitive> {
  const variables: Record<string, PromptContextPrimitive> = {
    "memorize/target/fileName": deps.sandboxPaths?.files[target] ?? targetResultFiles[target],
    "memorize/window/startAt": deps.windowStartAt ?? "",
    "memorize/window/endAt": deps.windowEndAt,
    "memorize/timezone": deps.timezone,
    "memorize/messages/content": formatCheckChatMessages(deps.messages, { timeZone: deps.timezone, userName: deps.userName ?? "user" })
  };
  if (deps.sandboxPaths) {
    variables["memorize/workspace/path"] = deps.sandboxPaths.workspacePath;
    for (const target of Object.keys(deps.sandboxPaths.files) as MemoryTarget[]) {
      variables[`memorize/files/${target}/filePath`] = deps.sandboxPaths.files[target];
    }
  }
  for (const target of Object.keys(memoryFileLimits) as MemoryTarget[]) {
    const limit = memoryFileLimits[target];
    variables[`memory/${target}/limit/lines`] = limit.lines;
    variables[`memory/${target}/limit/bytes`] = limit.bytes;
    variables[`memory/${target}/limit/kib`] = Math.ceil(limit.bytes / 1024);
  }
  return variables;
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

export function formatReadMemoryResult(target: MemoryTarget, content: string): string {
  const file = targetResultFiles[target];
  return [
    `<${file}>`,
    content.endsWith("\n") ? content.slice(0, -1) : content,
    `</${file}>`,
    `${lineCount(content)} line(s), ${utf8ByteLength(content)} byte(s)`
  ].join("\n");
}

export function readMemoryTargetForRun(memoryStore: MemoryStore, target: MemoryTarget, diaryDraftPath?: string): string {
  if (target === "yesterdaySummary" && diaryDraftPath) return readFile(diaryDraftPath);
  return memoryStore.readTarget(target);
}

export function isLongTermMemoryTarget(target: MemoryTarget): target is "persistent" | "userPreferences" {
  return target === "persistent" || target === "userPreferences";
}

export function cleanupDiaryDraft(draftPath?: string): void {
  if (!draftPath) return;
  try {
    if (fs.existsSync(draftPath)) fs.rmSync(draftPath);
  } catch {
    // Temp draft cleanup is best-effort.
  }
}
