import { createOpenAICompatibleClient } from "./index.js";
import { promptStoragePath } from "../../../contexts/agent-profile/src/adapters/json-prompt-profile-store.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type LLMApiPreset = {
  name: string;
  baseURL: string;
  apiKey?: string;
  model: string;
  temperature: number;
  maxTokens?: number;
  timeoutMs: number;
  stream: boolean;
  supportsImage: boolean;
  supportsAudio: boolean;
  extraParams: Record<string, unknown>;
  followupExtraParams: Record<string, unknown>;
};

export type PromptApiProfile = {
  chatPresetName?: string;
  talkPresetName?: string;
  memorizePresetName?: string;
};

export function createPromptApiPresetStore(memoryRoot: string) {
  return {
    readPromptApiProfile,
    readLLMApiPresets,
    resolvePromptApiPreset
  };

  function resolvePromptApiPreset(kind: "chat" | "talk" | "memorize"): LLMApiPreset | undefined {
    const profile = readPromptApiProfile();
    const name = kind === "chat"
      ? profile.chatPresetName
      : kind === "talk"
        ? profile.talkPresetName
        : profile.memorizePresetName;
    if (!name) return undefined;
    return readLLMApiPresets().find((entry) => entry.name === name);
  }

  function readPromptApiProfile(): PromptApiProfile {
    const filePath = promptStoragePath(memoryRoot, "prompt-api-profile.json");
    if (!fs.existsSync(filePath)) return {};
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
      return {
        chatPresetName: typeof value.chatPresetName === "string" && value.chatPresetName ? value.chatPresetName : undefined,
        talkPresetName: typeof value.talkPresetName === "string" && value.talkPresetName ? value.talkPresetName : undefined,
        memorizePresetName: typeof value.memorizePresetName === "string" && value.memorizePresetName ? value.memorizePresetName : undefined
      };
    } catch {
      return {};
    }
  }

  function readLLMApiPresets(): LLMApiPreset[] {
    const filePath = path.join(memoryRoot, "config", "llm-api-presets.json");
    if (!fs.existsSync(filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { presets?: Partial<LLMApiPreset>[] };
      const presets = Array.isArray(parsed.presets) ? parsed.presets : [];
      return presets.map(normalizeLLMApiPreset).filter((entry): entry is LLMApiPreset => Boolean(entry));
    } catch {
      return [];
    }
  }
}

export function createLLMClientFromPreset(preset: LLMApiPreset): ReturnType<typeof createOpenAICompatibleClient> | undefined {
  if (!preset.baseURL || !preset.apiKey) return undefined;
  return createOpenAICompatibleClient({
    baseURL: preset.baseURL,
    apiKey: preset.apiKey,
    model: preset.model,
    temperature: preset.temperature,
    timeoutMs: preset.timeoutMs,
    extraParams: preset.extraParams
  });
}

function normalizeLLMApiPreset(value: Partial<LLMApiPreset>): LLMApiPreset | undefined {
  if (!value || typeof value !== "object" || !value.name || !value.model) return undefined;
  return {
    name: String(value.name),
    baseURL: typeof value.baseURL === "string" ? value.baseURL : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : undefined,
    model: String(value.model),
    temperature: Number.isFinite(Number(value.temperature)) ? Number(value.temperature) : 0.2,
    maxTokens: Number.isInteger(Number(value.maxTokens)) && Number(value.maxTokens) > 0 ? Number(value.maxTokens) : undefined,
    timeoutMs: Number.isFinite(Number(value.timeoutMs)) ? Number(value.timeoutMs) : 60_000,
    stream: value.stream !== false,
    supportsImage: value.supportsImage === true,
    supportsAudio: value.supportsAudio === true,
    extraParams: value.extraParams && typeof value.extraParams === "object" && !Array.isArray(value.extraParams) ? value.extraParams : {},
    followupExtraParams: value.followupExtraParams && typeof value.followupExtraParams === "object" && !Array.isArray(value.followupExtraParams) ? value.followupExtraParams : {}
  };
}
