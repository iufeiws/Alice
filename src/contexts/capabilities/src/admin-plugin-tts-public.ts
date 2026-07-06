import { defaultBailianTtsEndpoint, defaultMimoTtsBaseURL, type TtsPluginConfig, type TtsPreset } from "../../../channels/tts/src/index.js";
import type { TtsAdminConfig } from "./admin-plugin-types.js";
import { readTtsPresetReferenceText, ttsPresetModelDir, ttsPresetReferenceAudioPath } from "./admin-plugin-tts-config.js";

export function publicTtsConfig(config: TtsPluginConfig, assetRoot = "assets"): TtsAdminConfig {
  if (!config.activePresetName || !config.presets || !config.activePreset) throw new Error("tts active preset not found");
  const translationPresets = config.translationPresets ?? {};
  const translationPresetName = config.translationPresetName ?? Object.keys(translationPresets)[0] ?? "default";
  const currentTranslation = translationPresets[translationPresetName] ?? {};
  const editPresetName = config.editPresetName ?? config.activePresetName;
  const currentPreset = config.presets[editPresetName] ?? config.activePreset;
  return {
    enabled: config.enabled,
    activePresetName: config.activePresetName,
    corePresetName: config.corePresetName,
    shellPresetName: config.shellPresetName,
    editPresetName,
    newPresetName: "",
    presets: Object.fromEntries(Object.entries(config.presets).map(([name, preset]) => [name, publicTtsPreset(name, preset, assetRoot)])),
    currentPreset: publicTtsPreset(editPresetName, currentPreset, assetRoot),
    translationPresetName,
    translationEditPresetName: translationPresetName,
    newTranslationPresetName: "",
    translationPresets,
    currentTranslation: {
      translationEnabled: currentTranslation.translationEnabled ?? config.translationEnabled,
      apiPresetName: currentTranslation.apiPresetName ?? config.apiPresetName,
      prompt: currentTranslation.prompt ?? config.prompt
    },
  };
}

function publicTtsPreset(name: string, preset: TtsPreset, assetRoot = "assets"): TtsAdminConfig["currentPreset"] {
  if (preset.provider === "genie") {
    const genie = preset.genie ?? {};
    return {
      provider: "genie",
      genie: {
      enabled: genie.enabled ?? true,
      baseURL: genie.baseURL ?? "",
      localFallbackEnabled: genie.localFallbackEnabled ?? false,
      language: genie.language ?? "jp",
      modelDir: genie.modelDir ?? ttsPresetModelDir(name, assetRoot),
      referenceAudio: ttsPresetReferenceAudioPath(name, assetRoot),
      referenceText: readTtsPresetReferenceText(name, assetRoot),
      speed: genie.speed,
      partSilenceSeconds: genie.partSilenceSeconds,
      splitText: genie.splitText ?? false,
      ...(genie.textFilters?.length ? { textFilters: genie.textFilters } : {})
      }
    };
  }
  if (preset.provider === "openai-api") {
    const openaiApi = preset.openaiApi ?? {};
    return {
      provider: "openai-api",
      openaiApi: {
      apiPresetName: openaiApi.apiPresetName,
      model: openaiApi.model ?? "higgs-audio-v3-tts",
      voice: openaiApi.voice ?? "default",
      timeoutMs: openaiApi.timeoutMs ?? 60_000,
      sampleRate: openaiApi.sampleRate ?? 32_000,
      channels: openaiApi.channels ?? 1,
      ...(openaiApi.textFilters?.length ? { textFilters: openaiApi.textFilters } : {}),
      extraParamsJson: JSON.stringify(openaiApi.extraParams ?? {}, null, 2)
      }
    };
  }
  if (preset.provider === "bailian") {
    const bailian = preset.bailian ?? {};
    return {
      provider: "bailian",
      bailian: {
      service: bailian.service ?? "qwen",
      endpoint: bailian.endpoint ?? defaultBailianTtsEndpoint(bailian.service),
      apiKey: "",
      apiKeyEnv: bailian.apiKeyEnv ?? "DASHSCOPE_API_KEY",
      workspaceId: bailian.workspaceId,
      userAgent: bailian.userAgent,
      model: bailian.model ?? "qwen3-tts-vc-2026-01-22",
      voice: bailian.voice ?? "Cherry",
      languageType: bailian.languageType ?? "Chinese",
      responseFormat: bailian.responseFormat ?? "pcm",
      timeoutMs: bailian.timeoutMs ?? 60_000,
      sampleRate: bailian.sampleRate ?? 24_000,
      channels: bailian.channels ?? 1,
      ...(bailian.textFilters?.length ? { textFilters: bailian.textFilters } : {}),
      extraParamsJson: JSON.stringify(bailian.extraParams ?? {}, null, 2)
      }
    };
  }
  const mimo = preset.mimo ?? {};
  return {
    provider: "mimo",
    mimo: {
      mode: mimo.mode ?? "preset",
      baseURL: mimo.baseURL ?? defaultMimoTtsBaseURL,
      apiKey: "",
      apiKeyEnv: mimo.apiKeyEnv ?? "MIMO_API_KEY",
      voice: mimo.voice ?? "mimo_default",
      voiceDesignPrompt: mimo.voiceDesignPrompt,
      voiceCloneAudioDataUrl: mimo.voiceCloneAudioDataUrl ? "(configured)" : "",
      voiceCloneAudioDataUrlSet: Boolean(mimo.voiceCloneAudioDataUrl),
      audioFormat: mimo.audioFormat ?? "wav",
      timeoutMs: mimo.timeoutMs ?? 60_000,
      sampleRate: mimo.sampleRate ?? 24_000,
      channels: mimo.channels ?? 1,
      ...(mimo.textFilters?.length ? { textFilters: mimo.textFilters } : {}),
      extraParamsJson: JSON.stringify(mimo.extraParams ?? {}, null, 2)
    }
  };
}
