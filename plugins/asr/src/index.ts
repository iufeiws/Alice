const fs = await import("node:fs");
const path = await import("node:path");
const crypto = await import("node:crypto");
const os = await import("node:os");
const childProcess = await import("node:child_process");
const moduleApi = await import("node:module");
const require = moduleApi.createRequire(import.meta.url);

const tencentLocalAudioUploadLimitBytes = 5 * 1024 * 1024;

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
  providers: {
    openaiCompatible?: {
      apiPresetName?: string;
      responseFormat?: AsrResponseFormat;
      retryCount?: number;
      retryBackoffMs?: number;
    };
    tencent?: {
      secretId?: string;
      secretKey?: string;
      endpoint?: string;
      region?: string;
      engineModelType?: string;
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
  env?: Record<string, string | undefined>;
  resolveApiPreset?(name: string): AsrApiPreset | undefined;
  sleep?(ms: number): Promise<void>;
  splitAudio?(input: AsrSplitAudioInput): Promise<AsrAudioChunk[]>;
  now?(): Date;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
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

const defaultConfigPath = "plugins/asr/config.json";

export function createAsrPlugin(deps: AsrPluginDeps = {}): AsrPlugin {
  return {
    id: "asr",
    config: readAsrPluginConfig(deps.configPath),
    transcribe(input) {
      return transcribeWithAsrPlugin(input, readAsrPluginConfig(deps.configPath), deps);
    }
  };
}

export function readAsrPluginConfig(configPath = defaultConfigPath): AsrPluginConfig {
  const resolved = path.resolve(configPath);
  const parsed = parseJsonObject(fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "{}");
  const providers = parseJsonObject(parsed.providers);
  return {
    enabled: booleanValue(parsed.enabled, false),
    defaultProvider: asrProviderValue(parsed.defaultProvider) ?? "openai_compatible",
    testAudioPath: stringValue(parsed.testAudioPath),
    providers: {
      openaiCompatible: parseOpenAiCompatibleConfig(providers.openaiCompatible),
      tencent: parseTencentConfig(providers.tencent)
    }
  };
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

function parseTencentConfig(value: unknown): AsrPluginConfig["providers"]["tencent"] {
  const parsed = parseJsonObject(value);
  if (!Object.keys(parsed).length) return undefined;
  return {
    secretId: stringValue(parsed.secretId),
    secretKey: stringValue(parsed.secretKey),
    endpoint: stringValue(parsed.endpoint),
    region: stringValue(parsed.region),
    engineModelType: stringValue(parsed.engineModelType),
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

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key: string | Uint8Array, value: string): any {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function hmacSha256Hex(key: string | Uint8Array, value: string): string {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
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
