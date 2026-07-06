import type {
  InboundAudioStreamAbortFrame,
  InboundAudioStreamChunkFrame,
  InboundAudioStreamFrame,
  InboundAudioStreamStartFrame
} from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { sanitizeAudioTranscript } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type {
  AsrInboundStreamAborted,
  AsrInboundStreamAcceptResult,
  AsrInboundStreamError,
  AsrInboundStreamSession,
  AsrPluginConfig,
  AsrPluginDeps,
  AsrTranscribeError,
  AsrTranscribeResult
} from "./types.js";
import { concatAudioStreamChunks, copyInboundChunk, isPcm16Stream, replaceExtension, wrapPcm16AsWav } from "./audio.js";
import { createTencentRealtimeInboundStreamSession } from "./tencent.js";
import { transcribeWithAsrPlugin } from "./transcribe.js";

const defaultPseudoStreamMinPauseMs = 1500;

export function createAsrInboundStreamSession(
  start: InboundAudioStreamStartFrame,
  config: AsrPluginConfig,
  deps: AsrPluginDeps = {}
): AsrInboundStreamSession {
  const provider = start.provider ?? config.defaultProvider;
  if (provider === "tencent" && config.providers.tencent?.appId) {
    return createTencentRealtimeInboundStreamSession(start, config, deps);
  }

  let currentChunks: InboundAudioStreamChunkFrame[] = [];
  const completedTexts: string[] = [];
  let totalChunks = 0;
  let totalBytes = 0;
  let expectedSequence = 0;
  let closed = false;

  return {
    streamId: start.streamId,
    async accept(frame): Promise<AsrInboundStreamAcceptResult> {
      if (frame.streamId !== start.streamId) return streamError(start.streamId, "stream_id_mismatch");
      if (closed) return streamError(start.streamId, "stream_closed");
      if (frame.type === "abort") {
        closed = true;
        return abortStream(start.streamId, frame);
      }
      if (frame.type === "chunk") {
        if (frame.sequence !== expectedSequence) return streamError(start.streamId, "out_of_order_chunk");
        const chunk = copyInboundChunk(frame);
        const shouldFlush = currentChunks.length > 0 && isConservativeLongPause(currentChunks[currentChunks.length - 1], chunk, config.pseudoStreamMinPauseMs);
        if (shouldFlush) {
          const partial = await transcribePseudoStreamSegment(start, currentChunks, config, deps);
          if ("ok" in partial) return streamError(start.streamId, partial.error, partial.message);
          const partialResult = partial;
          const text = sanitizeAudioTranscript(partialResult.text);
          if (text) completedTexts.push(text);
          currentChunks = [chunk];
          totalChunks += 1;
          totalBytes += chunk.bytes.byteLength;
          expectedSequence += 1;
          return {
            ok: true,
            type: "partial",
            streamId: start.streamId,
            text,
            stable: true,
            raw: partialResult.raw
          };
        }
        currentChunks.push(chunk);
        totalChunks += 1;
        totalBytes += chunk.bytes.byteLength;
        expectedSequence += 1;
        return { ok: true, type: "ack", streamId: start.streamId, sequence: frame.sequence };
      }
      if (frame.type === "end") {
        closed = true;
        if (!currentChunks.length && !completedTexts.length) return streamError(start.streamId, "empty_stream");
        let finalResult: AsrTranscribeResult | undefined;
        if (currentChunks.length) {
          const result = await transcribePseudoStreamSegment(start, currentChunks, config, deps, frame.metadata);
          if ("ok" in result) {
            return streamError(start.streamId, result.error, result.message);
          }
          finalResult = result;
          const text = sanitizeAudioTranscript(finalResult.text);
          if (text) completedTexts.push(text);
        }
        const text = completedTexts.join("\n");
        if (!text) return streamError(start.streamId, "empty_transcription");
        return {
          ok: true,
          type: "final",
          streamId: start.streamId,
          result: {
            ...(finalResult ?? {
              provider: start.provider ?? config.defaultProvider
            }),
            text,
            rawStream: {
              streamId: start.streamId,
              chunks: totalChunks,
              bytes: totalBytes,
              metadata: {
                mode: "pseudo_stream",
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

async function transcribePseudoStreamSegment(
  start: InboundAudioStreamStartFrame,
  chunks: InboundAudioStreamChunkFrame[],
  config: AsrPluginConfig,
  deps: AsrPluginDeps,
  metadata?: Record<string, unknown>
): Promise<AsrTranscribeResult | AsrTranscribeError> {
  const audio = preparePseudoStreamAudio(start, chunks);
  return transcribeWithAsrPlugin({
    audioFile: audio.bytes,
    filename: audio.filename,
    mimeType: audio.mimeType,
    language: start.language,
    provider: start.provider,
    prompt: start.prompt,
    metadata: {
      ...start.metadata,
      ...metadata,
      streamId: start.streamId,
      audio: start.audio,
      mode: "pseudo_stream",
      chunks: chunks.map((chunk) => ({
        sequence: chunk.sequence,
        bytes: chunk.bytes.byteLength,
        timing: chunk.timing,
        metadata: chunk.metadata
      }))
    }
  }, config, deps);
}

function preparePseudoStreamAudio(
  start: InboundAudioStreamStartFrame,
  chunks: InboundAudioStreamChunkFrame[]
): { bytes: Uint8Array; filename?: string; mimeType?: string } {
  const bytes = concatAudioStreamChunks(chunks);
  if (!isPcm16Stream(start)) {
    return {
      bytes,
      filename: start.audio.filename,
      mimeType: start.audio.mimeType
    };
  }
  return {
    bytes: wrapPcm16AsWav(bytes, start.audio.sampleRateHz ?? 16000, start.audio.channels ?? 1),
    filename: replaceExtension(start.audio.filename || "audio.pcm", ".wav"),
    mimeType: "audio/wav"
  };
}

function isConservativeLongPause(previous: InboundAudioStreamChunkFrame | undefined, next: InboundAudioStreamChunkFrame, minPauseMs = defaultPseudoStreamMinPauseMs): boolean {
  const previousEnd = previous?.timing?.endMs;
  const nextStart = next.timing?.startMs;
  return typeof previousEnd === "number"
    && typeof nextStart === "number"
    && nextStart - previousEnd >= minPauseMs;
}

export function abortStream(streamId: string, frame: InboundAudioStreamAbortFrame): AsrInboundStreamAborted {
  return {
    ok: true,
    type: "aborted",
    streamId,
    reason: frame.reason
  };
}

export function streamError(streamId: string, error: AsrInboundStreamError["error"], message?: string): AsrInboundStreamError {
  return {
    ok: false,
    type: "error",
    streamId,
    error,
    ...(message ? { message } : {})
  };
}
