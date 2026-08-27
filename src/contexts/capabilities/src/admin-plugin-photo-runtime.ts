import type { AppConfig } from "../../../apps/api/bootstrap/app-config-runtime.js";
import { defaultPhotoPluginConfigPath, publicPhotoPluginConfig, readPhotoPluginConfig, type PhotoPluginConfig, type SelfieGenerationMode } from "../../../channels/image-generation/src/index.js";
import { readJsonBody, readRawBody } from "../../../apps/api/middleware/http-utils.js";
import { writeJson } from "../../../apps/api/routes/admin-http.js";
import { booleanFromUnknown, isValidHttpUrl, requiredString } from "../../../shared/admin-input/src/index.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";
import { generatePhotoOnBodyImage } from "./outfit-on-body-runtime.js";
import type { AdminPluginRegistryEntry, AdminPluginSummary } from "./admin-plugin-types.js";
import { invalidNumber, secretStringFromUnknown } from "./admin-plugin-utils.js";

const fs = await import("node:fs");
const path = await import("node:path");

export function photoPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return photoPluginSummary(context);
    },
    config(context) {
      return {
        ...publicPhotoPluginConfig(readPhotoConfigForAdmin(context)),
        selfiePromptTemplate: readSelfiePromptTemplate(context),
        selfieCharacterReferenceImage: photoReferenceAssetPath(context, "alice-character-reference.jpg")
      };
    },
    patch(context, patch) {
      const result = updatePhotoConfig(context, patch);
      if ("error" in result) return result;
      if (patch.selfiePromptTemplate !== undefined) writeSelfiePromptTemplate(context, requiredString(patch.selfiePromptTemplate));
      return { config: publicPhotoPluginConfig(result.config) };
    },
    uploadAsset(context, assetKey, request) {
      return uploadPhotoPluginAsset(context, assetKey, request);
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
        { key: "xai", label: "xAI" },
        { key: "codex", label: "Codex" },
        { key: "main_prompt", label: "Main Prompt" },
        { key: "on_body", label: "On Body" },
        { key: "2dinreal", label: "2DinReal" }
      ],
      fields: [
        { key: "enabled", label: "Enabled", type: "switch", group: "general", description: "Enable or disable the selfie tool route." },
        { key: "selfieMode", label: "Selfie Mode", type: "select", group: "general", options: [
          { value: "openai", label: "OpenAI" },
          { value: "openaiRelay", label: "OpenAI Relay" },
          { value: "xai", label: "xAI" },
          { value: "codex", label: "Codex" }
        ], description: "OpenAI, OpenAI Relay, and xAI use separate Image API settings. Codex starts an ephemeral Codex CLI session with alice-selfie-fast." },
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
        { key: "selfieImageApiTimeoutMs", label: "Timeout Ms", type: "number", group: "openai", min: 1000, step: 1000 },
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
        { key: "selfieImageApiRelayTimeoutMs", label: "Timeout Ms", type: "number", group: "openai_relay", min: 1000, step: 1000 },
        { key: "selfieXaiImageApiKeySet", label: "API Key Set", type: "readonly", group: "xai" },
        { key: "selfieXaiImageApiKey", label: "API Key", type: "password", group: "xai", description: "Leave blank to keep the current key." },
        { key: "selfieXaiImageApiBaseURL", label: "Base URL", type: "text", group: "xai" },
        { key: "selfieXaiImageApiModel", label: "Model", type: "text", group: "xai" },
        { key: "selfieXaiImageApiAspectRatio", label: "Aspect Ratio", type: "text", group: "xai" },
        { key: "selfieXaiImageApiResolution", label: "Resolution", type: "select", group: "xai", options: [{ value: "1k", label: "1k" }, { value: "2k", label: "2k" }] },
        { key: "selfieXaiImageApiQuality", label: "Quality", type: "select", group: "xai", options: [{ value: "low", label: "low" }, { value: "medium", label: "medium" }] },
        { key: "selfieXaiImageApiTimeoutMs", label: "Timeout Ms", type: "number", group: "xai", min: 1000, step: 1000 },
        { key: "selfieCodexCommand", label: "Codex Command", type: "text", group: "codex" },
        { key: "selfieCodexExtraPrompt", label: "Extra Prompt", type: "textarea", group: "codex", description: "Prepended exactly before the rendered selfie prompt. Empty by default." },
        { key: "selfieCodexTimeoutMs", label: "Codex Timeout Ms", type: "number", group: "codex", min: 1000, max: 600000, step: 1000 },
        { key: "selfieDefaultPose", label: "Default Pose", type: "textarea", group: "main_prompt", description: "Used when Selfie is called without pose." },
        { key: "selfieDefaultExpression", label: "Default Expression", type: "textarea", group: "main_prompt", description: "Used when Selfie is called without expression; the runtime adds the 表情 label." },
        { key: "selfieDefaultHair", label: "Default Hair", type: "textarea", group: "main_prompt", description: "Used when Selfie is called without hair; the runtime adds the 发型 label." },
        { key: "selfieDefaultComposition", label: "Default Composition", type: "textarea", group: "main_prompt", description: "Used when Selfie is called without composition." },
        { key: "selfieReferenceDir", label: "Reference Folder", type: "text", group: "main_prompt" },
        { key: "selfiePromptTemplate", label: "Prompt Template", type: "textarea", group: "main_prompt", description: "Edits assets/selfie/references/selfie-prompt.txt." },
        { key: "selfieCharacterReferenceImage", label: "Character Ref", type: "fileUpload", group: "main_prompt", assetKey: "character-reference", accept: "image/*", description: "Uploaded as alice-character-reference.jpg." },
        { key: "selfieOutputDir", label: "Output Folder", type: "text", group: "main_prompt", description: "Must stay under assets/ so generated images can be routed as assets." },
        { key: "selfieMaxBytes", label: "Max Image Bytes", type: "number", group: "main_prompt", min: 1024, max: 52428800, step: 1024 },
        { key: "autoGenerateOutfitOnBody", label: "Auto On-Body", type: "switch", group: "general", description: "Automatically attempts outfit on-body generation after outfit selection." },
        { key: "onBodyReferenceImage", label: "Full Body Ref", type: "fileUpload", group: "on_body", assetKey: "on-body-reference", accept: "image/*", description: "Generation image 1." },
        { key: "onBodyPrompt", label: "Prompt", type: "textarea", group: "on_body", description: "Used exactly as the on-body generation prompt." },
        { key: "selfieOnBodyPrompt", label: "Selfie Prompt", type: "textarea", group: "on_body", description: "Used exactly when selfie uses an on-body reference." },
        { key: "selfie2DinRealEnabled", label: "2DinReal", type: "switch", group: "general", description: "Use the extra 2DinReal reference image and append its prompt to selfie prompts." },
        { key: "selfie2DinRealReferenceImage", label: "Character Ref", type: "fileUpload", group: "2dinreal", assetKey: "2dinreal-reference", accept: "image/*", description: "Character reference image used instead of alice-character-reference.jpg when 2DinReal is enabled." },
        { key: "selfie2DinRealPrompt", label: "Prompt", type: "textarea", group: "2dinreal", description: "Appended exactly below the rendered selfie prompt when 2DinReal is enabled." }
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
      "read on-body full reference and outfit reference",
      "send generated image to the current messaging session"
    ]
  };
}


function photoPluginSummary(context: AdminRoutesContext, config = readPhotoConfigForAdmin(context)): AdminPluginSummary {
  const missingConfig = config.enabled && (config.selfieMode === "openai" || config.selfieMode === "openaiRelay" || config.selfieMode === "xai") && !selectedPhotoImageApiKey(config);
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

async function uploadPhotoPluginAsset(
  context: AdminRoutesContext,
  assetKey: string,
  request: any
): Promise<{ config: unknown; assetPath: string } | { error: string; statusCode?: number }> {
  if (assetKey !== "character-reference" && assetKey !== "on-body-reference" && assetKey !== "2dinreal-reference") return { error: "unsupported_photo_asset" };
  const body = await readRawBody(request, { maxBytes: 10 * 1024 * 1024 });
  if (body.length === 0) return { error: "empty_upload" };
  const config = readPhotoConfigForAdmin(context);
  const fullPath = assetKey === "on-body-reference"
    ? path.resolve(config.onBodyReferenceImage)
    : assetKey === "2dinreal-reference"
    ? path.resolve(config.selfie2DinRealReferenceImage)
    : path.resolve(config.selfieReferenceDir, "alice-character-reference.jpg");
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, body);
  return {
    config: {
      ...publicPhotoPluginConfig(config),
      selfiePromptTemplate: readSelfiePromptTemplate(context),
      selfieCharacterReferenceImage: photoReferenceAssetPath(context, "alice-character-reference.jpg")
    },
    assetPath: fullPath
  };
}

function readSelfiePromptTemplate(context: AdminRoutesContext): string {
  const filePath = path.resolve(readPhotoConfigForAdmin(context).selfieReferenceDir, "selfie-prompt.txt");
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function writeSelfiePromptTemplate(context: AdminRoutesContext, value: string): void {
  const filePath = path.resolve(readPhotoConfigForAdmin(context).selfieReferenceDir, "selfie-prompt.txt");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function photoReferenceAssetPath(context: AdminRoutesContext, fileName: string): string {
  return path.resolve(readPhotoConfigForAdmin(context).selfieReferenceDir, fileName);
}

function updatePhotoConfig(context: AdminRoutesContext, patch: Record<string, unknown>): { config: PhotoPluginConfig } | { error: string } {
  const current = readPhotoConfigForAdmin(context);
  const next: PhotoPluginConfig = {
    ...current,
    enabled: patch.enabled === undefined ? current.enabled : booleanFromUnknown(patch.enabled),
    selfieMode: patch.selfieMode === undefined ? current.selfieMode : photoSelfieModeFromUnknown(patch.selfieMode),
    selfieReferenceDir: patch.selfieReferenceDir === undefined ? current.selfieReferenceDir : requiredString(patch.selfieReferenceDir).trim(),
    selfieOutputDir: patch.selfieOutputDir === undefined ? current.selfieOutputDir : requiredString(patch.selfieOutputDir).trim(),
    selfieDefaultPose: patch.selfieDefaultPose === undefined ? current.selfieDefaultPose : requiredString(patch.selfieDefaultPose),
    selfieDefaultExpression: patch.selfieDefaultExpression === undefined ? current.selfieDefaultExpression : requiredString(patch.selfieDefaultExpression),
    selfieDefaultHair: patch.selfieDefaultHair === undefined ? current.selfieDefaultHair : requiredString(patch.selfieDefaultHair),
    selfieDefaultComposition: patch.selfieDefaultComposition === undefined ? current.selfieDefaultComposition : requiredString(patch.selfieDefaultComposition),
    selfieCodexCommand: patch.selfieCodexCommand === undefined ? current.selfieCodexCommand : requiredString(patch.selfieCodexCommand).trim(),
    selfieCodexExtraPrompt: patch.selfieCodexExtraPrompt === undefined ? current.selfieCodexExtraPrompt : requiredString(patch.selfieCodexExtraPrompt),
    selfieCodexTimeoutMs: patch.selfieCodexTimeoutMs === undefined ? current.selfieCodexTimeoutMs : photoNumberFromUnknown(patch.selfieCodexTimeoutMs),
    selfieImageApiKey: patch.selfieImageApiKey === undefined ? current.selfieImageApiKey : secretStringFromUnknown(patch.selfieImageApiKey, current.selfieImageApiKey),
    selfieImageApiBaseURL: patch.selfieImageApiBaseURL === undefined ? current.selfieImageApiBaseURL : requiredString(patch.selfieImageApiBaseURL).trim().replace(/\/+$/, ""),
    selfieImageApiRelayKey: patch.selfieImageApiRelayKey === undefined ? current.selfieImageApiRelayKey : secretStringFromUnknown(patch.selfieImageApiRelayKey, current.selfieImageApiRelayKey),
    selfieImageApiRelayBaseURL: patch.selfieImageApiRelayBaseURL === undefined ? current.selfieImageApiRelayBaseURL : requiredString(patch.selfieImageApiRelayBaseURL).trim().replace(/\/+$/, ""),
    selfieImageApiModel: patch.selfieImageApiModel === undefined ? current.selfieImageApiModel : requiredString(patch.selfieImageApiModel).trim(),
    selfieImageApiSize: patch.selfieImageApiSize === undefined ? current.selfieImageApiSize : requiredString(patch.selfieImageApiSize).trim(),
    selfieImageApiQuality: patch.selfieImageApiQuality === undefined ? current.selfieImageApiQuality : requiredString(patch.selfieImageApiQuality).trim(),
    selfieImageApiModeration: patch.selfieImageApiModeration === undefined ? current.selfieImageApiModeration : photoModerationFromUnknown(patch.selfieImageApiModeration),
    selfieImageApiOutputFormat: patch.selfieImageApiOutputFormat === undefined ? current.selfieImageApiOutputFormat : photoOutputFormatFromUnknown(patch.selfieImageApiOutputFormat),
    selfieImageApiOutputCompression: patch.selfieImageApiOutputCompression === undefined ? current.selfieImageApiOutputCompression : photoNumberFromUnknown(patch.selfieImageApiOutputCompression),
    selfieImageApiTimeoutMs: patch.selfieImageApiTimeoutMs === undefined ? current.selfieImageApiTimeoutMs : photoNumberFromUnknown(patch.selfieImageApiTimeoutMs),
    selfieImageApiRelayModel: patch.selfieImageApiRelayModel === undefined ? current.selfieImageApiRelayModel : requiredString(patch.selfieImageApiRelayModel).trim(),
    selfieImageApiRelaySize: patch.selfieImageApiRelaySize === undefined ? current.selfieImageApiRelaySize : requiredString(patch.selfieImageApiRelaySize).trim(),
    selfieImageApiRelayQuality: patch.selfieImageApiRelayQuality === undefined ? current.selfieImageApiRelayQuality : requiredString(patch.selfieImageApiRelayQuality).trim(),
    selfieImageApiRelayModeration: patch.selfieImageApiRelayModeration === undefined ? current.selfieImageApiRelayModeration : photoModerationFromUnknown(patch.selfieImageApiRelayModeration),
    selfieImageApiRelayOutputFormat: patch.selfieImageApiRelayOutputFormat === undefined ? current.selfieImageApiRelayOutputFormat : photoOutputFormatFromUnknown(patch.selfieImageApiRelayOutputFormat),
    selfieImageApiRelayOutputCompression: patch.selfieImageApiRelayOutputCompression === undefined ? current.selfieImageApiRelayOutputCompression : photoNumberFromUnknown(patch.selfieImageApiRelayOutputCompression),
    selfieImageApiRelayTimeoutMs: patch.selfieImageApiRelayTimeoutMs === undefined ? current.selfieImageApiRelayTimeoutMs : photoNumberFromUnknown(patch.selfieImageApiRelayTimeoutMs),
    selfieXaiImageApiKey: patch.selfieXaiImageApiKey === undefined ? current.selfieXaiImageApiKey : secretStringFromUnknown(patch.selfieXaiImageApiKey, current.selfieXaiImageApiKey),
    selfieXaiImageApiBaseURL: patch.selfieXaiImageApiBaseURL === undefined ? current.selfieXaiImageApiBaseURL : requiredString(patch.selfieXaiImageApiBaseURL).trim().replace(/\/+$/, ""),
    selfieXaiImageApiModel: patch.selfieXaiImageApiModel === undefined ? current.selfieXaiImageApiModel : requiredString(patch.selfieXaiImageApiModel).trim(),
    selfieXaiImageApiAspectRatio: patch.selfieXaiImageApiAspectRatio === undefined ? current.selfieXaiImageApiAspectRatio : requiredString(patch.selfieXaiImageApiAspectRatio).trim(),
    selfieXaiImageApiResolution: patch.selfieXaiImageApiResolution === undefined ? current.selfieXaiImageApiResolution : requiredString(patch.selfieXaiImageApiResolution).trim(),
    selfieXaiImageApiQuality: patch.selfieXaiImageApiQuality === undefined ? current.selfieXaiImageApiQuality : requiredString(patch.selfieXaiImageApiQuality).trim(),
    selfieXaiImageApiTimeoutMs: patch.selfieXaiImageApiTimeoutMs === undefined ? current.selfieXaiImageApiTimeoutMs : photoNumberFromUnknown(patch.selfieXaiImageApiTimeoutMs),
    selfieMaxBytes: patch.selfieMaxBytes === undefined ? current.selfieMaxBytes : photoNumberFromUnknown(patch.selfieMaxBytes),
    autoGenerateOutfitOnBody: patch.autoGenerateOutfitOnBody === undefined ? current.autoGenerateOutfitOnBody : booleanFromUnknown(patch.autoGenerateOutfitOnBody),
    onBodyReferenceImage: patch.onBodyReferenceImage === undefined ? current.onBodyReferenceImage : requiredString(patch.onBodyReferenceImage).trim(),
    onBodyPrompt: patch.onBodyPrompt === undefined ? current.onBodyPrompt : requiredString(patch.onBodyPrompt),
    selfieOnBodyPrompt: patch.selfieOnBodyPrompt === undefined ? current.selfieOnBodyPrompt : requiredString(patch.selfieOnBodyPrompt),
    selfie2DinRealEnabled: patch.selfie2DinRealEnabled === undefined ? current.selfie2DinRealEnabled : booleanFromUnknown(patch.selfie2DinRealEnabled),
    selfie2DinRealReferenceImage: patch.selfie2DinRealReferenceImage === undefined ? current.selfie2DinRealReferenceImage : requiredString(patch.selfie2DinRealReferenceImage).trim(),
    selfie2DinRealPrompt: patch.selfie2DinRealPrompt === undefined ? current.selfie2DinRealPrompt : requiredString(patch.selfie2DinRealPrompt)
  };

  const validationError = validatePhotoConfig(next);
  if (validationError) return { error: validationError };
  writePhotoConfig(context, next);
  return { config: next };
}

function validatePhotoConfig(config: PhotoPluginConfig): string | undefined {
  if (config.selfieMode !== "openai" && config.selfieMode !== "openaiRelay" && config.selfieMode !== "xai" && config.selfieMode !== "codex") return "invalid_selfie_mode";
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
  if (invalidNumber(config.selfieImageApiTimeoutMs, 1000)) return "invalid_selfie_api_timeout";
  if (!config.selfieImageApiRelayModel) return "missing_selfie_api_relay_model";
  if (!config.selfieImageApiRelaySize) return "missing_selfie_api_relay_size";
  if (!config.selfieImageApiRelayQuality) return "missing_selfie_api_relay_quality";
  if (!["auto", "low"].includes(config.selfieImageApiRelayModeration)) return "invalid_selfie_api_relay_moderation";
  if (!["jpeg", "png", "webp"].includes(config.selfieImageApiRelayOutputFormat)) return "invalid_selfie_relay_output_format";
  if (invalidNumber(config.selfieImageApiRelayOutputCompression, 0, 100)) return "invalid_selfie_relay_output_compression";
  if (invalidNumber(config.selfieImageApiRelayTimeoutMs, 1000)) return "invalid_selfie_api_relay_timeout";
  if (!isValidHttpUrl(config.selfieXaiImageApiBaseURL)) return "invalid_selfie_xai_api_base_url";
  if (!config.selfieXaiImageApiModel) return "missing_selfie_xai_api_model";
  if (!config.selfieXaiImageApiAspectRatio) return "missing_selfie_xai_api_aspect_ratio";
  if (!config.selfieXaiImageApiResolution || !["1k", "2k"].includes(config.selfieXaiImageApiResolution)) return "invalid_selfie_xai_api_resolution";
  if (!config.selfieXaiImageApiQuality || !["low", "medium"].includes(config.selfieXaiImageApiQuality)) return "invalid_selfie_xai_api_quality";
  if (invalidNumber(config.selfieXaiImageApiTimeoutMs, 1000)) return "invalid_selfie_xai_api_timeout";
  if (invalidNumber(config.selfieMaxBytes, 1024, 50 * 1024 * 1024)) return "invalid_selfie_max_bytes";
  if (!config.onBodyReferenceImage) return "missing_on_body_reference_image";
  if (config.selfie2DinRealEnabled && !config.selfie2DinRealReferenceImage) return "missing_2dinreal_reference_image";
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
    selfieDefaultPose: photo.selfieDefaultPose,
    selfieDefaultExpression: photo.selfieDefaultExpression,
    selfieDefaultHair: photo.selfieDefaultHair,
    selfieDefaultComposition: photo.selfieDefaultComposition,
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
    selfieXaiImageApiKey: photo.selfieXaiImageApiKey,
    selfieXaiImageApiBaseURL: photo.selfieXaiImageApiBaseURL,
    selfieXaiImageApiModel: photo.selfieXaiImageApiModel,
    selfieXaiImageApiAspectRatio: photo.selfieXaiImageApiAspectRatio,
    selfieXaiImageApiResolution: photo.selfieXaiImageApiResolution,
    selfieXaiImageApiQuality: photo.selfieXaiImageApiQuality,
    selfieXaiImageApiTimeoutMs: photo.selfieXaiImageApiTimeoutMs,
    selfieMaxBytes: photo.selfieMaxBytes,
    autoGenerateOutfitOnBody: photo.autoGenerateOutfitOnBody,
    onBodyReferenceImage: photo.onBodyReferenceImage,
    onBodyPrompt: photo.onBodyPrompt,
    selfieOnBodyPrompt: photo.selfieOnBodyPrompt,
    selfie2DinRealEnabled: photo.selfie2DinRealEnabled,
    selfie2DinRealReferenceImage: photo.selfie2DinRealReferenceImage,
    selfie2DinRealPrompt: photo.selfie2DinRealPrompt
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

export async function generatePhotoOnBody(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const result = await generatePhotoOnBodyImage(context, await readJsonBody(request));
  if (result.ok) {
    writeJson(response, 200, result);
  } else {
    writeJson(response, result.statusCode, result);
  }
}

function photoSelfieModeFromUnknown(value: unknown): SelfieGenerationMode {
  return requiredString(value).trim() as SelfieGenerationMode;
}

function photoOutputFormatFromUnknown(value: unknown): string {
  const normalized = requiredString(value).trim().toLowerCase();
  if (normalized === "jpg") return "jpeg";
  if (normalized === "jpeg" || normalized === "png" || normalized === "webp") return normalized;
  return normalized;
}

function photoModerationFromUnknown(value: unknown): string {
  const normalized = requiredString(value).trim().toLowerCase();
  if (normalized === "auto" || normalized === "low") return normalized;
  return normalized;
}

function photoNumberFromUnknown(value: unknown): number {
  if (typeof value === "string" && value.trim() === "") return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}


function selectedPhotoImageApiKey(config: PhotoPluginConfig): string | undefined {
  if (config.selfieMode === "openaiRelay") return config.selfieImageApiRelayKey;
  if (config.selfieMode === "xai") return config.selfieXaiImageApiKey;
  return config.selfieImageApiKey;
}

function isPathUnderAssets(value: string): boolean {
  const relative = path.relative(path.resolve("assets"), path.resolve(value));
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
