import type {
  TtsPluginConfig,
  TtsPluginDeps,
  TtsStreamChunk,
  TtsStreamInput
} from "./types.js";

import { bufferTtsStreamInput } from "./stream-input-buffer.js";
import { selectedTtsConversionProvider, ttsGenieOverrides } from "./config.js";
import { resolveTtsText } from "./translation.js";
import { synthesizeTtsRouted } from "./router.js";

export async function* streamTtsText(
  input: TtsStreamInput,
  config: TtsPluginConfig,
  deps: TtsPluginDeps
): AsyncIterable<TtsStreamChunk> {
  if (input.source !== "send_chat.voice") throw new Error("tts stream only supports send_chat.voice");
  if (!config.enabled) throw new Error("tts stream is disabled");
  const conversion = selectedTtsConversionProvider(config);

  let streamSequence = 0;
  for await (const sourceText of bufferTtsStreamInput(input.text, {
    minChars: config.translationEnabled ? 20 : 12,
    allowCrossNewline: config.translationEnabled,
    onIdle: input.onInputBufferIdle
  })) {
  const sourceChars = Array.from(sourceText).length;
  if (!sourceText.trim()) {
    deps.appendLog?.("info", `tts stream skipped: empty input stream=${input.streamId ?? ""}`);
    continue;
  }

  if (config.translationEnabled) {
    deps.appendLog?.("info", `tts stream translation start: stream=${input.streamId ?? ""} chars=${sourceChars}`);
    yield { type: "translation_started", sequence: streamSequence, sourceChars };
  }
  const ttsText = await resolveTtsText(sourceText, config, deps);
  const ttsChars = Array.from(ttsText).length;
  deps.appendLog?.("info", `tts stream text lengths: stream=${input.streamId ?? ""} sourceChars=${sourceChars} translatedChars=${ttsChars}`);
  if (config.translationEnabled) {
    deps.appendLog?.("info", `tts stream translation complete: stream=${input.streamId ?? ""} chars=${ttsChars}`);
    yield { type: "translation_done", sequence: streamSequence, translatedChars: ttsChars };
  }

  const streamGenie = conversion === "genie"
    ? (() => {
      const { speed: _streamUnsupportedSpeed, partSilenceSeconds: _streamUnusedSilence, ...genie } = ttsGenieOverrides(config);
      return genie;
    })()
    : undefined;
  const parts = splitTtsTextChunks(ttsText);
  deps.appendLog?.("info", `tts stream tts start: stream=${input.streamId ?? ""} chars=${ttsChars} parts=${parts.length}`);
  const sourceTextMapper = createTtsSourceTextMapper(sourceText, ttsText);
  let totalAudioFiles = 0;
  for (const part of parts) {
    const sequence = streamSequence;
    await input.beforeBackendRequest?.({ sequence, text: part });
    deps.appendLog?.("info", `tts stream part request: stream=${input.streamId ?? ""} sequence=${sequence} chars=${Array.from(part).length}`);
    const voice = await synthesizeTtsRouted({
      text: part,
      time: input.time,
      ...(streamGenie ? { genie: streamGenie } : {})
    }, config, deps, { ...(streamGenie ? { genie: streamGenie } : {}) });
    totalAudioFiles += 1;
    const text = config.translationEnabled ? sourceTextMapper.take(part) : part;
    yield {
      type: "audio_file",
      sequence,
      ...(text ? { text } : {}),
      textchunk: part,
      assetId: voice.assetId,
      filePath: voice.filePath
    };
    yield { type: "part_done", sequence };
    streamSequence += 1;
  }
  deps.appendLog?.("info", `tts stream tts complete: stream=${input.streamId ?? ""} files=${totalAudioFiles}`);
  }
  yield { type: "done" };
}

function createTtsSourceTextMapper(sourceText: string, translatedText: string): { take(translatedChunkText: string): string | undefined } {
  const sourceChars = Array.from(sourceText);
  const translatedChars = Array.from(translatedText);
  const sourceTotal = sourceChars.length;
  const translatedTotal = translatedChars.length;
  const boundaries = sourceTextBoundaries(sourceChars);
  let translatedCursor = 0;
  let sourceCursor = 0;

  return {
    take(translatedChunkText: string): string | undefined {
      const translatedChunkChars = Array.from(translatedChunkText).length;
      if (sourceCursor >= sourceTotal || translatedChunkChars <= 0) return undefined;
      translatedCursor = Math.min(translatedTotal, translatedCursor + translatedChunkChars);
      const rawTarget = translatedTotal > 0
        ? Math.round((translatedCursor / translatedTotal) * sourceTotal)
        : sourceTotal;
      const target = translatedCursor >= translatedTotal
        ? sourceTotal
        : nearestSourceBoundary(rawTarget, sourceCursor, sourceTotal, boundaries);
      const end = Math.min(sourceTotal, Math.max(sourceCursor + 1, target));
      const text = sourceChars.slice(sourceCursor, end).join("").trim();
      sourceCursor = end;
      return text || undefined;
    }
  };
}

export function createTtsPcmProgressTextMapper(
  text: string,
  totalAudioBytes: number,
  options: { sampleRate?: number; channels?: number; bytesPerSample?: number } = {}
): { take(chunkBytes: number): string | undefined } {
  const chars = Array.from(text);
  const totalChars = chars.length;
  const bytesPerMs = ((options.sampleRate ?? 32_000) * (options.channels ?? 1) * (options.bytesPerSample ?? 2)) / 1000;
  const totalMs = bytesPerMs > 0 ? totalAudioBytes / bytesPerMs : 0;
  let elapsedMs = 0;
  let cursor = 0;
  return {
    take(chunkBytes: number): string | undefined {
      if (cursor >= totalChars || totalChars <= 0) return undefined;
      elapsedMs += bytesPerMs > 0 ? chunkBytes / bytesPerMs : 0;
      const rawTarget = totalMs > 0 ? Math.round((elapsedMs / totalMs) * totalChars) : totalChars;
      const target = Math.min(totalChars, Math.max(cursor + 1, snapTtsTextBoundary(chars, rawTarget, cursor)));
      const value = chars.slice(cursor, target).join("").trim();
      cursor = target;
      return value || undefined;
    }
  };
}

function snapTtsTextBoundary(chars: string[], rawTarget: number, cursor: number): number {
  if (rawTarget >= chars.length) return chars.length;
  const boundary = nearestBoundary(chars, rawTarget, cursor, TTS_SENTENCE_ENDING_PATTERN);
  if (boundary !== undefined) return boundary;
  return Math.min(chars.length, Math.max(cursor + 1, rawTarget));
}

function nearestBoundary(chars: string[], rawTarget: number, cursor: number, pattern: RegExp): number | undefined {
  const candidates: number[] = [];
  for (let index = cursor; index < chars.length; index += 1) {
    if (pattern.test(chars[index]!)) candidates.push(index + 1);
  }
  if (!candidates.length) return undefined;
  const clamped = Math.min(chars.length, Math.max(cursor + 1, rawTarget));
  let nearest = candidates[0]!;
  let distance = Math.abs(nearest - clamped);
  for (const candidate of candidates.slice(1)) {
    const nextDistance = Math.abs(candidate - clamped);
    if (nextDistance < distance) {
      nearest = candidate;
      distance = nextDistance;
    }
  }
  return nearest > cursor ? nearest : undefined;
}

function sourceTextBoundaries(chars: string[]): number[] {
  const boundaries: number[] = [];
  chars.forEach((char, index) => {
    if (/[。！？.!?,，、；;：:\n]/.test(char)) boundaries.push(index + 1);
  });
  if (chars.length > 0 && boundaries[boundaries.length - 1] !== chars.length) boundaries.push(chars.length);
  return boundaries;
}

function nearestSourceBoundary(target: number, cursor: number, total: number, boundaries: number[]): number {
  const clamped = Math.min(total, Math.max(cursor + 1, target));
  const candidates = boundaries.filter((boundary) => boundary > cursor);
  if (!candidates.length) return clamped;
  let nearest = candidates[0]!;
  let nearestDistance = Math.abs(nearest - clamped);
  for (const boundary of candidates.slice(1)) {
    const distance = Math.abs(boundary - clamped);
    if (distance < nearestDistance) {
      nearest = boundary;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export async function collectTtsStreamText(text: AsyncIterable<string> | Iterable<string> | string): Promise<string> {
  let collected = "";
  for await (const chunk of iterateTextChunks(text)) {
    collected += chunk;
  }
  return collected.trim();
}

export async function* splitTtsStreamParts(
  text: AsyncIterable<string> | Iterable<string> | string,
  options: { minFlushChars?: number; maxFlushChars?: number; softBoundaryChars?: number } = {}
): AsyncIterable<string> {
  const minFlushChars = options.minFlushChars ?? 10;
  const maxFlushChars = options.maxFlushChars ?? 40;
  const softBoundaryChars = options.softBoundaryChars ?? 20;
  let pending = "";
  for await (const chunk of iterateTextChunks(text)) {
    pending += chunk;
    while (true) {
      const part = takeTtsStreamPart(pending, { minFlushChars, maxFlushChars, softBoundaryChars });
      if (!part) break;
      pending = pending.slice(part.length).trimStart();
      const normalized = part.trim();
      if (normalized) yield normalized;
    }
  }
  const remaining = pending.trim();
  if (remaining) yield remaining;
}

export function splitTtsTextChunks(text: string, options: { minChars?: number } = {}): string[] {
  const minChars = options.minChars ?? 12;
  const blocks = splitTtsTextBlocks(text);
  const chunks: string[] = [];
  let pending = "";
  for (const block of blocks) {
    pending += block;
    if (Array.from(pending).length >= minChars) {
      chunks.push(pending);
      pending = "";
    }
  }
  if (pending) {
    if (chunks.length > 0 && Array.from(pending).length < minChars) {
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}${pending}`;
    } else {
      chunks.push(pending);
    }
  }
  return chunks.map((chunk) => chunk.trim()).filter(Boolean);
}

const TTS_SENTENCE_ENDING_PATTERN = /[。！？.!?．]/u;

function splitTtsTextBlocks(text: string): string[] {
  const blocks: string[] = [];
  let pending = "";
  for (const char of Array.from(text)) {
    pending += char;
    if (TTS_SENTENCE_ENDING_PATTERN.test(char)) {
      blocks.push(pending);
      pending = "";
    }
  }
  if (pending) blocks.push(pending);
  return blocks;
}

async function* iterateTextChunks(text: AsyncIterable<string> | Iterable<string> | string): AsyncIterable<string> {
  if (typeof text === "string") {
    yield text;
    return;
  }
  for await (const chunk of text as AsyncIterable<string>) {
    if (chunk) yield String(chunk);
  }
}

function takeTtsStreamPart(
  pending: string,
  options: { minFlushChars: number; maxFlushChars: number; softBoundaryChars: number }
): string | undefined {
  const chars = Array.from(pending);
  if (chars.length < options.minFlushChars) return undefined;
  for (let index = 0; index < pending.length; index += 1) {
    if (TTS_SENTENCE_ENDING_PATTERN.test(pending[index]!)) {
      return pending.slice(0, index + 1);
    }
  }
  const hardLimit = Math.min(chars.length, options.maxFlushChars);
  for (let index = 0, seen = 0; index < pending.length; index += 1) {
    const char = pending[index]!;
    seen += 1;
    if (seen >= options.softBoundaryChars && TTS_SENTENCE_ENDING_PATTERN.test(char)) {
      return pending.slice(0, index + 1);
    }
    if (seen >= hardLimit) {
      return pending.slice(0, index + 1);
    }
  }
  return undefined;
}
