import { createOpenAICompatibleClient, type LLMClient } from "../../llm-gateway/src/index.js";
import type { AppConfig } from "../../../apps/api/bootstrap/app-config-runtime.js";
import { buildLLMTextVariables } from "../../agent-profile/src/application/llm-text-renderer.js";
import { createBailianTtsVoiceSynthesizer, createOpenAiApiTtsVoiceSynthesizer, createTtsRemoteAwareVoiceSynthesizer, defaultBailianTtsEndpoint, readTtsPluginConfig, translateTtsText, ttsGenieOverrides, type TtsLlmClient, type TtsPluginConfig, type TtsTranslationPreset, type TtsVoiceModelConfig, type VoiceSynthesizer } from "../../../channels/tts/src/index.js";
import { readAsrPluginConfig, transcribeWithAsrPlugin, type AsrPluginConfig, type AsrTranscribeError, type AsrTranscribeInput, type AsrTranscribeResult } from "../../../channels/asr/src/index.js";
import { defaultGoogleStreetViewPluginConfigPath, publicGoogleStreetViewPluginConfig, readGoogleStreetViewPluginConfig, validateGoogleStreetViewPluginConfig, type GoogleStreetViewPluginConfig, type GoogleStreetViewRegion } from "../../../channels/google-streetview/src/index.js";
import { defaultWorldWandererPluginConfigPath, publicWorldWandererConfig, readWorldWandererConfig, validateWorldWandererConfig, writeWorldWandererConfig, type WorldWandererConfig } from "../../world-wanderer/src/index.js";
import { defaultPhotoPluginConfigPath, publicPhotoPluginConfig, readPhotoPluginConfig, type PhotoPluginConfig, type SelfieGenerationMode } from "../../../capabilities/tools/photo/src/index.js";
import { HttpJsonError, readJsonBody, readRawBody } from "../../../apps/api/middleware/http-utils.js";
import { publicLLMApiPresets, readLLMApiPresets, resolvePromptApiPreset } from "../../llm-gateway/src/admin-presets.js";
import { writeJson } from "../../../apps/api/routes/admin-http.js";
import { resolveLibrarySetting } from "../../world-wanderer/src/admin-library-setting.js";
import { booleanFromUnknown, isValidHttpUrl, numberFromUnknown, optionalString, parseJsonObject, requiredString } from "../../../shared/admin-input/src/index.js";
import { convertReferenceAudio, decodeHeaderFileName, maxTtsReferenceUploadBytes, readMossCodecConfig, ttsAudioUrl } from "../../../channels/tts/src/admin-assets.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";

const fs = await import("node:fs");
const path = await import("node:path");
const maxPluginAssetUploadBytes = 100 * 1024 * 1024;
const maxPluginModelAssetUploadBytes = 512 * 1024 * 1024;
type AdminPluginKind = "channel" | "tool" | "voice" | "asr" | "presentation" | "context";
type AdminPluginStatus = "enabled" | "disabled" | "planned" | "external_config" | "missing_config" | "error";
type AdminPluginHealth = "healthy" | "degraded" | "failing" | "unknown";

type AdminPluginSummary = {
  id: string;
  name: string;
  kind: AdminPluginKind;
  status: AdminPluginStatus;
  health: AdminPluginHealth;
  description: string;
  configurable: boolean;
  switchable: boolean;
  configSource?: string;
  lastLoadedAt?: string;
  lastUsedAt?: string;
};

type TtsAdminConfig = {
  enabled: boolean;
  remote?: {
    enabled?: boolean;
    baseURL?: string;
    localFallbackEnabled?: boolean;
  };
  conversion?: {
    provider?: "genie" | "openai-api" | "bailian";
    genie?: {
      enabled?: boolean;
      baseURL?: string;
      localFallbackEnabled?: boolean;
    };
    openaiApi?: {
      apiPresetName?: string;
      model?: string;
      voice?: string;
      timeoutMs?: number;
      sampleRate?: number;
      channels?: number;
      extraParamsJson?: string;
    };
    bailian?: {
      service?: "qwen" | "cosy";
      endpoint?: string;
      apiKey?: string;
      apiKeyEnv?: string;
      workspaceId?: string;
      userAgent?: string;
      model?: string;
      voice?: string;
      languageType?: string;
      mode?: "server_commit" | "commit";
      responseFormat?: string;
      timeoutMs?: number;
      sampleRate?: number;
      channels?: number;
      extraParamsJson?: string;
    };
  };
  translationPresetName?: string;
  translationEditPresetName?: string;
  newTranslationPresetName?: string;
  translationPresets?: Record<string, {
    translationEnabled?: boolean;
    apiPresetName?: string;
    prompt?: string;
  }>;
  currentTranslation?: {
    translationEnabled?: boolean;
    apiPresetName?: string;
    prompt?: string;
  };
  voice: {
    modelConfigName?: string;
    modelEditPresetName?: string;
    newModelConfigName?: string;
    modelConfigs?: Record<string, {
      language?: "jp" | "zh" | "en";
      speed?: number;
      partSilenceSeconds?: number;
      splitText?: boolean;
    }>;
    currentModel?: {
      language?: "jp" | "zh" | "en";
      speed?: number;
      partSilenceSeconds?: number;
      splitText?: boolean;
      modelDir?: string;
      referenceAudio?: string;
      referenceText?: string;
    };
  };
};

type AdminPluginFieldType = "switch" | "text" | "password" | "number" | "textarea" | "select" | "apiPresetSelect" | "fileUpload" | "folderUpload" | "readonly";

type AdminPluginConfigField = {
  key: string;
  label: string;
  type: AdminPluginFieldType;
  group?: string;
  description?: string;
  assetKey?: string;
  accept?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
};

type AdminPluginRegistryEntry = {
  summary(context: AdminRoutesContext): AdminPluginSummary;
  config?(context: AdminRoutesContext): unknown;
  patch?(context: AdminRoutesContext, patch: Record<string, unknown>): { config: unknown } | { error: string };
  setEnabled?(context: AdminRoutesContext, enabled: boolean): { config: unknown } | { error: string };
  reload?(context: AdminRoutesContext): { config: unknown } | { error: string };
  test?(context: AdminRoutesContext, input: Record<string, unknown>): Promise<{ ok: true; result?: unknown } | { error: string }> | { ok: true; result?: unknown } | { error: string };
  uploadAsset?(context: AdminRoutesContext, assetKey: string, request: any): Promise<{ config: unknown; assetPath: string } | { error: string; statusCode?: number }>;
  configSchema?: {
    groups?: Array<{ key: string; label: string }>;
    fields: AdminPluginConfigField[];
  };
  routePreview?: string[];
  runtimeAccess?: string[];
  testSchema?: {
    input: "text" | "audio";
    label: string;
    buttonLabel: string;
    defaultValue?: string;
  };
};

export async function handleAdminPluginApi(context: AdminRoutesContext, request: any, response: any): Promise<boolean> {
  if (!request.url?.startsWith("/admin/api/plugins")) return false;
  const url = new URL(request.url, "http://admin.local");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "admin" || parts[1] !== "api" || parts[2] !== "plugins") return false;

  if (request.method === "GET" && parts.length === 3) {
    writeJson(response, 200, { plugins: listAdminPlugins(context) });
    return true;
  }

  const pluginId = parts[3] ?? "";
  const action = parts[4];
  if (!pluginId || !action) return false;

  if (request.method === "POST" && action === "assets" && parts.length === 6) {
    await uploadAdminPluginAsset(context, request, response, pluginId, parts[5]);
    return true;
  }

  if (parts.length !== 5) return false;

  if (request.method === "GET" && action === "config") {
    writeAdminPluginConfig(context, response, pluginId);
    return true;
  }
  if (request.method === "PATCH" && action === "config") {
    await patchAdminPluginConfig(context, request, response, pluginId);
    return true;
  }
  if (request.method === "POST" && action === "enable") {
    await setAdminPluginEnabled(context, response, pluginId, true);
    return true;
  }
  if (request.method === "POST" && action === "disable") {
    await setAdminPluginEnabled(context, response, pluginId, false);
    return true;
  }
  if (request.method === "POST" && action === "reload") {
    reloadAdminPlugin(context, response, pluginId);
    return true;
  }
  if (request.method === "POST" && action === "test") {
    await testAdminPlugin(context, request, response, pluginId);
    return true;
  }
  if (request.method === "GET" && action === "events") {
    writeAdminPluginEvents(context, response, pluginId);
    return true;
  }

  return false;
}

function listAdminPlugins(context: AdminRoutesContext): AdminPluginSummary[] {
  return adminPluginRegistry(context).map((entry) => entry.summary(context));
}

function findAdminPluginEntry(context: AdminRoutesContext, pluginId: string): AdminPluginRegistryEntry | undefined {
  return adminPluginRegistry(context).find((entry) => entry.summary(context).id === pluginId);
}

function adminPluginRegistry(_context: AdminRoutesContext): AdminPluginRegistryEntry[] {
  return [
    asrPluginEntry(),
    ttsPluginEntry(),
    photoPluginEntry(),
    googleStreetViewPluginEntry(),
    worldWandererPluginEntry(),
    feishuPluginEntry()
  ];
}

function writeAdminPluginConfig(context: AdminRoutesContext, response: any, pluginId: string): void {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!plugin.configurable || !entry?.config) {
    writeJson(response, 400, { ok: false, error: "plugin_not_configurable" });
    return;
  }
  writeJson(response, 200, adminPluginConfigPayload(context, entry));
}

async function patchAdminPluginConfig(context: AdminRoutesContext, request: any, response: any, pluginId: string): Promise<void> {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!plugin.configurable || !entry?.patch) {
    writeJson(response, 400, { ok: false, error: "plugin_not_configurable" });
    return;
  }
  const body = await readJsonBody(request);
  const result = entry.patch(context, body);
  if ("error" in result) {
    writeJson(response, 400, { ok: false, error: result.error });
    return;
  }
  context.appendLog("info", `plugin ${plugin.id} config saved`);
  writeJson(response, 200, {
    ok: true,
    plugin: entry.summary(context),
    configValue: result.config
  });
}

async function setAdminPluginEnabled(context: AdminRoutesContext, response: any, pluginId: string, enabled: boolean): Promise<void> {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!plugin.switchable || !entry?.setEnabled) {
    writeJson(response, 400, { ok: false, error: "plugin_not_switchable" });
    return;
  }
  const result = entry.setEnabled(context, enabled);
  if ("error" in result) {
    writeJson(response, 400, { ok: false, error: result.error });
    return;
  }
  context.appendLog("info", `plugin ${plugin.id} ${enabled ? "enabled" : "disabled"}`);
  writeJson(response, 200, {
    ok: true,
    plugin: entry.summary(context),
    configValue: result.config
  });
}

function reloadAdminPlugin(context: AdminRoutesContext, response: any, pluginId: string): void {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!plugin.configurable || !entry?.reload) {
    writeJson(response, 400, { ok: false, error: "plugin_not_configurable" });
    return;
  }
  const result = entry.reload(context);
  if ("error" in result) {
    writeJson(response, 400, { ok: false, error: result.error });
    return;
  }
  context.appendLog("info", `plugin ${plugin.id} config reloaded`);
  writeJson(response, 200, {
    ok: true,
    plugin: entry.summary(context),
    configValue: result.config
  });
}

async function testAdminPlugin(context: AdminRoutesContext, request: any, response: any, pluginId: string): Promise<void> {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!entry?.test) {
    writeJson(response, 400, { ok: false, error: "plugin_test_unavailable" });
    return;
  }
  const body = await readJsonBody(request);
  const result = await entry.test(context, body);
  writeJson(response, "error" in result ? 400 : 200, "error" in result ? { ok: false, error: result.error } : result);
}

function writeAdminPluginEvents(context: AdminRoutesContext, response: any, pluginId: string): void {
  const plugin = findAdminPluginEntry(context, pluginId)?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  writeJson(response, 200, { events: listAdminPluginEvents(context, pluginId) });
}

async function uploadAdminPluginAsset(context: AdminRoutesContext, request: any, response: any, pluginId: string, assetKey: string): Promise<void> {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!entry?.uploadAsset) {
    writeJson(response, 400, { ok: false, error: "plugin_not_configurable" });
    return;
  }
  const result = await entry.uploadAsset(context, assetKey, request);
  if ("error" in result) {
    writeJson(response, result.statusCode ?? 400, { ok: false, error: result.error });
    return;
  }
  context.appendLog("info", `plugin ${plugin.id} asset uploaded: ${assetKey} -> ${result.assetPath}`);
  writeJson(response, 200, {
    ok: true,
    plugin: entry.summary(context),
    assetPath: result.assetPath,
    configValue: result.config
  });
}

function adminPluginConfigPayload(context: AdminRoutesContext, entry: AdminPluginRegistryEntry): unknown {
  const plugin = entry.summary(context);
  const configValue = entry.config?.(context) ?? {};
  const configSchema = withDynamicPluginConfigSchema(plugin.id, entry.configSchema ?? { fields: [] }, configValue);
  return {
    plugin: {
      ...plugin,
      version: "local"
    },
    configSchema,
    configValue,
    apiPresets: publicLLMApiPresets(readLLMApiPresets(context)),
    routePreview: entry.routePreview ?? [],
    runtimeAccess: entry.runtimeAccess ?? [],
    testSchema: entry.testSchema
  };
}

function withDynamicPluginConfigSchema(pluginId: string, schema: NonNullable<AdminPluginRegistryEntry["configSchema"]>, configValue: unknown): NonNullable<AdminPluginRegistryEntry["configSchema"]> {
  if (pluginId !== "tts") return schema;
  const config = configValue as TtsAdminConfig;
  const translationNames = Object.keys(config.translationPresets ?? {});
  const modelNames = Object.keys(config.voice.modelConfigs ?? {});
  return {
    ...schema,
    fields: schema.fields.map((field) => field.key === "translationPresetName" || field.key === "translationEditPresetName"
      ? {
        ...field,
        options: translationNames.map((name) => ({ value: name, label: name }))
      }
      : field.key === "voice.modelConfigName" || field.key === "voice.modelEditPresetName"
      ? {
        ...field,
        options: modelNames.map((name) => ({ value: name, label: name }))
      }
      : field)
  };
}

function photoPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return photoPluginSummary(context);
    },
    config(context) {
      return publicPhotoPluginConfig(readPhotoConfigForAdmin(context));
    },
    patch(context, patch) {
      const result = updatePhotoConfig(context, patch);
      return "error" in result ? result : { config: publicPhotoPluginConfig(result.config) };
    },
    setEnabled(context, enabled) {
      const result = updatePhotoConfig(context, { enabled });
      return "error" in result ? result : { config: publicPhotoPluginConfig(result.config) };
    },
    reload(context) {
      return { config: publicPhotoPluginConfig(readPhotoConfigForAdmin(context)) };
    },
    configSchema: {
      groups: [
        { key: "general", label: "General" },
        { key: "openai", label: "OpenAI" },
        { key: "openai_relay", label: "OpenAI Relay" },
        { key: "codex", label: "Codex" },
        { key: "storage", label: "Storage" }
      ],
      fields: [
        { key: "enabled", label: "Enabled", type: "switch", group: "general", description: "Enable or disable the selfie tool route." },
        { key: "selfieMode", label: "Selfie Mode", type: "select", group: "general", options: [
          { value: "openai", label: "OpenAI" },
          { value: "openaiRelay", label: "OpenAI Relay" },
          { value: "codex", label: "Codex" }
        ], description: "OpenAI and OpenAI Relay use the same Image API build settings with different keys/base URLs. Codex starts an ephemeral Codex CLI session with alice-selfie-fast." },
        { key: "selfieImageApiKeySet", label: "API Key Set", type: "readonly", group: "openai" },
        { key: "selfieImageApiKey", label: "API Key", type: "password", group: "openai", description: "Leave blank to keep the current key." },
        { key: "selfieImageApiBaseURL", label: "Base URL", type: "text", group: "openai" },
        { key: "selfieImageApiModel", label: "Model", type: "text", group: "openai" },
        { key: "selfieImageApiSize", label: "Size", type: "text", group: "openai" },
        { key: "selfieImageApiQuality", label: "Quality", type: "text", group: "openai" },
        { key: "selfieImageApiModeration", label: "Moderation", type: "select", group: "openai", options: [
          { value: "auto", label: "auto" },
          { value: "low", label: "low" }
        ] },
        { key: "selfieImageApiOutputFormat", label: "Output Format", type: "select", group: "openai", options: [
          { value: "jpeg", label: "jpeg" },
          { value: "png", label: "png" },
          { value: "webp", label: "webp" }
        ] },
        { key: "selfieImageApiOutputCompression", label: "Output Compression", type: "number", group: "openai", min: 0, max: 100, step: 1 },
        { key: "selfieImageApiTimeoutMs", label: "Timeout Ms", type: "number", group: "openai", min: 1000, max: 600000, step: 1000 },
        { key: "selfieImageApiRelayKeySet", label: "API Key Set", type: "readonly", group: "openai_relay" },
        { key: "selfieImageApiRelayKey", label: "API Key", type: "password", group: "openai_relay", description: "Leave blank to keep the current key." },
        { key: "selfieImageApiRelayBaseURL", label: "Base URL", type: "text", group: "openai_relay" },
        { key: "selfieImageApiRelayModel", label: "Model", type: "text", group: "openai_relay" },
        { key: "selfieImageApiRelaySize", label: "Size", type: "text", group: "openai_relay" },
        { key: "selfieImageApiRelayQuality", label: "Quality", type: "text", group: "openai_relay" },
        { key: "selfieImageApiRelayModeration", label: "Moderation", type: "select", group: "openai_relay", options: [
          { value: "auto", label: "auto" },
          { value: "low", label: "low" }
        ] },
        { key: "selfieImageApiRelayOutputFormat", label: "Output Format", type: "select", group: "openai_relay", options: [
          { value: "jpeg", label: "jpeg" },
          { value: "png", label: "png" },
          { value: "webp", label: "webp" }
        ] },
        { key: "selfieImageApiRelayOutputCompression", label: "Output Compression", type: "number", group: "openai_relay", min: 0, max: 100, step: 1 },
        { key: "selfieImageApiRelayTimeoutMs", label: "Timeout Ms", type: "number", group: "openai_relay", min: 1000, max: 600000, step: 1000 },
        { key: "selfieCodexCommand", label: "Codex Command", type: "text", group: "codex" },
        { key: "selfieCodexTimeoutMs", label: "Codex Timeout Ms", type: "number", group: "codex", min: 1000, max: 600000, step: 1000 },
        { key: "selfieReferenceDir", label: "Reference Folder", type: "text", group: "storage" },
        { key: "selfieOutputDir", label: "Output Folder", type: "text", group: "storage", description: "Must stay under assets/ so generated images can be routed as assets." },
        { key: "selfieMaxBytes", label: "Max Image Bytes", type: "number", group: "storage", min: 1024, max: 52428800, step: 1024 }
      ]
    },
    routePreview: [
      "selfie tool call",
      "photo plugin config",
      "Image API path or ephemeral Codex CLI session",
      "channel.image.send"
    ],
    runtimeAccess: [
      "read selfie prompt template and reference images",
      "call selected Image API or ephemeral Codex CLI session",
      "write generated image under assets/generated/selfies",
      "send generated image to the current messaging session"
    ]
  };
}

function asrPluginEntry(): AdminPluginRegistryEntry {
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
        { key: "tencent", label: "Tencent Cloud" }
      ],
      fields: [
        { key: "enabled", label: "Enabled", type: "switch", group: "general", description: "Enable or disable ASR requests." },
        { key: "defaultProvider", label: "Default Provider", type: "select", group: "general", options: [
          { value: "openai_compatible", label: "OpenAI Compatible" },
          { value: "tencent", label: "Tencent Cloud" }
        ], description: "Provider used when callers do not explicitly choose one." },
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

function ttsPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return ttsPluginSummary(context);
    },
    config(context) {
      return publicTtsConfig(readTtsConfigForAdmin(context));
    },
    patch(context, patch) {
      const result = updateTtsConfig(context, patch);
      return "error" in result ? result : { config: publicTtsConfig(result.config) };
    },
    setEnabled(context, enabled) {
      const result = updateTtsConfig(context, { enabled });
      return "error" in result ? result : { config: publicTtsConfig(result.config) };
    },
    reload(context) {
      return { config: publicTtsConfig(readTtsConfigForAdmin(context)) };
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
        { key: "general", label: "Common Settings" }
      ],
      fields: [
        { key: "translationEditPresetName", label: "Translation Preset", type: "select", group: "translation", options: [], description: "Select the translation preset to edit." },
        { key: "newTranslationPresetName", label: "Create or Rename", type: "text", group: "translation", description: "Enter a translation preset name and save to create/switch to it." },
        { key: "currentTranslation.translationEnabled", label: "Translate Text", type: "switch", group: "general", description: "Translate text before TTS. Disable to send the original text directly to the selected voice model." },
        { key: "currentTranslation.apiPresetName", label: "API Preset", type: "apiPresetSelect", group: "translation", description: "Select a saved API preset. The plugin does not store API keys." },
        { key: "currentTranslation.prompt", label: "Prompt", type: "textarea", group: "translation", description: "Prompt used by this plugin before it calls the selected API preset." },
        { key: "voice.modelEditPresetName", label: "Model Preset", type: "select", group: "model_genie", options: [], description: "Select the model preset to edit." },
        { key: "voice.newModelConfigName", label: "Create or Rename", type: "text", group: "model_genie", description: "Enter a model preset name and save to create/switch to it." },
        { key: "voice.currentModel.language", label: "Voice Language", type: "select", group: "model_genie", options: [
          { value: "jp", label: "Japanese" },
          { value: "zh", label: "Chinese" },
          { value: "en", label: "English" }
        ], description: "Genie language used for this TTS voice route." },
        { key: "voice.currentModel.modelDir", label: "Model Folder", type: "folderUpload", group: "model_genie", assetKey: "model", description: "Genie model folder for the selected model config." },
        { key: "voice.currentModel.referenceAudio", label: "Reference Audio", type: "fileUpload", group: "model_genie", assetKey: "reference-audio", accept: "audio/*", description: "Reference audio for the selected model config." },
        { key: "voice.currentModel.referenceText", label: "Reference Text", type: "textarea", group: "model_genie", description: "Reference text for the selected model preset. It is stored at assets/tts/preset/{preset}/reference.txt on save." },
        { key: "voice.currentModel.speed", label: "Voice Speed", type: "number", group: "model_genie", min: 0.5, max: 2, step: 0.05, description: "Optional Genie playback speed multiplier from 0.5 to 2.0." },
        { key: "voice.currentModel.splitText", label: "Split Text", type: "switch", group: "model_genie", description: "Whether this preset lets Genie split one TTS text into multiple synthesized parts. Default is off." },
        { key: "voice.currentModel.partSilenceSeconds", label: "Part Silence", type: "number", group: "model_genie", min: 0, max: 3, step: 0.05, description: "Optional silence in seconds inserted between split Genie audio parts. Default is 0.67." },
        { key: "translationPresetName", label: "Active Translation Preset", type: "select", group: "general", options: [], description: "Translation preset used at runtime." },
        { key: "voice.modelConfigName", label: "Active Model Preset", type: "select", group: "general", options: [], description: "Model preset used at runtime." },
        { key: "conversion.provider", label: "Conversion Backend", type: "select", group: "general", options: [
          { value: "genie", label: "Genie" },
          { value: "openai-api", label: "OpenAI-API" },
          { value: "bailian", label: "Bailian" }
        ], description: "Backend used after optional translation." },
        { key: "enabled", label: "Enabled", type: "switch", group: "general", description: "Enable or disable this plugin route." },
        { key: "conversion.genie.enabled", label: "Remote Genie", type: "switch", group: "model_genie", description: "Use the LAN Genie TTS service before falling back to local Genie." },
        { key: "conversion.genie.localFallbackEnabled", label: "Local Genie Fallback", type: "switch", group: "model_genie", description: "Allow local Genie only after a non-local Genie route fails. Disable to keep API and remote routes from starting local Genie." },
        { key: "conversion.genie.baseURL", label: "Remote Genie IP/URL", type: "text", group: "model_genie", description: "Remote Genie TTS IP or base URL. Bare IP/host values default to http://{host}:8767." },
        { key: "conversion.openaiApi.apiPresetName", label: "API Preset", type: "apiPresetSelect", group: "conversion_openai_api", description: "OpenAI-compatible speech API preset. The plugin does not expose API keys in public config." },
        { key: "conversion.openaiApi.model", label: "Model", type: "text", group: "conversion_openai_api", description: "Speech model sent as model in POST /audio/speech." },
        { key: "conversion.openaiApi.voice", label: "Voice", type: "text", group: "conversion_openai_api", description: "Voice name or custom voice ID sent as voice." },
        { key: "conversion.openaiApi.timeoutMs", label: "Timeout Ms", type: "number", group: "conversion_openai_api", min: 1000, max: 300000, step: 1000, description: "Request timeout for OpenAI-API speech calls." },
        { key: "conversion.openaiApi.sampleRate", label: "PCM Sample Rate", type: "number", group: "conversion_openai_api", min: 8000, max: 48000, step: 1000, description: "PCM sample rate used to estimate chunk text timing. Default is 32000." },
        { key: "conversion.openaiApi.channels", label: "PCM Channels", type: "number", group: "conversion_openai_api", min: 1, max: 2, step: 1, description: "PCM channel count used to estimate chunk text timing. Default is 1." },
        { key: "conversion.openaiApi.extraParamsJson", label: "Extra Params JSON", type: "textarea", group: "conversion_openai_api", description: "Optional JSON object merged into the speech request before input/model/voice/response_format." },
        { key: "conversion.bailian.service", label: "Bailian Service", type: "select", group: "conversion_bailian", options: [
          { value: "qwen", label: "Qwen TTS" },
          { value: "cosy", label: "CosyVoice" }
        ], description: "Bailian TTS service family. CosyVoice uses the SpeechSynthesizer endpoint." },
        { key: "conversion.bailian.endpoint", label: "HTTP Endpoint", type: "text", group: "conversion_bailian", description: "Bailian HTTP endpoint. Qwen defaults to aigc/multimodal-generation; CosyVoice defaults to audio/tts/SpeechSynthesizer." },
        { key: "conversion.bailian.apiKey", label: "API Key", type: "password", group: "conversion_bailian", description: "Bailian DashScope API key stored in the local ignored plugin config. Leave blank to keep unchanged." },
        { key: "conversion.bailian.apiKeyEnv", label: "API Key Env", type: "text", group: "conversion_bailian", description: "Environment variable containing the Bailian DashScope API key. Default is DASHSCOPE_API_KEY." },
        { key: "conversion.bailian.workspaceId", label: "Workspace ID", type: "text", group: "conversion_bailian", description: "Optional Bailian workspace id sent as X-DashScope-WorkSpace." },
        { key: "conversion.bailian.userAgent", label: "User Agent", type: "text", group: "conversion_bailian", description: "Optional user-agent sent with the HTTP request." },
        { key: "conversion.bailian.model", label: "Model", type: "text", group: "conversion_bailian", description: "Bailian Qwen-TTS non-realtime model name." },
        { key: "conversion.bailian.voice", label: "Voice", type: "text", group: "conversion_bailian", description: "Bailian voice name or custom voice ID." },
        { key: "conversion.bailian.languageType", label: "Language Type", type: "text", group: "conversion_bailian", description: "Qwen-TTS language_type, for example Chinese, Japanese, English, or Auto." },
        { key: "conversion.bailian.mode", label: "Mode", type: "select", group: "conversion_bailian", options: [
          { value: "server_commit", label: "Server Commit" },
          { value: "commit", label: "Commit" }
        ], description: "Retained for older configs; non-realtime streaming uses HTTP SSE." },
        { key: "conversion.bailian.responseFormat", label: "Response Format", type: "text", group: "conversion_bailian", description: "Local PCM format label for playback; Bailian non-realtime SSE returns PCM audio data." },
        { key: "conversion.bailian.timeoutMs", label: "Timeout Ms", type: "number", group: "conversion_bailian", min: 1000, max: 300000, step: 1000, description: "Request timeout for Bailian non-realtime TTS." },
        { key: "conversion.bailian.sampleRate", label: "PCM Sample Rate", type: "number", group: "conversion_bailian", min: 8000, max: 48000, step: 1000, description: "PCM sample rate returned by Bailian. Default is 24000." },
        { key: "conversion.bailian.channels", label: "PCM Channels", type: "number", group: "conversion_bailian", min: 1, max: 2, step: 1, description: "PCM channel count returned by Bailian. Default is 1." },
        { key: "conversion.bailian.extraParamsJson", label: "Extra Params JSON", type: "textarea", group: "conversion_bailian", description: "Optional JSON object merged into Bailian Qwen-TTS input fields." },
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
    ]
  };
}

function feishuPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return {
        id: "feishu",
        name: "Feishu",
        kind: "channel",
        status: "external_config",
        health: context.runtime.feishuStarted ? "healthy" : "unknown",
        description: "Feishu channel plugin for inbound and outbound messages.",
        configurable: false,
        switchable: false,
        configSource: ".env"
      };
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

function photoPluginSummary(context: AdminRoutesContext, config = readPhotoConfigForAdmin(context)): AdminPluginSummary {
  const missingConfig = config.enabled && (config.selfieMode === "openai" || config.selfieMode === "openaiRelay") && !selectedPhotoImageApiKey(config);
  return {
    id: "photo",
    name: "Photo",
    kind: "tool",
    status: missingConfig ? "missing_config" : config.enabled ? "enabled" : "disabled",
    health: missingConfig ? "degraded" : config.enabled ? "healthy" : "unknown",
    description: "Generate and send selfie images through the Image API path or an ephemeral Codex CLI session.",
    configurable: true,
    switchable: true,
    configSource: photoConfigPath(context),
    lastLoadedAt: photoConfigMtime(context)
  };
}

function updatePhotoConfig(context: AdminRoutesContext, patch: Record<string, unknown>): { config: PhotoPluginConfig } | { error: string } {
  const current = readPhotoConfigForAdmin(context);
  const next: PhotoPluginConfig = {
    ...current,
    enabled: patch.enabled === undefined ? current.enabled : booleanFromUnknown(patch.enabled),
    selfieMode: patch.selfieMode === undefined ? current.selfieMode : photoSelfieModeFromUnknown(patch.selfieMode),
    selfieReferenceDir: patch.selfieReferenceDir === undefined ? current.selfieReferenceDir : requiredString(patch.selfieReferenceDir).trim(),
    selfieOutputDir: patch.selfieOutputDir === undefined ? current.selfieOutputDir : requiredString(patch.selfieOutputDir).trim(),
    selfieCodexCommand: patch.selfieCodexCommand === undefined ? current.selfieCodexCommand : requiredString(patch.selfieCodexCommand).trim(),
    selfieCodexTimeoutMs: patch.selfieCodexTimeoutMs === undefined ? current.selfieCodexTimeoutMs : numberFromUnknown(patch.selfieCodexTimeoutMs, current.selfieCodexTimeoutMs),
    selfieImageApiKey: patch.selfieImageApiKey === undefined ? current.selfieImageApiKey : secretStringFromUnknown(patch.selfieImageApiKey, current.selfieImageApiKey),
    selfieImageApiBaseURL: patch.selfieImageApiBaseURL === undefined ? current.selfieImageApiBaseURL : requiredString(patch.selfieImageApiBaseURL).trim().replace(/\/+$/, ""),
    selfieImageApiRelayKey: patch.selfieImageApiRelayKey === undefined ? current.selfieImageApiRelayKey : secretStringFromUnknown(patch.selfieImageApiRelayKey, current.selfieImageApiRelayKey),
    selfieImageApiRelayBaseURL: patch.selfieImageApiRelayBaseURL === undefined ? current.selfieImageApiRelayBaseURL : requiredString(patch.selfieImageApiRelayBaseURL).trim().replace(/\/+$/, ""),
    selfieImageApiModel: patch.selfieImageApiModel === undefined ? current.selfieImageApiModel : requiredString(patch.selfieImageApiModel).trim(),
    selfieImageApiSize: patch.selfieImageApiSize === undefined ? current.selfieImageApiSize : requiredString(patch.selfieImageApiSize).trim(),
    selfieImageApiQuality: patch.selfieImageApiQuality === undefined ? current.selfieImageApiQuality : requiredString(patch.selfieImageApiQuality).trim(),
    selfieImageApiModeration: patch.selfieImageApiModeration === undefined ? current.selfieImageApiModeration : photoModerationFromUnknown(patch.selfieImageApiModeration, current.selfieImageApiModeration),
    selfieImageApiOutputFormat: patch.selfieImageApiOutputFormat === undefined ? current.selfieImageApiOutputFormat : photoOutputFormatFromUnknown(patch.selfieImageApiOutputFormat, current.selfieImageApiOutputFormat),
    selfieImageApiOutputCompression: patch.selfieImageApiOutputCompression === undefined ? current.selfieImageApiOutputCompression : numberFromUnknown(patch.selfieImageApiOutputCompression, current.selfieImageApiOutputCompression),
    selfieImageApiTimeoutMs: patch.selfieImageApiTimeoutMs === undefined ? current.selfieImageApiTimeoutMs : numberFromUnknown(patch.selfieImageApiTimeoutMs, current.selfieImageApiTimeoutMs),
    selfieImageApiRelayModel: patch.selfieImageApiRelayModel === undefined ? current.selfieImageApiRelayModel : requiredString(patch.selfieImageApiRelayModel).trim(),
    selfieImageApiRelaySize: patch.selfieImageApiRelaySize === undefined ? current.selfieImageApiRelaySize : requiredString(patch.selfieImageApiRelaySize).trim(),
    selfieImageApiRelayQuality: patch.selfieImageApiRelayQuality === undefined ? current.selfieImageApiRelayQuality : requiredString(patch.selfieImageApiRelayQuality).trim(),
    selfieImageApiRelayModeration: patch.selfieImageApiRelayModeration === undefined ? current.selfieImageApiRelayModeration : photoModerationFromUnknown(patch.selfieImageApiRelayModeration, current.selfieImageApiRelayModeration),
    selfieImageApiRelayOutputFormat: patch.selfieImageApiRelayOutputFormat === undefined ? current.selfieImageApiRelayOutputFormat : photoOutputFormatFromUnknown(patch.selfieImageApiRelayOutputFormat, current.selfieImageApiRelayOutputFormat),
    selfieImageApiRelayOutputCompression: patch.selfieImageApiRelayOutputCompression === undefined ? current.selfieImageApiRelayOutputCompression : numberFromUnknown(patch.selfieImageApiRelayOutputCompression, current.selfieImageApiRelayOutputCompression),
    selfieImageApiRelayTimeoutMs: patch.selfieImageApiRelayTimeoutMs === undefined ? current.selfieImageApiRelayTimeoutMs : numberFromUnknown(patch.selfieImageApiRelayTimeoutMs, current.selfieImageApiRelayTimeoutMs),
    selfieMaxBytes: patch.selfieMaxBytes === undefined ? current.selfieMaxBytes : numberFromUnknown(patch.selfieMaxBytes, current.selfieMaxBytes)
  };

  const validationError = validatePhotoConfig(next);
  if (validationError) return { error: validationError };
  writePhotoConfig(context, next);
  return { config: next };
}

function validatePhotoConfig(config: PhotoPluginConfig): string | undefined {
  if (config.selfieMode !== "openai" && config.selfieMode !== "openaiRelay" && config.selfieMode !== "codex") return "invalid_selfie_mode";
  if (!config.selfieReferenceDir) return "missing_selfie_reference_dir";
  if (!config.selfieOutputDir || !isPathUnderAssets(config.selfieOutputDir)) return "invalid_selfie_output_dir";
  if (!config.selfieCodexCommand) return "missing_selfie_codex_command";
  if (invalidNumber(config.selfieCodexTimeoutMs, 1000, 600_000)) return "invalid_selfie_codex_timeout";
  if (!isValidHttpUrl(config.selfieImageApiBaseURL)) return "invalid_selfie_api_base_url";
  if (!isValidHttpUrl(config.selfieImageApiRelayBaseURL)) return "invalid_selfie_api_relay_base_url";
  if (!config.selfieImageApiModel) return "missing_selfie_api_model";
  if (!config.selfieImageApiSize) return "missing_selfie_api_size";
  if (!config.selfieImageApiQuality) return "missing_selfie_api_quality";
  if (!["auto", "low"].includes(config.selfieImageApiModeration)) return "invalid_selfie_api_moderation";
  if (!["jpeg", "png", "webp"].includes(config.selfieImageApiOutputFormat)) return "invalid_selfie_output_format";
  if (invalidNumber(config.selfieImageApiOutputCompression, 0, 100)) return "invalid_selfie_output_compression";
  if (invalidNumber(config.selfieImageApiTimeoutMs, 1000, 600_000)) return "invalid_selfie_api_timeout";
  if (!config.selfieImageApiRelayModel) return "missing_selfie_api_relay_model";
  if (!config.selfieImageApiRelaySize) return "missing_selfie_api_relay_size";
  if (!config.selfieImageApiRelayQuality) return "missing_selfie_api_relay_quality";
  if (!["auto", "low"].includes(config.selfieImageApiRelayModeration)) return "invalid_selfie_api_relay_moderation";
  if (!["jpeg", "png", "webp"].includes(config.selfieImageApiRelayOutputFormat)) return "invalid_selfie_relay_output_format";
  if (invalidNumber(config.selfieImageApiRelayOutputCompression, 0, 100)) return "invalid_selfie_relay_output_compression";
  if (invalidNumber(config.selfieImageApiRelayTimeoutMs, 1000, 600_000)) return "invalid_selfie_api_relay_timeout";
  if (invalidNumber(config.selfieMaxBytes, 1024, 50 * 1024 * 1024)) return "invalid_selfie_max_bytes";
  return undefined;
}

function readPhotoConfigForAdmin(context: AdminRoutesContext): PhotoPluginConfig {
  return readPhotoPluginConfig(photoConfigPath(context), photoConfigDefaultsForAdmin(context));
}

function writePhotoConfig(context: AdminRoutesContext, config: PhotoPluginConfig): void {
  const filePath = photoConfigPath(context);
  const persisted: Partial<PhotoPluginConfig> = { ...config };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(persisted, null, 2)}\n`);
}

function photoConfigDefaultsForAdmin(context: AdminRoutesContext): Partial<PhotoPluginConfig> {
  const photo = ((context.config as Partial<AppConfig>).photo ?? {}) as Partial<PhotoPluginConfig>;
  return {
    enabled: true,
    selfieMode: "openai",
    selfieReferenceDir: photo.selfieReferenceDir,
    selfieOutputDir: photo.selfieOutputDir,
    selfieCodexCommand: photo.selfieCodexCommand,
    selfieCodexTimeoutMs: photo.selfieCodexTimeoutMs,
    selfieImageApiKey: photo.selfieImageApiKey,
    selfieImageApiBaseURL: photo.selfieImageApiBaseURL,
    selfieImageApiRelayKey: photo.selfieImageApiRelayKey,
    selfieImageApiRelayBaseURL: photo.selfieImageApiRelayBaseURL,
    selfieImageApiModel: photo.selfieImageApiModel,
    selfieImageApiSize: photo.selfieImageApiSize,
    selfieImageApiQuality: photo.selfieImageApiQuality,
    selfieImageApiModeration: photo.selfieImageApiModeration,
    selfieImageApiOutputFormat: photo.selfieImageApiOutputFormat,
    selfieImageApiOutputCompression: photo.selfieImageApiOutputCompression,
    selfieImageApiTimeoutMs: photo.selfieImageApiTimeoutMs,
    selfieImageApiRelayModel: photo.selfieImageApiRelayModel,
    selfieImageApiRelaySize: photo.selfieImageApiRelaySize,
    selfieImageApiRelayQuality: photo.selfieImageApiRelayQuality,
    selfieImageApiRelayModeration: photo.selfieImageApiRelayModeration,
    selfieImageApiRelayOutputFormat: photo.selfieImageApiRelayOutputFormat,
    selfieImageApiRelayOutputCompression: photo.selfieImageApiRelayOutputCompression,
    selfieImageApiRelayTimeoutMs: photo.selfieImageApiRelayTimeoutMs,
    selfieMaxBytes: photo.selfieMaxBytes
  };
}

function photoConfigPath(context: AdminRoutesContext): string {
  return context.pluginConfigs?.photo?.configPath ?? defaultPhotoPluginConfigPath;
}

function photoConfigMtime(context: AdminRoutesContext): string | undefined {
  try {
    const stats = fs.statSync(photoConfigPath(context)) as { mtime?: Date; mtimeMs?: number };
    if (stats.mtime instanceof Date) return stats.mtime.toISOString();
    if (typeof stats.mtimeMs === "number") return new Date(stats.mtimeMs).toISOString();
    return undefined;
  } catch {
    return undefined;
  }
}

function googleStreetViewPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return googleStreetViewPluginSummary(context);
    },
    config(context) {
      return publicGoogleStreetViewPluginConfig(readGoogleStreetViewConfigForAdmin(context));
    },
    patch(context, patch) {
      const result = updateGoogleStreetViewConfig(context, patch);
      return "error" in result ? result : { config: publicGoogleStreetViewPluginConfig(result.config) };
    },
    setEnabled(context, enabled) {
      const result = updateGoogleStreetViewConfig(context, { enabled });
      return "error" in result ? result : { config: publicGoogleStreetViewPluginConfig(result.config) };
    },
    reload(context) {
      return { config: publicGoogleStreetViewPluginConfig(readGoogleStreetViewConfigForAdmin(context)) };
    },
    configSchema: {
      groups: [
        { key: "general", label: "General" },
        { key: "request", label: "Request" },
        { key: "storage", label: "Storage" },
        { key: "regions", label: "Regions" }
      ],
      fields: [
        { key: "enabled", label: "Enabled", type: "switch", group: "general", description: "Enable or disable the Google Street View channel plugin." },
        { key: "apiKeySet", label: "API Key Set", type: "readonly", group: "general" },
        { key: "apiKey", label: "API Key", type: "password", group: "general", description: "Leave blank to keep the current key. The key must allow Street View Static API and Map Tiles API." },
        { key: "imageSize", label: "Image Size", type: "text", group: "request", description: "Google Static Street View size, for example 640x640." },
        { key: "heading", label: "Heading", type: "number", group: "request", min: 0, max: 360, step: 1 },
        { key: "pitch", label: "Pitch", type: "number", group: "request", min: -90, max: 90, step: 1 },
        { key: "fov", label: "FOV", type: "number", group: "request", min: 10, max: 120, step: 1 },
        { key: "initialRadiusMeters", label: "Initial Radius Meters", type: "number", group: "request", min: 0, max: 50000, step: 1 },
        { key: "radiusExpansionFactor", label: "Radius Expansion Factor", type: "number", group: "request", min: 1.01, max: 10, step: 0.01 },
        { key: "maxRadiusMeters", label: "Max Radius Meters", type: "number", group: "request", min: 1, max: 100000, step: 1 },
        { key: "randomAttempts", label: "Random Attempts", type: "number", group: "request", min: 1, max: 100, step: 1 },
        { key: "coordinatePrecision", label: "Coordinate Precision", type: "number", group: "request", min: 0, max: 7, step: 1 },
        { key: "outputDir", label: "Output Folder", type: "text", group: "storage", description: "Must stay under assets/plugin/google-streetview and must not use assets/generated." },
        { key: "regions", label: "Regions JSON", type: "textarea", group: "regions", description: "Array of { id, label, bounds: { north, south, east, west } } entries." }
      ]
    },
    routePreview: [
      "google_streetview.getStreetViewByCoordinates / getRandomStreetView",
      "google_streetview.getPanoGraphByCoordinates / getPanoGraphByPanoId",
      "metadata preflight and radius expansion",
      "Map Tiles Street View metadata links",
      "static street view image download",
      "plugin-owned asset storage"
    ],
    runtimeAccess: [
      "read plugin config",
      "call Google Street View Static API and Map Tiles API metadata endpoints",
      "write images and metadata under assets/plugin/google-streetview",
      "reuse stored metadata when requested"
    ]
  };
}

function googleStreetViewPluginSummary(context: AdminRoutesContext, config = readGoogleStreetViewConfigForAdmin(context)): AdminPluginSummary {
  const validationError = validateGoogleStreetViewPluginConfig(config);
  const missingConfig = config.enabled && !config.apiKey;
  return {
    id: "google_streetview",
    name: "Google Street View",
    kind: "channel",
    status: validationError || missingConfig ? "missing_config" : config.enabled ? "enabled" : "disabled",
    health: validationError || missingConfig ? "degraded" : config.enabled ? "healthy" : "unknown",
    description: "Fetch Google Static Street View images and Map Tiles pano graph metadata into plugin-owned flows.",
    configurable: true,
    switchable: true,
    configSource: googleStreetViewConfigPath(context),
    lastLoadedAt: googleStreetViewConfigMtime(context)
  };
}

function updateGoogleStreetViewConfig(context: AdminRoutesContext, patch: Record<string, unknown>): { config: GoogleStreetViewPluginConfig } | { error: string } {
  const current = readGoogleStreetViewConfigForAdmin(context);
  let regions: GoogleStreetViewRegion[];
  try {
    regions = patch.regions === undefined ? current.regions : googleStreetViewRegionsFromUnknown(patch.regions, current.regions);
  } catch {
    return { error: "invalid_regions" };
  }
  const next: GoogleStreetViewPluginConfig = {
    ...current,
    enabled: patch.enabled === undefined ? current.enabled : booleanFromUnknown(patch.enabled),
    apiKey: patch.apiKey === undefined ? current.apiKey : secretStringFromUnknown(patch.apiKey, current.apiKey),
    imageSize: patch.imageSize === undefined ? current.imageSize : requiredString(patch.imageSize).trim(),
    heading: patch.heading === undefined ? current.heading : numberFromUnknown(patch.heading, current.heading),
    pitch: patch.pitch === undefined ? current.pitch : numberFromUnknown(patch.pitch, current.pitch),
    fov: patch.fov === undefined ? current.fov : numberFromUnknown(patch.fov, current.fov),
    initialRadiusMeters: patch.initialRadiusMeters === undefined ? current.initialRadiusMeters : numberFromUnknown(patch.initialRadiusMeters, current.initialRadiusMeters),
    radiusExpansionFactor: patch.radiusExpansionFactor === undefined ? current.radiusExpansionFactor : numberFromUnknown(patch.radiusExpansionFactor, current.radiusExpansionFactor),
    maxRadiusMeters: patch.maxRadiusMeters === undefined ? current.maxRadiusMeters : numberFromUnknown(patch.maxRadiusMeters, current.maxRadiusMeters),
    randomAttempts: patch.randomAttempts === undefined ? current.randomAttempts : numberFromUnknown(patch.randomAttempts, current.randomAttempts),
    coordinatePrecision: patch.coordinatePrecision === undefined ? current.coordinatePrecision : numberFromUnknown(patch.coordinatePrecision, current.coordinatePrecision),
    outputDir: patch.outputDir === undefined ? current.outputDir : requiredString(patch.outputDir).trim(),
    regions
  };

  if ([
    next.heading,
    next.pitch,
    next.fov,
    next.initialRadiusMeters,
    next.radiusExpansionFactor,
    next.maxRadiusMeters,
    next.randomAttempts,
    next.coordinatePrecision
  ].some((value) => !Number.isFinite(value))) return { error: "invalid_google_streetview_number" };

  const validationError = validateGoogleStreetViewPluginConfig(next);
  if (validationError) return { error: validationError };
  writeGoogleStreetViewConfig(context, next);
  return { config: next };
}

function googleStreetViewRegionsFromUnknown(value: unknown, fallback: GoogleStreetViewRegion[]): GoogleStreetViewRegion[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) throw new Error("invalid_regions");
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("invalid_region");
    const region = entry as { id?: unknown; label?: unknown; bounds?: unknown };
    if (!region.bounds || typeof region.bounds !== "object") throw new Error("invalid_region");
    const bounds = region.bounds as Record<string, unknown>;
    return {
      id: requiredString(region.id).trim(),
      label: optionalString(region.label),
      bounds: {
        north: numberFromUnknown(bounds.north, Number.NaN),
        south: numberFromUnknown(bounds.south, Number.NaN),
        east: numberFromUnknown(bounds.east, Number.NaN),
        west: numberFromUnknown(bounds.west, Number.NaN)
      }
    };
  });
}

function readGoogleStreetViewConfigForAdmin(context: AdminRoutesContext): GoogleStreetViewPluginConfig {
  return readGoogleStreetViewPluginConfig(googleStreetViewConfigPath(context));
}

function writeGoogleStreetViewConfig(context: AdminRoutesContext, config: GoogleStreetViewPluginConfig): void {
  const filePath = googleStreetViewConfigPath(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

function googleStreetViewConfigPath(context: AdminRoutesContext): string {
  return context.pluginConfigs?.googleStreetView?.configPath ?? defaultGoogleStreetViewPluginConfigPath;
}

function googleStreetViewConfigMtime(context: AdminRoutesContext): string | undefined {
  try {
    const stats = fs.statSync(googleStreetViewConfigPath(context)) as { mtime?: Date; mtimeMs?: number };
    if (stats.mtime instanceof Date) return stats.mtime.toISOString();
    if (typeof stats.mtimeMs === "number") return new Date(stats.mtimeMs).toISOString();
    return undefined;
  } catch {
    return undefined;
  }
}

function worldWandererPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return worldWandererPluginSummary(context);
    },
    config(context) {
      return publicWorldWandererConfig(readWorldWandererConfigForAdmin(context));
    },
    patch(context, patch) {
      const result = updateWorldWandererConfig(context, patch);
      return "error" in result ? result : { config: publicWorldWandererConfig(result.config) };
    },
    setEnabled(context, enabled) {
      const result = updateWorldWandererConfig(context, { enabled });
      return "error" in result ? result : { config: publicWorldWandererConfig(result.config) };
    },
    reload(context) {
      return { config: publicWorldWandererConfig(readWorldWandererConfigForAdmin(context)) };
    },
    configSchema: {
      groups: [
        { key: "general", label: "General" },
        { key: "movement", label: "Graph Movement" },
        { key: "policy", label: "Policy" },
        { key: "initial", label: "Initial Position" }
      ],
      fields: [
        { key: "enabled", label: "Enabled", type: "switch", group: "general", description: "Move world-wanderer state on idle timer transitions." },
        { key: "libraryPrompt", label: "Library Prompt", type: "textarea", group: "general", description: "Used as library.content while World Wanderer is enabled. Empty stays empty." },
        { key: "speedMetersPerSecond", label: "Speed Meters Per Second", type: "number", group: "movement", min: 0, max: 10, step: 0.1 },
        { key: "recentHistoryLimit", label: "Recent History Limit", type: "number", group: "movement", min: 1, max: 1000, step: 1 },
        { key: "maxPanosPerIdle", label: "Max Panos Per Idle", type: "number", group: "movement", min: 1, max: 100, step: 1 },
        { key: "noveltyWeight", label: "Novelty Weight", type: "number", group: "policy", min: 0, max: 100, step: 0.1 },
        { key: "forwardWeight", label: "Forward Weight", type: "number", group: "policy", min: 0, max: 100, step: 0.1 },
        { key: "roadContinuityWeight", label: "Road Continuity Weight", type: "number", group: "policy", min: 0, max: 100, step: 0.1 },
        { key: "uturnPenalty", label: "U-turn Penalty", type: "number", group: "policy", min: 0, max: 100, step: 0.1 },
        { key: "loopPenalty", label: "Loop Penalty", type: "number", group: "policy", min: 0, max: 100, step: 0.1 },
        { key: "selectionTemperature", label: "Selection Temperature", type: "number", group: "policy", min: 0.01, max: 100, step: 0.01 },
        { key: "initialLocation", label: "Initial Location JSON", type: "textarea", group: "initial", description: "Object with lat and lng. Defaults near Hagia Sophia." },
        { key: "initialHeading", label: "Initial Heading", type: "number", group: "initial", min: 0, max: 359, step: 1 }
      ]
    },
    routePreview: [
      "idle timer pano graph movement",
      "google_streetview.getPanoGraphByCoordinates / getPanoGraphByPanoId"
    ],
    runtimeAccess: [
      "read plugin config",
      "write world wanderer state under memory state",
      "call Google Street View pano graph metadata through google_streetview"
    ]
  };
}

function worldWandererPluginSummary(context: AdminRoutesContext, config = readWorldWandererConfigForAdmin(context)): AdminPluginSummary {
  const validationError = validateWorldWandererConfig(config);
  return {
    id: "world_wanderer",
    name: "World Wanderer",
    kind: "context",
    status: validationError ? "missing_config" : config.enabled ? "enabled" : "disabled",
    health: validationError ? "degraded" : config.enabled ? "healthy" : "unknown",
    description: "Persistently moves across Google Street View pano graph links during idle timer transitions.",
    configurable: true,
    switchable: true,
    configSource: worldWandererConfigPath(context),
    lastLoadedAt: worldWandererConfigMtime(context)
  };
}

function updateWorldWandererConfig(context: AdminRoutesContext, patch: Record<string, unknown>): { config: WorldWandererConfig } | { error: string } {
  const current = readWorldWandererConfigForAdmin(context);
  let initialLocation = current.initialLocation;
  try {
    initialLocation = patch.initialLocation === undefined ? current.initialLocation : worldWandererLocationFromUnknown(patch.initialLocation, current.initialLocation);
  } catch {
    return { error: "invalid_initial_location" };
  }
  const next: WorldWandererConfig = {
    ...current,
    enabled: patch.enabled === undefined ? current.enabled : booleanFromUnknown(patch.enabled),
    libraryPrompt: patch.libraryPrompt === undefined ? current.libraryPrompt : requiredString(patch.libraryPrompt),
    speedMetersPerSecond: patch.speedMetersPerSecond === undefined ? current.speedMetersPerSecond : numberFromUnknown(patch.speedMetersPerSecond, current.speedMetersPerSecond),
    initialLocation,
    initialHeading: patch.initialHeading === undefined ? current.initialHeading : numberFromUnknown(patch.initialHeading, current.initialHeading),
    recentHistoryLimit: patch.recentHistoryLimit === undefined ? current.recentHistoryLimit : numberFromUnknown(patch.recentHistoryLimit, current.recentHistoryLimit),
    maxPanosPerIdle: patch.maxPanosPerIdle === undefined ? current.maxPanosPerIdle : numberFromUnknown(patch.maxPanosPerIdle, current.maxPanosPerIdle),
    noveltyWeight: patch.noveltyWeight === undefined ? current.noveltyWeight : numberFromUnknown(patch.noveltyWeight, current.noveltyWeight),
    forwardWeight: patch.forwardWeight === undefined ? current.forwardWeight : numberFromUnknown(patch.forwardWeight, current.forwardWeight),
    roadContinuityWeight: patch.roadContinuityWeight === undefined ? current.roadContinuityWeight : numberFromUnknown(patch.roadContinuityWeight, current.roadContinuityWeight),
    uturnPenalty: patch.uturnPenalty === undefined ? current.uturnPenalty : numberFromUnknown(patch.uturnPenalty, current.uturnPenalty),
    loopPenalty: patch.loopPenalty === undefined ? current.loopPenalty : numberFromUnknown(patch.loopPenalty, current.loopPenalty),
    selectionTemperature: patch.selectionTemperature === undefined ? current.selectionTemperature : numberFromUnknown(patch.selectionTemperature, current.selectionTemperature)
  };

  if ([
    next.speedMetersPerSecond,
    next.initialHeading,
    next.recentHistoryLimit,
    next.maxPanosPerIdle,
    next.noveltyWeight,
    next.forwardWeight,
    next.roadContinuityWeight,
    next.uturnPenalty,
    next.loopPenalty,
    next.selectionTemperature
  ].some((value) => !Number.isFinite(value))) return { error: "invalid_world_wanderer_number" };

  const validationError = validateWorldWandererConfig(next);
  if (validationError) return { error: validationError };
  writeWorldWandererConfig(worldWandererConfigPath(context), next);
  return { config: next };
}

function worldWandererLocationFromUnknown(value: unknown, fallback: { lat: number; lng: number }): { lat: number; lng: number } {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_initial_location");
  const object = parsed as Record<string, unknown>;
  return {
    lat: numberFromUnknown(object.lat, Number.NaN),
    lng: numberFromUnknown(object.lng, Number.NaN)
  };
}

function readWorldWandererConfigForAdmin(context: AdminRoutesContext): WorldWandererConfig {
  return readWorldWandererConfig(worldWandererConfigPath(context));
}

function worldWandererConfigPath(context: AdminRoutesContext): string {
  return context.pluginConfigs?.worldWanderer?.configPath ?? defaultWorldWandererPluginConfigPath;
}

function worldWandererConfigMtime(context: AdminRoutesContext): string | undefined {
  try {
    const stats = fs.statSync(worldWandererConfigPath(context)) as { mtime?: Date; mtimeMs?: number };
    if (stats.mtime instanceof Date) return stats.mtime.toISOString();
    if (typeof stats.mtimeMs === "number") return new Date(stats.mtimeMs).toISOString();
    return undefined;
  } catch {
    return undefined;
  }
}

function photoSelfieModeFromUnknown(value: unknown): SelfieGenerationMode {
  return requiredString(value).trim() as SelfieGenerationMode;
}

function photoOutputFormatFromUnknown(value: unknown, fallback: string): string {
  const normalized = requiredString(value).trim().toLowerCase();
  if (normalized === "jpg") return "jpeg";
  if (normalized === "jpeg" || normalized === "png" || normalized === "webp") return normalized;
  return normalized;
}

function photoModerationFromUnknown(value: unknown, fallback: string): string {
  const normalized = requiredString(value).trim().toLowerCase();
  if (normalized === "auto" || normalized === "low") return normalized;
  return normalized;
}

function secretStringFromUnknown(value: unknown, fallback: string | undefined): string | undefined {
  const text = requiredString(value).trim();
  return text ? text : fallback;
}

function selectedPhotoImageApiKey(config: PhotoPluginConfig): string | undefined {
  return config.selfieMode === "openaiRelay" ? config.selfieImageApiRelayKey : config.selfieImageApiKey;
}

function isPathUnderAssets(value: string): boolean {
  const relative = path.relative(path.resolve("assets"), path.resolve(value));
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function asrConfigMissingPreset(config: AsrPluginConfig, presetNames: Set<string>): boolean {
  const provider = config.defaultProvider;
  if (provider === "openai_compatible") {
    const name = config.providers.openaiCompatible?.apiPresetName;
    return !name || !presetNames.has(name);
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
  const tencentPatch = providersPatch.tencent && typeof providersPatch.tencent === "object" && !Array.isArray(providersPatch.tencent)
    ? providersPatch.tencent as Record<string, unknown>
    : {};

  const next: AsrPluginConfig = {
    enabled: patch.enabled === undefined ? current.enabled : booleanFromUnknown(patch.enabled),
    defaultProvider: patch.defaultProvider === undefined ? current.defaultProvider : asrProviderFromUnknown(patch.defaultProvider),
    testAudioPath: patch.testAudioPath === undefined ? current.testAudioPath : optionalString(patch.testAudioPath),
    pseudoStreamMinPauseMs: patch.pseudoStreamMinPauseMs === undefined ? current.pseudoStreamMinPauseMs : optionalNumberFromUnknown(patch.pseudoStreamMinPauseMs),
    providers: {
      openaiCompatible: {
        apiPresetName: openAiPatch.apiPresetName === undefined ? current.providers.openaiCompatible?.apiPresetName : optionalString(openAiPatch.apiPresetName),
        responseFormat: openAiPatch.responseFormat === undefined ? current.providers.openaiCompatible?.responseFormat : asrResponseFormatFromUnknown(openAiPatch.responseFormat),
        retryCount: openAiPatch.retryCount === undefined ? current.providers.openaiCompatible?.retryCount : optionalNumberFromUnknown(openAiPatch.retryCount),
        retryBackoffMs: openAiPatch.retryBackoffMs === undefined ? current.providers.openaiCompatible?.retryBackoffMs : optionalNumberFromUnknown(openAiPatch.retryBackoffMs)
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
  if (config.defaultProvider !== "openai_compatible" && config.defaultProvider !== "tencent") return "invalid_asr_provider";
  if (config.testAudioPath && !isPluginAssetPath("asr", config.testAudioPath)) return "invalid_asset_path";
  const pseudoPause = config.pseudoStreamMinPauseMs;
  if (pseudoPause !== undefined && invalidNumber(pseudoPause, 500, 10_000)) return "invalid_pseudo_stream_pause";
  const presets = new Set(readLLMApiPresets(context).map((entry) => entry.name));
  for (const name of [config.providers.openaiCompatible?.apiPresetName]) {
    if (name && !presets.has(name)) return "invalid_api_preset";
  }
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
    testAudioPath: config.testAudioPath,
    pseudoStreamMinPauseMs: config.pseudoStreamMinPauseMs,
    providers: {
      openaiCompatible: config.providers.openaiCompatible ? { ...config.providers.openaiCompatible } : undefined,
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

function optionalNumberFromUnknown(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : Number.NaN;
}

function ttsPluginSummary(context: AdminRoutesContext, config = readTtsConfigForAdmin(context)): AdminPluginSummary {
  const presetExists = !config.apiPresetName || readLLMApiPresets(context).some((entry) => entry.name === config.apiPresetName);
  const conversionPresetName = config.conversion?.provider === "openai-api" ? config.conversion.openaiApi?.apiPresetName : undefined;
  const conversionPresetExists = !conversionPresetName || readLLMApiPresets(context).some((entry) => entry.name === conversionPresetName);
  const missingConfig = config.enabled && ((!config.apiPresetName || !presetExists) || !conversionPresetExists);
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
      promptVariables: () => buildLLMTextVariables({
        userName: context.promptProfileStore.get().userName,
        time: context.time,
        librarySetting: resolveLibrarySetting(context)
      }),
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
  const synthesizer = configuredSynthesizer ?? (
    config.conversion?.provider === "openai-api"
      ? createOpenAiApiTtsVoiceSynthesizer(config, {
        resolveApiPreset(name) {
          return readLLMApiPresets(context).find((entry) => entry.name === name);
        },
        appendLog: context.appendLog
      })
      : config.conversion?.provider === "bailian"
        ? createBailianTtsVoiceSynthesizer(config, {
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
      ...(config.conversion?.provider === "genie" || !config.conversion?.provider ? { genie: ttsGenieOverrides(config) } : {})
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
  const currentVoice = current.voice ?? {};
  if ("api_preset" in patch) return { error: "invalid_plugin_config" };
  const conversionPatch = patch.conversion && typeof patch.conversion === "object" && !Array.isArray(patch.conversion)
    ? patch.conversion as Record<string, unknown>
    : {};
  const remotePatch = patch.remote && typeof patch.remote === "object" && !Array.isArray(patch.remote)
    ? patch.remote as Record<string, unknown>
    : {};
  const geniePatch = conversionPatch.genie && typeof conversionPatch.genie === "object" && !Array.isArray(conversionPatch.genie)
    ? conversionPatch.genie as Record<string, unknown>
    : remotePatch;
  const currentRemote = current.conversion?.genie ?? current.remote ?? {};
  const nextRemote = {
    enabled: geniePatch.enabled === undefined ? currentRemote.enabled ?? true : booleanFromUnknown(geniePatch.enabled),
    baseURL: geniePatch.baseURL === undefined ? currentRemote.baseURL ?? "" : normalizeRemoteTtsBaseURL(optionalString(geniePatch.baseURL) ?? ""),
    localFallbackEnabled: geniePatch.localFallbackEnabled === undefined ? currentRemote.localFallbackEnabled ?? false : booleanFromUnknown(geniePatch.localFallbackEnabled)
  };
  const openAiApiPatch = conversionPatch.openaiApi && typeof conversionPatch.openaiApi === "object" && !Array.isArray(conversionPatch.openaiApi)
    ? conversionPatch.openaiApi as Record<string, unknown>
    : {};
  const currentOpenAiApi = current.conversion?.openaiApi ?? {};
  const extraParamsResult = parseOptionalJsonObject(openAiApiPatch.extraParamsJson, currentOpenAiApi.extraParams ?? {});
  if ("error" in extraParamsResult) return { error: extraParamsResult.error };
  const nextOpenAiApi = {
    apiPresetName: openAiApiPatch.apiPresetName === undefined ? currentOpenAiApi.apiPresetName : optionalString(openAiApiPatch.apiPresetName),
    model: openAiApiPatch.model === undefined ? currentOpenAiApi.model ?? "higgs-audio-v3-tts" : requiredString(openAiApiPatch.model),
    voice: openAiApiPatch.voice === undefined ? currentOpenAiApi.voice ?? "default" : requiredString(openAiApiPatch.voice),
    timeoutMs: openAiApiPatch.timeoutMs === undefined ? currentOpenAiApi.timeoutMs ?? 60_000 : optionalNumberFromUnknown(openAiApiPatch.timeoutMs),
    sampleRate: openAiApiPatch.sampleRate === undefined ? currentOpenAiApi.sampleRate ?? 32_000 : optionalNumberFromUnknown(openAiApiPatch.sampleRate),
    channels: openAiApiPatch.channels === undefined ? currentOpenAiApi.channels ?? 1 : optionalNumberFromUnknown(openAiApiPatch.channels),
    extraParams: extraParamsResult.value
  };
  const bailianPatch = conversionPatch.bailian && typeof conversionPatch.bailian === "object" && !Array.isArray(conversionPatch.bailian)
    ? conversionPatch.bailian as Record<string, unknown>
    : {};
  const currentBailian = current.conversion?.bailian ?? {};
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
  const nextBailian = {
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
    extraParams: bailianExtraParamsResult.value
  };
  const nextConversionProvider = conversionPatch.provider === undefined
    ? current.conversion?.provider ?? "genie"
    : conversionPatch.provider === "openai-api" ? "openai-api" : conversionPatch.provider === "bailian" ? "bailian" : conversionPatch.provider === "genie" ? "genie" : undefined;
  if (!nextConversionProvider) return { error: "invalid_conversion_provider" };
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
  const voicePatch = patch.voice && typeof patch.voice === "object" && !Array.isArray(patch.voice)
    ? patch.voice as Record<string, unknown>
    : {};
  const currentModelConfigs = currentVoice.modelConfigs ?? {};
  const activeModelConfigName = safeTtsPresetName(optionalString(voicePatch.modelConfigName) || currentVoice.modelConfigName || Object.keys(currentModelConfigs)[0] || "jp", "jp");
  const editModelConfigName = safeTtsPresetName(optionalString(voicePatch.newModelConfigName) || optionalString(voicePatch.modelEditPresetName) || activeModelConfigName, "jp");
  const currentModel = currentModelConfigs[editModelConfigName] ?? currentModelConfigs[activeModelConfigName] ?? {};
  const modelPatch = voicePatch.currentModel && typeof voicePatch.currentModel === "object" && !Array.isArray(voicePatch.currentModel)
    ? voicePatch.currentModel as Record<string, unknown>
    : {};
  const shouldUpdateModelPreset = Object.keys(modelPatch).length > 0 || optionalString(voicePatch.newModelConfigName) !== undefined;
  const nextModelLanguage = modelPatch.language === undefined ? currentModel.language ?? "jp" : ttsLanguageFromUnknown(modelPatch.language);
  if (!nextModelLanguage) return { error: "invalid_tts_language" };
  const nextModel = {
    language: nextModelLanguage,
    speed: modelPatch.speed === undefined ? currentModel.speed : optionalSpeedValue(modelPatch.speed),
    partSilenceSeconds: modelPatch.partSilenceSeconds === undefined ? currentModel.partSilenceSeconds : optionalPartSilenceSecondsValue(modelPatch.partSilenceSeconds),
    splitText: modelPatch.splitText === undefined ? currentModel.splitText ?? false : booleanFromUnknown(modelPatch.splitText)
  };
  const referenceText = modelPatch.referenceText === undefined ? undefined : optionalString(modelPatch.referenceText);
  if (referenceText !== undefined) writeTtsPresetReferenceText(editModelConfigName, referenceText, context.pluginConfigs?.tts?.assetRoot);
  const nextTranslationPresets = shouldUpdateTranslationPreset
    ? { ...currentTranslationPresets, [editTranslationPresetName]: nextTranslation }
    : currentTranslationPresets;
  const activeTranslation = nextTranslationPresets[activeTranslationPresetName] ?? nextTranslation;
  const nextModelConfigs = shouldUpdateModelPreset
    ? { ...currentModelConfigs, [editModelConfigName]: nextModel }
    : currentModelConfigs;
  const next: TtsPluginConfig = {
    enabled: patch.enabled === undefined ? current.enabled : booleanFromUnknown(patch.enabled),
    remote: nextRemote,
    conversion: {
      provider: nextConversionProvider,
      genie: nextRemote,
      openaiApi: nextOpenAiApi,
      bailian: nextBailian
    },
    translationPresetName: activeTranslationPresetName,
    translationPresets: nextTranslationPresets,
    translationEnabled: activeTranslation.translationEnabled ?? true,
    apiPresetName: activeTranslation.apiPresetName,
    api_preset: current.api_preset,
    prompt: activeTranslation.prompt ?? current.prompt,
    voice: {
      modelConfigName: activeModelConfigName,
      modelConfigs: nextModelConfigs
    }
  };

  const validationError = validateTtsConfig(next);
  if (validationError) return { error: validationError };
  const presetToValidate = shouldUpdateTranslationPreset ? nextTranslation : activeTranslation;
  if ((shouldUpdateTranslationPreset || "translationPresetName" in patch || "enabled" in patch) && (presetToValidate.translationEnabled ?? true) && presetToValidate.apiPresetName && !readLLMApiPresets(context).some((entry) => entry.name === presetToValidate.apiPresetName)) {
    return { error: "invalid_api_preset" };
  }
  if (next.conversion?.provider === "openai-api" && next.conversion.openaiApi?.apiPresetName && !readLLMApiPresets(context).some((entry) => entry.name === next.conversion?.openaiApi?.apiPresetName)) {
    return { error: "invalid_openai_api_preset" };
  }
  writeTtsConfig(context, next);
  return { config: next };
}

function validateTtsConfig(config: TtsPluginConfig): string | undefined {
  const genie = config.conversion?.genie ?? config.remote;
  if (genie?.enabled && !genie.baseURL) return "invalid_remote_tts_url";
  const openaiApi = config.conversion?.openaiApi;
  if (config.conversion?.provider === "openai-api") {
    if (!openaiApi?.apiPresetName && !openaiApi?.baseURL) return "missing_openai_api_tts_preset";
    if (!openaiApi?.model) return "missing_openai_api_tts_model";
    if (!openaiApi?.voice) return "missing_openai_api_tts_voice";
  }
  if (openaiApi?.timeoutMs !== undefined && invalidNumber(openaiApi.timeoutMs, 1000, 300000)) return "invalid_openai_api_timeout";
  if (openaiApi?.sampleRate !== undefined && invalidNumber(openaiApi.sampleRate, 8000, 48000)) return "invalid_openai_api_sample_rate";
  if (openaiApi?.channels !== undefined && invalidNumber(openaiApi.channels, 1, 2)) return "invalid_openai_api_channels";
  const bailian = config.conversion?.bailian;
  if (config.conversion?.provider === "bailian") {
    if (!bailian?.endpoint) return "missing_bailian_tts_endpoint";
    if (!bailian?.model) return "missing_bailian_tts_model";
    if (!bailian?.voice) return "missing_bailian_tts_voice";
  }
  if (bailian?.timeoutMs !== undefined && invalidNumber(bailian.timeoutMs, 1000, 300000)) return "invalid_bailian_timeout";
  if (bailian?.sampleRate !== undefined && invalidNumber(bailian.sampleRate, 8000, 48000)) return "invalid_bailian_sample_rate";
  if (bailian?.channels !== undefined && invalidNumber(bailian.channels, 1, 2)) return "invalid_bailian_channels";
  const voice = config.voice ?? {};
  for (const model of Object.values(voice.modelConfigs ?? {})) {
    if (model.speed !== undefined && invalidNumber(model.speed, 0.5, 2)) return "invalid_voice_speed";
    if (model.partSilenceSeconds !== undefined && invalidNumber(model.partSilenceSeconds, 0, 3)) return "invalid_part_silence";
  }
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

function isTtsVoiceAssetPath(value: string): boolean {
  return isTtsModelAssetPath(value) || isPluginAssetPath("tts", value);
}

function ttsLanguageFromUnknown(value: unknown): "jp" | "zh" | "en" | undefined {
  return value === "jp" || value === "zh" || value === "en" ? value : undefined;
}

function safeTtsModelConfigName(value: string): string {
  return value.trim().replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "jp";
}

function safeTtsPresetName(value: string, fallback: string): string {
  return value.trim().replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || fallback;
}

function isLikelyAssetPath(value: string): boolean {
  return value.startsWith("assets/") || value.startsWith("tts/") || value.startsWith("plugin/") || path.isAbsolute(value);
}

function isTtsModelAssetPath(value: string): boolean {
  const root = path.resolve("assets", "tts", "model");
  const fullPath = path.resolve(value);
  const relative = path.relative(root, fullPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function migrateTtsVoiceModelConfigAssets(modelConfigName: string, model: TtsVoiceModelConfig): TtsVoiceModelConfig {
  const safeName = safeTtsModelConfigName(modelConfigName);
  const baseDir = path.join("assets", "tts", "model", safeName);
  const next: TtsVoiceModelConfig = { ...model };

  if (model.modelDir) {
    const target = path.join(baseDir, "model");
    copyAssetPathIfPresent(model.modelDir, target);
    next.modelDir = normalizeAssetPath(target);
  }
  if (model.referenceAudio) {
    const extension = isLikelyAssetPath(model.referenceAudio) ? path.extname(model.referenceAudio) || ".wav" : ".wav";
    const target = path.join(baseDir, `reference${extension}`);
    copyAssetPathIfPresent(model.referenceAudio, target);
    next.referenceAudio = normalizeAssetPath(target);
  }
  if (model.referenceText) {
    const target = path.join(baseDir, "reference.txt");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (isLikelyAssetPath(model.referenceText)) {
      copyAssetPathIfPresent(model.referenceText, target);
    } else {
      fs.writeFileSync(target, model.referenceText);
    }
    next.referenceText = normalizeAssetPath(target);
  }

  return next;
}

function copyAssetPathIfPresent(sourcePath: string, targetPath: string): void {
  if (!isLikelyAssetPath(sourcePath)) return;
  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);
  if (source === target) return;
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stat = fs.statSync(source) as { isFile(): boolean; isDirectory?: () => boolean };
  if (typeof stat.isDirectory === "function" ? stat.isDirectory() : !stat.isFile()) {
    (fs as any).cpSync(source, target, { recursive: true });
  } else {
    fs.writeFileSync(target, fs.readFileSync(source));
  }
}

function normalizeAssetPath(value: string): string {
  return value.split(path.sep).join("/");
}

function ttsPresetRoot(modelConfigName: string, assetRoot = "assets"): string {
  return path.join(assetRoot, "tts", "preset", safeTtsPresetName(modelConfigName, "jp"));
}

function ttsPresetModelDir(modelConfigName: string): string {
  return normalizeAssetPath(path.join(ttsPresetRoot(modelConfigName), "model"));
}

function ttsPresetReferenceTextPath(modelConfigName: string, assetRoot = "assets"): string {
  return normalizeAssetPath(path.join(ttsPresetRoot(modelConfigName, assetRoot), "reference.txt"));
}

function ttsPresetReferenceAudioPath(modelConfigName: string): string | undefined {
  const root = ttsPresetRoot(modelConfigName);
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

function readTtsPresetReferenceText(modelConfigName: string): string | undefined {
  const filePath = ttsPresetReferenceTextPath(modelConfigName);
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  return undefined;
}

function writeTtsPresetReferenceText(modelConfigName: string, value: string, assetRoot = "assets"): void {
  const filePath = ttsPresetReferenceTextPath(modelConfigName, assetRoot);
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
}

async function uploadGenericPluginAsset(
  context: AdminRoutesContext,
  pluginId: string,
  assetKey: string,
  request: any
): Promise<{ config: TtsAdminConfig; assetPath: string } | { error: string; statusCode?: number }> {
  const config = readTtsConfigForAdmin(context);
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

  const modelConfigName = safeTtsPresetName(presetName || config.voice?.modelConfigName || "jp", "jp");
  const modelConfigs = config.voice?.modelConfigs ?? {};
  const currentModel = modelConfigs[modelConfigName] ?? {};
  const next: TtsPluginConfig = {
    ...config,
    voice: {
      ...config.voice,
      modelConfigName,
      modelConfigs: {
        ...modelConfigs,
        [modelConfigName]: {
          ...currentModel
        }
      }
    }
  };
  writeTtsConfig(context, next);
  return { config: publicTtsConfig(next), assetPath: assetPath.assetPath };
}

function resolveTtsModelAssetPathForUpload(config: TtsPluginConfig, assetKey: string, fileName: string, relativeDir: string, presetName?: string, assetRoot = "assets"): { fullPath: string; assetPath: string } {
  const modelConfigName = safeTtsPresetName(presetName || config.voice?.modelConfigName || "jp", "jp");
  const root = path.resolve(assetRoot, "tts", "preset", modelConfigName);
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
    assetPath: path.join("assets", "tts", "preset", modelConfigName, relative).split(path.sep).join("/")
  };
}

function resolvePluginAssetPathForUpload(pluginId: string, assetKey: string, fileName: string, relativeDir: string, assetRoot = "assets"): { fullPath: string; assetPath: string } {
  const root = path.resolve(assetRoot, "plugin", pluginId);
  const normalizedRelativeDir = sanitizePluginAssetRelativePath(relativeDir);
  const effectiveFileName = fileName || defaultPluginAssetFileName(assetKey);
  const baseRelativeDir = assetKey === "model" || assetKey === "test-audio" ? assetKey : normalizedRelativeDir;
  const fullPath = path.resolve(root, baseRelativeDir, effectiveFileName);
  const relative = path.relative(root, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpJsonError(400, "invalid_asset_path");
  }
  return {
    fullPath,
    assetPath: path.join("assets", "plugin", pluginId, relative).split(path.sep).join("/")
  };
}

function defaultPluginAssetFileName(assetKey: string): string {
  if (assetKey === "reference-text") return "reference.txt";
  if (assetKey === "reference-audio") return "reference";
  return "asset";
}

function safePluginAssetFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^\w.\- ]+/g, "_").trim();
  return base || "";
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

function publicTtsConfig(config: TtsPluginConfig): TtsAdminConfig {
  const translationPresets = config.translationPresets ?? {};
  const translationPresetName = config.translationPresetName ?? Object.keys(translationPresets)[0] ?? "default";
  const currentTranslation = translationPresets[translationPresetName] ?? {};
  const voice = config.voice ?? {};
  const modelConfigs = voice.modelConfigs ?? {};
  const modelConfigName = voice.modelConfigName ?? Object.keys(modelConfigs)[0] ?? "jp";
  const currentModel = modelConfigs[modelConfigName] ?? {};
  const conversion = config.conversion ?? { provider: "genie" as const, genie: config.remote };
  const openaiApi = conversion.openaiApi ?? {};
  const bailian = conversion.bailian ?? {};
  return {
    enabled: config.enabled,
    remote: {
      enabled: conversion.genie?.enabled ?? config.remote?.enabled ?? true,
      baseURL: conversion.genie?.baseURL ?? config.remote?.baseURL ?? "",
      localFallbackEnabled: conversion.genie?.localFallbackEnabled ?? config.remote?.localFallbackEnabled ?? false
    },
    conversion: {
      provider: conversion.provider ?? "genie",
      genie: {
        enabled: conversion.genie?.enabled ?? config.remote?.enabled ?? true,
        baseURL: conversion.genie?.baseURL ?? config.remote?.baseURL ?? "",
        localFallbackEnabled: conversion.genie?.localFallbackEnabled ?? config.remote?.localFallbackEnabled ?? false
      },
      openaiApi: {
        apiPresetName: openaiApi.apiPresetName,
        model: openaiApi.model ?? "higgs-audio-v3-tts",
        voice: openaiApi.voice ?? "default",
        timeoutMs: openaiApi.timeoutMs ?? 60_000,
        sampleRate: openaiApi.sampleRate ?? 32_000,
        channels: openaiApi.channels ?? 1,
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
        extraParamsJson: JSON.stringify(bailian.extraParams ?? {}, null, 2)
      }
    },
    translationPresetName,
    translationEditPresetName: translationPresetName,
    newTranslationPresetName: "",
    translationPresets,
    currentTranslation: {
      translationEnabled: currentTranslation.translationEnabled ?? config.translationEnabled,
      apiPresetName: currentTranslation.apiPresetName ?? config.apiPresetName,
      prompt: currentTranslation.prompt ?? config.prompt
    },
    voice: {
      modelConfigName,
      modelEditPresetName: modelConfigName,
      newModelConfigName: "",
      modelConfigs,
      currentModel: {
        ...currentModel,
        modelDir: ttsPresetModelDir(modelConfigName),
        referenceAudio: ttsPresetReferenceAudioPath(modelConfigName),
        referenceText: readTtsPresetReferenceText(modelConfigName)
      }
    }
  };
}

function canonicalTtsConfig(config: TtsPluginConfig): TtsPluginConfig {
  const translationPresets = config.translationPresets ?? {};
  const translationPresetName = config.translationPresetName ?? Object.keys(translationPresets)[0] ?? "default";
  const voice = config.voice ?? {};
  const modelConfigs = voice.modelConfigs ?? {};
  const modelConfigName = voice.modelConfigName ?? Object.keys(modelConfigs)[0] ?? "jp";
  const genie = config.conversion?.genie ?? config.remote;
  const openaiApi = config.conversion?.openaiApi;
  const bailian = config.conversion?.bailian;
  return {
    enabled: config.enabled,
    remote: {
      enabled: genie?.enabled ?? true,
      baseURL: genie?.baseURL ?? "",
      localFallbackEnabled: genie?.localFallbackEnabled ?? false
    },
    conversion: {
      provider: config.conversion?.provider ?? "genie",
      genie: {
        enabled: genie?.enabled ?? true,
        baseURL: genie?.baseURL ?? "",
        localFallbackEnabled: genie?.localFallbackEnabled ?? false
      },
      openaiApi: {
        apiPresetName: openaiApi?.apiPresetName,
        baseURL: openaiApi?.baseURL,
        apiKeyEnv: openaiApi?.apiKeyEnv,
        model: openaiApi?.model ?? "higgs-audio-v3-tts",
        voice: openaiApi?.voice ?? "default",
        timeoutMs: openaiApi?.timeoutMs ?? 60_000,
        sampleRate: openaiApi?.sampleRate ?? 32_000,
        channels: openaiApi?.channels ?? 1,
        extraParams: openaiApi?.extraParams ?? {}
      },
      bailian: {
        service: bailian?.service ?? "qwen",
        endpoint: bailian?.endpoint ?? defaultBailianTtsEndpoint(bailian?.service),
        apiKey: bailian?.apiKey,
        apiKeyEnv: bailian?.apiKeyEnv ?? "DASHSCOPE_API_KEY",
        workspaceId: bailian?.workspaceId,
        userAgent: bailian?.userAgent,
        model: bailian?.model ?? "qwen3-tts-vc-2026-01-22",
        voice: bailian?.voice ?? "Cherry",
        languageType: bailian?.languageType ?? "Chinese",
        mode: bailian?.mode ?? "server_commit",
        responseFormat: bailian?.responseFormat ?? "pcm",
        timeoutMs: bailian?.timeoutMs ?? 60_000,
        sampleRate: bailian?.sampleRate ?? 24_000,
        channels: bailian?.channels ?? 1,
        extraParams: bailian?.extraParams ?? {}
      }
    },
    translationPresetName,
    translationPresets,
    translationEnabled: config.translationEnabled,
    apiPresetName: config.apiPresetName,
    api_preset: undefined,
    prompt: config.prompt,
    voice: {
      modelConfigName,
      modelConfigs
    }
  };
}

function ttsConfigSchema(): unknown {
  return {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      remote: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          baseURL: { type: "string" },
          localFallbackEnabled: { type: "boolean" }
        }
      },
      conversion: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["genie", "openai-api", "bailian"] },
          genie: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              baseURL: { type: "string" },
              localFallbackEnabled: { type: "boolean" }
            }
          },
          openaiApi: { type: "object" },
          bailian: { type: "object" }
        }
      },
      translationEnabled: { type: "boolean" },
      apiPresetName: { type: "string" },
      prompt: { type: "string" },
      voice: { type: "object" }
    },
    required: ["enabled", "prompt"]
  };
}

function listAdminPluginEvents(context: AdminRoutesContext, pluginId: string): unknown[] {
  const aliases = [pluginId, pluginId.replace(/-/g, " "), pluginId.replace(/-/g, "_")];
  return context.logs
    .filter((entry): entry is { id?: number; time?: string; level?: "info" | "warn" | "error"; message: string } => {
      if (!entry || typeof entry !== "object") return false;
      const message = (entry as { message?: unknown }).message;
      return typeof message === "string" && aliases.some((alias) => message.toLowerCase().includes(alias));
    })
    .slice(-50)
    .reverse()
    .map((entry) => ({
      id: entry.id,
      time: entry.time,
      level: entry.level,
      message: entry.message
    }));
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

function invalidNumber(value: unknown, min?: number, max?: number): boolean {
  return typeof value !== "number" || !Number.isFinite(value) || (min !== undefined && value < min) || (max !== undefined && value > max);
}
