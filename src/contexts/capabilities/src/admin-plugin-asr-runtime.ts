import { createLLMClientFromPreset } from "../../llm-gateway/src/llm-api-profile.js";
import { multimodalLlmAsrProtocolCall, readAsrPluginConfig, transcribeWithAsrPlugin, type AsrPluginConfig, type AsrTranscribeError, type AsrTranscribeResult } from "../../../channels/asr/src/index.js";
import { readRawBody } from "../../../apps/api/middleware/http-utils.js";
import { readLLMApiPresets } from "../../llm-gateway/src/admin-presets.js";
import { booleanFromUnknown, isValidHttpUrl, optionalString, requiredString } from "../../../shared/admin-input/src/index.js";
import { decodeHeaderFileName } from "../../../channels/tts/src/admin-assets.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";
import type { AdminPluginRegistryEntry, AdminPluginSummary } from "./admin-plugin-types.js";
import { invalidNumber, isPluginAssetPath, maxPluginAssetUploadBytes, optionalNumberFromUnknown, resolvePluginAssetPath, resolvePluginAssetPathForUpload, safePluginAssetFileName } from "./admin-plugin-utils.js";

const fs = await import("node:fs");
const path = await import("node:path");

export function asrPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return asrPluginSummary(context);
    },
    config(context) {
      return publicAsrConfig(readAsrConfigForAdmin(context));
    },
    patch(context, patch) {
      const result = updateAsrConfig(context, patch);
      return "error" in result ? result : { config: publicAsrConfig(result.config) };
    },
    setEnabled(context, enabled) {
      const result = updateAsrConfig(context, { enabled });
      return "error" in result ? result : { config: publicAsrConfig(result.config) };
    },
    reload(context) {
      return { config: publicAsrConfig(readAsrConfigForAdmin(context)) };
    },
    test(context, input) {
      return testAsrPlugin(context, input);
    },
    uploadAsset(context, assetKey, request) {
      return uploadAsrPluginAsset(context, assetKey, request);
    },
    configSchema: {
      groups: [
        { key: "general", label: "General" },
        { key: "openai_compatible", label: "OpenAI Compatible" },
        { key: "multimodal_llm", label: "Multimodal LLM" },
        { key: "tencent", label: "Tencent Cloud" }
      ],
      fields: [
        { key: "enabled", label: "Enabled", type: "switch", group: "general", description: "Enable or disable ASR requests." },
        { key: "defaultProvider", label: "Default Provider", type: "select", group: "general", options: [
          { value: "openai_compatible", label: "OpenAI Compatible" },
          { value: "multimodal_llm", label: "Multimodal LLM" },
          { value: "tencent", label: "Tencent Cloud" }
        ], description: "Provider used when callers do not explicitly choose one." },
        { key: "directAudioInputEnabled", label: "Direct Audio Input", type: "switch", group: "general", description: "Bypass ASR and send final voice audio directly to talk LLMs that support audio input." },
        { key: "testAudioPath", label: "Test Audio", type: "fileUpload", group: "general", assetKey: "test-audio", accept: "audio/*", description: "Plugin-owned test audio under assets/plugin/asr/test-audio/." },
        { key: "pseudoStreamMinPauseMs", label: "Pseudo Stream Pause Ms", type: "number", group: "general", min: 500, max: 10000, step: 100, description: "Conservative pause threshold for pseudo streaming. Default is 1500 ms." },
        { key: "providers.openaiCompatible.apiPresetName", label: "OpenAI-Compatible Preset", type: "apiPresetSelect", group: "openai_compatible", description: "Preset for OpenAI or SiliconFlow compatible ASR. The plugin stores only the preset name." },
        { key: "providers.openaiCompatible.responseFormat", label: "Response Format", type: "select", group: "openai_compatible", options: [
          { value: "json", label: "json" },
          { value: "text", label: "text" },
          { value: "verbose_json", label: "verbose_json" }
        ] },
        { key: "providers.openaiCompatible.retryCount", label: "OpenAI Retry Count", type: "number", group: "openai_compatible", min: 0, max: 5, step: 1, description: "Retries for timeout or transient provider failures. Default is 1." },
        { key: "providers.openaiCompatible.retryBackoffMs", label: "OpenAI Retry Backoff Ms", type: "number", group: "openai_compatible", min: 0, max: 30000, step: 100, description: "Base retry backoff in milliseconds. Default is 500." },
        { key: "providers.multimodalLlm.apiPresetName", label: "Multimodal LLM Preset", type: "apiPresetSelect", group: "multimodal_llm", description: "Preset used for one-shot multimodal audio understanding." },
        { key: "providers.multimodalLlm.prompt", label: "Multimodal Prompt", type: "textarea", group: "multimodal_llm", description: "Prompt sent with the audio. Defaults to the MIMO audio understanding prompt." },
        { key: "providers.multimodalLlm.extraParams", label: "Multimodal Extra Params JSON", type: "textarea", group: "multimodal_llm", description: "JSON object rendered by the shared LLM request layer. Defaults to tool_choice=submit_audio_context and max_completion_tokens=8192." },
        { key: "providers.multimodalLlm.protocolCall", label: "submit_audio_context Protocol Call", type: "readonlyTextarea", group: "multimodal_llm", description: JSON.stringify(multimodalLlmAsrProtocolCall(), null, 2) },
        { key: "providers.tencent.appId", label: "Tencent AppID", type: "text", group: "tencent", description: "Tencent Cloud AppID used by native real-time WebSocket ASR. Omit to use pseudo streaming." },
        { key: "providers.tencent.secretId", label: "Tencent SecretId", type: "text", group: "tencent", description: "Tencent Cloud SecretId from the CAM API key pair." },
        { key: "providers.tencent.secretKey", label: "Tencent SecretKey", type: "text", group: "tencent", description: "Tencent Cloud SecretKey used to sign ASR requests." },
        { key: "providers.tencent.endpoint", label: "Tencent Endpoint", type: "text", group: "tencent", description: "Defaults to https://asr.tencentcloudapi.com when omitted." },
        { key: "providers.tencent.region", label: "Tencent Region", type: "text", group: "tencent", description: "Defaults to ap-guangzhou when omitted." },
        { key: "providers.tencent.engineModelType", label: "Tencent Engine", type: "text", group: "tencent", description: "EngineModelType, for example 16k_zh." },
        { key: "providers.tencent.realtimeVoiceFormat", label: "Tencent Realtime Format", type: "number", group: "tencent", min: 1, max: 16, step: 1, description: "Tencent real-time voice_format. Defaults from MIME/filename; wav is 12, pcm is 1, opus is 10." },
        { key: "providers.tencent.realtimeNeedVad", label: "Tencent Realtime VAD", type: "number", group: "tencent", min: 0, max: 1, step: 1, description: "Tencent real-time needvad. 1 enables VAD, 0 disables it. Default is 1." },
        { key: "providers.tencent.pollIntervalMs", label: "Tencent Poll Ms", type: "number", group: "tencent", min: 100, max: 10000, step: 100 },
        { key: "providers.tencent.timeoutMs", label: "Tencent Timeout Ms", type: "number", group: "tencent", min: 1000, max: 600000, step: 1000 },
        { key: "providers.tencent.retryCount", label: "Tencent Retry Count", type: "number", group: "tencent", min: 0, max: 5, step: 1, description: "Retries CreateRecTask and DescribeTaskStatus timeout or transient failures. Default is 1." },
        { key: "providers.tencent.retryBackoffMs", label: "Tencent Retry Backoff Ms", type: "number", group: "tencent", min: 0, max: 30000, step: 100, description: "Base retry backoff in milliseconds. Default is 500." },
        { key: "providers.tencent.maxChunkBytes", label: "Tencent Max Chunk Bytes", type: "number", group: "tencent", min: 100000, max: 5242880, step: 100000, description: "Tencent local upload chunk limit. Default and maximum are 5242880 bytes." },
        { key: "providers.tencent.splitSilenceThresholdDb", label: "Split Silence dB", type: "number", group: "tencent", min: -80, max: -10, step: 1, description: "Silence threshold for ffmpeg silencedetect. Default is -35 dB." },
        { key: "providers.tencent.splitMinSilenceMs", label: "Split Min Silence Ms", type: "number", group: "tencent", min: 100, max: 5000, step: 100, description: "Minimum silence duration used as preferred split point. Default is 700 ms." }
      ]
    },
    routePreview: [
      "audio file",
      "plugin.asr.transcribe",
      "selected provider",
      "normalized text result"
    ],
    runtimeAccess: [
      "read uploaded or caller-provided audio file",
      "call selected API preset",
      "return normalized transcription text",
      "do not persist transcription text by default"
    ],
    testSchema: {
      input: "audio",
      label: "Audio",
      buttonLabel: "Test transcription"
    }
  };
}


function asrPluginSummary(context: AdminRoutesContext, config = readAsrConfigForAdmin(context)): AdminPluginSummary {
  const presetNames = new Set(readLLMApiPresets(context).map((entry) => entry.name));
  const missingConfig = config.enabled && asrConfigMissingPreset(config, presetNames);
  return {
    id: "asr",
    name: "ASR",
    kind: "asr",
    status: missingConfig ? "missing_config" : config.enabled ? "enabled" : "disabled",
    health: missingConfig ? "degraded" : config.enabled ? "healthy" : "unknown",
    description: "Transcribe caller-provided audio files through Tencent Cloud or OpenAI-compatible ASR APIs.",
    configurable: true,
    switchable: true,
    configSource: asrConfigPath(context),
    lastLoadedAt: asrConfigMtime(context)
  };
}


function asrConfigMissingPreset(config: AsrPluginConfig, presetNames: Set<string>): boolean {
  const provider = config.defaultProvider;
  if (provider === "openai_compatible") {
    const name = config.providers.openaiCompatible?.apiPresetName;
    return !name || !presetNames.has(name);
  }
  if (provider === "multimodal_llm") {
    const name = config.providers.multimodalLlm?.apiPresetName;
    return !name || !presetNames.has(name) || !config.providers.multimodalLlm?.prompt;
  }
  return !config.providers.tencent?.secretId || !config.providers.tencent?.secretKey;
}

async function testAsrPlugin(context: AdminRoutesContext, input: Record<string, unknown>): Promise<{ ok: true; result?: unknown } | { error: string }> {
  const config = readAsrConfigForAdmin(context);
  const audioFile = optionalString(input.audioFile) ?? config.testAudioPath;
  if (!audioFile) return { error: "missing_audio_file" };
  if (!isPluginAssetPath("asr", audioFile, context.pluginConfigs?.asr?.assetRoot)) return { error: "invalid_asset_path" };
  const resolvedAudioFile = resolvePluginAssetPath("asr", audioFile, context.pluginConfigs?.asr?.assetRoot);
  if (!fs.existsSync(resolvedAudioFile)) return { error: "missing_audio_file" };

  const totalStartedAt = Date.now();
  const transcriber = context.pluginConfigs?.asr?.testTranscriber;
  const result = await (transcriber
    ? transcriber({ audioFile: resolvedAudioFile }, config)
    : transcribeWithAsrPlugin({ audioFile: resolvedAudioFile }, config, {
      resolveApiPreset(name) {
        return readLLMApiPresets(context).find((entry) => entry.name === name);
      },
      createLlmClientFromPreset(preset) {
        return createLLMClientFromPreset(preset as any);
      },
      llmRequestSender: context.llmRequestSender ? (request) => context.llmRequestSender!({ ...request, client: request.client as any } as any) as any : undefined,
      promptRenderer: () => context.getPromptRenderer(),
      appendLog: context.appendLog
    }));
  if (isAsrTranscribeError(result)) return { error: result.error };
  return {
    ok: true,
    result: {
      input: audioFile,
      output: result.text,
      provider: result.provider,
      model: result.model,
      requestId: result.requestId,
      timing: {
        transcriptionMs: result.durationMs,
        totalMs: Date.now() - totalStartedAt
      }
    }
  };
}

function isAsrTranscribeError(result: AsrTranscribeResult | AsrTranscribeError): result is AsrTranscribeError {
  return "ok" in result && result.ok === false;
}

function updateAsrConfig(context: AdminRoutesContext, patch: Record<string, unknown>): { config: AsrPluginConfig } | { error: string } {
  const current = readAsrConfigForAdmin(context);
  const providersPatch = patch.providers && typeof patch.providers === "object" && !Array.isArray(patch.providers)
    ? patch.providers as Record<string, unknown>
    : {};
  const openAiPatch = providersPatch.openaiCompatible && typeof providersPatch.openaiCompatible === "object" && !Array.isArray(providersPatch.openaiCompatible)
    ? providersPatch.openaiCompatible as Record<string, unknown>
    : {};
  const multimodalLlmPatch = providersPatch.multimodalLlm && typeof providersPatch.multimodalLlm === "object" && !Array.isArray(providersPatch.multimodalLlm)
    ? providersPatch.multimodalLlm as Record<string, unknown>
    : {};
  const tencentPatch = providersPatch.tencent && typeof providersPatch.tencent === "object" && !Array.isArray(providersPatch.tencent)
    ? providersPatch.tencent as Record<string, unknown>
    : {};
  const multimodalExtraParams = parseAsrExtraParams(multimodalLlmPatch.extraParams, current.providers.multimodalLlm?.extraParams ?? {});
  if ("error" in multimodalExtraParams) return { error: "invalid_multimodal_extra_params" };

  const next: AsrPluginConfig = {
    enabled: patch.enabled === undefined ? current.enabled : booleanFromUnknown(patch.enabled),
    defaultProvider: patch.defaultProvider === undefined ? current.defaultProvider : asrProviderFromUnknown(patch.defaultProvider),
    directAudioInputEnabled: patch.directAudioInputEnabled === undefined ? current.directAudioInputEnabled : booleanFromUnknown(patch.directAudioInputEnabled),
    testAudioPath: patch.testAudioPath === undefined ? current.testAudioPath : optionalString(patch.testAudioPath),
    pseudoStreamMinPauseMs: patch.pseudoStreamMinPauseMs === undefined ? current.pseudoStreamMinPauseMs : optionalNumberFromUnknown(patch.pseudoStreamMinPauseMs),
    providers: {
      openaiCompatible: {
        apiPresetName: openAiPatch.apiPresetName === undefined ? current.providers.openaiCompatible?.apiPresetName : optionalString(openAiPatch.apiPresetName),
        responseFormat: openAiPatch.responseFormat === undefined ? current.providers.openaiCompatible?.responseFormat : asrResponseFormatFromUnknown(openAiPatch.responseFormat),
        retryCount: openAiPatch.retryCount === undefined ? current.providers.openaiCompatible?.retryCount : optionalNumberFromUnknown(openAiPatch.retryCount),
        retryBackoffMs: openAiPatch.retryBackoffMs === undefined ? current.providers.openaiCompatible?.retryBackoffMs : optionalNumberFromUnknown(openAiPatch.retryBackoffMs)
      },
      multimodalLlm: {
        apiPresetName: multimodalLlmPatch.apiPresetName === undefined ? current.providers.multimodalLlm?.apiPresetName : optionalString(multimodalLlmPatch.apiPresetName),
        prompt: multimodalLlmPatch.prompt === undefined ? current.providers.multimodalLlm?.prompt : optionalString(multimodalLlmPatch.prompt),
        extraParams: multimodalExtraParams.value
      },
      tencent: {
        appId: tencentPatch.appId === undefined ? current.providers.tencent?.appId : optionalString(tencentPatch.appId),
        secretId: tencentPatch.secretId === undefined ? current.providers.tencent?.secretId : optionalString(tencentPatch.secretId),
        secretKey: tencentPatch.secretKey === undefined ? current.providers.tencent?.secretKey : optionalString(tencentPatch.secretKey),
        endpoint: tencentPatch.endpoint === undefined ? current.providers.tencent?.endpoint : optionalString(tencentPatch.endpoint),
        region: tencentPatch.region === undefined ? current.providers.tencent?.region : optionalString(tencentPatch.region),
        engineModelType: tencentPatch.engineModelType === undefined ? current.providers.tencent?.engineModelType : optionalString(tencentPatch.engineModelType),
        realtimeVoiceFormat: tencentPatch.realtimeVoiceFormat === undefined ? current.providers.tencent?.realtimeVoiceFormat : optionalNumberFromUnknown(tencentPatch.realtimeVoiceFormat),
        realtimeNeedVad: tencentPatch.realtimeNeedVad === undefined ? current.providers.tencent?.realtimeNeedVad : optionalNumberFromUnknown(tencentPatch.realtimeNeedVad),
        pollIntervalMs: tencentPatch.pollIntervalMs === undefined ? current.providers.tencent?.pollIntervalMs : optionalNumberFromUnknown(tencentPatch.pollIntervalMs),
        timeoutMs: tencentPatch.timeoutMs === undefined ? current.providers.tencent?.timeoutMs : optionalNumberFromUnknown(tencentPatch.timeoutMs),
        retryCount: tencentPatch.retryCount === undefined ? current.providers.tencent?.retryCount : optionalNumberFromUnknown(tencentPatch.retryCount),
        retryBackoffMs: tencentPatch.retryBackoffMs === undefined ? current.providers.tencent?.retryBackoffMs : optionalNumberFromUnknown(tencentPatch.retryBackoffMs),
        maxChunkBytes: tencentPatch.maxChunkBytes === undefined ? current.providers.tencent?.maxChunkBytes : optionalNumberFromUnknown(tencentPatch.maxChunkBytes),
        splitSilenceThresholdDb: tencentPatch.splitSilenceThresholdDb === undefined ? current.providers.tencent?.splitSilenceThresholdDb : optionalNumberFromUnknown(tencentPatch.splitSilenceThresholdDb),
        splitMinSilenceMs: tencentPatch.splitMinSilenceMs === undefined ? current.providers.tencent?.splitMinSilenceMs : optionalNumberFromUnknown(tencentPatch.splitMinSilenceMs)
      }
    }
  };

  const validationError = validateAsrConfig(context, next);
  if (validationError) return { error: validationError };
  writeAsrConfig(context, next);
  return { config: next };
}

function validateAsrConfig(context: AdminRoutesContext, config: AsrPluginConfig): string | undefined {
  if (config.defaultProvider !== "openai_compatible" && config.defaultProvider !== "multimodal_llm" && config.defaultProvider !== "tencent") return "invalid_asr_provider";
  if (config.testAudioPath && !isPluginAssetPath("asr", config.testAudioPath)) return "invalid_asset_path";
  const pseudoPause = config.pseudoStreamMinPauseMs;
  if (pseudoPause !== undefined && invalidNumber(pseudoPause, 500, 10_000)) return "invalid_pseudo_stream_pause";
  const presets = new Set(readLLMApiPresets(context).map((entry) => entry.name));
  for (const name of [config.providers.openaiCompatible?.apiPresetName, config.providers.multimodalLlm?.apiPresetName]) {
    if (name && !presets.has(name)) return "invalid_api_preset";
  }
  if (config.defaultProvider === "multimodal_llm" && !config.providers.multimodalLlm?.prompt) return "missing_multimodal_prompt";
  const responseFormat = config.providers.openaiCompatible?.responseFormat;
  if (responseFormat !== undefined && responseFormat !== "json" && responseFormat !== "text" && responseFormat !== "verbose_json") return "invalid_asr_response_format";
  if (config.providers.tencent?.endpoint && !isValidHttpUrl(config.providers.tencent.endpoint)) return "invalid_tencent_endpoint";
  const realtimeVoiceFormat = config.providers.tencent?.realtimeVoiceFormat;
  if (realtimeVoiceFormat !== undefined && invalidNumber(realtimeVoiceFormat, 1, 16)) return "invalid_realtime_voice_format";
  const realtimeNeedVad = config.providers.tencent?.realtimeNeedVad;
  if (realtimeNeedVad !== undefined && realtimeNeedVad !== 0 && realtimeNeedVad !== 1) return "invalid_realtime_need_vad";
  const poll = config.providers.tencent?.pollIntervalMs;
  if (poll !== undefined && invalidNumber(poll, 100, 10_000)) return "invalid_poll_interval";
  const timeout = config.providers.tencent?.timeoutMs;
  if (timeout !== undefined && invalidNumber(timeout, 1000, 600_000)) return "invalid_timeout";
  const retryCount = [config.providers.openaiCompatible?.retryCount, config.providers.tencent?.retryCount];
  if (retryCount.some((value) => value !== undefined && invalidNumber(value, 0, 5))) return "invalid_retry_count";
  const retryBackoff = [config.providers.openaiCompatible?.retryBackoffMs, config.providers.tencent?.retryBackoffMs];
  if (retryBackoff.some((value) => value !== undefined && invalidNumber(value, 0, 30_000))) return "invalid_retry_backoff";
  const maxChunkBytes = config.providers.tencent?.maxChunkBytes;
  if (maxChunkBytes !== undefined && invalidNumber(maxChunkBytes, 100_000, 5 * 1024 * 1024)) return "invalid_max_chunk_bytes";
  const splitDb = config.providers.tencent?.splitSilenceThresholdDb;
  if (splitDb !== undefined && invalidNumber(splitDb, -80, -10)) return "invalid_split_silence_threshold";
  const splitMs = config.providers.tencent?.splitMinSilenceMs;
  if (splitMs !== undefined && invalidNumber(splitMs, 100, 5000)) return "invalid_split_min_silence";
  return undefined;
}

async function uploadAsrPluginAsset(
  context: AdminRoutesContext,
  assetKey: string,
  request: any
): Promise<{ config: AsrPluginConfig; assetPath: string } | { error: string; statusCode?: number }> {
  if (assetKey !== "test-audio") return { error: "unknown_asset_key" };
  const config = readAsrConfigForAdmin(context);
  const fileName = safePluginAssetFileName(decodeHeaderFileName(optionalString(request.headers?.["x-file-name"]) ?? ""));
  const relativeDir = decodeHeaderFileName(optionalString(request.headers?.["x-relative-dir"]) ?? "");
  const body = await readRawBody(request, { maxBytes: maxPluginAssetUploadBytes });
  if (body.length === 0) return { error: "empty_upload" };
  const assetPath = resolvePluginAssetPathForUpload("asr", assetKey, fileName, relativeDir, context.pluginConfigs?.asr?.assetRoot);
  fs.mkdirSync(path.dirname(assetPath.fullPath), { recursive: true });
  fs.writeFileSync(assetPath.fullPath, body);
  const next: AsrPluginConfig = {
    ...config,
    testAudioPath: assetPath.assetPath
  };
  writeAsrConfig(context, next);
  return { config: publicAsrConfig(next), assetPath: assetPath.assetPath };
}

function readAsrConfigForAdmin(context: AdminRoutesContext): AsrPluginConfig {
  return readAsrPluginConfig(asrConfigPath(context));
}

function writeAsrConfig(context: AdminRoutesContext, config: AsrPluginConfig): void {
  const filePath = asrConfigPath(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(publicAsrConfig(config), null, 2)}\n`);
}

function publicAsrConfig(config: AsrPluginConfig): AsrPluginConfig {
  return {
    enabled: config.enabled,
    defaultProvider: config.defaultProvider,
    directAudioInputEnabled: config.directAudioInputEnabled === true,
    testAudioPath: config.testAudioPath,
    pseudoStreamMinPauseMs: config.pseudoStreamMinPauseMs,
    providers: {
      openaiCompatible: config.providers.openaiCompatible ? { ...config.providers.openaiCompatible } : undefined,
      multimodalLlm: config.providers.multimodalLlm ? { ...config.providers.multimodalLlm } : undefined,
      tencent: config.providers.tencent ? { ...config.providers.tencent } : undefined
    }
  };
}

function asrConfigPath(context: AdminRoutesContext): string {
  return context.pluginConfigs?.asr?.configPath ?? "config/plugin/asr/config.json";
}

function asrConfigMtime(context: AdminRoutesContext): string | undefined {
  try {
    const stats = fs.statSync(asrConfigPath(context)) as { mtime?: Date; mtimeMs?: number };
    if (stats.mtime instanceof Date) return stats.mtime.toISOString();
    if (typeof stats.mtimeMs === "number") return new Date(stats.mtimeMs).toISOString();
    return undefined;
  } catch {
    return undefined;
  }
}

function asrProviderFromUnknown(value: unknown): AsrPluginConfig["defaultProvider"] {
  return requiredString(value).trim() as AsrPluginConfig["defaultProvider"];
}

function asrResponseFormatFromUnknown(value: unknown): "json" | "text" | "verbose_json" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "json" || value === "text" || value === "verbose_json") return value;
  return requiredString(value).trim() as "json";
}

function parseAsrExtraParams(value: unknown, fallback: Record<string, unknown>): { value: Record<string, unknown> } | { error: string } {
  if (value === undefined) return { value: fallback };
  if (value && typeof value === "object" && !Array.isArray(value)) return { value: value as Record<string, unknown> };
  const text = optionalString(value);
  if (!text) return { value: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "invalid_extra_params" };
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { error: "invalid_extra_params" };
  }
}
