import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebRtcVoiceRuntime } from "../../../src/apps/api/bootstrap/web-rtc-voice-runtime.js";
import { createWebRtcVoicePlugin, defaultWebRtcVoiceConfig, encodePcmL16StreamToOpusRtpFrames, WebRtcVoiceError, type ServerAudioFrame } from "../../../src/channels/webrtc-voice/src/index.js";
import { createTalkRuntime } from "../../../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createTalkStore } from "../../../src/contexts/talk-session/src/adapters/sqlite-talk-session-store.js";
import { ControlledQueueTrack, DelayedEnqueueTrack, FakeAsrSession, FakeHangingAsrSession, FakePeer, RemotePlayingQueueTrack, collectVoiceTextInput, defaultConfig, fakeVoiceSynthesizer, makeTempDir, tempFilePath, waitFor } from "./webrtc-voice-plugin-helpers.js";

const path = await import("node:path");

test("WebRTC voice does not advance playback text until underrun silence finishes", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  let nowMs = 0;
  let sawSilence = false;
  let checkedSilenceSleep = false;
  let releaseNextFrame!: () => void;
  const nextFrameReady = new Promise<void>((resolve) => {
    releaseNextFrame = resolve;
  });
  const firstChunk = new Uint8Array(76_800);
  const secondChunk = new Uint8Array(1_280);
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    now: () => new Date(nowMs),
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        yield { type: "audio" as const, sequence: 0, text: "第一段", chunk: firstChunk, contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "audio" as const, sequence: 1, text: "第二段", chunk: secondChunk, contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      let chunkIndex = 0;
      for await (const _chunk of input.chunks) {
        if (chunkIndex === 0) {
          for (let index = 0; index < 60; index += 1) {
            yield { sequence: index, pcm: new Int16Array([index + 1]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
          }
          await nextFrameReady;
        } else {
          yield { sequence: 60, pcm: new Int16Array([99]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
        }
        chunkIndex += 1;
      }
    },
    sleep: async (ms) => {
      if (sawSilence && !checkedSilenceSleep) {
        checkedSilenceSleep = true;
        assert.equal(ms, 20);
        assert.equal(statuses.some((entry) => entry.state === "tts.playback.consumer" && entry.detail?.includes("第二段")), false);
        assert.equal(statuses.some((entry) => entry.state === "tts.playing_text" && entry.detail === "第二段"), false);
        releaseNextFrame();
      }
      nowMs += ms;
    },
    emitStatus: (event) => {
      statuses.push(event);
      if (event.state === "tts.queue.silence") sawSilence = true;
    }
  });

  const call = await plugin.createCall({ callId: "call-stream-text-silence-gate", userId: "browser-stream-text-silence-gate", offerSdp: "offer" });
  const result = await call.playReplyText("silence gate", "silence-gate-output");

  assert.equal(result.status, "played");
  assert.equal(checkedSilenceSleep, true);
  await waitFor(() => statuses.some((entry) => entry.state === "tts.playback.consumer" && entry.detail?.includes("前文=第二段")));
  assert.equal(statuses.some((entry) => entry.state === "tts.playback.consumer" && entry.detail?.includes("前文=第二段")), true);
  assert.deepEqual(statuses.filter((entry) => entry.state === "tts.playing_text").map((entry) => entry.detail), ["第一段", "第二段"]);
});

test("WebRTC voice does not advance playback text until the next real frame finishes", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  let nowMs = 0;
  let checkedSecondFrameSleep = false;
  const firstChunk = new Uint8Array(76_800);
  const secondChunk = new Uint8Array(1_280);
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    now: () => new Date(nowMs),
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        yield { type: "audio" as const, sequence: 0, text: "第一段", chunk: firstChunk, contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "audio" as const, sequence: 1, text: "第二段", chunk: secondChunk, contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      let chunkIndex = 0;
      for await (const _chunk of input.chunks) {
        if (chunkIndex === 0) {
          for (let index = 0; index < 60; index += 1) {
            yield { sequence: index, pcm: new Int16Array([index + 1]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
          }
        } else {
          yield { sequence: 60, pcm: new Int16Array([99]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
        }
        chunkIndex += 1;
      }
    },
    sleep: async (ms) => {
      if (!checkedSecondFrameSleep && ms === 20 && peer.outboundTrack?.frames.some((frame) => Array.from(frame.pcm).join(",") === "99")) {
        checkedSecondFrameSleep = true;
        assert.equal(statuses.some((entry) => entry.state === "tts.playback.consumer" && entry.detail?.includes("第二段")), false);
        assert.equal(statuses.some((entry) => entry.state === "tts.playing_text" && entry.detail === "第二段"), false);
      }
      nowMs += ms;
    },
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-stream-text-real-frame-gate", userId: "browser-stream-text-real-frame-gate", offerSdp: "offer" });
  const result = await call.playReplyText("real frame gate", "real-frame-gate-output");

  assert.equal(result.status, "played");
  await waitFor(() => statuses.some((entry) => entry.state === "tts.playback.consumer" && entry.detail?.includes("前文=第二段")));
  assert.equal(statuses.some((entry) => entry.state === "tts.playback.consumer" && entry.detail?.includes("前文=第二段")), true);
  assert.deepEqual(statuses.filter((entry) => entry.state === "tts.playing_text").map((entry) => entry.detail), ["第一段", "第二段"]);
});

test("WebRTC voice paces queued RTP frames instead of bursting the whole stream", async () => {
  const peer = new FakePeer();
  const frameCountsAtSleep: number[] = [];
  let nowMs = 0;
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    now: () => new Date(nowMs),
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
    sleep: async (ms) => {
      if (ms === 20) frameCountsAtSleep.push(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).length ?? 0);
      nowMs += ms;
    }
  });

  const call = await plugin.createCall({ callId: "call-stream-rtp-paced", userId: "browser-stream-rtp-paced", offerSdp: "offer" });
  const result = await call.playReplyText("paced", "paced-output");

  assert.equal(result.status, "played");
  assert.equal(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).length, 60);
  assert.equal(frameCountsAtSleep.some((count) => count > 0 && count < 60), true);
});

test("WebRTC voice gates playback when speech starts before streaming TTS writes audio", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  let releaseAudio!: () => void;
  const audioReady = new Promise<void>((resolve) => {
    releaseAudio = resolve;
  });
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        yield { type: "translation_done" as const, sequence: 0, translatedChars: 4 };
        await audioReady;
        yield { type: "audio" as const, sequence: 0, chunk: new Uint8Array([1, 2, 3, 4]), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16ToFrames: async () => [
      { sequence: 0, pcm: new Int16Array([7]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ],
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-stream-pending", userId: "browser-stream-pending", offerSdp: "offer" });
  const playback = call.playReplyText("pending", "pending-output");
  await Promise.resolve();
  await call.setSpeechActive(true);
  releaseAudio();
  const result = await playback;

  assert.equal(result.status, "interrupted");
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), []);
  assert.equal(statuses.some((entry) => entry.state === "tts.barge_in" && entry.detail === ""), true);
  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.interrupt.todo" && entry.detail === "barge_in:"), true);
});

test("WebRTC voice does not use pending chunk text as breakpoint context before TTS produces audio", async () => {
  let call: any;
  const latestInterrupts: Array<{ beforeText?: string; afterText?: string }> = [];
  let releaseAudio!: () => void;
  const audioReady = new Promise<void>((resolve) => {
    releaseAudio = resolve;
  });
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        yield { type: "translation_done" as const, sequence: 0, translatedChars: 4 };
        await audioReady;
        yield { type: "audio" as const, sequence: 0, chunk: new Uint8Array([1, 2]), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16ToFrames: async () => [
      { sequence: 0, pcm: new Int16Array([7]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ],
    talkRuntime: {
      openSession() {},
      ingestInput() {},
      closeSession() {},
      interruptLatestOutput(input) {
        latestInterrupts.push({
          beforeText: input.breakpointContext?.beforeText,
          afterText: input.breakpointContext?.afterText
        });
      }
    }
  });

  call = await plugin.createCall({ callId: "call-pending-context", userId: "browser-pending-context", offerSdp: "offer" });
  const playback = call.playReplyText("是什么文件？", "pending-context-output", {
    originalText: "是什么文件？"
  });
  await Promise.resolve();
  await call.setSpeechActive(true);
  releaseAudio();
  const result = await playback;

  assert.equal(result.status, "interrupted");
  assert.deepEqual(latestInterrupts, [{ beforeText: undefined, afterText: undefined }]);
});
