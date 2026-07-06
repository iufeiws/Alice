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
  asrProvider?: "tencent" | "openai_compatible" | "multimodal_llm";
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
  enqueueAudioFile?(input: EnqueuePlaybackAudioFileInput): Promise<{ itemId: string }> | { itemId: string };
  waitForPlaybackItem?(itemId: string): Promise<PlaybackItemSettled>;
  waitForPlaybackIdle?(): Promise<boolean>;
  interrupt?(input: { reason: "manual" | "barge_in" | "network" | "unknown" | "asr_failure" | "call_close"; targetOutputId?: string }): Promise<void> | void;
  getCurrentPlayback?(): Promise<PlaybackConsumerSnapshot> | PlaybackConsumerSnapshot;
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
  | { type: "audio_file"; sequence: number; text?: string; textchunk?: string; assetId: string; filePath: string }
  | { type: "part_done"; sequence: number }
  | { type: "done" };

export type WebRtcVoiceSynthesizer = VoiceSynthesizer & {
  stream?(input: {
    text: any;
    time: ReturnType<typeof createCurrentTimeProvider>;
    source: "send_chat.voice";
    streamId?: string;
    onInputBufferIdle?(): void | Promise<void>;
    beforeBackendRequest?(input: { sequence: number; text: string }): void | Promise<void>;
  }): AsyncIterable<unknown>;
};

export type WebRtcVoiceStatusEvent = {
  callId?: string;
  state: string;
  detail?: string;
};

export type WebRtcVoiceTtsArchiveInput = {
  callId: string;
  talkSessionId: number;
  outputId?: string;
  chunkId?: string;
  originalText?: string;
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
  openSession?(input: unknown): void | { sessionId?: number } | Promise<void | { sessionId?: number }>;
  closeSession?(input: unknown): void | Promise<void>;
  ingestInput?(event: { kind: string; [key: string]: unknown }): void | Promise<void>;
  commitStableInputBatch?(batch: {
    sessionId: number;
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
  markAgentLoopReady?(sessionId: number): void | Promise<void>;
  claimBufferedOutputText?(sessionId: number): unknown;
  claimReadyOutputChunk?(sessionId: number): unknown;
  isSessionOutputIdle?(sessionId: number): unknown;
  markForegroundPlaybackIdle?(input: { sessionId: number }): void | Promise<void>;
  markOutputChunkPlayed?(input: { sessionId: number; chunkId: string }): void | Promise<void>;
  interruptOutput?(input: { sessionId: number; outputId: string; reason: "manual" | "barge_in" | "network" | "unknown"; elapsedMs?: number; totalMs?: number; breakpointContext?: { beforeText?: string; afterText?: string }; omitAssistantMessage?: boolean }): unknown;
  interruptLatestOutput?(input: { sessionId: number; reason: "manual" | "barge_in" | "network" | "unknown"; elapsedMs?: number; totalMs?: number; breakpointContext?: { beforeText?: string; afterText?: string }; omitAssistantMessage?: boolean }): unknown;
  interruptAgentLoop?(sessionId: number, input?: { reason?: string; interruptEpoch?: number }): void | Promise<void>;
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
  supportsAudioInput?(): boolean;
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
  failureReason?: "tts_failed" | "outbound_audio_not_ready" | "no_frames_sent";
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
  stableInputAudio?: WebRtcVoiceInputAudio;
  sequence: number;
  runtimeInterruptPromise?: Promise<void>;
  stableInputTimeout?: NodeJS.Timeout;
};

export type WebRtcVoiceInputAudio = {
  kind: "audio";
  data: string;
  format: string;
  mimeType?: string;
  sampleRateHz?: number;
  channels?: number;
  encoding?: string;
  bytes?: number;
  durationMs?: number;
};

export type TtsTask = {
  id: string;
  outputId?: string;
  controller: AbortController;
};

export type EnqueuePlaybackAudioFileInput = {
  itemId: string;
  outputId?: string;
  chunkId?: string;
  filePath: string;
  assetId: string;
  originalText?: string;
  speakText?: string;
  text: string;
  createdAt: string;
  interruptEpoch?: number;
  beforeFirstPlayback?: boolean;
};

export type PlaybackItemSettled = {
  itemId: string;
  status: "played" | "interrupted" | "cancelled" | "failed";
  framesWritten: number;
  playedMs?: number;
  totalMs?: number;
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
  status?: "idle" | "queued" | "playing" | "interrupted" | "failed";
};

export type PlaybackConsumerSnapshot = PlaybackConsumer;

export type PlaybackAudioTextSpan = {
  text: string;
  audio: Uint8Array;
  startMs: number;
  endMs: number;
  sampleRateHz?: number;
  channels?: number;
};

export type PlaybackFrame = {
  item: PlaybackItem;
  frame: ServerAudioFrame;
  text?: string;
  textTotalMs?: number;
  writeFailures?: number;
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
  talkSessionId: number;
  asrStreamId: string;
  talkRuntimeIngressStatus: "todo" | "connected";
  acceptIceCandidate(candidate: unknown): Promise<void>;
  acceptInboundAudioChunk(bytes: Uint8Array, timing?: InboundAudioStreamChunkFrame["timing"]): Promise<AsrInboundStreamAcceptResult | undefined>;
  acceptTextDraft?(text: string): Promise<void>;
  acceptTextInput?(text: string): Promise<void>;
  endInboundAudio(): Promise<AsrInboundStreamAcceptResult | undefined>;
  setSpeechActive(active: boolean): Promise<void>;
  playReplyText(text: string | AsyncIterable<string>, outputId?: string, options?: unknown): Promise<PlaybackResult>;
  ackPlaybackIdle?(ackId: string): void;
  interrupt(reason?: "manual" | "barge_in" | "network" | "unknown", targetOutputId?: string): Promise<void>;
  close(reason?: string): Promise<void>;
};

export type WebRtcVoicePlugin = {
  id: "webrtc_voice";
  config: WebRtcVoiceConfig;
  renderCallPage(): string;
  createCall(input: CreateWebRtcVoiceCallInput): Promise<WebRtcVoiceCall>;
};
