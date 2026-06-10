import type {
  PlaybackConsumer,
  PlaybackItem,
  PlaybackConsumerSnapshot,
  ServerOutboundAudioTrack,
  WebRtcVoiceDeps
} from "./types.js";

export type RemoteVoicePlaybackConsumer = ReturnType<typeof createRemoteVoicePlaybackConsumer>;

export function createRemoteVoicePlaybackConsumer(input: {
  deps: WebRtcVoiceDeps;
  outboundTrack: ServerOutboundAudioTrack;
  isClosed(): boolean;
}) {
  const consumer: PlaybackConsumer = {
    playbackTextCache: "",
    playedMs: 0,
    totalMs: 0,
    status: "idle"
  };
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let lastPublishedPlaybackTextCache = "";

  const applySnapshot = (snapshot: PlaybackConsumerSnapshot | undefined) => {
    if (!snapshot) return;
    consumer.outputId = snapshot.outputId;
    consumer.chunkId = snapshot.chunkId;
    consumer.playbackTextCache = snapshot.playbackTextCache ?? "";
    consumer.playedMs = snapshot.playedMs ?? 0;
    consumer.totalMs = snapshot.totalMs ?? 0;
    consumer.status = snapshot.status ?? (snapshot.outputId ? "playing" : "idle");
  };

  const refresh = async () => {
    if (!input.outboundTrack.getCurrentPlayback) return;
    try {
      applySnapshot(await input.outboundTrack.getCurrentPlayback());
    } catch (error) {
      input.deps.emitStatus?.({
        state: "tts.playback.remote_status_failed",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  };

  return {
    consumer,
    currentPlayingItem: () => undefined as PlaybackItem | undefined,
    setCurrentPlayingItem(_item: PlaybackItem | undefined) {
      // Playback ownership lives in the media process.
    },
    startTextCacheStatus() {
      if (statusTimer) return;
      statusTimer = setInterval(() => {
        if (input.isClosed()) return;
        void refresh().then(() => {
          const value = consumer.playbackTextCache.trim();
          if (!value || value === lastPublishedPlaybackTextCache) return;
          lastPublishedPlaybackTextCache = value;
          input.deps.emitStatus?.({ state: "voice_call.playback_text_cache", detail: value });
        });
      }, 100);
      (statusTimer as { unref?: () => void }).unref?.();
    },
    stopTextCacheStatus() {
      if (!statusTimer) return;
      clearInterval(statusTimer);
      statusTimer = undefined;
    },
    processTimeline() {
      void refresh();
    },
    updateTextCache(_item: PlaybackItem, _text: string | undefined, _durationMs: number) {
      // Playback text is reported by the media process snapshot.
    },
    updateConsumer(_item: PlaybackItem, _text: string | undefined, _totalMs: number) {
      void refresh();
    },
    advanceConsumer(_item: PlaybackItem, _durationMs: number) {
      void refresh();
    },
    recordAudioTextSpan(_item: PlaybackItem, _text: string | undefined, _audio: Uint8Array) {
      // File-path playback does not ship audio spans back to the main process.
    },
    emitPlayingText(value: string | undefined) {
      const playingText = value?.trim();
      if (playingText) input.deps.emitStatus?.({ state: "tts.playing_text", detail: playingText });
    },
    reportMissingPlayingText(item: PlaybackItem, frameIndex: number) {
      input.deps.emitStatus?.({
        state: "tts.playing_text.missing",
        detail: `output=${item.outputId ?? ""} frame=${frameIndex} spans=${item.ttsAudioTextSpans?.length ?? 0}`
      });
    },
    enqueueFrame(_item: PlaybackItem, _frame: never, _encodedMs: number) {
      // Frames are decoded and queued by the media process.
    },
    start() {
      // The media process starts its own sender when audio is enqueued.
    },
    cleanupFinishedItems() {
      // Settled item cleanup is driven by waitForPlaybackItem.
    },
    clearPendingPlayback() {
      // The interrupt controller sends the authoritative interrupt request.
    },
    removeFramesFor(_item: PlaybackItem) {
      // The media process owns frame queues.
    },
    async waitForTurn(_item: PlaybackItem, gateOpen: () => boolean) {
      return gateOpen();
    },
    refresh
  };
}
