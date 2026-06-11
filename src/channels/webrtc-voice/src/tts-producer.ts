import { createCurrentTimeProvider } from "../../../platform/time/src/index.js";
import type { PlaybackItem, PlaybackResult, ServerOutboundAudioTrack, TtsTask, WebRtcVoiceDeps, WebRtcVoiceTtsArchiveInput } from "./types.js";
import { WebRtcVoiceError } from "./errors.js";
import type { VoicePlaybackConsumer } from "./playback-consumer.js";
import { abortableAsyncIterable, hashText, raceWithAbort, sleep, stripParenthesizedText } from "./utils.js";

const maxQueuedPlaybackItems = 2;

export function createTtsProducer(ctx: {
  callId: string;
  talkSessionId: string;
  deps: WebRtcVoiceDeps;
  outboundTrack: ServerOutboundAudioTrack;
  playbackQueue: PlaybackItem[];
  activeTtsTasks: Set<TtsTask>;
  playback: VoicePlaybackConsumer;
  synthesisTime: ReturnType<typeof createCurrentTimeProvider>;
  getPlaybackGeneration(): number;
  getInterruptEpoch(): number;
  archiveTtsOutput(deps: WebRtcVoiceDeps, input: WebRtcVoiceTtsArchiveInput): Promise<void>;
}) {
  const mediaPlaybackItems: PlaybackItem[] = [];
  let reservedPlaybackSlots = 0;
  const playbackDetail = (item: PlaybackItem, fallback?: string) => {
    const output = item.outputId ?? fallback;
    if (!output && !item.chunkId) return fallback ?? "";
    return `${output ?? ""}${item.chunkId ? ` chunk=${item.chunkId}` : ""}`;
  };
  const waitForPlaybackItemSettled = async (item: PlaybackItem) => {
    while (ctx.playbackQueue.includes(item) && item.status !== "failed" && item.status !== "interrupted" && item.status !== "cancelled") {
      ctx.playback.cleanupFinishedItems();
      if (!ctx.playbackQueue.includes(item)) break;
      await sleep(5);
    }
  };
  const createPlaybackItem = (input: {
    outputId?: string;
    chunkId?: string;
    originalText: string;
    speakText: string;
    text: string;
    createdAt: string;
    assetId: string;
    filePath: string;
    beforeFirstPlayback?: () => Promise<void> | void;
  }): PlaybackItem => ({
    outputId: input.outputId,
    chunkId: input.chunkId,
    originalText: input.originalText,
    speakText: input.text,
    textHash: hashText(input.speakText),
    assetId: input.assetId,
    filePath: input.filePath,
    status: "queued",
    createdAt: input.createdAt,
    framesWritten: 0,
    playedMs: 0,
    totalMs: 0,
    interruptEpoch: ctx.getInterruptEpoch(),
    ttsAudioTextSpans: [{ text: input.text, audio: new Uint8Array(), startMs: 0, endMs: 1 }],
    queuedFrames: 0,
    producerDone: false,
    pendingPlaybackEvents: 0,
    beforeFirstPlayback: input.beforeFirstPlayback
  });
  return {
    async playReplyText(text: string | AsyncIterable<string>, outputId?: string, options?: unknown): Promise<PlaybackResult> {
      const originalText = playbackOptionString(options, "originalText") ?? (typeof text === "string" ? text : "");
      const speakText = typeof text === "string" && ctx.deps.config.ttsTextFilter?.stripParenthesized ? stripParenthesizedText(text) : text;
      const speakTextForMeta = typeof speakText === "string" ? speakText : originalText;
      const createdAt = (ctx.deps.now?.() ?? new Date()).toISOString();
      const generation = ctx.getPlaybackGeneration();
      const playedItems: PlaybackItem[] = [];
      const remoteSettlements: Array<Promise<void>> = [];
      let taskReservedPlaybackSlots = 0;
      const ttsTask: TtsTask = {
        id: `tts:${ctx.callId}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
        outputId,
        controller: new AbortController()
      };
      const reservePlaybackQueueSlot = async () => {
        while (activePlaybackItemCount() + reservedPlaybackSlots >= maxQueuedPlaybackItems) {
          ctx.deps.emitStatus?.({ state: "tts.queue.backpressure", detail: `${outputId ?? ""} active=${activePlaybackItemCount()} reserved=${reservedPlaybackSlots}`.trim() });
          await raceWithAbort(sleep(20), ttsTask.controller.signal);
        }
        reservedPlaybackSlots += 1;
        taskReservedPlaybackSlots += 1;
      };
      const consumePlaybackQueueReservation = async () => {
        if (taskReservedPlaybackSlots <= 0) await reservePlaybackQueueSlot();
        reservedPlaybackSlots = Math.max(0, reservedPlaybackSlots - 1);
        taskReservedPlaybackSlots = Math.max(0, taskReservedPlaybackSlots - 1);
      };
      ctx.activeTtsTasks.add(ttsTask);
      try {
        let ready: boolean | undefined;
        try {
          ready = await raceWithAbort(Promise.resolve(ctx.outboundTrack.waitUntilReady?.(ctx.deps.config.timeouts.ttsPlaybackStartMs) ?? true), ttsTask.controller.signal);
        } catch (error) {
          if (ttsTask.controller.signal.aborted) return { status: "interrupted", outputId, frameCount: 0 };
          throw error;
        }
        if (ready === false) {
          ctx.deps.emitStatus?.({ state: "tts.failed", detail: "outbound_audio_not_ready" });
          return { status: "interrupted", outputId, frameCount: 0, failureReason: "outbound_audio_not_ready" };
        }

        const stream = ctx.deps.voiceSynthesizer.stream
          ? ctx.deps.voiceSynthesizer.stream({
            text: speakText,
            time: ctx.synthesisTime,
            source: "send_chat.voice",
            streamId: outputId,
            onInputBufferIdle: playbackOptionCallback(options, "onInputBufferIdle"),
            beforeBackendRequest: reservePlaybackQueueSlot
          })
          : synthesizeSingleFile(ctx.deps, speakText, ctx.synthesisTime, reservePlaybackQueueSlot);

        ctx.deps.emitStatus?.({ state: "tts.stream.started", detail: outputId });
        for await (const rawEvent of abortableAsyncIterable(stream, ttsTask.controller.signal)) {
          const event = normalizeTtsStreamEvent(rawEvent);
          if (!event) continue;
          if (ttsTask.controller.signal.aborted || generation !== ctx.getPlaybackGeneration()) break;
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
          if (event.type !== "audio_file") continue;
          await consumePlaybackQueueReservation();
          if (ctx.outboundTrack.enqueueAudioFile) {
            const itemId = `playback:${ctx.callId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
            if (playedItems.length === 0) await playbackOptionCallback(options, "beforeFirstPlayback")?.();
            const item = createPlaybackItem({
              outputId,
              chunkId: playbackOptionString(options, "chunkId"),
              originalText,
              speakText: speakTextForMeta,
              text: event.text ?? event.textchunk ?? speakTextForMeta,
              createdAt,
              assetId: event.assetId,
              filePath: event.filePath
            });
            playedItems.push(item);
            mediaPlaybackItems.push(item);
            const enqueued = await ctx.outboundTrack.enqueueAudioFile({
              itemId,
              outputId,
              chunkId: item.chunkId,
              originalText,
              speakText: speakTextForMeta,
              text: event.text ?? event.textchunk ?? speakTextForMeta,
              createdAt,
              assetId: event.assetId,
              filePath: event.filePath,
              interruptEpoch: item.interruptEpoch,
              beforeFirstPlayback: playedItems.length === 1
            });
            ctx.deps.emitStatus?.({ state: "tts.queue.ready", detail: playbackDetail(item, outputId) });
            await ctx.archiveTtsOutput(ctx.deps, {
              callId: ctx.callId,
              talkSessionId: ctx.talkSessionId,
              outputId,
              chunkId: item.chunkId,
              text: item.originalText ?? "",
              speakText: item.speakText ?? "",
              createdAt,
              status: item.status,
              source: "file",
              assetId: item.assetId,
              filePath: item.filePath
            });
            remoteSettlements.push(Promise.resolve(ctx.outboundTrack.waitForPlaybackItem?.(enqueued.itemId)).then((settled) => {
              if (!settled) return;
              item.status = settled.status === "played" ? "played" : settled.status === "failed" ? "failed" : "interrupted";
              item.framesWritten = settled.framesWritten;
              item.playedMs = settled.playedMs;
              item.totalMs = settled.totalMs;
            }));
            continue;
          }
          const item = createPlaybackItem({
            outputId,
            chunkId: playbackOptionString(options, "chunkId"),
            originalText,
            speakText: speakTextForMeta,
            text: event.text ?? event.textchunk ?? speakTextForMeta,
            createdAt,
            assetId: event.assetId,
            filePath: event.filePath,
            beforeFirstPlayback: playedItems.length === 0 ? playbackOptionCallback(options, "beforeFirstPlayback") : undefined
          });
          ctx.playbackQueue.push(item);
          playedItems.push(item);
          ctx.playback.start();
          ctx.deps.emitStatus?.({ state: "tts.queue.ready", detail: playbackDetail(item, outputId) });
          await ctx.archiveTtsOutput(ctx.deps, {
            callId: ctx.callId,
            talkSessionId: ctx.talkSessionId,
            outputId,
            chunkId: item.chunkId,
            text: item.originalText ?? "",
            speakText: item.speakText ?? "",
            createdAt,
            status: item.status,
            source: "file",
            assetId: item.assetId,
            filePath: item.filePath
          });
        }

        if (remoteSettlements.length > 0) await Promise.all(remoteSettlements);
        else for (const item of playedItems) await waitForPlaybackItemSettled(item);
        const interrupted = ttsTask.controller.signal.aborted || generation !== ctx.getPlaybackGeneration();
        const failed = !interrupted && (playedItems.length === 0 || playedItems.every((item) => item.status === "failed"));
        const frameCount = playedItems.reduce((sum, item) => sum + item.framesWritten, 0);
        if (failed) ctx.deps.emitStatus?.({ state: "tts.failed", detail: `${outputId ?? ""} no_frames_sent`.trim() });
        else ctx.deps.emitStatus?.({ state: interrupted ? "tts.interrupted" : "tts.played", detail: outputId });
        return {
          status: interrupted || failed ? "interrupted" : "played",
          outputId,
          frameCount,
          failureReason: failed ? "no_frames_sent" : undefined
        };
      } catch (error) {
        for (const item of playedItems) item.status = ttsTask.controller.signal.aborted ? "interrupted" : "failed";
        if (ttsTask.controller.signal.aborted) return { status: "interrupted", outputId, frameCount: playedItems.reduce((sum, item) => sum + item.framesWritten, 0) };
        throw new WebRtcVoiceError("tts_failed", error instanceof Error ? error.message : String(error));
      } finally {
        reservedPlaybackSlots = Math.max(0, reservedPlaybackSlots - taskReservedPlaybackSlots);
        taskReservedPlaybackSlots = 0;
        ctx.activeTtsTasks.delete(ttsTask);
        ttsTask.controller.abort(new Error("tts_task_finished"));
      }
    }
  };

  function activePlaybackItemCount(): number {
    if (!ctx.outboundTrack.enqueueAudioFile) {
      ctx.playback.cleanupFinishedItems();
      return ctx.playbackQueue.filter(isActivePlaybackItem).length;
    }
    for (let index = mediaPlaybackItems.length - 1; index >= 0; index -= 1) {
      if (!isActivePlaybackItem(mediaPlaybackItems[index]!)) mediaPlaybackItems.splice(index, 1);
    }
    return mediaPlaybackItems.length;
  }
}

function isActivePlaybackItem(item: PlaybackItem): boolean {
  return item.status === "queued" || item.status === "playing";
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
  return undefined;
}

async function* synthesizeSingleFile(
  deps: WebRtcVoiceDeps,
  text: string | AsyncIterable<string>,
  time: ReturnType<typeof createCurrentTimeProvider>,
  beforeBackendRequest?: (input: { sequence: number; text: string }) => void | Promise<void>
) {
  if (typeof text !== "string") throw new Error("streaming text requires tts synthesizer stream");
  await beforeBackendRequest?.({ sequence: 0, text });
  const voice = await deps.voiceSynthesizer({ text, time });
  yield { type: "audio_file" as const, sequence: 0, text, textchunk: text, assetId: voice.assetId, filePath: voice.filePath };
  yield { type: "done" as const };
}

function playbackOptionString(options: unknown, key: string): string | undefined {
  return options && typeof options === "object" && typeof (options as Record<string, unknown>)[key] === "string"
    ? (options as Record<string, string>)[key]
    : undefined;
}

function playbackOptionCallback(options: unknown, key: string): (() => Promise<void> | void) | undefined {
  return options && typeof options === "object" && typeof (options as Record<string, unknown>)[key] === "function"
    ? (options as Record<string, () => Promise<void> | void>)[key]
    : undefined;
}
