const fs = await import("node:fs");
const path = await import("node:path");
const crypto = await import("node:crypto");
const os = await import("node:os");
const childProcess = await import("node:child_process");
const moduleApi = await import("node:module");
const require = moduleApi.createRequire(import.meta.url);
import type {
  InboundAudioStreamAbortFrame,
  InboundAudioStreamChunkFrame,
  InboundAudioStreamEndFrame,
  InboundAudioStreamFrame,
  InboundAudioStreamStartFrame
} from "../../../packages/types/src/index.js";
import { sanitizeAudioTranscript } from "../../../packages/types/src/index.js";

const tencentLocalAudioUploadLimitBytes = 5 * 1024 * 1024;
const defaultPseudoStreamMinPauseMs = 1500;

export type AsrProvider = "tencent" | "openai_compatible";
export type AsrResponseFormat = "json" | "text" | "verbose_json";

export type AsrApiPreset = {
  name?: string;
  baseURL: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
  stream?: boolean;
  extraParams?: Record<string, unknown>;
  followupExtraParams?: Record<string, unknown>;
};

export type AsrPluginConfig = {
  enabled: boolean;
  defaultProvider: AsrProvider;
  testAudioPath?: string;
  pseudoStreamMinPauseMs?: number;
  providers: {
    openaiCompatible?: {
      apiPresetName?: string;
      responseFormat?: AsrResponseFormat;
      retryCount?: number;
      retryBackoffMs?: number;
    };
    tencent?: {
      appId?: string;
      secretId?: string;
      secretKey?: string;
      endpoint?: string;
      region?: string;
      engineModelType?: string;
      realtimeVoiceFormat?: number;
      realtimeNeedVad?: number;
      pollIntervalMs?: number;
      timeoutMs?: number;
      retryCount?: number;
      retryBackoffMs?: number;
      maxChunkBytes?: number;
      splitSilenceThresholdDb?: number;
      splitMinSilenceMs?: number;
    };
  };
};

export type AsrTranscribeInput = {
  audioFile: File | Blob | Uint8Array | string;
  filename?: string;
  mimeType?: string;
  language?: string;
  provider?: AsrProvider;
  prompt?: string;
  metadata?: Record<string, unknown>;
};

export type AsrTranscribeResult = {
  text: string;
  provider: AsrProvider;
  model?: string;
  language?: string;
  durationMs?: number;
  requestId?: string;
  raw?: unknown;
  rawStream?: {
    streamId: string;
    chunks: number;
    bytes: number;
    metadata?: Record<string, unknown>;
  };
};

export type AsrTranscribeError = {
  ok: false;
  error:
    | "asr_disabled"
    | "missing_audio_file"
    | "unsupported_audio_format"
    | "missing_provider_config"
    | "provider_request_failed"
    | "empty_transcription"
    | "timeout";
  message?: string;
  provider?: AsrProvider;
  requestId?: string;
};

export type AsrPluginDeps = {
  configPath?: string;
  fetch?: typeof fetch;
  createWebSocket?(url: string): AsrWebSocketLike | Promise<AsrWebSocketLike>;
  env?: Record<string, string | undefined>;
  resolveApiPreset?(name: string): AsrApiPreset | undefined;
  sleep?(ms: number): Promise<void>;
  splitAudio?(input: AsrSplitAudioInput): Promise<AsrAudioChunk[]>;
  now?(): Date;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
};

export type AsrWebSocketLike = {
  readyState?: number;
  send(data: string | Uint8Array): void | Promise<void>;
  close?(): void;
  addEventListener?(type: "message" | "error" | "close" | "open", listener: (event: { data?: unknown; error?: unknown }) => void): void;
  on?(type: "message" | "error" | "close" | "open", listener: (data: unknown) => void): void;
};

export type AsrAudioChunk = {
  bytes: Uint8Array;
  filename: string;
};

export type AsrSplitAudioInput = {
  filePath: string;
  maxChunkBytes: number;
  silenceThresholdDb: number;
  minSilenceMs: number;
};

export type AsrPlugin = {
  id: "asr";
  config: AsrPluginConfig;
  transcribe(input: AsrTranscribeInput): Promise<AsrTranscribeResult | AsrTranscribeError>;
};

export type AsrInboundStreamAccepted = {
  ok: true;
  type: "ack";
  streamId: string;
  sequence: number;
};

export type AsrInboundStreamFinal = {
  ok: true;
  type: "final";
  streamId: string;
  result: AsrTranscribeResult;
};

export type AsrInboundStreamAborted = {
  ok: true;
  type: "aborted";
  streamId: string;
  reason?: string;
};

export type AsrInboundStreamPartial = {
  ok: true;
  type: "partial";
  streamId: string;
  text: string;
  stable: boolean;
  raw?: unknown;
};

export type AsrInboundStreamError = {
  ok: false;
  type: "error";
  streamId: string;
  error: "stream_id_mismatch" | "out_of_order_chunk" | "stream_closed" | "empty_stream" | AsrTranscribeError["error"];
  message?: string;
};

export type AsrInboundStreamAcceptResult =
  | AsrInboundStreamAccepted
  | AsrInboundStreamPartial
  | AsrInboundStreamFinal
  | AsrInboundStreamAborted
  | AsrInboundStreamError;

export type AsrInboundStreamSession = {
  streamId: string;
  accept(frame: Exclude<InboundAudioStreamFrame, InboundAudioStreamStartFrame>): Promise<AsrInboundStreamAcceptResult>;
};

const defaultConfigPath = "config/plugin/asr/config.json";
const legacyConfigPath = "plugins/asr/config.json";

export function createAsrPlugin(deps: AsrPluginDeps = {}): AsrPlugin {
  return {
    id: "asr",
    config: readAsrPluginConfig(deps.configPath),
    transcribe(input) {
      return transcribeWithAsrPlugin(input, readAsrPluginConfig(deps.configPath), deps);
    }
  };
}

export function createAsrInboundStreamSession(
  start: InboundAudioStreamStartFrame,
  config: AsrPluginConfig,
  deps: AsrPluginDeps = {}
): AsrInboundStreamSession {
  const provider = start.provider ?? config.defaultProvider;
  if (provider === "tencent" && config.providers.tencent?.appId) {
    return createTencentRealtimeInboundStreamSession(start, config, deps);
  }

  let currentChunks: InboundAudioStreamChunkFrame[] = [];
  const completedTexts: string[] = [];
  let totalChunks = 0;
  let totalBytes = 0;
  let expectedSequence = 0;
  let closed = false;

  return {
    streamId: start.streamId,
    async accept(frame): Promise<AsrInboundStreamAcceptResult> {
      if (frame.streamId !== start.streamId) return streamError(start.streamId, "stream_id_mismatch");
      if (closed) return streamError(start.streamId, "stream_closed");
      if (frame.type === "abort") {
        closed = true;
        return abortStream(start.streamId, frame);
      }
      if (frame.type === "chunk") {
        if (frame.sequence !== expectedSequence) return streamError(start.streamId, "out_of_order_chunk");
        const chunk = copyInboundChunk(frame);
        const shouldFlush = currentChunks.length > 0 && isConservativeLongPause(currentChunks[currentChunks.length - 1], chunk, config.pseudoStreamMinPauseMs);
        if (shouldFlush) {
          const partial = await transcribePseudoStreamSegment(start, currentChunks, config, deps);
          if ("ok" in partial) return streamError(start.streamId, partial.error, partial.message);
          const partialResult = partial;
          const text = sanitizeAudioTranscript(partialResult.text);
          if (text) completedTexts.push(text);
          currentChunks = [chunk];
          totalChunks += 1;
          totalBytes += chunk.bytes.byteLength;
          expectedSequence += 1;
          return {
            ok: true,
            type: "partial",
            streamId: start.streamId,
            text,
            stable: true,
            raw: partialResult.raw
          };
        }
        currentChunks.push(chunk);
        totalChunks += 1;
        totalBytes += chunk.bytes.byteLength;
        expectedSequence += 1;
        return { ok: true, type: "ack", streamId: start.streamId, sequence: frame.sequence };
      }
      if (frame.type === "end") {
        closed = true;
        if (!currentChunks.length && !completedTexts.length) return streamError(start.streamId, "empty_stream");
        let finalResult: AsrTranscribeResult | undefined;
        if (currentChunks.length) {
          const result = await transcribePseudoStreamSegment(start, currentChunks, config, deps, frame.metadata);
          if ("ok" in result) {
            return streamError(start.streamId, result.error, result.message);
          }
          finalResult = result;
          const text = sanitizeAudioTranscript(finalResult.text);
          if (text) completedTexts.push(text);
        }
        const text = completedTexts.join("\n");
        if (!text) return streamError(start.streamId, "empty_transcription");
        return {
          ok: true,
          type: "final",
          streamId: start.streamId,
          result: {
            ...(finalResult ?? {
              provider: start.provider ?? config.defaultProvider
            }),
            text,
            rawStream: {
              streamId: start.streamId,
              chunks: totalChunks,
              bytes: totalBytes,
              metadata: {
                mode: "pseudo_stream",
                ...start.metadata,
                ...frame.metadata
              }
            }
          }
        };
      }
      return streamError(start.streamId, "stream_closed");
    }
  };
}

async function transcribePseudoStreamSegment(
  start: InboundAudioStreamStartFrame,
  chunks: InboundAudioStreamChunkFrame[],
  config: AsrPluginConfig,
  deps: AsrPluginDeps,
  metadata?: Record<string, unknown>
): Promise<AsrTranscribeResult | AsrTranscribeError> {
  return transcribeWithAsrPlugin({
    audioFile: concatAudioStreamChunks(chunks),
    filename: start.audio.filename,
    mimeType: start.audio.mimeType,
    language: start.language,
    provider: start.provider,
    prompt: start.prompt,
    metadata: {
      ...start.metadata,
      ...metadata,
      streamId: start.streamId,
      audio: start.audio,
      mode: "pseudo_stream",
      chunks: chunks.map((chunk) => ({
        sequence: chunk.sequence,
        bytes: chunk.bytes.byteLength,
        timing: chunk.timing,
        metadata: chunk.metadata
      }))
    }
  }, config, deps);
}

function isConservativeLongPause(previous: InboundAudioStreamChunkFrame | undefined, next: InboundAudioStreamChunkFrame, minPauseMs = defaultPseudoStreamMinPauseMs): boolean {
  const previousEnd = previous?.timing?.endMs;
  const nextStart = next.timing?.startMs;
  return typeof previousEnd === "number"
    && typeof nextStart === "number"
    && nextStart - previousEnd >= minPauseMs;
}

function createTencentRealtimeInboundStreamSession(
  start: InboundAudioStreamStartFrame,
  config: AsrPluginConfig,
  deps: AsrPluginDeps
): AsrInboundStreamSession {
  const providerConfig = config.providers.tencent!;
  const timeoutMs = providerConfig.timeoutMs ?? 120_000;
  const messages: unknown[] = [];
  const waiters: Array<() => void> = [];
  const stableResults = new Map<number, string>();
  let latestPartial = "";
  let expectedSequence = 0;
  let closed = false;
  let socketClosed = false;
  let finalReceived = false;

  const socketPromise = Promise.resolve(createTencentRealtimeSocket(start, providerConfig, deps)).then(async (socket) => {
    addSocketListener(socket, "message", (event) => {
      messages.push(socketMessageData(event));
      notifyMessageWaiters(waiters);
    });
    addSocketListener(socket, "close", () => {
      socketClosed = true;
      notifyMessageWaiters(waiters);
    });
    addSocketListener(socket, "error", () => {
      socketClosed = true;
      notifyMessageWaiters(waiters);
    });
    await waitForSocketOpen(socket, Math.min(timeoutMs, 10_000));
    return socket;
  });

  return {
    streamId: start.streamId,
    async accept(frame): Promise<AsrInboundStreamAcceptResult> {
      if (frame.streamId !== start.streamId) return streamError(start.streamId, "stream_id_mismatch");
      if (closed) return streamError(start.streamId, "stream_closed");
      const socket = await socketPromise;
      if (frame.type === "abort") {
        closed = true;
        socket.close?.();
        return abortStream(start.streamId, frame);
      }
      if (frame.type === "chunk") {
        if (frame.sequence !== expectedSequence) return streamError(start.streamId, "out_of_order_chunk");
        expectedSequence += 1;
        await Promise.resolve(socket.send(frame.bytes));
        return drainTencentRealtimeMessages(start.streamId, messages, stableResults, (text) => {
          latestPartial = text;
        }) ?? { ok: true, type: "ack", streamId: start.streamId, sequence: frame.sequence };
      }
      if (frame.type === "end") {
        closed = true;
        await Promise.resolve(socket.send(JSON.stringify({ type: "end" })));
        let drained: AsrInboundStreamPartial | AsrInboundStreamError | undefined;
        const deadline = Date.now() + timeoutMs;
        do {
          if (!messages.length && !socketClosed) await waitForSocketMessage(waiters, Math.min(1000, Math.max(0, deadline - Date.now())));
          drained = drainTencentRealtimeMessages(start.streamId, messages, stableResults, (text) => {
            latestPartial = text;
          }, () => {
            finalReceived = true;
          });
          if (drained && drained.ok === false) break;
        } while (!finalReceived && !socketClosed && Date.now() < deadline);
        socket.close?.();
        if (drained && drained.ok === false) return drained;
        const text = sanitizeAudioTranscript([...stableResults.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, value]) => value)
          .join("") || latestPartial);
        if (!text) return streamError(start.streamId, "empty_transcription");
        return {
          ok: true,
          type: "final",
          streamId: start.streamId,
          result: {
            text,
            provider: "tencent",
            model: providerConfig.engineModelType || "16k_zh",
            rawStream: {
              streamId: start.streamId,
              chunks: expectedSequence,
              bytes: 0,
              metadata: {
                mode: "native_stream",
                ...start.metadata,
                ...frame.metadata
              }
            }
          }
        };
      }
      return streamError(start.streamId, "stream_closed");
    }
  };
}

function createTencentRealtimeSocket(
  start: InboundAudioStreamStartFrame,
  providerConfig: NonNullable<AsrPluginConfig["providers"]["tencent"]>,
  deps: AsrPluginDeps
): AsrWebSocketLike | Promise<AsrWebSocketLike> {
  const url = tencentRealtimeWebSocketUrl(start, providerConfig, deps);
  if (deps.createWebSocket) return deps.createWebSocket(url);
  const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => AsrWebSocketLike }).WebSocket;
  if (WebSocketCtor) return new WebSocketCtor(url);
  try {
    const wsModule = require("ws") as { WebSocket?: new (url: string) => AsrWebSocketLike } | (new (url: string) => AsrWebSocketLike);
    const Ws = typeof wsModule === "function" ? wsModule : wsModule.WebSocket;
    if (Ws) return new Ws(url);
  } catch {
    // fall through
  }
  throw new AsrConfigError("missing_provider_config");
}

function drainTencentRealtimeMessages(
  streamId: string,
  messages: unknown[],
  stableResults: Map<number, string>,
  onPartial: (text: string) => void,
  onFinal?: () => void
): AsrInboundStreamPartial | AsrInboundStreamError | undefined {
  let latest: AsrInboundStreamPartial | AsrInboundStreamError | undefined;
  while (messages.length) {
    const raw = messages.shift();
    const parsed = parseJsonObject(socketTextMessage(raw));
    const code = numberValue(parsed.code, 0);
    if (code !== 0) return streamError(streamId, "provider_request_failed", stringValue(parsed.message));
    if (numberValue(parsed.final, 0) === 1) {
      onFinal?.();
      continue;
    }
    const result = parseJsonObject(parsed.result);
    const text = sanitizeAudioTranscript(stringValue(result.voice_text_str));
    if (!text) continue;
    const index = numberValue(result.index, stableResults.size);
    const sliceType = numberValue(result.slice_type, 1);
    const stable = sliceType === 2;
    if (stable) stableResults.set(index, text);
    onPartial(text);
    latest = {
      ok: true,
      type: "partial",
      streamId,
      text,
      stable,
      raw: parsed
    };
  }
  return latest;
}

function socketTextMessage(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return (Buffer as any).from(raw.slice()).toString("utf8");
  return String(raw ?? "");
}

function notifyMessageWaiters(waiters: Array<() => void>): void {
  for (const waiter of waiters.splice(0)) waiter();
}

function waitForSocketMessage(waiters: Array<() => void>, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    waiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function waitForSocketOpen(socket: AsrWebSocketLike, timeoutMs: number): Promise<void> {
  if (socket.readyState === undefined || socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tencent_realtime_socket_open_timeout")), timeoutMs);
    addSocketListener(socket, "open", () => {
      clearTimeout(timer);
      resolve();
    });
    addSocketListener(socket, "error", (event) => {
      clearTimeout(timer);
      reject(new Error(`tencent_realtime_socket_error:${String(event.error ?? "")}`));
    });
  });
}

function addSocketListener(socket: AsrWebSocketLike, type: "message" | "error" | "close" | "open", listener: (event: { data?: unknown; error?: unknown }) => void): void {
  if (socket.addEventListener) {
    socket.addEventListener(type, listener);
    return;
  }
  socket.on?.(type, (data) => listener({ data }));
}

function socketMessageData(event: { data?: unknown }): unknown {
  return event.data;
}

function tencentRealtimeWebSocketUrl(
  start: InboundAudioStreamStartFrame,
  providerConfig: NonNullable<AsrPluginConfig["providers"]["tencent"]>,
  deps: AsrPluginDeps
): string {
  const appId = providerConfig.appId;
  const secretId = providerConfig.secretId;
  const secretKey = providerConfig.secretKey;
  if (!appId || !secretId || !secretKey) throw new AsrConfigError("missing_provider_config");
  const host = "asr.cloud.tencent.com";
  const route = `/asr/v2/${appId}`;
  const timestamp = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
  const params: Record<string, string> = {
    engine_model_type: providerConfig.engineModelType || "16k_zh",
    expired: String(timestamp + 24 * 60 * 60),
    needvad: String(providerConfig.realtimeNeedVad ?? 1),
    nonce: String(Math.abs(hashToInt(start.streamId)) % 1_000_000_000),
    secretid: secretId,
    timestamp: String(timestamp),
    voice_format: String(providerConfig.realtimeVoiceFormat ?? voiceFormatForStream(start)),
    voice_id: start.streamId
  };
  const canonical = canonicalQuery(params);
  const signature = hmacSha1Base64(secretKey, `${host}${route}?${canonical}`);
  return `wss://${host}${route}?${canonical}&signature=${encodeURIComponent(signature)}`;
}

function voiceFormatForStream(start: InboundAudioStreamStartFrame): number {
  const encoding = `${start.audio.encoding ?? start.audio.mimeType ?? start.audio.filename ?? ""}`.toLowerCase();
  if (encoding.includes("pcm")) return 1;
  if (encoding.includes("silk")) return 6;
  if (encoding.includes("mp3")) return 8;
  if (encoding.includes("opus")) return 10;
  if (encoding.includes("wav")) return 12;
  if (encoding.includes("m4a")) return 14;
  if (encoding.includes("aac")) return 16;
  return 12;
}

export function readAsrPluginConfig(configPath = defaultConfigPath): AsrPluginConfig {
  const resolved = resolveAsrConfigReadPath(configPath);
  const parsed = parseJsonObject(fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "{}");
  const providers = parseJsonObject(parsed.providers);
  return {
    enabled: booleanValue(parsed.enabled, false),
    defaultProvider: asrProviderValue(parsed.defaultProvider) ?? "openai_compatible",
    testAudioPath: stringValue(parsed.testAudioPath),
    pseudoStreamMinPauseMs: numberValue(parsed.pseudoStreamMinPauseMs, undefined),
    providers: {
      openaiCompatible: parseOpenAiCompatibleConfig(providers.openaiCompatible),
      tencent: parseTencentConfig(providers.tencent)
    }
  };
}

function resolveAsrConfigReadPath(configPath = defaultConfigPath): string {
  const resolved = path.resolve(configPath);
  if (fs.existsSync(resolved)) return resolved;
  const defaultResolved = path.resolve(defaultConfigPath);
  const legacyResolved = path.resolve(legacyConfigPath);
  if (resolved === defaultResolved && fs.existsSync(legacyResolved)) return legacyResolved;
  const expectedSuffix = path.join("config", "plugin", "asr", "config.json");
  if (resolved.endsWith(expectedSuffix)) {
    const root = resolved.slice(0, -expectedSuffix.length);
    const siblingLegacy = path.join(root || path.parse(resolved).root, "plugins", "asr", "config.json");
    if (fs.existsSync(siblingLegacy)) return siblingLegacy;
  }
  return resolved;
}

export async function transcribeWithAsrPlugin(
  input: AsrTranscribeInput,
  config: AsrPluginConfig,
  deps: AsrPluginDeps = {}
): Promise<AsrTranscribeResult | AsrTranscribeError> {
  const provider = input.provider ?? config.defaultProvider;
  const startedAt = Date.now();
  if (!config.enabled) return { ok: false, error: "asr_disabled", provider };
  if (!input.audioFile) return { ok: false, error: "missing_audio_file", provider };

  try {
    const result = provider === "tencent"
      ? await transcribeTencent(input, config, deps)
      : await transcribeOpenAiCompatible(input, config, deps);
    const text = result.text.trim();
    if (!text) return { ok: false, error: "empty_transcription", provider, requestId: result.requestId };
    return {
      ...result,
      text,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    if (error instanceof AsrConfigError) return { ok: false, error: error.code, provider };
    const message = error instanceof Error ? error.message : String(error);
    deps.appendLog?.("warn", `asr ${provider} failed: ${message}`);
    return {
      ok: false,
      error: message === "timeout" ? "timeout" : "provider_request_failed",
      provider,
      message
    };
  }
}

async function transcribeOpenAiCompatible(input: AsrTranscribeInput, config: AsrPluginConfig, deps: AsrPluginDeps): Promise<AsrTranscribeResult> {
  const providerConfig = config.providers.openaiCompatible;
  const preset = providerConfig?.apiPresetName ? deps.resolveApiPreset?.(providerConfig.apiPresetName) : undefined;
  const apiKey = preset?.apiKey;
  const model = preset?.model;
  if (!providerConfig?.apiPresetName || !preset?.baseURL || !apiKey || !model) {
    throw new AsrConfigError("missing_provider_config");
  }

  const audio = await readAudioInput(input);
  const form = new FormData();
  form.append("file", new Blob([bufferToArrayBuffer(audio.bytes)], { type: input.mimeType || mimeTypeForFileName(audio.filename) }), input.filename || audio.filename);
  form.append("model", model);
  if (input.language) form.append("language", input.language);
  if (input.prompt) form.append("prompt", input.prompt);
  if (providerConfig.responseFormat) form.append("response_format", providerConfig.responseFormat);

  const response = await retryAsync(() => fetchWithTimeout(deps.fetch ?? fetch, `${preset.baseURL.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`
    },
    body: form
  }, preset.timeoutMs), retryOptions(providerConfig, deps));
  if (!response.ok) throw new Error(`openai_compatible_asr_failed:${response.status}:${await response.text()}`);

  const responseFormat = providerConfig.responseFormat ?? "json";
  const raw = responseFormat === "text" ? await response.text() : await response.json();
  const text = typeof raw === "string" ? raw : stringValue((raw as { text?: unknown }).text) ?? "";
  return {
    text,
    provider: "openai_compatible",
    model,
    language: input.language,
    raw
  };
}

async function transcribeTencent(input: AsrTranscribeInput, config: AsrPluginConfig, deps: AsrPluginDeps): Promise<AsrTranscribeResult> {
  const providerConfig = config.providers.tencent;
  const secretId = providerConfig?.secretId;
  const secretKey = providerConfig?.secretKey;
  const region = providerConfig?.region || "ap-guangzhou";
  const endpoint = providerConfig?.endpoint || "https://asr.tencentcloudapi.com";
  const engineModelType = providerConfig?.engineModelType || "16k_zh";
  if (!secretId || !secretKey || !engineModelType) {
    throw new AsrConfigError("missing_provider_config");
  }

  const chunks = await tencentAudioChunks(input, providerConfig, deps);
  const results: AsrTranscribeResult[] = [];
  for (const chunk of chunks) {
    results.push(await transcribeTencentChunk(chunk, providerConfig, { secretId, secretKey, region, endpoint, engineModelType }, deps));
  }
  return {
    text: results.map((entry) => entry.text.trim()).filter(Boolean).join("\n"),
    provider: "tencent",
    model: engineModelType,
    requestId: results.at(-1)?.requestId,
    raw: results.map((entry) => entry.raw)
  };
}

async function transcribeTencentChunk(
  audio: AsrAudioChunk,
  providerConfig: NonNullable<AsrPluginConfig["providers"]["tencent"]>,
  resolved: { secretId: string; secretKey: string; region: string; endpoint: string; engineModelType: string },
  deps: AsrPluginDeps
): Promise<AsrTranscribeResult> {
  if (audio.bytes.length > (providerConfig.maxChunkBytes ?? tencentLocalAudioUploadLimitBytes)) throw new AsrConfigError("unsupported_audio_format");
  const createPayload: Record<string, unknown> = {
    EngineModelType: resolved.engineModelType,
    ChannelNum: 1,
    ResTextFormat: 0,
    SourceType: 1,
    Data: base64FromBytes(audio.bytes),
    DataLen: audio.bytes.length
  };

  const timeoutMs = providerConfig.timeoutMs ?? 120_000;
  const retry = retryOptions(providerConfig, deps);
  const createRaw = await retryAsync(
    () => tencentRequest(resolved.endpoint, "CreateRecTask", createPayload, { secretId: resolved.secretId, secretKey: resolved.secretKey, region: resolved.region }, deps, timeoutMs),
    retry
  );
  const createResponse = parseTencentEnvelope(createRaw);
  const taskId = numberValue(parseJsonObject(createResponse.Data).TaskId, undefined);
  if (taskId === undefined) throw new Error("tencent_asr_missing_task_id");

  const pollIntervalMs = providerConfig.pollIntervalMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  let latestRequestId = stringValue(createResponse.RequestId);
  let latestRaw: unknown = createRaw;
  while (Date.now() <= deadline) {
    await (deps.sleep ?? sleep)(pollIntervalMs);
    const describeRaw = await retryAsync(
      () => tencentRequest(resolved.endpoint, "DescribeTaskStatus", { TaskId: taskId }, { secretId: resolved.secretId, secretKey: resolved.secretKey, region: resolved.region }, deps, timeoutMs),
      retry
    );
    latestRaw = describeRaw;
    const describeResponse = parseTencentEnvelope(describeRaw);
    latestRequestId = stringValue(describeResponse.RequestId) ?? latestRequestId;
    const data = parseJsonObject(describeResponse.Data);
    const status = numberValue(data.Status, undefined);
    if (status === 2) {
      return {
        text: stringValue(data.Result) ?? tencentResultDetailText(data.ResultDetail) ?? "",
        provider: "tencent",
        model: resolved.engineModelType,
        requestId: latestRequestId,
        raw: describeRaw
      };
    }
    if (status === 3) throw new Error(`tencent_asr_failed:${stringValue(data.ErrorMsg) ?? "unknown"}`);
  }
  throw new Error("timeout");
}

async function tencentAudioChunks(
  input: AsrTranscribeInput,
  providerConfig: NonNullable<AsrPluginConfig["providers"]["tencent"]>,
  deps: AsrPluginDeps
): Promise<AsrAudioChunk[]> {
  const audio = await readAudioInput(input);
  const maxChunkBytes = providerConfig.maxChunkBytes ?? tencentLocalAudioUploadLimitBytes;
  if (audio.bytes.length <= maxChunkBytes) return [audio];
  if (typeof input.audioFile !== "string") throw new AsrConfigError("unsupported_audio_format");
  const splitter = deps.splitAudio ?? splitAudioWithFfmpeg;
  const chunks = await splitter({
    filePath: input.audioFile,
    maxChunkBytes,
    silenceThresholdDb: providerConfig.splitSilenceThresholdDb ?? -35,
    minSilenceMs: providerConfig.splitMinSilenceMs ?? 700
  });
  if (!chunks.length) throw new AsrConfigError("unsupported_audio_format");
  return chunks;
}

async function tencentRequest(
  baseURL: string,
  action: string,
  payload: Record<string, unknown>,
  credentials: { secretId: string; secretKey: string; region: string },
  deps: AsrPluginDeps,
  timeoutMs: number
): Promise<unknown> {
  const endpoint = baseURL.replace(/\/+$/, "") || "https://asr.tencentcloudapi.com";
  const url = new URL(endpoint);
  const body = JSON.stringify(payload);
  const now = deps.now?.() ?? new Date();
  const timestamp = Math.floor(now.getTime() / 1000);
  const date = now.toISOString().slice(0, 10);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    host: url.host,
    "x-tc-action": action,
    "x-tc-region": credentials.region,
    "x-tc-timestamp": String(timestamp),
    "x-tc-version": "2019-06-14",
    authorization: tencentAuthorization({
      body,
      date,
      host: url.host,
      secretId: credentials.secretId,
      secretKey: credentials.secretKey,
      service: "asr",
      timestamp
    })
  };
  const response = await fetchWithTimeout(deps.fetch ?? fetch, endpoint, {
    method: "POST",
    headers,
    body
  }, timeoutMs);
  if (!response.ok) throw new Error(`tencent_asr_http_failed:${response.status}:${await response.text()}`);
  return response.json();
}

function tencentAuthorization(input: {
  body: string;
  date: string;
  host: string;
  secretId: string;
  secretKey: string;
  service: string;
  timestamp: number;
}): string {
  const hashedPayload = sha256Hex(input.body);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${input.host}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    hashedPayload
  ].join("\n");
  const credentialScope = `${input.date}/${input.service}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(input.timestamp),
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");
  const secretDate = hmacSha256(`TC3${input.secretKey}`, input.date);
  const secretService = hmacSha256(secretDate, input.service);
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = hmacSha256Hex(secretSigning, stringToSign);
  return `TC3-HMAC-SHA256 Credential=${input.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function readAudioInput(input: AsrTranscribeInput): Promise<{ bytes: Uint8Array; filename: string }> {
  const audioFile = input.audioFile;
  if (typeof audioFile === "string") {
    if (!fs.existsSync(audioFile)) throw new AsrConfigError("missing_audio_file");
    const stats = fs.statSync(audioFile);
    if (!stats.isFile() || stats.size <= 0) throw new AsrConfigError("missing_audio_file");
    return { bytes: fs.readFileSync(audioFile), filename: input.filename || path.basename(audioFile) };
  }
  if (audioFile instanceof Uint8Array) return { bytes: audioFile, filename: input.filename || "audio" };
  if (audioFile instanceof Blob) {
    const bytes = (Buffer as any).from(await audioFile.arrayBuffer()) as Uint8Array;
    return { bytes, filename: input.filename || ("name" in audioFile && typeof audioFile.name === "string" ? audioFile.name : "audio") };
  }
  throw new AsrConfigError("unsupported_audio_format");
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

function copyInboundChunk(frame: InboundAudioStreamChunkFrame): InboundAudioStreamChunkFrame {
  const bytes = new Uint8Array(frame.bytes.byteLength);
  bytes.set(frame.bytes);
  return {
    ...frame,
    bytes,
    timing: frame.timing ? { ...frame.timing } : undefined,
    metadata: frame.metadata ? { ...frame.metadata } : undefined
  };
}

function concatAudioStreamChunks(chunks: InboundAudioStreamChunkFrame[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk.bytes, offset);
    offset += chunk.bytes.byteLength;
  }
  return merged;
}

function abortStream(streamId: string, frame: InboundAudioStreamAbortFrame): AsrInboundStreamAborted {
  return {
    ok: true,
    type: "aborted",
    streamId,
    reason: frame.reason
  };
}

function streamError(streamId: string, error: AsrInboundStreamError["error"], message?: string): AsrInboundStreamError {
  return {
    ok: false,
    type: "error",
    streamId,
    error,
    ...(message ? { message } : {})
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

function parseTencentEnvelope(raw: unknown): Record<string, unknown> {
  const response = parseJsonObject(parseJsonObject(raw).Response);
  const error = parseJsonObject(response.Error);
  if (error.Code || error.Message) throw new Error(`tencent_asr_error:${stringValue(error.Code) ?? "unknown"}:${stringValue(error.Message) ?? ""}`);
  return response;
}

function tencentResultDetailText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => stringValue(parseJsonObject(entry).FinalSentence) ?? stringValue(parseJsonObject(entry).SliceSentence))
    .filter(Boolean)
    .join("");
}

function mimeTypeForFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a" || ext === ".mp4") return "audio/mp4";
  if (ext === ".ogg") return "audio/ogg";
  return "application/octet-stream";
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return parseJsonObject(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asrProviderValue(value: unknown): AsrProvider | undefined {
  return value === "tencent" || value === "openai_compatible" ? value : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number;
function numberValue(value: unknown, fallback: undefined): number | undefined;
function numberValue(value: unknown, fallback: number | undefined): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function hashToInt(value: string): number {
  const hash = crypto.createHash("sha1").update(value).digest();
  return ((hash[0] ?? 0) << 24) + ((hash[1] ?? 0) << 16) + ((hash[2] ?? 0) << 8) + (hash[3] ?? 0);
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key: string | Uint8Array, value: string): any {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function hmacSha256Hex(key: string | Uint8Array, value: string): string {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

function hmacSha1Base64(key: string, value: string): string {
  return crypto.createHmac("sha1", key).update(value).digest("base64");
}

function bufferToArrayBuffer(buffer: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

function base64FromBytes(bytes: Uint8Array): string {
  return (Buffer as any).from(bytes).toString("base64");
}

function retryOptions(
  config: { retryCount?: number; retryBackoffMs?: number },
  deps: AsrPluginDeps
): { count: number; backoffMs: number; sleep: (ms: number) => Promise<void> } {
  return {
    count: config.retryCount ?? 1,
    backoffMs: config.retryBackoffMs ?? 500,
    sleep: deps.sleep ?? sleep
  };
}

async function retryAsync<T>(
  run: () => Promise<T>,
  options: { count: number; backoffMs: number; sleep: (ms: number) => Promise<void> }
): Promise<T> {
  let latestError: unknown;
  for (let attempt = 0; attempt <= options.count; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      latestError = error;
      if (attempt >= options.count || !isRetryableAsrError(error)) break;
      await options.sleep(options.backoffMs * Math.max(1, attempt + 1));
    }
  }
  throw latestError;
}

function isRetryableAsrError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === "timeout" || /timeout|network|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|5\d\d/i.test(message);
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number | undefined): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) return fetchImpl(url, init);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function splitAudioWithFfmpeg(input: AsrSplitAudioInput): Promise<AsrAudioChunk[]> {
  const ffmpeg = resolveFfmpegCommand();
  const stat = fs.statSync(input.filePath);
  if (!stat.isFile() || stat.size <= 0) throw new AsrConfigError("missing_audio_file");
  const durationSeconds = await readAudioDurationSeconds(ffmpeg, input.filePath);
  if (!durationSeconds || durationSeconds <= 0) throw new AsrConfigError("unsupported_audio_format");
  const silenceEnds = await detectSilenceEnds(ffmpeg, input.filePath, input.silenceThresholdDb, input.minSilenceMs);
  const chunkRanges = buildChunkRanges(durationSeconds, stat.size, input.maxChunkBytes, silenceEnds);
  const tempDir = path.join(os.tmpdir(), `alice-asr-split-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    const chunks: AsrAudioChunk[] = [];
    for (let index = 0; index < chunkRanges.length; index += 1) {
      const range = chunkRanges[index];
      const outPath = path.join(tempDir, `chunk-${String(index + 1).padStart(4, "0")}.wav`);
      await runFfmpeg(ffmpeg, [
        "-hide_banner",
        "-loglevel", "error",
        "-ss", String(range.start),
        "-to", String(range.end),
        "-i", input.filePath,
        "-ac", "1",
        "-ar", "16000",
        "-y",
        outPath
      ]);
      const bytes = fs.readFileSync(outPath);
      if (bytes.length > input.maxChunkBytes) {
        const smaller = buildEvenChunkRanges(range.end - range.start, bytes.length, input.maxChunkBytes)
          .map((entry) => ({ start: range.start + entry.start, end: range.start + entry.end }));
        for (const subRange of smaller) {
          const subPath = path.join(tempDir, `chunk-${String(chunks.length + 1).padStart(4, "0")}.wav`);
          await runFfmpeg(ffmpeg, [
            "-hide_banner",
            "-loglevel", "error",
            "-ss", String(subRange.start),
            "-to", String(subRange.end),
            "-i", input.filePath,
            "-ac", "1",
            "-ar", "16000",
            "-y",
            subPath
          ]);
          const subBytes = fs.readFileSync(subPath);
          if (subBytes.length > input.maxChunkBytes) throw new AsrConfigError("unsupported_audio_format");
          chunks.push({ bytes: subBytes, filename: path.basename(subPath) });
        }
      } else if (bytes.length > 0) {
        chunks.push({ bytes, filename: path.basename(outPath) });
      }
    }
    return chunks;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function resolveFfmpegCommand(): string {
  try {
    const ffmpegStatic = require("ffmpeg-static") as string | undefined;
    if (ffmpegStatic) return ffmpegStatic;
  } catch {
    // Fall through to PATH lookup.
  }
  return "ffmpeg";
}

async function readAudioDurationSeconds(ffmpeg: string, filePath: string): Promise<number | undefined> {
  const result = await runFfmpegCapture(ffmpeg, ["-hide_banner", "-i", filePath]);
  const match = result.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function detectSilenceEnds(ffmpeg: string, filePath: string, thresholdDb: number, minSilenceMs: number): Promise<number[]> {
  const result = await runFfmpegCapture(ffmpeg, [
    "-hide_banner",
    "-i", filePath,
    "-af", `silencedetect=noise=${thresholdDb}dB:d=${Math.max(0.1, minSilenceMs / 1000)}`,
    "-f", "null",
    "-"
  ]);
  return Array.from(result.stderr.matchAll(/silence_end:\s*([0-9.]+)/g))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
}

function buildChunkRanges(durationSeconds: number, fileBytes: number, maxChunkBytes: number, silenceEnds: number[]): Array<{ start: number; end: number }> {
  const targetSeconds = Math.max(1, durationSeconds * (maxChunkBytes / Math.max(fileBytes, 1)) * 0.9);
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < durationSeconds) {
    const desiredEnd = Math.min(durationSeconds, start + targetSeconds);
    const silenceEnd = silenceEnds.find((value) => value > start + 1 && value >= desiredEnd * 0.75 && value <= desiredEnd * 1.25);
    const end = Math.min(durationSeconds, silenceEnd ?? desiredEnd);
    if (end <= start) break;
    ranges.push({ start, end });
    start = end;
  }
  return ranges.length ? ranges : buildEvenChunkRanges(durationSeconds, fileBytes, maxChunkBytes);
}

function buildEvenChunkRanges(durationSeconds: number, fileBytes: number, maxChunkBytes: number): Array<{ start: number; end: number }> {
  const count = Math.max(1, Math.ceil(fileBytes / Math.max(1, maxChunkBytes)));
  const step = durationSeconds / count;
  return Array.from({ length: count }, (_, index) => ({
    start: index * step,
    end: index === count - 1 ? durationSeconds : (index + 1) * step
  }));
}

async function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  const result = await runFfmpegCapture(ffmpeg, args);
  if (result.code !== 0) throw new Error(`ffmpeg_failed:${result.stderr.slice(0, 500)}`);
}

function runFfmpegCapture(ffmpeg: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: any[] = [];
    child.stderr?.on("data", (chunk: unknown) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class AsrConfigError extends Error {
  constructor(public readonly code: AsrTranscribeError["error"]) {
    super(code);
  }
}
