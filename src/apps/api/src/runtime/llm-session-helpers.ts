import type { TokenPressurePreviewBaseline } from "../../../../core/agent/src/index.js";
import type { LLMChatInput } from "../../../../core/llm/src/index.js";
import type { LLMSessionRequestInfo, LLMSessionResponseInfo, LLMSessionRoundInfo } from "./llm-session-types.js";

export function cloneLLMTools(tools: LLMChatInput["tools"] | undefined): LLMChatInput["tools"] | undefined {
  return cloneJsonObject(tools);
}

export function cloneJsonObject<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneTokenPressurePreviewBaselines(value: Record<string, TokenPressurePreviewBaseline> | undefined): Record<string, TokenPressurePreviewBaseline> {
  return cloneJsonObject(value) ?? {};
}

export function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === "number") : [];
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function parseTokenPressurePreviewBaselines(value: unknown): Record<string, TokenPressurePreviewBaseline> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, TokenPressurePreviewBaseline> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    result[key] = {
      inputTokens: typeof entry.inputTokens === "number" ? entry.inputTokens : 0,
      previewTokens: typeof entry.previewTokens === "number" ? entry.previewTokens : 0
    };
  }
  return result;
}

export function parseRoundInfo(value: unknown): LLMSessionRoundInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as LLMSessionRoundInfo;
  if (typeof entry.round !== "number") return undefined;
  if (entry.status !== "running" && entry.status !== "finished" && entry.status !== "interrupted") return undefined;
  return {
    status: entry.status,
    round: entry.round,
    startedAt: entry.startedAt,
    startedAtUtc: entry.startedAtUtc,
    finishedAt: entry.finishedAt,
    finishedAtUtc: entry.finishedAtUtc,
    model: entry.model,
    temperature: entry.temperature,
    tools: cloneLLMTools(entry.tools),
    extraParams: cloneJsonObject(entry.extraParams)
  };
}

export function parseRequestInfo(value: unknown): LLMSessionRequestInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as LLMSessionRequestInfo;
  if (typeof entry.round !== "number" || typeof entry.messageCount !== "number") return undefined;
  return {
    time: entry.time,
    timeUtc: entry.timeUtc,
    round: entry.round,
    model: entry.model,
    temperature: entry.temperature,
    tools: cloneLLMTools(entry.tools),
    extraParams: cloneJsonObject(entry.extraParams),
    messageCount: entry.messageCount
  };
}

export function parseResponseInfo(value: unknown): LLMSessionResponseInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as LLMSessionResponseInfo;
  if (typeof entry.round !== "number") return undefined;
  return {
    time: entry.time,
    timeUtc: entry.timeUtc,
    round: entry.round,
    finishReason: entry.finishReason,
    usage: entry.usage,
    toolCallCount: typeof entry.toolCallCount === "number" ? entry.toolCallCount : 0
  };
}
