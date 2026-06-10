const fs = await import("node:fs");
const path = await import("node:path");
import type {
  ConfiguredVoiceSynthesizerDeps,
  FallbackVoiceSynthesizerDeps,
  MossOnnxVoiceSynthesizerDeps,
  TTSConfig,
  TtsApiPreset,
  TtsAudioTextChunk,
  TtsBailianConversionConfig,
  TtsConversionConfig,
  TtsOpenAiApiConversionConfig,
  TtsPlugin,
  TtsPluginConfig,
  TtsPluginDeps,
  TtsStreamChunk,
  TtsStreamInput,
  TtsSynthesizer,
  TtsTranslationPreset,
  TtsVoiceModelConfig,
  VoiceSynthesisInput,
  VoiceSynthesizer
} from "./types.js";

import { parseJsonObject, stringValue } from "./internal.js";
import { writeAscii } from "./audio-utils.js";

export function createTtsConversionSynthesizer(
  conversion: "genie" | "openai-api" | "bailian",
  config: TtsPluginConfig,
  deps: TtsPluginDeps
): VoiceSynthesizer | undefined {
  if (conversion === "openai-api") return createOpenAiApiTtsVoiceSynthesizer(config, deps);
  if (conversion === "bailian") return createBailianTtsVoiceSynthesizer(config, deps);
  return undefined;
}

export function createOpenAiApiTtsVoiceSynthesizer(
  config: TtsPluginConfig,
  deps: Pick<TtsPluginDeps, "fetch" | "env" | "resolveApiPreset" | "appendLog"> & { outputDir?: string } = {}
): VoiceSynthesizer {
  const synthesize = (async (request) => {
    const settings = resolveOpenAiApiTtsSettings(config, deps);
    const audio = await requestOpenAiApiTtsAudio(request.text, settings, deps, { stream: false });
    const stamp = request.time.now().iso.replace(/[^\dA-Za-z.-]+/g, "_");
    const outputDir = deps.outputDir ?? path.join("assets", "generated", "tts");
    const filePath = path.join(outputDir, `${stamp}-openai-api.wav`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, pcmToWav(audio, { sampleRate: settings.sampleRate, channels: settings.channels }));
    return {
      assetId: `generated/tts/${path.basename(filePath)}`,
      filePath
    };
  }) as VoiceSynthesizer;

  synthesize.streamAudio = async function* (request) {
    const settings = resolveOpenAiApiTtsSettings(config, deps);
    const audio = await requestOpenAiApiTtsAudio(request.text, settings, deps, { stream: false });
    if (audio.byteLength) yield audio;
  };
  synthesize.streamAudioWithText = async function* (request) {
    const settings = resolveOpenAiApiTtsSettings(config, deps);
    const audio = await requestOpenAiApiTtsAudio(request.text, settings, deps, { stream: false });
    if (!audio.byteLength) return;
    yield {
      text: request.text,
      chunk: audio,
      sampleRateHz: settings.sampleRate,
      channels: settings.channels
    };
  };
  return synthesize;
}

type OpenAiApiTtsSettings = {
  baseURL: string;
  apiKey: string;
  model: string;
  voice: string;
  timeoutMs: number;
  sampleRate: number;
  channels: number;
  extraParams: Record<string, unknown>;
};

function resolveOpenAiApiTtsSettings(config: TtsPluginConfig, deps: Pick<TtsPluginDeps, "env" | "resolveApiPreset">): OpenAiApiTtsSettings {
  const conversion = config.conversion?.openaiApi ?? {};
  const preset = conversion.apiPresetName ? deps.resolveApiPreset?.(conversion.apiPresetName) : undefined;
  const env = deps.env ?? process.env;
  const apiKey = conversion.apiKey || (conversion.apiKeyEnv ? env[conversion.apiKeyEnv] : undefined) || preset?.apiKey || (preset?.apiKeyEnv ? env[preset.apiKeyEnv] : undefined);
  const baseURL = normalizeOpenAiApiSpeechBaseURL(conversion.baseURL || preset?.baseURL || "");
  if (!baseURL) throw new Error("OpenAI-API TTS conversion requires baseURL or API preset");
  if (!apiKey) throw new Error("OpenAI-API TTS conversion requires API key or API preset");
  return {
    baseURL,
    apiKey,
    model: conversion.model || preset?.model || "higgs-audio-v3-tts",
    voice: conversion.voice || "default",
    timeoutMs: conversion.timeoutMs ?? preset?.timeoutMs ?? 60_000,
    sampleRate: conversion.sampleRate ?? 32_000,
    channels: conversion.channels ?? 1,
    extraParams: {
      ...(preset?.extraParams ?? {}),
      ...(conversion.extraParams ?? {})
    }
  };
}

async function requestOpenAiApiTtsAudio(
  text: string,
  settings: OpenAiApiTtsSettings,
  deps: Pick<TtsPluginDeps, "fetch" | "appendLog">,
  options: { stream: boolean }
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of requestOpenAiApiTtsAudioStream(text, settings, deps, options)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const audio = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return audio;
}

async function* requestOpenAiApiTtsAudioStream(
  text: string,
  settings: OpenAiApiTtsSettings,
  deps: Pick<TtsPluginDeps, "fetch" | "appendLog">,
  options: { stream?: boolean } = { stream: true }
): AsyncIterable<Uint8Array> {
  const fetchImpl = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("openai_api_tts_timeout")), settings.timeoutMs);
  const body = {
    ...settings.extraParams,
    input: text,
    model: settings.model,
    voice: settings.voice,
    response_format: "pcm",
    ...(options.stream === false ? {} : { stream: true })
  };
  deps.appendLog?.("info", `tts OpenAI-API speech start: chars=${Array.from(text).length} stream=${options.stream === false ? "false" : "true"}`);
  try {
    const response = await fetchImpl(`${settings.baseURL}/audio/speech`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${settings.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`OpenAI-API TTS HTTP ${response.status}: ${errorText.slice(0, 500)}`);
    }
    if (!response.body) {
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > 0) yield buffer;
      return;
    }
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOpenAiApiSpeechBaseURL(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) return "";
  return normalized.endsWith("/audio/speech")
    ? normalized.slice(0, -"/audio/speech".length).replace(/\/+$/, "")
    : normalized;
}

export function createBailianTtsVoiceSynthesizer(
  config: TtsPluginConfig,
  deps: Pick<TtsPluginDeps, "env" | "fetch" | "appendLog"> & { outputDir?: string } = {}
): VoiceSynthesizer {
  const synthesize = (async (request) => {
    const settings = resolveBailianTtsSettings(config, deps);
    const audio = await requestBailianTtsAudio(request.text, settings, deps);
    const stamp = request.time.now().iso.replace(/[^\dA-Za-z.-]+/g, "_");
    const outputDir = deps.outputDir ?? path.join("assets", "generated", "tts");
    const filePath = path.join(outputDir, `${stamp}-bailian.wav`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, pcmToWav(audio, { sampleRate: settings.sampleRate, channels: settings.channels }));
    return {
      assetId: `generated/tts/${path.basename(filePath)}`,
      filePath
    };
  }) as VoiceSynthesizer;

  synthesize.streamAudio = async function* (request) {
    const settings = resolveBailianTtsSettings(config, deps);
    const audio = await requestBailianTtsAudio(request.text, settings, deps);
    if (audio.byteLength) yield audio;
  };
  synthesize.streamAudioWithText = async function* (request) {
    const settings = resolveBailianTtsSettings(config, deps);
    const audio = await requestBailianTtsAudio(request.text, settings, deps);
    if (!audio.byteLength) return;
    yield {
      text: request.text,
      chunk: audio,
      sampleRateHz: settings.sampleRate,
      channels: settings.channels
    };
  };
  return synthesize;
}

type BailianTtsSettings = {
  endpoint: string;
  apiKey: string;
  workspaceId?: string;
  userAgent?: string;
  model: string;
  voice: string;
  languageType: string;
  mode: "server_commit" | "commit";
  responseFormat: string;
  sampleRate: number;
  channels: number;
  timeoutMs: number;
  extraParams: Record<string, unknown>;
};

function resolveBailianTtsSettings(
  config: TtsPluginConfig,
  deps: Pick<TtsPluginDeps, "env">
): BailianTtsSettings {
  const conversion = config.conversion?.bailian ?? {};
  const env = deps.env ?? process.env;
  const apiKey = conversion.apiKey || (conversion.apiKeyEnv ? env[conversion.apiKeyEnv] : undefined) || env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("Bailian TTS conversion requires apiKey or DASHSCOPE_API_KEY");
  return {
    endpoint: conversion.endpoint || "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    apiKey,
    workspaceId: conversion.workspaceId,
    userAgent: conversion.userAgent,
    model: conversion.model || "qwen3-tts-vc-2026-01-22",
    voice: conversion.voice || "Cherry",
    languageType: conversion.languageType || "Chinese",
    mode: conversion.mode === "commit" ? "commit" : "server_commit",
    responseFormat: conversion.responseFormat || "pcm",
    sampleRate: conversion.sampleRate ?? 24_000,
    channels: conversion.channels ?? 1,
    timeoutMs: conversion.timeoutMs ?? 60_000,
    extraParams: conversion.extraParams ?? {}
  };
}

async function requestBailianTtsAudio(
  text: string,
  settings: BailianTtsSettings,
  deps: Pick<TtsPluginDeps, "fetch" | "appendLog">
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of requestBailianTtsAudioStream(text, settings, deps)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const audio = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return audio;
}

async function* requestBailianTtsAudioStream(
  text: string,
  settings: BailianTtsSettings,
  deps: Pick<TtsPluginDeps, "fetch" | "appendLog">
): AsyncIterable<Uint8Array> {
  const fetchImpl = deps.fetch ?? fetch;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), settings.timeoutMs);
  deps.appendLog?.("info", `tts Bailian non-realtime stream start: chars=${Array.from(text).length}`);
  try {
    const response = await fetchImpl(settings.endpoint, {
      method: "POST",
      signal: abort.signal,
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-SSE": "enable",
        ...(settings.userAgent ? { "user-agent": settings.userAgent } : {}),
        ...(settings.workspaceId ? { "X-DashScope-WorkSpace": settings.workspaceId } : {})
      },
      body: JSON.stringify({
        model: settings.model,
        input: {
          ...settings.extraParams,
          text,
          voice: settings.voice,
          language_type: settings.languageType
        }
      })
    });
    if (!response.ok) {
      throw new Error(`Bailian TTS HTTP error ${response.status}: ${await response.text()}`);
    }
    let chunks = 0;
    let bytes = 0;
    for await (const event of readBailianSseEvents(response)) {
      const error = parseBailianHttpError(event);
      if (error) throw error;
      const audio = bailianHttpAudioData(event);
      if (audio?.byteLength) {
        chunks += 1;
        bytes += audio.byteLength;
        yield audio;
      }
    }
    if (bytes <= 0) throw new Error("Bailian TTS returned no audio data");
    deps.appendLog?.("info", `tts Bailian non-realtime stream complete: chunks=${chunks} bytes=${bytes}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function* readBailianSseEvents(response: Response): AsyncIterable<Record<string, unknown>> {
  const body = response.body;
  if (!body) {
    const event = parseJsonObject(await response.text());
    if (Object.keys(event).length) yield event;
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = bailianSseEventBoundary(buffer);
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + (buffer[boundary] === "\r" ? 4 : 2));
        const event = parseBailianSseEvent(raw);
        if (event) yield event;
        boundary = bailianSseEventBoundary(buffer);
      }
    }
    buffer += decoder.decode();
    const event = parseBailianSseEvent(buffer);
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}

function bailianSseEventBoundary(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0) return crlf;
  if (crlf < 0) return lf;
  return Math.min(lf, crlf);
}

function parseBailianSseEvent(raw: string): Record<string, unknown> | undefined {
  const data = raw.split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return undefined;
  return parseJsonObject(data);
}

function bailianHttpAudioData(event: Record<string, unknown>): Uint8Array | undefined {
  const output = parseJsonObject(event.output);
  const audio = parseJsonObject(output.audio);
  const data = stringValue(audio.data);
  if (!data) return undefined;
  return new Uint8Array(Buffer.from(data, "base64"));
}

function parseBailianHttpError(event: Record<string, unknown>): Error | undefined {
  const code = stringValue(event.error_code) || stringValue(event.code);
  if (!code) return undefined;
  const error = parseJsonObject(event.error);
  const message = stringValue(error.message) || stringValue(event.message) || JSON.stringify(event).slice(0, 500);
  return new Error(`Bailian TTS error: ${message}`);
}

function pcmToWav(pcm: Uint8Array, options: { sampleRate: number; channels: number }): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  writeAscii(header, 0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(header, 8, "WAVE");
  writeAscii(header, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, options.channels, true);
  view.setUint32(24, options.sampleRate, true);
  view.setUint32(28, options.sampleRate * options.channels * 2, true);
  view.setUint16(32, options.channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(header, 36, "data");
  view.setUint32(40, pcm.byteLength, true);
  const wav = new Uint8Array(header.byteLength + pcm.byteLength);
  wav.set(header);
  wav.set(pcm, header.byteLength);
  return wav;
}
