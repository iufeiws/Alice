import type { LLMClient, OpenAICompatibleConfig } from "../../../contexts/llm-gateway/src/index.js";
import { createOpenAICompatibleClient } from "../../../contexts/llm-gateway/src/index.js";
import type { LLMRequestSender } from "../../../contexts/llm-gateway/src/llm-tool-loop.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import { renderLLMText, type LLMTextVariables } from "../../../contexts/agent-profile/src/application/llm-text-renderer.js";

const fsp = await import("node:fs/promises");
const childProcess = await import("node:child_process");
const moduleApi = await import("node:module");
const require = moduleApi.createRequire(import.meta.url);
export type TTSConfig = {
  backend?: "genie-tts" | "moss-onnx";
  genieBaseURL?: string;
  genieBaseURLExplicit?: boolean;
  genieHost?: string;
  geniePort?: number;
  geniePythonCommand?: string;
  genieServiceScript?: string;
  genieDataDir?: string;
  genieModelDir?: string;
  genieCharacterName?: string;
  genieLanguage?: string;
  genieReferenceAudio?: string;
  genieReferenceText?: string;
  genieOutputDir?: string;
  genieTimeoutMs?: number;
  genieIdleShutdownMs?: number;
  genieFfmpegCommand?: string;
  genieUseStreamForSynthesis?: boolean;
  mossBaseURL?: string;
  mossBaseURLExplicit?: boolean;
  mossHost?: string;
  mossPort?: number;
  mossPythonCommand?: string;
  mossServiceScript?: string;
  mossModelDir?: string;
  mossReferenceAudio?: string;
  mossOutputDir?: string;
  mossTimeoutMs?: number;
  mossIdleShutdownMs?: number;
  mossFfmpegCommand?: string;
  mossVoiceCloneMaxTextTokens?: number;
};

export type VoiceSynthesisInput = {
  text: string;
  time: CurrentTimeProvider;
  genie?: {
    language?: string;
    modelDir?: string;
    referenceAudio?: string;
    referenceText?: string;
    speed?: number;
    partSilenceSeconds?: number;
    splitText?: boolean;
  };
};

export type VoiceSynthesisResult = {
  assetId: string;
  filePath: string;
};

export type VoiceSynthesizer = ((input: VoiceSynthesisInput) => Promise<VoiceSynthesisResult>) & {
  streamAudio?(input: VoiceSynthesisInput): AsyncIterable<Uint8Array>;
  streamAudioWithText?(input: VoiceSynthesisInput): AsyncIterable<TtsAudioTextChunk>;
  noteActivity?(): void;
  prepare?(): Promise<void>;
  shutdown?(): Promise<void>;
};

export type FallbackVoiceSynthesizerDeps = {
  appendLog?(level: "info" | "warn" | "error", message: string): void;
};

const fs = await import("node:fs");
const path = await import("node:path");
const crypto = await import("node:crypto");

export type TtsApiPreset = {
  name?: string;
  baseURL: string;
  apiKey?: string;
  apiKeyEnv?: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
  extraParams?: Record<string, unknown>;
};

export type TtsPluginConfig = {
  enabled: boolean;
  remote?: TtsRemoteConfig;
  translationPresetName?: string;
  translationPresets?: Record<string, TtsTranslationPreset>;
  translationEnabled: boolean;
  apiPresetName?: string;
  api_preset?: TtsApiPreset;
  prompt: string;
  voice?: {
    modelConfigName?: string;
    modelConfigs?: Record<string, TtsVoiceModelConfig>;
  };
};

export type TtsRemoteConfig = {
  enabled?: boolean;
  baseURL?: string;
};

export type TtsTranslationPreset = {
  translationEnabled?: boolean;
  apiPresetName?: string;
  prompt?: string;
};

export type TtsVoiceModelConfig = {
  language?: "jp" | "zh" | "en";
  speed?: number;
  partSilenceSeconds?: number;
  splitText?: boolean;
  modelDir?: string;
  referenceAudio?: string;
  referenceText?: string;
};

export type TtsPluginDeps = {
  baseSynthesizer: VoiceSynthesizer;
  configPath?: string;
  llm?: LLMClient;
  llmRequestSender?: LLMRequestSender;
  env?: Record<string, string | undefined>;
  resolveApiPreset?(name: string): TtsApiPreset | undefined;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
  promptVariables?: LLMTextVariables | (() => LLMTextVariables);
};

export type TtsPlugin = {
  id: "tts";
  config: TtsPluginConfig;
  voiceSynthesizer: TtsSynthesizer;
};

export type TtsStreamInput = {
  text: AsyncIterable<string> | Iterable<string> | string;
  time: CurrentTimeProvider;
  source: "send_chat.voice";
  streamId?: string;
};

export type TtsStreamChunk =
  | { type: "translation_started"; sequence: number; sourceChars: number }
  | { type: "translation_done"; sequence: number; translatedChars: number }
  | { type: "audio"; sequence: number; text?: string; chunk: Uint8Array; contentType: "audio/L16; rate=32000; channels=1" }
  | { type: "part_done"; sequence: number }
  | { type: "done" };

export type TtsAudioTextChunk = {
  text?: string;
  chunk: Uint8Array;
};

export type TtsSynthesizer = VoiceSynthesizer & {
  stream?(input: TtsStreamInput): AsyncIterable<TtsStreamChunk>;
};

const defaultConfigPath = "config/plugin/tts/config.json";
const legacyTtsConfigPath = "src/plugins/tts/config.json";
const legacyConfigPath = "src/plugins/japanese-voice/config.json";
const ttsPresetAssetRoot = path.join("assets", "tts", "preset");

export function createTtsPlugin(deps: TtsPluginDeps): TtsPlugin {
  const config = readTtsPluginConfig(deps.configPath);

  return {
    id: "tts",
    config,
    voiceSynthesizer: createTtsRoutingSynthesizer(deps)
  };
}

export function readTtsPluginConfig(configPath = defaultConfigPath): TtsPluginConfig {
  const resolved = resolveTtsConfigReadPath(configPath);
  const raw = resolved ? fs.readFileSync(resolved, "utf8") : "{}";
  const parsed = parseJsonObject(raw);
  const preset = parseJsonObject(parsed.api_preset);
  const remote = parseJsonObject(parsed.remote);
  const legacyPrompt = stringValue(parsed.prompt) || defaultPrompt();
  const translationPresetName = stringValue(parsed.translationPresetName) || "default";
  const translationPresets = ttsTranslationPresetsValue(parsed.translationPresets, translationPresetName, {
    translationEnabled: booleanValue(parsed.translationEnabled, true),
    apiPresetName: stringValue(parsed.apiPresetName) || stringValue(preset.name),
    prompt: legacyPrompt
  });
  const selectedTranslation = selectedTtsTranslationPreset({ translationPresetName, translationPresets });
  const voice = parseJsonObject(parsed.voice);
  const modelConfigName = stringValue(voice.modelConfigName) || ttsLanguageValue(voice.language);
  const modelConfigs = ttsModelConfigsValue(voice.modelConfigs, modelConfigName, {
    language: ttsLanguageValue(voice.language),
    speed: optionalNumberValue(voice.speed),
    partSilenceSeconds: optionalNumberValue(voice.partSilenceSeconds),
    splitText: voice.splitText === undefined ? undefined : booleanValue(voice.splitText, false),
    modelDir: stringValue(voice.modelDir),
    referenceAudio: stringValue(voice.referenceAudio),
    referenceText: stringValue(voice.referenceText)
  });
  return {
    enabled: booleanValue(parsed.enabled, false),
    remote: {
      enabled: booleanValue(remote.enabled, true),
      baseURL: normalizeBaseURL(stringValue(remote.baseURL) || "http://192.168.0.103:8767")
    },
    translationPresetName,
    translationPresets,
    translationEnabled: selectedTranslation.translationEnabled ?? true,
    apiPresetName: selectedTranslation.apiPresetName,
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
    prompt: selectedTranslation.prompt || legacyPrompt,
    voice: {
      modelConfigName,
      modelConfigs
    }
  };
}

function resolveTtsConfigReadPath(configPath = defaultConfigPath): string | undefined {
  const resolved = path.resolve(configPath);
  if (fs.existsSync(resolved)) return resolved;
  const defaultResolved = path.resolve(defaultConfigPath);
  const legacyTtsResolved = path.resolve(legacyTtsConfigPath);
  const legacyResolved = path.resolve(legacyConfigPath);
  if (resolved === defaultResolved && fs.existsSync(legacyTtsResolved)) return legacyTtsResolved;
  if (resolved === defaultResolved && fs.existsSync(legacyResolved)) return legacyResolved;
  const parsed = path.parse(resolved);
  const expectedSuffix = path.join("config", "plugin", "tts", "config.json");
  if (resolved.endsWith(expectedSuffix)) {
    const root = resolved.slice(0, -expectedSuffix.length);
    const siblingLegacyTts = path.join(root || parsed.root, "plugins", "tts", "config.json");
    if (fs.existsSync(siblingLegacyTts)) return siblingLegacyTts;
    const siblingLegacy = path.join(root || parsed.root, "plugins", "japanese-voice", "config.json");
    if (fs.existsSync(siblingLegacy)) return siblingLegacy;
  }
  return undefined;
}

function renderTtsPrompt(config: TtsPluginConfig, deps: TtsPluginDeps): string {
  const variables = typeof deps.promptVariables === "function" ? deps.promptVariables() : deps.promptVariables;
  return renderLLMText(config.prompt.trim(), variables ?? {});
}

export function createTtsTranslationSynthesizer(
  config: TtsPluginConfig,
  deps: TtsPluginDeps
): TtsSynthesizer {
  const base = deps.baseSynthesizer;
  const synthesize = (async (input) => {
    const ttsText = await resolveTtsText(input.text, config, deps);
    deps.appendLog?.("info", `tts synthesis start: chars=${Array.from(ttsText).length}`);
    const result = await base({
      ...input,
      text: ttsText,
      genie: ttsGenieOverrides(config)
    });
    deps.appendLog?.("info", `tts synthesis complete: asset=${result.assetId}`);
    return result;
  }) as TtsSynthesizer;

  synthesize.stream = (input) => streamTtsText(input, config, deps);
  synthesize.streamAudio = base.streamAudio?.bind(base);
  synthesize.streamAudioWithText = base.streamAudioWithText?.bind(base);
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

function createTtsRoutingSynthesizer(deps: TtsPluginDeps): TtsSynthesizer {
  const base = deps.baseSynthesizer;
  const synthesize = (async (input) => {
    const config = readTtsPluginConfig(deps.configPath);
    if (!config.enabled) return base(input);
    const ttsText = await resolveTtsText(input.text, config, deps);
    deps.appendLog?.("info", `tts synthesis start: chars=${Array.from(ttsText).length}`);
    const result = await base({
      ...input,
      text: ttsText,
      genie: ttsGenieOverrides(config)
    });
    deps.appendLog?.("info", `tts synthesis complete: asset=${result.assetId}`);
    return result;
  }) as TtsSynthesizer;

  synthesize.stream = (input) => {
    const config = readTtsPluginConfig(deps.configPath);
    return streamTtsText(input, config, deps);
  };
  synthesize.streamAudio = base.streamAudio?.bind(base);
  synthesize.streamAudioWithText = base.streamAudioWithText?.bind(base);
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

export function ttsGenieOverrides(config: TtsPluginConfig): NonNullable<Parameters<VoiceSynthesizer>[0]["genie"]> {
  const model = selectedTtsVoiceModelConfig(config);
  const modelPresetName = selectedTtsVoiceModelConfigName(config);
  const referenceTextPath = ttsPresetReferenceText(modelPresetName);
  return {
    language: model.language ?? "jp",
    modelDir: ttsPresetModelDir(modelPresetName),
    referenceAudio: ttsPresetReferenceAudio(modelPresetName),
    referenceText: fs.existsSync(referenceTextPath) ? ttsReferenceTextValue(referenceTextPath) : undefined,
    ...(model.speed !== undefined ? { speed: model.speed } : {}),
    ...(model.partSilenceSeconds !== undefined ? { partSilenceSeconds: model.partSilenceSeconds } : {}),
    splitText: model.splitText ?? false
  };
}

export function selectedTtsVoiceModelConfig(config: TtsPluginConfig): TtsVoiceModelConfig {
  const voice = config.voice ?? {};
  const modelConfigs = voice.modelConfigs ?? {};
  const selected = voice.modelConfigName ? modelConfigs[voice.modelConfigName] : undefined;
  return selected ?? modelConfigs[Object.keys(modelConfigs)[0] ?? ""] ?? { language: "jp" };
}

export function selectedTtsVoiceModelConfigName(config: TtsPluginConfig): string {
  const voice = config.voice ?? {};
  const modelConfigs = voice.modelConfigs ?? {};
  return voice.modelConfigName || Object.keys(modelConfigs)[0] || "jp";
}

export function selectedTtsTranslationPreset(config: Pick<TtsPluginConfig, "translationPresetName" | "translationPresets">): TtsTranslationPreset {
  const presets = config.translationPresets ?? {};
  const selected = config.translationPresetName ? presets[config.translationPresetName] : undefined;
  return selected ?? presets[Object.keys(presets)[0] ?? ""] ?? { translationEnabled: true, prompt: defaultPrompt() };
}

export async function resolveTtsText(text: string, config: TtsPluginConfig, deps: TtsPluginDeps): Promise<string> {
  if (!config.translationEnabled) {
    deps.appendLog?.("info", `tts translation skipped: disabled chars=${Array.from(text).length}`);
    return text;
  }
  const translated = await translateTtsText(text, config, deps);
  if (!translated) throw new Error("tts translation failed; no fallback configured");
  return translated;
}

export async function translateTtsText(text: string, config: TtsPluginConfig, deps: TtsPluginDeps): Promise<string | undefined> {
  const preset = resolveEffectivePreset(config, deps);
  const client = deps.llm ?? (preset ? createClientFromPreset(preset, deps.env ?? process.env) : undefined);
  if (!client) {
    deps.appendLog?.("warn", "tts translation skipped: missing api preset baseURL or api key");
    return undefined;
  }

  try {
    deps.appendLog?.("info", `tts translation start: chars=${Array.from(text).length}`);
    const legacyPreset = config.api_preset ?? { baseURL: "", model: "flash", temperature: 0.2, extraParams: {} };
    const request = {
      agentId: "tts",
      client,
      messages: [
        { role: "system" as const, content: renderTtsPrompt(config, deps) },
        { role: "user" as const, content: text }
      ],
      model: preset?.model ?? legacyPreset.model,
      temperature: preset?.temperature ?? legacyPreset.temperature,
      extraParams: preset?.extraParams ?? legacyPreset.extraParams,
      toolNames: [],
      round: 0,
      stream: false,
      metadata: { pluginId: "tts", route: "send_chat.voice.before_tts" }
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
      deps.appendLog?.("warn", "tts translation returned empty text");
      return undefined;
    }
    deps.appendLog?.("info", `tts translation complete: chars=${Array.from(translated).length}`);
    return translated;
  } catch (error) {
    deps.appendLog?.("warn", `tts translation failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export async function* streamTtsText(
  input: TtsStreamInput,
  config: TtsPluginConfig,
  deps: TtsPluginDeps
): AsyncIterable<TtsStreamChunk> {
  if (input.source !== "send_chat.voice") throw new Error("tts stream only supports send_chat.voice");
  if (!config.enabled) throw new Error("tts stream is disabled");
  if (!deps.baseSynthesizer.streamAudio && !deps.baseSynthesizer.streamAudioWithText) {
    throw new Error("tts stream requires a streaming Genie TTS synthesizer");
  }

  const sequence = 0;
  const sourceText = await collectTtsStreamText(input.text);
  const sourceChars = Array.from(sourceText).length;
  if (!sourceText.trim()) {
    deps.appendLog?.("info", `tts stream skipped: empty input stream=${input.streamId ?? ""}`);
    yield { type: "done" };
    return;
  }

  if (config.translationEnabled) {
    deps.appendLog?.("info", `tts stream translation start: stream=${input.streamId ?? ""} chars=${sourceChars}`);
    yield { type: "translation_started", sequence, sourceChars };
  }
  const ttsText = await resolveTtsText(sourceText, config, deps);
  const ttsChars = Array.from(ttsText).length;
  deps.appendLog?.("info", `tts stream text lengths: stream=${input.streamId ?? ""} sourceChars=${sourceChars} translatedChars=${ttsChars}`);
  if (config.translationEnabled) {
    deps.appendLog?.("info", `tts stream translation complete: stream=${input.streamId ?? ""} chars=${ttsChars}`);
    yield { type: "translation_done", sequence, translatedChars: ttsChars };
  }

  const { speed: _streamUnsupportedSpeed, partSilenceSeconds: _streamUnusedSilence, ...streamGenie } = ttsGenieOverrides(config);
  deps.appendLog?.("info", `tts stream tts start: stream=${input.streamId ?? ""} chars=${ttsChars}`);
  const sourceTextMapper = createTtsSourceTextMapper(sourceText, ttsText);
  let audioChunks = 0;
  let audioBytes = 0;
  for await (const audio of streamTtsAudioWithOptionalText(deps.baseSynthesizer, {
    text: ttsText,
    time: input.time,
    genie: streamGenie
  })) {
    audioChunks += 1;
    audioBytes += audio.chunk.byteLength;
    const text = audio.text ? sourceTextMapper.take(audio.text) : undefined;
    yield {
      type: "audio",
      sequence,
      ...(text ? { text } : {}),
      chunk: audio.chunk,
      contentType: "audio/L16; rate=32000; channels=1"
    };
  }
  deps.appendLog?.("info", `tts stream tts complete: stream=${input.streamId ?? ""} chunks=${audioChunks} bytes=${audioBytes}`);
  yield { type: "part_done", sequence };
  yield { type: "done" };
}

async function* streamTtsAudioWithOptionalText(
  synthesizer: VoiceSynthesizer,
  input: VoiceSynthesisInput
): AsyncIterable<TtsAudioTextChunk> {
  if (synthesizer.streamAudioWithText) {
    yield* synthesizer.streamAudioWithText(input);
    return;
  }
  if (!synthesizer.streamAudio) throw new Error("tts stream requires a streaming Genie TTS synthesizer");
  for await (const chunk of synthesizer.streamAudio(input)) yield { chunk };
}

function createTtsSourceTextMapper(sourceText: string, translatedText: string): { take(translatedChunkText: string): string | undefined } {
  const sourceChars = Array.from(sourceText);
  const translatedChars = Array.from(translatedText);
  const sourceTotal = sourceChars.length;
  const translatedTotal = translatedChars.length;
  const boundaries = sourceTextBoundaries(sourceChars);
  let translatedCursor = 0;
  let sourceCursor = 0;

  return {
    take(translatedChunkText: string): string | undefined {
      const translatedChunkChars = Array.from(translatedChunkText).length;
      if (sourceCursor >= sourceTotal || translatedChunkChars <= 0) return undefined;
      translatedCursor = Math.min(translatedTotal, translatedCursor + translatedChunkChars);
      const rawTarget = translatedTotal > 0
        ? Math.round((translatedCursor / translatedTotal) * sourceTotal)
        : sourceTotal;
      const target = translatedCursor >= translatedTotal
        ? sourceTotal
        : nearestSourceBoundary(rawTarget, sourceCursor, sourceTotal, boundaries);
      const end = Math.min(sourceTotal, Math.max(sourceCursor + 1, target));
      const text = sourceChars.slice(sourceCursor, end).join("").trim();
      sourceCursor = end;
      return text || undefined;
    }
  };
}

function sourceTextBoundaries(chars: string[]): number[] {
  const boundaries: number[] = [];
  chars.forEach((char, index) => {
    if (/[。！？.!?,，、；;：:\n]/.test(char)) boundaries.push(index + 1);
  });
  if (chars.length > 0 && boundaries[boundaries.length - 1] !== chars.length) boundaries.push(chars.length);
  return boundaries;
}

function nearestSourceBoundary(target: number, cursor: number, total: number, boundaries: number[]): number {
  const clamped = Math.min(total, Math.max(cursor + 1, target));
  const candidates = boundaries.filter((boundary) => boundary > cursor);
  if (!candidates.length) return clamped;
  let nearest = candidates[0]!;
  let nearestDistance = Math.abs(nearest - clamped);
  for (const boundary of candidates.slice(1)) {
    const distance = Math.abs(boundary - clamped);
    if (distance < nearestDistance) {
      nearest = boundary;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export async function collectTtsStreamText(text: AsyncIterable<string> | Iterable<string> | string): Promise<string> {
  let collected = "";
  for await (const chunk of iterateTextChunks(text)) {
    collected += chunk;
  }
  return collected.trim();
}

export async function* splitTtsStreamParts(
  text: AsyncIterable<string> | Iterable<string> | string,
  options: { minFlushChars?: number; maxFlushChars?: number; softBoundaryChars?: number } = {}
): AsyncIterable<string> {
  const minFlushChars = options.minFlushChars ?? 10;
  const maxFlushChars = options.maxFlushChars ?? 40;
  const softBoundaryChars = options.softBoundaryChars ?? 20;
  let pending = "";
  for await (const chunk of iterateTextChunks(text)) {
    pending += chunk;
    while (true) {
      const part = takeTtsStreamPart(pending, { minFlushChars, maxFlushChars, softBoundaryChars });
      if (!part) break;
      pending = pending.slice(part.length).trimStart();
      const normalized = part.trim();
      if (normalized) yield normalized;
    }
  }
  const remaining = pending.trim();
  if (remaining) yield remaining;
}

async function* iterateTextChunks(text: AsyncIterable<string> | Iterable<string> | string): AsyncIterable<string> {
  if (typeof text === "string") {
    yield text;
    return;
  }
  for await (const chunk of text as AsyncIterable<string>) {
    if (chunk) yield String(chunk);
  }
}

function takeTtsStreamPart(
  pending: string,
  options: { minFlushChars: number; maxFlushChars: number; softBoundaryChars: number }
): string | undefined {
  const chars = Array.from(pending);
  if (chars.length < options.minFlushChars) return undefined;
  for (let index = 0; index < pending.length; index += 1) {
    if (/[。！？.!?\n]/.test(pending[index]!)) {
      return pending.slice(0, index + 1);
    }
  }
  const hardLimit = Math.min(chars.length, options.maxFlushChars);
  for (let index = 0, seen = 0; index < pending.length; index += 1) {
    const char = pending[index]!;
    seen += 1;
    if (seen >= options.softBoundaryChars && /[。！？.!?\n]/.test(char)) {
      return pending.slice(0, index + 1);
    }
    if (seen >= hardLimit) {
      return pending.slice(0, index + 1);
    }
  }
  return undefined;
}

function resolveEffectivePreset(config: TtsPluginConfig, deps: TtsPluginDeps): TtsApiPreset | undefined {
  if (config.apiPresetName) return deps.resolveApiPreset?.(config.apiPresetName) ?? config.api_preset;
  return config.api_preset;
}

function createClientFromPreset(preset: TtsApiPreset, env: Record<string, string | undefined>): LLMClient | undefined {
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

function ttsLanguageValue(value: unknown): "jp" | "zh" | "en" {
  return value === "zh" || value === "en" ? value : "jp";
}

function ttsTranslationPresetsValue(value: unknown, fallbackName: string, fallback: TtsTranslationPreset): Record<string, TtsTranslationPreset> {
  const raw = parseJsonObject(value);
  const entries = Object.fromEntries(Object.entries(raw)
    .map(([name, entry]) => [safeModelConfigName(name), ttsTranslationPresetValue(entry)])
    .filter(([name]) => Boolean(name))) as Record<string, TtsTranslationPreset>;
  if (Object.keys(entries).length > 0) return entries;
  return { [safeModelConfigName(fallbackName) || "default"]: fallback };
}

function ttsTranslationPresetValue(value: unknown): TtsTranslationPreset {
  const raw = parseJsonObject(value);
  return {
    translationEnabled: raw.translationEnabled === undefined ? undefined : booleanValue(raw.translationEnabled, true),
    apiPresetName: stringValue(raw.apiPresetName),
    prompt: stringValue(raw.prompt)
  };
}

function ttsModelConfigsValue(value: unknown, fallbackName: string, fallback: TtsVoiceModelConfig): Record<string, TtsVoiceModelConfig> {
  const raw = parseJsonObject(value);
  const entries = Object.fromEntries(Object.entries(raw)
    .map(([name, entry]) => [safeModelConfigName(name), ttsVoiceModelConfigValue(entry)])
    .filter(([name]) => Boolean(name))) as Record<string, TtsVoiceModelConfig>;
  if (Object.keys(entries).length > 0) return entries;
  return { [safeModelConfigName(fallbackName) || "jp"]: fallback };
}

function ttsVoiceModelConfigValue(value: unknown): TtsVoiceModelConfig {
  const raw = parseJsonObject(value);
  return {
    language: ttsLanguageValue(raw.language),
    speed: optionalNumberValue(raw.speed),
    partSilenceSeconds: optionalNumberValue(raw.partSilenceSeconds),
    splitText: raw.splitText === undefined ? undefined : booleanValue(raw.splitText, false),
    modelDir: stringValue(raw.modelDir),
    referenceAudio: stringValue(raw.referenceAudio),
    referenceText: stringValue(raw.referenceText)
  };
}

function safeModelConfigName(value: string): string {
  return value.trim().replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

function ttsReferenceTextValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const filePath = resolveAssetScopedPath(value);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    // Treat it as literal reference text below.
  }
  return value;
}

function requireGenieReferenceText(value: string | undefined, message: string): string {
  const text = ttsReferenceTextValue(value)?.trim();
  if (!text) throw new Error(message);
  return text;
}

function ttsPresetModelDir(name: string): string {
  return path.join(ttsPresetAssetRoot, safeModelConfigName(name) || "jp", "model").split(path.sep).join("/");
}

function ttsPresetReferenceText(name: string): string {
  return path.join(ttsPresetAssetRoot, safeModelConfigName(name) || "jp", "reference.txt").split(path.sep).join("/");
}

function ttsPresetReferenceAudio(name: string): string | undefined {
  const root = path.join(ttsPresetAssetRoot, safeModelConfigName(name) || "jp");
  for (const candidate of ["reference.wav", "reference.mp3", "reference.ogg", "reference.opus", "reference.m4a"]) {
    const filePath = path.join(root, candidate);
    if (fs.existsSync(filePath)) return filePath.split(path.sep).join("/");
  }
  try {
    const match = fs.readdirSync(root).find((entry) => /^reference\.[\w-]+$/i.test(entry));
    return match ? path.join(root, match).split(path.sep).join("/") : undefined;
  } catch {
    return undefined;
  }
}

export type JapaneseVoiceApiPreset = TtsApiPreset;
export type JapaneseVoicePluginConfig = TtsPluginConfig;
export type JapaneseVoicePluginDeps = TtsPluginDeps;
export type JapaneseVoicePlugin = TtsPlugin;
export type JapaneseVoiceStreamInput = TtsStreamInput;
export type JapaneseVoiceStreamChunk = TtsStreamChunk;
export type JapaneseVoiceSynthesizer = TtsSynthesizer;
export const createJapaneseVoicePlugin = createTtsPlugin;
export const readJapaneseVoicePluginConfig = readTtsPluginConfig;
export const createJapaneseVoiceTranslationSynthesizer = createTtsTranslationSynthesizer;
export const japaneseVoiceGenieOverrides = ttsGenieOverrides;
export const resolveJapaneseVoiceTtsText = resolveTtsText;
export const translateJapaneseVoiceText = translateTtsText;
export const streamJapaneseVoiceText = streamTtsText;
export const collectJapaneseVoiceStreamText = collectTtsStreamText;
export const splitJapaneseVoiceStreamParts = splitTtsStreamParts;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseURL(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const hasScheme = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed);
  const candidate = hasScheme ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!hasScheme && !parsed.port) parsed.port = "8767";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

function zipDirectoryToBuffer(rootDir: string): Uint8Array {
  const root = path.resolve(rootDir);
  const files = listZipFiles(root);
  if (!files.length) throw new Error(`Genie TTS model directory has no files to upload: ${root}`);
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const filePath of files) {
    const relativeName = path.relative(root, filePath).split(path.sep).join("/");
    const name = new TextEncoder().encode(relativeName);
    const data = fs.readFileSync(filePath);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    writeZipUint32(local, 0, 0x04034b50);
    writeZipUint16(local, 4, 20);
    writeZipUint16(local, 6, 0x0800);
    writeZipUint16(local, 8, 0);
    writeZipUint16(local, 10, 0);
    writeZipUint16(local, 12, 0);
    writeZipUint32(local, 14, crc);
    writeZipUint32(local, 18, data.length);
    writeZipUint32(local, 22, data.length);
    writeZipUint16(local, 26, name.length);
    writeZipUint16(local, 28, 0);
    local.set(name, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + name.length);
    writeZipUint32(central, 0, 0x02014b50);
    writeZipUint16(central, 4, 20);
    writeZipUint16(central, 6, 20);
    writeZipUint16(central, 8, 0x0800);
    writeZipUint16(central, 10, 0);
    writeZipUint16(central, 12, 0);
    writeZipUint16(central, 14, 0);
    writeZipUint32(central, 16, crc);
    writeZipUint32(central, 20, data.length);
    writeZipUint32(central, 24, data.length);
    writeZipUint16(central, 28, name.length);
    writeZipUint16(central, 30, 0);
    writeZipUint16(central, 32, 0);
    writeZipUint16(central, 34, 0);
    writeZipUint16(central, 36, 0);
    writeZipUint32(central, 38, 0);
    writeZipUint32(central, 42, offset);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const centralDirectory = concatUint8Arrays(centralParts);
  const end = new Uint8Array(22);
  writeZipUint32(end, 0, 0x06054b50);
  writeZipUint16(end, 4, 0);
  writeZipUint16(end, 6, 0);
  writeZipUint16(end, 8, files.length);
  writeZipUint16(end, 10, files.length);
  writeZipUint32(end, 12, centralDirectory.length);
  writeZipUint32(end, 16, offset);
  writeZipUint16(end, 20, 0);
  return concatUint8Arrays([...localParts, centralDirectory, end]);
}

function listZipFiles(root: string): string[] {
  const result: string[] = [];
  for (const name of fs.readdirSync(root)) {
    const fullPath = path.join(root, name);
    const stats = fs.statSync(fullPath) as { isDirectory?(): boolean; isFile(): boolean };
    if (stats.isDirectory?.()) {
      result.push(...listZipFiles(fullPath));
    } else if (stats.isFile()) {
      result.push(fullPath);
    }
  }
  return result.sort();
}

function writeZipUint16(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint16(offset, value, true);
}

function writeZipUint32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value >>> 0, true);
}

const crc32Table = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc = crc32Table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}


export type ConfiguredVoiceSynthesizerDeps = MossOnnxVoiceSynthesizerDeps;

export function createConfiguredVoiceSynthesizer(input?: TTSConfig, deps: ConfiguredVoiceSynthesizerDeps = {}): VoiceSynthesizer {
  const config = input ?? { backend: "genie-tts" as const };
  const disableMoss = Boolean(
    process.env.DISABLE_MOSS_TTS === "1" ||
    String(process.env.DISABLE_MOSS_TTS || "").toLowerCase() === "true" ||
    Boolean((input as any)?.disableMoss)
  );
  let moss: VoiceSynthesizer | undefined = undefined;
  if (!disableMoss) {
    moss = createMossOnnxVoiceSynthesizer({ ...config, backend: "moss-onnx" }, deps);
    if (config.backend === "moss-onnx") return moss;
  } else {
    if (config.backend === "moss-onnx") {
      throw new Error("MOSS TTS is disabled by DISABLE_MOSS_TTS");
    }
  }
  const genieReadinessError = getGenieReadinessError(config);
  if (genieReadinessError) {
    deps.appendLog?.("warn", `genie tts unavailable; falling back to moss: ${genieReadinessError}`);
    if (disableMoss) {
      throw new Error(`Genie TTS unavailable and MOSS is disabled: ${genieReadinessError}`);
    }
    if (!moss) {
      moss = createMossOnnxVoiceSynthesizer({ ...config, backend: "moss-onnx" }, deps);
    }
    return moss as VoiceSynthesizer;
  }
  const genie = createGenieTtsVoiceSynthesizer(config, deps);
  const fallbackMoss = moss;
  let genieHasSynthesized = false;
  let useMossFallback = false;
  const synthesize = (async (request) => {
    if (useMossFallback) return fallbackMoss?.(request) ?? Promise.reject(new Error("MOSS TTS is disabled"));
    try {
      const result = await genie(request);
      genieHasSynthesized = true;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!genieHasSynthesized && isGenieStartupFallbackError(message)) {
        useMossFallback = true;
        deps.appendLog?.("warn", `genie tts startup failed; falling back to moss: ${message}`);
        return fallbackMoss?.(request) ?? Promise.reject(new Error("MOSS TTS is disabled"));
      }
      throw error;
    }
  }) as VoiceSynthesizer;
  synthesize.noteActivity = () => {
    if (!useMossFallback) genie.noteActivity?.();
    fallbackMoss?.noteActivity?.();
  };
  synthesize.streamAudio = async function* (request) {
    if (useMossFallback || !genie.streamAudio) {
      throw new Error("Genie TTS stream is unavailable while using MOSS fallback");
    }
    try {
      yield* genie.streamAudio(request);
      genieHasSynthesized = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!genieHasSynthesized && isGenieStartupFallbackError(message)) {
        useMossFallback = true;
        deps.appendLog?.("warn", `genie tts stream failed; falling back to moss for non-stream synthesis: ${message}`);
      }
      throw error;
    }
  };
  synthesize.streamAudioWithText = async function* (request) {
    if (useMossFallback || !genie.streamAudioWithText) {
      throw new Error("Genie TTS text stream is unavailable while using MOSS fallback");
    }
    try {
      yield* genie.streamAudioWithText(request);
      genieHasSynthesized = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!genieHasSynthesized && isGenieStartupFallbackError(message)) {
        useMossFallback = true;
        deps.appendLog?.("warn", `genie tts text stream failed; falling back to moss for non-stream synthesis: ${message}`);
      }
      throw error;
    }
  };
  synthesize.prepare = async () => {
    if (useMossFallback) {
      await fallbackMoss?.prepare?.();
      return;
    }
    try {
      await genie.prepare?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isGenieStartupFallbackError(message)) {
        useMossFallback = true;
        deps.appendLog?.("warn", `genie tts prepare failed; falling back to moss: ${message}`);
        await fallbackMoss?.prepare?.();
        return;
      }
      throw error;
    }
  };
  synthesize.shutdown = async () => {
    await genie.shutdown?.();
    await fallbackMoss?.shutdown?.();
  };
  return synthesize;
}

export function createTtsRemoteAwareVoiceSynthesizer(
  input: TTSConfig & { ttsConfigPath?: string },
  deps: ConfiguredVoiceSynthesizerDeps = {}
): VoiceSynthesizer {
  const local = createGenieTtsVoiceSynthesizer({
    ...input,
    backend: "genie-tts",
    genieBaseURL: undefined,
    genieBaseURLExplicit: false,
    genieUseStreamForSynthesis: true
  }, deps);
  const remotes = new Map<string, VoiceSynthesizer>();

  const remoteFor = (baseURL: string): VoiceSynthesizer => {
    const normalized = normalizeBaseURL(baseURL);
    const existing = remotes.get(normalized);
    if (existing) return existing;
    const remote = createGenieTtsVoiceSynthesizer({
      ...input,
      backend: "genie-tts",
      genieBaseURL: normalized,
      genieBaseURLExplicit: true,
      genieIdleShutdownMs: 0,
      genieUseStreamForSynthesis: true
    }, deps);
    remotes.set(normalized, remote);
    return remote;
  };

  const selectedRemote = (): VoiceSynthesizer | undefined => {
    const pluginConfig = readTtsPluginConfig(input.ttsConfigPath);
    if (!pluginConfig.remote?.enabled) return undefined;
    const baseURL = normalizeBaseURL(pluginConfig.remote.baseURL || "");
    return baseURL ? remoteFor(baseURL) : undefined;
  };

  const synthesize = (async (request) => {
    const remote = selectedRemote();
    if (!remote) return local(request);
    try {
      return await remote(request);
    } catch (error) {
      if (isRemoteGenieProtocolError(error)) throw error;
      deps.appendLog?.("warn", `tts remote Genie failed; falling back to local Genie: ${error instanceof Error ? error.message : String(error)}`);
      return local(request);
    }
  }) as VoiceSynthesizer;

  synthesize.streamAudio = async function* (request) {
    const remote = selectedRemote();
    if (!remote?.streamAudio) {
      deps.appendLog?.("info", "tts remote-aware stream using local Genie: remote unavailable");
      if (!local.streamAudio) throw new Error("Local Genie TTS stream is unavailable");
      yield* local.streamAudio(request);
      return;
    }
    let yielded = false;
    try {
      deps.appendLog?.("info", `tts remote-aware stream using remote Genie: chars=${Array.from(request.text).length}`);
      for await (const chunk of remote.streamAudio(request)) {
        yielded = true;
        yield chunk;
      }
      deps.appendLog?.("info", "tts remote-aware stream remote complete");
    } catch (error) {
      if (yielded) throw error;
      if (isRemoteGenieProtocolError(error)) throw error;
      deps.appendLog?.("warn", `tts remote Genie stream failed before audio; falling back to local Genie: ${error instanceof Error ? error.message : String(error)}`);
      if (!local.streamAudio) throw new Error("Local Genie TTS stream is unavailable");
      yield* local.streamAudio(request);
    }
  };
  synthesize.streamAudioWithText = async function* (request) {
    const remote = selectedRemote();
    if (!remote?.streamAudioWithText) {
      deps.appendLog?.("info", "tts remote-aware text stream using local Genie: remote unavailable");
      if (local.streamAudioWithText) {
        yield* local.streamAudioWithText(request);
        return;
      }
      if (!local.streamAudio) throw new Error("Local Genie TTS stream is unavailable");
      for await (const chunk of local.streamAudio(request)) yield { chunk };
      return;
    }
    let yielded = false;
    try {
      deps.appendLog?.("info", `tts remote-aware text stream using remote Genie: chars=${Array.from(request.text).length}`);
      for await (const chunk of remote.streamAudioWithText(request)) {
        yielded = true;
        yield chunk;
      }
      deps.appendLog?.("info", "tts remote-aware text stream remote complete");
    } catch (error) {
      if (yielded) throw error;
      if (isRemoteGenieProtocolError(error)) throw error;
      deps.appendLog?.("warn", `tts remote Genie text stream failed before audio; falling back to local Genie: ${error instanceof Error ? error.message : String(error)}`);
      if (local.streamAudioWithText) {
        yield* local.streamAudioWithText(request);
        return;
      }
      if (!local.streamAudio) throw new Error("Local Genie TTS stream is unavailable");
      for await (const chunk of local.streamAudio(request)) yield { chunk };
    }
  };
  synthesize.noteActivity = () => {
    selectedRemote()?.noteActivity?.();
    local.noteActivity?.();
  };
  synthesize.prepare = async () => {
    const remote = selectedRemote();
    if (remote) {
      try {
        await remote.prepare?.();
        return;
      } catch (error) {
        deps.appendLog?.("warn", `tts remote Genie prepare failed; falling back to local Genie: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await local.prepare?.();
  };
  synthesize.shutdown = async () => {
    await Promise.all([...remotes.values()].map((remote) => remote.shutdown?.()));
    await local.shutdown?.();
  };
  return synthesize;
}

export function createFallbackVoiceSynthesizer(
  primary: VoiceSynthesizer,
  fallback: VoiceSynthesizer,
  deps: FallbackVoiceSynthesizerDeps = {}
): VoiceSynthesizer {
  let useFallback = false;
  const synthesize = (async (request) => {
    if (useFallback) return fallback(request);
    try {
      return await primary(request);
    } catch (error) {
      useFallback = true;
      deps.appendLog?.("warn", `voice tts primary failed; falling back to local Genie: ${error instanceof Error ? error.message : String(error)}`);
      return fallback(request);
    }
  }) as VoiceSynthesizer;
  synthesize.streamAudio = async function* (request) {
    if (useFallback) {
      if (!fallback.streamAudio) throw new Error("Fallback voice TTS stream is unavailable");
      yield* fallback.streamAudio(request);
      return;
    }
    if (!primary.streamAudio) {
      useFallback = true;
      deps.appendLog?.("warn", "voice tts primary stream unavailable; falling back to local Genie");
      if (!fallback.streamAudio) throw new Error("Fallback voice TTS stream is unavailable");
      yield* fallback.streamAudio(request);
      return;
    }
    let yielded = false;
    try {
      for await (const chunk of primary.streamAudio(request)) {
        yielded = true;
        yield chunk;
      }
    } catch (error) {
      if (yielded) throw error;
      useFallback = true;
      deps.appendLog?.("warn", `voice tts primary stream failed before audio; falling back to local Genie: ${error instanceof Error ? error.message : String(error)}`);
      if (!fallback.streamAudio) throw new Error("Fallback voice TTS stream is unavailable");
      yield* fallback.streamAudio(request);
    }
  };
  synthesize.streamAudioWithText = async function* (request) {
    if (useFallback) {
      if (fallback.streamAudioWithText) {
        yield* fallback.streamAudioWithText(request);
        return;
      }
      if (!fallback.streamAudio) throw new Error("Fallback voice TTS stream is unavailable");
      for await (const chunk of fallback.streamAudio(request)) yield { chunk };
      return;
    }
    const primaryStream = primary.streamAudioWithText ?? (primary.streamAudio
      ? async function* (input: VoiceSynthesisInput) {
        for await (const chunk of primary.streamAudio!(input)) yield { chunk };
      }
      : undefined);
    if (!primaryStream) {
      useFallback = true;
      deps.appendLog?.("warn", "voice tts primary text stream unavailable; falling back to local Genie");
      if (fallback.streamAudioWithText) {
        yield* fallback.streamAudioWithText(request);
        return;
      }
      if (!fallback.streamAudio) throw new Error("Fallback voice TTS stream is unavailable");
      for await (const chunk of fallback.streamAudio(request)) yield { chunk };
      return;
    }
    let yielded = false;
    try {
      for await (const chunk of primaryStream(request)) {
        yielded = true;
        yield chunk;
      }
    } catch (error) {
      if (yielded) throw error;
      useFallback = true;
      deps.appendLog?.("warn", `voice tts primary text stream failed before audio; falling back to local Genie: ${error instanceof Error ? error.message : String(error)}`);
      if (fallback.streamAudioWithText) {
        yield* fallback.streamAudioWithText(request);
        return;
      }
      if (!fallback.streamAudio) throw new Error("Fallback voice TTS stream is unavailable");
      for await (const chunk of fallback.streamAudio(request)) yield { chunk };
    }
  };
  synthesize.noteActivity = () => {
    primary.noteActivity?.();
    fallback.noteActivity?.();
  };
  synthesize.prepare = async () => {
    if (useFallback) {
      await fallback.prepare?.();
      return;
    }
    try {
      await primary.prepare?.();
    } catch (error) {
      useFallback = true;
      deps.appendLog?.("warn", `voice tts primary prepare failed; falling back to local Genie: ${error instanceof Error ? error.message : String(error)}`);
      await fallback.prepare?.();
    }
  };
  synthesize.shutdown = async () => {
    await primary.shutdown?.();
    await fallback.shutdown?.();
  };
  return synthesize;
}

function getGenieReadinessError(input: TTSConfig): string | undefined {
  if (input.genieBaseURLExplicit) return undefined;
  const dataDir = input.genieDataDir ?? "assets/tts/genie/GenieData";
  const modelDir = input.genieModelDir ?? "assets/tts/genie/models/alice";
  const referenceAudio = input.genieReferenceAudio ?? input.mossReferenceAudio ?? "assets/tts/references/alice/reference.wav";
  const referenceText = input.genieReferenceText ?? referenceTextPath(referenceAudio);
  const modelPath = resolveAssetScopedPath(modelDir);
  try {
    requireAssetDirectory(dataDir, "Genie TTS data directory was not found");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!fs.existsSync(modelPath)) return `Genie model directory was not found: ${modelPath}`;
  if (!containsFileWithExtension(modelPath, ".onnx")) return `Genie model directory has no ONNX files: ${modelPath}`;
  try {
    requireAssetPath(referenceAudio, "Genie TTS reference audio was not found");
    requireGenieReferenceText(referenceText, "Genie TTS reference text was not found");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

function containsFileWithExtension(dir: string, extension: string): boolean {
  try {
    for (const name of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && path.extname(name).toLowerCase() === extension) return true;
      if (!stat.isFile() && containsFileWithExtension(fullPath, extension)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function referenceTextPath(referenceAudio: string): string {
  return referenceAudio.replace(/\.[^./\\]+$/, "") + ".txt";
}

function isGenieStartupFallbackError(message: string): boolean {
  return /load|reference|not healthy|did not become healthy|exited before ready|model directory|reference text|reference audio/i.test(message);
}

export type MossOnnxVoiceSynthesizerDeps = {
  appendLog?(level: "info" | "warn" | "error", message: string): void;
  spawn?: typeof childProcess.spawn;
  fetch?: typeof fetch;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export function createMossOnnxVoiceSynthesizer(input: TTSConfig, deps: MossOnnxVoiceSynthesizerDeps = {}): VoiceSynthesizer {
  const fetchImpl = deps.fetch ?? fetch;
  const spawnImpl = deps.spawn ?? childProcess.spawn;
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  const config = {
    baseURL: (input.mossBaseURL ?? `http://${input.mossHost ?? "127.0.0.1"}:${input.mossPort ?? 8765}`).replace(/\/+$/, ""),
    baseURLExplicit: input.mossBaseURLExplicit ?? Boolean(input.mossBaseURL),
    host: input.mossHost ?? "127.0.0.1",
    port: input.mossPort ?? 8765,
    pythonCommand: input.mossPythonCommand ?? ".conda-moss/bin/python",
    serviceScript: input.mossServiceScript ?? "scripts/moss_tts_onnx/service.py",
    modelDir: input.mossModelDir ?? "assets/tts/moss-onnx/models",
    referenceAudio: input.mossReferenceAudio ?? "assets/tts/references/alice/reference.wav",
    outputDir: input.mossOutputDir ?? "assets/generated/tts",
    timeoutMs: input.mossTimeoutMs ?? 120_000,
    idleShutdownMs: input.mossIdleShutdownMs ?? 15 * 60 * 1000,
    ffmpegCommand: input.mossFfmpegCommand ?? "ffmpeg-static",
    voiceCloneMaxTextTokens: input.mossVoiceCloneMaxTextTokens ?? 75
  };
  let ownedProcess: ReturnType<typeof childProcess.spawn> | undefined;
  let starting: Promise<void> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const synthesize = (async (request) => {
    const { text, time } = request;
    noteActivity();
    const outputDir = resolveAssetOutputDir(config.outputDir);
    fs.mkdirSync(outputDir.fullPath, { recursive: true });
    const baseName = uniqueVoiceBaseName(outputDir.fullPath, time.now().iso);
    const wavPath = path.resolve(outputDir.fullPath, `${baseName}.wav`);
    const opusPath = path.resolve(outputDir.fullPath, `${baseName}.opus`);
    const opusAssetId = path.join(outputDir.relativePath, `${baseName}.opus`);
    const referenceAudio = requireAssetPath(config.referenceAudio, "MOSS TTS reference audio was not found");
    await ensureMossService();
    try {
      const response = await postJson(`${config.baseURL}/synthesize`, {
        text,
        referenceAudioPath: referenceAudio,
        outputPath: wavPath,
        voiceCloneMaxTextTokens: config.voiceCloneMaxTextTokens
      }, config.timeoutMs, fetchImpl);
      if (!isRecord(response) || response.ok === false) {
        throw new Error(isRecord(response) ? optionalStringValue(response.error) || "MOSS TTS synthesize failed" : "MOSS TTS synthesize failed");
      }
      validateGeneratedVoice(wavPath, outputDir.fullPath);
      await validateVoiceLoudness(wavPath, config.ffmpegCommand, spawnImpl);
      await convertWavToOpus(wavPath, opusPath, config.ffmpegCommand, spawnImpl);
      validateGeneratedVoice(opusPath, outputDir.fullPath);
      await validateVoiceLoudness(opusPath, config.ffmpegCommand, spawnImpl);
      noteActivity();
      return { assetId: opusAssetId, filePath: opusPath };
    } finally {
      await removeGeneratedVoice(wavPath);
    }
  }) as VoiceSynthesizer;

  synthesize.noteActivity = noteActivity;
  synthesize.prepare = async () => {
    noteActivity();
    await ensureMossService();
  };
  synthesize.shutdown = shutdownOwnedService;
  return synthesize;

  function noteActivity(): void {
    if (idleTimer) clearTimer(idleTimer);
    if (config.idleShutdownMs <= 0) return;
    idleTimer = setTimer(() => {
      idleTimer = undefined;
      shutdownOwnedService().catch((error) => {
        deps.appendLog?.("warn", `moss tts idle shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, config.idleShutdownMs);
    idleTimer.unref?.();
  }

  async function ensureMossService(): Promise<void> {
    if (await isHealthy()) {
      return;
    }
    if (config.baseURLExplicit) {
      throw new Error(`MOSS TTS service is not healthy at ${config.baseURL}; custom MOSS_TTS_BASE_URL disables local auto-start`);
    }
    if (starting) {
      await starting;
      return;
    }
    starting = startOwnedService().finally(() => {
      starting = undefined;
    });
    await starting;
  }

  async function startOwnedService(): Promise<void> {
    const scriptPath = path.resolve(config.serviceScript);
    if (!fs.existsSync(scriptPath)) throw new Error(`MOSS TTS service script was not found: ${scriptPath}`);
    const modelDir = requireAssetPath(config.modelDir, "MOSS TTS model directory was not found");
    const outputDir = resolveAssetOutputDir(config.outputDir);
    fs.mkdirSync(outputDir.fullPath, { recursive: true });
    deps.appendLog?.("info", `moss tts service starting: ${config.pythonCommand} ${scriptPath}`);
    ownedProcess = spawnImpl(config.pythonCommand, [
      scriptPath,
      "--host", config.host,
      "--port", String(config.port),
      "--model-dir", modelDir,
      "--output-dir", outputDir.fullPath
    ], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    ownedProcess.stdout?.on("data", (chunk: Buffer) => deps.appendLog?.("info", `moss tts: ${String(chunk).trim()}`));
    ownedProcess.stderr?.on("data", (chunk: Buffer) => deps.appendLog?.("warn", `moss tts: ${String(chunk).trim()}`));
    ownedProcess.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      deps.appendLog?.("info", `moss tts service exited: code=${code ?? ""} signal=${signal ?? ""}`);
      ownedProcess = undefined;
    });
    await waitForHealthy();
  }

  async function waitForHealthy(): Promise<void> {
    const deadline = Date.now() + config.timeoutMs;
    let lastError = "not ready";
    while (Date.now() < deadline) {
      if (ownedProcess?.exitCode !== null && ownedProcess?.exitCode !== undefined) {
        throw new Error(`MOSS TTS service exited before ready: ${ownedProcess.exitCode}`);
      }
      try {
        if (await isHealthy()) return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await delay(500);
    }
    throw new Error(`MOSS TTS service did not become healthy: ${lastError}`);
  }

  async function isHealthy(): Promise<boolean> {
    try {
      const response = await fetchImpl(`${config.baseURL}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(2_000, config.timeoutMs))
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function shutdownOwnedService(): Promise<void> {
    if (idleTimer) {
      clearTimer(idleTimer);
      idleTimer = undefined;
    }
    if (!ownedProcess) return;
    const processToStop = ownedProcess;
    ownedProcess = undefined;
    try {
      await postJson(`${config.baseURL}/shutdown`, {}, 2_000, fetchImpl);
    } catch {
      processToStop.kill("SIGTERM");
    }
  }
}

export function createGenieTtsVoiceSynthesizer(input: TTSConfig, deps: MossOnnxVoiceSynthesizerDeps = {}): VoiceSynthesizer {
  const fetchImpl = deps.fetch ?? fetch;
  const spawnImpl = deps.spawn ?? childProcess.spawn;
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  const referenceAudioConfig = input.genieReferenceAudio ?? input.mossReferenceAudio ?? "assets/tts/references/alice/reference.wav";
  const config = {
    baseURL: (input.genieBaseURL ?? `http://${input.genieHost ?? "127.0.0.1"}:${input.geniePort ?? 8767}`).replace(/\/+$/, ""),
    baseURLExplicit: input.genieBaseURLExplicit ?? Boolean(input.genieBaseURL),
    host: input.genieHost ?? "127.0.0.1",
    port: input.geniePort ?? 8767,
    pythonCommand: input.geniePythonCommand ?? input.mossPythonCommand ?? ".conda-moss/bin/python",
    serviceScript: input.genieServiceScript ?? "scripts/genie_tts/service.py",
    dataDir: input.genieDataDir ?? "assets/tts/genie/GenieData",
    modelDir: input.genieModelDir ?? "assets/tts/genie/models/alice",
    characterName: input.genieCharacterName ?? "alice",
    language: input.genieLanguage ?? "zh",
    referenceAudio: referenceAudioConfig,
    referenceText: input.genieReferenceText ?? referenceTextPath(referenceAudioConfig),
    outputDir: input.genieOutputDir ?? input.mossOutputDir ?? "assets/generated/tts",
    timeoutMs: input.genieTimeoutMs ?? input.mossTimeoutMs ?? 120_000,
    idleShutdownMs: input.genieIdleShutdownMs ?? input.mossIdleShutdownMs ?? 15 * 60 * 1000,
    ffmpegCommand: input.genieFfmpegCommand ?? input.mossFfmpegCommand ?? "ffmpeg-static",
    useStreamForSynthesis: input.genieUseStreamForSynthesis ?? false
  };
  let ownedProcess: ReturnType<typeof childProcess.spawn> | undefined;
  let starting: Promise<void> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const synthesize = (async (request) => {
    const { text, time } = request;
    noteActivity();
    const outputDir = resolveAssetOutputDir(config.outputDir);
    fs.mkdirSync(outputDir.fullPath, { recursive: true });
    const baseName = uniqueVoiceBaseName(outputDir.fullPath, time.now().iso);
    const wavPath = path.resolve(outputDir.fullPath, `${baseName}.wav`);
    const speedAdjustedWavPath = path.resolve(outputDir.fullPath, `${baseName}.speed.wav`);
    const opusPath = path.resolve(outputDir.fullPath, `${baseName}.opus`);
    const opusAssetId = path.join(outputDir.relativePath, `${baseName}.opus`);
    const speed = genieSpeedValue(request.genie?.speed);
    await ensureGenieService();
    try {
      if (config.useStreamForSynthesis) {
        deps.appendLog?.("info", `genie tts synthesize via stream start: url=${config.baseURL}/${config.baseURLExplicit ? "stream-input" : "stream"} chars=${Array.from(text).length}`);
        const pcm = await collectGenieStreamPcm({
          text,
          genie: request.genie,
          baseURL: config.baseURL,
          useClientUploadFlow: config.baseURLExplicit,
          timeoutMs: config.timeoutMs,
          fetchImpl,
          setTimer,
          clearTimer,
          appendLog: deps.appendLog,
          onChunk: noteActivity
        });
        deps.appendLog?.("info", `genie tts synthesize via stream complete: bytes=${pcm.byteLength}`);
        writePcmL16Wav(wavPath, pcm, 32_000, 1);
        validateGeneratedVoice(wavPath, outputDir.fullPath);
        const conversionWavPath = speed === 1 ? wavPath : speedAdjustedWavPath;
        if (speed !== 1) {
          await changeAudioTempo(wavPath, speedAdjustedWavPath, speed, config.ffmpegCommand, spawnImpl);
          validateGeneratedVoice(speedAdjustedWavPath, outputDir.fullPath);
        }
        await validateVoiceLoudness(conversionWavPath, config.ffmpegCommand, spawnImpl);
        await convertWavToOpus(conversionWavPath, opusPath, config.ffmpegCommand, spawnImpl);
        validateGeneratedVoice(opusPath, outputDir.fullPath);
        await validateVoiceLoudness(opusPath, config.ffmpegCommand, spawnImpl);
        noteActivity();
        return { assetId: opusAssetId, filePath: opusPath };
      }
      const requestBody = {
        text,
        outputPath: wavPath,
        ...genieRequestOverrides(request.genie, deps.appendLog)
      };
      let response: unknown;
      try {
        response = await postJson(`${config.baseURL}/synthesize`, requestBody, config.timeoutMs, fetchImpl, "Genie TTS");
      } catch (error) {
        if (!isAbortLikeError(error)) throw error;
        deps.appendLog?.("warn", `genie tts synthesize timed out waiting for HTTP response; waiting for generated file: ${error instanceof Error ? error.message : String(error)}`);
        response = await waitForGeneratedVoiceAfterAbort(wavPath, outputDir.fullPath, config.timeoutMs);
      }
      if (!isRecord(response) || response.ok === false) {
        throw new Error(isRecord(response) ? optionalStringValue(response.error) || "Genie TTS synthesize failed" : "Genie TTS synthesize failed");
      }
      validateGeneratedVoice(wavPath, outputDir.fullPath);
      const conversionWavPath = speed === 1 ? wavPath : speedAdjustedWavPath;
      if (speed !== 1) {
        await changeAudioTempo(wavPath, speedAdjustedWavPath, speed, config.ffmpegCommand, spawnImpl);
        validateGeneratedVoice(speedAdjustedWavPath, outputDir.fullPath);
      }
      await validateVoiceLoudness(conversionWavPath, config.ffmpegCommand, spawnImpl);
      await convertWavToOpus(conversionWavPath, opusPath, config.ffmpegCommand, spawnImpl);
      validateGeneratedVoice(opusPath, outputDir.fullPath);
      await validateVoiceLoudness(opusPath, config.ffmpegCommand, spawnImpl);
      noteActivity();
      return { assetId: opusAssetId, filePath: opusPath };
    } finally {
      await removeGeneratedVoice(wavPath);
      await removeGeneratedVoice(speedAdjustedWavPath);
    }
  }) as VoiceSynthesizer;

  synthesize.noteActivity = noteActivity;
  synthesize.streamAudio = async function* (request) {
    const { text } = request;
    noteActivity();
    const speed = genieSpeedValue(request.genie?.speed);
    if (speed !== 1) throw new Error("Genie TTS stream does not support speed adjustment");
    deps.appendLog?.("info", `genie tts stream prepare: baseURL=${config.baseURL} explicit=${config.baseURLExplicit ? "true" : "false"} chars=${Array.from(text).length}`);
    await ensureGenieService();
    deps.appendLog?.("info", `genie tts stream open: url=${config.baseURL}/${config.baseURLExplicit ? "stream-input" : "stream"} chars=${Array.from(text).length}`);
    let chunks = 0;
    let bytes = 0;
    for await (const chunk of streamGeniePcm({
      text,
      genie: request.genie,
      baseURL: config.baseURL,
      useClientUploadFlow: config.baseURLExplicit,
      timeoutMs: config.timeoutMs,
      fetchImpl,
      setTimer,
      clearTimer,
      appendLog: deps.appendLog
    })) {
      noteActivity();
      chunks += 1;
      bytes += chunk.byteLength;
      if (chunks === 1 || chunks % 20 === 0) {
        deps.appendLog?.("info", `genie tts stream chunk: chunks=${chunks} bytes=${bytes}`);
      }
      yield chunk;
    }
    deps.appendLog?.("info", `genie tts stream complete: chunks=${chunks} bytes=${bytes}`);
  };
  synthesize.streamAudioWithText = async function* (request) {
    const { text } = request;
    noteActivity();
    const speed = genieSpeedValue(request.genie?.speed);
    if (speed !== 1) throw new Error("Genie TTS stream does not support speed adjustment");
    deps.appendLog?.("info", `genie tts text stream prepare: baseURL=${config.baseURL} explicit=${config.baseURLExplicit ? "true" : "false"} chars=${Array.from(text).length}`);
    await ensureGenieService();
    deps.appendLog?.("info", `genie tts text stream open: url=${config.baseURL}/${config.baseURLExplicit ? "stream-input" : "stream"} chars=${Array.from(text).length}`);
    let chunks = 0;
    let bytes = 0;
  for await (const chunk of streamGeniePcmWithText({
      text,
      genie: request.genie,
      baseURL: config.baseURL,
      useClientUploadFlow: config.baseURLExplicit,
      timeoutMs: config.timeoutMs,
      fetchImpl,
      setTimer,
      clearTimer,
      appendLog: deps.appendLog
    })) {
    noteActivity();
    chunks += 1;
    bytes += chunk.chunk.byteLength;
    if (chunks === 1 || chunks % 20 === 0) {
        deps.appendLog?.("info", `genie tts text stream chunk: chunks=${chunks} bytes=${bytes}`);
      }
      yield chunk;
    }
    deps.appendLog?.("info", `genie tts text stream complete: chunks=${chunks} bytes=${bytes}`);
  };
  synthesize.prepare = async () => {
    noteActivity();
    await ensureGenieService();
  };
  synthesize.shutdown = shutdownOwnedService;
  return synthesize;

  function noteActivity(): void {
    if (idleTimer) clearTimer(idleTimer);
    if (config.idleShutdownMs <= 0) return;
    idleTimer = setTimer(() => {
      idleTimer = undefined;
      shutdownOwnedService().catch((error) => {
        deps.appendLog?.("warn", `genie tts idle shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, config.idleShutdownMs);
    idleTimer.unref?.();
  }

  async function ensureGenieService(): Promise<void> {
    if (await isHealthy()) {
      return;
    }
    if (config.baseURLExplicit) {
      throw new Error(`Genie TTS service is not healthy at ${config.baseURL}; custom GENIE_TTS_BASE_URL disables local auto-start`);
    }
    if (starting) {
      await starting;
      return;
    }
    starting = startOwnedService().finally(() => {
      starting = undefined;
    });
    await starting;
  }

  async function startOwnedService(): Promise<void> {
    const scriptPath = path.resolve(config.serviceScript);
    if (!fs.existsSync(scriptPath)) throw new Error(`Genie TTS service script was not found: ${scriptPath}`);
    const dataDir = requireAssetDirectory(config.dataDir, "Genie TTS data directory was not found");
    const modelDir = requireAssetDirectory(config.modelDir, "Genie TTS model directory was not found");
    const referenceAudio = requireAssetPath(config.referenceAudio, "Genie TTS reference audio was not found");
    const referenceText = requireGenieReferenceText(config.referenceText, "Genie TTS reference text was not found");
    const outputDir = resolveAssetOutputDir(config.outputDir);
    fs.mkdirSync(outputDir.fullPath, { recursive: true });
    deps.appendLog?.("info", `genie tts service starting: ${config.pythonCommand} ${scriptPath}`);
    ownedProcess = spawnImpl(config.pythonCommand, [
      scriptPath,
      "--host", config.host,
      "--port", String(config.port),
      "--model-dir", modelDir,
      "--output-dir", outputDir.fullPath,
      "--character-name", config.characterName,
      "--language", config.language,
      "--reference-audio", referenceAudio,
      "--reference-text", referenceText
    ], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GENIE_DATA_DIR: dataDir }
    });
    ownedProcess.stdout?.on("data", (chunk: Buffer) => deps.appendLog?.("info", `genie tts: ${String(chunk).trim()}`));
    ownedProcess.stderr?.on("data", (chunk: Buffer) => deps.appendLog?.("warn", `genie tts: ${String(chunk).trim()}`));
    ownedProcess.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      deps.appendLog?.("info", `genie tts service exited: code=${code ?? ""} signal=${signal ?? ""}`);
      ownedProcess = undefined;
    });
    await waitForHealthy();
  }

  async function waitForHealthy(): Promise<void> {
    const deadline = Date.now() + config.timeoutMs;
    let lastError = "not ready";
    while (Date.now() < deadline) {
      if (ownedProcess?.exitCode !== null && ownedProcess?.exitCode !== undefined) {
        throw new Error(`Genie TTS service exited before ready: ${ownedProcess.exitCode}`);
      }
      try {
        if (await isHealthy()) return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await delay(500);
    }
    throw new Error(`Genie TTS service did not become healthy: ${lastError}`);
  }

  async function isHealthy(): Promise<boolean> {
    try {
      const response = await fetchImpl(`${config.baseURL}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(2_000, config.timeoutMs))
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function shutdownOwnedService(): Promise<void> {
    if (idleTimer) {
      clearTimer(idleTimer);
      idleTimer = undefined;
    }
    if (!ownedProcess) return;
    const processToStop = ownedProcess;
    ownedProcess = undefined;
    try {
      await postJson(`${config.baseURL}/shutdown`, {}, 2_000, fetchImpl, "Genie TTS");
    } catch {
      processToStop.kill("SIGTERM");
    }
  }
}

const genieRequiredBaseModelFiles = [
  "t2s_encoder_fp32.bin",
  "t2s_encoder_fp32.onnx",
  "t2s_first_stage_decoder_fp32.onnx",
  "t2s_shared_fp16.bin",
  "t2s_stage_decoder_fp32.onnx",
  "vits_fp16.bin",
  "vits_fp32.onnx"
];

function genieRequestOverrides(
  input: VoiceSynthesisInput["genie"],
  appendLog?: MossOnnxVoiceSynthesizerDeps["appendLog"],
  options: { requireCompleteModel?: boolean } = {}
): Record<string, unknown> {
  if (!input) return {};
  const requireCompleteModel = options.requireCompleteModel ?? true;
  const overrides: Record<string, unknown> = {};
  if (input.language) overrides.language = input.language;
  if (input.modelDir) {
    const modelDir = requireAssetDirectory(input.modelDir, "Genie TTS model directory was not found");
    const missing = missingGenieBaseModelFiles(modelDir);
    if (!requireCompleteModel || missing.length === 0) {
      overrides.modelDir = modelDir;
    } else {
      appendLog?.("warn", `genie tts model override skipped because ${input.modelDir} is incomplete; missing ${missing.join(", ")}`);
    }
  }
  if (input.referenceAudio) overrides.referenceAudioPath = requireAssetPath(input.referenceAudio, "Genie TTS reference audio was not found");
  if (input.referenceText) overrides.referenceText = requireGenieReferenceText(input.referenceText, "Genie TTS reference text was not found");
  if (input.partSilenceSeconds !== undefined) overrides.partSilenceSeconds = geniePartSilenceSecondsValue(input.partSilenceSeconds);
  if (input.splitText !== undefined) overrides.splitText = Boolean(input.splitText);
  return overrides;
}

function missingGenieBaseModelFiles(modelDir: string): string[] {
  return genieRequiredBaseModelFiles.filter((fileName) => !fs.existsSync(path.join(modelDir, fileName)));
}

function genieSpeedValue(value: unknown): number {
  if (value === undefined || value === null) return 1;
  const speed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(speed)) throw new Error("Genie TTS speed must be a number");
  if (speed < 0.5 || speed > 2) throw new Error("Genie TTS speed must be between 0.5 and 2.0");
  return Math.round(speed * 1000) / 1000;
}

function geniePartSilenceSecondsValue(value: unknown): number {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(seconds)) throw new Error("Genie TTS part silence seconds must be a number");
  if (seconds < 0 || seconds > 3) throw new Error("Genie TTS part silence seconds must be between 0 and 3");
  return Math.round(seconds * 1000) / 1000;
}

async function postJson(url: string, body: Record<string, unknown>, timeoutMs: number, fetchImpl: typeof fetch, label = "MOSS TTS"): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = { text };
    }
  }
  if (!response.ok) {
    const message = isRecord(parsed) ? optionalStringValue(parsed.error) || optionalStringValue(parsed.text) : undefined;
    throw new Error(`${label} HTTP ${response.status}: ${(message ?? text).slice(0, 500)}`);
  }
  return parsed ?? {};
}

async function* streamGeniePcm(input: {
  text: string;
  genie?: VoiceSynthesisInput["genie"];
  baseURL: string;
  useClientUploadFlow?: boolean;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  appendLog?: MossOnnxVoiceSynthesizerDeps["appendLog"];
}): AsyncIterable<Uint8Array> {
  for await (const chunk of streamGeniePcmWithText(input)) yield chunk.chunk;
}

async function* streamGeniePcmWithText(input: {
  text: string;
  genie?: VoiceSynthesisInput["genie"];
  baseURL: string;
  useClientUploadFlow?: boolean;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  appendLog?: MossOnnxVoiceSynthesizerDeps["appendLog"];
}): AsyncIterable<TtsAudioTextChunk> {
  const controller = new AbortController();
  const timeout = input.setTimer(() => controller.abort(), input.timeoutMs);
  timeout.unref?.();
  try {
    const response = await openGeniePcmStream({
      ...input,
      responseFormat: input.useClientUploadFlow && input.genie?.modelDir ? "ndjson" : undefined
    }, controller.signal);
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Genie TTS stream HTTP ${response.status}: ${errorText.slice(0, 500)}`);
    }
    if (!response.body) throw new Error("Genie TTS stream response had no body");
    const contentType = response.headers.get("content-type") ?? "";
    if (/ndjson|jsonl|application\/json/i.test(contentType)) {
      yield* parseGenieNdjsonAudioStream(response.body as AsyncIterable<Uint8Array>);
      return;
    }
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      if (!chunk.byteLength) continue;
      yield { chunk: chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk) };
    }
  } finally {
    input.clearTimer(timeout);
    controller.abort();
  }
}

async function openGeniePcmStream(input: {
  text: string;
  genie?: VoiceSynthesisInput["genie"];
  baseURL: string;
  useClientUploadFlow?: boolean;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  appendLog?: MossOnnxVoiceSynthesizerDeps["appendLog"];
  responseFormat?: "ndjson";
}, signal: AbortSignal): Promise<Response> {
  const overrides = genieRequestOverrides(input.genie, input.appendLog, {
    requireCompleteModel: !input.useClientUploadFlow
  });
  if (!input.useClientUploadFlow || !input.genie?.modelDir) {
    return input.fetchImpl(`${input.baseURL}/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        text: input.text,
        ...overrides
      })
    });
  }

  const url = genieStreamInputUrl(input.baseURL, {
    language: typeof overrides.language === "string" ? overrides.language : undefined,
    modelDir: String(overrides.modelDir),
    responseFormat: input.responseFormat
  });
  const body = `${JSON.stringify({
    text: input.text,
    ...(typeof overrides.referenceText === "string" ? { referenceText: overrides.referenceText } : {})
  })}\n`;
  let response = await input.fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    signal,
    body
  });
  if (response.status !== 409) return response;
  const missing = await readGenieRemoteUploadResponse(response, String(overrides.modelDir));
  await uploadGenieModelForRemote({
    baseURL: input.baseURL,
    modelDir: missing.modelDir,
    uploadUrl: missing.uploadUrl,
    timeoutMs: input.timeoutMs,
    fetchImpl: input.fetchImpl,
    signal,
    appendLog: input.appendLog
  });
  input.appendLog?.("info", `genie tts remote preset uploaded; retrying original stream-input request code=${missing.code} modelDir=${missing.modelDir}`);
  response = await input.fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    signal,
    body
  });
  return response;
}

function genieStreamInputUrl(baseURL: string, input: { language?: string; modelDir: string; responseFormat?: "ndjson" }): string {
  const url = new URL(`${baseURL}/stream-input`);
  if (input.language) url.searchParams.set("language", input.language);
  url.searchParams.set("modelDir", input.modelDir);
  if (input.responseFormat) url.searchParams.set("responseFormat", input.responseFormat);
  return url.toString();
}

async function* parseGenieNdjsonAudioStream(body: AsyncIterable<Uint8Array>): AsyncIterable<TtsAudioTextChunk> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const rawChunk of body) {
    const chunk = rawChunk instanceof Uint8Array ? rawChunk : new Uint8Array(rawChunk);
    pending += decoder.decode(chunk, { stream: true });
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      const parsed = parseGenieNdjsonAudioLine(line);
      if (parsed) yield parsed;
    }
  }
  pending += decoder.decode();
  const line = pending.trim();
  const parsed = parseGenieNdjsonAudioLine(line);
  if (parsed) yield parsed;
}

function parseGenieNdjsonAudioLine(line: string): TtsAudioTextChunk | undefined {
  if (!line) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`Genie TTS ndjson stream invalid JSON line: ${line.slice(0, 500)}`);
  }
  if (!isRecord(parsed)) throw new Error(`Genie TTS ndjson stream invalid line: ${line.slice(0, 500)}`);
  const type = optionalStringValue(parsed.type);
  if (type === "done") return undefined;
  if (type !== "audio") return undefined;
  const audioBase64 = optionalStringValue(parsed.audioBase64);
  if (!audioBase64) throw new Error("Genie TTS ndjson audio line did not include audioBase64");
  return {
    text: optionalStringValue(parsed.text),
    chunk: new Uint8Array(Buffer.from(audioBase64, "base64"))
  };
}

async function readGenieRemoteUploadResponse(response: Response, fallbackModelDir: string): Promise<{ code: string; modelDir: string; uploadUrl?: string }> {
  const text = await response.text().catch(() => "");
  if (!text) throw new Error("Genie TTS stream-input HTTP 409 without JSON body");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) throw new Error(`Genie TTS stream-input HTTP 409: ${text.slice(0, 500)}`);
    const code = optionalStringValue(parsed.code) || "unknown_code";
    if (code !== "MODEL_NOT_UPLOADED" && code !== "REFERENCE_NOT_UPLOADED") {
      const message = optionalStringValue(parsed.error) || optionalStringValue(parsed.message) || text;
      throw new Error(`Genie TTS stream-input HTTP 409 ${code}: ${message.slice(0, 500)}`);
    }
    const modelDir = optionalStringValue(parsed.modelDir) || fallbackModelDir;
    if (!modelDir) throw new Error(`Genie TTS ${code} response did not include modelDir and original request had no modelDir`);
    return {
      code,
      modelDir,
      uploadUrl: optionalStringValue(parsed.uploadUrl)
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Genie TTS")) throw error;
    throw new Error(`Genie TTS stream-input HTTP 409 invalid JSON: ${text.slice(0, 500)}`);
  }
}

function isRemoteGenieProtocolError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Genie TTS stream-input HTTP 409|MODEL_NOT_UPLOADED|REFERENCE_NOT_UPLOADED|remote stream-input requires modelDir/i.test(message);
}

async function uploadGenieModelForRemote(input: {
  baseURL: string;
  modelDir: string;
  uploadUrl?: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  appendLog?: MossOnnxVoiceSynthesizerDeps["appendLog"];
}): Promise<void> {
  const modelDir = requireAssetDirectory(input.modelDir, "Genie TTS remote upload model directory was not found");
  const presetDir = path.dirname(modelDir);
  const zip = zipDirectoryToBuffer(presetDir);
  const hash = crypto.createHash("sha256").update(zip).digest("hex");
  const uploadUrl = new URL(input.uploadUrl || `/models/upload?modelDir=${encodeURIComponent(input.modelDir)}`, input.baseURL).toString();
  input.appendLog?.("info", `genie tts remote preset upload start: files_zip_bytes=${zip.byteLength} modelDir=${input.modelDir} presetDir=${presetDir}`);
  const response = await input.fetchImpl(uploadUrl, {
    method: "POST",
    headers: {
      "content-type": "application/zip",
      "x-model-sha256": hash
    },
    signal: input.signal,
    body: new Uint8Array(zip)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Genie TTS model upload HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
}

async function collectGenieStreamPcm(input: Parameters<typeof streamGeniePcm>[0] & { onChunk?(): void }): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of streamGeniePcm(input)) {
    input.onChunk?.();
    chunks.push(chunk);
  }
  const pcm = concatUint8Arrays(chunks);
  if (pcm.byteLength === 0) throw new Error("Genie TTS stream returned no audio");
  return pcm;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; code?: unknown; message?: unknown };
  const name = typeof value.name === "string" ? value.name : "";
  const code = typeof value.code === "string" ? value.code : "";
  const message = typeof value.message === "string" ? value.message : "";
  return name === "AbortError" || code === "ABORT_ERR" || /abort|timeout/i.test(message);
}

async function waitForGeneratedVoiceAfterAbort(filePath: string, outputDir: string, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + Math.max(5_000, timeoutMs);
  let lastError = "not generated yet";
  while (Date.now() < deadline) {
    try {
      validateGeneratedVoice(filePath, outputDir);
      return { ok: true, audioPath: filePath, recoveredAfterClientTimeout: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`Genie TTS synthesize timed out and output file was not available: ${lastError}`);
}

async function changeAudioTempo(inputPath: string, outputPath: string, speed: number, ffmpegCommand: string, spawnImpl: typeof childProcess.spawn): Promise<void> {
  const resolvedFfmpegCommand = resolveFfmpegCommand(ffmpegCommand);
  await new Promise<void>((resolve, reject) => {
    const child = spawnImpl(resolvedFfmpegCommand, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", inputPath,
      "-filter:a", `atempo=${speed}`,
      outputPath
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => reject(error));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg tempo adjustment failed with exit code ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

async function convertWavToOpus(wavPath: string, opusPath: string, ffmpegCommand: string, spawnImpl: typeof childProcess.spawn): Promise<void> {
  const resolvedFfmpegCommand = resolveFfmpegCommand(ffmpegCommand);
  await new Promise<void>((resolve, reject) => {
    const child = spawnImpl(resolvedFfmpegCommand, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", wavPath,
      "-acodec", "libopus",
      "-b:a", "32k",
      "-vbr", "on",
      opusPath
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      const code = isRecord(error) ? error.code : undefined;
      reject(new Error(code === "ENOENT"
        ? `ffmpeg was not found; install ffmpeg-static or set MOSS_TTS_FFMPEG_COMMAND to enable opus audio`
        : error.message));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg failed with exit code ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

async function readPcmStats(audioPath: string, ffmpegCommand: string, spawnImpl: typeof childProcess.spawn): Promise<{ rms: number; peak: number }> {
  const resolvedFfmpegCommand = resolveFfmpegCommand(ffmpegCommand);
  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawnImpl(resolvedFfmpegCommand, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", audioPath,
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout?.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Uint8Array) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => reject(error));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg failed to inspect audio loudness for ${audioPath}: ${stderr.slice(0, 500)}`));
    });
  });
  const pcm = concatUint8Arrays(chunks);
  if (pcm.length < 2) return { rms: 0, peak: 0 };
  let sumSquares = 0;
  let peak = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = readInt16LE(pcm, offset) / 32768;
    const abs = Math.abs(sample);
    peak = Math.max(peak, abs);
    sumSquares += sample * sample;
  }
  return { rms: Math.sqrt(sumSquares / samples), peak };
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function writePcmL16Wav(filePath: string, pcm: Uint8Array, sampleRate: number, channels: number): void {
  if (pcm.byteLength === 0) throw new Error("PCM audio is empty");
  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const output = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(output.buffer);
  writeAscii(output, 0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(output, 8, "WAVE");
  writeAscii(output, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(output, 36, "data");
  view.setUint32(40, pcm.byteLength, true);
  output.set(pcm, 44);
  fs.writeFileSync(filePath, output);
}

function writeAscii(output: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    output[offset + index] = text.charCodeAt(index);
  }
}

function readInt16LE(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset] | (bytes[offset + 1] << 8);
  return value & 0x8000 ? value - 0x10000 : value;
}

async function validateVoiceLoudness(audioPath: string, ffmpegCommand: string, spawnImpl: typeof childProcess.spawn): Promise<void> {
  const stats = await readPcmStats(audioPath, ffmpegCommand, spawnImpl);
  if (stats.rms < 0.005 || stats.peak < 0.03) {
    throw new Error(`Generated voice is too quiet: rms=${stats.rms.toFixed(6)} peak=${stats.peak.toFixed(6)} file=${path.basename(audioPath)}`);
  }
}

function resolveFfmpegCommand(ffmpegCommand: string): string {
  if (ffmpegCommand !== "ffmpeg-static") return ffmpegCommand;
  try {
    const resolved = require("ffmpeg-static") as unknown;
    if (typeof resolved === "string" && resolved) return resolved;
  } catch {
    // Fall through to a clear error below.
  }
  throw new Error("ffmpeg-static is not installed or did not expose an ffmpeg binary path");
}

function requireAssetPath(assetId: string, error: string): string {
  const assetRoot = path.resolve("assets");
  const filePath = resolveAssetScopedPath(assetId);
  const relative = path.relative(assetRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("TTS asset path is outside assets directory");
  if (!fs.existsSync(filePath)) throw new Error(error);
  return filePath;
}

function requireAssetDirectory(assetId: string, error: string): string {
  const dirPath = requireAssetPath(assetId, error);
  if (fs.statSync(dirPath).isFile()) throw new Error(error);
  return dirPath;
}

function resolveAssetOutputDir(assetDir: string): { fullPath: string; relativePath: string } {
  const assetRoot = path.resolve("assets");
  const fullPath = resolveAssetScopedPath(assetDir);
  const relativePath = path.relative(assetRoot, fullPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("TTS output directory must be inside assets");
  }
  return { fullPath, relativePath };
}

function resolveAssetScopedPath(assetPath: string): string {
  if (path.isAbsolute(assetPath)) return assetPath;
  const normalized = path.normalize(assetPath);
  if (normalized === "assets" || normalized.startsWith(`assets${path.sep}`)) {
    return path.resolve(normalized);
  }
  return path.resolve("assets", normalized);
}

function validateGeneratedVoice(filePath: string, outputDir: string): void {
  const relative = path.relative(outputDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("TTS output file is outside output directory");
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("TTS output is not a file");
  if (stat.size <= 0) throw new Error("TTS output file is empty");
}

function uniqueVoiceBaseName(outputDir: string, iso: string): string {
  const baseName = formatFileDateTime(iso);
  let candidate = baseName;
  let suffix = 2;
  while (fs.existsSync(path.join(outputDir, `${candidate}.wav`)) || fs.existsSync(path.join(outputDir, `${candidate}.opus`))) {
    candidate = `${baseName}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function removeGeneratedVoice(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

function formatFileDateTime(value: string): string {
  return value.replace(/[-:]/g, "").replace("T", "_").replace(".", "_");
}
