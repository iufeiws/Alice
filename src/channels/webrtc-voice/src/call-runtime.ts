import type { AsrInboundStreamAcceptResult, AsrInboundStreamSession } from "../../asr/src/index.js";
import { createCurrentTimeProvider } from "../../../platform/time/src/index.js";
import type {
  CreateWebRtcVoiceCallInput,
  PlaybackItem,
  ServerAudioFrame,
  ServerOutboundAudioTrack,
  ServerWebRtcPeer,
  TtsTask,
  WebRtcVoiceCall,
  WebRtcVoiceDeps,
  WebRtcVoiceTtsArchiveInput
} from "./types.js";
import { WebRtcVoiceError } from "./errors.js";
import { createVoicePlaybackConsumer } from "./playback-consumer.js";
import { createTtsProducer } from "./tts-producer.js";
import { createInterruptController } from "./interrupt-controller.js";
import {
  normalizeTypedInputText,
  sleep,
} from "./utils.js";

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
  let outboundFrameSequence = 0;
  let closed = false;
  let speechActive = false;
  let playbackGeneration = 0;
  let interruptEpoch = 0;
  let stableSequence = 20_000;
  let outboundRtpTimestamp = 0;
  const activeTtsTasks = new Set<TtsTask>();
  const activePlaybackTasks = new Set<Promise<unknown>>();
  const playbackQueue: PlaybackItem[] = [];
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
  const outboundTimestampIncrement = (frame: ServerAudioFrame) => frame.rtpTimestampIncrement ?? Math.round(frame.sampleRateHz * frame.durationMs / 1000);
  const stampOutboundFrame = (frame: ServerAudioFrame): ServerAudioFrame => ({
    ...frame,
    sequence: outboundFrameSequence++,
    rtpTimestamp: outboundRtpTimestamp >>> 0
  });
  const advanceOutboundRtpClockForFrame = (frame: ServerAudioFrame) => {
    outboundRtpTimestamp = (outboundRtpTimestamp + outboundTimestampIncrement(frame)) >>> 0;
  };
  const createOutboundSilenceFrame = (durationMs = deps.config.outboundAudio.frameMs): ServerAudioFrame => ({
    sequence: 0,
    pcm: new Int16Array(),
    sampleRateHz: deps.config.outboundAudio.sampleRateHz,
    channels: deps.config.outboundAudio.channels,
    durationMs,
    rtpPayload: new Uint8Array([0xf8, 0xff, 0xfe]),
    rtpTimestampIncrement: Math.round(deps.config.outboundAudio.sampleRateHz * durationMs / 1000),
    payloadType: 111
  });
  const writeOutboundSilenceFrame = async (durationMs = deps.config.outboundAudio.frameMs) => {
    const frame = createOutboundSilenceFrame(durationMs);
    const written = await outboundTrack.writeFrame(stampOutboundFrame(frame));
    if (written) advanceOutboundRtpClockForFrame(frame);
    return written;
  };
  const playback = createVoicePlaybackConsumer({
    deps,
    talkSessionId,
    playbackQueue,
    outboundTrack,
    stampOutboundFrame,
    advanceOutboundRtpClockForFrame,
    writeOutboundSilenceFrame,
    isClosed: () => closed
  });
  const interruptController = createInterruptController({
    callId: input.callId,
    talkSessionId,
    deps,
    source,
    playback,
    playbackQueue,
    activeTtsTasks,
    nowStamp,
    getAsrStreamId: () => asrStreamId,
    nextStableSequence: () => stableSequence++,
    bumpInterruptEpoch: () => { interruptEpoch += 1; return interruptEpoch; },
    getInterruptEpoch: () => interruptEpoch,
    bumpPlaybackGeneration: () => { playbackGeneration += 1; return playbackGeneration; }
  });
  const ttsProducer = createTtsProducer({
    callId: input.callId,
    talkSessionId,
    deps,
    outboundTrack,
    playbackQueue,
    activeTtsTasks,
    playback,
    synthesisTime,
    getPlaybackGeneration: () => playbackGeneration,
    getInterruptEpoch: () => interruptEpoch,
    stampOutboundFrame,
    advanceOutboundRtpClockForFrame,
    playbackGateOpen: interruptController.playbackGateOpen,
    archiveTtsOutput
  });
  const restartAsrStream = (reason: string) => {
    asrStreamIndex += 1;
    asrStreamId = `asr-${input.callId}-${asrStreamIndex}`;
    inboundSequence = 0;
    asrSession = createCallAsrSession(input, talkSessionId, asrStreamId, deps);
    deps.emitStatus?.({ state: "asr.stream.restarted", detail: `${asrStreamId}:${reason}` });
  };
  const runOutputPump = async () => {
    while (!closed) {
      const raw = deps.talkRuntime?.claimBufferedOutputText?.(talkSessionId)
        ?? deps.talkRuntime?.claimReadyOutputChunk?.(talkSessionId);
      const chunk = normalizeTalkChunk(raw);
      if (!chunk) {
        await sleep(25);
        continue;
      }
      const playback = call.playReplyText(chunk.text, chunk.outputId, {
        chunkId: chunk.chunkId,
        originalText: chunk.text,
        beforeFirstPlayback: async () => {
          if (!firstOutboundPlaybackBufferPending) return;
          firstOutboundPlaybackBufferPending = false;
          await deps.sleep?.(deps.config.outboundAudio.frameMs);
        }
      });
      void deps.talkRuntime?.startAgentLoop?.(talkSessionId);
      void playback.then(async (result) => {
        if (result?.failureReason) {
          deps.emitStatus?.({ state: "voice_call.tts_fatal", detail: `${result.outputId ?? chunk.outputId ?? ""} ${result.failureReason}`.trim() });
          await call.close("tts_failed");
          return;
        }
        if (result?.status !== "played" || !chunk.chunkId) return;
        try {
          await deps.talkRuntime?.markOutputChunkPlayed?.({ sessionId: talkSessionId, chunkId: chunk.chunkId });
          deps.emitStatus?.({ state: "talk_runtime.chunk_played", detail: `${chunk.outputId} chunk=${chunk.chunkId}` });
        } catch (error) {
          deps.emitStatus?.({ state: "talk_runtime.chunk_played_failed", detail: `${chunk.outputId} chunk=${chunk.chunkId}: ${error instanceof Error ? error.message : String(error)}` });
        }
      }).catch((error) => {
        deps.emitStatus?.({ state: "voice_call.output_pump.playback_failed", detail: error instanceof Error ? error.message : String(error) });
        void call.close("tts_failed");
      });
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
    playbackQueue,
    async acceptIceCandidate(candidate) {
      await peer.addIceCandidate?.(candidate);
    },
    async acceptInboundAudioChunk(bytes, timing) {
      if (closed) return undefined;
      const sequence = inboundSequence;
      inboundSequence += 1;
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
      if (stableText !== "-已撤回-" && playbackQueue.some((item) => item.status === "playing" || item.status === "queued")) {
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
    async interrupt(reason = "manual", targetOutputId) {
      await interruptController.runInterrupt(reason === "network" || reason === "unknown" ? "manual" : reason, targetOutputId);
    },
    async close(reason = "closed") {
      if (closed) return;
      closed = true;
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
  if (deps.talkRuntime?.claimReadyOutputChunk) {
    deps.emitStatus?.({ state: "voice_call.waiting", detail: talkSessionId });
    const pumpTask = runOutputPump();
    activePlaybackTasks.add(pumpTask);
    pumpTask.finally(() => activePlaybackTasks.delete(pumpTask));
  }
  return call;
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
  startCharIndex: number;
  endCharIndex: number;
} | undefined {
  if (!value || typeof value !== "object") return undefined;
  const chunk = value as Record<string, unknown>;
  if (typeof chunk.outputId !== "string" || typeof chunk.text !== "string") return undefined;
  return {
    sessionId: typeof chunk.sessionId === "string" ? chunk.sessionId : "",
    outputId: chunk.outputId,
    chunkId: typeof chunk.chunkId === "string" ? chunk.chunkId : undefined,
    text: chunk.text,
    startCharIndex: typeof chunk.startCharIndex === "number" ? chunk.startCharIndex : 0,
    endCharIndex: typeof chunk.endCharIndex === "number" ? chunk.endCharIndex : Array.from(chunk.text).length
  };
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
