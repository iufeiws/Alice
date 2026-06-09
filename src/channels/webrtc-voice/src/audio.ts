const childProcess = await import("node:child_process");
const dgram = await import("node:dgram");
const moduleApi = await import("node:module");
const nodeBuffer: any = (await import("node:buffer")).Buffer;
const require = moduleApi.createRequire(import.meta.url);

import type { DecodeAudioFileInput, EncodePcmL16Input, EncodePcmL16StreamInput, ServerAudioFrame } from "./types.js";
import { createAsyncQueue } from "./utils.js";

export async function decodeAudioFileToOpusRtpFrames(input: DecodeAudioFileInput & { ffmpegCommand?: string }): Promise<ServerAudioFrame[]> {
  const ogg = await runFfmpegToOggOpus(input.filePath, input.ffmpegCommand ?? "ffmpeg-static");
  const packets = parseOggOpusPackets(ogg).filter((packet) => !isOpusHeaderPacket(packet));
  const timestampIncrement = Math.round(input.sampleRateHz * input.frameMs / 1000);
  return packets.map((packet, index) => ({
    sequence: index,
    pcm: new Int16Array(),
    sampleRateHz: input.sampleRateHz,
    channels: input.channels,
    durationMs: input.frameMs,
    rtpPayload: packet,
    rtpTimestampIncrement: timestampIncrement,
    payloadType: 111
  }));
}

export async function encodePcmL16ToOpusRtpFrames(input: EncodePcmL16Input & { ffmpegCommand?: string }): Promise<ServerAudioFrame[]> {
  const ogg = await runFfmpegPcmL16ToOggOpus(input.pcm, input.inputSampleRateHz, input.inputChannels, input.ffmpegCommand ?? "ffmpeg-static");
  const packets = parseOggOpusPackets(ogg).filter((packet) => !isOpusHeaderPacket(packet));
  const timestampIncrement = Math.round(input.sampleRateHz * input.frameMs / 1000);
  return packets.map((packet, index) => ({
    sequence: index,
    pcm: new Int16Array(),
    sampleRateHz: input.sampleRateHz,
    channels: input.channels,
    durationMs: input.frameMs,
    rtpPayload: packet,
    rtpTimestampIncrement: timestampIncrement,
    payloadType: 111
  }));
}

export async function* encodePcmL16StreamToOpusRtpFrames(input: EncodePcmL16StreamInput & { ffmpegCommand?: string }): AsyncIterable<ServerAudioFrame> {
  const timestampIncrement = Math.round(input.sampleRateHz * input.frameMs / 1000);
  let index = 0;
  for await (const packet of runFfmpegPcmL16StreamToOpusPackets(input.chunks, input.inputSampleRateHz, input.inputChannels, input.ffmpegCommand ?? "ffmpeg-static")) {
    if (isOpusHeaderPacket(packet)) continue;
    yield {
      sequence: index,
      pcm: new Int16Array(),
      sampleRateHz: input.sampleRateHz,
      channels: input.channels,
      durationMs: input.frameMs,
      rtpPayload: packet,
      rtpTimestampIncrement: timestampIncrement,
      payloadType: 111
    };
    index += 1;
  }
}

async function runFfmpegToOggOpus(filePath: string, ffmpegCommand: string): Promise<any> {
  const command = resolveFfmpegCommand(ffmpegCommand);
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", filePath,
      "-ac", "1",
      "-ar", "48000",
      "-c:a", "libopus",
      "-application", "voip",
      "-frame_duration", "20",
      "-page_duration", "20000",
      "-f", "opus",
      "pipe:1"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: any[] = [];
    const stderr: any[] = [];
    child.stdout.on("data", (chunk: any) => stdout.push(chunk));
    child.stderr.on("data", (chunk: any) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(nodeBuffer.concat(stdout) as any);
      else reject(new Error(`ffmpeg opus transcode failed: ${nodeBuffer.concat(stderr).toString("utf8").slice(0, 500)}`));
    });
  });
}

async function runFfmpegPcmL16ToOggOpus(pcm: Uint8Array, sampleRateHz: number, channels: number, ffmpegCommand: string): Promise<any> {
  const command = resolveFfmpegCommand(ffmpegCommand);
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "s16le",
      "-ar", String(sampleRateHz),
      "-ac", String(channels),
      "-i", "pipe:0",
      "-ac", "1",
      "-ar", "48000",
      "-c:a", "libopus",
      "-application", "voip",
      "-frame_duration", "20",
      "-page_duration", "20000",
      "-f", "opus",
      "pipe:1"
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: any[] = [];
    const stderr: any[] = [];
    child.stdout.on("data", (chunk: any) => stdout.push(chunk));
    child.stderr.on("data", (chunk: any) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(nodeBuffer.concat(stdout) as any);
      else reject(new Error(`ffmpeg pcm opus transcode failed: ${nodeBuffer.concat(stderr).toString("utf8").slice(0, 500)}`));
    });
    child.stdin.end(nodeBuffer.from(pcm));
  });
}

async function* runFfmpegPcmL16StreamToOpusPackets(chunks: AsyncIterable<Uint8Array>, sampleRateHz: number, channels: number, ffmpegCommand: string): AsyncIterable<Uint8Array> {
  const command = resolveFfmpegCommand(ffmpegCommand);
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.off("error", reject);
      resolve();
    });
  });
  const address = socket.address();
  if (typeof address === "string") {
    socket.close();
    throw new Error("ffmpeg RTP socket did not bind to an IP port");
  }
  const packetQueue = createAsyncQueue<Uint8Array>();
  socket.on("message", (message) => {
    const payload = parseRtpPayload(message);
    if (payload.byteLength) packetQueue.push(payload);
  });
  const child = childProcess.spawn(command, [
    "-hide_banner",
    "-loglevel", "error",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-analyzeduration", "0",
    "-probesize", "32",
    "-f", "s16le",
    "-ar", String(sampleRateHz),
    "-ac", String(channels),
    "-i", "pipe:0",
    "-ac", "1",
    "-ar", "48000",
    "-c:a", "libopus",
    "-application", "voip",
    "-frame_duration", "20",
    "-flush_packets", "1",
    "-f", "rtp",
    `rtp://127.0.0.1:${address.port}?pkt_size=1200`
  ], { stdio: ["pipe", "ignore", "pipe"] });
  const stderr: any[] = [];
  let settled = false;
  const closePromise = new Promise<void>((resolve, reject) => {
    child.stderr.on("data", (chunk: any) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      settled = true;
      socket.close();
      if (code === 0) {
        packetQueue.close();
        resolve();
      } else {
        const error = new Error(`ffmpeg pcm opus RTP stream transcode failed: ${nodeBuffer.concat(stderr).toString("utf8").slice(0, 500)}`);
        packetQueue.fail(error);
        reject(error);
      }
    });
  });
  const writer = (async () => {
    try {
      for await (const chunk of chunks) {
        if (!chunk.byteLength || child.stdin.destroyed) continue;
        await writeChildStdin(child.stdin, nodeBuffer.from(chunk));
      }
      if (!child.stdin.destroyed) child.stdin.end();
    } catch (error) {
      if (!child.stdin.destroyed) child.stdin.destroy(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  })();
  try {
    while (!packetQueue.closed || packetQueue.length > 0) {
      const packet = packetQueue.shift();
      if (packet) {
        yield packet;
        continue;
      }
      await packetQueue.waitFor(() => packetQueue.length > 0 || packetQueue.closed);
    }
    await writer;
    await closePromise;
  } finally {
    if (!settled) {
      child.kill("SIGTERM");
      await closePromise.catch(() => undefined);
    }
    try {
      socket.close();
    } catch {
      // already closed
    }
  }
}

function parseRtpPayload(packet: Buffer): Uint8Array {
  if (packet.length < 12) return new Uint8Array();
  const version = packet[0] >> 6;
  if (version !== 2) return new Uint8Array();
  const csrcCount = packet[0] & 0x0f;
  const hasExtension = Boolean(packet[0] & 0x10);
  let offset = 12 + csrcCount * 4;
  if (offset > packet.length) return new Uint8Array();
  if (hasExtension) {
    if (offset + 4 > packet.length) return new Uint8Array();
    const extensionLengthWords = nodeBuffer.from(packet).readUInt16BE(offset + 2);
    offset += 4 + extensionLengthWords * 4;
    if (offset > packet.length) return new Uint8Array();
  }
  return new Uint8Array(packet.subarray(offset));
}

function writeChildStdin(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off?.("error", onError);
      stream.off?.("drain", onDrain);
    };
    stream.on?.("error", onError);
    if (stream.write(chunk)) {
      cleanup();
      resolve();
    } else {
      stream.on?.("drain", onDrain);
    }
  });
}

function resolveFfmpegCommand(command: string): string {
  if (command !== "ffmpeg-static") return command;
  try {
    const ffmpegStatic = require("ffmpeg-static") as string | undefined;
    return ffmpegStatic || "ffmpeg";
  } catch {
    return "ffmpeg";
  }
}

type OggOpusParserState = {
  buffer: Buffer;
  pending: Buffer;
};

function appendOggOpusPackets(state: OggOpusParserState, chunk: Buffer | Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  const buffer = nodeBuffer.concat([state.buffer, nodeBuffer.from(chunk)]);
  let offset = 0;
  while (offset + 27 <= buffer.length) {
    if (buffer.subarray(offset, offset + 4).toString("ascii") !== "OggS") throw new Error("invalid ogg opus stream");
    const pageSegments = buffer[offset + 26];
    const segmentTableStart = offset + 27;
    const dataStart = segmentTableStart + pageSegments;
    if (dataStart > buffer.length) break;
    const laces = Array.from(buffer.subarray(segmentTableStart, dataStart)) as number[];
    const pageDataLength = laces.reduce((sum, value) => sum + value, 0);
    const pageEnd = dataStart + pageDataLength;
    if (pageEnd > buffer.length) break;
    const pageData = buffer.subarray(dataStart, pageEnd);
    let pageOffset = 0;
    for (const lace of laces) {
      state.pending = nodeBuffer.concat([state.pending, pageData.subarray(pageOffset, pageOffset + lace)]);
      pageOffset += lace;
      if (lace < 255) {
        packets.push(new Uint8Array(state.pending));
        state.pending = nodeBuffer.alloc(0);
      }
    }
    offset = pageEnd;
  }
  state.buffer = buffer.subarray(offset);
  return packets;
}

function parseOggOpusPackets(buffer: any): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let offset = 0;
  let pending = nodeBuffer.alloc(0);
  while (offset + 27 <= buffer.length) {
    if (buffer.subarray(offset, offset + 4).toString("ascii") !== "OggS") throw new Error("invalid ogg opus stream");
    const pageSegments = buffer[offset + 26];
    const segmentTableStart = offset + 27;
    const dataStart = segmentTableStart + pageSegments;
    if (dataStart > buffer.length) break;
    const laces = Array.from(buffer.subarray(segmentTableStart, dataStart)) as number[];
    const pageDataLength = laces.reduce((sum, value) => sum + value, 0);
    const pageData = buffer.subarray(dataStart, dataStart + pageDataLength);
    if (dataStart + pageDataLength > buffer.length) break;
    let pageOffset = 0;
    for (const lace of laces) {
      pending = nodeBuffer.concat([pending, pageData.subarray(pageOffset, pageOffset + lace)]);
      pageOffset += lace;
      if (lace < 255) {
        packets.push(new Uint8Array(pending));
        pending = nodeBuffer.alloc(0);
      }
    }
    offset = dataStart + pageDataLength;
  }
  return packets;
}

function isOpusHeaderPacket(packet: Uint8Array): boolean {
  const text = nodeBuffer.from(packet.subarray(0, 8)).toString("ascii");
  return text === "OpusHead" || text === "OpusTags";
}
