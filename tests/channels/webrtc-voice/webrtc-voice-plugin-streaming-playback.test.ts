import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebRtcVoiceRuntime } from "../../../src/apps/api/bootstrap/web-rtc-voice-runtime.js";
import { createWebRtcVoicePlugin, defaultWebRtcVoiceConfig, encodePcmL16StreamToOpusRtpFrames, WebRtcVoiceError, type ServerAudioFrame } from "../../../src/channels/webrtc-voice/src/index.js";
import { createTalkRuntime } from "../../../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createTalkStore } from "../../../src/contexts/talk-session/src/adapters/sqlite-talk-session-store.js";
import { ControlledQueueTrack, DelayedEnqueueTrack, FakeAsrSession, FakeHangingAsrSession, FakePeer, RemotePlayingQueueTrack, collectVoiceTextInput, defaultConfig, fakeVoiceSynthesizer, makeTempDir, tempFilePath, waitFor } from "./webrtc-voice-plugin-helpers.js";

const path = await import("node:path");

test("WebRTC voice queues streaming encoder frames before playback", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        yield { type: "audio" as const, sequence: 0, text: "原文播放片段", chunk: new Uint8Array([1, 2]), contentType: "audio/L16; rate=16000; channels=1", sampleRateHz: 16_000, channels: 1 };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      assert.equal(input.inputSampleRateHz, 16_000);
      assert.equal(input.inputChannels, 1);
      const chunks: number[] = [];
      for await (const chunk of input.chunks) chunks.push(chunk.byteLength);
      assert.deepEqual(chunks, [2]);
      yield { sequence: 0, pcm: new Int16Array([1]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
      yield { sequence: 1, pcm: new Int16Array([2]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
      yield { sequence: 2, pcm: new Int16Array([3]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
    },
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-stream-queue", userId: "browser-stream-queue", offerSdp: "offer" });
  const result = await call.playReplyText("queue", "queue-output", {
    beforeFirstPlayback() {
      assert.equal(statuses.some((entry) => entry.state === "tts.playing_text"), false);
    }
  });
  await waitFor(() => (peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).length ?? 0) === 3);

  assert.equal(result.status, "played");
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[1], [2], [3]]);
});

test("WebRTC voice treats zero-frame queued streaming interrupt as interrupted", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  let releaseStream!: () => void;
  const streamReady = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        await streamReady;
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      for await (const _chunk of input.chunks) {
        throw new Error("interrupted stream should not receive audio chunks");
      }
    },
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-stream-zero-interrupt", userId: "browser-stream-zero-interrupt", offerSdp: "offer" });
  const playback = call.playReplyText("queued interrupt", "zero-interrupt-output", { chunkId: "zero-interrupt-chunk" });
  await waitFor(() => statuses.some((entry) => entry.state === "tts.stream.started"));

  await call.interrupt("manual", "zero-interrupt-output");
  releaseStream();
  const result = await playback;

  assert.equal(result.status, "interrupted");
  assert.equal(result.frameCount, 0);
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0), []);
});

test("WebRTC voice maps streaming text spans with source PCM sample rate", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  let nowMs = 0;
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        yield {
          type: "audio" as const,
          sequence: 0,
          text: "父亲大人终于睡醒了呀",
          chunk: new Uint8Array(16_000),
          contentType: "audio/L16; rate=16000; channels=1",
          sampleRateHz: 16_000,
          channels: 1
        };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      for await (const chunk of input.chunks) {
        assert.equal(chunk.byteLength, 16_000);
        assert.equal(input.inputSampleRateHz, 16_000);
        for (let index = 0; index < 25; index += 1) {
          yield { sequence: index, pcm: new Int16Array([index + 1]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
        }
      }
    },
    emitStatus: (event) => statuses.push(event),
    now: () => new Date(nowMs),
    sleep: async (ms) => {
      nowMs += ms;
    }
  });

  const call = await plugin.createCall({ callId: "call-stream-text-span-rate", userId: "browser-stream-text-span-rate", offerSdp: "offer" });
  const result = await call.playReplyText("span", "span-output");

  assert.equal(result.status, "played");
  assert.equal(result.frameCount, 25);
  assert.equal(statuses.some((entry) => entry.state === "tts.playing_text.missing"), false);
  assert.equal(statuses.some((entry) => entry.state === "tts.playback.consumer" && entry.detail === "前文=父亲大人终于睡醒了呀 时长=500ms"), true);
});

test("WebRTC voice starts streaming playback clock after first-playback delay", async () => {
  const peer = new FakePeer();
  const sleeps: number[] = [];
  let nowMs = 0;
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        yield { type: "audio" as const, sequence: 0, chunk: new Uint8Array([1]), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      for await (const _chunk of input.chunks) {
        for (let index = 0; index < 60; index += 1) {
          yield { sequence: index, pcm: new Int16Array([index + 1]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
        }
      }
    },
    now: () => new Date(nowMs),
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    }
  });

  const call = await plugin.createCall({ callId: "call-stream-clock", userId: "browser-stream-clock", offerSdp: "offer" });
  const result = await call.playReplyText("clock", "clock-output", {
    beforeFirstPlayback: async () => {
      sleeps.push(1000);
      nowMs += 1000;
    }
  });

  assert.equal(result.status, "played");
  await waitFor(() => (peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).length ?? 0) === 60);
  assert.equal(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).length, 60);
  assert.deepEqual(sleeps.slice(0, 3), [20, 20, 20]);
});

test("WebRTC voice waits for streaming encoder completion before queued playback", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  let releaseNextFrame!: () => void;
  const nextFrameReady = new Promise<void>((resolve) => {
    releaseNextFrame = resolve;
  });
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        yield { type: "audio" as const, sequence: 0, chunk: new Uint8Array([1]), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      for await (const _chunk of input.chunks) {
        for (let index = 0; index < 60; index += 1) {
          yield { sequence: index, pcm: new Int16Array([index + 1]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
        }
        await nextFrameReady;
        yield { sequence: 60, pcm: new Int16Array([99]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
      }
    },
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-stream-keepalive", userId: "browser-stream-keepalive", offerSdp: "offer" });
  setTimeout(() => releaseNextFrame(), 0);
  const result = await call.playReplyText("keepalive", "keepalive-output");

  assert.equal(result.status, "played");
  assert.equal(result.frameCount, 61);
  assert.equal(statuses.some((entry) => entry.state === "tts.queue.producer_done"), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.queue.underrun"), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.queue.rtp_keepalive"), false);
});

test("WebRTC voice fills streaming underrun with timed silence frames", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  let nowMs = 0;
  let underrunStartedAt: number | undefined;
  let nextFrameReleased = false;
  let releaseNextFrame!: () => void;
  const nextFrameReady = new Promise<void>((resolve) => {
    releaseNextFrame = resolve;
  });
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    now: () => new Date(nowMs),
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        yield { type: "audio" as const, sequence: 0, text: "等待下一帧", chunk: new Uint8Array([1]), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      for await (const _chunk of input.chunks) {
        for (let index = 0; index < 60; index += 1) {
          yield { sequence: index, pcm: new Int16Array([index + 1]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
        }
        await nextFrameReady;
        yield { sequence: 60, pcm: new Int16Array([99]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
      }
    },
    sleep: async (ms) => {
      nowMs += ms;
      if (underrunStartedAt !== undefined && !nextFrameReleased && nowMs - underrunStartedAt >= 120) {
        nextFrameReleased = true;
        releaseNextFrame();
      }
    },
    emitStatus: (event) => {
      statuses.push(event);
      if (event.state === "tts.queue.underrun") underrunStartedAt = nowMs;
    }
  });

  const call = await plugin.createCall({ callId: "call-stream-underrun-silence", userId: "browser-stream-underrun-silence", offerSdp: "offer" });
  const result = await call.playReplyText("underrun", "underrun-output");

  assert.equal(result.status, "played");
  assert.equal(statuses.some((entry) => entry.state === "tts.queue.underrun"), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.queue.silence"), true);
  await waitFor(() => (peer.outboundTrack?.frames ?? []).some((frame) => Array.from(frame.pcm).join(",") === "99"));
  const frames = peer.outboundTrack?.frames ?? [];
  const silenceCount = frames.filter((frame) => frame.pcm.length === 0).length;
  const finalFrameIndex = frames.findIndex((frame) => Array.from(frame.pcm).join(",") === "99");
  assert.ok(silenceCount > 0);
  assert.ok(finalFrameIndex > 60);
  assert.equal(frames.some((frame) => frame.pcm.length === 0 && frame.durationMs === 20), true);
});
