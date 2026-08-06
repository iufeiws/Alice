import type { LLMApiPreset } from "./admin-presets.js";

const allowedExtraParams = new Set([
  "top_p",
  "top_k",
  "min_p",
  "presence_penalty",
  "frequency_penalty",
  "repetition_penalty",
  "seed",
  "stop",
  "reasoning_effort",
  "thinking"
]);

const forbiddenExtraParams = new Set([
  "tool_choice",
  "tools",
  "stream",
  "stream_options",
  "messages",
  "model",
  "max_tokens",
  "max_completion_tokens",
  "authorization",
  "api_key",
  "base_url"
]);

export type PiPresetSnapshot = {
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens?: number;
  timeoutMs: number;
  supportsImage: boolean;
  extraParams: Record<string, unknown>;
};

export type PiModelConfig = {
  id: string;
  api: "openai-completions";
  baseUrl: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  temperature?: number;
  maxTokens?: number;
};

export function createPiPresetSnapshot(preset: LLMApiPreset): PiPresetSnapshot {
  assertPiPresetCompatible(preset);
  if (!preset.baseURL) throw new Error("pi_preset_missing_base_url");
  if (!preset.apiKey) throw new Error("pi_preset_missing_api_key");
  return {
    name: preset.name,
    baseURL: preset.baseURL.replace(/\/+$/, ""),
    apiKey: preset.apiKey,
    model: preset.model,
    temperature: preset.temperature,
    maxTokens: preset.maxTokens,
    timeoutMs: preset.timeoutMs,
    supportsImage: preset.supportsImage === true,
    extraParams: { ...preset.extraParams }
  };
}
export function assertPiPresetCompatible(preset: Pick<LLMApiPreset, "extraParams" | "followupExtraParams">): void {
  for (const [name, value] of Object.entries(preset.extraParams ?? {})) {
    if (forbiddenExtraParams.has(name) || !allowedExtraParams.has(name)) {
      throw new Error(`pi_preset_incompatible_extra_param:${name}`);
    }
    if (value === undefined) throw new Error(`pi_preset_invalid_extra_param:${name}`);
  }
  if (Object.keys(preset.followupExtraParams ?? {}).length > 0) {
    throw new Error("pi_preset_followup_extra_params_unsupported");
  }
}

export function piModelConfig(snapshot: PiPresetSnapshot, relayUrl: string): PiModelConfig {
  return {
    id: snapshot.model,
    api: "openai-completions",
    baseUrl: relayUrl.replace(/\/+$/, ""),
    reasoning: typeof snapshot.extraParams.reasoning_effort === "string"
      || (snapshot.extraParams.thinking !== undefined && snapshot.extraParams.thinking !== false),
    input: snapshot.supportsImage ? ["text", "image"] : ["text"],
    temperature: snapshot.temperature,
    maxTokens: snapshot.maxTokens
  };
}
