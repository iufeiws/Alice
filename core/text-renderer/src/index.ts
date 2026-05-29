import type { CurrentTimeProvider } from "../../time/src/index.js";
import type { AgentEvent, ToolResult } from "../../../packages/types/src/index.js";

export type LLMTextPrimitive = string | number | boolean | null | undefined;
export type LLMTextValue = LLMTextPrimitive | LLMTextValue[] | { [key: string]: LLMTextValue };

export type LLMTextVariables = { [key: string]: LLMTextValue };

export type LLMTextShellOption = {
  id: string;
  name: string;
  content: string;
  group?: string;
  imageUrl?: string;
};

export type LLMTextDailyShell = {
  date: string;
  createdAt: string;
  personality: LLMTextShellOption;
  relationship: LLMTextShellOption;
  outfit: LLMTextShellOption;
};

export type LLMTextContextInput = {
  userName?: string;
  time?: CurrentTimeProvider;
  event?: AgentEvent;
  dailyShell?: string;
  dailyShellRaw?: LLMTextDailyShell;
  appearanceDescription?: string;
  extra?: LLMTextVariables;
};

export function buildLLMTextVariables(input: LLMTextContextInput = {}): LLMTextVariables {
  const variables: LLMTextVariables = {};
  if (input.time) {
    const now = input.time.now();
    variables.date_time = formatLocalDateTime(now.date, input.time.timeZone);
    variables.time = formatLocalTime(now.date, input.time.timeZone);
    variables.date = formatLocalDate(now.date, input.time.timeZone);
    variables.timezone = input.time.timeZone;
  }
  variables.user = input.userName?.trim() || "user";
  variables.appearance = input.appearanceDescription?.trim() || "";
  if (input.dailyShellRaw) {
    variables.dailyShell = {
      date: input.dailyShellRaw.date,
      createdAt: input.dailyShellRaw.createdAt,
      persona: optionVariable(input.dailyShellRaw.personality),
      relationship: optionVariable(input.dailyShellRaw.relationship)
    };
    variables.outfit = optionVariable(input.dailyShellRaw.outfit);
  }
  if (input.event) {
    variables.session = input.event.session.sessionId;
    variables.channel = input.event.source.channelId ?? input.event.source.userId ?? input.event.session.sessionId;
  }
  return {
    ...variables,
    ...(input.extra ?? {})
  };
}

export function renderLLMText(content: string, variables: LLMTextVariables = {}): string {
  return content.replace(/\{\{\s*([a-zA-Z0-9_/]+)\s*\}\}/g, (match, key: string) => {
    const resolved = resolveVariablePath(variables, key);
    return resolved === undefined || resolved === null || typeof resolved === "object" ? match : String(resolved);
  });
}

export function renderLLMValue<T>(value: T, variables: LLMTextVariables = {}): T {
  return renderLLMValueInner(value, variables, new WeakSet<object>());
}

function renderLLMValueInner<T>(value: T, variables: LLMTextVariables, seen: WeakSet<object>): T {
  if (typeof value === "string") return renderLLMText(value, variables) as T;
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]" as T;
    seen.add(value);
    return value.map((entry) => renderLLMValueInner(entry, variables, seen)) as T;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]" as T;
    seen.add(value);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, renderLLMValueInner(entry, variables, seen)])) as T;
  }
  return value;
}

export function formatToolResultForLLM(result: Pick<ToolResult, "ok" | "output" | "error">, variables: LLMTextVariables = {}): string {
  return stringifyToolResult(result, variables);
}

function stringifyToolResult(result: Pick<ToolResult, "ok" | "output" | "error">, variables: LLMTextVariables): string {
  if (!result.ok && typeof result.output === "string") return renderLLMText(result.output, variables);
  if (!result.ok) return result.error ? `error: ${renderLLMText(result.error, variables)}` : "error";
  if (typeof result.output === "string") return renderLLMText(result.output, variables);
  if (result.output === undefined || result.output === null) return "ok";
  if (typeof result.output === "number" || typeof result.output === "boolean") return String(result.output);
  try {
    return JSON.stringify(renderLLMValue(result.output as LLMTextValue, variables));
  } catch {
    return String(result.output);
  }
}

function optionVariable(option: LLMTextShellOption): LLMTextVariables {
  return {
    id: option.id,
    name: option.name,
    content: option.content,
    ...(option.group ? { group: option.group } : {}),
    ...(option.imageUrl ? { imageUrl: option.imageUrl } : {})
  };
}

function resolveVariablePath(variables: LLMTextVariables, path: string): LLMTextValue {
  return path.split("/").reduce<LLMTextValue>((current, segment) => {
    if (!segment || !current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return current[segment];
  }, variables);
}

function formatLocalDateTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function formatLocalDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatLocalTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}:${values.second}`;
}
