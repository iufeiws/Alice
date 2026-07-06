import type { WebRtcVoiceDeps, WebRtcVoiceInputAudio } from "./types.js";

export type InboundAudioStats = {
  chunks: number;
  bytes: number;
  firstStartMs?: number;
  lastEndMs?: number;
  durationMs: number;
};

export function createInboundAudioStats(): InboundAudioStats {
  return {
    chunks: 0,
    bytes: 0,
    durationMs: 0
  };
}

export function recordInboundAudioStats(
  stats: InboundAudioStats,
  bytes: Uint8Array,
  timing?: { startMs?: number; endMs?: number; durationMs?: number }
): void {
  stats.chunks += 1;
  stats.bytes += bytes.byteLength;
  if (typeof timing?.startMs === "number") stats.firstStartMs = stats.firstStartMs === undefined ? timing.startMs : Math.min(stats.firstStartMs, timing.startMs);
  if (typeof timing?.endMs === "number") stats.lastEndMs = stats.lastEndMs === undefined ? timing.endMs : Math.max(stats.lastEndMs, timing.endMs);
  if (typeof timing?.durationMs === "number" && Number.isFinite(timing.durationMs)) stats.durationMs += Math.max(0, timing.durationMs);
}

export function summarizeInboundAudioStats(stats: InboundAudioStats): string {
  const timedDurationMs = stats.firstStartMs !== undefined && stats.lastEndMs !== undefined
    ? Math.max(0, stats.lastEndMs - stats.firstStartMs)
    : stats.durationMs;
  return `chunks=${stats.chunks} bytes=${stats.bytes} durationMs=${Math.round(timedDurationMs)}`;
}

export function buildDirectAudioInput(chunks: Uint8Array[], stats: InboundAudioStats, deps: WebRtcVoiceDeps): WebRtcVoiceInputAudio | undefined {
  if (chunks.length === 0 || stats.bytes <= 0) return undefined;
  const wav = wrapPcm16AsWav(chunks, deps.config.inboundAudio.sampleRateHz, deps.config.inboundAudio.channels);
  return {
    kind: "audio",
    data: wav.toString("base64"),
    format: "wav",
    mimeType: "audio/wav",
    sampleRateHz: deps.config.inboundAudio.sampleRateHz,
    channels: deps.config.inboundAudio.channels,
    encoding: deps.config.inboundAudio.encoding,
    bytes: wav.byteLength,
    durationMs: stats.firstStartMs !== undefined && stats.lastEndMs !== undefined
      ? Math.max(0, stats.lastEndMs - stats.firstStartMs)
      : stats.durationMs
  };
}

function wrapPcm16AsWav(chunks: Uint8Array[], sampleRateHz: number, channels: number): Buffer {
  const dataSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, ...chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))]);
}
