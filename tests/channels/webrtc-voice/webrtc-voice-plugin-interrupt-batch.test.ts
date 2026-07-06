import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebRtcVoiceRuntime } from "../../../src/apps/api/bootstrap/web-rtc-voice-runtime.js";
import { createWebRtcVoicePlugin, defaultWebRtcVoiceConfig, encodePcmL16StreamToOpusRtpFrames, WebRtcVoiceError, type ServerAudioFrame } from "../../../src/channels/webrtc-voice/src/index.js";
import { createTalkRuntime } from "../../../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createTalkStore } from "../../../src/contexts/talk-session/src/adapters/sqlite-talk-session-store.js";
import { ControlledQueueTrack, DelayedEnqueueTrack, FakeAsrSession, FakeHangingAsrSession, FakePeer, RemotePlayingQueueTrack, collectVoiceTextInput, defaultConfig, fakeVoiceSynthesizer, makeTempDir, tempFilePath, waitFor } from "./webrtc-voice-plugin-helpers.js";

const path = await import("node:path");

test("WebRTC voice skips random voice-call filler after stable interrupt input is committed", async () => {
  const track = new ControlledQueueTrack();
  const batches: unknown[] = [];
  const statuses: Array<{ state: string; detail?: string }> = [];
  const sleeps: number[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => ({
      async createAnswer() {
        return "answer";
      },
      async createOutboundAudioTrack() {
        return track;
      },
      close() {}
    }),
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used with enqueueAudioFile track");
    },
    talkRuntime: {
      openSession() {},
      closeSession() {},
      ingestInput() {},
      interruptLatestOutput() {
        return { interruptId: "runtime-interrupt-filler" };
      },
      commitStableInputBatch(batch) {
        batches.push(batch);
      }
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-filler-after-stable", userId: "browser-filler-after-stable", offerSdp: "offer" });
  await call.interrupt("manual");
  assert.equal(track.enqueued.length, 0);

  await call.acceptTextInput?.("はい");

  await waitFor(() => batches.length === 1);
  assert.deepEqual(sleeps, [3_000]);
  assert.equal(track.enqueued.length, 0);
  assert.equal(statuses.some((entry) => entry.state === "voice_call.filler_skipped" && entry.detail === "disabled"), true);
  assert.equal(statuses.some((entry) => entry.state === "voice_call.filler_queued"), false);
  await call.close("test_done");
});

test("WebRTC voice aggregates consecutive stable interrupt inputs within the settle window", async () => {
  const batches: unknown[] = [];
  const sleeps: Array<{ ms: number; resolve(): void }> = [];
  const latestInterrupts: string[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    talkRuntime: {
      openSession() {},
      closeSession() {},
      ingestInput() {
        throw new Error("settled interrupt input should be committed through a batch");
      },
      interruptLatestOutput(input) {
        latestInterrupts.push(input.reason);
        return { interruptId: `runtime-interrupt-${latestInterrupts.length}` };
      },
      commitStableInputBatch(batch) {
        batches.push(batch);
      }
    },
    sleep: async (ms) => {
      await new Promise<void>((resolve) => {
        sleeps.push({ ms, resolve });
      });
    }
  });

  const call = await plugin.createCall({ callId: "call-stable-settle-aggregate", userId: "browser-stable-settle-aggregate", offerSdp: "offer" });
  await call.interrupt("manual");
  await call.acceptTextInput?.("first");
  await waitFor(() => sleeps.length === 1);
  assert.equal(batches.length, 0);

  await call.interrupt("manual");
  await call.acceptTextInput?.("second");
  await waitFor(() => sleeps.length === 2);
  sleeps[0]!.resolve();
  await assert.rejects(() => waitFor(() => batches.length > 0, 50), /timeout waiting for condition/);

  sleeps[1]!.resolve();
  await waitFor(() => batches.length === 1);

  assert.deepEqual((batches[0] as { inputs: Array<{ interruptId: string; text: string }> }).inputs.map((input) => ({
    interruptId: input.interruptId,
    text: input.text
  })), [
    { interruptId: "runtime-interrupt-1", text: "first" },
    { interruptId: "runtime-interrupt-2", text: "second" }
  ]);
});

test("WebRTC voice commits noise for earlier pending interrupts when a later interrupt input finishes", async () => {
  const batches: unknown[] = [];
  const sleeps: Array<{ ms: number; resolve(): void }> = [];
  let interruptCount = 0;
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    talkRuntime: {
      openSession() {},
      closeSession() {},
      ingestInput() {
        throw new Error("settled interrupt input should be committed through a batch");
      },
      interruptLatestOutput() {
        interruptCount += 1;
        return { interruptId: `runtime-interrupt-${interruptCount}` };
      },
      commitStableInputBatch(batch) {
        batches.push(batch);
      }
    },
    sleep: async (ms) => {
      await new Promise<void>((resolve) => {
        sleeps.push({ ms, resolve });
      });
    }
  });

  const call = await plugin.createCall({ callId: "call-later-stable-fails-earlier", userId: "browser-later-stable-fails-earlier", offerSdp: "offer" });
  await call.interrupt("manual");
  await call.interrupt("manual");
  await call.acceptTextInput?.("second");

  await waitFor(() => sleeps.length === 1);
  sleeps[0]!.resolve();
  await waitFor(() => batches.length === 1);

  assert.deepEqual((batches[0] as { inputs: Array<{ interruptId: string; reason: string; text: string }> }).inputs.map((input) => ({
    interruptId: input.interruptId,
    reason: input.reason,
    text: input.text
  })), [
    { interruptId: "runtime-interrupt-1", reason: "asr_failure", text: "-杂音-" },
    { interruptId: "runtime-interrupt-2", reason: "manual", text: "second" }
  ]);
  await call.close("test_done");
});

test("WebRTC voice barge-in before consumer has audio interrupts latest output", async () => {
  const latestInterrupts: Array<{ reason?: string; omitAssistantMessage?: boolean }> = [];
  let resolveVoice!: () => void;
  const voiceReady = new Promise<void>((resolve) => {
    resolveVoice = resolve;
  });
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      await voiceReady;
      return { assetId: "generated/tts/queued.opus", filePath: tempFilePath("queued.opus") };
    }, {}),
    decodeAudioFileToFrames: async () => [
      { sequence: 0, pcm: new Int16Array([17]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ],
    talkRuntime: {
      openSession() {},
      closeSession() {},
      ingestInput() {},
      interruptLatestOutput(input) {
        latestInterrupts.push({
          reason: input.reason,
          omitAssistantMessage: input.omitAssistantMessage
        });
      }
    }
  });

  const call = await plugin.createCall({ callId: "call-between-segments", userId: "browser-between-segments", offerSdp: "offer" });
  const playback = call.playReplyText("第二段已经生成但还没有开始播放。", "output-17");

  await call.setSpeechActive(true);
  await waitFor(() => latestInterrupts.length === 1);

  assert.deepEqual(latestInterrupts, [{ reason: "barge_in", omitAssistantMessage: true }]);
  resolveVoice();
  assert.equal((await playback).status, "interrupted");
  await call.close("test_done");
});

test("WebRTC voice continues claiming TalkRuntime output during interrupt handling", async () => {
  const peer = new FakePeer();
  const claimedChunks: string[] = [];
  const synthesizedTexts: string[] = [];
  let resolveInterrupt!: () => void;
  const interruptDone = new Promise<void>((resolve) => {
    resolveInterrupt = resolve;
  });
  let releasePlaybackSleep!: () => void;
  const playbackSleep = new Promise<void>((resolve) => {
    releasePlaybackSleep = resolve;
  });
  let interruptStarted = false;
  const chunks = [
    { sessionId: 0, outputId: "output-1", chunkId: "chunk-1", text: "第一段。" },
    { sessionId: 0, outputId: "output-2", chunkId: "chunk-2", text: "第二段。" }
  ];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async ({ text }: { text: string }) => {
      synthesizedTexts.push(text);
      return { assetId: text, filePath: tempFilePath(`${text}.opus`) };
    }, {}),
    decodeAudioFileToFrames: async (input) => [
      { sequence: 0, pcm: new Int16Array([input.filePath.includes("第二段") ? 2 : 1]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ],
    talkRuntime: {
      openSession() {},
      ingestInput() {},
      closeSession() {},
      markAgentLoopReady() {},
      claimReadyOutputChunk(sessionId: number) {
        const chunk = chunks.shift();
        if (!chunk) return undefined;
        claimedChunks.push(chunk.chunkId);
        return { ...chunk, sessionId };
      },
      async interruptOutput() {
        interruptStarted = true;
        await interruptDone;
      }
    },
    sleep: async (ms) => {
      if (ms === 20) await playbackSleep;
    }
  });

  const call = await plugin.createCall({ callId: "call-pause-pump", userId: "browser-pause-pump", offerSdp: "offer" });
  await waitFor(() => claimedChunks.length >= 1);
  call.interrupt("manual");
  assert.equal(claimedChunks.length > 0, true);

  resolveInterrupt();
  releasePlaybackSleep();
  await waitFor(() => claimedChunks.length === 2 && synthesizedTexts.length === 2);
  assert.equal(synthesizedTexts.length, 2);
  await call.close("test_done");
});
