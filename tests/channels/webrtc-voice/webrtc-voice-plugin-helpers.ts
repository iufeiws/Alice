import assert from "node:assert/strict";
import type { AsrInboundStreamAcceptResult, AsrInboundStreamSession } from "../../../src/channels/asr/src/index.js";
import type { PlaybackConsumerSnapshot, PlaybackItemSettled, ServerAudioFrame, ServerOutboundAudioTrack, WebRtcVoiceConfig } from "../../../src/channels/webrtc-voice/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");

export const defaultConfig: WebRtcVoiceConfig = {
  enabled: true,
  callPath: "/plugins/webrtc-voice/call",
  signalingPath: "/plugins/webrtc-voice/signaling",
  accountId: "main",
  language: "ja",
  inboundAudio: {
    sampleRateHz: 16000,
    channels: 1,
    encoding: "pcm_s16le",
    chunkMs: 100
  },
  outboundAudio: {
    sampleRateHz: 48000,
    channels: 1,
    frameMs: 20
  },
  iceServers: [],
  bargeIn: {
    enabled: true,
    minSpeechMs: 250
  },
  timeouts: {
    signalingIdleMs: 30_000,
    peerConnectionMs: 10_000,
    ttsPlaybackStartMs: 10_000
  },
  ttsTextFilter: {
    stripParenthesized: true
  }
};

export async function fakeVoiceSynthesizer() {
  return { assetId: "generated/tts/fake.opus", filePath: tempFilePath("fake.opus") };
}

export class FakePeer {
  readonly withoutOutboundTrack: boolean;
  readonly writeResults: boolean[];
  readonly candidates: unknown[] = [];
  closed = false;
  outboundTrack?: FakeOutboundTrack;

  constructor(input: { withoutOutboundTrack?: boolean; writeResults?: boolean[] } = {}) {
    this.withoutOutboundTrack = Boolean(input.withoutOutboundTrack);
    this.writeResults = [...(input.writeResults ?? [])];
  }

  async createAnswer(offerSdp: string) {
    assert.equal(offerSdp, "offer");
    return "answer";
  }

  async addIceCandidate(candidate: unknown) {
    this.candidates.push(candidate);
  }

  async createOutboundAudioTrack() {
    if (this.withoutOutboundTrack) return undefined;
    this.outboundTrack = new FakeOutboundTrack(this.writeResults);
    return this.outboundTrack;
  }

  close() {
    this.closed = true;
  }
}

class FakeOutboundTrack {
  frames: ServerAudioFrame[] = [];
  stopped = false;

  constructor(private readonly writeResults: boolean[] = []) {}

  async writeFrame(frame: ServerAudioFrame) {
    const result = frame.pcm.length > 0 && this.writeResults.length > 0 ? this.writeResults.shift()! : true;
    if (!result) return false;
    this.frames.push(frame);
    return true;
  }

  stop() {
    this.stopped = true;
  }
}

export class ControlledQueueTrack implements ServerOutboundAudioTrack {
  readonly enqueued: Array<{ itemId: string; outputId?: string; filePath: string; assetId: string; text?: string }> = [];
  private readonly settlements: Array<{ resolve(value: PlaybackItemSettled): void }> = [];
  private readonly idleWaiters: Array<{ resolve(value: boolean): void }> = [];
  stopped = false;

  get waitingSettlements() {
    return this.settlements.length;
  }

  get waitingIdleResolvers() {
    return this.idleWaiters.length;
  }

  async writeFrame() {
    return true;
  }

  async waitUntilReady() {
    return true;
  }

  async enqueueAudioFile(input: { itemId: string; outputId?: string; filePath: string; assetId: string; text?: string }) {
    this.enqueued.push({ itemId: input.itemId, outputId: input.outputId, filePath: input.filePath, assetId: input.assetId, text: input.text });
    return { itemId: input.itemId };
  }

  waitForPlaybackItem(_itemId: string) {
    return new Promise<PlaybackItemSettled>((resolve) => {
      this.settlements.push({ resolve });
    });
  }

  waitForPlaybackIdle() {
    return new Promise<boolean>((resolve) => {
      this.idleWaiters.push({ resolve });
    });
  }

  settle(index: number, value: PlaybackItemSettled) {
    this.settlements[index]?.resolve(value);
  }

  resolveIdle(value = true) {
    const waiters = this.idleWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve(value);
  }

  stop() {
    this.stopped = true;
  }
}

export class RemotePlayingQueueTrack extends ControlledQueueTrack {
  constructor(private readonly snapshot: PlaybackConsumerSnapshot) {
    super();
  }

  getCurrentPlayback() {
    return this.snapshot;
  }
}

export class DelayedEnqueueTrack extends ControlledQueueTrack {
  readonly pendingEnqueues: Array<{ resolve(): void }> = [];

  override async enqueueAudioFile(input: { itemId: string; outputId?: string; filePath: string; assetId: string; text?: string }) {
    const result = super.enqueueAudioFile(input);
    await new Promise<void>((resolve) => {
      this.pendingEnqueues.push({ resolve });
    });
    return result;
  }

  resolveEnqueue(index: number) {
    this.pendingEnqueues[index]?.resolve();
  }
}

export class FakeAsrSession implements AsrInboundStreamSession {
  readonly streamId = "fake-stream";
  private readonly results: AsrInboundStreamAcceptResult[];

  constructor(results: AsrInboundStreamAcceptResult[]) {
    this.results = [...results];
  }

  async accept(): Promise<AsrInboundStreamAcceptResult> {
    return this.results.shift() ?? { ok: true, type: "ack", streamId: this.streamId, sequence: 0 };
  }
}

export class FakeHangingAsrSession implements AsrInboundStreamSession {
  readonly streamId = "fake-hanging-stream";

  async accept(): Promise<AsrInboundStreamAcceptResult> {
    return new Promise<AsrInboundStreamAcceptResult>(() => undefined);
  }
}

export function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function tempFilePath(fileName: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", "webrtc-voice-files");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, fileName);
}

export async function collectVoiceTextInput(text: string | AsyncIterable<string>): Promise<string> {
  if (typeof text === "string") return text;
  let result = "";
  for await (const part of text) result += part;
  return result;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
