import type {
  AsrInboundStreamAcceptResult,
  AsrInboundStreamSession
} from "../../asr/src/index.js";
import type {
  InboundAudioStreamChunkFrame,
  InboundAudioStreamStartFrame
} from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { VoiceSynthesizer } from "../../tts/src/index.js";
import { createCurrentTimeProvider } from "../../../platform/time/src/index.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";

const childProcess = await import("node:child_process");
const crypto = await import("node:crypto");
const dgram = await import("node:dgram");
const moduleApi = await import("node:module");
const nodeBuffer: any = (await import("node:buffer")).Buffer;
const require = moduleApi.createRequire(import.meta.url);
const defaultTestSpeakText = [
  "これは疑似ストリーミング音声のテストです。",
  "最初の文が再生されている間に、次の文を順番に合成します。",
  "途中で割り込みボタンを押すと、残りの文は再生されません。",
  "聞こえ方と停止の反応を確認してください。"
].join("");
const defaultWebRtcInboundPcmAudio = {
  sampleRateHz: 16_000,
  channels: 1,
  encoding: "pcm_s16le",
  chunkMs: 100
} as const;

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
    asrFinalMs?: number;
  };
  ttsTextFilter?: {
    stripParenthesized: boolean;
  };
};

export type ServerAudioFrame = {
  sequence: number;
  pcm: Int16Array;
  sampleRateHz: number;
  channels: number;
  durationMs: number;
  rtpPayload?: Uint8Array;
  rtpTimestamp?: number;
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

export type EncodePcmL16StreamInput = Omit<EncodePcmL16Input, "pcm"> & {
  chunks: AsyncIterable<Uint8Array>;
};

export type WebRtcVoiceTtsStreamEvent =
  | { type: "translation_started"; sequence: number; sourceChars: number }
  | { type: "translation_done"; sequence: number; translatedChars: number }
  | { type: "audio"; sequence: number; text?: string; chunk: Uint8Array; contentType: string }
  | { type: "part_done"; sequence: number }
  | { type: "done" };

export type WebRtcVoiceSynthesizer = VoiceSynthesizer & {
  stream?(input: {
    text: string;
    time: ReturnType<typeof createCurrentTimeProvider>;
    source: "send_chat.voice";
    streamId?: string;
  }): AsyncIterable<WebRtcVoiceTtsStreamEvent>;
};

export type WebRtcVoiceStatusEvent = {
  state: string;
  detail?: string;
};

export type WebRtcVoiceTalkRuntime = {
  openSession?(input: unknown): void | { sessionId?: string | number } | Promise<void | { sessionId?: string | number }>;
  closeSession?(input: unknown): void | Promise<void>;
  ingestInput?(event: { kind: string; [key: string]: unknown }): void | Promise<void>;
  commitStableInputBatch?(batch: {
    sessionId: string;
    batchId: string;
    interruptEpoch: number;
    inputs: Array<{
      interruptId: string;
      sequence: number;
      reason: "barge_in" | "manual" | "asr_failure" | "call_close";
      asrStreamId?: string;
      text: string;
      occurredAt: string;
      occurredAtUtc?: string;
      targetOutputId?: string;
      targetChunkId?: string;
    }>;
  }): void | Promise<void>;
  startAgentLoop?(sessionId: string): void | Promise<void>;
  markOutputChunkPlayed?(input: { sessionId: string; chunkId: string }): void | Promise<void>;
  claimReadyOutputChunk?(sessionId: string): unknown;
  interruptOutput?(input: { sessionId: string; outputId: string; reason: "manual" | "barge_in" | "network" | "unknown"; elapsedMs?: number; totalMs?: number; breakpointContext?: { beforeText?: string; afterText?: string }; omitAssistantMessage?: boolean }): unknown;
  interruptLatestOutput?(input: { sessionId: string; reason: "manual" | "barge_in" | "network" | "unknown"; elapsedMs?: number; totalMs?: number; breakpointContext?: { beforeText?: string; afterText?: string }; omitAssistantMessage?: boolean }): unknown;
};

export type WebRtcVoiceDeps = {
  config: WebRtcVoiceConfig;
  time?: CurrentTimeProvider;
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
  encodePcmL16StreamToFrames?(input: EncodePcmL16StreamInput): AsyncIterable<ServerAudioFrame>;
  talkRuntime?: WebRtcVoiceTalkRuntime;
  testAsr?(): Promise<{ ok: true } | { ok: false; error: string; message?: string }>;
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

type InterruptItem = {
  interruptId: string;
  reason: "barge_in" | "manual" | "asr_failure" | "call_close";
  targetOutputId?: string;
  targetChunkId?: string;
  asrStreamId?: string;
  interruptEpoch: number;
  runtimeInterrupted: boolean;
  stableInputReady: boolean;
  stableInputText?: string;
  sequence: number;
  runtimeInterruptPromise?: Promise<void>;
};

type TtsTask = {
  id: string;
  outputId?: string;
  controller: AbortController;
};

export type PlaybackItem = {
  outputId?: string;
  chunkId?: string;
  originalText?: string;
  speakText?: string;
  textHash: string;
  assetId: string;
  filePath: string;
  status: "queued" | "playing" | "played" | "interrupted" | "cancelled" | "failed";
  createdAt: string;
  framesWritten: number;
  playedMs?: number;
  totalMs?: number;
  interruptEpoch?: number;
  streamingTts?: boolean;
  playbackTextCache?: string;
  ttsAudioTextSpans?: PlaybackAudioTextSpan[];
};

type PlaybackConsumer = {
  outputId?: string;
  chunkId?: string;
  playbackTextCache: string;
  playedMs: number;
  totalMs: number;
};

type PlaybackAudioTextSpan = {
  text: string;
  audio: Uint8Array;
  startMs: number;
  endMs: number;
};

type PlaybackFrame = {
  frame: ServerAudioFrame;
  text?: string;
  textTotalMs?: number;
};

export type WebRtcVoiceCall = {
  callId: string;
  userId: string;
  answerSdp: string;
  talkSessionId: string;
  asrStreamId: string;
  talkRuntimeIngressStatus: "todo" | "connected";
  playbackQueue: PlaybackItem[];
  acceptIceCandidate(candidate: unknown): Promise<void>;
  acceptInboundAudioChunk(bytes: Uint8Array, timing?: InboundAudioStreamChunkFrame["timing"]): Promise<AsrInboundStreamAcceptResult | undefined>;
  acceptTextInput?(text: string): Promise<void>;
  endInboundAudio(): Promise<AsrInboundStreamAcceptResult | undefined>;
  setSpeechActive(active: boolean): Promise<void>;
  playReplyText(text: string, outputId?: string, options?: unknown): Promise<PlaybackResult>;
  interrupt(reason?: "manual" | "barge_in" | "network" | "unknown", targetOutputId?: string): Promise<void>;
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
    | "asr_preflight_failed"
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
      if (deps.testAsr) {
        deps.emitStatus?.({ state: "asr.preflight.started", detail: "checking" });
        const result = await deps.testAsr();
        if (!result.ok) {
          deps.emitStatus?.({ state: "asr.preflight.failed", detail: result.message ?? result.error });
          throw new WebRtcVoiceError("asr_preflight_failed", result.message ?? result.error);
        }
        deps.emitStatus?.({ state: "asr.preflight.ready", detail: "connected" });
      }
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

      return await createCallState(input, answerSdp, peer, outboundTrack, deps);
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
    inboundAudio: { ...defaultWebRtcInboundPcmAudio },
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
      ttsPlaybackStartMs: 10_000,
      asrFinalMs: 8_000
    },
    ttsTextFilter: {
      stripParenthesized: true
    }
  };
}

export async function createWeriftPeer(input: {
  callId: string;
  userId: string;
  iceServers: WebRtcVoiceConfig["iceServers"];
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
  const outboundSsrc = crypto.randomInt(1, 0x7fffffff);
  let outboundTrack: any;
  let outboundSender: any;
  let outboundPacketsWritten = 0;
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
          const timestamp = (frame.rtpTimestamp ?? (frame.sequence * (frame.rtpTimestampIncrement ?? 960))) >>> 0;
          const packet = new werift.RtpPacket(new werift.RtpHeader({
            payloadType: frame.payloadType ?? 111,
            sequenceNumber: sequence,
            timestamp,
            ssrc: outboundSsrc
          }), nodeBuffer.from(frame.rtpPayload));
          outboundTrack.writeRtp(packet);
          outboundPacketsWritten += 1;
          if (outboundPacketsWritten === 1 || outboundPacketsWritten % 50 === 0) {
            input.onStatus?.({ state: "webrtc.outbound_audio.packets_written", detail: String(outboundPacketsWritten) });
          }
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

export async function* encodePcmL16StreamToOpusRtpFrames(input: EncodePcmL16StreamInput & { ffmpegCommand?: string }): AsyncIterable<ServerAudioFrame> {
  const timestampIncrement = Math.round(input.sampleRateHz * input.frameMs / 1000);
  let index = 0;
  for await (const packet of runFfmpegPcmL16StreamToOpusPackets(input.chunks, input.inputSampleRateHz, input.inputChannels, input.ffmpegCommand ?? "ffmpeg-static")) {
    if (isOpusHeaderPacket(packet)) continue;
    yield {
      sequence: index,
      pcm: new Int16Array(),
      sampleRateHz: input.sampleRateHz,
      channels: input.channels,
      durationMs: input.frameMs,
      rtpPayload: packet,
      rtpTimestampIncrement: timestampIncrement,
      payloadType: 111
    };
    index += 1;
  }
}

export function attachWebRtcVoiceSignalingServer(input: {
  server: { on(event: "upgrade", listener: (request: any, socket: any, head: any) => void): unknown };
  plugin: WebRtcVoicePlugin;
  path?: string;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
  onCallCreated?(call: WebRtcVoiceCall): void;
  onClientConnected?(client: { send(message: unknown): void }): void | (() => void);
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
      const cleanupClient = input.onClientConnected?.({ send });
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        cleanupClient?.();
      };
      socket.on("close", cleanup);
      socket.on("end", cleanup);
      socket.on("error", cleanup);
      socket.on("data", async (chunk: any) => {
        try {
          const decoded = readWebSocketTextFrames(nodeBuffer.concat([wsBuffer, chunk]));
          wsBuffer = decoded.rest;
          for (const text of decoded.messages) {
            const message = JSON.parse(text) as { type?: string; sdp?: string; candidate?: unknown; reason?: string; text?: unknown };
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
            } else if (message.type === "hold-to-talk") {
              await call?.setSpeechActive(Boolean((message as { active?: unknown }).active));
            } else if (message.type === "text-input") {
              if (typeof message.text === "string") await call?.acceptTextInput?.(message.text);
            } else if (message.type === "audio-chunk") {
              const data = (message as { data?: unknown }).data;
              if (typeof data === "string") {
                await call?.acceptInboundAudioChunk(new Uint8Array(nodeBuffer.from(data, "base64")));
              }
            } else if (message.type === "speak-test") {
              try {
                const testText = typeof message.text === "string" && message.text.trim() ? message.text.trim() : defaultTestSpeakText;
                await call?.playReplyText(testText, "manual-test");
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                input.appendLog?.("error", `webrtc voice tts failed: ${message}`);
                send({ type: "status", state: "tts.failed", detail: message });
              }
            } else if (message.type === "interrupt") {
              await call?.interrupt("manual");
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

async function createCallState(
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
  const interruptBatch: { items: InterruptItem[] } = { items: [] };
  const activeTtsTasks = new Set<TtsTask>();
  const activePlaybackTasks = new Set<Promise<unknown>>();
  const playbackQueue: PlaybackItem[] = [];
  const playbackConsumer: PlaybackConsumer = {
    playbackTextCache: "",
    playedMs: 0,
    totalMs: 0
  };
  let currentPlayingItem: PlaybackItem | undefined;
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
  };
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
  const createOutboundSilenceFrame = (): ServerAudioFrame => ({
    sequence: 0,
    pcm: new Int16Array(),
    sampleRateHz: deps.config.outboundAudio.sampleRateHz,
    channels: deps.config.outboundAudio.channels,
    durationMs: deps.config.outboundAudio.frameMs,
    rtpPayload: new Uint8Array([0xf8, 0xff, 0xfe]),
    rtpTimestampIncrement: Math.round(deps.config.outboundAudio.sampleRateHz * deps.config.outboundAudio.frameMs / 1000),
    payloadType: 111
  });
  const writeOutboundSilenceFrame = async () => {
    const frame = createOutboundSilenceFrame();
    const written = await outboundTrack.writeFrame(stampOutboundFrame(frame));
    if (written) advanceOutboundRtpClockForFrame(frame);
    return written;
  };
  const restartAsrStream = (reason: string) => {
    asrStreamIndex += 1;
    asrStreamId = `asr-${input.callId}-${asrStreamIndex}`;
    inboundSequence = 0;
    asrSession = createCallAsrSession(input, talkSessionId, asrStreamId, deps);
    deps.emitStatus?.({ state: "asr.stream.restarted", detail: `${asrStreamId}:${reason}` });
  };
  const playbackGateOpen = () => interruptBatch.items.length === 0;
  const commitStableInputsIfReady = async () => {
    if (interruptBatch.items.length === 0) return;
    if (!interruptBatch.items.every((item) => item.stableInputReady)) return;
    const batchId = `stable:${input.callId}:${interruptEpoch}:${Date.now()}`;
    const items = [...interruptBatch.items].sort((a, b) => a.sequence - b.sequence);
    try {
      await Promise.all(items.map((item) => item.runtimeInterruptPromise).filter((promise): promise is Promise<void> => Boolean(promise)));
      if (playbackGateOpen()) throw new Error("voice call transaction assert failed: playback gate open");
      if (playbackQueue.some((item) => item.status === "queued" || item.status === "playing")) {
        throw new Error("voice call transaction assert failed: playable queue not cleared");
      }
      if (deps.talkRuntime?.commitStableInputBatch) {
        await deps.talkRuntime.commitStableInputBatch({
          sessionId: talkSessionId,
          batchId,
          interruptEpoch,
          inputs: items.map((item) => {
            const stamp = nowStamp();
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
        deps.emitStatus?.({ state: "talk_runtime.stable_batch", detail: `${batchId}:${items.length}` });
      } else {
        for (const item of items) {
          deps.emitStatus?.({ state: "talk_runtime.ingress.todo", detail: `audio.transcript.final: ${item.stableInputText ?? "-杂音-"}` });
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      deps.emitStatus?.({ state: "talk_runtime.stable_batch.failed", detail: `${batchId}:${detail}` });
    } finally {
      interruptBatch.items.length = 0;
    }
  };
  const markStableInput = async (text: string, reason: InterruptItem["reason"], streamId?: string) => {
    const target = streamId
      ? interruptBatch.items.find((item) => item.asrStreamId === streamId && !item.stableInputReady)
      : interruptBatch.items.find((item) => !item.stableInputReady);
    if (!target) {
      const stamp = nowStamp();
      if (deps.talkRuntime?.ingestInput) {
        await deps.talkRuntime.ingestInput({
          kind: reason === "manual" ? "text.final" : "audio.transcript.final",
          sessionId: talkSessionId,
          source,
          sequence: stableSequence++,
          occurredAt: stamp.occurredAt,
          occurredAtUtc: stamp.occurredAtUtc,
          payload: { kind: reason === "manual" ? "text" : "transcript", text }
        });
        deps.emitStatus?.({ state: "talk_runtime.ingress", detail: `${reason === "manual" ? "text.final" : "audio.transcript.final"}: ${text}` });
      } else {
        deps.emitStatus?.({ state: "talk_runtime.ingress.todo", detail: `audio.transcript.final: ${text}` });
      }
      return;
    }
    target.reason = reason;
    target.stableInputText = text;
    target.stableInputReady = true;
    await commitStableInputsIfReady();
  };
  const abortActiveTtsTasks = (reason: string) => {
    for (const task of activeTtsTasks) {
      task.controller.abort(new Error(reason));
    }
  };
  const normalizePlaybackTextCache = (text: string | undefined): string | undefined => {
    const value = text?.trim();
    if (!value) return undefined;
    if (["none", "null", "undefined", "nil"].includes(value.toLowerCase())) return undefined;
    return value;
  };
  const updatePlaybackTextCache = (item: PlaybackItem, text: string | undefined, durationMs: number) => {
    const value = normalizePlaybackTextCache(text);
    if (!value || durationMs <= 0 || (item.totalMs ?? 0) <= 0 || item.playbackTextCache === value) return;
    item.playbackTextCache = value;
  };
  const updatePlaybackConsumer = (item: PlaybackItem, text: string | undefined, totalMs: number, options?: { emit?: boolean }) => {
    const value = normalizePlaybackTextCache(text);
    if (!value || totalMs <= 0) return;
    if (
      playbackConsumer.outputId === item.outputId
      && playbackConsumer.chunkId === item.chunkId
      && playbackConsumer.playbackTextCache === value
    ) {
      playbackConsumer.totalMs = Math.max(playbackConsumer.totalMs, totalMs);
      if (options?.emit && playbackConsumer.playedMs === 0) {
        deps.emitStatus?.({
          state: "tts.playback.consumer",
          detail: `前文=${value} 时长=${playbackConsumer.totalMs}ms`
        });
      }
      return;
    }
    playbackConsumer.outputId = item.outputId;
    playbackConsumer.chunkId = item.chunkId;
    playbackConsumer.playbackTextCache = value;
    playbackConsumer.playedMs = 0;
    playbackConsumer.totalMs = totalMs;
    if (options?.emit) {
      deps.emitStatus?.({
        state: "tts.playback.consumer",
        detail: `前文=${value} 时长=${totalMs}ms`
      });
    }
  };
  const advancePlaybackConsumer = (item: PlaybackItem, durationMs: number) => {
    if (durationMs <= 0) return;
    if (playbackConsumer.outputId !== item.outputId || playbackConsumer.chunkId !== item.chunkId) return;
    playbackConsumer.playedMs = Math.max(0, Math.min(playbackConsumer.totalMs, playbackConsumer.playedMs + durationMs));
  };
  const recordTtsAudioTextSpan = (item: PlaybackItem, text: string | undefined, audio: Uint8Array) => {
    const value = normalizePlaybackTextCache(text);
    if (!value || audio.byteLength <= 0) return;
    const startMs = item.ttsAudioTextSpans?.at(-1)?.endMs ?? 0;
    const durationMs = Math.max(0, (audio.byteLength / 2 / 32_000) * 1000);
    if (durationMs <= 0) return;
    const endMs = startMs + durationMs;
    item.ttsAudioTextSpans ??= [];
    item.ttsAudioTextSpans.push({ text: value, audio, startMs, endMs });
    item.totalMs = Math.max(item.totalMs ?? 0, endMs);
    updatePlaybackTextCache(item, value, durationMs);
  };
  const breakpointFromPlaybackConsumer = (): { breakpointContext?: { beforeText?: string; afterText?: string } } => {
    const text = playbackConsumer.playbackTextCache.trim();
    if (!text || playbackConsumer.totalMs <= 0) return {};
    const totalMs = playbackConsumer.totalMs;
    const chars = Array.from(text);
    const playedRatio = Math.max(0, Math.min(1, playbackConsumer.playedMs / totalMs));
    const localIndex = Math.max(0, Math.min(chars.length, Math.round(chars.length * playedRatio)));
    return {
      breakpointContext: {
        beforeText: chars.slice(0, localIndex).join("") || undefined,
        afterText: chars.slice(localIndex).join("") || undefined
      }
    };
  };
  const runInterrupt = async (reason: InterruptItem["reason"], explicitTargetOutputId?: string) => {
    interruptEpoch += 1;
    playbackGeneration += 1;
    abortActiveTtsTasks(`voice_call_interrupt:${reason}`);
    const targetOutputId = playbackConsumer.outputId ?? explicitTargetOutputId;
    const targetChunkId = playbackConsumer.outputId ? playbackConsumer.chunkId : undefined;
    const interruptId = `interrupt:${input.callId}:${interruptEpoch}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const item: InterruptItem = {
      interruptId,
      reason,
      targetOutputId,
      targetChunkId,
      asrStreamId,
      interruptEpoch,
      runtimeInterrupted: false,
      stableInputReady: false,
      sequence: stableSequence++
    };
    interruptBatch.items.push(item);
    for (const queued of playbackQueue) queued.status = queued.outputId === targetOutputId ? "interrupted" : "cancelled";
    currentPlayingItem = undefined;
    playbackQueue.length = 0;
    const elapsedMs = playbackConsumer.playedMs;
    const totalMs = playbackConsumer.totalMs;
    const breakpoint = breakpointFromPlaybackConsumer();
    const beforeText = breakpoint.breakpointContext?.beforeText ?? "";
    const afterText = breakpoint.breakpointContext?.afterText ?? "";
    deps.emitStatus?.({
      state: "talk_runtime.interrupt.breakpoint",
      detail: `前文=${beforeText} 后文=${afterText}`
    });
    try {
      let runtimeInterrupt: unknown;
      if (deps.talkRuntime && item.targetOutputId) {
        runtimeInterrupt = deps.talkRuntime.interruptOutput?.({
          sessionId: talkSessionId,
          outputId: item.targetOutputId,
          reason: reason === "call_close" || reason === "asr_failure" ? "network" : reason,
          elapsedMs,
          totalMs,
          breakpointContext: breakpoint.breakpointContext,
          omitAssistantMessage: !playbackConsumer.playbackTextCache
        });
        deps.emitStatus?.({ state: "talk_runtime.interrupt", detail: `${reason}:${item.targetOutputId}` });
      } else if (deps.talkRuntime) {
        runtimeInterrupt = deps.talkRuntime.interruptLatestOutput?.({
          sessionId: talkSessionId,
          reason: reason === "call_close" || reason === "asr_failure" ? "network" : reason,
          breakpointContext: breakpoint.breakpointContext,
          omitAssistantMessage: reason !== "manual"
        });
        deps.emitStatus?.({ state: "talk_runtime.interrupt_latest", detail: reason });
      } else {
        deps.emitStatus?.({ state: "talk_runtime.interrupt.todo", detail: `${reason}:${item.targetOutputId ?? ""}` });
      }
      item.runtimeInterruptPromise = Promise.resolve(runtimeInterrupt).then(() => {
        item.runtimeInterrupted = true;
      });
      await item.runtimeInterruptPromise;
    } catch (error) {
      deps.emitStatus?.({ state: "talk_runtime.interrupt.failed", detail: error instanceof Error ? error.message : String(error) });
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
  const runOutputPump = async () => {
    while (!closed) {
      const raw = deps.talkRuntime?.claimReadyOutputChunk?.(talkSessionId);
      const chunk = normalizeTalkChunk(raw);
      if (!chunk) {
        await sleep(25);
        continue;
      }
      let ttsStreamSettled = false;
      let resolveTtsStreamSettled!: () => void;
      const ttsStreamSettledPromise = new Promise<void>((resolve) => {
        resolveTtsStreamSettled = () => {
          if (ttsStreamSettled) return;
          ttsStreamSettled = true;
          resolve();
        };
      });
      const playback = call.playReplyText(chunk.text, chunk.outputId, {
        chunkId: chunk.chunkId,
        originalText: chunk.text,
        beforeFirstPlayback: async () => {
          await deps.sleep?.(1000);
        },
        onTtsStreamSettled: resolveTtsStreamSettled
      });
      void deps.talkRuntime?.startAgentLoop?.(talkSessionId);
      void playback.then(async (result) => {
        resolveTtsStreamSettled();
        if (result.status === "played") await deps.talkRuntime?.markOutputChunkPlayed?.({ sessionId: talkSessionId, chunkId: chunk.chunkId });
      }).catch((error) => {
        resolveTtsStreamSettled();
        deps.emitStatus?.({ state: "voice_call.output_pump.playback_failed", detail: error instanceof Error ? error.message : String(error) });
      });
      await ttsStreamSettledPromise;
    }
  };
  const waitForPlaybackTurn = async (item: PlaybackItem) => {
    while (
      !closed
      && playbackQueue.includes(item)
      && (!playbackGateOpen() || playbackQueue[0] !== item || (currentPlayingItem && currentPlayingItem !== item))
    ) {
      await sleep(5);
    }
    if (closed || !playbackQueue.includes(item) || playbackQueue[0] !== item || !playbackGateOpen()) return false;
    currentPlayingItem = item;
    item.status = "playing";
    item.playedMs = 0;
    return true;
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
        await runInterrupt("asr_failure");
        restartAsrStream(result.error);
      }
      return result;
    },
    async acceptTextInput(text) {
      if (closed) return;
      const stableText = normalizeTypedInputText(text) || "-已撤回-";
      if (stableText === "-已撤回-" && interruptBatch.items.length === 0) return;
      if (stableText !== "-已撤回-" && playbackQueue.some((item) => item.status === "playing" || item.status === "queued")) {
        await runInterrupt("manual");
      }
      await markStableInput(stableText, "manual");
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
      if (result.ok && result.type === "final" && deps.talkRuntime && interruptBatch.items.length === 0) {
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
      } else if (result.ok && result.type === "final" && interruptBatch.items.length > 0) {
        await markStableInput(result.result.text, "barge_in", result.streamId);
      } else if (!result.ok) {
        if (interruptBatch.items.length > 0) await markStableInput("-杂音-", "asr_failure", result.streamId);
        else await runInterrupt("asr_failure");
      }
      if (!result.ok && !isRecoverableAsrError(result.error)) return result;
      return result;
    },
    async setSpeechActive(active) {
      if (closed || speechActive === active) return;
      speechActive = active;
      deps.emitStatus?.({ state: active ? "push_to_talk.active" : "push_to_talk.released", detail: active ? "pressed" : "released" });
      if (active && deps.config.bargeIn.enabled) {
        deps.emitStatus?.({ state: "tts.barge_in", detail: playbackConsumer.outputId ?? "" });
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
      const speakText = deps.config.ttsTextFilter?.stripParenthesized ? stripParenthesizedText(text) : text;
      const createdAt = (deps.now?.() ?? new Date()).toISOString();
      const generation = playbackGeneration;
      let frameCount = 0;
      const item: PlaybackItem = {
        outputId,
        chunkId: playbackOptionString(options, "chunkId"),
        originalText: playbackOptionString(options, "originalText") ?? text,
        speakText,
        textHash: hashText(speakText),
        assetId: "",
        filePath: "",
        status: "queued",
        createdAt,
        framesWritten: 0,
        playedMs: 0,
        totalMs: 0,
        interruptEpoch,
        streamingTts: Boolean(deps.voiceSynthesizer.stream),
        ttsAudioTextSpans: []
      };
      playbackQueue.push(item);
      const ttsTask: TtsTask = {
        id: `tts:${input.callId}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
        outputId,
        controller: new AbortController()
      };
      activeTtsTasks.add(ttsTask);
      try {
      let ttsStreamSettledNotified = false;
      let lastPlayingText = "";
      const emitPlayingText = (value: string | undefined) => {
        const playingText = value?.trim();
        if (!playingText || playingText === lastPlayingText) return;
        lastPlayingText = playingText;
        deps.emitStatus?.({ state: "tts.playing_text", detail: playingText });
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
      let missingPlayingTextReported = false;
      const reportMissingPlayingText = (frameIndex: number) => {
        if (missingPlayingTextReported) return;
        missingPlayingTextReported = true;
        deps.emitStatus?.({
          state: "tts.playing_text.missing",
          detail: `output=${outputId ?? ""} frame=${frameIndex} spans=${item.ttsAudioTextSpans?.length ?? 0}`
        });
      };
      const notifyTtsStreamSettled = async () => {
        if (ttsStreamSettledNotified) return;
        ttsStreamSettledNotified = true;
        try {
          await playbackOptionCallback(options, "onTtsStreamSettled")?.();
        } catch (error) {
          deps.emitStatus?.({ state: "tts.stream.settled_callback_failed", detail: error instanceof Error ? error.message : String(error) });
        }
      };
      let ready: boolean | undefined;
      try {
        ready = await raceWithAbort(Promise.resolve(outboundTrack.waitUntilReady?.(deps.config.timeouts.ttsPlaybackStartMs)), ttsTask.controller.signal);
      } catch (error) {
        if (ttsTask.controller.signal.aborted) {
          item.status = "interrupted";
          return { status: "interrupted", outputId, frameCount: 0 };
        }
        throw error;
      }
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
      if (deps.voiceSynthesizer.stream && (deps.encodePcmL16StreamToFrames || deps.encodePcmL16ToFrames)) {
        deps.emitStatus?.({ state: "tts.stream.started", detail: outputId });
        const ttsEvents = deps.voiceSynthesizer.stream({
          text: speakText,
          time: synthesisTime,
          source: "send_chat.voice",
          streamId: outputId
        });
        if (deps.encodePcmL16StreamToFrames) {
          let audioChunks = 0;
          let audioBytes = 0;
          let encodedFrames = 0;
          const pcmChunks = async function* () {
            for await (const event of abortableAsyncIterable(ttsEvents, ttsTask.controller.signal)) {
              if (ttsTask.controller.signal.aborted || generation !== playbackGeneration || !playbackQueue.includes(item)) break;
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
              audioChunks += 1;
              audioBytes += event.chunk.byteLength;
              recordTtsAudioTextSpan(item, event.text, event.chunk);
              if (audioChunks === 1 || audioChunks % 20 === 0) {
                deps.emitStatus?.({ state: "tts.stream.audio_chunk", detail: `${audioChunks}:${audioBytes}` });
              }
              yield event.chunk;
            }
          };
          const frameQueue = createAsyncQueue<PlaybackFrame>();
          const producer = (async () => {
            try {
              let encodedMs = 0;
              for await (const frame of deps.encodePcmL16StreamToFrames!({
                chunks: pcmChunks(),
                inputSampleRateHz: 32_000,
                inputChannels: 1,
                sampleRateHz: deps.config.outboundAudio.sampleRateHz,
                channels: deps.config.outboundAudio.channels,
                frameMs: deps.config.outboundAudio.frameMs
              })) {
                encodedFrames += 1;
                frameQueue.push({ frame, text: playbackTextAt(item, encodedMs), textTotalMs: playbackTextTotalMsAt(item, encodedMs) });
                encodedMs += frame.durationMs;
                item.totalMs = Math.max(item.totalMs ?? 0, encodedMs);
              }
              frameQueue.close();
              deps.emitStatus?.({ state: "tts.queue.producer_done", detail: `chunks=${audioChunks} encoded=${encodedFrames} queued=${frameQueue.length}` });
            } catch (error) {
              frameQueue.fail(error);
            } finally {
              await notifyTtsStreamSettled();
            }
          })();
          const minBufferedFrames = Math.max(20, Math.ceil(1200 / deps.config.outboundAudio.frameMs));
          deps.emitStatus?.({ state: "tts.queue.waiting", detail: `min=${minBufferedFrames} queued=${frameQueue.length}` });
          await frameQueue.waitFor(() => frameQueue.length >= minBufferedFrames || frameQueue.closed);
          deps.emitStatus?.({ state: "tts.queue.ready", detail: `queued=${frameQueue.length} closed=${frameQueue.closed ? "true" : "false"}` });
          if (!await waitForPlaybackTurn(item)) {
            item.status = "interrupted";
            return { status: "interrupted", outputId, frameCount: 0 };
          }
          let playbackStartedAt = deps.now?.().getTime() ?? Date.now();
          let playbackFrameCount = 0;
          let firstPlayback = true;
          const consumePlaybackFrame = async (playbackFrame: PlaybackFrame) => {
            const { frame, text: frameText, textTotalMs } = playbackFrame;
            if (firstPlayback) {
              updatePlaybackConsumer(item, frameText, Math.max(textTotalMs ?? 0, item.totalMs ?? 0));
              await playbackOptionCallback(options, "beforeFirstPlayback")?.();
              deps.emitStatus?.({ state: "voice_call.connected", detail: talkSessionId });
              playbackStartedAt = deps.now?.().getTime() ?? Date.now();
              firstPlayback = false;
            }
            const written = await outboundTrack.writeFrame(stampOutboundFrame(frame));
            if (written) {
              advanceOutboundRtpClockForFrame(frame);
              updatePlaybackConsumer(item, frameText, Math.max(textTotalMs ?? 0, item.totalMs ?? 0), { emit: true });
              if (frameText) emitPlayingText(frameText);
              else reportMissingPlayingText(frameCount + 1);
              frameCount += 1;
              playbackFrameCount += 1;
              item.framesWritten = frameCount;
              item.playedMs = (item.playedMs ?? 0) + frame.durationMs;
              item.totalMs = Math.max(item.totalMs ?? 0, (item.framesWritten ?? 0) * frame.durationMs);
              advancePlaybackConsumer(item, frame.durationMs);
            }
            const targetAt = playbackStartedAt + playbackFrameCount * frame.durationMs;
            const delayMs = targetAt - (deps.now?.().getTime() ?? Date.now());
            if (delayMs > 0) await (deps.sleep ?? sleep)(delayMs);
          };
          while (!ttsTask.controller.signal.aborted && generation === playbackGeneration && playbackQueue.includes(item)) {
            let playbackFrame = frameQueue.shift();
            if (!playbackFrame) {
              if (frameQueue.closed) break;
              deps.emitStatus?.({ state: "tts.queue.underrun", detail: `sent=${frameCount} encoded=${encodedFrames} chunks=${audioChunks}` });
              let silenceFrames = 0;
              while (!ttsTask.controller.signal.aborted && generation === playbackGeneration && playbackQueue.includes(item) && !frameQueue.closed) {
                await Promise.resolve();
                playbackFrame = frameQueue.shift();
                if (playbackFrame) break;
                const nextFrameAt = playbackStartedAt + playbackFrameCount * deps.config.outboundAudio.frameMs;
                const remainingMs = nextFrameAt - (deps.now?.().getTime() ?? Date.now());
                if (remainingMs >= 20) {
                  await Promise.race([
                    (deps.sleep ?? sleep)(remainingMs - 19),
                    frameQueue.waitFor(() => frameQueue.length > 0 || frameQueue.closed)
                  ]);
                  continue;
                }
                const written = await writeOutboundSilenceFrame();
                if (written) {
                  playbackFrameCount += 1;
                  silenceFrames += 1;
                  if (silenceFrames === 1 || silenceFrames % 50 === 0) {
                    deps.emitStatus?.({ state: "tts.queue.silence", detail: `silence=${silenceFrames} sent=${frameCount} encoded=${encodedFrames} chunks=${audioChunks}` });
                  }
                }
              }
              if (!playbackFrame) continue;
              deps.emitStatus?.({ state: "tts.queue.resumed", detail: `queued=${frameQueue.length} sent=${frameCount} silence=${silenceFrames}` });
            }
            await consumePlaybackFrame(playbackFrame);
          }
          await producer;
        } else if (deps.encodePcmL16ToFrames) {
          if (!await waitForPlaybackTurn(item)) {
            item.status = "interrupted";
            return { status: "interrupted", outputId, frameCount: 0 };
          }
          await playbackOptionCallback(options, "beforeFirstPlayback")?.();
          deps.emitStatus?.({ state: "voice_call.connected", detail: talkSessionId });
          try {
          for await (const event of abortableAsyncIterable(ttsEvents, ttsTask.controller.signal)) {
            if (ttsTask.controller.signal.aborted || generation !== playbackGeneration || !playbackQueue.includes(item)) break;
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
            recordTtsAudioTextSpan(item, event.text, event.chunk);
            const frames = await raceWithAbort(Promise.resolve(deps.encodePcmL16ToFrames({
              pcm: event.chunk,
              inputSampleRateHz: 32_000,
              inputChannels: 1,
              sampleRateHz: deps.config.outboundAudio.sampleRateHz,
              channels: deps.config.outboundAudio.channels,
              frameMs: deps.config.outboundAudio.frameMs
            })), ttsTask.controller.signal);
            const eventTotalMs = frames.reduce((sum, frame) => sum + frame.durationMs, 0);
            for (const frame of frames) {
              if (ttsTask.controller.signal.aborted || generation !== playbackGeneration || !playbackQueue.includes(item)) break;
              const written = await outboundTrack.writeFrame(stampOutboundFrame(frame));
              if (written) {
                advanceOutboundRtpClockForFrame(frame);
                updatePlaybackConsumer(item, event.text, eventTotalMs, { emit: true });
                if (event.text) emitPlayingText(event.text);
                else reportMissingPlayingText(frameCount + 1);
                frameCount += 1;
              item.framesWritten = frameCount;
              item.playedMs = (item.playedMs ?? 0) + frame.durationMs;
              item.totalMs = Math.max(item.totalMs ?? 0, (item.framesWritten ?? 0) * frame.durationMs);
              advancePlaybackConsumer(item, frame.durationMs);
              }
              await (deps.sleep ?? sleep)(frame.durationMs);
            }
            deps.emitStatus?.({ state: "tts.stream.frames_sent", detail: `sent=${frameCount}` });
          }
          } finally {
            await notifyTtsStreamSettled();
          }
        }
        const interrupted = ttsTask.controller.signal.aborted || generation !== playbackGeneration || !playbackQueue.includes(item);
        item.status = interrupted ? "interrupted" : frameCount > 0 ? "played" : "failed";
        if (currentPlayingItem === item) currentPlayingItem = undefined;
        playbackQueue.shift();
        deps.emitStatus?.({ state: interrupted ? "tts.interrupted" : frameCount > 0 ? "tts.played" : "tts.failed", detail: frameCount > 0 ? outputId : "no_frames_sent" });
        return {
          status: interrupted || frameCount === 0 ? "interrupted" : "played",
          outputId,
          frameCount
        };
      }
      const parts = splitTtsPseudoStreamParts(speakText);
      const synthesizePart = async (part: string, partIndex: number) => {
        deps.emitStatus?.({ state: "tts.part.synthesizing", detail: `${partIndex + 1}/${parts.length}` });
        let voice;
        try {
          voice = await raceWithAbort(Promise.resolve(deps.voiceSynthesizer({ text: part, time: synthesisTime })), ttsTask.controller.signal);
        } catch (error) {
          if (ttsTask.controller.signal.aborted) return undefined;
          item.status = "failed";
          throw new WebRtcVoiceError("tts_failed", error instanceof Error ? error.message : String(error));
        }
        deps.emitStatus?.({ state: "tts.part.synthesized", detail: `${partIndex + 1}/${parts.length}` });
        try {
          return {
            voice,
            frames: await raceWithAbort(Promise.resolve(deps.decodeAudioFileToFrames({
              filePath: voice.filePath,
              sampleRateHz: deps.config.outboundAudio.sampleRateHz,
              channels: deps.config.outboundAudio.channels,
              frameMs: deps.config.outboundAudio.frameMs
            })), ttsTask.controller.signal)
          };
        } catch (error) {
          if (ttsTask.controller.signal.aborted) return undefined;
          item.status = "failed";
          throw error;
        }
      };
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        if (ttsTask.controller.signal.aborted || generation !== playbackGeneration || !playbackQueue.includes(item)) break;
        const prepared = await synthesizePart(parts[partIndex]!, partIndex);
        if (!prepared) break;
        item.totalMs = prepared.frames.reduce((sum, frame) => sum + frame.durationMs, 0);
        updatePlaybackTextCache(item, parts[partIndex]!, item.totalMs);
        if (!await waitForPlaybackTurn(item)) break;
        updatePlaybackConsumer(item, parts[partIndex], item.totalMs);
        if (frameCount === 0) await playbackOptionCallback(options, "beforeFirstPlayback")?.();
        deps.emitStatus?.({ state: "voice_call.connected", detail: talkSessionId });
        deps.emitStatus?.({ state: "tts.part.playing", detail: `${partIndex + 1}/${parts.length}` });
        emitPlayingText(parts[partIndex]);
        updatePlaybackConsumer(item, parts[partIndex], item.totalMs, { emit: true });
        item.assetId = prepared.voice.assetId;
        item.filePath = prepared.voice.filePath;
        for (const frame of prepared.frames) {
          if (ttsTask.controller.signal.aborted || generation !== playbackGeneration || !playbackQueue.includes(item)) break;
          const written = await outboundTrack.writeFrame(stampOutboundFrame(frame));
          if (written) {
            advanceOutboundRtpClockForFrame(frame);
            frameCount += 1;
            item.framesWritten = frameCount;
            item.playedMs = (item.playedMs ?? 0) + frame.durationMs;
            item.totalMs = Math.max(item.totalMs ?? 0, (item.framesWritten ?? 0) * frame.durationMs);
            advancePlaybackConsumer(item, frame.durationMs);
          }
          await (deps.sleep ?? sleep)(frame.durationMs);
        }
        deps.emitStatus?.({ state: "tts.part.frames_sent", detail: `${partIndex + 1}/${parts.length}:${frameCount}` });
      }
      const interrupted = ttsTask.controller.signal.aborted || generation !== playbackGeneration || !playbackQueue.includes(item);
      item.status = interrupted ? "interrupted" : frameCount > 0 ? "played" : "failed";
      if (currentPlayingItem === item) currentPlayingItem = undefined;
      playbackQueue.shift();
      deps.emitStatus?.({ state: interrupted ? "tts.interrupted" : frameCount > 0 ? "tts.played" : "tts.failed", detail: frameCount > 0 ? outputId : "no_frames_sent" });
      return {
        status: interrupted || frameCount === 0 ? "interrupted" : "played",
        outputId,
        frameCount
      };
      } catch (error) {
        item.status = ttsTask.controller.signal.aborted ? "interrupted" : "failed";
        if (currentPlayingItem === item) currentPlayingItem = undefined;
        const queueIndex = playbackQueue.indexOf(item);
        if (queueIndex >= 0) playbackQueue.splice(queueIndex, 1);
        throw error;
      } finally {
        activeTtsTasks.delete(ttsTask);
        ttsTask.controller.abort(new Error("tts_task_finished"));
      }
    },
    async interrupt(reason = "manual", targetOutputId) {
      await runInterrupt(reason === "network" || reason === "unknown" ? "manual" : reason, targetOutputId);
    },
    async close(reason = "closed") {
      if (closed) return;
      closed = true;
      await runInterrupt("call_close");
      await commitStableInputsIfReady();
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
  chunkId: string;
  text: string;
  startCharIndex: number;
  endCharIndex: number;
} | undefined {
  if (!value || typeof value !== "object") return undefined;
  const chunk = value as Record<string, unknown>;
  if (typeof chunk.outputId !== "string" || typeof chunk.chunkId !== "string" || typeof chunk.text !== "string") return undefined;
  return {
    sessionId: typeof chunk.sessionId === "string" ? chunk.sessionId : "",
    outputId: chunk.outputId,
    chunkId: chunk.chunkId,
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
    textarea { font: inherit; }
    #status, #finalTranscript { margin-top: 16px; white-space: pre-wrap; font-family: ui-monospace, monospace; }
    #partialTranscript { min-height: 28px; margin-top: 12px; padding: 8px; border: 1px solid #bbb; }
    #finalTranscript { min-height: 64px; padding: 8px; border: 1px solid #bbb; }
    #typedInterruptInput { display: block; width: 100%; min-height: 72px; box-sizing: border-box; margin-top: 8px; padding: 8px; }
    .label { margin-top: 12px; font-size: 12px; color: #555; }
    .error { color: #b00020; }
  </style>
</head>
<body>
  <main>
    <button id="callButton" type="button">Call</button>
    <button id="talkButton" type="button" disabled>Hold to talk</button>
    <button id="testSpeakButton" type="button">Test voice</button>
    <button id="interruptButton" type="button">Interrupt voice</button>
    <button id="hangupButton" type="button">Hang up</button>
    <div class="label">Typed interrupt input</div>
    <textarea id="typedInterruptInput" rows="3" placeholder="Type more than 1 character to interrupt; press Enter to submit."></textarea>
    <textarea id="testSpeakText" rows="5" style="display:block; width:100%; box-sizing:border-box; margin:12px 0; font-family:ui-monospace, monospace;">${escapeHtml(defaultTestSpeakText)}</textarea>
    <audio id="remoteAudio" autoplay playsinline controls></audio>
    <div id="assistantOutputText" hidden data-event="tts.output_text"></div>
    <div id="userInputText" hidden data-event="audio.transcript.final"></div>
    <div class="label">Current transcript</div>
    <div id="partialTranscript"></div>
    <div class="label">Final transcripts</div>
    <div id="finalTranscript"></div>
    <div id="status"></div>
  </main>
  <script type="module">
    const signalingPath = ${JSON.stringify(signalingPath)};
    const inboundAudio = ${JSON.stringify(config.inboundAudio)};
    const remoteAudio = document.getElementById("remoteAudio");
    remoteAudio.autoplay = true;
    remoteAudio.muted = false;
    remoteAudio.volume = 1;
    const status = document.getElementById("status");
    const partialTranscript = document.getElementById("partialTranscript");
    const finalTranscript = document.getElementById("finalTranscript");
    const talkButton = document.getElementById("talkButton");
    const testSpeakText = document.getElementById("testSpeakText");
    const typedInterruptInput = document.getElementById("typedInterruptInput");
    let peer;
    let socket;
    let localStream;
    let speechActive = false;
    let pcmSource;
    let pcmProcessor;
    let pendingRemoteIce = [];
    let typedInputInterruptSent = false;
    function log(line, error = false) {
      const prefix = new Date().toLocaleTimeString();
      status.textContent += "[" + prefix + "] " + line + "\\n";
      status.className = error ? "error" : "";
    }
    function updateTranscript(message) {
      if (message.type !== "status") return;
      if (message.state === "tts.playback.consumer") {
        const detail = String(message.detail || "");
        const match = detail.match(/^前文=(.*) 时长=[^ ]+$/);
        const playbackTextCache = (match ? match[1] : detail).trim();
        if (!playbackTextCache) return;
        document.getElementById("assistantOutputText").textContent = playbackTextCache;
        partialTranscript.textContent = playbackTextCache;
        return;
      }
      if (message.state !== "talk_runtime.ingress.todo") return;
      const prefix = "audio.transcript.final: ";
      const detail = String(message.detail || "");
      if (!detail.startsWith(prefix)) return;
      const text = detail.slice(prefix.length).trim();
      if (!text) return;
      const time = new Date().toLocaleTimeString();
      finalTranscript.textContent += "[" + time + "] " + text + "\\n";
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
        localStream = await navigator.mediaDevices.getUserMedia({
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
          log("audio processing requested: noiseSuppression=true echoCancellation=true autoGainControl=true; actual sampleRate=" + (settings.sampleRate || "unknown") + "; asr target=" + inboundAudio.encoding + "/" + inboundAudio.sampleRateHz + "Hz/" + inboundAudio.channels + "ch");
        }
        startPcmStreaming(localStream);
        peer = new RTCPeerConnection({ iceServers: ${JSON.stringify(config.iceServers)} });
        peer.addTransceiver("audio", { direction: "recvonly" });
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
          log("signaling connected; creating offer");
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          socket.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));
        });
        socket.addEventListener("message", async (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "answer") {
            await peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
            log("answer applied");
            talkButton.disabled = false;
            for (const candidate of pendingRemoteIce.splice(0)) {
              await peer.addIceCandidate(candidate).catch((error) => log("queued ice failed: " + error.message, true));
            }
          }
          if (message.type === "ice") {
            if (peer.remoteDescription) await peer.addIceCandidate(message.candidate).catch((error) => log("ice failed: " + error.message, true));
            else pendingRemoteIce.push(message.candidate);
          }
          if (message.type === "status") {
            updateTranscript(message);
            log(message.state + (message.detail ? ": " + message.detail : ""));
          }
          if (message.type === "error") log(message.error + (message.message ? ": " + message.message : ""), true);
        });
        socket.addEventListener("error", () => log("signaling websocket error", true));
        socket.addEventListener("close", () => {
          stopTalking();
          talkButton.disabled = true;
          log("signaling closed");
        });
        peer.addEventListener("icecandidate", (event) => {
          if (event.candidate) socket?.send(JSON.stringify({ type: "ice", candidate: event.candidate }));
        });
      } catch (error) {
        log(error && error.message ? error.message : String(error), true);
      }
    });
    talkButton.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      startTalking();
    });
    talkButton.addEventListener("pointerup", (event) => {
      event.preventDefault();
      stopTalking();
    });
    talkButton.addEventListener("pointerleave", () => stopTalking());
    talkButton.addEventListener("pointercancel", () => stopTalking());
    talkButton.addEventListener("keydown", (event) => {
      if (event.code !== "Space" && event.code !== "Enter") return;
      if (event.repeat) return;
      event.preventDefault();
      startTalking();
    });
    talkButton.addEventListener("keyup", (event) => {
      if (event.code !== "Space" && event.code !== "Enter") return;
      event.preventDefault();
      stopTalking();
    });
    document.getElementById("hangupButton").addEventListener("click", () => {
      stopTalking();
      talkButton.disabled = true;
      socket?.send(JSON.stringify({ type: "hangup", reason: "manual" }));
      peer?.close();
      for (const track of localStream?.getTracks?.() || []) track.stop();
    });
    document.getElementById("testSpeakButton").addEventListener("click", () => {
      void remoteAudio.play().catch((error) => log("audio play failed before test voice: " + error.message, true));
      log("test voice requested; socket=" + (socket ? socket.readyState : "none") + " remoteAudio paused=" + remoteAudio.paused + " muted=" + remoteAudio.muted + " readyState=" + remoteAudio.readyState);
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        log("test voice not sent; signaling is not open", true);
        return;
      }
      socket.send(JSON.stringify({ type: "speak-test", text: testSpeakText.value }));
    });
    document.getElementById("interruptButton").addEventListener("click", () => {
      log("interrupt requested");
      socket?.send(JSON.stringify({ type: "interrupt" }));
    });
    function commitTypedFinalText(text) {
      const payloadText = normalizeTypedInputText(text) || "-已撤回-";
      socket?.send(JSON.stringify({ type: "text-input", text: payloadText }));
      document.getElementById("userInputText").textContent = payloadText;
      const time = new Date().toLocaleTimeString();
      finalTranscript.textContent += "[" + time + "] " + payloadText + "\\n";
      typedInterruptInput.value = "";
      typedInputInterruptSent = false;
      log("typed final committed");
    }
    function normalizeTypedInputText(text) {
      return String(text || "").replace(/[\\u0000-\\u001F\\u007F\\u200B-\\u200D\\u2060\\uFEFF\\uFFFC]/g, "").trim();
    }
    typedInterruptInput.addEventListener("input", () => {
      const text = normalizeTypedInputText(typedInterruptInput.value);
      if (text.length <= 1) {
        return;
      }
      if (!typedInputInterruptSent) {
        typedInputInterruptSent = true;
        log("typed interrupt requested");
        socket?.send(JSON.stringify({ type: "interrupt", reason: "manual" }));
      }
    });
    typedInterruptInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      commitTypedFinalText(typedInterruptInput.value);
    });
    function startTalking() {
      if (speechActive || !socket || socket.readyState !== WebSocket.OPEN) return;
      speechActive = true;
      talkButton.textContent = "Talking";
      log("talk started");
      socket.send(JSON.stringify({ type: "speech-state", active: true }));
    }
    function stopTalking() {
      if (!speechActive) return;
      speechActive = false;
      talkButton.textContent = "Hold to talk";
      log("talk stopped");
      socket?.send(JSON.stringify({ type: "speech-state", active: false }));
    }
    function startPcmStreaming(stream) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContext();
      pcmSource = audioContext.createMediaStreamSource(stream);
      pcmProcessor = audioContext.createScriptProcessor(4096, 1, 1);
      pcmProcessor.onaudioprocess = (event) => {
        if (!speechActive || !socket || socket.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = downsampleToPcm16(input, audioContext.sampleRate, inboundAudio.sampleRateHz);
        if (!pcm.byteLength) return;
        let binary = "";
        const bytes = new Uint8Array(pcm.buffer);
        for (const byte of bytes) binary += String.fromCharCode(byte);
        socket.send(JSON.stringify({ type: "audio-chunk", data: btoa(binary) }));
      };
      pcmSource.connect(pcmProcessor);
      pcmProcessor.connect(audioContext.destination);
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

function normalizeTypedInputText(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F\u200B-\u200D\u2060\uFEFF\uFFFC]/g, "")
    .trim();
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

function stripParenthesizedText(text: string): string {
  let depth = 0;
  let output = "";
  for (const char of Array.from(text)) {
    if (char === "(" || char === "（") {
      depth += 1;
      continue;
    }
    if ((char === ")" || char === "）") && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) output += char;
  }
  return output
    .replace(/\s+/g, " ")
    .replace(/\s+([，。！？、,.!?])/g, "$1")
    .trim();
}

function createAsyncQueue<T>() {
  const items: T[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let error: unknown;
  const notify = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  return {
    get length() {
      return items.length;
    },
    get closed() {
      return closed;
    },
    push(item: T) {
      if (closed) return;
      items.push(item);
      notify();
    },
    shift() {
      if (error) throw error;
      return items.shift();
    },
    close() {
      closed = true;
      notify();
    },
    fail(cause: unknown) {
      error = cause;
      closed = true;
      notify();
    },
    async waitFor(predicate: () => boolean) {
      while (!predicate()) {
        if (error) throw error;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      if (error) throw error;
    }
  };
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "operation_aborted");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

async function* abortableAsyncIterable<T>(iterable: AsyncIterable<T>, signal: AbortSignal): AsyncIterable<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (!signal.aborted) {
      let result: IteratorResult<T>;
      try {
        result = await raceWithAbort(iterator.next(), signal);
      } catch (error) {
        if (signal.aborted) break;
        throw error;
      }
      if (result.done) break;
      yield result.value;
    }
  } finally {
    if (signal.aborted) {
      try {
        await iterator.return?.();
      } catch {
        // Best-effort cancellation for provider-side async generators.
      }
    }
  }
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
      "-page_duration", "20000",
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
      "-page_duration", "20000",
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

async function* runFfmpegPcmL16StreamToOpusPackets(chunks: AsyncIterable<Uint8Array>, sampleRateHz: number, channels: number, ffmpegCommand: string): AsyncIterable<Uint8Array> {
  const command = resolveFfmpegCommand(ffmpegCommand);
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.off("error", reject);
      resolve();
    });
  });
  const address = socket.address();
  if (typeof address === "string") {
    socket.close();
    throw new Error("ffmpeg RTP socket did not bind to an IP port");
  }
  const packetQueue = createAsyncQueue<Uint8Array>();
  socket.on("message", (message) => {
    const payload = parseRtpPayload(message);
    if (payload.byteLength) packetQueue.push(payload);
  });
  const child = childProcess.spawn(command, [
    "-hide_banner",
    "-loglevel", "error",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-analyzeduration", "0",
    "-probesize", "32",
    "-f", "s16le",
    "-ar", String(sampleRateHz),
    "-ac", String(channels),
    "-i", "pipe:0",
    "-ac", "1",
    "-ar", "48000",
    "-c:a", "libopus",
    "-application", "voip",
    "-frame_duration", "20",
    "-flush_packets", "1",
    "-f", "rtp",
    `rtp://127.0.0.1:${address.port}?pkt_size=1200`
  ], { stdio: ["pipe", "ignore", "pipe"] });
  const stderr: any[] = [];
  let settled = false;
  const closePromise = new Promise<void>((resolve, reject) => {
    child.stderr.on("data", (chunk: any) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      settled = true;
      socket.close();
      if (code === 0) {
        packetQueue.close();
        resolve();
      } else {
        const error = new Error(`ffmpeg pcm opus RTP stream transcode failed: ${nodeBuffer.concat(stderr).toString("utf8").slice(0, 500)}`);
        packetQueue.fail(error);
        reject(error);
      }
    });
  });
  const writer = (async () => {
    try {
      for await (const chunk of chunks) {
        if (!chunk.byteLength || child.stdin.destroyed) continue;
        await writeChildStdin(child.stdin, nodeBuffer.from(chunk));
      }
      if (!child.stdin.destroyed) child.stdin.end();
    } catch (error) {
      if (!child.stdin.destroyed) child.stdin.destroy(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  })();
  try {
    while (!packetQueue.closed || packetQueue.length > 0) {
      const packet = packetQueue.shift();
      if (packet) {
        yield packet;
        continue;
      }
      await packetQueue.waitFor(() => packetQueue.length > 0 || packetQueue.closed);
    }
    await writer;
    await closePromise;
  } finally {
    if (!settled) {
      child.kill("SIGTERM");
      await closePromise.catch(() => undefined);
    }
    try {
      socket.close();
    } catch {
      // already closed
    }
  }
}

function parseRtpPayload(packet: Buffer): Uint8Array {
  if (packet.length < 12) return new Uint8Array();
  const version = packet[0] >> 6;
  if (version !== 2) return new Uint8Array();
  const csrcCount = packet[0] & 0x0f;
  const hasExtension = Boolean(packet[0] & 0x10);
  let offset = 12 + csrcCount * 4;
  if (offset > packet.length) return new Uint8Array();
  if (hasExtension) {
    if (offset + 4 > packet.length) return new Uint8Array();
    const extensionLengthWords = nodeBuffer.from(packet).readUInt16BE(offset + 2);
    offset += 4 + extensionLengthWords * 4;
    if (offset > packet.length) return new Uint8Array();
  }
  return new Uint8Array(packet.subarray(offset));
}

function writeChildStdin(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off?.("error", onError);
      stream.off?.("drain", onDrain);
    };
    stream.on?.("error", onError);
    if (stream.write(chunk)) {
      cleanup();
      resolve();
    } else {
      stream.on?.("drain", onDrain);
    }
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

type OggOpusParserState = {
  buffer: Buffer;
  pending: Buffer;
};

function appendOggOpusPackets(state: OggOpusParserState, chunk: Buffer | Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  const buffer = nodeBuffer.concat([state.buffer, nodeBuffer.from(chunk)]);
  let offset = 0;
  while (offset + 27 <= buffer.length) {
    if (buffer.subarray(offset, offset + 4).toString("ascii") !== "OggS") throw new Error("invalid ogg opus stream");
    const pageSegments = buffer[offset + 26];
    const segmentTableStart = offset + 27;
    const dataStart = segmentTableStart + pageSegments;
    if (dataStart > buffer.length) break;
    const laces = Array.from(buffer.subarray(segmentTableStart, dataStart)) as number[];
    const pageDataLength = laces.reduce((sum, value) => sum + value, 0);
    const pageEnd = dataStart + pageDataLength;
    if (pageEnd > buffer.length) break;
    const pageData = buffer.subarray(dataStart, pageEnd);
    let pageOffset = 0;
    for (const lace of laces) {
      state.pending = nodeBuffer.concat([state.pending, pageData.subarray(pageOffset, pageOffset + lace)]);
      pageOffset += lace;
      if (lace < 255) {
        packets.push(new Uint8Array(state.pending));
        state.pending = nodeBuffer.alloc(0);
      }
    }
    offset = pageEnd;
  }
  state.buffer = buffer.subarray(offset);
  return packets;
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
