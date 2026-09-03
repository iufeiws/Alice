import type { LLMApiPreset } from "./admin-presets.js";

export type PiPresetSnapshot = {
  name: string;
  protocol: LLMApiPreset["protocol"];
  credentialId: string;
  baseURL: string;
  model: string;
  temperature: number;
  maxTokens?: number;
  timeoutMs: number;
  stream: boolean;
  useProxy: boolean;
  supportsImage: boolean;
  extraParams: Record<string, unknown>;
};

export function createPiPresetSnapshot(preset: LLMApiPreset): PiPresetSnapshot {
  return {
    name: preset.name,
    protocol: preset.protocol,
    credentialId: preset.credentialId,
    baseURL: preset.baseURL.replace(/\/+$/, ""),
    model: preset.model,
    temperature: preset.temperature,
    maxTokens: preset.maxTokens,
    timeoutMs: preset.timeoutMs,
    stream: preset.stream,
    useProxy: preset.useProxy === true,
    supportsImage: preset.supportsImage === true,
    extraParams: { ...preset.extraParams }
  };
}
