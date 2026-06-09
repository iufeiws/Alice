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
  | { type: "audio"; sequence: number; text?: string; chunk: Uint8Array; contentType: string; sampleRateHz?: number; channels?: number }
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

export type WebRtcVoiceTtsArchiveInput = {
  callId: string;
  talkSessionId: string;
  outputId?: string;
  chunkId?: string;
  text: string;
  speakText: string;
  createdAt: string;
  status: PlaybackItem["status"];
  source: "stream" | "file";
  partIndex?: number;
  partCount?: number;
  assetId?: string;
  filePath?: string;
  audio?: {
    chunks: Uint8Array[];
    sampleRateHz: number;
    channels: number;
    encoding: "pcm_s16le";
  };
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
  archiveTtsOutput?(input: WebRtcVoiceTtsArchiveInput): Promise<{ filePath?: string } | void> | { filePath?: string } | void;
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

export type InterruptItem = {
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

export type TtsTask = {
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
  queuedFrames?: number;
  producerDone?: boolean;
  pendingPlaybackEvents?: number;
  firstPlaybackStarted?: boolean;
  beforeFirstPlayback?: () => Promise<void> | void;
  missingPlayingTextReported?: boolean;
};

export type PlaybackConsumer = {
  outputId?: string;
  chunkId?: string;
  playbackTextCache: string;
  playedMs: number;
  totalMs: number;
};

export type PlaybackAudioTextSpan = {
  text: string;
  audio: Uint8Array;
  startMs: number;
  endMs: number;
};

export type PlaybackFrame = {
  item: PlaybackItem;
  frame: ServerAudioFrame;
  text?: string;
  textTotalMs?: number;
};

export type PlaybackTimelineEvent = {
  atMs: number;
  kind: "start" | "end";
  item: PlaybackItem;
  text?: string;
  textTotalMs?: number;
  durationMs: number;
  frameIndex: number;
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
