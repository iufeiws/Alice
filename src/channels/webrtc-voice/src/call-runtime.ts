import * as fs from "node:fs";
import * as path from "node:path";
import type { AsrInboundStreamAcceptResult, AsrInboundStreamSession } from "../../asr/src/index.js";
import { createCurrentTimeProvider } from "../../../platform/time/src/index.js";
import type {
  CreateWebRtcVoiceCallInput,
  ServerOutboundAudioTrack,
  ServerWebRtcPeer,
  TtsTask,
  WebRtcVoiceCall,
  WebRtcVoiceDeps,
  WebRtcVoiceTtsArchiveInput
} from "./types.js";
import { WebRtcVoiceError } from "./errors.js";
import { createRemoteVoicePlaybackConsumer } from "./remote-playback-consumer.js";
import { createTtsProducer } from "./tts-producer.js";
import { createInterruptController } from "./interrupt-controller.js";
import {
  normalizeTypedInputText,
  sleep,
} from "./utils.js";

const frontendPlaybackIdleAckDelayMs = 250;
const frontendPlaybackIdleAckTimeoutMs = 2_500;
const voiceCallFillerDelayMs = 1_500;
const voiceCallFillerDir = path.resolve(process.cwd(), "assets", "voice-call");

type TalkRuntimeOutputChunk = {
  sessionId: string;
  outputId: string;
  chunkId?: string;
  text: string;
  status?: string;
  startCharIndex: number;
  endCharIndex: number;
};

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
  if (!outboundTrack.enqueueAudioFile) {
    throw new WebRtcVoiceError("outbound_track_failed", "server WebRTC outbound audio track must support enqueueAudioFile");
  }
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
  const playback = createRemoteVoicePlaybackConsumer({
    deps,
    outboundTrack,
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
    await delay(voiceCallFillerDelayMs, deps);
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
    interruptPlayback: (interrupt) => outboundTrack.interrupt?.({
      reason: interrupt.reason,
      targetOutputId: interrupt.targetOutputId
    }),
    enqueuePostStableInputFiller: enqueueRandomFiller
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
  let activeOutputStream: {
    outputId: string;
    text: AsyncTextQueue;
    playback: Promise<unknown>;
  } | undefined;
  const pendingOutputChunks: TalkRuntimeOutputChunk[] = [];
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
  const runOutputPump = async () => {
    while (!closed) {
      const raw = pendingOutputChunks.shift()
        ?? deps.talkRuntime?.claimBufferedOutputText?.(talkSessionId)
        ?? deps.talkRuntime?.claimReadyOutputChunk?.(talkSessionId);
      const chunk = normalizeTalkChunk(raw);
      if (!chunk) {
        await sleep(25);
        continue;
      }
      const hasSpeakableText = chunk.text.trim().length > 0;
      if (activeOutputStream && activeOutputStream.outputId !== chunk.outputId) {
        pendingOutputChunks.unshift(chunk);
        await sleep(25);
        continue;
      }
      if (!hasSpeakableText) {
        if (activeOutputStream && chunk.status === "finished") activeOutputStream.text.finish();
        deps.emitStatus?.({ state: "voice_call.output_empty_skipped", detail: chunk.outputId });
        continue;
      }
      if (!activeOutputStream) {
        const text = new AsyncTextQueue();
        const playback = call.playReplyText(text, chunk.outputId, {
          chunkId: chunk.chunkId,
          originalText: chunk.text,
          beforeFirstPlayback: async () => {
            if (!firstOutboundPlaybackBufferPending) return;
            firstOutboundPlaybackBufferPending = false;
            await deps.sleep?.(deps.config.outboundAudio.frameMs);
          }
        });
        const stream = { outputId: chunk.outputId, text, playback };
        activeOutputStream = stream;
        void playback.then(async (result) => {
          const playbackResult = result as Awaited<ReturnType<WebRtcVoiceCall["playReplyText"]>>;
          if (playbackResult?.failureReason) {
            deps.emitStatus?.({ state: "voice_call.tts_fatal", detail: `${playbackResult.outputId ?? chunk.outputId ?? ""} ${playbackResult.failureReason}`.trim() });
            await call.close("tts_failed");
            return;
          }
          if (playbackResult?.status !== "played") return;
          try {
            const idle = await waitForForegroundPlaybackIdle();
            const frontendAcked = idle && await waitForFrontendPlaybackIdleAck(playbackResult.outputId ?? chunk.outputId, chunk.chunkId);
            if (frontendAcked) await deps.talkRuntime?.markForegroundPlaybackIdle?.({ sessionId: talkSessionId });
            if (chunk.chunkId) {
              await deps.talkRuntime?.markOutputChunkPlayed?.({ sessionId: talkSessionId, chunkId: chunk.chunkId });
              deps.emitStatus?.({ state: "talk_runtime.chunk_played", detail: `${chunk.outputId} chunk=${chunk.chunkId}` });
            }
          } catch (error) {
            deps.emitStatus?.({ state: "talk_runtime.playback_finished_failed", detail: `${chunk.outputId}${chunk.chunkId ? ` chunk=${chunk.chunkId}` : ""}: ${error instanceof Error ? error.message : String(error)}` });
          }
        }).catch((error) => {
          deps.emitStatus?.({ state: "voice_call.output_pump.playback_failed", detail: error instanceof Error ? error.message : String(error) });
          void call.close("tts_failed");
        }).finally(() => {
          stream.text.abort();
          if (activeOutputStream === stream) activeOutputStream = undefined;
        });
      }
      activeOutputStream.text.push(chunk.text);
      if (chunk.status === "finished" || chunk.chunkId) activeOutputStream.text.finish();
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
      return ttsProducer.playReplyText(text, outputId, options);
    },
    ackPlaybackIdle(ackId) {
      resolveFrontendPlaybackIdleAck(ackId, true);
    },
    async interrupt(reason = "manual", targetOutputId) {
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

function normalizeTalkChunk(value: unknown): {
  sessionId: string;
  outputId: string;
  chunkId?: string;
  text: string;
  status?: string;
  startCharIndex: number;
  endCharIndex: number;
} | undefined {
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
    text: "voice call filler"
  };
}

async function delay(ms: number, deps: WebRtcVoiceDeps): Promise<void> {
  if (deps.sleep) return deps.sleep(ms);
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
