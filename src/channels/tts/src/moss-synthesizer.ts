const childProcess = await import("node:child_process");
const fs = await import("node:fs");
const path = await import("node:path");
import type {
  MossOnnxVoiceSynthesizerDeps,
  TTSConfig,
  VoiceSynthesizer
} from "./types.js";

import { convertWavToOpus, postJson, validateVoiceLoudness } from "./audio-utils.js";
import { delay, isRecord, optionalStringValue, removeGeneratedVoice, requireAssetPath, resolveAssetOutputDir, uniqueVoiceBaseName, validateGeneratedVoice } from "./internal.js";

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
    const outputDir = resolveAssetOutputDir(config.outputDir, input.assetRoot);
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
    const outputDir = resolveAssetOutputDir(config.outputDir, input.assetRoot);
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
