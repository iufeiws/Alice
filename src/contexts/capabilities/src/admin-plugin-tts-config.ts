import { defaultBailianTtsEndpoint, defaultMimoTtsBaseURL, readTtsPluginConfig, type TtsPluginConfig, type TtsPreset, type TtsTranslationPreset } from "../../../channels/tts/src/index.js";
import { readLLMApiPresets } from "../../llm-gateway/src/admin-presets.js";
import { booleanFromUnknown, optionalString, requiredString } from "../../../shared/admin-input/src/index.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";
import { invalidNumber, optionalNumberFromUnknown } from "./admin-plugin-utils.js";

const fs = await import("node:fs");
const path = await import("node:path");

export function updateTtsConfig(
  context: AdminRoutesContext,
  patch: Record<string, unknown>
): { config: TtsPluginConfig } | { error: string } {
  const current = readTtsConfigForAdmin(context);
  if (!current.activePresetName || !current.presets || !current.activePreset) return { error: "tts_active_preset_not_found" };
  const currentPresets = current.presets;
  const currentTranslationPresets = current.translationPresets ?? {};
  const activeTranslationPresetName = safeTtsPresetName(optionalString(patch.translationPresetName) || current.translationPresetName || Object.keys(currentTranslationPresets)[0] || "default", "default");
  const editTranslationPresetName = safeTtsPresetName(optionalString(patch.newTranslationPresetName) || optionalString(patch.translationEditPresetName) || activeTranslationPresetName, "default");
  const currentTranslation = currentTranslationPresets[editTranslationPresetName] ?? currentTranslationPresets[activeTranslationPresetName] ?? {};
  const translationPatch = patch.currentTranslation && typeof patch.currentTranslation === "object" && !Array.isArray(patch.currentTranslation)
    ? patch.currentTranslation as Record<string, unknown>
    : {};
  const shouldUpdateTranslationPreset = Object.keys(translationPatch).length > 0 || optionalString(patch.newTranslationPresetName) !== undefined;
  const nextTranslation: TtsTranslationPreset = {
    translationEnabled: translationPatch.translationEnabled === undefined ? currentTranslation.translationEnabled ?? current.translationEnabled : booleanFromUnknown(translationPatch.translationEnabled),
    apiPresetName: translationPatch.apiPresetName === undefined ? currentTranslation.apiPresetName ?? current.apiPresetName : optionalString(translationPatch.apiPresetName),
    prompt: translationPatch.prompt === undefined ? currentTranslation.prompt ?? current.prompt : requiredString(translationPatch.prompt)
  };
  const requestedNewPresetName = optionalString(patch.newPresetName);
  const requestedCopyPresetName = optionalString(patch.copyPresetName);
  const activePresetName = safeTtsPresetName(optionalString(patch.activePresetName) || current.activePresetName, current.activePresetName);
  const editPresetName = safeTtsPresetName(requestedNewPresetName || optionalString(patch.editPresetName) || current.editPresetName || activePresetName, activePresetName);
  const copyPresetName = requestedCopyPresetName ? safeTtsPresetName(requestedCopyPresetName, "") : undefined;
  if (copyPresetName && !requestedNewPresetName?.trim()) return { error: "tts_copy_target_required" };
  if (copyPresetName && !currentPresets[copyPresetName]) return { error: "tts_copy_preset_not_found" };
  if (copyPresetName && currentPresets[editPresetName]) return { error: "tts_preset_already_exists" };
  const presetPatch = patch.currentPreset && typeof patch.currentPreset === "object" && !Array.isArray(patch.currentPreset)
    ? patch.currentPreset as Record<string, unknown>
    : {};
  const shouldUpdatePreset = Boolean(copyPresetName) || Object.keys(presetPatch).length > 0 || requestedNewPresetName !== undefined;
  const currentPreset = copyPresetName ? currentPresets[copyPresetName]! : currentPresets[editPresetName] ?? currentPresets[current.editPresetName ?? ""] ?? currentPresets[activePresetName] ?? current.activePreset;
  const presetResult = buildTtsPresetFromPatch(currentPreset, presetPatch);
  if ("error" in presetResult) return presetResult;
  const geniePatch = presetPatch.genie && typeof presetPatch.genie === "object" && !Array.isArray(presetPatch.genie)
    ? presetPatch.genie as Record<string, unknown>
    : {};
  const referenceText = geniePatch.referenceText === undefined ? undefined : optionalString(geniePatch.referenceText);
  if (referenceText !== undefined) writeTtsPresetReferenceText(editPresetName, referenceText, context.pluginConfigs?.tts?.assetRoot);
  const nextTranslationPresets = shouldUpdateTranslationPreset
    ? { ...currentTranslationPresets, [editTranslationPresetName]: nextTranslation }
    : currentTranslationPresets;
  const activeTranslation = nextTranslationPresets[activeTranslationPresetName] ?? nextTranslation;
  const nextPresets = shouldUpdatePreset ? { ...currentPresets, [editPresetName]: presetResult.preset } : currentPresets;
  const activePreset = nextPresets[activePresetName];
  if (!activePreset) return { error: "tts_active_preset_not_found" };
  const next: TtsPluginConfig = {
    enabled: patch.enabled === undefined ? current.enabled : booleanFromUnknown(patch.enabled),
    activePresetName,
    editPresetName,
    presets: nextPresets,
    activePreset,
    translationPresetName: activeTranslationPresetName,
    translationPresets: nextTranslationPresets,
    translationEnabled: activeTranslation.translationEnabled ?? true,
    apiPresetName: activeTranslation.apiPresetName,
    prompt: activeTranslation.prompt ?? current.prompt
  };

  const validationError = validateTtsConfig(next);
  if (validationError) return { error: validationError };
  const presetToValidate = shouldUpdateTranslationPreset ? nextTranslation : activeTranslation;
  if ((shouldUpdateTranslationPreset || "translationPresetName" in patch || "enabled" in patch) && (presetToValidate.translationEnabled ?? true) && presetToValidate.apiPresetName && !readLLMApiPresets(context).some((entry) => entry.name === presetToValidate.apiPresetName)) {
    return { error: "invalid_api_preset" };
  }
  if (activePreset.provider === "openai-api" && activePreset.openaiApi?.apiPresetName && !readLLMApiPresets(context).some((entry) => entry.name === activePreset.openaiApi?.apiPresetName)) {
    return { error: "invalid_openai_api_preset" };
  }
  writeTtsConfig(context, next);
  if (copyPresetName) copyTtsPresetAssets(copyPresetName, editPresetName, context.pluginConfigs?.tts?.assetRoot);
  return { config: next };
}

function validateTtsConfig(config: TtsPluginConfig): string | undefined {
  for (const preset of Object.values(config.presets ?? {})) {
    const error = validateTtsPreset(preset);
    if (error) return error;
  }
  return undefined;
}

function buildTtsPresetFromPatch(current: TtsPreset, patch: Record<string, unknown>): { preset: TtsPreset } | { error: string } {
  const provider = patch.provider === undefined
    ? current.provider
    : patch.provider === "openai-api" ? "openai-api" : patch.provider === "bailian" ? "bailian" : patch.provider === "mimo" ? "mimo" : patch.provider === "genie" ? "genie" : undefined;
  if (!provider) return { error: "invalid_tts_preset_provider" };
  if (provider === "openai-api") {
    const openAiApiPatch = objectPatch(patch.openaiApi);
    const currentOpenAiApi = current.openaiApi ?? {};
    const extraParamsResult = parseOptionalJsonObject(openAiApiPatch.extraParamsJson, currentOpenAiApi.extraParams ?? {});
    if ("error" in extraParamsResult) return { error: extraParamsResult.error };
    return {
      preset: {
        provider,
        openaiApi: {
          apiPresetName: openAiApiPatch.apiPresetName === undefined ? currentOpenAiApi.apiPresetName : optionalString(openAiApiPatch.apiPresetName),
          model: openAiApiPatch.model === undefined ? currentOpenAiApi.model ?? "higgs-audio-v3-tts" : requiredString(openAiApiPatch.model),
          voice: openAiApiPatch.voice === undefined ? currentOpenAiApi.voice ?? "default" : requiredString(openAiApiPatch.voice),
          timeoutMs: openAiApiPatch.timeoutMs === undefined ? currentOpenAiApi.timeoutMs ?? 60_000 : optionalNumberFromUnknown(openAiApiPatch.timeoutMs),
          sampleRate: openAiApiPatch.sampleRate === undefined ? currentOpenAiApi.sampleRate ?? 32_000 : optionalNumberFromUnknown(openAiApiPatch.sampleRate),
          channels: openAiApiPatch.channels === undefined ? currentOpenAiApi.channels ?? 1 : optionalNumberFromUnknown(openAiApiPatch.channels),
          textFilters: currentOpenAiApi.textFilters?.length ? currentOpenAiApi.textFilters : undefined,
          extraParams: extraParamsResult.value
        }
      }
    };
  }
  if (provider === "bailian") {
    const bailianPatch = objectPatch(patch.bailian);
    const currentBailian = current.bailian ?? {};
    const bailianExtraParamsResult = parseOptionalJsonObject(bailianPatch.extraParamsJson, currentBailian.extraParams ?? {});
    if ("error" in bailianExtraParamsResult) return { error: "invalid_bailian_extra_params" };
    const nextBailianService = bailianPatch.service === undefined ? currentBailian.service ?? "qwen" as const : bailianServiceFromUnknown(bailianPatch.service);
    if (!nextBailianService) return { error: "invalid_bailian_service" };
    const currentBailianService = currentBailian.service ?? "qwen";
    const submittedBailianEndpoint = bailianPatch.endpoint === undefined ? undefined : requiredString(bailianPatch.endpoint);
    const currentBailianEndpoint = currentBailian.endpoint ?? defaultBailianTtsEndpoint(currentBailianService);
    const nextBailianEndpoint = submittedBailianEndpoint === undefined
      ? nextBailianService === currentBailianService
        ? currentBailianEndpoint
        : defaultBailianTtsEndpoint(nextBailianService)
      : nextBailianService !== currentBailianService && submittedBailianEndpoint === defaultBailianTtsEndpoint(currentBailianService)
        ? defaultBailianTtsEndpoint(nextBailianService)
        : submittedBailianEndpoint;
    return {
      preset: {
        provider,
        bailian: {
          service: nextBailianService,
          endpoint: nextBailianEndpoint,
          apiKey: bailianPatch.apiKey === undefined ? currentBailian.apiKey : optionalString(bailianPatch.apiKey) ?? currentBailian.apiKey,
          apiKeyEnv: bailianPatch.apiKeyEnv === undefined ? currentBailian.apiKeyEnv ?? "DASHSCOPE_API_KEY" : optionalString(bailianPatch.apiKeyEnv),
          workspaceId: bailianPatch.workspaceId === undefined ? currentBailian.workspaceId : optionalString(bailianPatch.workspaceId),
          userAgent: bailianPatch.userAgent === undefined ? currentBailian.userAgent : optionalString(bailianPatch.userAgent),
          model: bailianPatch.model === undefined ? currentBailian.model ?? "qwen3-tts-vc-2026-01-22" : requiredString(bailianPatch.model),
          voice: bailianPatch.voice === undefined ? currentBailian.voice ?? "Cherry" : requiredString(bailianPatch.voice),
          languageType: bailianPatch.languageType === undefined ? currentBailian.languageType ?? "Chinese" : optionalString(bailianPatch.languageType),
          responseFormat: bailianPatch.responseFormat === undefined ? currentBailian.responseFormat ?? "pcm" : requiredString(bailianPatch.responseFormat),
          timeoutMs: bailianPatch.timeoutMs === undefined ? currentBailian.timeoutMs ?? 60_000 : optionalNumberFromUnknown(bailianPatch.timeoutMs),
          sampleRate: bailianPatch.sampleRate === undefined ? currentBailian.sampleRate ?? 24_000 : optionalNumberFromUnknown(bailianPatch.sampleRate),
          channels: bailianPatch.channels === undefined ? currentBailian.channels ?? 1 : optionalNumberFromUnknown(bailianPatch.channels),
          textFilters: currentBailian.textFilters?.length ? currentBailian.textFilters : undefined,
          extraParams: bailianExtraParamsResult.value
        }
      }
    };
  }
  if (provider === "mimo") {
    const mimoPatch = objectPatch(patch.mimo);
    const currentMimo = current.mimo ?? {};
    const mimoExtraParamsResult = parseOptionalJsonObject(mimoPatch.extraParamsJson, currentMimo.extraParams ?? {});
    if ("error" in mimoExtraParamsResult) return { error: "invalid_mimo_extra_params" };
    const nextMimoMode = mimoPatch.mode === undefined ? currentMimo.mode ?? "preset" : mimoModeFromUnknown(mimoPatch.mode);
    if (!nextMimoMode) return { error: "invalid_mimo_mode" };
    const audioFormat = mimoPatch.audioFormat === undefined ? currentMimo.audioFormat ?? "wav" : mimoAudioFormatFromUnknown(mimoPatch.audioFormat);
    if (!audioFormat) return { error: "invalid_mimo_audio_format" };
    return {
      preset: {
        provider,
        mimo: {
          mode: nextMimoMode,
          baseURL: mimoPatch.baseURL === undefined ? currentMimo.baseURL ?? defaultMimoTtsBaseURL : requiredString(mimoPatch.baseURL),
          apiKey: mimoPatch.apiKey === undefined ? currentMimo.apiKey : optionalString(mimoPatch.apiKey) ?? currentMimo.apiKey,
          apiKeyEnv: mimoPatch.apiKeyEnv === undefined ? currentMimo.apiKeyEnv ?? "MIMO_API_KEY" : optionalString(mimoPatch.apiKeyEnv),
          voice: mimoPatch.voice === undefined ? currentMimo.voice ?? "mimo_default" : requiredString(mimoPatch.voice),
          voiceDesignPrompt: mimoPatch.voiceDesignPrompt === undefined ? currentMimo.voiceDesignPrompt : optionalString(mimoPatch.voiceDesignPrompt),
          voiceCloneAudioDataUrl: currentMimo.voiceCloneAudioDataUrl,
          audioFormat,
          timeoutMs: mimoPatch.timeoutMs === undefined ? currentMimo.timeoutMs ?? 60_000 : optionalNumberFromUnknown(mimoPatch.timeoutMs),
          sampleRate: mimoPatch.sampleRate === undefined ? currentMimo.sampleRate ?? 24_000 : optionalNumberFromUnknown(mimoPatch.sampleRate),
          channels: mimoPatch.channels === undefined ? currentMimo.channels ?? 1 : optionalNumberFromUnknown(mimoPatch.channels),
          textFilters: currentMimo.textFilters?.length ? currentMimo.textFilters : undefined,
          extraParams: mimoExtraParamsResult.value
        }
      }
    };
  }
  const geniePatch = objectPatch(patch.genie);
  const currentGenie = current.genie ?? {};
  const nextLanguage = geniePatch.language === undefined ? currentGenie.language ?? "jp" : ttsLanguageFromUnknown(geniePatch.language);
  if (!nextLanguage) return { error: "invalid_tts_language" };
  return {
    preset: {
      provider: "genie",
      genie: {
        enabled: geniePatch.enabled === undefined ? currentGenie.enabled ?? true : booleanFromUnknown(geniePatch.enabled),
        baseURL: geniePatch.baseURL === undefined ? currentGenie.baseURL ?? "" : normalizeRemoteTtsBaseURL(optionalString(geniePatch.baseURL) ?? ""),
        localFallbackEnabled: geniePatch.localFallbackEnabled === undefined ? currentGenie.localFallbackEnabled ?? false : booleanFromUnknown(geniePatch.localFallbackEnabled),
        language: nextLanguage,
        modelDir: geniePatch.modelDir === undefined ? currentGenie.modelDir : optionalString(geniePatch.modelDir),
        speed: geniePatch.speed === undefined ? currentGenie.speed : optionalSpeedValue(geniePatch.speed),
        partSilenceSeconds: geniePatch.partSilenceSeconds === undefined ? currentGenie.partSilenceSeconds : optionalPartSilenceSecondsValue(geniePatch.partSilenceSeconds),
        splitText: geniePatch.splitText === undefined ? currentGenie.splitText ?? false : booleanFromUnknown(geniePatch.splitText),
        textFilters: currentGenie.textFilters?.length ? currentGenie.textFilters : undefined
      }
    }
  };
}

function objectPatch(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validateTtsPreset(preset: TtsPreset): string | undefined {
  const genie = preset.genie;
  if (preset.provider === "genie" && genie?.enabled && !genie.baseURL) return "invalid_remote_tts_url";
  if (genie?.speed !== undefined && invalidNumber(genie.speed, 0.5, 2)) return "invalid_voice_speed";
  if (genie?.partSilenceSeconds !== undefined && invalidNumber(genie.partSilenceSeconds, 0, 3)) return "invalid_part_silence";
  const openaiApi = preset.openaiApi;
  if (preset.provider === "openai-api") {
    if (!openaiApi?.apiPresetName && !openaiApi?.baseURL) return "missing_openai_api_tts_preset";
    if (!openaiApi?.model) return "missing_openai_api_tts_model";
    if (!openaiApi?.voice) return "missing_openai_api_tts_voice";
  }
  if (openaiApi?.timeoutMs !== undefined && invalidNumber(openaiApi.timeoutMs, 1000, 300000)) return "invalid_openai_api_timeout";
  if (openaiApi?.sampleRate !== undefined && invalidNumber(openaiApi.sampleRate, 8000, 48000)) return "invalid_openai_api_sample_rate";
  if (openaiApi?.channels !== undefined && invalidNumber(openaiApi.channels, 1, 2)) return "invalid_openai_api_channels";
  const bailian = preset.bailian;
  if (preset.provider === "bailian") {
    if (!bailian?.endpoint) return "missing_bailian_tts_endpoint";
    if (!bailian?.model) return "missing_bailian_tts_model";
    if (!bailian?.voice) return "missing_bailian_tts_voice";
  }
  if (bailian?.timeoutMs !== undefined && invalidNumber(bailian.timeoutMs, 1000, 300000)) return "invalid_bailian_timeout";
  if (bailian?.sampleRate !== undefined && invalidNumber(bailian.sampleRate, 8000, 48000)) return "invalid_bailian_sample_rate";
  if (bailian?.channels !== undefined && invalidNumber(bailian.channels, 1, 2)) return "invalid_bailian_channels";
  const mimo = preset.mimo;
  if (preset.provider === "mimo") {
    if (!mimo?.baseURL) return "missing_mimo_tts_base_url";
    if (mimo.mode === "preset" && !mimo.voice) return "missing_mimo_tts_voice";
    if (mimo.mode === "voicedesign" && !mimo.voiceDesignPrompt) return "missing_mimo_voice_design_prompt";
    if (mimo.mode === "voiceclone" && !mimo.voiceCloneAudioDataUrl) return "missing_mimo_voice_clone_audio";
  }
  if (mimo?.audioFormat !== undefined && mimo.audioFormat !== "wav" && mimo.audioFormat !== "pcm16") return "invalid_mimo_audio_format";
  if (mimo?.timeoutMs !== undefined && invalidNumber(mimo.timeoutMs, 1000, 300000)) return "invalid_mimo_timeout";
  if (mimo?.sampleRate !== undefined && invalidNumber(mimo.sampleRate, 8000, 48000)) return "invalid_mimo_sample_rate";
  if (mimo?.channels !== undefined && invalidNumber(mimo.channels, 1, 2)) return "invalid_mimo_channels";
  return undefined;
}

function parseOptionalJsonObject(value: unknown, fallback: Record<string, unknown>): { value: Record<string, unknown> } | { error: string } {
  if (value === undefined) return { value: fallback };
  const text = optionalString(value);
  if (!text) return { value: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "invalid_openai_api_extra_params" };
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { error: "invalid_openai_api_extra_params" };
  }
}

function normalizeRemoteTtsBaseURL(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const hasScheme = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed);
  const candidate = hasScheme ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (!hasScheme && !parsed.port) parsed.port = "8767";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function bailianServiceFromUnknown(value: unknown): "qwen" | "cosy" | undefined {
  return value === "qwen" || value === "cosy" ? value : undefined;
}

function mimoModeFromUnknown(value: unknown): "preset" | "voicedesign" | "voiceclone" | undefined {
  return value === "preset" || value === "voicedesign" || value === "voiceclone" ? value : undefined;
}

function mimoAudioFormatFromUnknown(value: unknown): "wav" | "pcm16" | undefined {
  return value === "wav" || value === "pcm16" ? value : undefined;
}

function ttsLanguageFromUnknown(value: unknown): "jp" | "zh" | "en" | undefined {
  return value === "jp" || value === "zh" || value === "en" ? value : undefined;
}

export function safeTtsPresetName(value: string, fallback: string): string {
  return value.trim().replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || fallback;
}

function normalizeAssetPath(value: string): string {
  return value.split(path.sep).join("/");
}

function ttsPresetRoot(presetName: string, assetRoot = "assets"): string {
  return path.join(assetRoot, "tts", "preset", safeTtsPresetName(presetName, "jp"));
}

function copyTtsPresetAssets(sourcePresetName: string, targetPresetName: string, assetRoot = "assets"): void {
  const sourceRoot = ttsPresetRoot(sourcePresetName, assetRoot);
  if (!fs.existsSync(sourceRoot)) return;
  const targetRoot = ttsPresetRoot(targetPresetName, assetRoot);
  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  fs.cpSync(sourceRoot, targetRoot, { recursive: true, force: true });
}

export function ttsPresetModelDir(presetName: string, assetRoot = "assets"): string {
  return normalizeAssetPath(path.join(ttsPresetRoot(presetName, assetRoot), "model"));
}

function ttsPresetReferenceTextPath(presetName: string, assetRoot = "assets"): string {
  return normalizeAssetPath(path.join(ttsPresetRoot(presetName, assetRoot), "reference.txt"));
}

export function ttsPresetReferenceAudioPath(presetName: string, assetRoot = "assets"): string | undefined {
  const root = ttsPresetRoot(presetName, assetRoot);
  for (const candidate of ["reference.wav", "reference.mp3", "reference.ogg", "reference.opus", "reference.m4a"]) {
    const filePath = path.join(root, candidate);
    if (fs.existsSync(filePath)) return normalizeAssetPath(filePath);
  }
  try {
    const match = fs.readdirSync(root).find((entry) => /^reference\.[\w-]+$/i.test(entry));
    return match ? normalizeAssetPath(path.join(root, match)) : undefined;
  } catch {
    return undefined;
  }
}

export function readTtsPresetReferenceText(presetName: string, assetRoot = "assets"): string | undefined {
  const filePath = ttsPresetReferenceTextPath(presetName, assetRoot);
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  return undefined;
}

function writeTtsPresetReferenceText(presetName: string, value: string, assetRoot = "assets"): void {
  const filePath = ttsPresetReferenceTextPath(presetName, assetRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

export function readTtsConfigForAdmin(context: AdminRoutesContext): TtsPluginConfig {
  return readTtsPluginConfig(ttsConfigPath(context));
}

export function writeTtsConfig(context: AdminRoutesContext, config: TtsPluginConfig): void {
  const filePath = ttsConfigPath(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(canonicalTtsConfig(config), null, 2)}\n`);
  writeTtsPresetConfigs(context, config);
}

function writeTtsPresetConfigs(context: AdminRoutesContext, config: TtsPluginConfig): void {
  const dir = ttsPresetConfigDirectory(context);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, preset] of Object.entries(config.presets ?? {})) {
    fs.writeFileSync(path.join(dir, `${safeTtsPresetName(name, "tts")}.json`), `${JSON.stringify(canonicalTtsPreset(preset), null, 2)}\n`);
  }
}

export function ttsConfigPath(context: AdminRoutesContext): string {
  return context.pluginConfigs?.tts?.configPath ?? "config/plugin/tts/config.json";
}

export function ttsPresetConfigDirectory(context: AdminRoutesContext): string {
  return path.join(path.dirname(ttsConfigPath(context)), "presets");
}

export function ttsConfigMtime(context: AdminRoutesContext): string | undefined {
  try {
    const stats = fs.statSync(ttsConfigPath(context)) as { mtime?: Date; mtimeMs?: number };
    if (stats.mtime instanceof Date) return stats.mtime.toISOString();
    if (typeof stats.mtimeMs === "number") return new Date(stats.mtimeMs).toISOString();
    return undefined;
  } catch {
    return undefined;
  }
}

function canonicalTtsPreset(preset: TtsPreset): TtsPreset {
  if (preset.provider === "openai-api") return { provider: preset.provider, openaiApi: preset.openaiApi };
  if (preset.provider === "bailian") return { provider: preset.provider, bailian: preset.bailian };
  if (preset.provider === "mimo") return { provider: preset.provider, mimo: preset.mimo };
  return { provider: "genie", genie: preset.genie };
}

function canonicalTtsConfig(config: TtsPluginConfig): TtsPluginConfig {
  const translationPresets = config.translationPresets ?? {};
  const translationPresetName = config.translationPresetName ?? Object.keys(translationPresets)[0] ?? "default";
  return {
    enabled: config.enabled,
    activePresetName: config.activePresetName,
    translationPresetName,
    translationPresets
  } as TtsPluginConfig;
}

function optionalSpeedValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : Number.NaN;
}

function optionalPartSilenceSecondsValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : Number.NaN;
}
