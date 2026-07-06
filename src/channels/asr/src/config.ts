import * as fs from "node:fs";
import * as path from "node:path";
import type { AsrPluginConfig } from "./types.js";
import { defaultMultimodalLlmAsrExtraParams, defaultMultimodalLlmAsrPrompt } from "./multimodal-llm.js";
import { asrProviderValue, booleanValue, numberValue, parseJsonObject, recordValue, stringValue } from "./utils.js";

const defaultConfigPath = "config/plugin/asr/config.json";

export function readAsrPluginConfig(configPath = defaultConfigPath): AsrPluginConfig {
  const resolved = path.resolve(configPath);
  const parsed = parseJsonObject(fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "{}");
  const providers = parseJsonObject(parsed.providers);
  return {
    enabled: booleanValue(parsed.enabled, false),
    defaultProvider: asrProviderValue(parsed.defaultProvider) ?? "openai_compatible",
    directAudioInputEnabled: booleanValue(parsed.directAudioInputEnabled, false),
    testAudioPath: stringValue(parsed.testAudioPath),
    pseudoStreamMinPauseMs: numberValue(parsed.pseudoStreamMinPauseMs, undefined),
    providers: {
      openaiCompatible: parseOpenAiCompatibleConfig(providers.openaiCompatible),
      multimodalLlm: parseMultimodalLlmConfig(providers.multimodalLlm),
      tencent: parseTencentConfig(providers.tencent)
    }
  };
}

function parseOpenAiCompatibleConfig(value: unknown): AsrPluginConfig["providers"]["openaiCompatible"] {
  const parsed = parseJsonObject(value);
  if (!Object.keys(parsed).length) return undefined;
  const responseFormat = parsed.responseFormat === "text" || parsed.responseFormat === "verbose_json" || parsed.responseFormat === "json"
    ? parsed.responseFormat
    : undefined;
  return {
    apiPresetName: stringValue(parsed.apiPresetName),
    responseFormat,
    retryCount: numberValue(parsed.retryCount, undefined),
    retryBackoffMs: numberValue(parsed.retryBackoffMs, undefined)
  };
}

function parseMultimodalLlmConfig(value: unknown): AsrPluginConfig["providers"]["multimodalLlm"] {
  const parsed = parseJsonObject(value);
  return {
    apiPresetName: stringValue(parsed.apiPresetName),
    prompt: stringValue(parsed.prompt) ?? defaultMultimodalLlmAsrPrompt,
    extraParams: recordValue(parsed.extraParams) ?? defaultMultimodalLlmAsrExtraParams()
  };
}

function parseTencentConfig(value: unknown): AsrPluginConfig["providers"]["tencent"] {
  const parsed = parseJsonObject(value);
  if (!Object.keys(parsed).length) return undefined;
  return {
    appId: stringValue(parsed.appId),
    secretId: stringValue(parsed.secretId),
    secretKey: stringValue(parsed.secretKey),
    endpoint: stringValue(parsed.endpoint),
    region: stringValue(parsed.region),
    engineModelType: stringValue(parsed.engineModelType),
    realtimeVoiceFormat: numberValue(parsed.realtimeVoiceFormat, undefined),
    realtimeNeedVad: numberValue(parsed.realtimeNeedVad, undefined),
    pollIntervalMs: numberValue(parsed.pollIntervalMs, undefined),
    timeoutMs: numberValue(parsed.timeoutMs, undefined),
    retryCount: numberValue(parsed.retryCount, undefined),
    retryBackoffMs: numberValue(parsed.retryBackoffMs, undefined),
    maxChunkBytes: numberValue(parsed.maxChunkBytes, undefined),
    splitSilenceThresholdDb: numberValue(parsed.splitSilenceThresholdDb, undefined),
    splitMinSilenceMs: numberValue(parsed.splitMinSilenceMs, undefined)
  };
}
