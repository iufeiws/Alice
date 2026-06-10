const childProcess = await import("node:child_process");
const moduleApi = await import("node:module");
const require = moduleApi.createRequire(import.meta.url);
const fs = await import("node:fs");
const path = await import("node:path");
import { isRecord, optionalStringValue } from "./internal.js";

export async function postJson(url: string, body: Record<string, unknown>, timeoutMs: number, fetchImpl: typeof fetch, label = "MOSS TTS"): Promise<unknown> {
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

export async function changeAudioTempo(inputPath: string, outputPath: string, speed: number, ffmpegCommand: string, spawnImpl: typeof childProcess.spawn): Promise<void> {
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

export async function convertWavToOpus(wavPath: string, opusPath: string, ffmpegCommand: string, spawnImpl: typeof childProcess.spawn): Promise<void> {
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

export function writePcmL16Wav(filePath: string, pcm: Uint8Array, sampleRate: number, channels: number): void {
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

export function writeAscii(output: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    output[offset + index] = text.charCodeAt(index);
  }
}

function readInt16LE(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset] | (bytes[offset + 1] << 8);
  return value & 0x8000 ? value - 0x10000 : value;
}

export async function validateVoiceLoudness(audioPath: string, ffmpegCommand: string, spawnImpl: typeof childProcess.spawn): Promise<void> {
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
