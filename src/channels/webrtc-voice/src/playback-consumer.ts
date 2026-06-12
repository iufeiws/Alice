import type {
  PlaybackConsumer,
  PlaybackFrame,
  PlaybackItem,
  PlaybackTimelineEvent,
  ServerAudioFrame,
  ServerOutboundAudioTrack,
  WebRtcVoiceDeps
} from "./types.js";
import { createAsyncQueue, sleep } from "./utils.js";

export type VoicePlaybackConsumer = ReturnType<typeof createVoicePlaybackConsumer>;

export function createVoicePlaybackConsumer(input: {
  deps: WebRtcVoiceDeps;
  talkSessionId: string;
  playbackQueue: PlaybackItem[];
  outboundTrack: ServerOutboundAudioTrack;
  stampOutboundFrame(frame: ServerAudioFrame): ServerAudioFrame;
  advanceOutboundRtpClockForFrame(frame: ServerAudioFrame): void;
  writeOutboundSilenceFrame(durationMs?: number): Promise<boolean>;
  isClosed(): boolean;
}): {
  consumer: PlaybackConsumer;
  currentPlayingItem(): PlaybackItem | undefined;
  setCurrentPlayingItem(item: PlaybackItem | undefined): void;
  startTextCacheStatus(): void;
  stopTextCacheStatus(): void;
  processTimeline(nowMs?: number): void;
  updateTextCache(item: PlaybackItem, text: string | undefined, durationMs: number): void;
  updateConsumer(item: PlaybackItem, text: string | undefined, totalMs: number, options?: { emit?: boolean }): void;
  advanceConsumer(item: PlaybackItem, durationMs: number): void;
  recordAudioTextSpan(item: PlaybackItem, text: string | undefined, audio: Uint8Array, format?: { sampleRateHz?: number; channels?: number }): void;
  emitPlayingText(value: string | undefined): void;
  reportMissingPlayingText(item: PlaybackItem, frameIndex: number): void;
  enqueueFrame(item: PlaybackItem, frame: ServerAudioFrame, encodedMs: number): void;
  start(): void;
  cleanupFinishedItems(): void;
  clearPendingPlayback(): void;
  removeFramesFor(item: PlaybackItem): void;
  waitForTurn(item: PlaybackItem, gateOpen: () => boolean): Promise<boolean>;
} {
  const playbackTextAdvanceDelayMs = input.deps.config.outboundAudio.frameMs;
  const outboundPlaybackBufferTargetMs = Math.max(playbackTextAdvanceDelayMs, 120);
  const maxFrameWriteFailures = 3;
  const playbackFrameQueue = createAsyncQueue<PlaybackFrame>();
  const playbackTimelineEvents: PlaybackTimelineEvent[] = [];
  const decodingItems = new WeakSet<PlaybackItem>();
  const consumer: PlaybackConsumer = {
    playbackTextCache: "",
    playedMs: 0,
    totalMs: 0,
    status: "idle"
  };
  let playbackConsumerTask: Promise<void> | undefined;
  let playbackTextCacheStatusTimer: ReturnType<typeof setInterval> | undefined;
  let lastPublishedPlaybackTextCache = "";
  let lastPlayingText = "";
  let playbackClockMs = input.deps.now?.().getTime() ?? Date.now();
  let outboundBufferedUntilMs = 0;
  let currentPlayingItem: PlaybackItem | undefined;
  let underrunActive = false;

  const playbackDetail = (item: PlaybackItem | undefined, fallback?: string) => {
    const output = item?.outputId ?? fallback;
    const chunk = item?.chunkId;
    if (!output && !chunk) return fallback ?? "";
    return `${output ?? ""}${chunk ? ` chunk=${chunk}` : ""}`;
  };

  const normalizePlaybackTextCache = (text: string | undefined): string | undefined => {
    const value = text?.trim();
    if (!value) return undefined;
    if (["none", "null", "undefined", "nil"].includes(value.toLowerCase())) return undefined;
    return value;
  };
  const playbackNowMs = () => {
    if (input.deps.now) playbackClockMs = input.deps.now().getTime();
    return playbackClockMs;
  };
  const playbackSleep = async (ms: number) => {
    if (input.deps.sleep) {
      await input.deps.sleep(ms);
      await sleep(0);
    } else {
      await sleep(ms);
    }
    if (!input.deps.now) playbackClockMs += ms;
  };
  const updateConsumer = (item: PlaybackItem, text: string | undefined, totalMs: number, options?: { emit?: boolean }) => {
    const value = normalizePlaybackTextCache(text);
    if (!value || totalMs <= 0) return;
    if (
      consumer.outputId === item.outputId
      && consumer.chunkId === item.chunkId
      && consumer.playbackTextCache === value
    ) {
      consumer.totalMs = Math.max(consumer.totalMs, totalMs);
      if (options?.emit && consumer.playedMs === 0) {
        input.deps.emitStatus?.({
          state: "tts.playback.consumer",
          detail: `前文=${value} 时长=${consumer.totalMs}ms`
        });
      }
      return;
    }
    consumer.outputId = item.outputId;
    consumer.chunkId = item.chunkId;
    consumer.playbackTextCache = value;
    consumer.playedMs = 0;
    consumer.totalMs = totalMs;
    consumer.status = item.status === "playing" ? "playing" : "queued";
    if (options?.emit) {
      input.deps.emitStatus?.({
        state: "tts.playback.consumer",
        detail: `前文=${value} 时长=${totalMs}ms`
      });
    }
  };
  const emitPlayingText = (value: string | undefined) => {
    const playingText = value?.trim();
    if (!playingText || playingText === lastPlayingText) return;
    lastPlayingText = playingText;
    input.deps.emitStatus?.({ state: "tts.playing_text", detail: playingText });
  };
  const reportMissingPlayingText = (item: PlaybackItem, frameIndex: number) => {
    if (item.missingPlayingTextReported) return;
    item.missingPlayingTextReported = true;
    input.deps.emitStatus?.({
      state: "tts.playing_text.missing",
      detail: `output=${item.outputId ?? ""} frame=${frameIndex} spans=${item.ttsAudioTextSpans?.length ?? 0}`
    });
  };
  const playbackTextAt = (target: PlaybackItem, playedMs: number): string | undefined => {
    const spans = target.ttsAudioTextSpans;
    if (!spans?.length) return undefined;
    const value = Math.max(0, playedMs);
    return spans.find((span) => value >= span.startMs && value < span.endMs)?.text;
  };
  const playbackTextTotalMsAt = (target: PlaybackItem, playedMs: number): number | undefined => {
    const spans = target.ttsAudioTextSpans;
    if (!spans?.length) return undefined;
    const value = Math.max(0, playedMs);
    const span = spans.find((candidate) => value >= candidate.startMs && value < candidate.endMs);
    return span ? span.endMs - span.startMs : undefined;
  };
  const playbackTextBeforeBreakpoint = (): { chunkId: string; text: string } | undefined => {
    const text = consumer.playbackTextCache.trim();
    if (!text || consumer.totalMs <= 0) return undefined;
    const chars = Array.from(text);
    const playedRatio = Math.max(0, Math.min(1, consumer.playedMs / consumer.totalMs));
    const localIndex = Math.max(0, Math.min(chars.length, Math.round(chars.length * playedRatio)));
    const beforeText = chars.slice(0, localIndex).join("");
    if (!beforeText) return undefined;
    return {
      chunkId: consumer.chunkId ?? consumer.outputId ?? "",
      text: beforeText
    };
  };
  const updateTextCache = (item: PlaybackItem, text: string | undefined, durationMs: number) => {
    const value = normalizePlaybackTextCache(text);
    if (!value || durationMs <= 0 || (item.totalMs ?? 0) <= 0 || item.playbackTextCache === value) return;
    item.playbackTextCache = value;
  };
  const isPlaybackItemActive = (item: PlaybackItem) => {
    return input.playbackQueue.includes(item)
      && item.status !== "cancelled"
      && item.status !== "interrupted"
      && item.status !== "failed";
  };
  const discardInactiveQueuedFrames = () => {
    playbackFrameQueue.removeWhere((frame) => !isPlaybackItemActive(frame.item));
  };
  const enqueueFrame = (item: PlaybackItem, frame: ServerAudioFrame, encodedMs: number) => {
    if (!isPlaybackItemActive(item)) return;
    item.queuedFrames = (item.queuedFrames ?? 0) + 1;
    playbackFrameQueue.push({
      item,
      frame,
      text: playbackTextAt(item, encodedMs),
      textTotalMs: playbackTextTotalMsAt(item, encodedMs)
    });
  };
  const cleanupFinishedItems = () => {
    while (input.playbackQueue.length > 0) {
      const item = input.playbackQueue[0]!;
      if (!item.producerDone) return;
      if ((item.queuedFrames ?? 0) > item.framesWritten) return;
      if ((item.pendingPlaybackEvents ?? 0) > 0) return;
      item.status = item.framesWritten > 0 && item.status !== "failed" ? "played" : item.status === "failed" ? "failed" : "interrupted";
      if (currentPlayingItem === item) currentPlayingItem = undefined;
      input.playbackQueue.shift();
      if (consumer.outputId === item.outputId && consumer.chunkId === item.chunkId) {
        consumer.status = item.status === "failed" ? "failed" : "idle";
      }
      input.deps.emitStatus?.({
        state: item.status === "played" ? "tts.played" : "tts.failed",
        detail: item.status === "played" ? playbackDetail(item, item.outputId) : `${playbackDetail(item, item.outputId)}${item.framesWritten > 0 ? "" : " no_frames_sent"}`.trim()
      });
    }
  };
  const ensureItemFramesQueued = async (item: PlaybackItem) => {
    if (item.producerDone || decodingItems.has(item)) return;
    if (!item.filePath) return;
    decodingItems.add(item);
    try {
      const frames = await Promise.resolve(input.deps.decodeAudioFileToFrames({
        filePath: item.filePath,
        sampleRateHz: input.deps.config.outboundAudio.sampleRateHz,
        channels: input.deps.config.outboundAudio.channels,
        frameMs: input.deps.config.outboundAudio.frameMs
      }));
      let encodedMs = 0;
      for (const frame of frames) {
        enqueueFrame(item, frame, encodedMs);
        encodedMs += frame.durationMs;
      }
      item.totalMs = Math.max(item.totalMs ?? 0, encodedMs);
      updateTextCache(item, item.speakText, encodedMs);
      item.producerDone = true;
      input.deps.emitStatus?.({ state: "tts.queue.producer_done", detail: `${playbackDetail(item, item.outputId)} encoded=${frames.length} queued=${item.queuedFrames ?? 0}`.trim() });
      if (frames.length <= 0) item.status = "failed";
    } catch (error) {
      item.status = "failed";
      item.producerDone = true;
      input.deps.emitStatus?.({ state: "tts.decode.failed", detail: error instanceof Error ? error.message : String(error) });
    }
  };
  const processTimeline = (nowMs = playbackNowMs()) => {
    playbackTimelineEvents.sort((a, b) => a.atMs - b.atMs || (a.kind === "start" ? -1 : 1));
    while (playbackTimelineEvents.length > 0 && playbackTimelineEvents[0]!.atMs <= nowMs) {
      const event = playbackTimelineEvents.shift()!;
      if (!input.playbackQueue.includes(event.item) && event.item.status !== "playing" && event.item.status !== "played") continue;
      if (event.kind === "start") {
        updateConsumer(event.item, event.text, Math.max(event.textTotalMs ?? 0, event.item.totalMs ?? 0), { emit: true });
        if (event.text) emitPlayingText(event.text);
        else reportMissingPlayingText(event.item, event.frameIndex);
        continue;
      }
      advanceConsumer(event.item, event.durationMs);
      event.item.pendingPlaybackEvents = Math.max(0, (event.item.pendingPlaybackEvents ?? 0) - 1);
      cleanupFinishedItems();
    }
  };
  const consumeQueuedPlaybackFrame = async (playbackFrame: PlaybackFrame) => {
    const { item, frame, text: frameText, textTotalMs } = playbackFrame;
    if (!isPlaybackItemActive(item)) return false;
    if (!item.firstPlaybackStarted) {
      updateConsumer(item, frameText, Math.max(textTotalMs ?? 0, item.totalMs ?? 0));
      await item.beforeFirstPlayback?.();
      input.deps.emitStatus?.({ state: "voice_call.connected", detail: input.talkSessionId });
      item.firstPlaybackStarted = true;
    }
    item.status = "playing";
    consumer.status = "playing";
    currentPlayingItem = item;
    const nowMs = playbackNowMs();
    const frameStartAt = Math.max(outboundBufferedUntilMs, nowMs);
    const frameEndAt = frameStartAt + frame.durationMs;
    const written = await input.outboundTrack.writeFrame(input.stampOutboundFrame(frame));
    if (!written) {
      playbackFrame.writeFailures = (playbackFrame.writeFailures ?? 0) + 1;
      input.deps.emitStatus?.({
        state: "tts.playback.write_failed",
        detail: `${playbackDetail(item, item.outputId)} framesWritten=${item.framesWritten} queuedFrames=${item.queuedFrames ?? 0} attempt=${playbackFrame.writeFailures}`.trim()
      });
      if (playbackFrame.writeFailures < maxFrameWriteFailures) {
        playbackFrameQueue.unshift(playbackFrame);
        await playbackSleep(frame.durationMs);
      } else {
        item.status = "failed";
        item.producerDone = true;
        playbackFrameQueue.removeWhere((candidate) => candidate.item === item);
        item.queuedFrames = item.framesWritten;
        if (currentPlayingItem === item) currentPlayingItem = undefined;
        cleanupFinishedItems();
      }
      return false;
    }
    input.advanceOutboundRtpClockForFrame(frame);
    underrunActive = false;
    item.framesWritten += 1;
    item.playedMs = Math.max(item.playedMs ?? 0, item.framesWritten * frame.durationMs);
    item.totalMs = Math.max(item.totalMs ?? 0, item.framesWritten * frame.durationMs);
    item.pendingPlaybackEvents = (item.pendingPlaybackEvents ?? 0) + 1;
    outboundBufferedUntilMs = Math.max(outboundBufferedUntilMs, frameEndAt);
    const frameIndex = item.framesWritten;
    playbackTimelineEvents.push({ atMs: frameStartAt, kind: "start", item, text: frameText, textTotalMs, durationMs: frame.durationMs, frameIndex });
    playbackTimelineEvents.push({ atMs: frameEndAt, kind: "end", item, text: frameText, textTotalMs, durationMs: frame.durationMs, frameIndex });
    return true;
  };
  const start = () => {
    if (playbackConsumerTask) return;
    playbackConsumerTask = (async () => {
      while (!input.isClosed()) {
        const nowMs = playbackNowMs();
        processTimeline(nowMs);
        cleanupFinishedItems();
        discardInactiveQueuedFrames();
        const hasActivePlayback = input.playbackQueue.some((item) => item.status === "queued" || item.status === "playing");
        if (!hasActivePlayback && playbackFrameQueue.length === 0) {
          playbackConsumerTask = undefined;
          return;
        }
        const streamLeftMs = Math.max(0, outboundBufferedUntilMs - nowMs);
        if (streamLeftMs >= outboundPlaybackBufferTargetMs) {
          await playbackSleep(playbackTextAdvanceDelayMs);
          continue;
        }
        const head = input.playbackQueue.find((item) => item.status === "queued" || item.status === "playing");
        if (head) await ensureItemFramesQueued(head);
        let drained = false;
        while (head) {
          if (Math.max(0, outboundBufferedUntilMs - playbackNowMs()) >= outboundPlaybackBufferTargetMs) break;
          const playbackFrame = playbackFrameQueue.shiftWhere((frame) => frame.item === head);
          if (!playbackFrame) break;
          drained = true;
          await consumeQueuedPlaybackFrame(playbackFrame);
        }
        if (drained) continue;
        const silenceWritten = await input.writeOutboundSilenceFrame(playbackTextAdvanceDelayMs);
        if (silenceWritten) {
          const silenceStartAt = Math.max(outboundBufferedUntilMs, nowMs);
          outboundBufferedUntilMs = silenceStartAt + playbackTextAdvanceDelayMs;
          input.deps.emitStatus?.({
            state: "tts.queue.silence",
            detail: `sent=${input.playbackQueue.reduce((sum, item) => sum + item.framesWritten, 0)} queued=${playbackFrameQueue.length}`
          });
        }
        if (head && !underrunActive) {
          underrunActive = true;
          input.deps.emitStatus?.({
            state: "tts.queue.underrun",
            detail: `sent=${head.framesWritten} queued=${playbackFrameQueue.length}`
          });
        }
      }
    })().catch((error) => {
      input.deps.emitStatus?.({ state: "tts.playback.consumer_failed", detail: error instanceof Error ? error.message : String(error) });
    });
  };

  function advanceConsumer(item: PlaybackItem, durationMs: number): void {
    if (durationMs <= 0) return;
    if (consumer.outputId !== item.outputId || consumer.chunkId !== item.chunkId) return;
    consumer.playedMs = Math.max(0, Math.min(consumer.totalMs, consumer.playedMs + durationMs));
  }

  return {
    consumer,
    currentPlayingItem: () => currentPlayingItem,
    setCurrentPlayingItem(item) {
      currentPlayingItem = item;
    },
    startTextCacheStatus() {
      if (playbackTextCacheStatusTimer) return;
      playbackTextCacheStatusTimer = setInterval(() => {
        if (input.isClosed()) return;
        const value = playbackTextBeforeBreakpoint();
        if (!value) return;
        const detail = JSON.stringify(value);
        if (detail === lastPublishedPlaybackTextCache) return;
        lastPublishedPlaybackTextCache = detail;
        input.deps.emitStatus?.({ state: "voice_call.playback_text_cache", detail });
      }, 100);
      (playbackTextCacheStatusTimer as { unref?: () => void }).unref?.();
    },
    stopTextCacheStatus() {
      if (!playbackTextCacheStatusTimer) return;
      clearInterval(playbackTextCacheStatusTimer);
      playbackTextCacheStatusTimer = undefined;
    },
    processTimeline,
    updateTextCache(item, text, durationMs) {
      updateTextCache(item, text, durationMs);
    },
    updateConsumer,
    advanceConsumer,
    recordAudioTextSpan(item, text, audio, format) {
      const value = normalizePlaybackTextCache(text);
      if (!value || audio.byteLength <= 0) return;
      const startMs = item.ttsAudioTextSpans?.at(-1)?.endMs ?? 0;
      const sampleRateHz = format?.sampleRateHz ?? input.deps.config.outboundAudio.sampleRateHz;
      const channels = format?.channels ?? input.deps.config.outboundAudio.channels;
      const bytesPerMs = (sampleRateHz * channels * 2) / 1000;
      const durationMs = Math.max(0, audio.byteLength / bytesPerMs);
      if (durationMs <= 0) return;
      const endMs = startMs + durationMs;
      item.ttsAudioTextSpans ??= [];
      item.ttsAudioTextSpans.push({ text: value, audio, startMs, endMs, sampleRateHz, channels });
      item.totalMs = Math.max(item.totalMs ?? 0, endMs);
      this.updateTextCache(item, value, durationMs);
    },
    emitPlayingText,
    reportMissingPlayingText,
    enqueueFrame(item, frame, encodedMs) {
      enqueueFrame(item, frame, encodedMs);
    },
    start,
    cleanupFinishedItems,
    clearPendingPlayback() {
      playbackFrameQueue.removeWhere(() => true);
      playbackTimelineEvents.length = 0;
    },
    removeFramesFor(item) {
      playbackFrameQueue.removeWhere((frame) => frame.item === item);
    },
    async waitForTurn(item, gateOpen) {
      while (
        !input.isClosed()
        && input.playbackQueue.includes(item)
        && (!gateOpen() || input.playbackQueue[0] !== item || (currentPlayingItem && currentPlayingItem !== item))
      ) {
        await sleep(5);
      }
      if (input.isClosed() || !input.playbackQueue.includes(item) || input.playbackQueue[0] !== item || !gateOpen()) return false;
      currentPlayingItem = item;
      item.status = "playing";
      item.playedMs = 0;
      return true;
    }
  };
}
