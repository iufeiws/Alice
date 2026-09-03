import { createOpenAICompatibleClient, type LLMClient } from "./index.js";
import { createOpenAIResponsesClient } from "./openai-responses-client.js";
import { resolveCredentialAuthorization } from "./credential-runtime.js";
import { normalizeLLMApiPreset, type LLMApiPreset } from "./llm-api-preset.js";
import { promptStoragePath } from "../../../contexts/agent-profile/src/adapters/json-prompt-profile-store.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type { LLMApiPreset, LLMProtocol } from "./llm-api-preset.js";

export type PromptApiProfile = {
  chatPresetName?: string;
  talkPresetName?: string;
  memorizePresetName?: string;
};

export function createPromptApiPresetStore(memoryRoot: string) {
  return { readPromptApiProfile, readLLMApiPresets, resolvePromptApiPreset };

  function resolvePromptApiPreset(kind: "chat" | "talk" | "memorize"): LLMApiPreset | undefined {
    const profile = readPromptApiProfile();
    const name = kind === "chat" ? profile.chatPresetName : kind === "talk" ? profile.talkPresetName : profile.memorizePresetName;
    return name ? readLLMApiPresets().find((entry) => entry.name === name) : undefined;
  }

  function readPromptApiProfile(): PromptApiProfile {
    const filePath = promptStoragePath(memoryRoot, "prompt-api-profile.json");
    if (!fs.existsSync(filePath)) return {};
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return {
      chatPresetName: nonEmptyString(value.chatPresetName),
      talkPresetName: nonEmptyString(value.talkPresetName),
      memorizePresetName: nonEmptyString(value.memorizePresetName)
    };
  }

  function readLLMApiPresets(): LLMApiPreset[] {
    const filePath = path.join(memoryRoot, "config", "llm-api-presets.json");
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { schemaVersion?: number; presets?: unknown[] };
    if (parsed.schemaVersion !== 2) throw new Error("llm_api_presets_migration_required");
    if (!Array.isArray(parsed.presets)) throw new Error("llm_api_presets_invalid");
    return parsed.presets.map((value) => {
      const preset = normalizeLLMApiPreset(value);
      if (!preset) throw new Error("llm_api_preset_invalid");
      return preset;
    });
  }
}

export function createLLMClientFromPreset(preset: LLMApiPreset): LLMClient | undefined {
  if (!preset.baseURL || !preset.credentialId) return undefined;
  const authorization = resolveCredentialAuthorization(preset.credentialId);
  const config = {
    baseURL: preset.baseURL,
    authorization,
    model: preset.model,
    temperature: preset.temperature,
    timeoutMs: preset.timeoutMs,
    useProxy: preset.useProxy === true,
    extraParams: preset.extraParams
  };
  return preset.protocol === "openai-responses"
    ? createOpenAIResponsesClient(config)
    : createOpenAICompatibleClient(config);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
