import { createOpenAICompatibleClient } from "../../llm-gateway/src/index.js";
import { readRawBody } from "../../../apps/api/middleware/http-utils.js";
import { readLLMApiPresets } from "../../llm-gateway/src/admin-presets.js";
import { booleanFromUnknown, optionalString } from "../../../shared/admin-input/src/index.js";
import { decodeHeaderFileName } from "../../../channels/tts/src/admin-assets.js";
import {
  defaultImageRecognitionConfigPath,
  defaultImageRecognitionExtraParams,
  defaultImageRecognitionPrompt,
  readImageRecognitionConfig,
  recognizeImageWithPlugin,
  type ImageRecognitionConfig,
  type ImageRecognitionError,
  type ImageRecognitionResult
} from "../../../channels/image-recognition/src/index.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";
import type { AdminPluginRegistryEntry, AdminPluginSummary } from "./admin-plugin-types.js";
import { isPluginAssetPath, maxPluginAssetUploadBytes, resolvePluginAssetPath, resolvePluginAssetPathForUpload, safePluginAssetFileName } from "./admin-plugin-utils.js";

const fs = await import("node:fs");
const path = await import("node:path");

export function imageRecognitionPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return imageRecognitionSummary(context);
    },
    config(context) {
      return publicImageRecognitionConfig(readImageRecognitionConfigForAdmin(context));
    },
    patch(context, patch) {
      const result = updateImageRecognitionConfig(context, patch);
      return "error" in result ? result : { config: publicImageRecognitionConfig(result.config) };
    },
    setEnabled(context, enabled) {
      const result = updateImageRecognitionConfig(context, { enabled });
      return "error" in result ? result : { config: publicImageRecognitionConfig(result.config) };
    },
    reload(context) {
      return { config: publicImageRecognitionConfig(readImageRecognitionConfigForAdmin(context)) };
    },
    test(context, input) {
      return testImageRecognitionPlugin(context, input);
    },
    uploadAsset(context, assetKey, request) {
      return uploadImageRecognitionAsset(context, assetKey, request);
    },
    configSchema: {
      groups: [
        { key: "general", label: "General" },
        { key: "llm", label: "LLM" }
      ],
      fields: [
        { key: "enabled", label: "Enabled", type: "switch", group: "general", description: "Enable or disable image recognition requests." },
        { key: "testImagePath", label: "Test Image", type: "fileUpload", group: "general", assetKey: "test-image", accept: "image/*", description: "Plugin-owned test image under assets/plugin/image-recognition/test-image/." },
        { key: "apiPresetName", label: "Multimodal LLM Preset", type: "apiPresetSelect", group: "llm", description: "Saved API preset used for image recognition. The plugin stores only the preset name." },
        { key: "prompt", label: "Prompt", type: "textarea", group: "llm", description: "Prompt sent with the image. This is the only prompt text this plugin adds." },
        { key: "extraParams", label: "Extra Params JSON", type: "textarea", group: "llm", description: "JSON object sent as request extraParams, replacing the selected preset's extraParams for this call." }
      ]
    },
    routePreview: [
      "image file",
      "plugin.image-recognition.recognize",
      "selected LLM API preset",
      "text description"
    ],
    runtimeAccess: [
      "read uploaded or caller-provided image file",
      "call selected API preset",
      "return normalized description text",
      "do not persist descriptions by default"
    ],
    testSchema: {
      input: "image",
      label: "Image",
      buttonLabel: "Test image recognition"
    }
  };
}

function imageRecognitionSummary(context: AdminRoutesContext, config = readImageRecognitionConfigForAdmin(context)): AdminPluginSummary {
  const presetNames = new Set(readLLMApiPresets(context).map((entry) => entry.name));
  const missingConfig = config.enabled && (!config.apiPresetName || !presetNames.has(config.apiPresetName) || !config.prompt);
  return {
    id: "image-recognition",
    name: "Image Recognition",
    kind: "channel",
    status: missingConfig ? "missing_config" : config.enabled ? "enabled" : "disabled",
    health: missingConfig ? "degraded" : config.enabled ? "healthy" : "unknown",
    description: "Describe caller-provided images through a multimodal LLM API preset.",
    configurable: true,
    switchable: true,
    configSource: imageRecognitionConfigPath(context),
    lastLoadedAt: imageRecognitionConfigMtime(context)
  };
}

async function testImageRecognitionPlugin(context: AdminRoutesContext, input: Record<string, unknown>): Promise<{ ok: true; result?: unknown } | { error: string }> {
  const config = readImageRecognitionConfigForAdmin(context);
  const imageFile = optionalString(input.imageFile) ?? config.testImagePath;
  if (!imageFile) return { error: "missing_image_file" };
  if (!isPluginAssetPath("image-recognition", imageFile, context.pluginConfigs?.imageRecognition?.assetRoot)) return { error: "invalid_asset_path" };
  const resolvedImageFile = resolvePluginAssetPath("image-recognition", imageFile, context.pluginConfigs?.imageRecognition?.assetRoot);
  if (!fs.existsSync(resolvedImageFile)) return { error: "missing_image_file" };

  const recognizer = context.pluginConfigs?.imageRecognition?.testRecognizer;
  const result = await (recognizer
    ? recognizer({ imageFile: resolvedImageFile }, config)
    : recognizeImageWithPlugin({ imageFile: resolvedImageFile }, config, {
      resolveApiPreset(name) {
        return readLLMApiPresets(context).find((entry) => entry.name === name);
      },
      createLlmClientFromPreset(preset) {
        if (!preset.baseURL || !preset.apiKey) return undefined;
        return createOpenAICompatibleClient({
          baseURL: preset.baseURL,
          apiKey: preset.apiKey,
          model: preset.model,
          temperature: preset.temperature,
          timeoutMs: preset.timeoutMs,
          useProxy: preset.useProxy === true,
          extraParams: preset.extraParams
        });
      },
      llmRequestSender: context.llmRequestSender ? (request) => context.llmRequestSender!({ ...request, client: request.client as any } as any) as any : undefined,
      promptRenderer: () => context.getPromptRenderer(),
      appendLog: context.appendLog
    }));
  if (isImageRecognitionError(result)) return { error: result.error };
  return {
    ok: true,
    result: {
      input: imageFile,
      output: result.text,
      provider: result.provider,
      model: result.model,
      requestId: result.requestId,
      timing: {
        recognitionMs: result.durationMs
      }
    }
  };
}

function updateImageRecognitionConfig(context: AdminRoutesContext, patch: Record<string, unknown>): { config: ImageRecognitionConfig } | { error: string } {
  const current = readImageRecognitionConfigForAdmin(context);
  const extraParams = parseExtraParams(patch.extraParams, current.extraParams ?? defaultImageRecognitionExtraParams());
  if ("error" in extraParams) return { error: "invalid_extra_params" };
  const next: ImageRecognitionConfig = {
    enabled: patch.enabled === undefined ? current.enabled : booleanFromUnknown(patch.enabled),
    apiPresetName: patch.apiPresetName === undefined ? current.apiPresetName : optionalString(patch.apiPresetName),
    prompt: patch.prompt === undefined ? current.prompt : optionalString(patch.prompt),
    extraParams: extraParams.value,
    testImagePath: patch.testImagePath === undefined ? current.testImagePath : optionalString(patch.testImagePath)
  };
  const validationError = validateImageRecognitionConfig(context, next);
  if (validationError) return { error: validationError };
  writeImageRecognitionConfig(context, next);
  return { config: next };
}

function validateImageRecognitionConfig(context: AdminRoutesContext, config: ImageRecognitionConfig): string | undefined {
  if (config.testImagePath && !isPluginAssetPath("image-recognition", config.testImagePath, context.pluginConfigs?.imageRecognition?.assetRoot)) return "invalid_asset_path";
  if (config.apiPresetName && !readLLMApiPresets(context).some((entry) => entry.name === config.apiPresetName)) return "invalid_api_preset";
  if (config.enabled && !config.apiPresetName) return "missing_api_preset";
  if (config.enabled && !config.prompt) return "missing_prompt";
  return undefined;
}

async function uploadImageRecognitionAsset(
  context: AdminRoutesContext,
  assetKey: string,
  request: any
): Promise<{ config: ImageRecognitionConfig; assetPath: string } | { error: string; statusCode?: number }> {
  if (assetKey !== "test-image") return { error: "unknown_asset_key" };
  const config = readImageRecognitionConfigForAdmin(context);
  const fileName = safePluginAssetFileName(decodeHeaderFileName(optionalString(request.headers?.["x-file-name"]) ?? ""));
  const relativeDir = decodeHeaderFileName(optionalString(request.headers?.["x-relative-dir"]) ?? "");
  const body = await readRawBody(request, { maxBytes: maxPluginAssetUploadBytes });
  if (body.length === 0) return { error: "empty_upload" };
  const assetPath = resolvePluginAssetPathForUpload("image-recognition", assetKey, fileName, relativeDir, context.pluginConfigs?.imageRecognition?.assetRoot);
  fs.mkdirSync(path.dirname(assetPath.fullPath), { recursive: true });
  fs.writeFileSync(assetPath.fullPath, body);
  const next: ImageRecognitionConfig = {
    ...config,
    testImagePath: assetPath.assetPath
  };
  writeImageRecognitionConfig(context, next);
  return { config: publicImageRecognitionConfig(next), assetPath: assetPath.assetPath };
}

function readImageRecognitionConfigForAdmin(context: AdminRoutesContext): ImageRecognitionConfig {
  return readImageRecognitionConfig(imageRecognitionConfigPath(context));
}

function writeImageRecognitionConfig(context: AdminRoutesContext, config: ImageRecognitionConfig): void {
  const filePath = imageRecognitionConfigPath(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(publicImageRecognitionConfig(config), null, 2)}\n`);
}

function publicImageRecognitionConfig(config: ImageRecognitionConfig): ImageRecognitionConfig {
  return {
    enabled: config.enabled,
    apiPresetName: config.apiPresetName,
    prompt: config.prompt ?? defaultImageRecognitionPrompt,
    extraParams: config.extraParams ?? defaultImageRecognitionExtraParams(),
    testImagePath: config.testImagePath
  };
}

function imageRecognitionConfigPath(context: AdminRoutesContext): string {
  return context.pluginConfigs?.imageRecognition?.configPath ?? defaultImageRecognitionConfigPath;
}

function imageRecognitionConfigMtime(context: AdminRoutesContext): string | undefined {
  try {
    return fs.statSync(imageRecognitionConfigPath(context)).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function parseExtraParams(value: unknown, fallback: Record<string, unknown>): { value: Record<string, unknown> } | { error: string } {
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

function isImageRecognitionError(result: ImageRecognitionResult | ImageRecognitionError): result is ImageRecognitionError {
  return "ok" in result && result.ok === false;
}
