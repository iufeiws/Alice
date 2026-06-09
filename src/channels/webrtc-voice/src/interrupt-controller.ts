import type { InterruptItem, PlaybackItem, TtsTask, WebRtcVoiceDeps } from "./types.js";
import type { VoicePlaybackConsumer } from "./playback-consumer.js";

export function createInterruptController(ctx: {
  callId: string;
  talkSessionId: string;
  deps: WebRtcVoiceDeps;
  source: {
    plugin: "webrtc_voice";
    accountId: string;
    channelId: string;
    userId: string;
  };
  playback: VoicePlaybackConsumer;
  playbackQueue: PlaybackItem[];
  activeTtsTasks: Set<TtsTask>;
  nowStamp(): { occurredAt: string; occurredAtUtc: string };
  getAsrStreamId(): string;
  nextStableSequence(): number;
  bumpInterruptEpoch(): number;
  getInterruptEpoch(): number;
  bumpPlaybackGeneration(): number;
}) {
  const batch: { items: InterruptItem[] } = { items: [] };
  const playbackGateOpen = () => batch.items.length === 0;

  const commitStableInputsIfReady = async () => {
    if (batch.items.length === 0) return;
    if (!batch.items.every((item) => item.stableInputReady)) return;
    const batchId = `stable:${ctx.callId}:${ctx.getInterruptEpoch()}:${Date.now()}`;
    const items = [...batch.items].sort((a, b) => a.sequence - b.sequence);
    try {
      await Promise.all(items.map((item) => item.runtimeInterruptPromise).filter((promise): promise is Promise<void> => Boolean(promise)));
      if (playbackGateOpen()) throw new Error("voice call transaction assert failed: playback gate open");
      if (ctx.playbackQueue.some((item) => item.status === "queued" || item.status === "playing")) {
        throw new Error("voice call transaction assert failed: playable queue not cleared");
      }
      if (ctx.deps.talkRuntime?.commitStableInputBatch) {
        await ctx.deps.talkRuntime.commitStableInputBatch({
          sessionId: ctx.talkSessionId,
          batchId,
          interruptEpoch: ctx.getInterruptEpoch(),
          inputs: items.map((item) => {
            const stamp = ctx.nowStamp();
            return {
              interruptId: item.interruptId,
              sequence: item.sequence,
              reason: item.reason,
              asrStreamId: item.asrStreamId,
              text: item.stableInputText ?? "-杂音-",
              occurredAt: stamp.occurredAt,
              occurredAtUtc: stamp.occurredAtUtc,
              targetOutputId: item.targetOutputId,
              targetChunkId: item.targetChunkId
            };
          })
        });
        ctx.deps.emitStatus?.({ state: "talk_runtime.stable_batch", detail: `${batchId}:${items.length}` });
      } else {
        for (const item of items) {
          ctx.deps.emitStatus?.({ state: "talk_runtime.ingress.todo", detail: `audio.transcript.final: ${item.stableInputText ?? "-杂音-"}` });
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ctx.deps.emitStatus?.({ state: "talk_runtime.stable_batch.failed", detail: `${batchId}:${detail}` });
    } finally {
      batch.items.length = 0;
    }
  };

  const markStableInput = async (text: string, reason: InterruptItem["reason"], streamId?: string) => {
    const target = streamId
      ? batch.items.find((item) => item.asrStreamId === streamId && !item.stableInputReady)
      : batch.items.find((item) => !item.stableInputReady);
    if (!target) {
      const stamp = ctx.nowStamp();
      if (ctx.deps.talkRuntime?.ingestInput) {
        await ctx.deps.talkRuntime.ingestInput({
          kind: reason === "manual" ? "text.final" : "audio.transcript.final",
          sessionId: ctx.talkSessionId,
          source: ctx.source,
          sequence: ctx.nextStableSequence(),
          occurredAt: stamp.occurredAt,
          occurredAtUtc: stamp.occurredAtUtc,
          payload: { kind: reason === "manual" ? "text" : "transcript", text }
        });
        ctx.deps.emitStatus?.({ state: "talk_runtime.ingress", detail: `${reason === "manual" ? "text.final" : "audio.transcript.final"}: ${text}` });
      } else {
        ctx.deps.emitStatus?.({ state: "talk_runtime.ingress.todo", detail: `audio.transcript.final: ${text}` });
      }
      return;
    }
    target.reason = reason;
    target.stableInputText = text;
    target.stableInputReady = true;
    await commitStableInputsIfReady();
  };

  const abortActiveTtsTasks = (reason: string) => {
    for (const task of ctx.activeTtsTasks) {
      task.controller.abort(new Error(reason));
    }
  };

  const breakpointFromPlaybackConsumer = (): { breakpointContext?: { beforeText?: string; afterText?: string } } => {
    const text = ctx.playback.consumer.playbackTextCache.trim();
    if (!text || ctx.playback.consumer.totalMs <= 0) return {};
    const totalMs = ctx.playback.consumer.totalMs;
    const chars = Array.from(text);
    const playedRatio = Math.max(0, Math.min(1, ctx.playback.consumer.playedMs / totalMs));
    const localIndex = Math.max(0, Math.min(chars.length, Math.round(chars.length * playedRatio)));
    return {
      breakpointContext: {
        beforeText: chars.slice(0, localIndex).join("") || undefined,
        afterText: chars.slice(localIndex).join("") || undefined
      }
    };
  };

  const runInterrupt = async (reason: InterruptItem["reason"], explicitTargetOutputId?: string) => {
    if (ctx.deps.now) ctx.playback.processTimeline();
    const interruptEpoch = ctx.bumpInterruptEpoch();
    ctx.bumpPlaybackGeneration();
    abortActiveTtsTasks(`voice_call_interrupt:${reason}`);
    const targetOutputId = ctx.playback.consumer.outputId ?? explicitTargetOutputId;
    const targetChunkId = ctx.playback.consumer.outputId ? ctx.playback.consumer.chunkId : undefined;
    const interruptId = `interrupt:${ctx.callId}:${interruptEpoch}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const item: InterruptItem = {
      interruptId,
      reason,
      targetOutputId,
      targetChunkId,
      asrStreamId: ctx.getAsrStreamId(),
      interruptEpoch,
      runtimeInterrupted: false,
      stableInputReady: false,
      sequence: ctx.nextStableSequence()
    };
    batch.items.push(item);
    for (const queued of ctx.playbackQueue) queued.status = queued.outputId === targetOutputId ? "interrupted" : "cancelled";
    ctx.playback.setCurrentPlayingItem(undefined);
    ctx.playback.clearPendingPlayback();
    ctx.playbackQueue.length = 0;
    const elapsedMs = ctx.playback.consumer.playedMs;
    const totalMs = ctx.playback.consumer.totalMs;
    const breakpoint = breakpointFromPlaybackConsumer();
    const beforeText = breakpoint.breakpointContext?.beforeText ?? "";
    const afterText = breakpoint.breakpointContext?.afterText ?? "";
    ctx.deps.emitStatus?.({
      state: "talk_runtime.interrupt.breakpoint",
      detail: `前文=${beforeText} 后文=${afterText}`
    });
    try {
      let runtimeInterrupt: unknown;
      if (ctx.deps.talkRuntime && item.targetOutputId) {
        runtimeInterrupt = ctx.deps.talkRuntime.interruptOutput?.({
          sessionId: ctx.talkSessionId,
          outputId: item.targetOutputId,
          reason: reason === "call_close" || reason === "asr_failure" ? "network" : reason,
          elapsedMs,
          totalMs,
          breakpointContext: breakpoint.breakpointContext,
          omitAssistantMessage: !ctx.playback.consumer.playbackTextCache
        });
        ctx.deps.emitStatus?.({ state: "talk_runtime.interrupt", detail: `${reason}:${item.targetOutputId}` });
      } else if (ctx.deps.talkRuntime) {
        runtimeInterrupt = ctx.deps.talkRuntime.interruptLatestOutput?.({
          sessionId: ctx.talkSessionId,
          reason: reason === "call_close" || reason === "asr_failure" ? "network" : reason,
          breakpointContext: breakpoint.breakpointContext,
          omitAssistantMessage: reason !== "manual"
        });
        ctx.deps.emitStatus?.({ state: "talk_runtime.interrupt_latest", detail: reason });
      } else {
        ctx.deps.emitStatus?.({ state: "talk_runtime.interrupt.todo", detail: `${reason}:${item.targetOutputId ?? ""}` });
      }
      item.runtimeInterruptPromise = Promise.resolve(runtimeInterrupt).then(() => {
        item.runtimeInterrupted = true;
      });
      await item.runtimeInterruptPromise;
    } catch (error) {
      ctx.deps.emitStatus?.({ state: "talk_runtime.interrupt.failed", detail: error instanceof Error ? error.message : String(error) });
      item.runtimeInterrupted = true;
    }
    if (reason === "call_close") {
      item.stableInputText = "-已挂断-";
      item.stableInputReady = true;
      await commitStableInputsIfReady();
    }
    if (reason === "asr_failure") {
      item.stableInputText = "-杂音-";
      item.stableInputReady = true;
      await commitStableInputsIfReady();
    }
  };

  return {
    batch,
    playbackGateOpen,
    commitStableInputsIfReady,
    markStableInput,
    runInterrupt
  };
}
