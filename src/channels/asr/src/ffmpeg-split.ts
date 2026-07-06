import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as childProcess from "node:child_process";
import { createRequire } from "node:module";
import type { AsrAudioChunk, AsrSplitAudioInput } from "./types.js";
import { AsrConfigError } from "./errors.js";

const require = createRequire(import.meta.url);

export async function splitAudioWithFfmpeg(input: AsrSplitAudioInput): Promise<AsrAudioChunk[]> {
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
