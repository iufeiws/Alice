import { selectedTtsPreset, type TtsPluginConfig } from "../../../channels/tts/src/index.js";
import { readLLMApiPresets } from "../../llm-gateway/src/admin-presets.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";
import type { AdminPluginRegistryEntry, AdminPluginSummary } from "./admin-plugin-types.js";
import { uploadGenericPluginAsset } from "./admin-plugin-tts-assets.js";
import { readTtsConfigForAdmin, ttsConfigMtime, ttsConfigPath, updateTtsConfig } from "./admin-plugin-tts-config.js";
import { publicTtsConfig } from "./admin-plugin-tts-public.js";
import { testTtsPlugin } from "./admin-plugin-tts-check.js";

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
        { key: "model_genie", label: "TTS Preset / Genie" },
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
        { key: "editPresetName", label: "Preset Loaded In Editor", type: "select", group: "model_genie", options: [], description: "Changing this loads that preset into the editor. It does not change runtime voice output." },
        { key: "newPresetName", label: "Save As Preset", type: "text", group: "model_genie", description: "Optional new preset name. Save TTS Preset writes the editor values under this name." },
        { key: "currentPreset.genie.language", label: "Voice Language", type: "select", group: "model_genie", options: [
          { value: "jp", label: "Japanese" },
          { value: "zh", label: "Chinese" },
          { value: "en", label: "English" }
        ], description: "Genie language used for this TTS voice route." },
        { key: "currentPreset.genie.modelDir", label: "Model Folder", type: "folderUpload", group: "model_genie", assetKey: "model", description: "Genie model folder for the selected TTS preset." },
        { key: "currentPreset.genie.referenceAudio", label: "Reference Audio", type: "fileUpload", group: "model_genie", assetKey: "reference-audio", accept: "audio/*", description: "Reference audio for the selected TTS preset." },
        { key: "currentPreset.genie.referenceText", label: "Reference Text", type: "textarea", group: "model_genie", description: "Reference text for the selected TTS preset. It is stored at assets/tts/preset/{preset}/reference.txt on save." },
        { key: "currentPreset.genie.speed", label: "Voice Speed", type: "number", group: "model_genie", min: 0.5, max: 2, step: 0.05, description: "Optional Genie playback speed multiplier from 0.5 to 2.0." },
        { key: "currentPreset.genie.splitText", label: "Split Text", type: "switch", group: "model_genie", description: "Whether this preset lets Genie split one TTS text into multiple synthesized parts. Default is off." },
        { key: "currentPreset.genie.partSilenceSeconds", label: "Part Silence", type: "number", group: "model_genie", min: 0, max: 3, step: 0.05, description: "Optional silence in seconds inserted between split Genie audio parts. Default is 0.67." },
        { key: "translationPresetName", label: "Active Translation Preset", type: "select", group: "general", options: [], description: "Translation preset used at runtime." },
        { key: "activePresetName", label: "Runtime Voice Preset", type: "select", group: "general", options: [], description: "Preset used by the normal TTS route. Save Runtime Settings persists this field." },
        { key: "corePresetName", label: "Core TTS Preset", type: "select", group: "general", options: [], description: "TTS preset used when send_chat voice alice is core. Missing value falls back to shell, then active." },
        { key: "shellPresetName", label: "Shell TTS Preset", type: "select", group: "general", options: [], description: "TTS preset used when send_chat voice alice is shell. Missing value falls back to core, then active." },
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
      "tts plugin active preset",
      "optional translation preset",
      "selected provider synthesize",
      "channel.audio.send"
    ],
    runtimeAccess: [
      "read TTS plugin preset config",
      "call optional translation API preset",
      "call selected TTS provider",
      "write generated voice asset"
    ],
    testSchema: {
      input: "text",
      label: "Voice Text",
      buttonLabel: "Test active TTS preset"
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
    description: "Select the active TTS preset and synthesize send_chat voice through its configured provider.",
    configurable: true,
    switchable: true,
    configSource: ttsConfigPath(context),
    lastLoadedAt: ttsConfigMtime(context)
  };
}
