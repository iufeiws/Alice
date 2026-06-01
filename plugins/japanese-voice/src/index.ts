import type { LLMClient, OpenAICompatibleConfig } from "../../../core/llm/src/index.js";
import { createOpenAICompatibleClient } from "../../../core/llm/src/index.js";
import type { LLMRequestSender } from "../../../core/agent/src/llm-tool-loop.js";
import type { VoiceSynthesizer } from "../../messaging/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type JapaneseVoiceApiPreset = {
  name?: string;
  baseURL: string;
  apiKey?: string;
  apiKeyEnv?: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
  extraParams?: Record<string, unknown>;
};

export type JapaneseVoicePluginConfig = {
  enabled: boolean;
  apiPresetName?: string;
  api_preset: JapaneseVoiceApiPreset;
  prompt: string;
  voice?: {
    modelDir?: string;
    referenceAudio?: string;
    referenceText?: string;
    speed?: number;
    partSilenceSeconds?: number;
  };
};

export type JapaneseVoicePluginDeps = {
  baseSynthesizer: VoiceSynthesizer;
  configPath?: string;
  llm?: LLMClient;
  llmRequestSender?: LLMRequestSender;
  env?: Record<string, string | undefined>;
  resolveApiPreset?(name: string): JapaneseVoiceApiPreset | undefined;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
};

export type JapaneseVoicePlugin = {
  id: "japanese_voice";
  config: JapaneseVoicePluginConfig;
  voiceSynthesizer: VoiceSynthesizer;
};

const defaultConfigPath = "plugins/japanese-voice/config.json";

export function createJapaneseVoicePlugin(deps: JapaneseVoicePluginDeps): JapaneseVoicePlugin {
  const config = readJapaneseVoicePluginConfig(deps.configPath);

  return {
    id: "japanese_voice",
    config,
    voiceSynthesizer: createJapaneseVoiceRoutingSynthesizer(deps)
  };
}

export function readJapaneseVoicePluginConfig(configPath = defaultConfigPath): JapaneseVoicePluginConfig {
  const resolved = path.resolve(configPath);
  const raw = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "{}";
  const parsed = parseJsonObject(raw);
  const preset = parseJsonObject(parsed.api_preset);
  return {
    enabled: booleanValue(parsed.enabled, false),
    apiPresetName: stringValue(parsed.apiPresetName) || stringValue(preset.name),
    api_preset: {
      name: stringValue(preset.name),
      baseURL: stringValue(preset.baseURL) || "",
      apiKey: stringValue(preset.apiKey),
      apiKeyEnv: stringValue(preset.apiKeyEnv),
      model: stringValue(preset.model) || "flash",
      temperature: numberValue(preset.temperature, 0.2),
      timeoutMs: numberValue(preset.timeoutMs, 60_000),
      extraParams: recordValue(preset.extraParams)
    },
    prompt: stringValue(parsed.prompt) || defaultPrompt(),
    voice: {
      modelDir: stringValue(parseJsonObject(parsed.voice).modelDir),
      referenceAudio: stringValue(parseJsonObject(parsed.voice).referenceAudio),
      referenceText: stringValue(parseJsonObject(parsed.voice).referenceText),
      speed: optionalNumberValue(parseJsonObject(parsed.voice).speed),
      partSilenceSeconds: optionalNumberValue(parseJsonObject(parsed.voice).partSilenceSeconds)
    }
  };
}

export function createJapaneseVoiceTranslationSynthesizer(
  config: JapaneseVoicePluginConfig,
  deps: JapaneseVoicePluginDeps
): VoiceSynthesizer {
  const base = deps.baseSynthesizer;
  const synthesize = (async (input) => {
    const translated = await translateJapaneseVoiceText(input.text, config, deps);
    return base({
      ...input,
      text: translated || input.text,
      genie: japaneseVoiceGenieOverrides(config)
    });
  }) as VoiceSynthesizer;

  synthesize.noteActivity = () => base.noteActivity?.();
  synthesize.prepare = async () => {
    base.noteActivity?.();
    await base.prepare?.();
  };
  synthesize.shutdown = async () => {
    await base.shutdown?.();
  };
  return synthesize;
}

function createJapaneseVoiceRoutingSynthesizer(deps: JapaneseVoicePluginDeps): VoiceSynthesizer {
  const base = deps.baseSynthesizer;
  const synthesize = (async (input) => {
    const config = readJapaneseVoicePluginConfig(deps.configPath);
    if (!config.enabled) return base(input);
    const translated = await translateJapaneseVoiceText(input.text, config, deps);
    return base({
      ...input,
      text: translated || input.text,
      genie: japaneseVoiceGenieOverrides(config)
    });
  }) as VoiceSynthesizer;

  synthesize.noteActivity = () => base.noteActivity?.();
  synthesize.prepare = async () => {
    base.noteActivity?.();
    await base.prepare?.();
  };
  synthesize.shutdown = async () => {
    await base.shutdown?.();
  };
  return synthesize;
}

export function japaneseVoiceGenieOverrides(config: JapaneseVoicePluginConfig): NonNullable<Parameters<VoiceSynthesizer>[0]["genie"]> {
  const voice = config.voice ?? {};
  return {
    language: "jp",
    modelDir: voice.modelDir,
    referenceAudio: voice.referenceAudio,
    referenceText: voice.referenceText,
    ...(voice.speed !== undefined ? { speed: voice.speed } : {}),
    ...(voice.partSilenceSeconds !== undefined ? { partSilenceSeconds: voice.partSilenceSeconds } : {})
  };
}

export async function translateJapaneseVoiceText(text: string, config: JapaneseVoicePluginConfig, deps: JapaneseVoicePluginDeps): Promise<string | undefined> {
  const preset = resolveEffectivePreset(config, deps);
  const client = deps.llm ?? (preset ? createClientFromPreset(preset, deps.env ?? process.env) : undefined);
  if (!client) {
    deps.appendLog?.("warn", "japanese voice translation skipped: missing api preset baseURL or api key");
    return undefined;
  }

  try {
    deps.appendLog?.("info", `japanese voice translation start: chars=${Array.from(text).length}`);
    const request = {
      agentId: "japanese-voice",
      client,
      messages: [
        { role: "system" as const, content: config.prompt.trim() },
        { role: "user" as const, content: text }
      ],
      model: preset?.model ?? config.api_preset.model,
      temperature: preset?.temperature ?? config.api_preset.temperature,
      extraParams: preset?.extraParams ?? config.api_preset.extraParams,
      toolNames: [],
      round: 0,
      stream: false,
      metadata: { pluginId: "japanese-voice", route: "send_chat.voice.before_tts" }
    };
    const result = deps.llmRequestSender
      ? await deps.llmRequestSender(request)
      : await client.chat({
        messages: request.messages,
        model: request.model,
        temperature: request.temperature,
        extraParams: request.extraParams
      });
    const translated = result.message.content.trim();
    if (!translated) {
      deps.appendLog?.("warn", "japanese voice translation returned empty text; using original text");
      return undefined;
    }
    deps.appendLog?.("info", `japanese voice translation complete: chars=${Array.from(translated).length}`);
    return translated;
  } catch (error) {
    deps.appendLog?.("warn", `japanese voice translation failed; using original text: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function resolveEffectivePreset(config: JapaneseVoicePluginConfig, deps: JapaneseVoicePluginDeps): JapaneseVoiceApiPreset | undefined {
  if (config.apiPresetName) return deps.resolveApiPreset?.(config.apiPresetName) ?? config.api_preset;
  return config.api_preset;
}

function createClientFromPreset(preset: JapaneseVoiceApiPreset, env: Record<string, string | undefined>): LLMClient | undefined {
  const apiKey = preset.apiKey || (preset.apiKeyEnv ? env[preset.apiKeyEnv] : undefined);
  if (!preset.baseURL || !apiKey) return undefined;
  const config: OpenAICompatibleConfig = {
    baseURL: preset.baseURL,
    apiKey,
    model: preset.model,
    temperature: preset.temperature,
    timeoutMs: preset.timeoutMs,
    extraParams: preset.extraParams
  };
  return createOpenAICompatibleClient(config);
}

function defaultPrompt(): string {
  return [
    "Translate the text appended below into natural Japanese for voice reading.",
    "Preserve meaning, tone, names, numbers, and punctuation intent.",
    "Return only the translated Japanese text. Do not add explanations.",
    "",
    "Text:"
  ].join("\n");
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parseJsonObject(parsed);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
