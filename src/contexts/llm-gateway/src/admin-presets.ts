import { promptStoragePath } from "../../agent-profile/src/adapters/json-prompt-profile-store.js";
import { booleanFromUnknown, isValidHttpUrl, numberFromUnknown, optionalString, parseJsonObject, requiredString } from "../../../shared/admin-input/src/index.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type LLMApiPreset = {
  name: string;
  baseURL: string;
  apiKey?: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  stream: boolean;
  supportsImage?: boolean;
  supportsAudio?: boolean;
  extraParams: Record<string, unknown>;
  followupExtraParams: Record<string, unknown>;
};

export type PromptApiProfile = {
  chatPresetName?: string;
  /** @deprecated accepted only for old prompt-api-profile.json/request bodies. */
  corePresetName?: string;
  talkPresetName?: string;
  memorizePresetName?: string;
};

export type LLMApiPresetView = Omit<LLMApiPreset, "apiKey"> & { apiKeySet: boolean };

export function parseLLMApiPresetBody(context: AdminRoutesContext, body: Record<string, unknown>, name: string): LLMApiPreset | { error: string } {
  const existing = readLLMApiPresets(context).find((entry) => entry.name === name);
  const baseURL = requiredString(body.baseURL);
  const apiKey = optionalString(body.apiKey) ?? existing?.apiKey;
  const model = requiredString(body.model);
  const temperature = numberFromUnknown(body.temperature, existing?.temperature ?? 0.2);
  const timeoutMs = numberFromUnknown(body.timeoutMs, existing?.timeoutMs ?? 60_000);
  const stream = body.stream === undefined ? existing?.stream ?? true : booleanFromUnknown(body.stream);
  const supportsImage = body.supportsImage === undefined ? existing?.supportsImage ?? false : booleanFromUnknown(body.supportsImage);
  const supportsAudio = body.supportsAudio === undefined ? existing?.supportsAudio ?? false : booleanFromUnknown(body.supportsAudio);
  const extraParamsResult = parseJsonObject(optionalString(body.extraParams) ?? "{}");
  const followupExtraParamsResult = parseJsonObject(optionalString(body.followupExtraParams) ?? "{}");
  if (baseURL && !isValidHttpUrl(baseURL)) return { error: "invalid_base_url" };
  if (!model) return { error: "missing_model" };
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) return { error: "invalid_temperature" };
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) return { error: "invalid_timeout_ms" };
  if (!extraParamsResult.ok) return { error: "invalid_extra_params" };
  if (!followupExtraParamsResult.ok) return { error: "invalid_followup_extra_params" };
  return { name, baseURL, apiKey, model, temperature, timeoutMs, stream, supportsImage, supportsAudio, extraParams: extraParamsResult.value, followupExtraParams: followupExtraParamsResult.value };
}

export function readLLMApiPresets(context: AdminRoutesContext): LLMApiPreset[] {
  const filePath = llmApiPresetsPath(context);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { presets?: LLMApiPreset[] } | LLMApiPreset[];
    const presets = Array.isArray(parsed) ? parsed : Array.isArray(parsed.presets) ? parsed.presets : [];
    return sortLLMApiPresets(presets.map(normalizeLLMApiPreset).filter((entry): entry is LLMApiPreset => Boolean(entry)));
  } catch {
    return [];
  }
}

export function writeLLMApiPresets(context: AdminRoutesContext, presets: LLMApiPreset[]): void {
  const filePath = llmApiPresetsPath(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ presets: sortLLMApiPresets(presets) }, null, 2)}\n`);
}

export function sortLLMApiPresets(presets: LLMApiPreset[]): LLMApiPreset[] {
  return [...presets].sort((left, right) => left.name.localeCompare(right.name));
}

export function publicLLMApiPresets(presets: LLMApiPreset[]): LLMApiPresetView[] {
  return presets.map(publicLLMApiPreset);
}

export function publicLLMApiPreset(preset: LLMApiPreset): LLMApiPresetView {
  const { apiKey, ...rest } = preset;
  return { ...rest, apiKeySet: Boolean(apiKey) };
}

export function readPromptApiProfile(context: AdminRoutesContext): PromptApiProfile {
  const filePath = promptApiProfilePath(context);
  if (!fs.existsSync(filePath)) return {};
  try {
    return normalizePromptApiProfile(JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>);
  } catch {
    return {};
  }
}

export function writePromptApiProfile(context: AdminRoutesContext, profile: PromptApiProfile): void {
  const filePath = promptApiProfilePath(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalizePromptApiProfile(profile), null, 2)}\n`);
}

export function normalizePromptApiProfile(value: Record<string, unknown>): PromptApiProfile {
  const chatPresetName = optionalString(value.chatPresetName) ?? optionalString(value.corePresetName);
  return {
    chatPresetName,
    talkPresetName: optionalString(value.talkPresetName),
    memorizePresetName: optionalString(value.memorizePresetName)
  };
}

export function resolvePromptApiPreset(context: AdminRoutesContext, kind: "chat" | "talk" | "memorize"): LLMApiPreset | undefined {
  const profile = readPromptApiProfile(context);
  const name = kind === "chat"
    ? profile.chatPresetName ?? profile.corePresetName
    : kind === "talk"
      ? profile.talkPresetName
      : profile.memorizePresetName;
  if (!name) return undefined;
  return readLLMApiPresets(context).find((entry) => entry.name === name);
}

export function resolveMemorizeApiPreset(context: AdminRoutesContext): LLMApiPreset | undefined {
  return resolvePromptApiPreset(context, "memorize") ?? defaultMemorizeApiPreset(context);
}

function normalizeLLMApiPreset(value: Partial<LLMApiPreset>): LLMApiPreset | undefined {
  if (!value || typeof value !== "object" || !value.name || !value.model) return undefined;
  return {
    name: String(value.name),
    baseURL: typeof value.baseURL === "string" ? value.baseURL : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : undefined,
    model: String(value.model),
    temperature: Number.isFinite(Number(value.temperature)) ? Number(value.temperature) : 0.2,
    timeoutMs: Number.isFinite(Number(value.timeoutMs)) ? Number(value.timeoutMs) : 60_000,
    stream: value.stream !== false,
    supportsImage: value.supportsImage === true,
    supportsAudio: value.supportsAudio === true,
    extraParams: value.extraParams && typeof value.extraParams === "object" && !Array.isArray(value.extraParams) ? value.extraParams : {},
    followupExtraParams: value.followupExtraParams && typeof value.followupExtraParams === "object" && !Array.isArray(value.followupExtraParams) ? value.followupExtraParams : {}
  };
}

function llmApiPresetsPath(context: AdminRoutesContext): string {
  return path.join(context.config.memoryFiles.root, "config", "llm-api-presets.json");
}

function defaultMemorizeApiPreset(context: AdminRoutesContext): LLMApiPreset | undefined {
  const config = context.config.memorySummary;
  if (!config.enabled || !config.model) return undefined;
  return {
    name: "Memory Summary",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    stream: config.stream,
    supportsImage: false,
    supportsAudio: false,
    extraParams: config.extraParams,
    followupExtraParams: config.followupExtraParams
  };
}

function promptApiProfilePath(context: AdminRoutesContext): string {
  return promptStoragePath(context.config.memoryFiles.root, "prompt-api-profile.json", ["config", "prompt-api-profile.json"]);
}
