import type {
  EnqueuePlaybackAudioFileInput,
  PlaybackItem,
  ServerAudioFrame,
  ServerOutboundAudioTrack,
  ServerWebRtcPeer,
  WebRtcVoiceConfig,
  WebRtcVoiceStatusEvent
} from "./types.js";
import { createWeriftPeer } from "./peer.js";
import { createVoicePlaybackConsumer } from "./playback-consumer.js";
import { decodeAudioFileToOpusRtpFrames } from "./audio.js";
import { hashText, sleep } from "./utils.js";

type RequestMessage = {
  type: "request";
  id: number;
  method: string;
  params?: unknown;
};

let callId = "";
let userId = "";
let config: WebRtcVoiceConfig | undefined;
let peer: ServerWebRtcPeer | undefined;
let outboundTrack: ServerOutboundAudioTrack | undefined;
let playback: ReturnType<typeof createVoicePlaybackConsumer> | undefined;
let closed = false;
let outboundFrameSequence = 0;
let outboundRtpTimestamp = 0;
const playbackQueue: PlaybackItem[] = [];
const itemsById = new Map<string, PlaybackItem>();
let initPromise: Promise<unknown> | undefined;

process.on("message", (message: RequestMessage) => {
  if (!message || message.type !== "request") return;
  const task = message.method === "init"
    ? (initPromise = handleRequest(message))
    : Promise.resolve(initPromise).then(() => handleRequest(message));
  void task.then(
    (result) => process.send?.({ type: "response", id: message.id, ok: true, result }),
    (error) => process.send?.({
      type: "response",
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  );
});

async function handleRequest(message: RequestMessage): Promise<unknown> {
  switch (message.method) {
    case "init": {
      const params = message.params as { callId: string; userId: string; config: WebRtcVoiceConfig };
      callId = params.callId;
      userId = params.userId;
      config = params.config;
      peer = await createWeriftPeer({
        callId,
        userId,
        iceServers: config.iceServers,
        onLocalIceCandidate: (candidate) => process.send?.({ type: "localIceCandidate", candidate }),
        onStatus: emitStatus
      });
      emitStatus({ state: "webrtc.media_process.ready", detail: callId });
      return true;
    }
    case "createOutboundAudioTrack": {
      const cfg = requireConfig();
      outboundTrack = await requirePeer().createOutboundAudioTrack({
        sampleRateHz: cfg.outboundAudio.sampleRateHz,
        channels: cfg.outboundAudio.channels,
        frameMs: cfg.outboundAudio.frameMs
      });
      if (!outboundTrack) throw new Error("server WebRTC outbound audio track is required");
      playback = createMediaPlaybackConsumer(cfg, outboundTrack);
      return true;
    }
    case "createAnswer":
      return await requirePeer().createAnswer((message.params as { offerSdp: string }).offerSdp);
    case "addIceCandidate":
      await requirePeer().addIceCandidate?.((message.params as { candidate: unknown }).candidate);
      return true;
    case "waitUntilReady":
      return await requireTrack().waitUntilReady?.((message.params as { timeoutMs: number }).timeoutMs) ?? true;
    case "enqueueAudioFile":
      return enqueueAudioFile(message.params as EnqueuePlaybackAudioFileInput);
    case "waitForPlaybackItem":
      return await waitForPlaybackItem((message.params as { itemId: string }).itemId);
    case "waitForPlaybackIdle":
      return await waitForPlaybackIdle();
    case "getCurrentPlayback":
      playback?.processTimeline();
      return playback?.consumer ?? { playbackTextCache: "", playedMs: 0, totalMs: 0, status: "idle" };
    case "interrupt":
      interruptPlayback(message.params as { reason: string; targetOutputId?: string });
      return true;
    case "stopTrack":
      await requireTrack().stop();
      return true;
    case "close":
      await close();
      return true;
    default:
      throw new Error(`unknown media process method: ${message.method}`);
  }
}

function createMediaPlaybackConsumer(cfg: WebRtcVoiceConfig, track: ServerOutboundAudioTrack) {
  const outboundTimestampIncrement = (frame: ServerAudioFrame) => frame.rtpTimestampIncrement ?? Math.round(frame.sampleRateHz * frame.durationMs / 1000);
  const stampOutboundFrame = (frame: ServerAudioFrame): ServerAudioFrame => ({
    ...frame,
    sequence: outboundFrameSequence++,
    rtpTimestamp: outboundRtpTimestamp >>> 0
  });
  const advanceOutboundRtpClockForFrame = (frame: ServerAudioFrame) => {
    outboundRtpTimestamp = (outboundRtpTimestamp + outboundTimestampIncrement(frame)) >>> 0;
  };
  const createOutboundSilenceFrame = (durationMs = cfg.outboundAudio.frameMs): ServerAudioFrame => ({
    sequence: 0,
    pcm: new Int16Array(),
    sampleRateHz: cfg.outboundAudio.sampleRateHz,
    channels: cfg.outboundAudio.channels,
    durationMs,
    rtpPayload: new Uint8Array([0xf8, 0xff, 0xfe]),
    rtpTimestampIncrement: Math.round(cfg.outboundAudio.sampleRateHz * durationMs / 1000),
    payloadType: 111
  });
  const writeOutboundSilenceFrame = async (durationMs = cfg.outboundAudio.frameMs) => {
    const frame = createOutboundSilenceFrame(durationMs);
    const written = await track.writeFrame(stampOutboundFrame(frame));
    if (written) advanceOutboundRtpClockForFrame(frame);
    return written;
  };
  return createVoicePlaybackConsumer({
    deps: {
      config: cfg,
      createPeer: () => requirePeer(),
      createAsrSession: () => {
        throw new Error("ASR is not available in media process");
      },
      voiceSynthesizer: (() => {
        throw new Error("TTS is not available in media process");
      }) as never,
      decodeAudioFileToFrames(input) {
        return decodeAudioFileToOpusRtpFrames(input);
      },
      emitStatus,
      sleep
    },
    talkSessionId: `webrtc_voice:${callId}`,
    playbackQueue,
    outboundTrack: track,
    stampOutboundFrame,
    advanceOutboundRtpClockForFrame,
    writeOutboundSilenceFrame,
    isClosed: () => closed
  });
}

function enqueueAudioFile(input: EnqueuePlaybackAudioFileInput): { itemId: string } {
  const item: PlaybackItem = {
    outputId: input.outputId,
    chunkId: input.chunkId,
    originalText: input.originalText,
    speakText: input.speakText,
    textHash: hashText(input.speakText ?? input.text),
    assetId: input.assetId,
    filePath: input.filePath,
    status: "queued",
    createdAt: input.createdAt,
    framesWritten: 0,
    playedMs: 0,
    totalMs: 0,
    interruptEpoch: input.interruptEpoch,
    ttsAudioTextSpans: [{ text: input.text, audio: new Uint8Array(), startMs: 0, endMs: 1 }],
    queuedFrames: 0,
    producerDone: false,
    pendingPlaybackEvents: 0
  };
  itemsById.set(input.itemId, item);
  playbackQueue.push(item);
  playback?.start();
  emitStatus({ state: "tts.queue.ready", detail: `${input.outputId ?? ""}${input.chunkId ? ` chunk=${input.chunkId}` : ""}`.trim() });
  return { itemId: input.itemId };
}

async function waitForPlaybackItem(itemId: string) {
  const item = itemsById.get(itemId);
  if (!item) throw new Error(`unknown playback item: ${itemId}`);
  while (!closed && playbackQueue.includes(item) && item.status !== "failed" && item.status !== "interrupted" && item.status !== "cancelled") {
    playback?.processTimeline();
    playback?.cleanupFinishedItems();
    await sleep(5);
  }
  playback?.processTimeline();
  playback?.cleanupFinishedItems();
  return {
    itemId,
    status: item.status === "played" ? "played" : item.status === "failed" ? "failed" : item.status === "cancelled" ? "cancelled" : "interrupted",
    framesWritten: item.framesWritten,
    playedMs: item.playedMs,
    totalMs: item.totalMs
  };
}

async function waitForPlaybackIdle(): Promise<boolean> {
  while (!closed) {
    playback?.processTimeline();
    playback?.cleanupFinishedItems();
    if (playbackQueue.length === 0) return true;
    await sleep(5);
  }
  return false;
}

function interruptPlayback(input: { reason: string; targetOutputId?: string }): void {
  const current = playback?.consumer;
  const targetOutputId = current?.outputId ?? input.targetOutputId;
  for (const item of playbackQueue) {
    item.status = item.outputId === targetOutputId ? "interrupted" : "cancelled";
  }
  playback?.setCurrentPlayingItem(undefined);
  playback?.clearPendingPlayback();
  playbackQueue.length = 0;
  if (current) current.status = "interrupted";
  emitStatus({ state: "tts.interrupted", detail: `${input.reason}:${targetOutputId ?? ""}` });
}

async function close(): Promise<void> {
  if (closed) return;
  closed = true;
  interruptPlayback({ reason: "close" });
  await outboundTrack?.stop();
  await peer?.close();
}

function requireConfig(): WebRtcVoiceConfig {
  if (!config) throw new Error("media process is not initialized");
  return config;
}

function requirePeer(): ServerWebRtcPeer {
  if (!peer) throw new Error("media process peer is not initialized");
  return peer;
}

function requireTrack(): ServerOutboundAudioTrack {
  if (!outboundTrack) throw new Error("media process outbound track is not initialized");
  return outboundTrack;
}

function emitStatus(event: WebRtcVoiceStatusEvent): void {
  process.send?.({ type: "status", event });
}
