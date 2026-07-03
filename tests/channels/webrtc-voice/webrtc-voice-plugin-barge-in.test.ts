import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebRtcVoiceRuntime } from "../../../src/apps/api/bootstrap/web-rtc-voice-runtime.js";
import { createWebRtcVoicePlugin, defaultWebRtcVoiceConfig, encodePcmL16StreamToOpusRtpFrames, WebRtcVoiceError, type ServerAudioFrame } from "../../../src/channels/webrtc-voice/src/index.js";
import { createTalkRuntime } from "../../../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createTalkStore } from "../../../src/contexts/talk-session/src/adapters/sqlite-talk-session-store.js";
import { ControlledQueueTrack, DelayedEnqueueTrack, FakeAsrSession, FakeHangingAsrSession, FakePeer, RemotePlayingQueueTrack, collectVoiceTextInput, defaultConfig, fakeVoiceSynthesizer, makeTempDir, tempFilePath, waitFor } from "./webrtc-voice-plugin-helpers.js";

const path = await import("node:path");

test("WebRTC voice automatically interrupts pseudo-streaming TTS when user starts speaking", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  const synthesizedTexts: string[] = [];
  let call: any;
  let sleeps = 0;
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async ({ text }: { text: string }) => {
      synthesizedTexts.push(text);
      return { assetId: `generated/tts/${synthesizedTexts.length}.opus`, filePath: tempFilePath(`${synthesizedTexts.length}.opus`) };
    }, {}),
    decodeAudioFileToFrames: async () => [
      { sequence: 0, pcm: new Int16Array([synthesizedTexts.length]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ],
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) await call.setSpeechActive(true);
    },
    emitStatus: (event) => statuses.push(event)
  });

  call = await plugin.createCall({ callId: "call-6", userId: "browser-6", offerSdp: "offer" });
  const result = await call.playReplyText("第一句。第二句。", "barge-output");

  assert.equal(result.status, "interrupted");
  assert.deepEqual(synthesizedTexts, ["第一句。第二句。"]);
  assert.equal(statuses.some((entry) => entry.state === "tts.barge_in" && entry.detail === "barge-output"), true);
  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.interrupt.todo" && entry.detail === "barge_in:barge-output"), true);
});

test("WebRTC voice waits for one playReplyText output before playback", async () => {
  const peer = new FakePeer();
  let releaseSecondPart!: () => void;
  const secondPartReady = new Promise<void>((resolve) => {
    releaseSecondPart = resolve;
  });
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async ({ text }: { text: string }) => {
      if (text.includes("第二")) await secondPartReady;
      return { assetId: `generated/tts/${text}.opus`, filePath: tempFilePath(`${text}.opus`) };
    }, {}),
    decodeAudioFileToFrames: async (input) => [
      { sequence: 0, pcm: new Int16Array([input.filePath.includes("第一") ? 1 : 2]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ]
  });

  const call = await plugin.createCall({ callId: "call-first-part-immediate", userId: "browser-first-part-immediate", offerSdp: "offer" });
  const playback = call.playReplyText("第一句。第二句。", "part-output");
  await assert.rejects(() => waitFor(() => (peer.outboundTrack?.frames.length ?? 0) > 0, 50), /timeout waiting for condition/);

  releaseSecondPart();
  assert.equal((await playback).status, "played");
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[1]]);
  await call.close("test_done");
});

test("WebRTC voice keeps consecutive interrupts isolated in the interrupt queue", async () => {
  const peer = new FakePeer();
  const interrupts: string[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async ({ text }: { text: string }) => {
      return { assetId: `generated/tts/${text}.opus`, filePath: tempFilePath(`${text}.opus`) };
    }, {}),
    decodeAudioFileToFrames: async () => [
      { sequence: 0, pcm: new Int16Array([1]), sampleRateHz: 48000, channels: 1, durationMs: 20 },
      { sequence: 1, pcm: new Int16Array([2]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ],
    talkRuntime: {
      openSession() {},
      closeSession() {},
      ingestInput() {},
      interruptOutput(input) {
        interrupts.push(input.outputId);
      }
    }
  });

  const call = await plugin.createCall({ callId: "call-consecutive-interrupts", userId: "browser-consecutive-interrupts", offerSdp: "offer" });
  const first = call.playReplyText("第一句。", "output-first");
  await waitFor(() => (peer.outboundTrack?.frames.length ?? 0) >= 1);
  await call.interrupt("manual", "output-first");
  assert.equal((await first).status, "interrupted");

  const second = call.playReplyText("第二句。", "output-second");
  await call.interrupt("manual", "output-second");

  assert.equal((await second).status, "interrupted");
  assert.deepEqual(interrupts, ["output-first", "output-second"]);
  await call.close("test_done");
});

test("WebRTC voice passes playback timing to TalkRuntime on barge-in", async () => {
  const peer = new FakePeer();
  let call: any;
  let sleeps = 0;
  const interrupts: Array<{ elapsedMs?: number; totalMs?: number }> = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async ({ text }: { text: string }) => {
      return { assetId: `generated/tts/${text}.opus`, filePath: tempFilePath(`${text}.opus`) };
    }, {}),
    decodeAudioFileToFrames: async () => [
      { sequence: 0, pcm: new Int16Array([1]), sampleRateHz: 48000, channels: 1, durationMs: 20 },
      { sequence: 1, pcm: new Int16Array([2]), sampleRateHz: 48000, channels: 1, durationMs: 20 },
      { sequence: 2, pcm: new Int16Array([3]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ],
    talkRuntime: {
      openSession() {},
      ingestInput() {},
      closeSession() {},
      interruptOutput(input) {
        interrupts.push({ elapsedMs: input.elapsedMs, totalMs: input.totalMs });
      }
    },
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) await call.setSpeechActive(true);
    }
  });

  call = await plugin.createCall({ callId: "call-barge-timing", userId: "browser-barge-timing", offerSdp: "offer" });
  const result = await call.playReplyText("第一句。", "timed-output");

  assert.equal(result.status, "interrupted");
  assert.deepEqual(interrupts, [{ elapsedMs: 0, totalMs: 60 }]);
});
