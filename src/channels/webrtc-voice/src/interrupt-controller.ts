import type { InterruptItem, TtsTask, WebRtcVoiceDeps } from "./types.js";
import type { VoicePlaybackConsumer } from "./playback-consumer.js";

const interruptStableInputTimeoutMs = 30_000;

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
  activeTtsTasks: Set<TtsTask>;
  nowStamp(): { occurredAt: string; occurredAtUtc: string };
  getAsrStreamId(): string;
  nextStableSequence(): number;
  bumpInterruptEpoch(): number;
  getInterruptEpoch(): number;
  bumpPlaybackGeneration(): number;
  interruptPlayback?(input: { reason: InterruptItem["reason"]; targetOutputId?: string }): Promise<void> | void;
  enqueuePostStableInputFiller?(items: ReadonlyArray<InterruptItem>): Promise<void> | void;
  stableSettleWindowMs?: number;
}) {
  const batch: { items: InterruptItem[] } = { items: [] };
  let stableCommitVersion = 0;
  const playbackGateOpen = () => batch.items.length === 0;

  const commitStableInputsIfReady = async (options?: { immediate?: boolean }) => {
    if (batch.items.length === 0) return;
    if (!batch.items.every((item) => item.stableInputReady)) return;
    const version = ++stableCommitVersion;
    if (!options?.immediate && (ctx.stableSettleWindowMs ?? 0) > 0) {
      void (async () => {
        await sleep(ctx.stableSettleWindowMs ?? 0, ctx.deps);
        if (version !== stableCommitVersion) return;
        await flushStableInputs();
      })();
      return;
    }
    await flushStableInputs();
  };

  const flushStableInputs = async () => {
    if (batch.items.length === 0) return;
    if (!batch.items.every((item) => item.stableInputReady)) return;
    const batchId = `stable:${ctx.callId}:${ctx.getInterruptEpoch()}:${Date.now()}`;
    const items = [...batch.items].sort((a, b) => a.sequence - b.sequence);
    const itemSet = new Set(items);
    batch.items = batch.items.filter((item) => !itemSet.has(item));
    try {
      await Promise.all(items.map((item) => item.runtimeInterruptPromise).filter((promise): promise is Promise<void> => Boolean(promise)));
      for (const item of items) clearStableInputTimeout(item);
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
      await ctx.enqueuePostStableInputFiller?.(items);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ctx.deps.emitStatus?.({ state: "talk_runtime.stable_batch.failed", detail: `${batchId}:${detail}` });
    }
  };

  const markStableInput = async (text: string, reason: InterruptItem["reason"], streamId?: string) => {
    const target = findLatestPendingStableInput(streamId);
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
    failEarlierPendingStableInputs(target, "superseded_by_later_stable_input");
    clearStableInputTimeout(target);
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
    stableCommitVersion += 1;
    if (ctx.deps.now) ctx.playback.processTimeline();
    await (ctx.playback as unknown as { refresh?: () => Promise<void> }).refresh?.();
    const interruptEpoch = ctx.bumpInterruptEpoch();
    ctx.bumpPlaybackGeneration();
    abortActiveTtsTasks(`voice_call_interrupt:${reason}`);
    const targetOutputId = explicitTargetOutputId ?? ctx.playback.consumer.outputId;
    const targetChunkId = explicitTargetOutputId ? undefined : ctx.playback.consumer.chunkId;
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
    item.stableInputTimeout = scheduleStableInputTimeout(item);
    batch.items.push(item);
    ctx.playback.setCurrentPlayingItem(undefined);
    ctx.playback.clearPendingPlayback();
    const elapsedMs = ctx.playback.consumer.playedMs;
    const totalMs = ctx.playback.consumer.totalMs;
    const breakpoint = breakpointFromPlaybackConsumer();
    const beforeText = breakpoint.breakpointContext?.beforeText ?? "";
    const afterText = breakpoint.breakpointContext?.afterText ?? "";
    ctx.deps.emitStatus?.({
      state: "talk_runtime.interrupt.breakpoint",
      detail: `前文=${beforeText} 后文=${afterText}`
    });
    await ctx.interruptPlayback?.({ reason, targetOutputId });
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
      item.runtimeInterruptPromise = Promise.resolve(runtimeInterrupt).then(async (resolved) => {
        const runtimeInterruptId = interruptIdFromRuntime(resolved);
        if (runtimeInterruptId) item.interruptId = runtimeInterruptId;
        if (!runtimeInterruptId && !item.targetOutputId) {
          await ctx.deps.talkRuntime?.interruptAgentLoop?.(ctx.talkSessionId, { reason, interruptEpoch });
          ctx.deps.emitStatus?.({ state: "talk_runtime.agent_loop_interrupted", detail: reason });
        }
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
      await commitStableInputsIfReady({ immediate: true });
    }
    if (reason === "asr_failure") {
      item.stableInputText = "-杂音-";
      item.stableInputReady = true;
      await commitStableInputsIfReady({ immediate: true });
    }
  };

  return {
    batch,
    playbackGateOpen,
    commitStableInputsIfReady,
    hasPendingStableInput(reason?: InterruptItem["reason"]) {
      return batch.items.some((item) => !item.stableInputReady && (!reason || item.reason === reason));
    },
    extendPendingStableInputTimeout(input?: { reason?: InterruptItem["reason"]; streamId?: string }) {
      const item = findLatestPendingStableInput(input?.streamId, input?.reason);
      if (!item) return false;
      clearStableInputTimeout(item);
      item.stableInputTimeout = scheduleStableInputTimeout(item);
      ctx.deps.emitStatus?.({ state: "talk_runtime.stable_input_timeout_extended", detail: item.interruptId });
      return true;
    },
    markStableInput,
    runInterrupt
  };

  function findLatestPendingStableInput(streamId?: string, reason?: InterruptItem["reason"]): InterruptItem | undefined {
    for (let index = batch.items.length - 1; index >= 0; index -= 1) {
      const item = batch.items[index]!;
      if (item.stableInputReady) continue;
      if (reason && item.reason !== reason) continue;
      if (streamId && item.asrStreamId !== streamId) continue;
      return item;
    }
    return undefined;
  }

  function failEarlierPendingStableInputs(target: InterruptItem, reason: string): void {
    for (const item of batch.items) {
      if (item === target) return;
      if (item.stableInputReady) continue;
      failStableInput(item, reason);
    }
  }

  function failStableInput(item: InterruptItem, reason: string): void {
    clearStableInputTimeout(item);
    item.reason = "asr_failure";
    item.stableInputText = "-杂音-";
    item.stableInputReady = true;
    ctx.deps.emitStatus?.({ state: "talk_runtime.stable_input_failed", detail: `${reason}:${item.interruptId}` });
  }

  function scheduleStableInputTimeout(item: InterruptItem): NodeJS.Timeout {
    const timer = setTimeout(() => {
      if (!batch.items.includes(item) || item.stableInputReady) return;
      failStableInput(item, "timeout");
      void commitStableInputsIfReady({ immediate: true });
    }, interruptStableInputTimeoutMs);
    timer.unref?.();
    return timer;
  }
}

async function sleep(ms: number, deps: WebRtcVoiceDeps): Promise<void> {
  if (deps.sleep) return deps.sleep(ms);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function clearStableInputTimeout(item: InterruptItem): void {
  if (!item.stableInputTimeout) return;
  clearTimeout(item.stableInputTimeout);
  item.stableInputTimeout = undefined;
}

function interruptIdFromRuntime(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const interruptId = (value as { interruptId?: unknown }).interruptId;
  return typeof interruptId === "string" && interruptId ? interruptId : undefined;
}
