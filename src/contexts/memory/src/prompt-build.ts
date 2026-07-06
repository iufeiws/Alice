import type { StoredConversationMessage } from '../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js';
import type { LLMMessage } from '../../../contexts/llm-gateway/src/index.js';
import type { PromptContextRuntime, PromptContextValue } from '../../../contexts/prompt-context/src/index.js';
import type { MemorySummaryConfig } from './contracts/memory-config.js';
import { parsePromptToolArguments, promptLayerToMessage } from '../../../contexts/agent-profile/src/domain/prompt-layer.js';
import type { MemoryInductionPrompts, MemoryInductionPromptStore, MemoryPromptLayer, MemoryPromptPreview, MemoryStore, MemoryTarget } from './model.js';
import { memoryFileLimits, targetResultFiles } from './model.js';
import { memoryTools } from './tools.js';
import { memoryErrorLayerId, normalizeMemoryInductionPrompts } from './prompt-store.js';
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
    memorizeErrorDetail?: string;
  },
  target: MemoryTarget,
  options?: { includeCommonLayers?: boolean; includeErrorLayer?: boolean }
): LLMMessage[] {
  const layers = memoryPromptLayers(deps.promptStore.get(), target, options);
  const promptContextRuntime = memoryPromptRuntime(deps, target);
  const messages: LLMMessage[] = [];
  for (const layer of layers) {
    const message = promptLayerToMessage(layer, promptContextRuntime, {
      defaultToolName: "Read",
      toolCallIdPrefix: "memory_prompt",
      allowedToolNames: ["Read", "Edit", "self_talk"]
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

export function buildMemoryErrorMessages(
  deps: {
    promptStore: Pick<MemoryInductionPromptStore, "get">;
    promptContextRuntime: PromptContextRuntime;
    messages: StoredConversationMessage[];
    windowStartAt?: string;
    windowEndAt: string;
    timezone: string;
    userName?: string;
    sandboxPaths?: MemorySandboxPromptPaths;
  },
  target: MemoryTarget,
  errorDetail: string
): LLMMessage[] {
  const layer = memoryPromptLayers(deps.promptStore.get(), target, { includeCommonLayers: true, includeErrorLayer: true })
    .find((entry) => entry.id === memoryErrorLayerId);
  if (!layer) throw new Error("memorize_error_layer_missing");
  return [promptLayerToMessage(layer, memoryPromptRuntime({ ...deps, memorizeErrorDetail: errorDetail }, target))];
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
    memorizeErrorDetail?: string;
  },
  target: MemoryTarget
): PromptContextRuntime {
  const localVariables = memoryPromptVariables(deps, target);
  return {
    renderText(content, options) {
      return content.replace(/\{\{\s*([a-zA-Z0-9_/]+)\s*\}\}/g, (match, key: string) => {
        const resolved = localVariables[key] ?? deps.promptContextRuntime.getVariable(key, options);
        return resolved === undefined || resolved === null || typeof resolved === "object" ? match : String(resolved);
      });
    },
    getVariable(name, options) {
      return localVariables[name] ?? deps.promptContextRuntime.getVariable(name, options);
    },
    listVariables() {
      return [...new Set([...deps.promptContextRuntime.listVariables(), ...Object.keys(localVariables)])];
    }
  };
}

function memoryPromptVariables(
  deps: {
    messages: StoredConversationMessage[];
    windowStartAt?: string;
    windowEndAt: string;
    timezone: string;
    userName?: string;
    sandboxPaths?: MemorySandboxPromptPaths;
    memorizeErrorDetail?: string;
  },
  target: MemoryTarget
): Record<string, PromptContextValue> {
  const variables: Record<string, PromptContextValue> = {
    "memorize/target/fileName": deps.sandboxPaths?.files[target] ?? targetResultFiles[target],
    "memorize/ErrorDetail": deps.memorizeErrorDetail ?? "",
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

function memoryPromptLayers(
  prompts: MemoryInductionPrompts,
  target: MemoryTarget,
  options?: { includeCommonLayers?: boolean; includeErrorLayer?: boolean }
): MemoryPromptLayer[] {
  const targetLayers = target === "persistent"
    ? prompts.persistentLayers
    : target === "userPreferences"
      ? prompts.userPreferencesLayers
      : prompts.yesterdaySummaryLayers;
  const sortEnabled = (layers: MemoryPromptLayer[]) => layers
    .filter((item) => item.enabled !== false)
    .filter((item) => item.id !== memoryErrorLayerId || options?.includeErrorLayer === true)
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
