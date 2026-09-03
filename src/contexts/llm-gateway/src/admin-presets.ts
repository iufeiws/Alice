import { promptStoragePath } from "../../agent-profile/src/adapters/json-prompt-profile-store.js";
import { booleanFromUnknown, isValidHttpUrl, numberFromUnknown, optionalString, parseJsonObject, requiredString } from "../../../shared/admin-input/src/index.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";
import { normalizeLLMApiPreset, type LLMApiPreset, type LLMProtocol } from "./llm-api-preset.js";

export type { LLMApiPreset, LLMProtocol } from "./llm-api-preset.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type PromptApiProfile = {
  chatPresetName?: string;
  talkPresetName?: string;
  memorizePresetName?: string;
};

export type LLMApiPresetView = LLMApiPreset;

export function parseLLMApiPresetBody(context: AdminRoutesContext, body: Record<string, unknown>, name: string): LLMApiPreset | { error: string } {
  const existing = readLLMApiPresets(context).find((entry) => entry.name === name);
  const baseURL = requiredString(body.baseURL);
  const protocol = optionalString(body.protocol) as LLMProtocol | undefined ?? existing?.protocol ?? "openai-chat-completions";
  const credentialId = optionalString(body.credentialId) ?? existing?.credentialId ?? "";
  const model = requiredString(body.model);
  const temperature = numberFromUnknown(body.temperature, existing?.temperature ?? 0.2);
  const maxTokens = body.maxTokens === undefined
    ? existing?.maxTokens
    : body.maxTokens === null || body.maxTokens === ""
      ? undefined
      : numberFromUnknown(body.maxTokens, Number.NaN);
  const timeoutMs = numberFromUnknown(body.timeoutMs, existing?.timeoutMs ?? 60_000);
  const stream = body.stream === undefined ? existing?.stream ?? true : booleanFromUnknown(body.stream);
  const useProxy = body.useProxy === undefined ? existing?.useProxy ?? false : booleanFromUnknown(body.useProxy);
  const supportsImage = body.supportsImage === undefined ? existing?.supportsImage ?? false : booleanFromUnknown(body.supportsImage);
  const supportsAudio = body.supportsAudio === undefined ? existing?.supportsAudio ?? false : booleanFromUnknown(body.supportsAudio);
  const extraParamsResult = parseJsonObject(optionalString(body.extraParams) ?? "{}");
  const followupExtraParamsResult = parseJsonObject(optionalString(body.followupExtraParams) ?? "{}");
  if (baseURL && !isValidHttpUrl(baseURL)) return { error: "invalid_base_url" };
  if (protocol !== "openai-chat-completions" && protocol !== "openai-responses") return { error: "invalid_protocol" };
  if (!credentialId) return { error: "missing_credential" };
  if (!model) return { error: "missing_model" };
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) return { error: "invalid_temperature" };
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) return { error: "invalid_max_tokens" };
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) return { error: "invalid_timeout_ms" };
  if (!extraParamsResult.ok) return { error: "invalid_extra_params" };
  if (!followupExtraParamsResult.ok) return { error: "invalid_followup_extra_params" };
  return { name, protocol, credentialId, baseURL, model, temperature, maxTokens, timeoutMs, stream, useProxy, supportsImage, supportsAudio, extraParams: extraParamsResult.value, followupExtraParams: followupExtraParamsResult.value };
}

export function readLLMApiPresets(context: AdminRoutesContext): LLMApiPreset[] {
  const filePath = llmApiPresetsPath(context);
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { schemaVersion?: number; presets?: unknown[] };
  if (parsed.schemaVersion !== 2) throw new Error("llm_api_presets_migration_required");
  if (!Array.isArray(parsed.presets)) throw new Error("llm_api_presets_invalid");
  return sortLLMApiPresets(parsed.presets.map((value) => {
    const preset = normalizeLLMApiPreset(value);
    if (!preset) throw new Error("llm_api_preset_invalid");
    return preset;
  }));
}

export function writeLLMApiPresets(context: AdminRoutesContext, presets: LLMApiPreset[]): void {
  const filePath = llmApiPresetsPath(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ schemaVersion: 2, presets: sortLLMApiPresets(presets) }, null, 2)}\n`);
}

export function sortLLMApiPresets(presets: LLMApiPreset[]): LLMApiPreset[] {
  return [...presets].sort((left, right) => left.name.localeCompare(right.name));
}

export function publicLLMApiPresets(presets: LLMApiPreset[]): LLMApiPresetView[] {
  return presets.map(publicLLMApiPreset);
}

export function publicLLMApiPreset(preset: LLMApiPreset): LLMApiPresetView {
  return { ...preset };
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
  return {
    chatPresetName: optionalString(value.chatPresetName),
    talkPresetName: optionalString(value.talkPresetName),
    memorizePresetName: optionalString(value.memorizePresetName)
  };
}

export function resolvePromptApiPreset(context: AdminRoutesContext, kind: "chat" | "talk" | "memorize"): LLMApiPreset | undefined {
  const profile = readPromptApiProfile(context);
  const name = kind === "chat"
    ? profile.chatPresetName
    : kind === "talk"
      ? profile.talkPresetName
      : profile.memorizePresetName;
  if (!name) return undefined;
  return readLLMApiPresets(context).find((entry) => entry.name === name);
}

export function resolveMemorizeApiPreset(context: AdminRoutesContext): LLMApiPreset | undefined {
  return resolvePromptApiPreset(context, "memorize") ?? defaultMemorizeApiPreset(context);
}

function llmApiPresetsPath(context: AdminRoutesContext): string {
  return path.join(context.config.memoryFiles.root, "config", "llm-api-presets.json");
}

function defaultMemorizeApiPreset(context: AdminRoutesContext): LLMApiPreset | undefined {
  const config = context.config.memorySummary;
  if (!config.enabled || !config.model) return undefined;
  return {
    name: "Memory Summary",
    protocol: "openai-chat-completions",
    credentialId: "env:memory-summary",
    baseURL: config.baseURL,
    model: config.model,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    stream: config.stream,
    useProxy: false,
    supportsImage: false,
    supportsAudio: false,
    extraParams: config.extraParams,
    followupExtraParams: config.followupExtraParams
  };
}

function promptApiProfilePath(context: AdminRoutesContext): string {
  return promptStoragePath(context.config.memoryFiles.root, "prompt-api-profile.json");
}
