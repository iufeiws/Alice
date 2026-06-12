const childProcess = await import("node:child_process");
const crypto = await import("node:crypto");
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

import { changeAudioTempo, convertWavToOpus, validateVoiceLoudness, writePcmL16Wav } from "./audio-utils.js";
import { concatUint8Arrays, delay, isRecord, optionalStringValue, referenceTextPath, removeGeneratedVoice, requireAssetDirectory, requireAssetPath, requireGenieReferenceText, resolveAssetOutputDir, uniqueVoiceBaseName, validateGeneratedVoice, zipDirectoryToBuffer } from "./internal.js";

export function createGenieTtsVoiceSynthesizer(input: TTSConfig, deps: MossOnnxVoiceSynthesizerDeps = {}): VoiceSynthesizer {
  const fetchImpl = deps.fetch ?? fetch;
  const spawnImpl = deps.spawn ?? childProcess.spawn;
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  const referenceAudioConfig = input.genieReferenceAudio ?? input.mossReferenceAudio ?? "assets/tts/references/alice/reference.wav";
  const config = {
    baseURL: (input.genieBaseURL ?? `http://${input.genieHost ?? "127.0.0.1"}:${input.geniePort ?? 8767}`).replace(/\/+$/, ""),
    baseURLExplicit: input.genieBaseURLExplicit ?? Boolean(input.genieBaseURL),
    useRemoteUploadProtocol: input.genieBaseURLExplicit === true,
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
    const outputDir = resolveAssetOutputDir(config.outputDir, input.assetRoot);
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
        deps.appendLog?.("info", `genie tts synthesize via stream start: url=${config.baseURL}/${config.useRemoteUploadProtocol ? "stream-input" : "stream"} chars=${Array.from(text).length}`);
        const pcm = await collectGenieStreamPcm({
          text,
          genie: request.genie,
          baseURL: config.baseURL,
          useClientUploadFlow: config.useRemoteUploadProtocol,
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
        ...(config.useRemoteUploadProtocol ? {} : { outputPath: wavPath }),
        ...genieRequestOverrides(request.genie, deps.appendLog, { assetRoot: input.assetRoot })
      };
      if (config.useRemoteUploadProtocol) {
        await synthesizeRemoteGenieWav({
          body: requestBody,
          outputPath: wavPath,
          baseURL: config.baseURL,
          timeoutMs: config.timeoutMs,
          fetchImpl,
          setTimer,
          clearTimer,
          assetRoot: input.assetRoot,
          appendLog: deps.appendLog
        });
      } else {
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
    deps.appendLog?.("info", `genie tts stream prepare: baseURL=${config.baseURL} explicit=${config.useRemoteUploadProtocol ? "true" : "false"} chars=${Array.from(text).length}`);
    await ensureGenieService();
    deps.appendLog?.("info", `genie tts stream open: url=${config.baseURL}/${config.useRemoteUploadProtocol ? "stream-input" : "stream"} chars=${Array.from(text).length}`);
    let chunks = 0;
    let bytes = 0;
    for await (const chunk of streamGeniePcm({
      text,
      genie: request.genie,
      baseURL: config.baseURL,
      useClientUploadFlow: config.useRemoteUploadProtocol,
      timeoutMs: config.timeoutMs,
      fetchImpl,
      setTimer,
      clearTimer,
      assetRoot: input.assetRoot,
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
    deps.appendLog?.("info", `genie tts text stream prepare: baseURL=${config.baseURL} explicit=${config.useRemoteUploadProtocol ? "true" : "false"} chars=${Array.from(text).length}`);
    await ensureGenieService();
    deps.appendLog?.("info", `genie tts text stream open: url=${config.baseURL}/${config.useRemoteUploadProtocol ? "stream-input" : "stream"} chars=${Array.from(text).length}`);
    let chunks = 0;
    let bytes = 0;
  for await (const chunk of streamGeniePcmWithText({
      text,
      genie: request.genie,
      baseURL: config.baseURL,
      useClientUploadFlow: config.useRemoteUploadProtocol,
      timeoutMs: config.timeoutMs,
      fetchImpl,
      setTimer,
      clearTimer,
      assetRoot: input.assetRoot,
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
    const dataDir = requireAssetDirectory(config.dataDir, "Genie TTS data directory was not found", input.assetRoot);
    const modelDir = requireAssetDirectory(config.modelDir, "Genie TTS model directory was not found", input.assetRoot);
    const referenceAudio = requireAssetPath(config.referenceAudio, "Genie TTS reference audio was not found", input.assetRoot);
    const referenceText = requireGenieReferenceText(config.referenceText, "Genie TTS reference text was not found");
    const outputDir = resolveAssetOutputDir(config.outputDir, input.assetRoot);
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
  options: { requireCompleteModel?: boolean; assetRoot?: string } = {}
): Record<string, unknown> {
  if (!input) return {};
  const requireCompleteModel = options.requireCompleteModel ?? true;
  const overrides: Record<string, unknown> = {};
  if (input.language) overrides.language = input.language;
  if (input.modelDir) {
    const modelDir = requireAssetDirectory(input.modelDir, "Genie TTS model directory was not found", options.assetRoot);
    const missing = missingGenieBaseModelFiles(modelDir);
    if (!requireCompleteModel || missing.length === 0) {
      overrides.modelDir = modelDir;
    } else {
      appendLog?.("warn", `genie tts model override skipped because ${input.modelDir} is incomplete; missing ${missing.join(", ")}`);
    }
  }
  if (input.referenceAudio) overrides.referenceAudioPath = requireAssetPath(input.referenceAudio, "Genie TTS reference audio was not found", options.assetRoot);
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

async function synthesizeRemoteGenieWav(input: {
  body: Record<string, unknown>;
  outputPath: string;
  baseURL: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  assetRoot?: string;
  appendLog?: MossOnnxVoiceSynthesizerDeps["appendLog"];
}): Promise<void> {
  const controller = new AbortController();
  const timeout = input.setTimer(() => controller.abort(), input.timeoutMs);
  timeout.unref?.();
  try {
    const body = remoteGenieSynthesizeBody(input.body);
    let response = await postRemoteGenieSynthesize(input.baseURL, body, input.fetchImpl, controller.signal);
    if (response.status === 409) {
      const missing = await readGenieRemoteUploadResponse(response, String(body.modelDir ?? ""));
      await uploadGenieModelForRemote({
        baseURL: input.baseURL,
        modelDir: missing.modelDir,
        uploadUrl: missing.uploadUrl,
        timeoutMs: input.timeoutMs,
        fetchImpl: input.fetchImpl,
        signal: controller.signal,
        assetRoot: input.assetRoot,
        appendLog: input.appendLog
      });
      input.appendLog?.("info", `genie tts remote preset uploaded; retrying original synthesize request code=${missing.code} modelDir=${missing.modelDir}`);
      response = await postRemoteGenieSynthesize(input.baseURL, body, input.fetchImpl, controller.signal);
    }
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Genie TTS synthesize HTTP ${response.status}: ${errorText.slice(0, 500)}`);
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    if (!audio.byteLength) throw new Error("Genie TTS synthesize returned empty audio");
    fs.writeFileSync(input.outputPath, audio);
  } finally {
    input.clearTimer(timeout);
    controller.abort();
  }
}

function remoteGenieSynthesizeBody(input: Record<string, unknown>): Record<string, unknown> {
  const { outputPath: _outputPath, referenceAudioPath: _referenceAudioPath, partSilenceSeconds: _partSilenceSeconds, ...body } = input;
  return body;
}

function postRemoteGenieSynthesize(baseURL: string, body: Record<string, unknown>, fetchImpl: typeof fetch, signal: AbortSignal): Promise<Response> {
  return fetchImpl(`${baseURL}/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify(body)
  });
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
  assetRoot?: string;
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
  assetRoot?: string;
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
  assetRoot?: string;
  responseFormat?: "ndjson";
}, signal: AbortSignal): Promise<Response> {
  const overrides = genieRequestOverrides(input.genie, input.appendLog, {
    requireCompleteModel: !input.useClientUploadFlow,
    assetRoot: input.assetRoot
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
    splitText: typeof overrides.splitText === "boolean" ? overrides.splitText : undefined,
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
    assetRoot: input.assetRoot,
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

function genieStreamInputUrl(baseURL: string, input: { language?: string; modelDir: string; splitText?: boolean; responseFormat?: "ndjson" }): string {
  const url = new URL(`${baseURL}/stream-input`);
  if (input.language) url.searchParams.set("language", input.language);
  url.searchParams.set("modelDir", input.modelDir);
  if (input.splitText !== undefined) url.searchParams.set("splitText", String(input.splitText));
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
  if (!text) throw new Error("Genie TTS remote generation HTTP 409 without JSON body");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) throw new Error(`Genie TTS remote generation HTTP 409: ${text.slice(0, 500)}`);
    const code = optionalStringValue(parsed.code) || "unknown_code";
    if (code !== "MODEL_NOT_UPLOADED" && code !== "REFERENCE_NOT_UPLOADED") {
      const message = optionalStringValue(parsed.error) || optionalStringValue(parsed.message) || text;
      throw new Error(`Genie TTS remote generation HTTP 409 ${code}: ${message.slice(0, 500)}`);
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
    throw new Error(`Genie TTS remote generation HTTP 409 invalid JSON: ${text.slice(0, 500)}`);
  }
}

export function isRemoteGenieProtocolError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Genie TTS (stream-input|remote generation) HTTP 409|MODEL_NOT_UPLOADED|REFERENCE_NOT_UPLOADED|remote stream-input requires modelDir/i.test(message);
}

async function uploadGenieModelForRemote(input: {
  baseURL: string;
  modelDir: string;
  uploadUrl?: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  assetRoot?: string;
  appendLog?: MossOnnxVoiceSynthesizerDeps["appendLog"];
}): Promise<void> {
  const modelDir = requireAssetDirectory(input.modelDir, "Genie TTS remote upload model directory was not found", input.assetRoot);
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
