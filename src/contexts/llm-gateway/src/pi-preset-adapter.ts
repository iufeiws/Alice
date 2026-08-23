import type { LLMApiPreset } from "./admin-presets.js";

export type PiPresetSnapshot = {
  name: string;
  baseURL: string;
  apiKey?: string;
  model: string;
  temperature: number;
  maxTokens?: number;
  timeoutMs: number;
  useProxy: boolean;
  supportsImage: boolean;
  extraParams: Record<string, unknown>;
};

export function createPiPresetSnapshot(preset: LLMApiPreset): PiPresetSnapshot {
  return {
    name: preset.name,
    baseURL: preset.baseURL.replace(/\/+$/, ""),
    apiKey: preset.apiKey,
    model: preset.model,
    temperature: preset.temperature,
    maxTokens: preset.maxTokens,
    timeoutMs: preset.timeoutMs,
    useProxy: preset.useProxy === true,
    supportsImage: preset.supportsImage === true,
    extraParams: { ...preset.extraParams }
  };
}
