import type { ServerAudioFrame, WebRtcVoiceDeps, WebRtcVoiceTtsArchiveInput } from "./types.js";

export type TalkChunk = {
  sessionId: number;
  outputId: string;
  chunkId?: string;
  text: string;
  status?: string;
  startCharIndex: number;
  endCharIndex: number;
};

export async function archiveTtsOutput(deps: WebRtcVoiceDeps, input: WebRtcVoiceTtsArchiveInput): Promise<void> {
  if (!deps.archiveTtsOutput) return;
  try {
    const result = await deps.archiveTtsOutput(input);
    deps.emitStatus?.({ state: "tts.archive.saved", detail: result?.filePath ?? input.outputId ?? "" });
  } catch (error) {
    deps.emitStatus?.({ state: "tts.archive.failed", detail: error instanceof Error ? error.message : String(error) });
  }
}

export function normalizeTalkSessionOpenResult(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "number" && Number.isFinite(sessionId) ? sessionId : undefined;
}

export function normalizeTalkChunk(value: unknown): TalkChunk | undefined {
  if (!value || typeof value !== "object") return undefined;
  const chunk = value as Record<string, unknown>;
  if (typeof chunk.outputId !== "string" || typeof chunk.text !== "string" || typeof chunk.sessionId !== "number") return undefined;
  const status = chunk.status === "streaming" || chunk.status === "finished" ? chunk.status : undefined;
  return {
    sessionId: chunk.sessionId,
    outputId: chunk.outputId,
    chunkId: typeof chunk.chunkId === "string" ? chunk.chunkId : undefined,
    text: chunk.text,
    status,
    startCharIndex: typeof chunk.startCharIndex === "number" ? chunk.startCharIndex : 0,
    endCharIndex: typeof chunk.endCharIndex === "number" ? chunk.endCharIndex : Array.from(chunk.text).length
  };
}

export function playbackOptionString(options: unknown, key: string): string | undefined {
  return options && typeof options === "object" && typeof (options as Record<string, unknown>)[key] === "string"
    ? (options as Record<string, string>)[key]
    : undefined;
}

export async function* iterateUint8Chunks(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

export async function* iterateServerAudioFrames(frames: ServerAudioFrame[]): AsyncIterable<ServerAudioFrame> {
  for (const frame of frames) yield frame;
}

export function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
