import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";
import type { TtsConversionProvider, TtsTextFilter } from "../../../channels/tts/src/index.js";

export type AdminPluginKind = "channel" | "tool" | "voice" | "asr" | "presentation" | "context";
export type AdminPluginStatus = "enabled" | "disabled" | "planned" | "missing_config" | "error";
export type AdminPluginHealth = "healthy" | "degraded" | "failing" | "unknown";

export type AdminPluginSummary = {
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

export type TtsAdminConfig = {
  enabled: boolean;
  activePresetName: string;
  corePresetName?: string;
  shellPresetName?: string;
  editPresetName: string;
  newPresetName?: string;
  presets: Record<string, any>;
  currentPreset: {
    provider: TtsConversionProvider;
    genie?: {
      enabled?: boolean;
      baseURL?: string;
      localFallbackEnabled?: boolean;
      language?: "jp" | "zh" | "en";
      modelDir?: string;
      referenceAudio?: string;
      referenceText?: string;
      speed?: number;
      partSilenceSeconds?: number;
      splitText?: boolean;
      textFilters?: TtsTextFilter[];
    };
    openaiApi?: {
      apiPresetName?: string;
      model?: string;
      voice?: string;
      timeoutMs?: number;
      sampleRate?: number;
      channels?: number;
      textFilters?: TtsTextFilter[];
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
      responseFormat?: string;
      timeoutMs?: number;
      sampleRate?: number;
      channels?: number;
      textFilters?: TtsTextFilter[];
      extraParamsJson?: string;
    };
    mimo?: {
      mode?: "preset" | "voicedesign" | "voiceclone";
      baseURL?: string;
      apiKey?: string;
      apiKeyEnv?: string;
      model?: string;
      voice?: string;
      voiceDesignPrompt?: string;
      voiceCloneAudioDataUrl?: string;
      voiceCloneAudioDataUrlSet?: boolean;
      audioFormat?: "wav" | "pcm16";
      timeoutMs?: number;
      sampleRate?: number;
      channels?: number;
      textFilters?: TtsTextFilter[];
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
};

export type AdminPluginFieldType = "switch" | "text" | "password" | "number" | "textarea" | "select" | "apiPresetSelect" | "fileUpload" | "folderUpload" | "readonly" | "readonlyTextarea";

export type AdminPluginConfigField = {
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

export type AdminPluginRegistryEntry = {
  summary(context: AdminRoutesContext): AdminPluginSummary;
  config?(context: AdminRoutesContext): unknown;
  patch?(context: AdminRoutesContext, patch: Record<string, unknown>): { config: unknown; restartRequired?: boolean } | { error: string } | Promise<{ config: unknown; restartRequired?: boolean } | { error: string }>;
  setEnabled?(context: AdminRoutesContext, enabled: boolean): { config: unknown } | { error: string };
  reload?(context: AdminRoutesContext): { config: unknown } | { error: string };
  runtimeState?(context: AdminRoutesContext): unknown;
  preview?(context: AdminRoutesContext): Promise<unknown> | unknown;
  test?(context: AdminRoutesContext, input: Record<string, unknown>): Promise<{ ok: true; result?: unknown } | { error: string }> | { ok: true; result?: unknown } | { error: string };
  uploadAsset?(context: AdminRoutesContext, assetKey: string, request: any): Promise<{ config: unknown; assetPath: string } | { error: string; statusCode?: number }>;
  configSchema?: {
    groups?: Array<{ key: string; label: string }>;
    fields: AdminPluginConfigField[];
  };
  routePreview?: string[];
  runtimeAccess?: string[];
  testSchema?: {
    input: "text" | "audio" | "image";
    label: string;
    buttonLabel: string;
    defaultValue?: string;
  };
};
