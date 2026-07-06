const fs = await import("node:fs");
const path = await import("node:path");
import type {
  TtsBailianConversionConfig,
  TtsConversionProvider,
  TtsGeniePresetConfig,
  TtsMimoConversionConfig,
  TtsOpenAiApiConversionConfig,
  TtsPreset,
  TtsPluginConfig,
  TtsPluginDeps,
  TtsRemoteConfig,
  TtsTextFilter,
  TtsTranslationPreset,
  TtsVoiceModelConfig,
  VoiceSynthesizer
} from "./types.js";

import {
  booleanValue,
  normalizeBaseURL,
  numberValue,
  optionalNumberValue,
  parseJsonObject,
  recordValue,
  stringValue,
  ttsReferenceTextValue
} from "./internal.js";

const defaultConfigPath = "config/plugin/tts/config.json";
const ttsPresetAssetRoot = path.join("assets", "tts", "preset");
export const defaultBailianQwenTtsEndpoint = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
export const defaultBailianCosyTtsEndpoint = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";
export const defaultMimoTtsBaseURL = "https://api.xiaomimimo.com/v1";

export function readTtsPluginConfig(configPath = defaultConfigPath): TtsPluginConfig {
  const resolved = path.resolve(configPath);
  const raw = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "{}";
  const parsed = parseJsonObject(raw);
  const translationPresetName = stringValue(parsed.translationPresetName) || "default";
  const translationPresets = ttsTranslationPresetsValue(parsed.translationPresets, translationPresetName);
  const selectedTranslation = selectedTtsTranslationPreset({ translationPresetName, translationPresets });
  const translationEnabled = selectedTranslation.translationEnabled ?? true;
  const selectedPrompt = selectedTranslation.prompt;
  if (translationEnabled && !selectedPrompt) throw new Error("tts translation prompt is required");
  const presets = readTtsPresets(resolved);
  const activePresetName = safeModelConfigName(stringValue(parsed.activePresetName) || "");
  if (!activePresetName) throw new Error("tts activePresetName is required");
  const activePreset = presets[activePresetName];
  if (!activePreset) throw new Error(`tts active preset not found: ${activePresetName}`);
  const corePresetName = safeModelConfigName(stringValue(parsed.corePresetName) || "") || undefined;
  const shellPresetName = safeModelConfigName(stringValue(parsed.shellPresetName) || "") || undefined;
  if (corePresetName && !presets[corePresetName]) throw new Error(`tts core preset not found: ${corePresetName}`);
  if (shellPresetName && !presets[shellPresetName]) throw new Error(`tts shell preset not found: ${shellPresetName}`);
  return {
    enabled: booleanValue(parsed.enabled, false),
    activePresetName,
    corePresetName,
    shellPresetName,
    editPresetName: safeModelConfigName(stringValue(parsed.editPresetName) || "") || activePresetName,
    presets,
    activePreset,
    translationPresetName,
    translationPresets,
    translationEnabled,
    apiPresetName: selectedTranslation.apiPresetName,
    prompt: selectedPrompt ?? ""
  };
}

export function renderTtsPrompt(config: TtsPluginConfig, deps: TtsPluginDeps): string {
  if (!config.prompt.trim()) throw new Error("tts translation prompt is required");
  if (!deps.promptRenderer) throw new Error("tts prompt renderer is required");
  const renderer = typeof deps.promptRenderer === "function" ? deps.promptRenderer() : deps.promptRenderer;
  return renderer.renderText(config.prompt.trim());
}

export function ttsGenieOverrides(config: TtsPluginConfig, alice?: "core" | "shell"): NonNullable<Parameters<VoiceSynthesizer>[0]["genie"]> {
  const model = selectedTtsPreset(config, alice).genie ?? {};
  const presetName = selectedTtsPresetName(config, alice);
  const referenceTextPath = ttsPresetReferenceTextPath(presetName);
  return {
    language: model.language ?? "jp",
    modelDir: model.modelDir || ttsPresetModelDir(presetName),
    referenceAudio: ttsPresetReferenceAudio(presetName),
    referenceText: fs.existsSync(referenceTextPath) ? ttsReferenceTextValue(referenceTextPath) : undefined,
    ...(model.speed !== undefined ? { speed: model.speed } : {}),
    ...(model.partSilenceSeconds !== undefined ? { partSilenceSeconds: model.partSilenceSeconds } : {}),
    splitText: model.splitText ?? false
  };
}

export function selectedTtsVoiceModelConfig(config: TtsPluginConfig, alice?: "core" | "shell"): TtsVoiceModelConfig {
  return selectedTtsPreset(config, alice).genie ?? { language: "jp" };
}

export function selectedTtsVoiceModelConfigName(config: TtsPluginConfig, alice?: "core" | "shell"): string {
  return selectedTtsPresetName(config, alice);
}

export function selectedTtsPreset(config: TtsPluginConfig, alice?: "core" | "shell"): TtsPreset {
  const presetName = selectedTtsPresetName(config, alice);
  const preset = config.presets?.[presetName];
  if (!preset) throw new Error(`tts preset not found: ${presetName}`);
  return preset;
}

export function selectedTtsPresetName(config: TtsPluginConfig, alice?: "core" | "shell"): string {
  const presetName = alice === "core"
    ? config.corePresetName || config.shellPresetName || config.activePresetName
    : alice === "shell"
      ? config.shellPresetName || config.corePresetName || config.activePresetName
      : config.activePresetName || config.shellPresetName || config.corePresetName;
  if (!presetName) throw new Error("tts preset name is required");
  return presetName;
}

export function selectedTtsTranslationPreset(config: Pick<TtsPluginConfig, "translationPresetName" | "translationPresets">): TtsTranslationPreset {
  const presets = config.translationPresets ?? {};
  const selected = config.translationPresetName ? presets[config.translationPresetName] : undefined;
  return selected ?? presets[Object.keys(presets)[0] ?? ""] ?? { translationEnabled: true };
}

function ttsPresetModelDir(name: string): string {
  return path.join(ttsPresetAssetRoot, safeModelConfigName(name) || "jp", "model").split(path.sep).join("/");
}

export function ttsPresetReferenceTextPath(name: string, assetRoot = "assets"): string {
  return path.join(assetRoot, "tts", "preset", safeModelConfigName(name) || "jp", "reference.txt").split(path.sep).join("/");
}

export function ttsPresetReferenceAudio(name: string, assetRoot = "assets"): string | undefined {
  const root = path.join(assetRoot, "tts", "preset", safeModelConfigName(name) || "jp");
  for (const candidate of ["reference.wav", "reference.mp3", "reference.ogg", "reference.opus", "reference.m4a"]) {
    const filePath = path.join(root, candidate);
    if (fs.existsSync(filePath)) return filePath.split(path.sep).join("/");
  }
  try {
    const match = fs.readdirSync(root).find((entry) => /^reference\.[\w-]+$/i.test(entry));
    return match ? path.join(root, match).split(path.sep).join("/") : undefined;
  } catch {
    return undefined;
  }
}

export function resolveEffectivePreset(config: TtsPluginConfig, deps: TtsPluginDeps) {
  return config.apiPresetName ? deps.resolveApiPreset?.(config.apiPresetName) : undefined;
}

export function ttsPresetConfigDir(configPath = defaultConfigPath): string {
  return path.join(path.dirname(path.resolve(configPath)), "presets");
}

export function ttsPresetConfigPath(configPath: string, presetName: string): string {
  return path.join(ttsPresetConfigDir(configPath), `${safeModelConfigName(presetName)}.json`);
}

function readTtsPresets(configPath: string): Record<string, TtsPreset> {
  const dir = ttsPresetConfigDir(configPath);
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      const name = safeModelConfigName(path.basename(entry, ".json"));
      return [name, ttsPresetValue(parseJsonObject(fs.readFileSync(path.join(dir, entry), "utf8")))];
    })
    .filter(([name]) => Boolean(name))) as Record<string, TtsPreset>;
}

function ttsPresetValue(raw: Record<string, unknown>): TtsPreset {
  const provider = ttsConversionProviderValue(raw.provider);
  if (provider === "openai-api") return { provider, openaiApi: ttsOpenAiApiConversionConfigValue(parseJsonObject(raw.openaiApi)) };
  if (provider === "bailian") return { provider, bailian: ttsBailianConversionConfigValue(parseJsonObject(raw.bailian)) };
  if (provider === "mimo") return { provider, mimo: ttsMimoConversionConfigValue(parseJsonObject(raw.mimo)) };
  return { provider: "genie", genie: ttsGeniePresetConfigValue(parseJsonObject(raw.genie)) };
}

function ttsConversionProviderValue(value: unknown): TtsConversionProvider {
  return value === "openai-api" || value === "bailian" || value === "mimo" || value === "genie" ? value : "genie";
}

function ttsGenieConversionConfigValue(raw: Record<string, unknown>): TtsRemoteConfig {
  const textFilters = ttsTextFiltersValue(raw.textFilters);
  return {
    enabled: raw.enabled === undefined ? true : booleanValue(raw.enabled, true),
    baseURL: normalizeBaseURL(stringValue(raw.baseURL) || "http://192.168.0.103:8767"),
    localFallbackEnabled: raw.localFallbackEnabled === undefined ? true : booleanValue(raw.localFallbackEnabled, true),
    ...(textFilters.length ? { textFilters } : {})
  };
}

function ttsGeniePresetConfigValue(raw: Record<string, unknown>): TtsGeniePresetConfig {
  return {
    ...ttsGenieConversionConfigValue(raw),
    language: ttsLanguageValue(raw.language),
    speed: optionalNumberValue(raw.speed),
    partSilenceSeconds: optionalNumberValue(raw.partSilenceSeconds),
    splitText: raw.splitText === undefined ? undefined : booleanValue(raw.splitText, false),
    modelDir: stringValue(raw.modelDir)
  };
}

function ttsOpenAiApiConversionConfigValue(raw: Record<string, unknown>): TtsOpenAiApiConversionConfig {
  const textFilters = ttsTextFiltersValue(raw.textFilters);
  return {
    apiPresetName: stringValue(raw.apiPresetName),
    baseURL: stringValue(raw.baseURL),
    apiKey: stringValue(raw.apiKey),
    apiKeyEnv: stringValue(raw.apiKeyEnv),
    model: stringValue(raw.model) || "higgs-audio-v3-tts",
    voice: stringValue(raw.voice) || "default",
    timeoutMs: numberValue(raw.timeoutMs, 60_000),
    sampleRate: numberValue(raw.sampleRate, 32_000),
    channels: numberValue(raw.channels, 1),
    ...(textFilters.length ? { textFilters } : {}),
    extraParams: recordValue(raw.extraParams)
  };
}

function ttsTextFiltersValue(value: unknown): TtsTextFilter[] {
  if (!Array.isArray(value)) return [];
  const filters: TtsTextFilter[] = [];
  for (const valueEntry of value) {
    const entry = parseJsonObject(valueEntry);
    const pattern = stringValue(entry.pattern);
    if (!pattern) continue;
    filters.push({
      pattern,
      flags: stringValue(entry.flags),
      replacement: stringValue(entry.replacement)
    });
  }
  return filters;
}

function ttsBailianConversionConfigValue(raw: Record<string, unknown>): TtsBailianConversionConfig {
  const service = raw.service === "cosy" ? "cosy" : "qwen";
  const textFilters = ttsTextFiltersValue(raw.textFilters);
  return {
    service,
    endpoint: stringValue(raw.endpoint) || defaultBailianTtsEndpoint(service),
    apiKey: stringValue(raw.apiKey),
    apiKeyEnv: stringValue(raw.apiKeyEnv) || "DASHSCOPE_API_KEY",
    workspaceId: stringValue(raw.workspaceId),
    userAgent: stringValue(raw.userAgent),
    model: stringValue(raw.model) || "qwen3-tts-vc-2026-01-22",
    voice: stringValue(raw.voice) || "Cherry",
    languageType: stringValue(raw.languageType) || "Chinese",
    responseFormat: stringValue(raw.responseFormat) || "pcm",
    sampleRate: numberValue(raw.sampleRate, 24_000),
    channels: numberValue(raw.channels, 1),
    timeoutMs: numberValue(raw.timeoutMs, 60_000),
    ...(textFilters.length ? { textFilters } : {}),
    extraParams: recordValue(raw.extraParams)
  };
}

function ttsMimoConversionConfigValue(raw: Record<string, unknown>): TtsMimoConversionConfig {
  const mode = raw.mode === "voicedesign" || raw.mode === "voiceclone" ? raw.mode : "preset";
  const textFilters = ttsTextFiltersValue(raw.textFilters);
  return {
    mode,
    baseURL: stringValue(raw.baseURL) || defaultMimoTtsBaseURL,
    apiKey: stringValue(raw.apiKey),
    apiKeyEnv: stringValue(raw.apiKeyEnv) || "MIMO_API_KEY",
    voice: stringValue(raw.voice) || "mimo_default",
    voiceDesignPrompt: stringValue(raw.voiceDesignPrompt),
    voiceCloneAudioDataUrl: stringValue(raw.voiceCloneAudioDataUrl),
    audioFormat: raw.audioFormat === "pcm16" ? "pcm16" : "wav",
    timeoutMs: numberValue(raw.timeoutMs, 60_000),
    sampleRate: numberValue(raw.sampleRate, 24_000),
    channels: numberValue(raw.channels, 1),
    ...(textFilters.length ? { textFilters } : {}),
    extraParams: recordValue(raw.extraParams)
  };
}

export function defaultMimoTtsModel(mode: "preset" | "voicedesign" | "voiceclone" | undefined): string {
  if (mode === "voicedesign") return "mimo-v2.5-tts-voicedesign";
  if (mode === "voiceclone") return "mimo-v2.5-tts-voiceclone";
  return "mimo-v2.5-tts";
}

export function defaultBailianTtsEndpoint(service: "qwen" | "cosy" | undefined): string {
  return service === "cosy" ? defaultBailianCosyTtsEndpoint : defaultBailianQwenTtsEndpoint;
}

export function selectedTtsConversionProvider(config: TtsPluginConfig, alice?: "core" | "shell"): TtsConversionProvider {
  const provider = selectedTtsPreset(config, alice).provider;
  return provider === "openai-api" || provider === "bailian" || provider === "mimo" ? provider : "genie";
}

export function ttsProviderTextFilters(conversion: TtsConversionProvider, config: TtsPluginConfig, alice?: "core" | "shell"): TtsTextFilter[] {
  const preset = selectedTtsPreset(config, alice);
  if (conversion === "openai-api") return preset.openaiApi?.textFilters ?? [];
  if (conversion === "bailian") return preset.bailian?.textFilters ?? [];
  if (conversion === "mimo") return preset.mimo?.textFilters ?? [];
  return preset.genie?.textFilters ?? [];
}

export function applyTtsTextFilters(text: string, filters: TtsTextFilter[]): string {
  let next = text;
  for (const filter of filters) {
    next = next.replace(new RegExp(filter.pattern, filter.flags), filter.replacement ?? "");
  }
  return next;
}

function ttsLanguageValue(value: unknown): "jp" | "zh" | "en" {
  return value === "zh" || value === "en" ? value : "jp";
}

function ttsTranslationPresetsValue(value: unknown, fallbackName: string): Record<string, TtsTranslationPreset> {
  const raw = parseJsonObject(value);
  const entries = Object.fromEntries(Object.entries(raw)
    .map(([name, entry]) => [safeModelConfigName(name), ttsTranslationPresetValue(entry)])
    .filter(([name]) => Boolean(name))) as Record<string, TtsTranslationPreset>;
  if (Object.keys(entries).length > 0) return entries;
  return { [safeModelConfigName(fallbackName) || "default"]: { translationEnabled: false } };
}

function ttsTranslationPresetValue(value: unknown): TtsTranslationPreset {
  const raw = parseJsonObject(value);
  return {
    translationEnabled: raw.translationEnabled === undefined ? undefined : booleanValue(raw.translationEnabled, true),
    apiPresetName: stringValue(raw.apiPresetName),
    prompt: stringValue(raw.prompt)
  };
}

function safeModelConfigName(value: string): string {
  return value.trim().replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}
