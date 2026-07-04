const fs = await import("node:fs");
const path = await import("node:path");

export type SelfieGenerationMode = "openai" | "codex" | "openaiRelay";

export type PhotoPluginConfig = {
  enabled: boolean;
  selfieMode: SelfieGenerationMode;
  selfieReferenceDir: string;
  selfieOutputDir: string;
  selfieCodexCommand: string;
  selfieCodexExtraPrompt: string;
  selfieCodexTimeoutMs: number;
  selfieImageApiKey?: string;
  selfieImageApiBaseURL: string;
  selfieImageApiRelayKey?: string;
  selfieImageApiRelayBaseURL: string;
  selfieImageApiModel: string;
  selfieImageApiSize: string;
  selfieImageApiQuality: string;
  selfieImageApiModeration: string;
  selfieImageApiOutputFormat: string;
  selfieImageApiOutputCompression: number;
  selfieImageApiTimeoutMs: number;
  selfieImageApiRelayModel: string;
  selfieImageApiRelaySize: string;
  selfieImageApiRelayQuality: string;
  selfieImageApiRelayModeration: string;
  selfieImageApiRelayOutputFormat: string;
  selfieImageApiRelayOutputCompression: number;
  selfieImageApiRelayTimeoutMs: number;
  selfieMaxBytes: number;
  autoGenerateOutfitOnBody: boolean;
  onBodyReferenceImage: string;
  onBodyPrompt: string;
  selfieOnBodyPrompt: string;
  selfie2DinRealEnabled: boolean;
  selfie2DinRealReferenceImage: string;
  selfie2DinRealPrompt: string;
};

export type PhotoPluginPublicConfig = Omit<PhotoPluginConfig, "selfieImageApiKey" | "selfieImageApiRelayKey"> & {
  selfieImageApiKeySet: boolean;
  selfieImageApiRelayKeySet: boolean;
};

export type ImageApiSettings = {
  key?: string;
  baseURL: string;
  endpoint: "edits" | "relayEdits";
  model: string;
  size: string;
  quality: string;
  moderation: string;
  outputFormat: string;
  outputCompression: number;
  timeoutMs: number;
};

export const defaultPhotoPluginConfigPath = "config/plugin/photo/config.json";

export function readPhotoPluginConfig(configPath?: string, defaults: Partial<PhotoPluginConfig> = {}): PhotoPluginConfig {
  let parsed: Record<string, unknown> = {};
  if (configPath) {
    const resolved = path.resolve(configPath);
    parsed = parseJsonObject(fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "{}");
  }
  return normalizePhotoPluginConfig(parsed, defaults);
}

export function publicPhotoPluginConfig(config: PhotoPluginConfig): PhotoPluginPublicConfig {
  const { selfieImageApiKey, selfieImageApiRelayKey, ...publicConfig } = config;
  return {
    ...publicConfig,
    selfieImageApiKeySet: Boolean(selfieImageApiKey),
    selfieImageApiRelayKeySet: Boolean(selfieImageApiRelayKey)
  };
}

export function normalizePhotoPluginConfig(parsed: Record<string, unknown>, defaults: Partial<PhotoPluginConfig> = {}): PhotoPluginConfig {
  return {
    enabled: booleanValue(parsed.enabled, defaults.enabled ?? true, "enabled"),
    selfieMode: selfieModeValue(parsed.selfieMode, defaults.selfieMode ?? "openai", "selfieMode"),
    selfieReferenceDir: requiredStringValue(parsed.selfieReferenceDir, defaults.selfieReferenceDir ?? "assets/selfie/references", "selfieReferenceDir"),
    selfieOutputDir: requiredStringValue(parsed.selfieOutputDir, defaults.selfieOutputDir ?? "assets/generated/selfies", "selfieOutputDir"),
    selfieCodexCommand: requiredStringValue(parsed.selfieCodexCommand, defaults.selfieCodexCommand ?? "codex", "selfieCodexCommand"),
    selfieCodexExtraPrompt: optionalRawStringValue(parsed.selfieCodexExtraPrompt, defaults.selfieCodexExtraPrompt, "selfieCodexExtraPrompt") ?? "",
    selfieCodexTimeoutMs: numberValue(parsed.selfieCodexTimeoutMs, defaults.selfieCodexTimeoutMs ?? 300_000, "selfieCodexTimeoutMs"),
    selfieImageApiKey: optionalStringValue(parsed.selfieImageApiKey, defaults.selfieImageApiKey, "selfieImageApiKey"),
    selfieImageApiBaseURL: requiredStringValue(parsed.selfieImageApiBaseURL, defaults.selfieImageApiBaseURL ?? "https://api.openai.com/v1", "selfieImageApiBaseURL").replace(/\/+$/, ""),
    selfieImageApiRelayKey: optionalStringValue(parsed.selfieImageApiRelayKey, defaults.selfieImageApiRelayKey, "selfieImageApiRelayKey"),
    selfieImageApiRelayBaseURL: requiredStringValue(parsed.selfieImageApiRelayBaseURL, defaults.selfieImageApiRelayBaseURL ?? defaults.selfieImageApiBaseURL ?? "https://api.openai.com/v1", "selfieImageApiRelayBaseURL").replace(/\/+$/, ""),
    selfieImageApiModel: requiredStringValue(parsed.selfieImageApiModel, defaults.selfieImageApiModel ?? "gpt-image-2", "selfieImageApiModel"),
    selfieImageApiSize: requiredStringValue(parsed.selfieImageApiSize, defaults.selfieImageApiSize ?? "768x1024", "selfieImageApiSize"),
    selfieImageApiQuality: requiredStringValue(parsed.selfieImageApiQuality, defaults.selfieImageApiQuality ?? "low", "selfieImageApiQuality"),
    selfieImageApiModeration: requiredStringValue(parsed.selfieImageApiModeration, defaults.selfieImageApiModeration ?? "low", "selfieImageApiModeration"),
    selfieImageApiOutputFormat: outputFormatValue(parsed.selfieImageApiOutputFormat, defaults.selfieImageApiOutputFormat ?? "jpeg", "selfieImageApiOutputFormat"),
    selfieImageApiOutputCompression: numberValue(parsed.selfieImageApiOutputCompression, defaults.selfieImageApiOutputCompression ?? 45, "selfieImageApiOutputCompression"),
    selfieImageApiTimeoutMs: numberValue(parsed.selfieImageApiTimeoutMs, defaults.selfieImageApiTimeoutMs ?? 120_000, "selfieImageApiTimeoutMs"),
    selfieImageApiRelayModel: requiredStringValue(parsed.selfieImageApiRelayModel, defaults.selfieImageApiRelayModel ?? defaults.selfieImageApiModel ?? "gpt-image-2", "selfieImageApiRelayModel"),
    selfieImageApiRelaySize: requiredStringValue(parsed.selfieImageApiRelaySize, defaults.selfieImageApiRelaySize ?? defaults.selfieImageApiSize ?? "768x1024", "selfieImageApiRelaySize"),
    selfieImageApiRelayQuality: requiredStringValue(parsed.selfieImageApiRelayQuality, defaults.selfieImageApiRelayQuality ?? defaults.selfieImageApiQuality ?? "low", "selfieImageApiRelayQuality"),
    selfieImageApiRelayModeration: requiredStringValue(parsed.selfieImageApiRelayModeration, defaults.selfieImageApiRelayModeration ?? defaults.selfieImageApiModeration ?? "low", "selfieImageApiRelayModeration"),
    selfieImageApiRelayOutputFormat: outputFormatValue(parsed.selfieImageApiRelayOutputFormat, defaults.selfieImageApiRelayOutputFormat ?? defaults.selfieImageApiOutputFormat ?? "jpeg", "selfieImageApiRelayOutputFormat"),
    selfieImageApiRelayOutputCompression: numberValue(parsed.selfieImageApiRelayOutputCompression, defaults.selfieImageApiRelayOutputCompression ?? defaults.selfieImageApiOutputCompression ?? 45, "selfieImageApiRelayOutputCompression"),
    selfieImageApiRelayTimeoutMs: numberValue(parsed.selfieImageApiRelayTimeoutMs, defaults.selfieImageApiRelayTimeoutMs ?? defaults.selfieImageApiTimeoutMs ?? 120_000, "selfieImageApiRelayTimeoutMs"),
    selfieMaxBytes: numberValue(parsed.selfieMaxBytes, defaults.selfieMaxBytes ?? 10 * 1024 * 1024, "selfieMaxBytes"),
    autoGenerateOutfitOnBody: booleanValue(parsed.autoGenerateOutfitOnBody, defaults.autoGenerateOutfitOnBody ?? false, "autoGenerateOutfitOnBody"),
    onBodyReferenceImage: requiredStringValue(parsed.onBodyReferenceImage, defaults.onBodyReferenceImage ?? "assets/selfie/references/full-body-reference.jpg", "onBodyReferenceImage"),
    onBodyPrompt: optionalStringValue(parsed.onBodyPrompt, defaults.onBodyPrompt, "onBodyPrompt") ?? "",
    selfieOnBodyPrompt: optionalStringValue(parsed.selfieOnBodyPrompt, defaults.selfieOnBodyPrompt, "selfieOnBodyPrompt") ?? "",
    selfie2DinRealEnabled: booleanValue(parsed.selfie2DinRealEnabled, defaults.selfie2DinRealEnabled ?? false, "selfie2DinRealEnabled"),
    selfie2DinRealReferenceImage: requiredStringValue(parsed.selfie2DinRealReferenceImage, defaults.selfie2DinRealReferenceImage ?? "assets/selfie/references/2dinreal-reference.jpg", "selfie2DinRealReferenceImage"),
    selfie2DinRealPrompt: optionalRawStringValue(parsed.selfie2DinRealPrompt, defaults.selfie2DinRealPrompt, "selfie2DinRealPrompt") ?? ""
  };
}

export function selectedImageApiSettings(config: PhotoPluginConfig): ImageApiSettings {
  if (config.selfieMode === "openaiRelay") {
    return {
      key: config.selfieImageApiRelayKey,
      baseURL: config.selfieImageApiRelayBaseURL,
      endpoint: "relayEdits",
      model: config.selfieImageApiRelayModel,
      size: config.selfieImageApiRelaySize,
      quality: config.selfieImageApiRelayQuality,
      moderation: config.selfieImageApiRelayModeration,
      outputFormat: config.selfieImageApiRelayOutputFormat,
      outputCompression: config.selfieImageApiRelayOutputCompression,
      timeoutMs: config.selfieImageApiRelayTimeoutMs
    };
  }
  return {
    key: config.selfieImageApiKey,
    baseURL: config.selfieImageApiBaseURL,
    endpoint: "edits",
    model: config.selfieImageApiModel,
    size: config.selfieImageApiSize,
    quality: config.selfieImageApiQuality,
    moderation: config.selfieImageApiModeration,
    outputFormat: config.selfieImageApiOutputFormat,
    outputCompression: config.selfieImageApiOutputCompression,
    timeoutMs: config.selfieImageApiTimeoutMs
  };
}

export function extensionForOutputFormat(value: string): string {
  return value === "jpeg" ? "jpg" : value;
}

function normalizeOutputFormat(value: string, name: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "jpg") return "jpeg";
  if (normalized === "jpeg" || normalized === "png" || normalized === "webp") return normalized;
  throw new Error(`invalid ${name}: ${value}`);
}

function selfieModeValue(value: unknown, defaultValue: SelfieGenerationMode, name: string): SelfieGenerationMode {
  if (value === undefined || value === null) return defaultValue;
  if (value === "codex" || value === "openaiRelay" || value === "openai") return value;
  throw new Error(`invalid ${name}: ${String(value)}`);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`invalid photo plugin config JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error("invalid photo plugin config JSON: root must be an object");
}

function requiredStringValue(value: unknown, defaultValue: string, name: string): string {
  const text = stringValue(value, name).trim();
  if (text) return text;
  if (value === undefined || value === null) return defaultValue;
  throw new Error(`invalid ${name}: empty string`);
}

function optionalStringValue(value: unknown, defaultValue: string | undefined, name: string): string | undefined {
  if (value === undefined || value === null) return defaultValue;
  const text = stringValue(value, name).trim();
  return text || undefined;
}

function optionalRawStringValue(value: unknown, defaultValue: string | undefined, name: string): string | undefined {
  if (value === undefined || value === null) return defaultValue;
  return stringValue(value, name);
}

function outputFormatValue(value: unknown, defaultValue: string, name: string): string {
  if (value === undefined || value === null) return normalizeOutputFormat(defaultValue, name);
  return normalizeOutputFormat(requiredStringValue(value, defaultValue, name), name);
}

function numberValue(value: unknown, defaultValue: number, name: string): number {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "string" && value.trim() === "") throw new Error(`invalid ${name}: empty string`);
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`invalid ${name}: ${String(value)}`);
}

function booleanValue(value: unknown, defaultValue: boolean, name: string): boolean {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  throw new Error(`invalid ${name}: ${String(value)}`);
}

function stringValue(value: unknown, name: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  throw new Error(`invalid ${name}: expected string`);
}
