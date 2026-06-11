import { renderLLMText } from "../../../contexts/agent-profile/src/application/llm-text-renderer.js";
const fs = await import("node:fs");
const path = await import("node:path");
import type {
  ConfiguredVoiceSynthesizerDeps,
  FallbackVoiceSynthesizerDeps,
  MossOnnxVoiceSynthesizerDeps,
  TTSConfig,
  TtsApiPreset,
  TtsAudioTextChunk,
  TtsBailianConversionConfig,
  TtsConversionConfig,
  TtsOpenAiApiConversionConfig,
  TtsPlugin,
  TtsPluginConfig,
  TtsPluginDeps,
  TtsStreamChunk,
  TtsStreamInput,
  TtsSynthesizer,
  TtsTranslationPreset,
  TtsVoiceModelConfig,
  VoiceSynthesisInput,
  VoiceSynthesizer
} from "./types.js";

import {
  booleanValue,
  normalizeBaseURL,
  numberValue,
  optionalNumberValue,
  parseJsonObject,
  recordValue,
  resolveAssetScopedPath,
  stringValue,
  ttsReferenceTextValue
} from "./internal.js";

const defaultConfigPath = "config/plugin/tts/config.json";
const legacyTtsConfigPath = "src/channels/tts/config.json";
const ttsPresetAssetRoot = path.join("assets", "tts", "preset");
export const defaultBailianQwenTtsEndpoint = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
export const defaultBailianCosyTtsEndpoint = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";

export function readTtsPluginConfig(configPath = defaultConfigPath): TtsPluginConfig {
  const resolved = resolveTtsConfigReadPath(configPath);
  const raw = resolved ? fs.readFileSync(resolved, "utf8") : "{}";
  const parsed = parseJsonObject(raw);
  const preset = parseJsonObject(parsed.api_preset);
  const remote = parseJsonObject(parsed.remote);
  const conversion = ttsConversionConfigValue(parsed.conversion, remote);
  const legacyPrompt = stringValue(parsed.prompt) || defaultPrompt();
  const translationPresetName = stringValue(parsed.translationPresetName) || "default";
  const translationPresets = ttsTranslationPresetsValue(parsed.translationPresets, translationPresetName, {
    translationEnabled: booleanValue(parsed.translationEnabled, true),
    apiPresetName: stringValue(parsed.apiPresetName) || stringValue(preset.name),
    prompt: legacyPrompt
  });
  const selectedTranslation = selectedTtsTranslationPreset({ translationPresetName, translationPresets });
  const voice = parseJsonObject(parsed.voice);
  const modelConfigName = stringValue(voice.modelConfigName) || ttsLanguageValue(voice.language);
  const modelConfigs = ttsModelConfigsValue(voice.modelConfigs, modelConfigName, {
    language: ttsLanguageValue(voice.language),
    speed: optionalNumberValue(voice.speed),
    partSilenceSeconds: optionalNumberValue(voice.partSilenceSeconds),
    splitText: voice.splitText === undefined ? undefined : booleanValue(voice.splitText, false),
    modelDir: stringValue(voice.modelDir),
    referenceAudio: stringValue(voice.referenceAudio),
    referenceText: stringValue(voice.referenceText)
  });
  return {
    enabled: booleanValue(parsed.enabled, false),
    remote: {
      enabled: conversion.genie?.enabled ?? true,
      baseURL: conversion.genie?.baseURL ?? normalizeBaseURL("http://192.168.0.103:8767")
    },
    conversion,
    translationPresetName,
    translationPresets,
    translationEnabled: selectedTranslation.translationEnabled ?? true,
    apiPresetName: selectedTranslation.apiPresetName,
    api_preset: {
      name: stringValue(preset.name),
      baseURL: stringValue(preset.baseURL) || "",
      apiKey: stringValue(preset.apiKey),
      apiKeyEnv: stringValue(preset.apiKeyEnv),
      model: stringValue(preset.model) || "flash",
      temperature: numberValue(preset.temperature, 0.2),
      timeoutMs: numberValue(preset.timeoutMs, 60_000),
      extraParams: recordValue(preset.extraParams)
    },
    prompt: selectedTranslation.prompt || legacyPrompt,
    voice: {
      modelConfigName,
      modelConfigs
    }
  };
}

function resolveTtsConfigReadPath(configPath = defaultConfigPath): string | undefined {
  const resolved = path.resolve(configPath);
  if (fs.existsSync(resolved)) return resolved;
  const defaultResolved = path.resolve(defaultConfigPath);
  const legacyTtsResolved = path.resolve(legacyTtsConfigPath);
  if (resolved === defaultResolved && fs.existsSync(legacyTtsResolved)) return legacyTtsResolved;
  const parsed = path.parse(resolved);
  const expectedSuffix = path.join("config", "plugin", "tts", "config.json");
  if (resolved.endsWith(expectedSuffix)) {
    const root = resolved.slice(0, -expectedSuffix.length);
    const siblingLegacyTts = path.join(root || parsed.root, "plugins", "tts", "config.json");
    if (fs.existsSync(siblingLegacyTts)) return siblingLegacyTts;
  }
  return undefined;
}

export function renderTtsPrompt(config: TtsPluginConfig, deps: TtsPluginDeps): string {
  const variables = typeof deps.promptVariables === "function" ? deps.promptVariables() : deps.promptVariables;
  return renderLLMText(config.prompt.trim(), variables ?? {});
}

export function ttsGenieOverrides(config: TtsPluginConfig): NonNullable<Parameters<VoiceSynthesizer>[0]["genie"]> {
  const model = selectedTtsVoiceModelConfig(config);
  const modelPresetName = selectedTtsVoiceModelConfigName(config);
  const referenceTextPath = ttsPresetReferenceText(modelPresetName);
  return {
    language: model.language ?? "jp",
    modelDir: ttsPresetModelDir(modelPresetName),
    referenceAudio: ttsPresetReferenceAudio(modelPresetName),
    referenceText: fs.existsSync(referenceTextPath) ? ttsReferenceTextValue(referenceTextPath) : undefined,
    ...(model.speed !== undefined ? { speed: model.speed } : {}),
    ...(model.partSilenceSeconds !== undefined ? { partSilenceSeconds: model.partSilenceSeconds } : {}),
    splitText: model.splitText ?? false
  };
}

export function selectedTtsVoiceModelConfig(config: TtsPluginConfig): TtsVoiceModelConfig {
  const voice = config.voice ?? {};
  const modelConfigs = voice.modelConfigs ?? {};
  const selected = voice.modelConfigName ? modelConfigs[voice.modelConfigName] : undefined;
  return selected ?? modelConfigs[Object.keys(modelConfigs)[0] ?? ""] ?? { language: "jp" };
}

export function selectedTtsVoiceModelConfigName(config: TtsPluginConfig): string {
  const voice = config.voice ?? {};
  const modelConfigs = voice.modelConfigs ?? {};
  return voice.modelConfigName || Object.keys(modelConfigs)[0] || "jp";
}

export function selectedTtsTranslationPreset(config: Pick<TtsPluginConfig, "translationPresetName" | "translationPresets">): TtsTranslationPreset {
  const presets = config.translationPresets ?? {};
  const selected = config.translationPresetName ? presets[config.translationPresetName] : undefined;
  return selected ?? presets[Object.keys(presets)[0] ?? ""] ?? { translationEnabled: true, prompt: defaultPrompt() };
}

function ttsPresetModelDir(name: string): string {
  return path.join(ttsPresetAssetRoot, safeModelConfigName(name) || "jp", "model").split(path.sep).join("/");
}

function ttsPresetReferenceText(name: string): string {
  return path.join(ttsPresetAssetRoot, safeModelConfigName(name) || "jp", "reference.txt").split(path.sep).join("/");
}

function ttsPresetReferenceAudio(name: string): string | undefined {
  const root = path.join(ttsPresetAssetRoot, safeModelConfigName(name) || "jp");
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

export function resolveEffectivePreset(config: TtsPluginConfig, deps: TtsPluginDeps): TtsApiPreset | undefined {
  if (config.apiPresetName) return deps.resolveApiPreset?.(config.apiPresetName) ?? config.api_preset;
  return config.api_preset;
}

export function defaultPrompt(): string {
  return [
    "Translate the text appended below into natural Japanese for voice reading.",
    "Preserve meaning, tone, names, numbers, and punctuation intent.",
    "Return only the translated Japanese text. Do not add explanations.",
    "",
    "Text:"
  ].join("\n");
}

function ttsConversionConfigValue(value: unknown, legacyRemote: Record<string, unknown>): TtsConversionConfig {
  const raw = parseJsonObject(value);
  const genie = parseJsonObject(raw.genie);
  const openaiApi = parseJsonObject(raw.openaiApi);
  const bailian = parseJsonObject(raw.bailian);
  const legacyGenie = {
    enabled: booleanValue(legacyRemote.enabled, true),
    baseURL: normalizeBaseURL(stringValue(legacyRemote.baseURL) || "http://192.168.0.103:8767")
  };
  const nextGenie = {
    enabled: genie.enabled === undefined ? legacyGenie.enabled : booleanValue(genie.enabled, legacyGenie.enabled),
    baseURL: normalizeBaseURL(stringValue(genie.baseURL) || legacyGenie.baseURL)
  };
  return {
    provider: raw.provider === "openai-api" ? "openai-api" : raw.provider === "bailian" ? "bailian" : "genie",
    genie: nextGenie,
    openaiApi: ttsOpenAiApiConversionConfigValue(openaiApi),
    bailian: ttsBailianConversionConfigValue(bailian)
  };
}

function ttsOpenAiApiConversionConfigValue(raw: Record<string, unknown>): TtsOpenAiApiConversionConfig {
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
    extraParams: recordValue(raw.extraParams)
  };
}

function ttsBailianConversionConfigValue(raw: Record<string, unknown>): TtsBailianConversionConfig {
  const service = raw.service === "cosy" ? "cosy" : "qwen";
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
    mode: raw.mode === "commit" ? "commit" : "server_commit",
    responseFormat: stringValue(raw.responseFormat) || "pcm",
    sampleRate: numberValue(raw.sampleRate, 24_000),
    channels: numberValue(raw.channels, 1),
    timeoutMs: numberValue(raw.timeoutMs, 60_000),
    extraParams: recordValue(raw.extraParams)
  };
}

export function defaultBailianTtsEndpoint(service: "qwen" | "cosy" | undefined): string {
  return service === "cosy" ? defaultBailianCosyTtsEndpoint : defaultBailianQwenTtsEndpoint;
}

export function selectedTtsConversionProvider(config: TtsPluginConfig): "genie" | "openai-api" | "bailian" {
  const provider = config.conversion?.provider;
  return provider === "openai-api" || provider === "bailian" ? provider : "genie";
}

function ttsLanguageValue(value: unknown): "jp" | "zh" | "en" {
  return value === "zh" || value === "en" ? value : "jp";
}

function ttsTranslationPresetsValue(value: unknown, fallbackName: string, fallback: TtsTranslationPreset): Record<string, TtsTranslationPreset> {
  const raw = parseJsonObject(value);
  const entries = Object.fromEntries(Object.entries(raw)
    .map(([name, entry]) => [safeModelConfigName(name), ttsTranslationPresetValue(entry)])
    .filter(([name]) => Boolean(name))) as Record<string, TtsTranslationPreset>;
  if (Object.keys(entries).length > 0) return entries;
  return { [safeModelConfigName(fallbackName) || "default"]: fallback };
}

function ttsTranslationPresetValue(value: unknown): TtsTranslationPreset {
  const raw = parseJsonObject(value);
  return {
    translationEnabled: raw.translationEnabled === undefined ? undefined : booleanValue(raw.translationEnabled, true),
    apiPresetName: stringValue(raw.apiPresetName),
    prompt: stringValue(raw.prompt)
  };
}

function ttsModelConfigsValue(value: unknown, fallbackName: string, fallback: TtsVoiceModelConfig): Record<string, TtsVoiceModelConfig> {
  const raw = parseJsonObject(value);
  const entries = Object.fromEntries(Object.entries(raw)
    .map(([name, entry]) => [safeModelConfigName(name), ttsVoiceModelConfigValue(entry)])
    .filter(([name]) => Boolean(name))) as Record<string, TtsVoiceModelConfig>;
  if (Object.keys(entries).length > 0) return entries;
  return { [safeModelConfigName(fallbackName) || "jp"]: fallback };
}

function ttsVoiceModelConfigValue(value: unknown): TtsVoiceModelConfig {
  const raw = parseJsonObject(value);
  return {
    language: ttsLanguageValue(raw.language),
    speed: optionalNumberValue(raw.speed),
    partSilenceSeconds: optionalNumberValue(raw.partSilenceSeconds),
    splitText: raw.splitText === undefined ? undefined : booleanValue(raw.splitText, false),
    modelDir: stringValue(raw.modelDir),
    referenceAudio: stringValue(raw.referenceAudio),
    referenceText: stringValue(raw.referenceText)
  };
}

function safeModelConfigName(value: string): string {
  return value.trim().replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}
