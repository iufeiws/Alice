const fs = await import("node:fs");
const path = await import("node:path");
import type {
  TtsConversionProvider,
  TtsMimoConversionConfig,
  TtsPluginConfig,
  TtsPluginDeps,
  VoiceSynthesizer
} from "./types.js";

import { defaultBailianTtsEndpoint, defaultMimoTtsBaseURL, defaultMimoTtsModel, selectedTtsPreset } from "./config.js";
import { parseJsonObject, stringValue } from "./internal.js";
import { writeAscii } from "./audio-utils.js";
import { recordTtsApiUsage } from "./usage.js";
import { createOpenAIUpstreamRequester } from "../../../contexts/llm-gateway/src/index.js";

export function createTtsConversionSynthesizer(
  conversion: TtsConversionProvider,
  config: TtsPluginConfig,
  deps: TtsPluginDeps
): VoiceSynthesizer | undefined {
  if (conversion === "openai-api") return createOpenAiApiTtsVoiceSynthesizer(config, deps);
  if (conversion === "bailian") return createBailianTtsVoiceSynthesizer(config, deps);
  if (conversion === "mimo") return createMimoTtsVoiceSynthesizer(config, deps);
  return undefined;
}

export function createOpenAiApiTtsVoiceSynthesizer(
  config: TtsPluginConfig,
  deps: Pick<TtsPluginDeps, "fetch" | "env" | "resolveApiPreset" | "appendLog" | "recordTokenUsageEvent"> & { outputDir?: string } = {}
): VoiceSynthesizer {
  const synthesize = (async (request) => {
    const settings = resolveOpenAiApiTtsSettings(config, deps);
    recordTtsApiUsage(deps, { time: request.time, provider: "openai-api", model: settings.model, text: request.text });
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
    recordTtsApiUsage(deps, { time: request.time, provider: "openai-api", model: settings.model, text: request.text });
    const audio = await requestOpenAiApiTtsAudio(request.text, settings, deps, { stream: false });
    if (audio.byteLength) yield audio;
  };
  synthesize.streamAudioWithText = async function* (request) {
    const settings = resolveOpenAiApiTtsSettings(config, deps);
    recordTtsApiUsage(deps, { time: request.time, provider: "openai-api", model: settings.model, text: request.text });
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
  const conversion = selectedTtsPreset(config).openaiApi ?? {};
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
  deps: Pick<TtsPluginDeps, "env" | "fetch" | "appendLog" | "recordTokenUsageEvent"> & { outputDir?: string } = {}
): VoiceSynthesizer {
  const synthesize = (async (request) => {
    const settings = resolveBailianTtsSettings(config, deps);
    recordTtsApiUsage(deps, { time: request.time, provider: `bailian-${settings.service}`, model: settings.model, text: request.text });
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
    recordTtsApiUsage(deps, { time: request.time, provider: `bailian-${settings.service}`, model: settings.model, text: request.text });
    const audio = await requestBailianTtsAudio(request.text, settings, deps);
    if (audio.byteLength) yield audio;
  };
  synthesize.streamAudioWithText = async function* (request) {
    const settings = resolveBailianTtsSettings(config, deps);
    recordTtsApiUsage(deps, { time: request.time, provider: `bailian-${settings.service}`, model: settings.model, text: request.text });
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

export function createMimoTtsVoiceSynthesizer(
  config: TtsPluginConfig,
  deps: Pick<TtsPluginDeps, "env" | "fetch" | "appendLog" | "recordTokenUsageEvent"> & { outputDir?: string } = {}
): VoiceSynthesizer {
  const synthesize = (async (request) => {
    const settings = resolveMimoTtsSettings(config, deps);
    const audio = await requestMimoTtsAudio(request.text, settings, deps);
    const stamp = request.time.now().iso.replace(/[^\dA-Za-z.-]+/g, "_");
    const outputDir = deps.outputDir ?? path.join("assets", "generated", "tts");
    const filePath = path.join(outputDir, `${stamp}-mimo.wav`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, settings.audioFormat === "pcm16" ? pcmToWav(audio, { sampleRate: settings.sampleRate, channels: settings.channels }) : audio);
    return {
      assetId: `generated/tts/${path.basename(filePath)}`,
      filePath
    };
  }) as VoiceSynthesizer;

  synthesize.streamAudio = async function* (request) {
    const settings = resolveMimoTtsSettings(config, deps);
    const audio = await requestMimoTtsAudio(request.text, settings, deps);
    if (audio.byteLength) yield audio;
  };
  synthesize.streamAudioWithText = async function* (request) {
    const settings = resolveMimoTtsSettings(config, deps);
    const audio = await requestMimoTtsAudio(request.text, settings, deps);
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

type MimoTtsSettings = Required<Pick<TtsMimoConversionConfig, "mode" | "baseURL" | "apiKey" | "audioFormat" | "timeoutMs" | "sampleRate" | "channels" | "extraParams">> & {
  model: string;
  voice?: string;
  voiceDesignPrompt?: string;
  voiceCloneAudioDataUrl?: string;
};

function resolveMimoTtsSettings(
  config: TtsPluginConfig,
  deps: Pick<TtsPluginDeps, "env">
): MimoTtsSettings {
  const conversion = selectedTtsPreset(config).mimo ?? {};
  const mode = conversion.mode === "voicedesign" || conversion.mode === "voiceclone" ? conversion.mode : "preset";
  const env = deps.env ?? process.env;
  const apiKey = conversion.apiKey || (conversion.apiKeyEnv ? env[conversion.apiKeyEnv] : undefined) || env.MIMO_API_KEY;
  if (!apiKey) throw new Error("MiMo TTS conversion requires apiKey or MIMO_API_KEY");
  if (mode === "voicedesign" && !conversion.voiceDesignPrompt) throw new Error("MiMo voice design requires voiceDesignPrompt");
  if (mode === "voiceclone" && !conversion.voiceCloneAudioDataUrl) throw new Error("MiMo voice clone requires voiceCloneAudioDataUrl");
  return {
    mode,
    baseURL: normalizeMimoBaseURL(conversion.baseURL || defaultMimoTtsBaseURL),
    apiKey,
    model: defaultMimoTtsModel(mode),
    voice: conversion.voice || "mimo_default",
    voiceDesignPrompt: conversion.voiceDesignPrompt,
    voiceCloneAudioDataUrl: conversion.voiceCloneAudioDataUrl,
    audioFormat: conversion.audioFormat === "pcm16" ? "pcm16" : "wav",
    timeoutMs: conversion.timeoutMs ?? 60_000,
    sampleRate: conversion.sampleRate ?? 24_000,
    channels: conversion.channels ?? 1,
    extraParams: conversion.extraParams ?? {}
  };
}

async function requestMimoTtsAudio(
  text: string,
  settings: MimoTtsSettings,
  deps: Pick<TtsPluginDeps, "fetch" | "appendLog">
): Promise<Uint8Array> {
  const requester = createOpenAIUpstreamRequester({
    baseURL: settings.baseURL,
    timeoutMs: settings.timeoutMs,
    fetchImpl: deps.fetch
  });
  deps.appendLog?.("info", `tts MiMo ${settings.mode} start: chars=${Array.from(text).length}`);
  return requester({
    path: "/chat/completions",
    callContext: { agentId: "tts" },
    init: {
      method: "POST",
      headers: {
        "api-key": settings.apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify(mimoTtsRequestBody(text, settings))
    },
    async consume(response) {
      if (!response.ok) {
        throw new Error(`MiMo TTS HTTP error ${response.status}: ${await response.text()}`);
      }
      const data = parseJsonObject(await response.text());
      const audio = parseMimoAudioData(data);
      if (!audio) throw new Error("MiMo TTS returned no audio data");
      return new Uint8Array(Buffer.from(audio, "base64"));
    }
  });
}

function mimoTtsRequestBody(text: string, settings: MimoTtsSettings): Record<string, unknown> {
  return {
    ...settings.extraParams,
    model: settings.model,
    messages: mimoTtsMessages(text, settings),
    audio: {
      format: settings.audioFormat,
      ...(settings.mode === "preset" ? { voice: settings.voice } : {}),
      ...(settings.mode === "voiceclone" ? { voice: settings.voiceCloneAudioDataUrl } : {})
    }
  };
}

function mimoTtsMessages(text: string, settings: MimoTtsSettings): Array<{ role: "user" | "assistant"; content: string }> {
  if (settings.mode === "voicedesign") {
    return [
      { role: "user", content: settings.voiceDesignPrompt! },
      { role: "assistant", content: text }
    ];
  }
  return [{ role: "assistant", content: text }];
}

function parseMimoAudioData(value: Record<string, unknown>): string | undefined {
  const choices = Array.isArray(value.choices) ? value.choices : [];
  for (const choice of choices) {
    const message = parseJsonObject(parseJsonObject(choice).message);
    const audio = parseJsonObject(message.audio);
    const data = stringValue(audio.data);
    if (data) return data;
  }
  return undefined;
}

function normalizeMimoBaseURL(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) return defaultMimoTtsBaseURL;
  return normalized.endsWith("/chat/completions")
    ? normalized.slice(0, -"/chat/completions".length).replace(/\/+$/, "")
    : normalized;
}

type BailianTtsSettings = {
  service: "qwen" | "cosy";
  endpoint: string;
  apiKey: string;
  workspaceId?: string;
  userAgent?: string;
  model: string;
  voice: string;
  languageType: string;
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
  const conversion = selectedTtsPreset(config).bailian ?? {};
  const env = deps.env ?? process.env;
  const apiKey = conversion.apiKey || (conversion.apiKeyEnv ? env[conversion.apiKeyEnv] : undefined) || env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("Bailian TTS conversion requires apiKey or DASHSCOPE_API_KEY");
  const service = conversion.service === "cosy" ? "cosy" : "qwen";
  return {
    service,
    endpoint: conversion.endpoint || defaultBailianTtsEndpoint(service),
    apiKey,
    workspaceId: conversion.workspaceId,
    userAgent: conversion.userAgent,
    model: conversion.model || "qwen3-tts-vc-2026-01-22",
    voice: conversion.voice || "Cherry",
    languageType: conversion.languageType || "Chinese",
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
  deps.appendLog?.("info", `tts Bailian ${settings.service} stream start: chars=${Array.from(text).length}`);
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
      body: JSON.stringify(bailianTtsRequestBody(text, settings))
    });
    if (!response.ok) {
      throw new Error(`Bailian TTS HTTP error ${response.status}: ${await response.text()}`);
    }
    let chunks = 0;
    let bytes = 0;
    for await (const event of readBailianAudioEvents(response)) {
      const error = event.json ? parseBailianHttpError(event.json) : undefined;
      if (error) throw error;
      const audio = event.audio ?? (event.json ? bailianHttpAudioData(event.json) : undefined);
      if (audio?.byteLength) {
        chunks += 1;
        bytes += audio.byteLength;
        yield audio;
      }
    }
    if (bytes <= 0) throw new Error("Bailian TTS returned no audio data");
    deps.appendLog?.("info", `tts Bailian ${settings.service} stream complete: chunks=${chunks} bytes=${bytes}`);
  } finally {
    clearTimeout(timeout);
  }
}

function bailianTtsRequestBody(text: string, settings: BailianTtsSettings): Record<string, unknown> {
  if (settings.service === "cosy") {
    return {
      model: settings.model,
      input: { text },
      parameters: {
        ...settings.extraParams,
        voice: settings.voice,
        format: settings.responseFormat,
        sample_rate: settings.sampleRate
      }
    };
  }
  return {
    model: settings.model,
    input: {
      ...settings.extraParams,
      text,
      voice: settings.voice,
      language_type: settings.languageType
    }
  };
}

async function* readBailianAudioEvents(response: Response): AsyncIterable<{ json?: Record<string, unknown>; audio?: Uint8Array }> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.startsWith("audio/") || contentType.includes("octet-stream")) {
    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength) yield { audio };
    return;
  }
  if (contentType.includes("application/json")) {
    const json = parseJsonObject(await response.text());
    if (Object.keys(json).length) yield { json };
    return;
  }
  for await (const json of readBailianSseEvents(response)) yield { json };
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
