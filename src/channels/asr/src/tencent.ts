import { createRequire } from "node:module";
import type { InboundAudioStreamAbortFrame, InboundAudioStreamStartFrame } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { sanitizeAudioTranscript } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type {
  AsrAudioChunk,
  AsrInboundStreamAborted,
  AsrInboundStreamAcceptResult,
  AsrInboundStreamError,
  AsrInboundStreamPartial,
  AsrInboundStreamSession,
  AsrPluginConfig,
  AsrPluginDeps,
  AsrTranscribeInput,
  AsrTranscribeResult,
  AsrWebSocketLike
} from "./types.js";
import { readAudioInput } from "./audio.js";
import { AsrConfigError } from "./errors.js";
import { splitAudioWithFfmpeg } from "./ffmpeg-split.js";
import {
  base64FromBytes,
  canonicalQuery,
  fetchWithTimeout,
  hashToInt,
  hmacSha1Base64,
  hmacSha256,
  hmacSha256Hex,
  numberValue,
  parseJsonObject,
  retryAsync,
  retryOptions,
  sha256Hex,
  sleep,
  stringValue
} from "./utils.js";

const require = createRequire(import.meta.url);
const tencentLocalAudioUploadLimitBytes = 5 * 1024 * 1024;

export function createTencentRealtimeInboundStreamSession(
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
  let socketPromise: Promise<AsrWebSocketLike> | undefined;
  let receivedAudio = false;

  const socketForAudio = () => {
    socketPromise ??= Promise.resolve(createTencentRealtimeSocket(start, providerConfig, deps)).then(async (socket) => {
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
    return socketPromise;
  };

  return {
    streamId: start.streamId,
    async accept(frame): Promise<AsrInboundStreamAcceptResult> {
      if (frame.streamId !== start.streamId) return streamError(start.streamId, "stream_id_mismatch");
      if (closed) return streamError(start.streamId, "stream_closed");
      if (frame.type === "abort") {
        closed = true;
        const socket = await socketPromise;
        socket?.close?.();
        return abortStream(start.streamId, frame);
      }
      if (frame.type === "chunk") {
        if (frame.sequence !== expectedSequence) return streamError(start.streamId, "out_of_order_chunk");
        expectedSequence += 1;
        receivedAudio = true;
        const socket = await socketForAudio();
        await Promise.resolve(socket.send(frame.bytes));
        return drainTencentRealtimeMessages(start.streamId, messages, stableResults, (text) => {
          latestPartial = text;
        }) ?? { ok: true, type: "ack", streamId: start.streamId, sequence: frame.sequence };
      }
      if (frame.type === "end") {
        closed = true;
        if (!receivedAudio) return streamError(start.streamId, "empty_stream");
        const socket = await socketForAudio();
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
    if (code !== 0) {
      const message = [String(code), stringValue(parsed.message)].filter(Boolean).join(":");
      return streamError(streamId, "provider_request_failed", message || undefined);
    }
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

export async function transcribeTencent(input: AsrTranscribeInput, config: AsrPluginConfig, deps: AsrPluginDeps): Promise<AsrTranscribeResult> {
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
  while (Date.now() <= deadline) {
    await (deps.sleep ?? sleep)(pollIntervalMs);
    const describeRaw = await retryAsync(
      () => tencentRequest(resolved.endpoint, "DescribeTaskStatus", { TaskId: taskId }, { secretId: resolved.secretId, secretKey: resolved.secretKey, region: resolved.region }, deps, timeoutMs),
      retry
    );
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
