import { createOpenAICompatibleClient, type LLMClient } from "../../llm-gateway/src/index.js";
import { createBailianTtsVoiceSynthesizer, createMimoTtsVoiceSynthesizer, createOpenAiApiTtsVoiceSynthesizer, createTtsRemoteAwareVoiceSynthesizer, defaultBailianTtsEndpoint, defaultMimoTtsBaseURL, readTtsPluginConfig, selectedTtsPreset, translateTtsText, ttsGenieOverrides, type TtsLlmClient, type TtsPluginConfig, type TtsPreset, type TtsTranslationPreset, type VoiceSynthesizer } from "../../../channels/tts/src/index.js";
import { HttpJsonError, readRawBody } from "../../../apps/api/middleware/http-utils.js";
import { readLLMApiPresets } from "../../llm-gateway/src/admin-presets.js";
import { booleanFromUnknown, optionalString, requiredString } from "../../../shared/admin-input/src/index.js";
import { convertReferenceAudio, decodeHeaderFileName, maxTtsReferenceUploadBytes, readMossCodecConfig, ttsAudioUrl } from "../../../channels/tts/src/admin-assets.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";
import type { AdminPluginRegistryEntry, AdminPluginSummary, TtsAdminConfig } from "./admin-plugin-types.js";
import { defaultPluginAssetFileName, invalidNumber, maxPluginAssetUploadBytes, maxPluginModelAssetUploadBytes, optionalNumberFromUnknown, resolvePluginAssetPathForUpload, safePluginAssetFileName } from "./admin-plugin-utils.js";

const fs = await import("node:fs");
const path = await import("node:path");

export function ttsPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return ttsPluginSummary(context);
    },
    config(context) {
      return publicTtsConfig(readTtsConfigForAdmin(context), context.pluginConfigs?.tts?.assetRoot);
    },
    patch(context, patch) {
      const result = updateTtsConfig(context, patch);
      return "error" in result ? result : { config: publicTtsConfig(result.config, context.pluginConfigs?.tts?.assetRoot) };
    },
    setEnabled(context, enabled) {
      const result = updateTtsConfig(context, { enabled });
      return "error" in result ? result : { config: publicTtsConfig(result.config, context.pluginConfigs?.tts?.assetRoot) };
    },
    reload(context) {
      return { config: publicTtsConfig(readTtsConfigForAdmin(context), context.pluginConfigs?.tts?.assetRoot) };
    },
    test(context, input) {
      return testTtsPlugin(context, input);
    },
    uploadAsset(context, assetKey, request) {
      return uploadGenericPluginAsset(context, "tts", assetKey, request);
    },
    configSchema: {
      groups: [
        { key: "translation", label: "Translation Presets" },
        { key: "model_genie", label: "Model / Conversion / Genie" },
        { key: "conversion_openai_api", label: "Conversion / OpenAI-API" },
        { key: "conversion_bailian", label: "Conversion / Bailian" },
        { key: "conversion_mimo", label: "Conversion / MiMo" },
        { key: "general", label: "Common Settings" }
      ],
      fields: [
        { key: "translationEditPresetName", label: "Translation Preset", type: "select", group: "translation", options: [], description: "Select the translation preset to edit." },
        { key: "newTranslationPresetName", label: "Create or Rename", type: "text", group: "translation", description: "Enter a translation preset name and save to create/switch to it." },
        { key: "currentTranslation.translationEnabled", label: "Translate Text", type: "switch", group: "general", description: "Translate text before TTS. Disable to send the original text directly to the selected voice model." },
        { key: "currentTranslation.apiPresetName", label: "API Preset", type: "apiPresetSelect", group: "translation", description: "Select a saved API preset. The plugin does not store API keys." },
        { key: "currentTranslation.prompt", label: "Prompt", type: "textarea", group: "translation", description: "Prompt used by this plugin before it calls the selected API preset." },
        { key: "editPresetName", label: "Model Preset", type: "select", group: "model_genie", options: [], description: "Select the model preset to edit." },
        { key: "newPresetName", label: "Create or Rename", type: "text", group: "model_genie", description: "Enter a model preset name and save to create/switch to it." },
        { key: "currentPreset.genie.language", label: "Voice Language", type: "select", group: "model_genie", options: [
          { value: "jp", label: "Japanese" },
          { value: "zh", label: "Chinese" },
          { value: "en", label: "English" }
        ], description: "Genie language used for this TTS voice route." },
        { key: "currentPreset.genie.modelDir", label: "Model Folder", type: "folderUpload", group: "model_genie", assetKey: "model", description: "Genie model folder for the selected model config." },
        { key: "currentPreset.genie.referenceAudio", label: "Reference Audio", type: "fileUpload", group: "model_genie", assetKey: "reference-audio", accept: "audio/*", description: "Reference audio for the selected model config." },
        { key: "currentPreset.genie.referenceText", label: "Reference Text", type: "textarea", group: "model_genie", description: "Reference text for the selected model preset. It is stored at assets/tts/preset/{preset}/reference.txt on save." },
        { key: "currentPreset.genie.speed", label: "Voice Speed", type: "number", group: "model_genie", min: 0.5, max: 2, step: 0.05, description: "Optional Genie playback speed multiplier from 0.5 to 2.0." },
        { key: "currentPreset.genie.splitText", label: "Split Text", type: "switch", group: "model_genie", description: "Whether this preset lets Genie split one TTS text into multiple synthesized parts. Default is off." },
        { key: "currentPreset.genie.partSilenceSeconds", label: "Part Silence", type: "number", group: "model_genie", min: 0, max: 3, step: 0.05, description: "Optional silence in seconds inserted between split Genie audio parts. Default is 0.67." },
        { key: "translationPresetName", label: "Active Translation Preset", type: "select", group: "general", options: [], description: "Translation preset used at runtime." },
        { key: "activePresetName", label: "Active Model Preset", type: "select", group: "general", options: [], description: "Model preset used at runtime." },
        { key: "currentPreset.provider", label: "Conversion Backend", type: "select", group: "general", options: [
          { value: "genie", label: "Genie" },
          { value: "openai-api", label: "OpenAI-API" },
          { value: "bailian", label: "Bailian" },
          { value: "mimo", label: "MiMo" }
        ], description: "Backend used after optional translation." },
        { key: "enabled", label: "Enabled", type: "switch", group: "general", description: "Enable or disable this plugin route." },
        { key: "currentPreset.genie.enabled", label: "Remote Genie", type: "switch", group: "model_genie", description: "Use the LAN Genie TTS service before falling back to local Genie." },
        { key: "currentPreset.genie.localFallbackEnabled", label: "Local Genie Fallback", type: "switch", group: "model_genie", description: "Allow local Genie only after a non-local Genie route fails. Disable to keep API and remote routes from starting local Genie." },
        { key: "currentPreset.genie.baseURL", label: "Remote Genie IP/URL", type: "text", group: "model_genie", description: "Remote Genie TTS IP or base URL. Bare IP/host values default to http://{host}:8767." },
        { key: "currentPreset.openaiApi.apiPresetName", label: "API Preset", type: "apiPresetSelect", group: "conversion_openai_api", description: "OpenAI-compatible speech API preset. The plugin does not expose API keys in public config." },
        { key: "currentPreset.openaiApi.model", label: "Model", type: "text", group: "conversion_openai_api", description: "Speech model sent as model in POST /audio/speech." },
        { key: "currentPreset.openaiApi.voice", label: "Voice", type: "text", group: "conversion_openai_api", description: "Voice name or custom voice ID sent as voice." },
        { key: "currentPreset.openaiApi.timeoutMs", label: "Timeout Ms", type: "number", group: "conversion_openai_api", min: 1000, max: 300000, step: 1000, description: "Request timeout for OpenAI-API speech calls." },
        { key: "currentPreset.openaiApi.sampleRate", label: "PCM Sample Rate", type: "number", group: "conversion_openai_api", min: 8000, max: 48000, step: 1000, description: "PCM sample rate used to estimate chunk text timing. Default is 32000." },
        { key: "currentPreset.openaiApi.channels", label: "PCM Channels", type: "number", group: "conversion_openai_api", min: 1, max: 2, step: 1, description: "PCM channel count used to estimate chunk text timing. Default is 1." },
        { key: "currentPreset.openaiApi.extraParamsJson", label: "Extra Params JSON", type: "textarea", group: "conversion_openai_api", description: "Optional JSON object merged into the speech request before input/model/voice/response_format." },
        { key: "currentPreset.bailian.service", label: "Bailian Service", type: "select", group: "conversion_bailian", options: [
          { value: "qwen", label: "Qwen TTS" },
          { value: "cosy", label: "CosyVoice" }
        ], description: "Bailian TTS service family. CosyVoice uses the SpeechSynthesizer endpoint." },
        { key: "currentPreset.bailian.endpoint", label: "HTTP Endpoint", type: "text", group: "conversion_bailian", description: "Bailian HTTP endpoint. Qwen defaults to aigc/multimodal-generation; CosyVoice defaults to audio/tts/SpeechSynthesizer." },
        { key: "currentPreset.bailian.apiKey", label: "API Key", type: "password", group: "conversion_bailian", description: "Bailian DashScope API key stored in the local ignored plugin config. Leave blank to keep unchanged." },
        { key: "currentPreset.bailian.apiKeyEnv", label: "API Key Env", type: "text", group: "conversion_bailian", description: "Environment variable containing the Bailian DashScope API key. Default is DASHSCOPE_API_KEY." },
        { key: "currentPreset.bailian.workspaceId", label: "Workspace ID", type: "text", group: "conversion_bailian", description: "Optional Bailian workspace id sent as X-DashScope-WorkSpace." },
        { key: "currentPreset.bailian.userAgent", label: "User Agent", type: "text", group: "conversion_bailian", description: "Optional user-agent sent with the HTTP request." },
        { key: "currentPreset.bailian.model", label: "Model", type: "text", group: "conversion_bailian", description: "Bailian Qwen-TTS non-realtime model name." },
        { key: "currentPreset.bailian.voice", label: "Voice", type: "text", group: "conversion_bailian", description: "Bailian voice name or custom voice ID." },
        { key: "currentPreset.bailian.languageType", label: "Language Type", type: "text", group: "conversion_bailian", description: "Qwen-TTS language_type, for example Chinese, Japanese, English, or Auto." },
        { key: "currentPreset.bailian.mode", label: "Mode", type: "select", group: "conversion_bailian", options: [
          { value: "server_commit", label: "Server Commit" },
          { value: "commit", label: "Commit" }
        ], description: "Retained for older configs; non-realtime streaming uses HTTP SSE." },
        { key: "currentPreset.bailian.responseFormat", label: "Response Format", type: "text", group: "conversion_bailian", description: "Local PCM format label for playback; Bailian non-realtime SSE returns PCM audio data." },
        { key: "currentPreset.bailian.timeoutMs", label: "Timeout Ms", type: "number", group: "conversion_bailian", min: 1000, max: 300000, step: 1000, description: "Request timeout for Bailian non-realtime TTS." },
        { key: "currentPreset.bailian.sampleRate", label: "PCM Sample Rate", type: "number", group: "conversion_bailian", min: 8000, max: 48000, step: 1000, description: "PCM sample rate returned by Bailian. Default is 24000." },
        { key: "currentPreset.bailian.channels", label: "PCM Channels", type: "number", group: "conversion_bailian", min: 1, max: 2, step: 1, description: "PCM channel count returned by Bailian. Default is 1." },
        { key: "currentPreset.bailian.extraParamsJson", label: "Extra Params JSON", type: "textarea", group: "conversion_bailian", description: "Optional JSON object merged into Bailian Qwen-TTS input fields." },
        { key: "currentPreset.mimo.mode", label: "MiMo Mode", type: "select", group: "conversion_mimo", options: [
          { value: "preset", label: "Preset Voice" },
          { value: "voicedesign", label: "Voice Design" },
          { value: "voiceclone", label: "Voice Clone" }
        ], description: "MiMo V2.5 TTS mode." },
        { key: "currentPreset.mimo.baseURL", label: "Base URL", type: "text", group: "conversion_mimo", description: "MiMo API base URL. Defaults to https://api.xiaomimimo.com/v1." },
        { key: "currentPreset.mimo.apiKey", label: "API Key", type: "password", group: "conversion_mimo", description: "MiMo API key stored in the provider JSON. Leave blank to keep unchanged." },
        { key: "currentPreset.mimo.apiKeyEnv", label: "API Key Env", type: "text", group: "conversion_mimo", description: "Environment variable containing the MiMo API key. Default is MIMO_API_KEY." },
        { key: "currentPreset.mimo.voice", label: "Preset Voice", type: "text", group: "conversion_mimo", description: "Preset voice for mimo-v2.5-tts." },
        { key: "currentPreset.mimo.voiceDesignPrompt", label: "Voice Design Prompt", type: "textarea", group: "conversion_mimo", description: "Sent as the MiMo user message only in voice design mode." },
        { key: "currentPreset.mimo.voiceCloneAudioDataUrl", label: "Voice Clone Audio", type: "fileUpload", group: "conversion_mimo", assetKey: "mimo-voiceclone-audio", accept: "audio/wav,audio/mpeg,.wav,.mp3", description: "Uploaded WAV/MP3 is stored as data URL base64 in presets/mimo.json." },
        { key: "currentPreset.mimo.audioFormat", label: "Audio Format", type: "select", group: "conversion_mimo", options: [
          { value: "wav", label: "WAV" },
          { value: "pcm16", label: "PCM16" }
        ], description: "MiMo audio.format. WAV is the normal file output path." },
        { key: "currentPreset.mimo.timeoutMs", label: "Timeout Ms", type: "number", group: "conversion_mimo", min: 1000, max: 300000, step: 1000, description: "Request timeout for MiMo TTS." },
        { key: "currentPreset.mimo.sampleRate", label: "PCM Sample Rate", type: "number", group: "conversion_mimo", min: 8000, max: 48000, step: 1000, description: "PCM sample rate used when audioFormat is pcm16. Default is 24000." },
        { key: "currentPreset.mimo.channels", label: "PCM Channels", type: "number", group: "conversion_mimo", min: 1, max: 2, step: 1, description: "PCM channel count used when audioFormat is pcm16. Default is 1." },
        { key: "currentPreset.mimo.extraParamsJson", label: "Extra Params JSON", type: "textarea", group: "conversion_mimo", description: "Optional JSON object merged into the MiMo chat/completions request." },
        { key: "targetRoute", label: "Target Route", type: "readonly", group: "general", description: "send_chat.voice.before_tts" },
        { key: "persistTranslation", label: "Persist Translation", type: "readonly", group: "general", description: "Translations are transient and never written to message log." }
      ]
    },
    routePreview: [
      "send_chat.voice",
      "plugin.translate_optional",
      "default_tts.synthesize",
      "channel.audio.send"
    ],
    runtimeAccess: [
      "call selected API preset",
      "read outgoing voice text before TTS",
      "pass translated text to TTS",
      "do not persist translated text to message log"
    ],
    testSchema: {
      input: "text",
      label: "Input",
      buttonLabel: "Test translation and voice"
    }
  };
}

function ttsPluginSummary(context: AdminRoutesContext, config = readTtsConfigForAdmin(context)): AdminPluginSummary {
  const presetExists = !config.apiPresetName || readLLMApiPresets(context).some((entry) => entry.name === config.apiPresetName);
  const activePreset = selectedTtsPreset(config);
  const conversionPresetName = activePreset.provider === "openai-api" ? activePreset.openaiApi?.apiPresetName : undefined;
  const conversionPresetExists = !conversionPresetName || readLLMApiPresets(context).some((entry) => entry.name === conversionPresetName);
  const missingConfig = config.enabled && ((config.translationEnabled && (!config.apiPresetName || !presetExists)) || !conversionPresetExists);
  return {
    id: "tts",
    name: "TTS",
    kind: "voice",
    status: missingConfig ? "missing_config" : config.enabled ? "enabled" : "disabled",
    health: missingConfig ? "degraded" : config.enabled ? "healthy" : "unknown",
    description: "Translate send_chat voice text through a selected API preset before the normal TTS route.",
    configurable: true,
    switchable: true,
    configSource: ttsConfigPath(context),
    lastLoadedAt: ttsConfigMtime(context)
  };
}

async function testTtsPlugin(context: AdminRoutesContext, input: Record<string, unknown>): Promise<{ ok: true; result?: unknown } | { error: string }> {
  const config = readTtsConfigForAdmin(context);
  const text = requiredString(input.text);
  if (!text) return { error: "text_required" };
  if (Array.from(text).length > 240) return { error: "text_too_long" };

  const totalStartedAt = Date.now();
  let translatedText = text;
  let translationMs = 0;
  if (config.translationEnabled) {
    if (!config.apiPresetName) return { error: "missing_api_preset" };
    const preset = readLLMApiPresets(context).find((entry) => entry.name === config.apiPresetName);
    if (!preset) return { error: "invalid_api_preset" };
    if (!preset.baseURL || !preset.apiKey) return { error: "incomplete_api_preset" };
    const translationStartedAt = Date.now();
    const translated = await translateTtsText(text, config, {
      baseSynthesizer: async () => {
        throw new Error("not used");
      },
      llmRequestSender: context.llmRequestSender ? (request) => context.llmRequestSender!({ ...request, client: request.client as any } as any) as any : undefined,
      llm: createTextOnlyTtsLlmClient(createOpenAICompatibleClient({
        baseURL: preset.baseURL,
        apiKey: preset.apiKey,
        model: preset.model,
        temperature: preset.temperature,
        timeoutMs: preset.timeoutMs,
        extraParams: preset.extraParams
      })),
      resolveApiPreset(name) {
        return readLLMApiPresets(context).find((entry) => entry.name === name);
      },
      promptRenderer: () => context.getPromptRenderer(),
      appendLog: context.appendLog
    });
    translationMs = Date.now() - translationStartedAt;
    if (!translated) return { error: "translation_failed" };
    translatedText = translated;
  } else {
    context.appendLog?.("info", `tts admin test translation skipped: disabled chars=${Array.from(text).length}`);
  }

  const ttsStartedAt = Date.now();
  const configuredSynthesizer = context.pluginConfigs?.tts?.testVoiceSynthesizer;
  const activePreset = selectedTtsPreset(config);
  const synthesizer = configuredSynthesizer ?? (
    activePreset.provider === "openai-api"
      ? createOpenAiApiTtsVoiceSynthesizer(config, {
        resolveApiPreset(name) {
          return readLLMApiPresets(context).find((entry) => entry.name === name);
        },
        appendLog: context.appendLog
      })
      : activePreset.provider === "bailian"
        ? createBailianTtsVoiceSynthesizer(config, {
          appendLog: context.appendLog
        })
      : activePreset.provider === "mimo"
        ? createMimoTtsVoiceSynthesizer(config, {
          appendLog: context.appendLog
        })
        : createTtsFallbackTtsSynthesizer(context)
  );
  let voice: Awaited<ReturnType<VoiceSynthesizer>>;
  let ttsMs = 0;
  try {
    voice = await synthesizer({
      text: translatedText,
      time: context.time,
      ...(activePreset.provider === "genie" ? { genie: ttsGenieOverrides(config) } : {})
    });
    ttsMs = Date.now() - ttsStartedAt;
  } finally {
    if (!configuredSynthesizer) await synthesizer.shutdown?.();
  }

  return {
    ok: true,
    result: {
      input: text,
      output: translatedText,
      voice: {
        assetId: voice.assetId,
        filePath: voice.filePath,
        audioUrl: ttsAudioUrl(context, voice.filePath)
      },
      timing: {
        translationMs,
        ttsMs,
        totalMs: Date.now() - totalStartedAt
      }
    }
  };
}

function createTtsFallbackTtsSynthesizer(context: AdminRoutesContext): VoiceSynthesizer {
  return createTtsRemoteAwareVoiceSynthesizer({
    ...context.config.tts,
    ttsConfigPath: ttsConfigPath(context)
  }, {
    appendLog: context.appendLog
  });
}

function updateTtsConfig(
  context: AdminRoutesContext,
  patch: Record<string, unknown>
): { config: TtsPluginConfig } | { error: string } {
  const current = readTtsConfigForAdmin(context);
  if ("api_preset" in patch) return { error: "invalid_plugin_config" };
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
  const activePresetName = safeTtsPresetName(optionalString(patch.activePresetName) || current.activePresetName, current.activePresetName);
  const editPresetName = safeTtsPresetName(optionalString(patch.newPresetName) || optionalString(patch.editPresetName) || current.editPresetName || activePresetName, activePresetName);
  const presetPatch = patch.currentPreset && typeof patch.currentPreset === "object" && !Array.isArray(patch.currentPreset)
    ? patch.currentPreset as Record<string, unknown>
    : {};
  const shouldUpdatePreset = Object.keys(presetPatch).length > 0 || optionalString(patch.newPresetName) !== undefined;
  const currentPreset = currentPresets[editPresetName] ?? currentPresets[current.editPresetName ?? ""] ?? currentPresets[activePresetName] ?? current.activePreset;
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
    api_preset: current.api_preset,
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
    const nextBailianMode = bailianPatch.mode === undefined ? currentBailian.mode ?? "server_commit" : bailianModeFromUnknown(bailianPatch.mode);
    if (!nextBailianMode) return { error: "invalid_bailian_mode" };
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
          mode: nextBailianMode,
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

function bailianModeFromUnknown(value: unknown): "commit" | "server_commit" | undefined {
  return value === "commit" || value === "server_commit" ? value : undefined;
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

function safeTtsPresetName(value: string, fallback: string): string {
  return value.trim().replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || fallback;
}

function normalizeAssetPath(value: string): string {
  return value.split(path.sep).join("/");
}

function ttsPresetRoot(presetName: string, assetRoot = "assets"): string {
  return path.join(assetRoot, "tts", "preset", safeTtsPresetName(presetName, "jp"));
}

function ttsPresetModelDir(presetName: string, assetRoot = "assets"): string {
  return normalizeAssetPath(path.join(ttsPresetRoot(presetName, assetRoot), "model"));
}

function ttsPresetReferenceTextPath(presetName: string, assetRoot = "assets"): string {
  return normalizeAssetPath(path.join(ttsPresetRoot(presetName, assetRoot), "reference.txt"));
}

function ttsPresetReferenceAudioPath(presetName: string, assetRoot = "assets"): string | undefined {
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

function readTtsPresetReferenceText(presetName: string, assetRoot = "assets"): string | undefined {
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

function readTtsConfigForAdmin(context: AdminRoutesContext): TtsPluginConfig {
  return readTtsPluginConfig(ttsConfigPath(context));
}

function writeTtsConfig(context: AdminRoutesContext, config: TtsPluginConfig): void {
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

async function uploadGenericPluginAsset(
  context: AdminRoutesContext,
  pluginId: string,
  assetKey: string,
  request: any
): Promise<{ config: TtsAdminConfig; assetPath: string } | { error: string; statusCode?: number }> {
  const config = readTtsConfigForAdmin(context);
  if (!config.activePresetName || !config.presets || !config.activePreset) return { error: "tts_active_preset_not_found" };
  const fileName = safePluginAssetFileName(decodeHeaderFileName(optionalString(request.headers?.["x-file-name"]) ?? ""));
  const relativeDir = decodeHeaderFileName(optionalString(request.headers?.["x-relative-dir"]) ?? "");
  const maxBytes = assetKey === "model"
    ? maxPluginModelAssetUploadBytes
    : pluginId === "tts" && assetKey === "reference-audio"
      ? maxTtsReferenceUploadBytes
      : maxPluginAssetUploadBytes;
  const body = await readRawBody(request, { maxBytes });
  if (body.length === 0) return { error: "empty_upload" };

  const presetName = decodeHeaderFileName(optionalString(request.headers?.["x-preset-name"]) ?? "");
  if (pluginId === "tts" && assetKey === "mimo-voiceclone-audio") {
    const result = writeTtsMimoVoiceCloneAudioUpload(context, config, fileName, body);
    if ("error" in result) return result;
    return result;
  }
  const assetPath = pluginId === "tts"
    ? resolveTtsModelAssetPathForUpload(config, assetKey, fileName, relativeDir, presetName, context.pluginConfigs?.tts?.assetRoot)
    : resolvePluginAssetPathForUpload(pluginId, assetKey, fileName, relativeDir);
  if (pluginId === "tts" && assetKey === "reference-audio") {
    const result = await writeTtsPresetReferenceAudioUpload(context, assetPath.fullPath, fileName, body);
    if (result) return result;
  } else {
    fs.mkdirSync(path.dirname(assetPath.fullPath), { recursive: true });
    fs.writeFileSync(assetPath.fullPath, body);
  }

  const targetPresetName = safeTtsPresetName(presetName || config.editPresetName || config.activePresetName, config.activePresetName);
  const targetPreset = config.presets[targetPresetName] ?? config.activePreset;
  const nextPreset = assetKey === "model"
    ? {
      ...targetPreset,
      provider: "genie" as const,
      genie: {
        ...(targetPreset.genie ?? {}),
        modelDir: path.join("assets", "tts", "preset", targetPresetName, "model").split(path.sep).join("/")
      }
    }
    : targetPreset;
  const next: TtsPluginConfig = {
    ...config,
    editPresetName: targetPresetName,
    presets: {
      ...config.presets,
      [targetPresetName]: nextPreset
    },
    activePreset: config.presets[config.activePresetName] ?? config.activePreset
  };
  writeTtsConfig(context, next);
  return { config: publicTtsConfig(next, context.pluginConfigs?.tts?.assetRoot), assetPath: assetPath.assetPath };
}

function writeTtsMimoVoiceCloneAudioUpload(
  context: AdminRoutesContext,
  config: TtsPluginConfig,
  fileName: string,
  body: Buffer
): { config: TtsAdminConfig; assetPath: string } | { error: string; statusCode?: number } {
  const mimeType = mimoVoiceCloneMimeType(fileName);
  if (!mimeType) return { error: "unsupported_mimo_voiceclone_audio_type" };
  if (!config.activePresetName || !config.presets || !config.activePreset) return { error: "tts_active_preset_not_found" };
  const presetName = config.editPresetName || config.activePresetName;
  const currentPreset = config.presets[presetName] ?? config.activePreset;
  const currentMimo = currentPreset.mimo ?? {};
  const nextMode = "voiceclone" as const;
  const nextPreset: TtsPreset = {
    provider: "mimo",
    mimo: {
      ...currentMimo,
      mode: nextMode,
      voiceCloneAudioDataUrl: `data:${mimeType};base64,${body.toString("base64")}`
    }
  };
  const next: TtsPluginConfig = {
    ...config,
    editPresetName: presetName,
    presets: { ...config.presets, [presetName]: nextPreset },
    activePreset: config.activePresetName === presetName ? nextPreset : config.activePreset
  };
  writeTtsConfig(context, next);
  return { config: publicTtsConfig(next, context.pluginConfigs?.tts?.assetRoot), assetPath: `${path.join(ttsPresetConfigDirectory(context), `${presetName}.json`).split(path.sep).join("/")}#voiceCloneAudioDataUrl` };
}

function mimoVoiceCloneMimeType(fileName: string): string | undefined {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  return undefined;
}

function resolveTtsModelAssetPathForUpload(config: TtsPluginConfig, assetKey: string, fileName: string, relativeDir: string, presetName?: string, assetRoot = "assets"): { fullPath: string; assetPath: string } {
  if (!config.activePresetName) throw new HttpJsonError(400, "tts_active_preset_not_found");
  const selectedPresetName = safeTtsPresetName(presetName || config.editPresetName || config.activePresetName, config.activePresetName);
  const root = path.resolve(assetRoot, "tts", "preset", selectedPresetName);
  const effectiveFileName = fileName || defaultPluginAssetFileName(assetKey);
  const baseRelativeDir = assetKey === "model" ? "model" : "";
  const outputName = assetKey === "reference-text"
    ? "reference.txt"
    : assetKey === "reference-audio"
      ? "reference.wav"
      : effectiveFileName;
  const fullPath = path.resolve(root, baseRelativeDir, outputName);
  const relative = path.relative(root, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpJsonError(400, "invalid_asset_path");
  }
  return {
    fullPath,
    assetPath: path.join("assets", "tts", "preset", selectedPresetName, relative).split(path.sep).join("/")
  };
}

async function writeTtsPresetReferenceAudioUpload(context: AdminRoutesContext, outputPath: string, fileName: string, body: Buffer): Promise<{ error: string; statusCode?: number } | undefined> {
  const extension = path.extname(fileName).toLowerCase();
  if (extension && ![".wav", ".mp3", ".m4a", ".ogg", ".opus"].includes(extension)) {
    return { error: "unsupported_reference_audio_type" };
  }
  const tempDir = path.join(path.dirname(outputPath), `.alice-tts-preset-reference-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const inputPath = path.join(tempDir, `source${extension || ".wav"}`);
  const convertedPath = path.join(tempDir, "reference.wav");
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(inputPath, body);
    await convertReferenceAudio(inputPath, convertedPath, ttsReferenceFfmpegCommand(context), ttsReferenceCodecConfig(context));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.renameSync(convertedPath, outputPath);
    return undefined;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function ttsReferenceFfmpegCommand(context: AdminRoutesContext): string {
  return context.config.tts?.mossFfmpegCommand ?? "ffmpeg-static";
}

function ttsReferenceCodecConfig(context: AdminRoutesContext): { sampleRate: number; channels: number } {
  try {
    return readMossCodecConfig(context);
  } catch {
    return { sampleRate: 48_000, channels: 2 };
  }
}

function sanitizePluginAssetRelativePath(value: string): string {
  if (!value) return "";
  const normalized = path.normalize(value).replace(/^(\.\.(\/|\\|$))+/, "");
  return normalized === "." ? "" : normalized;
}

function isPluginAssetPath(pluginId: string, value: string, assetRoot = "assets"): boolean {
  const root = path.resolve(assetRoot, "plugin", pluginId);
  const fullPath = resolvePluginAssetPath(pluginId, value, assetRoot);
  const relative = path.relative(root, fullPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolvePluginAssetPath(pluginId: string, value: string, assetRoot = "assets"): string {
  const normalized = path.normalize(value);
  const prefix = path.join("assets", "plugin", pluginId);
  if (normalized === prefix || normalized.startsWith(`${prefix}${path.sep}`)) {
    return path.resolve(assetRoot, path.relative("assets", normalized));
  }
  return path.resolve(value);
}

function ttsConfigPath(context: AdminRoutesContext): string {
  return context.pluginConfigs?.tts?.configPath ?? "config/plugin/tts/config.json";
}

function ttsPresetConfigDirectory(context: AdminRoutesContext): string {
  return path.join(path.dirname(ttsConfigPath(context)), "presets");
}

function ttsConfigMtime(context: AdminRoutesContext): string | undefined {
  try {
    const stats = fs.statSync(ttsConfigPath(context)) as { mtime?: Date; mtimeMs?: number };
    if (stats.mtime instanceof Date) return stats.mtime.toISOString();
    if (typeof stats.mtimeMs === "number") return new Date(stats.mtimeMs).toISOString();
    return undefined;
  } catch {
    return undefined;
  }
}

function publicTtsConfig(config: TtsPluginConfig, assetRoot = "assets"): TtsAdminConfig {
  if (!config.activePresetName || !config.presets || !config.activePreset) throw new Error("tts active preset not found");
  const translationPresets = config.translationPresets ?? {};
  const translationPresetName = config.translationPresetName ?? Object.keys(translationPresets)[0] ?? "default";
  const currentTranslation = translationPresets[translationPresetName] ?? {};
  const editPresetName = config.editPresetName ?? config.activePresetName;
  const currentPreset = config.presets[editPresetName] ?? config.activePreset;
  return {
    enabled: config.enabled,
    activePresetName: config.activePresetName,
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
  const openaiApi = preset.openaiApi ?? {};
  const bailian = preset.bailian ?? {};
  const mimo = preset.mimo ?? {};
  const genie = preset.genie ?? {};
  return {
    provider: preset.provider,
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
    },
    openaiApi: {
      apiPresetName: openaiApi.apiPresetName,
      model: openaiApi.model ?? "higgs-audio-v3-tts",
      voice: openaiApi.voice ?? "default",
      timeoutMs: openaiApi.timeoutMs ?? 60_000,
      sampleRate: openaiApi.sampleRate ?? 32_000,
      channels: openaiApi.channels ?? 1,
      ...(openaiApi.textFilters?.length ? { textFilters: openaiApi.textFilters } : {}),
      extraParamsJson: JSON.stringify(openaiApi.extraParams ?? {}, null, 2)
    },
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
      mode: bailian.mode ?? "server_commit",
      responseFormat: bailian.responseFormat ?? "pcm",
      timeoutMs: bailian.timeoutMs ?? 60_000,
      sampleRate: bailian.sampleRate ?? 24_000,
      channels: bailian.channels ?? 1,
      ...(bailian.textFilters?.length ? { textFilters: bailian.textFilters } : {}),
      extraParamsJson: JSON.stringify(bailian.extraParams ?? {}, null, 2)
    },
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
    editPresetName: config.editPresetName,
    translationPresetName,
    translationPresets,
    api_preset: undefined
  } as TtsPluginConfig;
}

function createTextOnlyTtsLlmClient(client: LLMClient): TtsLlmClient {
  return {
    async chat(input) {
      const result = await client.chat(input);
      return {
        message: {
          role: result.message.role,
          content: typeof result.message.content === "string" ? result.message.content : ""
        }
      };
    }
  };
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
