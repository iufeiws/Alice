import * as fs from "node:fs";
import * as path from "node:path";
import type { InboundAudioStreamChunkFrame, InboundAudioStreamStartFrame } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { AsrTranscribeInput } from "./types.js";
import { AsrConfigError } from "./errors.js";
import { base64FromBytes } from "./utils.js";

export async function readAudioInput(input: AsrTranscribeInput): Promise<{ bytes: Uint8Array; filename: string }> {
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

export function mimeTypeForFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a" || ext === ".mp4") return "audio/mp4";
  if (ext === ".ogg") return "audio/ogg";
  return "application/octet-stream";
}

export function copyInboundChunk(frame: InboundAudioStreamChunkFrame): InboundAudioStreamChunkFrame {
  const bytes = new Uint8Array(frame.bytes.byteLength);
  bytes.set(frame.bytes);
  return {
    ...frame,
    bytes,
    timing: frame.timing ? { ...frame.timing } : undefined,
    metadata: frame.metadata ? { ...frame.metadata } : undefined
  };
}

export function concatAudioStreamChunks(chunks: InboundAudioStreamChunkFrame[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk.bytes, offset);
    offset += chunk.bytes.byteLength;
  }
  return merged;
}

export function isPcm16Stream(start: InboundAudioStreamStartFrame): boolean {
  const encoding = `${start.audio.encoding ?? ""}`.toLowerCase();
  const mimeType = `${start.audio.mimeType ?? ""}`.toLowerCase();
  const filename = `${start.audio.filename ?? ""}`.toLowerCase();
  return encoding.includes("pcm16") || mimeType === "audio/pcm" || filename.endsWith(".pcm");
}

export function wrapPcm16AsWav(pcm: Uint8Array, sampleRateHz: number, channels: number): Uint8Array {
  const headerSize = 44;
  const bytes = new Uint8Array(headerSize + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, pcm.byteLength, true);
  bytes.set(pcm, headerSize);
  return bytes;
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    target[offset + index] = value.charCodeAt(index);
  }
}

export function replaceExtension(filename: string, extension: string): string {
  const parsed = path.parse(filename);
  return `${parsed.name || "audio"}${extension}`;
}

export function audioDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${base64FromBytes(bytes)}`;
}

export function audioFormatForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (normalized.includes("wav") || normalized.includes("wave")) return "wav";
  if (normalized.includes("mp4") || normalized.includes("m4a")) return "mp4";
  if (normalized.includes("ogg")) return "ogg";
  return "wav";
}
