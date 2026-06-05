import type {
  AsrInboundStreamAcceptResult,
  AsrInboundStreamSession
} from "../../asr/src/index.js";
import type {
  InboundAudioStreamChunkFrame,
  InboundAudioStreamStartFrame
} from "../../../packages/types/src/index.js";
import type { VoiceSynthesizer } from "../../tts/src/index.js";
import { createCurrentTimeProvider } from "../../../core/time/src/index.js";

const childProcess = await import("node:child_process");
const crypto = await import("node:crypto");
const moduleApi = await import("node:module");
const nodeBuffer: any = (await import("node:buffer")).Buffer;
const require = moduleApi.createRequire(import.meta.url);
const voiceTime = createCurrentTimeProvider("Asia/Tokyo");

export type WebRtcVoiceConfig = {
  enabled: boolean;
  callPath: string;
  signalingPath: string;
  accountId: string;
  language: string;
  asrProvider?: "tencent" | "openai_compatible";
  inboundAudio: {
    sampleRateHz: number;
    channels: number;
    encoding: string;
    chunkMs: number;
  };
  outboundAudio: {
    sampleRateHz: number;
    channels: number;
    frameMs: number;
  };
  iceServers: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
  bargeIn: {
    enabled: boolean;
    minSpeechMs: number;
  };
  timeouts: {
    signalingIdleMs: number;
    peerConnectionMs: number;
    ttsPlaybackStartMs: number;
  };
};

export type ServerAudioFrame = {
  sequence: number;
  pcm: Int16Array;
  sampleRateHz: number;
  channels: number;
  durationMs: number;
  rtpPayload?: Uint8Array;
  rtpTimestampIncrement?: number;
  payloadType?: number;
};

export type ServerOutboundAudioTrack = {
  writeFrame(frame: ServerAudioFrame): Promise<boolean> | boolean;
  waitUntilReady?(timeoutMs: number): Promise<boolean>;
  stop(): Promise<void> | void;
};

export type ServerWebRtcPeer = {
  createAnswer(offerSdp: string): Promise<string> | string;
  addIceCandidate?(candidate: unknown): Promise<void> | void;
  createOutboundAudioTrack(input: {
    sampleRateHz: number;
    channels: number;
    frameMs: number;
  }): Promise<ServerOutboundAudioTrack | undefined> | ServerOutboundAudioTrack | undefined;
  close(): Promise<void> | void;
};

export type DecodeAudioFileInput = {
  filePath: string;
  sampleRateHz: number;
  channels: number;
  frameMs: number;
};

export type EncodePcmL16Input = {
  pcm: Uint8Array;
  inputSampleRateHz: number;
  inputChannels: number;
  sampleRateHz: number;
  channels: number;
  frameMs: number;
};

export type WebRtcVoiceTtsStreamEvent =
  | { type: "translation_started"; sequence: number; sourceChars: number }
  | { type: "translation_done"; sequence: number; translatedChars: number }
  | { type: "audio"; sequence: number; chunk: Uint8Array; contentType: string }
  | { type: "part_done"; sequence: number }
  | { type: "done" };

export type WebRtcVoiceVadState = {
  speechActive: boolean;
  speechScore: number;
  noiseFloor: number;
  lastSpeechAt: number;
  silenceStartedAt: number;
};

export type WebRtcVoiceVadDecision = "candidate" | "active" | "inactive" | "none";

export type WebRtcVoiceSynthesizer = VoiceSynthesizer & {
  stream?(input: {
    text: string;
    time: ReturnType<typeof createCurrentTimeProvider>;
    source: "send_chat.voice";
    streamId?: string;
  }): AsyncIterable<WebRtcVoiceTtsStreamEvent>;
};

export function stepWebRtcVoiceVad(input: {
  state: WebRtcVoiceVadState;
  rms: number;
  nowMs: number;
  minSpeechFrames?: number;
  silenceMs?: number;
}): WebRtcVoiceVadDecision {
  const state = input.state;
  const minSpeechFrames = input.minSpeechFrames ?? 3;
  const silenceMs = input.silenceMs ?? 1500;
  if (!state.speechActive && state.speechScore === 0) state.noiseFloor = state.noiseFloor * 0.96 + input.rms * 0.04;
  const threshold = Math.max(3.5, state.noiseFloor * 1.4);
  if (input.rms >= threshold) {
    state.speechScore = Math.min(8, state.speechScore + 2);
    if (!state.speechActive && state.speechScore >= minSpeechFrames) {
      state.speechActive = true;
      state.lastSpeechAt = input.nowMs;
      state.silenceStartedAt = 0;
      return "active";
    }
    if (state.speechActive && state.speechScore >= 2) {
      state.lastSpeechAt = input.nowMs;
      state.silenceStartedAt = 0;
    }
    return "candidate";
  }
  if (state.speechScore > 0 && input.rms >= threshold * 0.65) {
    state.speechScore = Math.min(8, state.speechScore + 1);
    if (!state.speechActive && state.speechScore >= minSpeechFrames) {
      state.speechActive = true;
      state.lastSpeechAt = input.nowMs;
      state.silenceStartedAt = 0;
      return "active";
    }
    if (state.speechActive && state.speechScore >= 2) {
      state.lastSpeechAt = input.nowMs;
      state.silenceStartedAt = 0;
    }
    return "candidate";
  }
  state.speechScore = Math.max(0, state.speechScore - 1);
  if (state.speechActive) {
    state.silenceStartedAt ||= input.nowMs;
    const referenceSilenceStartedAt = Math.max(state.silenceStartedAt, state.lastSpeechAt || state.silenceStartedAt);
    if (input.nowMs - referenceSilenceStartedAt >= silenceMs) {
      state.speechActive = false;
      state.silenceStartedAt = 0;
      state.lastSpeechAt = 0;
      return "inactive";
    }
  }
  return "none";
}

export type WebRtcVoiceStatusEvent = {
  state: string;
  detail?: string;
};

export type WebRtcVoiceDeps = {
  config: WebRtcVoiceConfig;
  createPeer(input: {
    callId: string;
    userId: string;
    iceServers: WebRtcVoiceConfig["iceServers"];
    onLocalIceCandidate?: (candidate: unknown) => void;
  }): Promise<ServerWebRtcPeer> | ServerWebRtcPeer;
  createAsrSession(start: InboundAudioStreamStartFrame): AsrInboundStreamSession;
  voiceSynthesizer: WebRtcVoiceSynthesizer;
  decodeAudioFileToFrames(input: DecodeAudioFileInput): Promise<ServerAudioFrame[]> | ServerAudioFrame[];
  encodePcmL16ToFrames?(input: EncodePcmL16Input): Promise<ServerAudioFrame[]> | ServerAudioFrame[];
  emitStatus?(event: WebRtcVoiceStatusEvent): void;
  now?(): Date;
  sleep?(ms: number): Promise<void>;
};

export type CreateWebRtcVoiceCallInput = {
  callId: string;
  userId: string;
  offerSdp: string;
  onLocalIceCandidate?: (candidate: unknown) => void;
};

export type PlaybackResult = {
  status: "played" | "interrupted";
  outputId?: string;
  frameCount: number;
};

export type PlaybackItem = {
  outputId?: string;
  textHash: string;
  assetId: string;
  filePath: string;
  status: "queued" | "playing" | "played" | "interrupted" | "failed";
  createdAt: string;
};

export type WebRtcVoiceCall = {
  callId: string;
  userId: string;
  answerSdp: string;
  talkSessionId: string;
  asrStreamId: string;
  talkRuntimeIngressStatus: "todo";
  playbackQueue: PlaybackItem[];
  acceptIceCandidate(candidate: unknown): Promise<void>;
  acceptInboundAudioChunk(bytes: Uint8Array, timing?: InboundAudioStreamChunkFrame["timing"]): Promise<AsrInboundStreamAcceptResult | undefined>;
  endInboundAudio(): Promise<AsrInboundStreamAcceptResult | undefined>;
  setSpeechActive(active: boolean): Promise<void>;
  playReplyText(text: string, outputId?: string): Promise<PlaybackResult>;
  interrupt(reason?: "manual" | "barge_in" | "network" | "unknown", targetOutputId?: string): void;
  close(reason?: string): Promise<void>;
};

export type WebRtcVoicePlugin = {
  id: "webrtc_voice";
  config: WebRtcVoiceConfig;
  renderCallPage(): string;
  createCall(input: CreateWebRtcVoiceCallInput): Promise<WebRtcVoiceCall>;
};

export type WebRtcVoiceErrorCode =
    | "plugin_disabled"
    | "outbound_track_failed"
    | "webrtc_negotiation_failed"
    | "asr_stream_failed"
    | "tts_failed";

export class WebRtcVoiceError extends Error {
  constructor(public readonly code: WebRtcVoiceErrorCode, message?: string) {
    message ??= code;
    super(message);
  }
}

export function createWebRtcVoicePlugin(deps: WebRtcVoiceDeps): WebRtcVoicePlugin {
  return {
    id: "webrtc_voice",
    config: deps.config,
    renderCallPage() {
      return renderCallPage(deps.config);
    },
    async createCall(input) {
      if (!deps.config.enabled) throw new WebRtcVoiceError("plugin_disabled");
      deps.emitStatus?.({ state: "tts.prepare.started", detail: "connecting" });
      await deps.voiceSynthesizer.prepare?.();
      deps.emitStatus?.({ state: "tts.prepare.ready", detail: "connected" });
      const peer = await deps.createPeer({
        callId: input.callId,
        userId: input.userId,
        iceServers: deps.config.iceServers,
        onLocalIceCandidate: input.onLocalIceCandidate
      });
      const outboundTrack = await peer.createOutboundAudioTrack({
        sampleRateHz: deps.config.outboundAudio.sampleRateHz,
        channels: deps.config.outboundAudio.channels,
        frameMs: deps.config.outboundAudio.frameMs
      });
      if (!outboundTrack) throw new WebRtcVoiceError("outbound_track_failed", "server WebRTC outbound audio track is required");

      let answerSdp: string;
      try {
        answerSdp = await peer.createAnswer(input.offerSdp);
      } catch (error) {
        throw new WebRtcVoiceError("webrtc_negotiation_failed", error instanceof Error ? error.message : String(error));
      }

      return createCallState(input, answerSdp, peer, outboundTrack, deps);
    }
  };
}

export function renderWebRtcVoiceCallPage(config: WebRtcVoiceConfig = defaultWebRtcVoiceConfig()): string {
  return renderCallPage(config);
}

export function defaultWebRtcVoiceConfig(): WebRtcVoiceConfig {
  return {
    enabled: true,
    callPath: "/plugins/webrtc-voice/call",
    signalingPath: "/plugins/webrtc-voice/signaling",
    accountId: "main",
    language: "ja",
    inboundAudio: {
      sampleRateHz: 48000,
      channels: 1,
      encoding: "opus",
      chunkMs: 20
    },
    outboundAudio: {
      sampleRateHz: 48000,
      channels: 1,
      frameMs: 20
    },
    iceServers: [],
    bargeIn: {
      enabled: true,
      minSpeechMs: 500
    },
    timeouts: {
      signalingIdleMs: 30_000,
      peerConnectionMs: 10_000,
      ttsPlaybackStartMs: 10_000
    }
  };
}

export async function createWeriftPeer(input: {
  callId: string;
  userId: string;
  iceServers: WebRtcVoiceConfig["iceServers"];
  onInboundAudioChunk?(bytes: Uint8Array): void | Promise<void>;
  onLocalIceCandidate?(candidate: unknown): void;
  onStatus?(event: WebRtcVoiceStatusEvent): void;
}): Promise<ServerWebRtcPeer> {
  const werift = await import("werift");
  const peer = new werift.RTCPeerConnection({
    iceServers: input.iceServers.map((server) => ({
      urls: Array.isArray(server.urls) ? server.urls[0] ?? "" : server.urls,
      username: server.username,
      credential: server.credential
    }))
  });
  let outboundReady = false;
  const waiters: Array<() => void> = [];
  let outboundTrack: any;
  let outboundSender: any;
  const markOutboundReady = (reason: string) => {
    if (outboundReady) return;
    outboundReady = true;
    input.onStatus?.({ state: "webrtc.outbound_audio.ready", detail: reason });
    for (const waiter of waiters.splice(0)) waiter();
  };
  peer.onIceCandidate.subscribe((candidate: unknown) => {
    input.onStatus?.({ state: "webrtc.ice_candidate", detail: candidate ? "candidate" : "complete" });
    input.onLocalIceCandidate?.(candidate);
  });
  peer.connectionStateChange.subscribe((state: string) => {
    input.onStatus?.({ state: "webrtc.connection", detail: state });
  });
  peer.iceConnectionStateChange.subscribe((state: string) => {
    input.onStatus?.({ state: "webrtc.ice_connection", detail: state });
  });
  peer.onTrack.subscribe((track: any) => {
    if (track.kind !== "audio") return;
    input.onStatus?.({ state: "webrtc.inbound_track", detail: input.callId });
    track.onReceiveRtp.subscribe((rtp: { payload?: Buffer | Uint8Array }) => {
      const payload = rtp.payload ? new Uint8Array(rtp.payload) : new Uint8Array();
      if (payload.byteLength) void input.onInboundAudioChunk?.(payload);
    });
  });

  return {
    async createAnswer(offerSdp) {
      await peer.setRemoteDescription({ type: "offer", sdp: offerSdp });
      if (outboundTrack && !outboundSender) {
        outboundSender = peer.addTrack(outboundTrack);
        outboundSender?.onReady?.subscribe?.(() => markOutboundReady("sender_ready"));
        outboundSender?.dtlsTransport?.onStateChange?.subscribe?.((state: string) => {
          input.onStatus?.({ state: "webrtc.sender.dtls", detail: state });
          if (state === "connected") markOutboundReady("sender_dtls_connected");
        });
        if (outboundSender?.dtlsTransport?.state === "connected") markOutboundReady("sender_already_ready");
      }
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      input.onStatus?.({ state: "webrtc.answer.audio", detail: summarizeAudioSdp(answer.sdp) });
      return answer.sdp;
    },
    async addIceCandidate(candidate) {
      if (!candidate) return;
      await peer.addIceCandidate(candidate as any);
    },
    createOutboundAudioTrack() {
      outboundTrack = new werift.MediaStreamTrack({ kind: "audio" });
      return {
        async waitUntilReady(timeoutMs: number) {
          if (!outboundReady) {
            input.onStatus?.({ state: "webrtc.outbound_audio.waiting", detail: `sender_ready:${outboundSender?.dtlsTransport?.state ?? "no_dtls"}` });
            await waitForPeerConnected(() => outboundReady, waiters, timeoutMs);
          }
          if (!outboundReady) input.onStatus?.({ state: "webrtc.outbound_audio.not_ready", detail: `sender_ready_timeout:${outboundSender?.dtlsTransport?.state ?? "no_dtls"}` });
          return outboundReady;
        },
        async writeFrame(frame: ServerAudioFrame) {
          if (!frame.rtpPayload?.byteLength) return false;
          if (!outboundReady) {
            input.onStatus?.({ state: "webrtc.outbound_audio.dropped", detail: "sender_not_ready" });
            return false;
          }
          const sequence = frame.sequence & 0xffff;
          const timestamp = (frame.sequence * (frame.rtpTimestampIncrement ?? 960)) >>> 0;
          const packet = new werift.RtpPacket(new werift.RtpHeader({
            payloadType: frame.payloadType ?? 111,
            sequenceNumber: sequence,
            timestamp,
            ssrc: 0
          }), nodeBuffer.from(frame.rtpPayload));
          outboundTrack.writeRtp(packet);
          return true;
        },
        stop() {
          outboundTrack?.stop();
        }
      };
    },
    async close() {
      outboundTrack?.stop();
      await peer.close();
    }
  };
}

export async function decodeAudioFileToOpusRtpFrames(input: DecodeAudioFileInput & { ffmpegCommand?: string }): Promise<ServerAudioFrame[]> {
  const ogg = await runFfmpegToOggOpus(input.filePath, input.ffmpegCommand ?? "ffmpeg-static");
  const packets = parseOggOpusPackets(ogg).filter((packet) => !isOpusHeaderPacket(packet));
  const timestampIncrement = Math.round(input.sampleRateHz * input.frameMs / 1000);
  return packets.map((packet, index) => ({
    sequence: index,
    pcm: new Int16Array(),
    sampleRateHz: input.sampleRateHz,
    channels: input.channels,
    durationMs: input.frameMs,
    rtpPayload: packet,
    rtpTimestampIncrement: timestampIncrement,
    payloadType: 111
  }));
}

export async function encodePcmL16ToOpusRtpFrames(input: EncodePcmL16Input & { ffmpegCommand?: string }): Promise<ServerAudioFrame[]> {
  const ogg = await runFfmpegPcmL16ToOggOpus(input.pcm, input.inputSampleRateHz, input.inputChannels, input.ffmpegCommand ?? "ffmpeg-static");
  const packets = parseOggOpusPackets(ogg).filter((packet) => !isOpusHeaderPacket(packet));
  const timestampIncrement = Math.round(input.sampleRateHz * input.frameMs / 1000);
  return packets.map((packet, index) => ({
    sequence: index,
    pcm: new Int16Array(),
    sampleRateHz: input.sampleRateHz,
    channels: input.channels,
    durationMs: input.frameMs,
    rtpPayload: packet,
    rtpTimestampIncrement: timestampIncrement,
    payloadType: 111
  }));
}

export function attachWebRtcVoiceSignalingServer(input: {
  server: { on(event: "upgrade", listener: (request: any, socket: any, head: any) => void): unknown };
  plugin: WebRtcVoicePlugin;
  path?: string;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
  onCallCreated?(call: WebRtcVoiceCall): void;
  onClientConnected?(client: { send(message: unknown): void }): void;
}): void {
  const signalingPath = input.path ?? input.plugin.config.signalingPath;
  input.server.on("upgrade", (request: any, socket: any) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== signalingPath) return;
    try {
      acceptWebSocket(request, socket);
      const callId = url.searchParams.get("callId") || `browser-${Date.now()}`;
      const userId = url.searchParams.get("userId") || "browser";
      let call: WebRtcVoiceCall | undefined;
      let wsBuffer = nodeBuffer.alloc(0);
      const send = (message: unknown) => sendWebSocketFrame(socket, JSON.stringify(message));
      input.onClientConnected?.({ send });
      socket.on("data", async (chunk: any) => {
        try {
          const decoded = readWebSocketTextFrames(nodeBuffer.concat([wsBuffer, chunk]));
          wsBuffer = decoded.rest;
          for (const text of decoded.messages) {
            const message = JSON.parse(text) as { type?: string; sdp?: string; candidate?: unknown; reason?: string };
            if (message.type === "offer" && message.sdp) {
              let answerSent = false;
              const pendingCandidates: unknown[] = [];
              call = await input.plugin.createCall({
                callId,
                userId,
                offerSdp: message.sdp,
                onLocalIceCandidate(candidate) {
                  if (answerSent) send({ type: "ice", candidate });
                  else pendingCandidates.push(candidate);
                }
              });
              input.onCallCreated?.(call);
              send({ type: "answer", sdp: call.answerSdp });
              answerSent = true;
              for (const candidate of pendingCandidates) send({ type: "ice", candidate });
              send({ type: "status", state: "webrtc.answer.created" });
            } else if (message.type === "ice") {
              await call?.acceptIceCandidate(message.candidate);
            } else if (message.type === "speech-state") {
              await call?.setSpeechActive(Boolean((message as { active?: unknown }).active));
            } else if (message.type === "audio-chunk") {
              const data = (message as { data?: unknown }).data;
              if (typeof data === "string") {
                await call?.acceptInboundAudioChunk(new Uint8Array(nodeBuffer.from(data, "base64")));
              }
            } else if (message.type === "speak-test") {
              try {
                await call?.playReplyText([
                  "これは疑似ストリーミング音声のテストです。",
                  "最初の文が再生されている間に、次の文を順番に合成します。",
                  "途中で割り込みボタンを押すと、残りの文は再生されません。",
                  "聞こえ方と停止の反応を確認してください。"
                ].join(""), "manual-test");
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                input.appendLog?.("error", `webrtc voice tts failed: ${message}`);
                send({ type: "status", state: "tts.failed", detail: message });
              }
            } else if (message.type === "interrupt") {
              call?.interrupt("manual");
            } else if (message.type === "hangup") {
              await call?.close(message.reason);
              socket.end();
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          input.appendLog?.("error", `webrtc voice signaling message failed: ${message}`);
          send({ type: "error", error: "signaling_message_failed", message });
        }
      });
      socket.on("close", () => {
        void call?.close("socket_closed");
      });
    } catch (error) {
      input.appendLog?.("error", `webrtc voice signaling failed: ${error instanceof Error ? error.message : String(error)}`);
      socket.destroy();
    }
  });
}

function createCallState(
  input: CreateWebRtcVoiceCallInput,
  answerSdp: string,
  peer: ServerWebRtcPeer,
  outboundTrack: ServerOutboundAudioTrack,
  deps: WebRtcVoiceDeps
): WebRtcVoiceCall {
  const talkSessionId = `webrtc_voice:${input.callId}`;
  let asrStreamIndex = 0;
  let asrStreamId = `asr-${input.callId}-${asrStreamIndex}`;
  let inboundSequence = 0;
  let outboundFrameSequence = 0;
  let closed = false;
  let speechActive = false;
  let playbackGeneration = 0;
  const playbackQueue: PlaybackItem[] = [];
  let asrSession = createCallAsrSession(input, talkSessionId, asrStreamId, deps);
  const restartAsrStream = (reason: string) => {
    asrStreamIndex += 1;
    asrStreamId = `asr-${input.callId}-${asrStreamIndex}`;
    inboundSequence = 0;
    asrSession = createCallAsrSession(input, talkSessionId, asrStreamId, deps);
    deps.emitStatus?.({ state: "asr.stream.restarted", detail: `${asrStreamId}:${reason}` });
  };

  const call: WebRtcVoiceCall = {
    callId: input.callId,
    userId: input.userId,
    answerSdp,
    talkSessionId,
    get asrStreamId() {
      return asrStreamId;
    },
    talkRuntimeIngressStatus: "todo",
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
      if (!result.ok && isRecoverableAsrError(result.error)) restartAsrStream(result.error);
      return result;
    },
    async endInboundAudio() {
      if (closed) return undefined;
      const result = await acceptAsrFrame(asrSession, {
        type: "end",
        streamId: asrStreamId,
        metadata: {
          callId: input.callId,
          talkSessionId
        }
      }, deps);
      handleAsrResult(result, deps);
      if (!result.ok && !isRecoverableAsrError(result.error)) return result;
      return result;
    },
    async setSpeechActive(active) {
      if (closed || speechActive === active) return;
      speechActive = active;
      deps.emitStatus?.({ state: active ? "speech.active" : "speech.inactive", detail: active ? "speaking" : "not speaking" });
      if (active && deps.config.bargeIn.enabled && playbackQueue.length) {
        deps.emitStatus?.({ state: "tts.barge_in", detail: playbackQueue[0]?.outputId });
        this.interrupt("barge_in", playbackQueue[0]?.outputId);
      }
      if (!active) {
        const result = await this.endInboundAudio();
        if (result) {
          restartAsrStream(result.ok ? "speech_inactive" : result.error);
        }
      }
    },
    async playReplyText(text, outputId) {
      const createdAt = (deps.now?.() ?? new Date()).toISOString();
      const generation = ++playbackGeneration;
      let frameCount = 0;
      const item: PlaybackItem = {
        outputId,
        textHash: hashText(text),
        assetId: "",
        filePath: "",
        status: "queued",
        createdAt
      };
      playbackQueue.push(item);
      item.status = "playing";
      const ready = await outboundTrack.waitUntilReady?.(deps.config.timeouts.ttsPlaybackStartMs);
      if (ready === false) {
        item.status = "failed";
        playbackQueue.shift();
        deps.emitStatus?.({ state: "tts.failed", detail: "outbound_audio_not_ready" });
        return {
          status: "interrupted",
          outputId,
          frameCount: 0
        };
      }
      if (deps.voiceSynthesizer.stream && deps.encodePcmL16ToFrames) {
        deps.emitStatus?.({ state: "tts.stream.started", detail: outputId });
        for await (const event of deps.voiceSynthesizer.stream({
          text,
          time: voiceTime,
          source: "send_chat.voice",
          streamId: outputId
        })) {
          if (generation !== playbackGeneration || !playbackQueue.includes(item)) break;
          if (event.type === "translation_started") {
            deps.emitStatus?.({ state: "tts.stream.translation_started", detail: `${event.sequence}:${event.sourceChars}` });
            continue;
          }
          if (event.type === "translation_done") {
            deps.emitStatus?.({ state: "tts.stream.translation_done", detail: `${event.sequence}:${event.translatedChars}` });
            continue;
          }
          if (event.type === "part_done") {
            deps.emitStatus?.({ state: "tts.stream.part_done", detail: String(event.sequence) });
            continue;
          }
          if (event.type === "done") {
            deps.emitStatus?.({ state: "tts.stream.done", detail: outputId });
            break;
          }
          if (event.type !== "audio") continue;
          const frames = await deps.encodePcmL16ToFrames({
            pcm: event.chunk,
            inputSampleRateHz: 32_000,
            inputChannels: 1,
            sampleRateHz: deps.config.outboundAudio.sampleRateHz,
            channels: deps.config.outboundAudio.channels,
            frameMs: deps.config.outboundAudio.frameMs
          });
          for (const frame of frames) {
            if (generation !== playbackGeneration || !playbackQueue.includes(item)) break;
            const written = await outboundTrack.writeFrame({
              ...frame,
              sequence: outboundFrameSequence++
            });
            if (written) frameCount += 1;
            await (deps.sleep ?? sleep)(frame.durationMs);
          }
          deps.emitStatus?.({ state: "tts.stream.frames_sent", detail: `${event.sequence}:${frameCount}` });
        }
        const interrupted = generation !== playbackGeneration || !playbackQueue.includes(item);
        item.status = interrupted ? "interrupted" : frameCount > 0 ? "played" : "failed";
        playbackQueue.shift();
        deps.emitStatus?.({ state: interrupted ? "tts.interrupted" : frameCount > 0 ? "tts.played" : "tts.failed", detail: frameCount > 0 ? outputId : "no_frames_sent" });
        return {
          status: interrupted || frameCount === 0 ? "interrupted" : "played",
          outputId,
          frameCount
        };
      }
      const parts = splitTtsPseudoStreamParts(text);
      const synthesizePart = async (part: string, partIndex: number) => {
        deps.emitStatus?.({ state: "tts.part.synthesizing", detail: `${partIndex + 1}/${parts.length}` });
        let voice;
        try {
          voice = await deps.voiceSynthesizer({ text: part, time: voiceTime });
        } catch (error) {
          item.status = "failed";
          throw new WebRtcVoiceError("tts_failed", error instanceof Error ? error.message : String(error));
        }
        deps.emitStatus?.({ state: "tts.part.synthesized", detail: `${partIndex + 1}/${parts.length}` });
        return {
          voice,
          frames: await deps.decodeAudioFileToFrames({
            filePath: voice.filePath,
            sampleRateHz: deps.config.outboundAudio.sampleRateHz,
            channels: deps.config.outboundAudio.channels,
            frameMs: deps.config.outboundAudio.frameMs
          })
        };
      };
      let nextPartPromise = parts[0] ? synthesizePart(parts[0], 0) : undefined;
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        if (generation !== playbackGeneration || !playbackQueue.includes(item)) break;
        const prepared = await nextPartPromise;
        if (!prepared) break;
        nextPartPromise = parts[partIndex + 1] && generation === playbackGeneration && playbackQueue.includes(item)
          ? synthesizePart(parts[partIndex + 1], partIndex + 1)
          : undefined;
        deps.emitStatus?.({ state: "tts.part.playing", detail: `${partIndex + 1}/${parts.length}` });
        item.assetId = prepared.voice.assetId;
        item.filePath = prepared.voice.filePath;
        for (const frame of prepared.frames) {
          if (generation !== playbackGeneration || !playbackQueue.includes(item)) break;
          const written = await outboundTrack.writeFrame({
            ...frame,
            sequence: outboundFrameSequence++
          });
          if (written) frameCount += 1;
          await (deps.sleep ?? sleep)(frame.durationMs);
        }
        deps.emitStatus?.({ state: "tts.part.frames_sent", detail: `${partIndex + 1}/${parts.length}:${frameCount}` });
      }
      const interrupted = generation !== playbackGeneration || !playbackQueue.includes(item);
      item.status = interrupted ? "interrupted" : frameCount > 0 ? "played" : "failed";
      playbackQueue.shift();
      deps.emitStatus?.({ state: interrupted ? "tts.interrupted" : frameCount > 0 ? "tts.played" : "tts.failed", detail: frameCount > 0 ? outputId : "no_frames_sent" });
      return {
        status: interrupted || frameCount === 0 ? "interrupted" : "played",
        outputId,
        frameCount
      };
    },
    interrupt(reason = "manual", targetOutputId) {
      playbackGeneration += 1;
      for (const item of playbackQueue) item.status = "interrupted";
      playbackQueue.length = 0;
      deps.emitStatus?.({ state: "talk_runtime.interrupt.todo", detail: `${reason}:${targetOutputId ?? ""}` });
    },
    async close(reason = "closed") {
      if (closed) return;
      closed = true;
      playbackQueue.length = 0;
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
      deps.emitStatus?.({ state: "talk_runtime.close.todo", detail: reason });
    }
  };

  deps.emitStatus?.({ state: "talk_runtime.open.todo", detail: talkSessionId });
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

function renderCallPage(config: WebRtcVoiceConfig): string {
  const signalingPath = escapeHtml(config.signalingPath);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Alice WebRTC Voice</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; max-width: 760px; }
    button { margin-right: 8px; padding: 8px 12px; }
    #status { margin-top: 16px; white-space: pre-wrap; font-family: ui-monospace, monospace; }
    .error { color: #b00020; }
  </style>
</head>
<body>
  <main>
    <button id="callButton" type="button">Call</button>
    <button id="testSpeakButton" type="button">Test voice</button>
    <button id="interruptButton" type="button">Interrupt voice</button>
    <button id="hangupButton" type="button">Hang up</button>
    <audio id="remoteAudio" autoplay playsinline controls></audio>
    <div id="status"></div>
  </main>
  <script type="module">
    const signalingPath = ${JSON.stringify(signalingPath)};
    const remoteAudio = document.getElementById("remoteAudio");
    remoteAudio.autoplay = true;
    remoteAudio.muted = false;
    remoteAudio.volume = 1;
    const status = document.getElementById("status");
    let peer;
    let socket;
    let speechActive = false;
    let silenceStartedAt = 0;
    let vadTimer;
    let pcmSource;
    let pcmProcessor;
    let pendingRemoteIce = [];
    function log(line, error = false) {
      const prefix = new Date().toLocaleTimeString();
      status.textContent += "[" + prefix + "] " + line + "\\n";
      status.className = error ? "error" : "";
    }
    document.getElementById("callButton").addEventListener("click", async () => {
      try {
        log("requesting microphone");
        void remoteAudio.play().catch(() => {
          // The real remote stream is attached after negotiation; this call unlocks autoplay in the Call gesture.
        });
        if (!window.isSecureContext) {
          log("this page is not a secure context; use HTTPS or localhost for microphone access", true);
        }
        const localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1
          }
        });
        log("microphone ready");
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack?.getSettings) {
          const settings = audioTrack.getSettings();
          log("audio processing requested: noiseSuppression=true echoCancellation=true autoGainControl=true; actual sampleRate=" + (settings.sampleRate || "unknown"));
        }
        startPcmStreaming(localStream);
        startVad(localStream);
        peer = new RTCPeerConnection({ iceServers: ${JSON.stringify(config.iceServers)} });
        for (const track of localStream.getAudioTracks()) peer.addTrack(track, localStream);
        peer.addEventListener("connectionstatechange", () => log("peer connection: " + peer.connectionState));
        peer.addEventListener("iceconnectionstatechange", () => log("ice connection: " + peer.iceConnectionState));
        peer.addEventListener("track", (event) => {
          log("remote audio track received");
          remoteAudio.srcObject = event.streams[0] || new MediaStream([event.track]);
          event.track.addEventListener("mute", () => log("remote audio track muted"));
          event.track.addEventListener("unmute", () => log("remote audio track unmuted"));
          void remoteAudio.play().catch((error) => log("audio play failed: " + error.message, true));
        });
        const wsUrl = new URL(signalingPath, window.location.href);
        wsUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        wsUrl.searchParams.set("callId", crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
        socket = new WebSocket(wsUrl);
        socket.addEventListener("open", async () => {
          log("signaling connected; creating offer and starting ASR stream");
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          socket.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));
        });
        socket.addEventListener("message", async (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "answer") {
            await peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
            log("answer applied");
            for (const candidate of pendingRemoteIce.splice(0)) {
              await peer.addIceCandidate(candidate).catch((error) => log("queued ice failed: " + error.message, true));
            }
          }
          if (message.type === "ice") {
            if (peer.remoteDescription) await peer.addIceCandidate(message.candidate).catch((error) => log("ice failed: " + error.message, true));
            else pendingRemoteIce.push(message.candidate);
          }
          if (message.type === "status") log(message.state + (message.detail ? ": " + message.detail : ""));
          if (message.type === "error") log(message.error + (message.message ? ": " + message.message : ""), true);
        });
        socket.addEventListener("error", () => log("signaling websocket error", true));
        socket.addEventListener("close", () => log("signaling closed"));
        peer.addEventListener("icecandidate", (event) => {
          if (event.candidate) socket?.send(JSON.stringify({ type: "ice", candidate: event.candidate }));
        });
      } catch (error) {
        log(error && error.message ? error.message : String(error), true);
      }
    });
    document.getElementById("hangupButton").addEventListener("click", () => {
      socket?.send(JSON.stringify({ type: "hangup", reason: "manual" }));
      peer?.close();
    });
    document.getElementById("testSpeakButton").addEventListener("click", () => {
      void remoteAudio.play().catch((error) => log("audio play failed before test voice: " + error.message, true));
      log("test voice requested; socket=" + (socket ? socket.readyState : "none") + " remoteAudio paused=" + remoteAudio.paused + " muted=" + remoteAudio.muted + " readyState=" + remoteAudio.readyState);
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        log("test voice not sent; signaling is not open", true);
        return;
      }
      socket.send(JSON.stringify({ type: "speak-test" }));
    });
    setInterval(() => {
      if (!remoteAudio.srcObject) return;
      log("remoteAudio state: paused=" + remoteAudio.paused + " muted=" + remoteAudio.muted + " readyState=" + remoteAudio.readyState + " currentTime=" + remoteAudio.currentTime.toFixed(2));
    }, 3000);
    document.getElementById("interruptButton").addEventListener("click", () => {
      log("interrupt requested");
      socket?.send(JSON.stringify({ type: "interrupt" }));
    });
    function startVad(stream) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) {
        log("Web Audio is unavailable; speech state detection disabled", true);
        return;
      }
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let noiseFloor = 6;
      let speechScore = 0;
      let speechCandidateLogged = false;
      let lastSpeechAt = 0;
      let lastMeterLogAt = 0;
      const minSpeechFrames = Math.max(3, Math.ceil(${JSON.stringify(config.bargeIn.minSpeechMs)} / 200));
      const silenceMs = 1500;
      clearInterval(vadTimer);
      vadTimer = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) {
          const centered = value - 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        const now = Date.now();
        if (!speechActive && speechScore === 0) noiseFloor = noiseFloor * 0.96 + rms * 0.04;
        const threshold = Math.max(3.5, noiseFloor * 1.4);
        if (now - lastMeterLogAt >= 1000) {
          lastMeterLogAt = now;
          log("mic level: rms=" + rms.toFixed(1) + " threshold=" + threshold.toFixed(1) + " noise=" + noiseFloor.toFixed(1) + " active=" + speechActive);
        }
        if (rms >= threshold) {
          speechScore = Math.min(8, speechScore + 2);
          if (!speechCandidateLogged) {
            speechCandidateLogged = true;
            log("voice detected; confirming speech");
          }
          if (!speechActive && speechScore >= minSpeechFrames) {
            speechActive = true;
            lastSpeechAt = now;
            silenceStartedAt = 0;
            speechCandidateLogged = false;
            log("speaking; realtime transcription active; interrupting TTS if playing");
            socket?.send(JSON.stringify({ type: "speech-state", active: true }));
          } else if (speechActive && speechScore >= 2) {
            lastSpeechAt = now;
            silenceStartedAt = 0;
          }
        } else {
          if (speechScore > 0 && rms >= threshold * 0.65) {
            speechScore = Math.min(8, speechScore + 1);
            if (!speechActive && speechScore >= minSpeechFrames) {
              speechActive = true;
              lastSpeechAt = now;
              silenceStartedAt = 0;
              speechCandidateLogged = false;
              log("speaking; realtime transcription active; interrupting TTS if playing");
              socket?.send(JSON.stringify({ type: "speech-state", active: true }));
            } else if (speechActive && speechScore >= 2) {
              lastSpeechAt = now;
              silenceStartedAt = 0;
            }
            return;
          }
          speechScore = Math.max(0, speechScore - 1);
          if (!speechActive && speechCandidateLogged && speechScore === 0) {
            log("voice candidate dropped");
            speechCandidateLogged = false;
          }
          if (speechActive) {
            silenceStartedAt ||= now;
            const referenceSilenceStartedAt = Math.max(silenceStartedAt, lastSpeechAt || silenceStartedAt);
            if (now - referenceSilenceStartedAt >= silenceMs) {
              speechActive = false;
              silenceStartedAt = 0;
              lastSpeechAt = 0;
              log("not speaking");
              socket?.send(JSON.stringify({ type: "speech-state", active: false }));
            }
          }
        }
      }, 100);
    }
    function startPcmStreaming(stream) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContext();
      pcmSource = audioContext.createMediaStreamSource(stream);
      pcmProcessor = audioContext.createScriptProcessor(4096, 1, 1);
      let pcmNoiseFloor = 0.004;
      pcmProcessor.onaudioprocess = (event) => {
        if (!speechActive || !socket || socket.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const denoised = noiseGate(input, pcmNoiseFloor);
        pcmNoiseFloor = estimateNoiseFloor(input, pcmNoiseFloor);
        const pcm = downsampleToPcm16(denoised, audioContext.sampleRate, 16000);
        if (!pcm.byteLength) return;
        let binary = "";
        const bytes = new Uint8Array(pcm.buffer);
        for (const byte of bytes) binary += String.fromCharCode(byte);
        socket.send(JSON.stringify({ type: "audio-chunk", data: btoa(binary) }));
      };
      pcmSource.connect(pcmProcessor);
      pcmProcessor.connect(audioContext.destination);
    }
    function estimateNoiseFloor(input, previous) {
      let sum = 0;
      for (const sample of input) sum += sample * sample;
      const rms = Math.sqrt(sum / Math.max(1, input.length));
      if (speechActive && rms > previous * 2.5) return previous;
      return previous * 0.98 + rms * 0.02;
    }
    function noiseGate(input, floor) {
      const threshold = Math.max(0.006, floor * 2.2);
      let sum = 0;
      for (const sample of input) sum += sample * sample;
      const rms = Math.sqrt(sum / Math.max(1, input.length));
      if (rms < threshold) return new Float32Array(input.length);
      const output = new Float32Array(input.length);
      const gain = Math.min(1, Math.max(0.25, (rms - threshold) / Math.max(rms, 0.0001)));
      for (let index = 0; index < input.length; index += 1) output[index] = input[index] * gain;
      return output;
    }
    function downsampleToPcm16(input, sourceRate, targetRate) {
      const ratio = sourceRate / targetRate;
      const length = Math.floor(input.length / ratio);
      const output = new Int16Array(length);
      for (let index = 0; index < length; index += 1) {
        const sourceIndex = Math.floor(index * ratio);
        const sample = Math.max(-1, Math.min(1, input[sourceIndex] || 0));
        output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      return output;
    }
  </script>
</body>
</html>`;
}

function hashText(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16);
}

function splitTtsPseudoStreamParts(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const matches = normalized.match(/[^。！？.!?\n]+[。！？.!?]?|\n+/g) ?? [normalized];
  const parts = matches
    .map((part) => part.trim())
    .filter((part) => part && !/^\n+$/.test(part));
  return parts.length ? parts : [normalized];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function acceptWebSocket(request: any, socket: any): void {
  const key = request.headers["sec-websocket-key"];
  if (!key) throw new Error("missing websocket key");
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));
}

function sendWebSocketFrame(socket: any, text: string): void {
  const payload = nodeBuffer.from(text);
  const header = payload.length < 126
    ? nodeBuffer.from([0x81, payload.length])
    : payload.length <= 0xffff
      ? nodeBuffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
      : undefined;
  if (!header) throw new Error("websocket frame too large");
  socket.write(nodeBuffer.concat([header, payload]));
}

function readWebSocketTextFrames(buffer: any): { messages: string[]; rest: any } {
  const messages: string[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const frameStart = offset;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    offset += 2;
    if (length === 126) {
      if (offset + 2 > buffer.length) return { messages, rest: buffer.subarray(frameStart) };
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      throw new Error("large websocket frames are not supported");
    }
    let mask: Buffer | undefined;
    if (masked) {
      if (offset + 4 > buffer.length) return { messages, rest: buffer.subarray(frameStart) };
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (offset + length > buffer.length) return { messages, rest: buffer.subarray(frameStart) };
    const payload = nodeBuffer.from(buffer.subarray(offset, offset + length));
    offset += length;
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    if (opcode === 0x8) break;
    if (opcode === 0x1) messages.push(payload.toString("utf8"));
  }
  return { messages, rest: buffer.subarray(offset) };
}

async function runFfmpegToOggOpus(filePath: string, ffmpegCommand: string): Promise<any> {
  const command = resolveFfmpegCommand(ffmpegCommand);
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", filePath,
      "-ac", "1",
      "-ar", "48000",
      "-c:a", "libopus",
      "-application", "voip",
      "-frame_duration", "20",
      "-f", "opus",
      "pipe:1"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: any[] = [];
    const stderr: any[] = [];
    child.stdout.on("data", (chunk: any) => stdout.push(chunk));
    child.stderr.on("data", (chunk: any) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(nodeBuffer.concat(stdout) as any);
      else reject(new Error(`ffmpeg opus transcode failed: ${nodeBuffer.concat(stderr).toString("utf8").slice(0, 500)}`));
    });
  });
}

async function runFfmpegPcmL16ToOggOpus(pcm: Uint8Array, sampleRateHz: number, channels: number, ffmpegCommand: string): Promise<any> {
  const command = resolveFfmpegCommand(ffmpegCommand);
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "s16le",
      "-ar", String(sampleRateHz),
      "-ac", String(channels),
      "-i", "pipe:0",
      "-ac", "1",
      "-ar", "48000",
      "-c:a", "libopus",
      "-application", "voip",
      "-frame_duration", "20",
      "-f", "opus",
      "pipe:1"
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: any[] = [];
    const stderr: any[] = [];
    child.stdout.on("data", (chunk: any) => stdout.push(chunk));
    child.stderr.on("data", (chunk: any) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(nodeBuffer.concat(stdout) as any);
      else reject(new Error(`ffmpeg pcm opus transcode failed: ${nodeBuffer.concat(stderr).toString("utf8").slice(0, 500)}`));
    });
    child.stdin.end(nodeBuffer.from(pcm));
  });
}

function resolveFfmpegCommand(command: string): string {
  if (command !== "ffmpeg-static") return command;
  try {
    const ffmpegStatic = require("ffmpeg-static") as string | undefined;
    return ffmpegStatic || "ffmpeg";
  } catch {
    return "ffmpeg";
  }
}

function parseOggOpusPackets(buffer: any): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let offset = 0;
  let pending = nodeBuffer.alloc(0);
  while (offset + 27 <= buffer.length) {
    if (buffer.subarray(offset, offset + 4).toString("ascii") !== "OggS") throw new Error("invalid ogg opus stream");
    const pageSegments = buffer[offset + 26];
    const segmentTableStart = offset + 27;
    const dataStart = segmentTableStart + pageSegments;
    if (dataStart > buffer.length) break;
    const laces = Array.from(buffer.subarray(segmentTableStart, dataStart)) as number[];
    const pageDataLength = laces.reduce((sum, value) => sum + value, 0);
    const pageData = buffer.subarray(dataStart, dataStart + pageDataLength);
    if (dataStart + pageDataLength > buffer.length) break;
    let pageOffset = 0;
    for (const lace of laces) {
      pending = nodeBuffer.concat([pending, pageData.subarray(pageOffset, pageOffset + lace)]);
      pageOffset += lace;
      if (lace < 255) {
        packets.push(new Uint8Array(pending));
        pending = nodeBuffer.alloc(0);
      }
    }
    offset = dataStart + pageDataLength;
  }
  return packets;
}

function isOpusHeaderPacket(packet: Uint8Array): boolean {
  const text = nodeBuffer.from(packet.subarray(0, 8)).toString("ascii");
  return text === "OpusHead" || text === "OpusTags";
}
