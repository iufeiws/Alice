import { HttpJsonError } from "../../../apps/api/middleware/http-utils.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";

const fs = await import("node:fs");
const path = await import("node:path");
const childProcess = await import("node:child_process");
const moduleApi = await import("node:module");
const require = moduleApi.createRequire(import.meta.url);

export const maxTtsReferenceDurationSeconds = 20;
export const maxTtsReferenceUploadBytes = 15 * 1024 * 1024;
const ttsReferenceConvertTimeoutMs = 60_000;

export function decodeHeaderFileName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveTtsOutputDir(context: AdminRoutesContext): string {
  return resolveTtsAssetPath(context, context.config.tts.mossOutputDir);
}

export function resolveTtsAssetPath(context: AdminRoutesContext, assetPath: string): string {
  const assetRoot = path.resolve(context.pluginConfigs?.tts?.assetRoot ?? "assets");
  const fullPath = path.isAbsolute(assetPath)
    ? assetPath
    : path.normalize(assetPath) === "assets" || path.normalize(assetPath).startsWith(`assets${path.sep}`)
      ? path.resolve(assetPath)
      : path.resolve(assetRoot, assetPath);
  const relative = path.relative(assetRoot, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpJsonError(400, "tts_asset_path_outside_assets");
  }
  return fullPath;
}

export function ttsAudioUrl(context: AdminRoutesContext, filePath: string): string {
  const outputDir = resolveTtsOutputDir(context);
  const relative = path.relative(outputDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("generated tts file is outside output directory");
  return `/admin/assets/tts/${relative.split(path.sep).map(encodeURIComponent).join("/")}`;
}

export function readMossCodecConfig(context: AdminRoutesContext): { sampleRate: number; channels: number } {
  const fallback = { sampleRate: 48_000, channels: 2 };
  const metaPath = path.join(resolveTtsAssetPath(context, context.config.tts.mossModelDir), "MOSS-Audio-Tokenizer-Nano-ONNX", "codec_browser_onnx_meta.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { codec_config?: { sample_rate?: unknown; channels?: unknown } };
    const sampleRate = Number(parsed.codec_config?.sample_rate);
    const channels = Number(parsed.codec_config?.channels);
    if (Number.isInteger(sampleRate) && sampleRate > 0 && Number.isInteger(channels) && channels > 0) {
      return { sampleRate, channels };
    }
  } catch {
    // Use the current MOSS Nano defaults when metadata is not available.
  }
  return fallback;
}

export async function ensureTtsReferenceWithinLimit(context: AdminRoutesContext): Promise<void> {
  const referencePath = resolveTtsAssetPath(context, context.config.tts.genieReferenceAudio);
  if (!fs.existsSync(referencePath)) throw new Error("TTS reference audio was not found");
  const codecConfig = readMossCodecConfig(context);
  const maxBytes = maxTtsReferencePcmBytes(codecConfig);
  const stat = fs.statSync(referencePath);
  if (stat.size <= maxBytes) return;
  const tempDir = path.join(path.dirname(referencePath), `.alice-tts-reference-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const trimmedPath = path.join(tempDir, "reference.wav");
  try {
    await convertReferenceAudio(referencePath, trimmedPath, context.config.tts.mossFfmpegCommand, codecConfig);
    fs.renameSync(trimmedPath, referencePath);
    const mossReferencePath = resolveTtsAssetPath(context, context.config.tts.mossReferenceAudio);
    if (path.resolve(mossReferencePath) !== path.resolve(referencePath)) {
      fs.mkdirSync(path.dirname(mossReferencePath), { recursive: true });
      fs.writeFileSync(mossReferencePath, fs.readFileSync(referencePath));
    }
    context.appendLog("warn", `tts reference audio was too large and has been trimmed to ${maxTtsReferenceDurationSeconds}s`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function convertReferenceAudio(
  inputPath: string,
  outputPath: string,
  ffmpegCommand: string,
  codecConfig: { sampleRate: number; channels: number }
): Promise<void> {
  const resolvedFfmpegCommand = resolveFfmpegCommand(ffmpegCommand);
  await new Promise<void>((resolve, reject) => {
    const child = childProcess.spawn(resolvedFfmpegCommand, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", inputPath,
      "-vn",
      "-t", String(maxTtsReferenceDurationSeconds),
      "-acodec", "pcm_s16le",
      "-ar", String(codecConfig.sampleRate),
      "-ac", String(codecConfig.channels),
      outputPath
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, ttsReferenceConvertTimeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      const code = typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : undefined;
      reject(new Error(code === "ENOENT"
        ? "ffmpeg was not found; install ffmpeg-static or set MOSS_TTS_FFMPEG_COMMAND"
        : error.message));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`ffmpeg reference audio conversion timed out after ${ttsReferenceConvertTimeoutMs}ms`));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg reference audio conversion failed: ${stderr.slice(0, 500) || `exit ${code ?? "unknown"}`}`));
    });
  });
  const stat = fs.statSync(outputPath);
  if (!stat.isFile() || stat.size <= 0) throw new Error("converted reference audio is empty");
}

function maxTtsReferencePcmBytes(codecConfig: { sampleRate: number; channels: number }): number {
  const wavHeaderAndSlack = 128 * 1024;
  return (codecConfig.sampleRate * codecConfig.channels * 2 * maxTtsReferenceDurationSeconds) + wavHeaderAndSlack;
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
