import { createCurrentTimeProvider } from "../../../platform/time/src/index.js";
import type { ServerOutboundAudioTrack, TtsTask, WebRtcVoiceDeps, WebRtcVoiceTtsArchiveInput } from "./types.js";
import { WebRtcVoiceError } from "./errors.js";
import { abortableAsyncIterable, raceWithAbort, stripParenthesizedText } from "./utils.js";

export type TtsReadyChunk = {
  outputId?: string;
  chunkId?: string;
  originalText: string;
  speakText: string;
  text: string;
  createdAt: string;
  assetId: string;
  filePath?: string;
  audio?: {
    chunks: Uint8Array[];
    sampleRateHz: number;
    channels: number;
  };
  interruptEpoch?: number;
  failureReason?: "tts_failed" | "outbound_audio_not_ready" | "no_frames_sent";
};

type TtsOutputState = {
  outputId: string;
  chunkId?: string;
  originalText: string;
  createdAt: string;
  text: AsyncTextQueue;
  task: TtsTask;
  promise: Promise<void>;
};

export function createTtsProducer(ctx: {
  callId: string;
  talkSessionId: string;
  deps: WebRtcVoiceDeps;
  outboundTrack: ServerOutboundAudioTrack;
  activeTtsTasks: Set<TtsTask>;
  synthesisTime: ReturnType<typeof createCurrentTimeProvider>;
  getPlaybackGeneration(): number;
  getInterruptEpoch(): number;
  archiveTtsOutput(deps: WebRtcVoiceDeps, input: WebRtcVoiceTtsArchiveInput): Promise<void>;
}) {
  let current: TtsOutputState | undefined;
  let readyChunk: TtsReadyChunk | undefined;
  const readyChunkTakenWaiters: Array<() => void> = [];

  return {
    openOutput(input: { outputId: string; chunkId?: string; originalText?: string }): void {
      if (current) {
        if (current.outputId === input.outputId) return;
        throw new Error(`tts output already open: ${current.outputId}`);
      }
      const createdAt = (ctx.deps.now?.() ?? new Date()).toISOString();
      const generation = ctx.getPlaybackGeneration();
      const ttsTask: TtsTask = {
        id: `tts:${ctx.callId}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
        outputId: input.outputId,
        controller: new AbortController()
      };
      const text = new AsyncTextQueue();
      const state: TtsOutputState = {
        outputId: input.outputId,
        chunkId: input.chunkId,
        originalText: input.originalText ?? "",
        createdAt,
        text,
        task: ttsTask,
        promise: Promise.resolve()
      };
      state.promise = runOutput(state, generation).catch(async (error) => {
        if (ttsTask.controller.signal.aborted) return;
        ctx.deps.emitStatus?.({ state: "voice_call.output_pump.playback_failed", detail: error instanceof Error ? error.message : String(error) });
        await publishReadyChunk({
          outputId: state.outputId,
          chunkId: state.chunkId,
          originalText: state.originalText,
          speakText: state.originalText,
          text: "",
          createdAt: state.createdAt,
          assetId: "",
          filePath: "",
          interruptEpoch: ctx.getInterruptEpoch(),
          failureReason: "tts_failed"
        });
      }).finally(() => {
        ctx.activeTtsTasks.delete(ttsTask);
        ttsTask.controller.abort(new Error("tts_task_finished"));
        if (current === state) current = undefined;
      });
      current = state;
      ctx.activeTtsTasks.add(ttsTask);
    },
    pushText(input: { outputId: string; text: string }): void {
      if (!current || current.outputId !== input.outputId) throw new Error(`tts output not open: ${input.outputId}`);
      current.originalText += input.text;
      current.text.push(input.text);
    },
    finishOutput(input: { outputId: string }): void {
      if (!current || current.outputId !== input.outputId) return;
      current.text.finish();
    },
    takeReadyChunk(): TtsReadyChunk | undefined {
      const chunk = readyChunk;
      if (!chunk) return undefined;
      readyChunk = undefined;
      wakeReadyChunkTakenWaiters();
      return chunk;
    },
    currentOutput(): { outputId: string; chunkId?: string; originalText: string } | undefined {
      return current ? { outputId: current.outputId, chunkId: current.chunkId, originalText: current.originalText } : undefined;
    },
    abort(reason: string): void {
      readyChunk = undefined;
      wakeReadyChunkTakenWaiters();
      if (!current) return;
      current.text.abort();
      current.task.controller.abort(new Error(reason));
      current = undefined;
    }
  };

  async function runOutput(state: TtsOutputState, generation: number): Promise<void> {
    const outputId = state.outputId;
    const textInput = ctx.deps.config.ttsTextFilter?.stripParenthesized
      ? stripTextIterable(state.text)
      : state.text;
    const speakTextForMeta = () => ctx.deps.config.ttsTextFilter?.stripParenthesized
      ? stripParenthesizedText(state.originalText)
      : state.originalText;
    const speakTextForEvent = (event: { text?: string; textchunk?: string }) => {
      const text = event.text?.trim() || event.textchunk?.trim();
      return text || speakTextForMeta();
    };
    let produced = false;
    try {
      let ready: boolean | undefined;
      try {
        ready = await raceWithAbort(Promise.resolve(ctx.outboundTrack.waitUntilReady?.(ctx.deps.config.timeouts.ttsPlaybackStartMs) ?? true), state.task.controller.signal);
      } catch (error) {
        if (state.task.controller.signal.aborted) return;
        throw error;
      }
      if (ready === false) {
        ctx.deps.emitStatus?.({ state: "tts.failed", detail: "outbound_audio_not_ready" });
        await publishReadyChunk({
          outputId,
          chunkId: state.chunkId,
          originalText: state.originalText,
          speakText: speakTextForMeta(),
          text: "",
          createdAt: state.createdAt,
          assetId: "",
          filePath: "",
          interruptEpoch: ctx.getInterruptEpoch(),
          failureReason: "outbound_audio_not_ready"
        });
        return;
      }

      const stream = ctx.deps.voiceSynthesizer.stream
        ? ctx.deps.voiceSynthesizer.stream({
          text: textInput,
          time: ctx.synthesisTime,
          source: "send_chat.voice",
          streamId: outputId,
          beforeBackendRequest: async () => {
            await waitForReadyChunkTaken(state.task.controller.signal);
          }
        })
        : synthesizeSingleFile(ctx.deps, collectText(textInput), ctx.synthesisTime, async () => {
          await waitForReadyChunkTaken(state.task.controller.signal);
        });

      ctx.deps.emitStatus?.({ state: "tts.stream.started", detail: outputId });
      for await (const rawEvent of abortableAsyncIterable(stream, state.task.controller.signal)) {
        const event = normalizeTtsStreamEvent(rawEvent);
        if (!event) continue;
        if (state.task.controller.signal.aborted || generation !== ctx.getPlaybackGeneration()) break;
        if (event.type === "translation_started") {
          ctx.deps.emitStatus?.({ state: "tts.stream.translation_started", detail: `${event.sequence}:${event.sourceChars}` });
          continue;
        }
        if (event.type === "translation_done") {
          ctx.deps.emitStatus?.({ state: "tts.stream.translation_done", detail: `${event.sequence}:${event.translatedChars}` });
          continue;
        }
        if (event.type === "part_done") {
          ctx.deps.emitStatus?.({ state: "tts.stream.part_done", detail: String(event.sequence) });
          continue;
        }
        if (event.type === "done") {
          ctx.deps.emitStatus?.({ state: "tts.stream.done", detail: outputId });
          break;
        }
        if (event.type === "audio") {
          const speakText = speakTextForEvent(event);
          await publishReadyChunk({
            outputId,
            chunkId: state.chunkId,
            originalText: state.originalText,
            speakText,
            text: event.text ?? speakText,
            createdAt: state.createdAt,
            assetId: `stream:${outputId}:${event.sequence}`,
            filePath: undefined,
            audio: {
              chunks: [event.chunk],
              sampleRateHz: event.sampleRateHz,
              channels: event.channels
            },
            interruptEpoch: ctx.getInterruptEpoch()
          });
          produced = true;
          continue;
        }
        if (event.type !== "audio_file") continue;
        const speakText = speakTextForEvent(event);
        await publishReadyChunk({
          outputId,
          chunkId: state.chunkId,
          originalText: state.originalText,
          speakText,
          text: event.text ?? event.textchunk ?? speakText,
          createdAt: state.createdAt,
          assetId: event.assetId,
          filePath: event.filePath,
          interruptEpoch: ctx.getInterruptEpoch()
        });
        produced = true;
      }
      if (!produced && !state.task.controller.signal.aborted && generation === ctx.getPlaybackGeneration()) {
        ctx.deps.emitStatus?.({ state: "tts.failed", detail: `${outputId} no_frames_sent` });
        await publishReadyChunk({
          outputId,
          chunkId: state.chunkId,
          originalText: state.originalText,
          speakText: speakTextForMeta(),
          text: "",
          createdAt: state.createdAt,
          assetId: "",
          filePath: "",
          interruptEpoch: ctx.getInterruptEpoch(),
          failureReason: "no_frames_sent"
        });
      }
    } catch (error) {
      if (state.task.controller.signal.aborted) return;
      throw new WebRtcVoiceError("tts_failed", error instanceof Error ? error.message : String(error));
    }
  }

  async function publishReadyChunk(chunk: TtsReadyChunk): Promise<void> {
    await waitForReadyChunkTaken();
    readyChunk = chunk;
    ctx.deps.emitStatus?.({ state: "tts.queue.ready", detail: playbackDetail(chunk.outputId, chunk.chunkId) });
    if (chunk.filePath || chunk.audio) {
      await ctx.archiveTtsOutput(ctx.deps, {
        callId: ctx.callId,
        talkSessionId: ctx.talkSessionId,
        outputId: chunk.outputId,
        chunkId: chunk.chunkId,
        originalText: chunk.originalText,
        text: chunk.text,
        speakText: chunk.speakText,
        createdAt: chunk.createdAt,
        status: "queued",
        source: chunk.audio ? "stream" : "file",
        assetId: chunk.assetId,
        filePath: chunk.filePath,
        audio: chunk.audio ? { ...chunk.audio, encoding: "pcm_s16le" } : undefined
      });
    }
  }

  async function waitForReadyChunkTaken(signal?: AbortSignal): Promise<void> {
    while (readyChunk) {
      const wait = new Promise<void>((resolve) => readyChunkTakenWaiters.push(resolve));
      await (signal ? raceWithAbort(wait, signal) : wait);
    }
  }

  function wakeReadyChunkTakenWaiters(): void {
    const waiters = readyChunkTakenWaiters.splice(0, readyChunkTakenWaiters.length);
    for (const waiter of waiters) waiter();
  }
}

function playbackDetail(outputId?: string, chunkId?: string): string {
  if (!outputId && !chunkId) return "";
  return `${outputId ?? ""}${chunkId ? ` chunk=${chunkId}` : ""}`;
}

function normalizeTtsStreamEvent(event: unknown) {
  if (!event || typeof event !== "object") return undefined;
  const value = event as Record<string, unknown>;
  if (value.type === "translation_started" && typeof value.sequence === "number" && typeof value.sourceChars === "number") {
    return { type: "translation_started" as const, sequence: value.sequence, sourceChars: value.sourceChars };
  }
  if (value.type === "translation_done" && typeof value.sequence === "number" && typeof value.translatedChars === "number") {
    return { type: "translation_done" as const, sequence: value.sequence, translatedChars: value.translatedChars };
  }
  if (value.type === "part_done" && typeof value.sequence === "number") {
    return { type: "part_done" as const, sequence: value.sequence };
  }
  if (value.type === "done") return { type: "done" as const };
  if (value.type === "audio_file" && typeof value.sequence === "number" && typeof value.assetId === "string" && typeof value.filePath === "string") {
    return {
      type: "audio_file" as const,
      sequence: value.sequence,
      text: typeof value.text === "string" ? value.text : undefined,
      textchunk: typeof value.textchunk === "string" ? value.textchunk : undefined,
      assetId: value.assetId,
      filePath: value.filePath
    };
  }
  if (value.type === "audio" && typeof value.sequence === "number" && (value.chunk instanceof Uint8Array || value.soundchunk instanceof Uint8Array)) {
    const contentType = typeof value.contentType === "string" ? value.contentType : "";
    const chunk = value.soundchunk instanceof Uint8Array ? value.soundchunk : value.chunk as Uint8Array;
    return {
      type: "audio" as const,
      sequence: value.sequence,
      text: typeof value.textchunk === "string" ? value.textchunk : typeof value.text === "string" ? value.text : undefined,
      chunk,
      sampleRateHz: typeof value.sampleRateHz === "number" ? value.sampleRateHz : sampleRateFromContentType(contentType) ?? 32_000,
      channels: typeof value.channels === "number" ? value.channels : channelsFromContentType(contentType) ?? 1
    };
  }
  return undefined;
}

function sampleRateFromContentType(contentType: string): number | undefined {
  const match = /rate=(\d+)/i.exec(contentType);
  return match ? Number(match[1]) : undefined;
}

function channelsFromContentType(contentType: string): number | undefined {
  const match = /channels=(\d+)/i.exec(contentType);
  return match ? Number(match[1]) : undefined;
}

async function* synthesizeSingleFile(
  deps: WebRtcVoiceDeps,
  text: string | Promise<string>,
  time: ReturnType<typeof createCurrentTimeProvider>,
  beforeBackendRequest?: (input: { sequence: number; text: string }) => void | Promise<void>
) {
  const value = await text;
  await beforeBackendRequest?.({ sequence: 0, text: value });
  const voice = await deps.voiceSynthesizer({ text: value, time });
  yield { type: "audio_file" as const, sequence: 0, text: value, textchunk: value, assetId: voice.assetId, filePath: voice.filePath };
  yield { type: "done" as const };
}

async function collectText(text: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of text) out += chunk;
  return out;
}

async function* stripTextIterable(text: AsyncIterable<string>): AsyncIterable<string> {
  for await (const chunk of text) {
    const stripped = stripParenthesizedText(chunk);
    yield chunk.endsWith("\n") && stripped && !stripped.endsWith("\n") ? `${stripped}\n` : stripped;
  }
}

class AsyncTextQueue implements AsyncIterable<string> {
  private chunks: string[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  push(text: string): void {
    if (this.closed || !text) return;
    this.chunks.push(text);
    this.wake();
  }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
  }

  abort(): void {
    this.finish();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      const chunk = this.chunks.shift();
      if (chunk !== undefined) {
        yield chunk;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private wake(): void {
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const waiter of waiters) waiter();
  }
}
