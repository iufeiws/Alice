import * as fs from "node:fs";
import * as path from "node:path";
import type { AsrInboundStreamAcceptResult, AsrInboundStreamSession } from "../../asr/src/index.js";
import { createCurrentTimeProvider } from "../../../platform/time/src/index.js";
import type {
  CreateWebRtcVoiceCallInput,
  ServerOutboundAudioTrack,
  ServerWebRtcPeer,
  TtsTask,
  PlaybackResult,
  PlaybackItem,
  WebRtcVoiceCall,
  WebRtcVoiceDeps,
  WebRtcVoiceTtsArchiveInput
} from "./types.js";
import { WebRtcVoiceError } from "./errors.js";
import { createRemoteVoicePlaybackConsumer } from "./remote-playback-consumer.js";
import { createVoicePlaybackConsumer } from "./playback-consumer.js";
import { createTtsProducer, type TtsReadyChunk } from "./tts-producer.js";
import { createInterruptController } from "./interrupt-controller.js";
import {
  normalizeTypedInputText,
  hashText,
  sleep,
} from "./utils.js";

const frontendPlaybackIdleAckDelayMs = 250;
const frontendPlaybackIdleAckTimeoutMs = 2_500;
const voiceCallStableSettleWindowMs = 3_000;
const voiceCallFillerDir = path.resolve(process.cwd(), "assets", "voice-call");

export async function createCallState(
  input: CreateWebRtcVoiceCallInput,
  answerSdp: string,
  peer: ServerWebRtcPeer,
  outboundTrack: ServerOutboundAudioTrack,
  deps: WebRtcVoiceDeps
): Promise<WebRtcVoiceCall> {
  let talkSessionId = `webrtc_voice:${input.callId}`;
  let asrStreamIndex = 0;
  let asrStreamId = `asr-${input.callId}-${asrStreamIndex}`;
  let inboundSequence = 0;
  let inboundAudioStats = createInboundAudioStats();
  let closed = false;
  let speechActive = false;
  let playbackGeneration = 0;
  let interruptEpoch = 0;
  let stableSequence = 20_000;
  const activeTtsTasks = new Set<TtsTask>();
  const activePlaybackTasks = new Set<Promise<unknown>>();
  const playbackIdleAckWaiters = new Map<string, { resolve(value: boolean): void; timer: ReturnType<typeof setTimeout> }>();
  let firstOutboundPlaybackBufferPending = true;
  const synthesisTime = deps.time ?? createCurrentTimeProvider("UTC", deps.now);
  const nowStamp = () => {
    const current = synthesisTime.now();
    return { occurredAt: current.iso, occurredAtUtc: current.date.toISOString() };
  };
  const source = {
    plugin: "webrtc_voice",
    accountId: deps.config.accountId,
    channelId: `webrtc_voice:call:${input.callId}`,
    userId: input.userId
  } as const;
  if (deps.talkRuntime?.openSession) {
    const stamp = nowStamp();
    const opened = await deps.talkRuntime.openSession({
      sessionId: talkSessionId,
      source,
      occurredAt: stamp.occurredAt,
      occurredAtUtc: stamp.occurredAtUtc,
      metadata: { language: deps.config.language, callId: input.callId }
    });
    const openedSessionId = normalizeTalkSessionOpenResult(opened);
    if (openedSessionId) talkSessionId = openedSessionId;
    deps.emitStatus?.({ state: "talk_runtime.open", detail: talkSessionId });
  } else {
    deps.emitStatus?.({ state: "talk_runtime.open.todo", detail: talkSessionId });
  }
  let asrSession = createCallAsrSession(input, talkSessionId, asrStreamId, deps);
  let outboundFrameSequence = 0;
  const playbackQueue: PlaybackItem[] = [];
  const localPlaybackItemsById = new Map<string, PlaybackItem>();
  const stampOutboundFrame = (frame: import("./types.js").ServerAudioFrame) => ({
    ...frame,
    sequence: outboundFrameSequence++
  });
  const playback = outboundTrack.enqueueAudioFile
    ? createRemoteVoicePlaybackConsumer({
      deps,
      outboundTrack,
      isClosed: () => closed
    })
    : createVoicePlaybackConsumer({
      deps,
      talkSessionId,
      playbackQueue,
      outboundTrack,
      stampOutboundFrame,
      advanceOutboundRtpClockForFrame() {},
      writeOutboundSilenceFrame: async (durationMs = deps.config.outboundAudio.frameMs) => {
        return await outboundTrack.writeFrame(stampOutboundFrame({
          sequence: 0,
          pcm: new Int16Array(),
          sampleRateHz: deps.config.outboundAudio.sampleRateHz,
          channels: deps.config.outboundAudio.channels,
          durationMs
        }));
      },
      isClosed: () => closed
    });
  const enqueueRandomFiller = async (items: ReadonlyArray<{ reason: string; interruptEpoch: number }>) => {
    if (closed || !items.some((item) => item.reason !== "call_close")) return;
    const asset = selectRandomVoiceCallFillerAsset();
    if (!asset) {
      deps.emitStatus?.({ state: "voice_call.filler_skipped", detail: "no_assets" });
      return;
    }
    const itemId = `filler:${input.callId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const createdAt = (deps.now?.() ?? new Date()).toISOString();
    const interruptEpoch = Math.max(...items.map((item) => item.interruptEpoch));
    if (closed) return;
    try {
      await outboundTrack.enqueueAudioFile!({
        itemId,
        outputId: `filler:${input.callId}:${interruptEpoch}`,
        filePath: asset.filePath,
        assetId: asset.assetId,
        originalText: "",
        speakText: asset.text,
        text: asset.text,
        createdAt,
        interruptEpoch,
        beforeFirstPlayback: true
      });
      deps.emitStatus?.({ state: "voice_call.filler_queued", detail: asset.assetId });
    } catch (error) {
      deps.emitStatus?.({ state: "voice_call.filler_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  };
  const interruptController = createInterruptController({
    callId: input.callId,
    talkSessionId,
    deps,
    source,
    playback,
    activeTtsTasks,
    nowStamp,
    getAsrStreamId: () => asrStreamId,
    nextStableSequence: () => stableSequence++,
    bumpInterruptEpoch: () => { interruptEpoch += 1; return interruptEpoch; },
    getInterruptEpoch: () => interruptEpoch,
    bumpPlaybackGeneration: () => { playbackGeneration += 1; return playbackGeneration; },
    interruptPlayback: interruptPlaybackQueue,
    enqueuePostStableInputFiller: enqueueRandomFiller,
    stableSettleWindowMs: voiceCallStableSettleWindowMs
  });
  const ttsProducer = createTtsProducer({
    callId: input.callId,
    talkSessionId,
    deps,
    outboundTrack,
    activeTtsTasks,
    synthesisTime,
    getPlaybackGeneration: () => playbackGeneration,
    getInterruptEpoch: () => interruptEpoch,
    archiveTtsOutput
  });
  const restartAsrStream = (reason: string) => {
    asrStreamIndex += 1;
    asrStreamId = `asr-${input.callId}-${asrStreamIndex}`;
    inboundSequence = 0;
    inboundAudioStats = createInboundAudioStats();
    asrSession = createCallAsrSession(input, talkSessionId, asrStreamId, deps);
    deps.emitStatus?.({ state: "asr.stream.restarted", detail: `${asrStreamId}:${reason}` });
  };
  const pendingTalkChunks: TalkChunk[] = [];
  const waitForForegroundPlaybackIdle = async () => {
    return await outboundTrack.waitForPlaybackIdle?.() === true;
  };
  const waitForFrontendPlaybackIdleAck = async (outputId?: string, chunkId?: string) => {
    if (closed) return false;
    const ackId = `${input.callId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
    const ack = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        playbackIdleAckWaiters.delete(ackId);
        deps.emitStatus?.({ state: "voice_call.playback_idle_ack.timeout", detail: ackId });
        resolve(true);
      }, frontendPlaybackIdleAckTimeoutMs);
      playbackIdleAckWaiters.set(ackId, {
        timer,
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        }
      });
    });
    deps.emitStatus?.({
      state: "voice_call.playback_idle_ack.request",
      detail: JSON.stringify({ ackId, delayMs: frontendPlaybackIdleAckDelayMs, outputId, chunkId })
    });
    return await ack;
  };
  const resolveFrontendPlaybackIdleAck = (ackId: string, value: boolean) => {
    const waiter = playbackIdleAckWaiters.get(ackId);
    if (!waiter) return;
    playbackIdleAckWaiters.delete(ackId);
    waiter.resolve(value);
  };
  const handlePlaybackSettled = async (chunk: TtsReadyChunk, result: PlaybackResult) => {
    if (result.failureReason) {
      deps.emitStatus?.({ state: "voice_call.tts_fatal", detail: `${result.outputId ?? chunk.outputId ?? ""} ${result.failureReason}`.trim() });
      await call.close("tts_failed");
      return;
    }
    if (result.status !== "played") return;
    try {
      const idle = await waitForForegroundPlaybackIdle();
      const frontendAcked = idle && await waitForFrontendPlaybackIdleAck(result.outputId ?? chunk.outputId, chunk.chunkId);
      if (frontendAcked) await deps.talkRuntime?.markForegroundPlaybackIdle?.({ sessionId: talkSessionId });
      if (chunk.chunkId) {
        await deps.talkRuntime?.markOutputChunkPlayed?.({ sessionId: talkSessionId, chunkId: chunk.chunkId });
        deps.emitStatus?.({ state: "talk_runtime.chunk_played", detail: `${chunk.outputId} chunk=${chunk.chunkId}` });
      }
    } catch (error) {
      deps.emitStatus?.({ state: "talk_runtime.playback_finished_failed", detail: `${chunk.outputId}${chunk.chunkId ? ` chunk=${chunk.chunkId}` : ""}: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  const enqueueTtsReadyChunk = (chunk: TtsReadyChunk): Promise<PlaybackResult> => {
    const task = (async (): Promise<PlaybackResult> => {
      if (chunk.failureReason) {
        return { status: "interrupted", outputId: chunk.outputId, frameCount: 0, failureReason: chunk.failureReason };
      }
      if (!chunk.filePath && !chunk.audio) {
        return { status: "interrupted", outputId: chunk.outputId, frameCount: 0, failureReason: "no_frames_sent" };
      }
      if (chunk.audio) {
        if (outboundTrack.enqueueAudioFile) {
          return { status: "interrupted", outputId: chunk.outputId, frameCount: 0, failureReason: "tts_failed" };
        }
        const itemId = `playback:${input.callId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
        enqueueLocalStreamingAudioChunk(itemId, chunk);
        const settled = await waitForLocalPlaybackItem(itemId);
        const played = settled.status === "played";
        if (played) deps.emitStatus?.({ state: "tts.played", detail: chunk.outputId });
        else deps.emitStatus?.({ state: settled.status === "failed" ? "tts.failed" : "tts.interrupted", detail: chunk.outputId });
        return {
          status: played ? "played" : "interrupted",
          outputId: chunk.outputId,
          frameCount: settled.framesWritten
        };
      }
      const itemId = `playback:${input.callId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      const remoteBeforeFirstPlayback = outboundTrack.enqueueAudioFile ? firstOutboundPlaybackBufferPending : false;
      if (remoteBeforeFirstPlayback) {
        firstOutboundPlaybackBufferPending = false;
        await deps.sleep?.(deps.config.outboundAudio.frameMs);
      }
      if (chunk.interruptEpoch !== undefined && chunk.interruptEpoch !== interruptEpoch) {
        return { status: "interrupted", outputId: chunk.outputId, frameCount: 0 };
      }
      const enqueued = outboundTrack.enqueueAudioFile
        ? await outboundTrack.enqueueAudioFile({
          itemId,
          outputId: chunk.outputId,
          chunkId: chunk.chunkId,
          originalText: chunk.originalText,
          speakText: chunk.speakText,
          text: chunk.text,
          createdAt: chunk.createdAt,
          assetId: chunk.assetId,
          filePath: chunk.filePath!,
          interruptEpoch: chunk.interruptEpoch,
          beforeFirstPlayback: remoteBeforeFirstPlayback
        })
        : enqueueLocalPlaybackItem({
          itemId,
          outputId: chunk.outputId,
          chunkId: chunk.chunkId,
          originalText: chunk.originalText,
          speakText: chunk.speakText,
          text: chunk.text,
          createdAt: chunk.createdAt,
          assetId: chunk.assetId,
          filePath: chunk.filePath!,
          interruptEpoch: chunk.interruptEpoch,
          beforeFirstPlayback: true
        });
      const settled = outboundTrack.waitForPlaybackItem
        ? await Promise.resolve(outboundTrack.waitForPlaybackItem(enqueued.itemId))
        : await waitForLocalPlaybackItem(enqueued.itemId);
      const status = settled?.status ?? "played";
      const frameCount = settled?.framesWritten ?? 0;
      const played = status === "played";
      if (played) deps.emitStatus?.({ state: "tts.played", detail: chunk.outputId });
      else deps.emitStatus?.({ state: status === "failed" ? "tts.failed" : "tts.interrupted", detail: chunk.outputId });
      return {
        status: played ? "played" : "interrupted",
        outputId: chunk.outputId,
        frameCount
      };
    })();
    activePlaybackTasks.add(task);
    task.then((result) => handlePlaybackSettled(chunk, result)).catch((error) => {
      deps.emitStatus?.({ state: "voice_call.output_pump.playback_failed", detail: error instanceof Error ? error.message : String(error) });
      void call.close("tts_failed");
    }).finally(() => activePlaybackTasks.delete(task));
    return task;
  };
  const enqueueLocalPlaybackItem = (item: {
    itemId: string;
    outputId?: string;
    chunkId?: string;
    originalText?: string;
    speakText?: string;
    text: string;
    createdAt: string;
    assetId: string;
    filePath: string;
    interruptEpoch?: number;
    beforeFirstPlayback?: boolean;
  }): { itemId: string } => {
    const playbackItem: PlaybackItem = {
      outputId: item.outputId,
      chunkId: item.chunkId,
      originalText: item.originalText,
      speakText: item.speakText,
      textHash: hashText(item.speakText ?? item.text),
      assetId: item.assetId,
      filePath: item.filePath,
      status: "queued",
      createdAt: item.createdAt,
      framesWritten: 0,
      playedMs: 0,
      totalMs: 0,
      interruptEpoch: item.interruptEpoch,
      ttsAudioTextSpans: [{ text: item.text, audio: new Uint8Array(), startMs: 0, endMs: 1 }],
      queuedFrames: 0,
      producerDone: false,
      pendingPlaybackEvents: 0
    };
    if (item.beforeFirstPlayback) playbackItem.beforeFirstPlayback = createBeforeFirstPlaybackDelay();
    localPlaybackItemsById.set(item.itemId, playbackItem);
    playbackQueue.push(playbackItem);
    playback.start();
    deps.emitStatus?.({ state: "tts.queue.ready", detail: `${item.outputId ?? ""}${item.chunkId ? ` chunk=${item.chunkId}` : ""}`.trim() });
    return { itemId: item.itemId };
  };
  const enqueueLocalStreamingAudioChunk = (itemId: string, chunk: TtsReadyChunk): { itemId: string } => {
    if (!chunk.audio) throw new Error("streaming audio chunk is required");
    const playbackItem: PlaybackItem = {
      outputId: chunk.outputId,
      chunkId: chunk.chunkId,
      originalText: chunk.originalText,
      speakText: chunk.speakText,
      textHash: hashText(chunk.speakText || chunk.text),
      assetId: chunk.assetId,
      filePath: "",
      status: "queued",
      createdAt: chunk.createdAt,
      framesWritten: 0,
      playedMs: 0,
      totalMs: 0,
      interruptEpoch: chunk.interruptEpoch,
      streamingTts: true,
      ttsAudioTextSpans: [],
      queuedFrames: 0,
      producerDone: false,
      pendingPlaybackEvents: 0
    };
    playbackItem.beforeFirstPlayback = createBeforeFirstPlaybackDelay();
    localPlaybackItemsById.set(itemId, playbackItem);
    playbackQueue.push(playbackItem);
    deps.emitStatus?.({ state: "tts.queue.waiting", detail: chunk.outputId });
    void (async () => {
      try {
        const audioChunks = chunk.audio!.chunks;
        for (const audio of audioChunks) playback.recordAudioTextSpan(playbackItem, chunk.text, audio, chunk.audio);
        let encodedMs = 0;
        const frames = deps.encodePcmL16StreamToFrames
          ? deps.encodePcmL16StreamToFrames({
            chunks: iterateUint8Chunks(audioChunks),
            inputSampleRateHz: chunk.audio!.sampleRateHz,
            inputChannels: chunk.audio!.channels,
            sampleRateHz: deps.config.outboundAudio.sampleRateHz,
            channels: deps.config.outboundAudio.channels,
            frameMs: deps.config.outboundAudio.frameMs
          })
          : iterateServerAudioFrames(await Promise.resolve(deps.encodePcmL16ToFrames?.({
            pcm: concatUint8Arrays(audioChunks),
            inputSampleRateHz: chunk.audio!.sampleRateHz,
            inputChannels: chunk.audio!.channels,
            sampleRateHz: deps.config.outboundAudio.sampleRateHz,
            channels: deps.config.outboundAudio.channels,
            frameMs: deps.config.outboundAudio.frameMs
          }) ?? Promise.reject(new Error("streaming TTS encoder is not available"))));
        for await (const frame of frames) {
          playback.enqueueFrame(playbackItem, frame, encodedMs);
          encodedMs += frame.durationMs;
          playback.start();
        }
        playbackItem.totalMs = Math.max(playbackItem.totalMs ?? 0, encodedMs);
        playbackItem.producerDone = true;
        deps.emitStatus?.({ state: "tts.queue.producer_done", detail: `${chunk.outputId ?? ""}${chunk.chunkId ? ` chunk=${chunk.chunkId}` : ""} encoded=${playbackItem.queuedFrames ?? 0} queued=${playbackItem.queuedFrames ?? 0}`.trim() });
        if (encodedMs <= 0) playbackItem.status = "failed";
        playback.start();
      } catch (error) {
        playbackItem.status = "failed";
        playbackItem.producerDone = true;
        deps.emitStatus?.({ state: "tts.decode.failed", detail: error instanceof Error ? error.message : String(error) });
        playback.start();
      }
    })();
    deps.emitStatus?.({ state: "tts.queue.ready", detail: `${chunk.outputId ?? ""}${chunk.chunkId ? ` chunk=${chunk.chunkId}` : ""}`.trim() });
    return { itemId };
  };
  const waitForLocalPlaybackItem = async (itemId: string) => {
    const item = localPlaybackItemsById.get(itemId);
    if (!item) throw new Error(`unknown playback item: ${itemId}`);
    while (!closed && playbackQueue.includes(item) && item.status !== "failed" && item.status !== "interrupted" && item.status !== "cancelled") {
      playback.processTimeline();
      playback.cleanupFinishedItems();
      await sleep(5);
    }
    playback.processTimeline();
    playback.cleanupFinishedItems();
    return {
      itemId,
      status: item.status === "played" ? "played" as const : item.status === "failed" ? "failed" as const : item.status === "cancelled" ? "cancelled" as const : "interrupted" as const,
      framesWritten: item.framesWritten,
      playedMs: item.playedMs,
      totalMs: item.totalMs
    };
  };
  function interruptPlaybackQueue(interrupt: { reason: "manual" | "barge_in" | "network" | "unknown" | "asr_failure" | "call_close"; targetOutputId?: string }): Promise<void> | void {
    if (outboundTrack.interrupt) {
      return outboundTrack.interrupt({
        reason: interrupt.reason,
        targetOutputId: interrupt.targetOutputId
      });
    }
    const targetOutputId = interrupt.targetOutputId ?? playback.consumer.outputId;
    for (const item of playbackQueue) {
      item.status = !targetOutputId || item.outputId === targetOutputId ? "interrupted" : "cancelled";
    }
    playback.setCurrentPlayingItem(undefined);
    playback.clearPendingPlayback();
    playbackQueue.length = 0;
    playback.consumer.status = "interrupted";
    deps.emitStatus?.({ state: "tts.interrupted", detail: `${interrupt.reason}:${targetOutputId ?? ""}` });
  }
  function createBeforeFirstPlaybackDelay(): (() => Promise<void>) | undefined {
    if (!firstOutboundPlaybackBufferPending) return undefined;
    firstOutboundPlaybackBufferPending = false;
    return async () => {
      await deps.sleep?.(deps.config.outboundAudio.frameMs);
    };
  }
  const drainTtsReadyChunks = (): Array<Promise<PlaybackResult>> => {
    const tasks: Array<Promise<PlaybackResult>> = [];
    while (true) {
      const ready = ttsProducer.takeReadyChunk();
      if (!ready) return tasks;
      tasks.push(enqueueTtsReadyChunk(ready));
    }
  };
  const feedTalkChunkToTts = (chunk: TalkChunk): boolean => {
    const current = ttsProducer.currentOutput();
    if (current && current.outputId !== chunk.outputId) {
      ttsProducer.finishOutput({ outputId: current.outputId });
      return false;
    }
    const hasSpeakableText = chunk.text.trim().length > 0;
    if (!hasSpeakableText) {
      if (current && chunk.status === "finished") ttsProducer.finishOutput({ outputId: chunk.outputId });
      deps.emitStatus?.({ state: "voice_call.output_empty_skipped", detail: chunk.outputId });
      return true;
    }
    if (!current) {
      ttsProducer.openOutput({
        outputId: chunk.outputId,
        chunkId: chunk.chunkId,
        originalText: ""
      });
    }
    ttsProducer.pushText({ outputId: chunk.outputId, text: chunk.text });
    if (chunk.status === "finished" || chunk.chunkId) ttsProducer.finishOutput({ outputId: chunk.outputId });
    return true;
  };
  const runOutputPump = async () => {
    while (!closed) {
      drainTtsReadyChunks();
      let chunk = pendingTalkChunks.shift();
      if (!chunk) {
        const raw = deps.talkRuntime?.claimBufferedOutputText?.(talkSessionId)
          ?? deps.talkRuntime?.claimReadyOutputChunk?.(talkSessionId);
        chunk = normalizeTalkChunk(raw);
      }
      if (!chunk) {
        await sleep(25);
        continue;
      }
      if (!feedTalkChunkToTts(chunk)) {
        pendingTalkChunks.unshift(chunk);
        await sleep(5);
      }
    }
  };


  const call: WebRtcVoiceCall = {
    callId: input.callId,
    userId: input.userId,
    answerSdp,
    talkSessionId,
    get asrStreamId() {
      return asrStreamId;
    },
    talkRuntimeIngressStatus: deps.talkRuntime ? "connected" : "todo",
    async acceptIceCandidate(candidate) {
      await peer.addIceCandidate?.(candidate);
    },
    async acceptInboundAudioChunk(bytes, timing) {
      if (closed) return undefined;
      const sequence = inboundSequence;
      inboundSequence += 1;
      recordInboundAudioStats(inboundAudioStats, bytes, timing);
      const result = await acceptAsrFrame(asrSession, {
        type: "chunk",
        streamId: asrStreamId,
        sequence,
        bytes,
        timing,
        metadata: {
          callId: input.callId,
          talkSessionId
        }
      }, deps);
      handleAsrResult(result, deps);
      if (!result.ok && isRecoverableAsrError(result.error)) {
        await interruptController.runInterrupt("asr_failure");
        restartAsrStream(result.error);
      }
      return result;
    },
    async acceptTextInput(text) {
      if (closed) return;
      const stableText = normalizeTypedInputText(text) || "-已撤回-";
      if (stableText === "-已撤回-" && interruptController.batch.items.length === 0) return;
      await (playback as unknown as { refresh?: () => Promise<void> }).refresh?.();
      if (stableText !== "-已撤回-" && (playback.consumer.status === "playing" || playback.consumer.status === "queued")) {
        await interruptController.runInterrupt("manual");
      }
      await interruptController.markStableInput(stableText, "manual");
    },
    async endInboundAudio() {
      if (closed) return undefined;
      const result = await acceptAsrFinalFrame(asrSession, {
        type: "end",
        streamId: asrStreamId,
        metadata: {
          callId: input.callId,
          talkSessionId
        }
      }, deps);
      handleAsrResult(result, deps);
      deps.emitStatus?.({
        state: "asr.stream.final",
        detail: `${asrStreamId} ${summarizeInboundAudioStats(inboundAudioStats)} result=${summarizeAsrFinalResult(result)}`
      });
      if (result.ok && result.type === "final" && deps.talkRuntime && interruptController.batch.items.length === 0) {
        const stamp = nowStamp();
        await deps.talkRuntime.ingestInput?.({
          kind: "audio.transcript.final",
          sessionId: talkSessionId,
          source,
          sequence: stableSequence++,
          occurredAt: stamp.occurredAt,
          occurredAtUtc: stamp.occurredAtUtc,
          payload: { kind: "transcript", text: result.result.text },
          raw: { asrStreamId: result.streamId, provider: result.result.provider }
        });
        deps.emitStatus?.({ state: "talk_runtime.ingress", detail: `audio.transcript.final: ${result.result.text}` });
      } else if (result.ok && result.type === "final" && interruptController.batch.items.length > 0) {
        await interruptController.markStableInput(result.result.text, "barge_in", result.streamId);
      } else if (!result.ok) {
        if (interruptController.batch.items.length > 0) await interruptController.markStableInput("-杂音-", "asr_failure", result.streamId);
        else await interruptController.runInterrupt("asr_failure");
      }
      if (!result.ok && !isRecoverableAsrError(result.error)) return result;
      return result;
    },
    async setSpeechActive(active) {
      if (closed || speechActive === active) return;
      speechActive = active;
      deps.emitStatus?.({ state: active ? "push_to_talk.active" : "push_to_talk.released", detail: active ? "pressed" : "released" });
      if (active && deps.config.bargeIn.enabled) {
        deps.emitStatus?.({ state: "tts.barge_in", detail: playback.consumer.outputId ?? "" });
        await this.interrupt("barge_in");
      }
      if (!active) {
        const result = await this.endInboundAudio();
        if (result) {
          restartAsrStream(result.ok ? "push_to_talk_released" : result.error);
        }
      }
    },
    async playReplyText(text, outputId, options) {
      const targetOutputId = outputId ?? `manual:${input.callId}:${Date.now()}`;
      if (ttsProducer.currentOutput()) throw new Error("playReplyText is already active");
      const chunkId = playbackOptionString(options, "chunkId");
      const originalText = playbackOptionString(options, "originalText") ?? (typeof text === "string" ? text : "");
      const settlements: Array<Promise<PlaybackResult>> = [];
      const generation = playbackGeneration;
      ttsProducer.openOutput({ outputId: targetOutputId, chunkId, originalText: "" });
      if (typeof text === "string") {
        ttsProducer.pushText({ outputId: targetOutputId, text });
      } else {
        for await (const delta of text) {
          ttsProducer.pushText({ outputId: targetOutputId, text: delta });
          settlements.push(...drainTtsReadyChunks());
        }
      }
      ttsProducer.finishOutput({ outputId: targetOutputId });
      while (ttsProducer.currentOutput()) {
        settlements.push(...drainTtsReadyChunks());
        await sleep(5);
      }
      settlements.push(...drainTtsReadyChunks());
      if (settlements.length === 0 && generation !== playbackGeneration) {
        return { status: "interrupted", outputId: targetOutputId, frameCount: 0 };
      }
      const results = await Promise.all(settlements);
      const failed = results.find((result) => result.failureReason);
      if (failed) return failed;
      const interrupted = results.find((result) => result.status !== "played");
      return {
        status: interrupted ? "interrupted" : "played",
        outputId: targetOutputId,
        frameCount: results.reduce((sum, result) => sum + result.frameCount, 0)
      };
    },
    ackPlaybackIdle(ackId) {
      resolveFrontendPlaybackIdleAck(ackId, true);
    },
    async interrupt(reason = "manual", targetOutputId) {
      ttsProducer.abort(`voice_call_interrupt:${reason}`);
      await interruptController.runInterrupt(reason === "network" || reason === "unknown" ? "manual" : reason, targetOutputId);
    },
    async close(reason = "closed") {
      if (closed) return;
      closed = true;
      for (const [ackId, waiter] of playbackIdleAckWaiters) {
        playbackIdleAckWaiters.delete(ackId);
        waiter.resolve(false);
      }
      deps.emitStatus?.({ state: "voice_call.hangup", detail: reason });
      ttsProducer.abort(`voice_call_close:${reason}`);
      playback.stopTextCacheStatus();
      await interruptController.runInterrupt("call_close");
      await interruptController.commitStableInputsIfReady();
      await asrSession.accept({
        type: "abort",
        streamId: asrStreamId,
        reason,
        metadata: {
          callId: input.callId,
          talkSessionId
        }
      });
      await outboundTrack.stop();
      await peer.close();
      if (deps.talkRuntime?.closeSession) {
        const stamp = nowStamp();
        await deps.talkRuntime.closeSession({ sessionId: talkSessionId, occurredAt: stamp.occurredAt, occurredAtUtc: stamp.occurredAtUtc });
        deps.emitStatus?.({ state: "talk_runtime.close", detail: reason });
      } else {
        deps.emitStatus?.({ state: "talk_runtime.close.todo", detail: reason });
      }
    }
  };

  void deps.talkRuntime?.startAgentLoop?.(talkSessionId);
  playback.startTextCacheStatus();
  if (deps.talkRuntime?.claimBufferedOutputText || deps.talkRuntime?.claimReadyOutputChunk) {
    deps.emitStatus?.({ state: "voice_call.waiting", detail: talkSessionId });
    const pumpTask = runOutputPump();
    activePlaybackTasks.add(pumpTask);
    pumpTask.finally(() => activePlaybackTasks.delete(pumpTask));
  }
  return call;
}

type InboundAudioStats = {
  chunks: number;
  bytes: number;
  firstStartMs?: number;
  lastEndMs?: number;
  durationMs: number;
};

type TalkChunk = {
  sessionId: string;
  outputId: string;
  chunkId?: string;
  text: string;
  status?: string;
  startCharIndex: number;
  endCharIndex: number;
};

function createInboundAudioStats(): InboundAudioStats {
  return {
    chunks: 0,
    bytes: 0,
    durationMs: 0
  };
}

function recordInboundAudioStats(
  stats: InboundAudioStats,
  bytes: Uint8Array,
  timing?: { startMs?: number; endMs?: number; durationMs?: number }
): void {
  stats.chunks += 1;
  stats.bytes += bytes.byteLength;
  if (typeof timing?.startMs === "number") stats.firstStartMs = stats.firstStartMs === undefined ? timing.startMs : Math.min(stats.firstStartMs, timing.startMs);
  if (typeof timing?.endMs === "number") stats.lastEndMs = stats.lastEndMs === undefined ? timing.endMs : Math.max(stats.lastEndMs, timing.endMs);
  if (typeof timing?.durationMs === "number" && Number.isFinite(timing.durationMs)) stats.durationMs += Math.max(0, timing.durationMs);
}

function summarizeInboundAudioStats(stats: InboundAudioStats): string {
  const timedDurationMs = stats.firstStartMs !== undefined && stats.lastEndMs !== undefined
    ? Math.max(0, stats.lastEndMs - stats.firstStartMs)
    : stats.durationMs;
  return `chunks=${stats.chunks} bytes=${stats.bytes} durationMs=${Math.round(timedDurationMs)}`;
}

function summarizeAsrFinalResult(result: AsrInboundStreamAcceptResult): string {
  if (!result.ok) return result.error;
  if (result.type === "final") return `final:${result.result.text.length}`;
  return result.type;
}

async function acceptAsrFrame(
  session: AsrInboundStreamSession,
  frame: Parameters<AsrInboundStreamSession["accept"]>[0],
  deps: WebRtcVoiceDeps
): Promise<AsrInboundStreamAcceptResult> {
  try {
    return await session.accept(frame);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.emitStatus?.({ state: "asr.exception", detail });
    return {
      ok: false,
      type: "error",
      error: "provider_request_failed",
      streamId: frame.streamId,
      message: detail
    };
  }
}

async function acceptAsrFinalFrame(
  session: AsrInboundStreamSession,
  frame: Parameters<AsrInboundStreamSession["accept"]>[0],
  deps: WebRtcVoiceDeps
): Promise<AsrInboundStreamAcceptResult> {
  const timeoutMs = deps.config.timeouts.asrFinalMs ?? 8_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      acceptAsrFrame(session, frame, deps),
      new Promise<AsrInboundStreamAcceptResult>((resolve) => {
        timer = setTimeout(() => {
          deps.emitStatus?.({ state: "asr.final.timeout", detail: `${frame.streamId}:${timeoutMs}` });
          resolve({
            ok: false,
            type: "error",
            error: "timeout",
            streamId: frame.streamId,
            message: `ASR final timed out after ${timeoutMs}ms`
          });
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function archiveTtsOutput(deps: WebRtcVoiceDeps, input: WebRtcVoiceTtsArchiveInput): Promise<void> {
  if (!deps.archiveTtsOutput) return;
  try {
    const result = await deps.archiveTtsOutput(input);
    deps.emitStatus?.({ state: "tts.archive.saved", detail: result?.filePath ?? input.outputId ?? "" });
  } catch (error) {
    deps.emitStatus?.({ state: "tts.archive.failed", detail: error instanceof Error ? error.message : String(error) });
  }
}

function isRecoverableAsrError(error: string): boolean {
  return error === "provider_request_failed"
    || error === "timeout"
    || error === "stream_closed"
    || error === "empty_transcription"
    || error === "empty_stream";
}

function waitForPeerConnected(isConnected: () => boolean, waiters: Array<() => void>, timeoutMs: number): Promise<void> {
  if (isConnected()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    waiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function summarizeAudioSdp(sdp: string): string {
  const sections = sdp.split(/\r?\nm=/);
  const audioSections = sections.filter((section) => section.startsWith("audio ") || section.startsWith("m=audio "));
  const directions = audioSections.map((section) => {
    const match = section.match(/\r?\na=(sendrecv|sendonly|recvonly|inactive)(?:\r?\n|$)/);
    return match?.[1] ?? "unknown";
  });
  return `${audioSections.length}:${directions.join(",") || "none"}`;
}

function createCallAsrSession(
  input: CreateWebRtcVoiceCallInput,
  talkSessionId: string,
  asrStreamId: string,
  deps: WebRtcVoiceDeps
): AsrInboundStreamSession {
  deps.emitStatus?.({ state: "asr.stream.started", detail: asrStreamId });
  return deps.createAsrSession({
    type: "start",
    streamId: asrStreamId,
    audio: {
      filename: `${input.callId}.pcm`,
      mimeType: deps.config.inboundAudio.encoding === "webm_opus" ? "audio/webm" : "audio/pcm",
      sampleRateHz: deps.config.inboundAudio.sampleRateHz,
      channels: deps.config.inboundAudio.channels,
      encoding: deps.config.inboundAudio.encoding
    },
    language: deps.config.language,
    provider: deps.config.asrProvider,
    metadata: {
      plugin: "webrtc_voice",
      callId: input.callId,
      talkSessionId,
      talkRuntimeIngress: "todo"
    }
  });
}

function handleAsrResult(result: AsrInboundStreamAcceptResult, deps: WebRtcVoiceDeps): void {
  if (!result.ok) {
    deps.emitStatus?.({ state: "asr.error", detail: result.error });
    return;
  }
  if (result.type === "partial") {
    deps.emitStatus?.({ state: "asr.partial", detail: result.text });
    return;
  }
  if (result.type === "final") {
    deps.emitStatus?.({ state: "talk_runtime.ingress.todo", detail: `audio.transcript.final: ${result.result.text}` });
  }
}

function normalizeTalkSessionOpenResult(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" || typeof sessionId === "number" ? String(sessionId) : undefined;
}

function normalizeTalkChunk(value: unknown): TalkChunk | undefined {
  if (!value || typeof value !== "object") return undefined;
  const chunk = value as Record<string, unknown>;
  if (typeof chunk.outputId !== "string" || typeof chunk.text !== "string") return undefined;
  const status = chunk.status === "streaming" || chunk.status === "finished" ? chunk.status : undefined;
  return {
    sessionId: typeof chunk.sessionId === "string" ? chunk.sessionId : "",
    outputId: chunk.outputId,
    chunkId: typeof chunk.chunkId === "string" ? chunk.chunkId : undefined,
    text: chunk.text,
    status,
    startCharIndex: typeof chunk.startCharIndex === "number" ? chunk.startCharIndex : 0,
    endCharIndex: typeof chunk.endCharIndex === "number" ? chunk.endCharIndex : Array.from(chunk.text).length
  };
}

function playbackOptionString(options: unknown, key: string): string | undefined {
  return options && typeof options === "object" && typeof (options as Record<string, unknown>)[key] === "string"
    ? (options as Record<string, string>)[key]
    : undefined;
}

async function* iterateUint8Chunks(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

async function* iterateServerAudioFrames(frames: import("./types.js").ServerAudioFrame[]): AsyncIterable<import("./types.js").ServerAudioFrame> {
  for (const frame of frames) yield frame;
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function selectRandomVoiceCallFillerAsset(): { assetId: string; filePath: string; text: string } | undefined {
  let files: string[];
  try {
    files = fs.readdirSync(voiceCallFillerDir)
      .filter((file) => file.toLowerCase().endsWith(".wav"))
      .sort();
  } catch {
    return undefined;
  }
  if (files.length === 0) return undefined;
  const file = files[Math.floor(Math.random() * files.length)]!;
  return {
    assetId: `voice-call/${file}`,
    filePath: path.join(voiceCallFillerDir, file),
    text: readVoiceCallFillerText(path.join(voiceCallFillerDir, `${file}.json`)) ?? "voice call filler"
  };
}

function readVoiceCallFillerText(metadataPath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (text) return text;
    const speakText = typeof parsed.speakText === "string" ? parsed.speakText.trim() : "";
    return speakText || undefined;
  } catch {
    return undefined;
  }
}
