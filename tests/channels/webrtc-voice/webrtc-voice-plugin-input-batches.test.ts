import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebRtcVoiceRuntime } from "../../../src/apps/api/bootstrap/web-rtc-voice-runtime.js";
import { createWebRtcVoicePlugin, defaultWebRtcVoiceConfig, encodePcmL16StreamToOpusRtpFrames, WebRtcVoiceError, type ServerAudioFrame } from "../../../src/channels/webrtc-voice/src/index.js";
import { createTalkRuntime } from "../../../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createTalkStore } from "../../../src/contexts/talk-session/src/adapters/sqlite-talk-session-store.js";
import { ControlledQueueTrack, DelayedEnqueueTrack, FakeAsrSession, FakeHangingAsrSession, FakePeer, RemotePlayingQueueTrack, collectVoiceTextInput, defaultConfig, fakeVoiceSynthesizer, makeTempDir, tempFilePath, waitFor } from "./webrtc-voice-plugin-helpers.js";

const path = await import("node:path");

test("WebRTC voice starts barge-in batch on speech start", async () => {
  const { call, latestInterrupts, statuses } = await createBargeInBatchScenario();

  await call.setSpeechActive(true);

  assert.deepEqual(latestInterrupts, [{ reason: "barge_in", omitAssistantMessage: true }]);
  assert.equal(statuses.some((entry) => entry.state === "tts.barge_in"), true);
});

test("WebRTC voice commits ASR final as the barge-in batch result", async () => {
  const { call, batches, statuses } = await createBargeInBatchScenario();

  await call.setSpeechActive(true);
  await call.setSpeechActive(false);

  await waitFor(() => batches.length === 1);
  assert.deepEqual((batches[0] as { inputs: Array<{ interruptId: string; reason: string; text: string; asrStreamId?: string }> }).inputs.map((input) => ({
    interruptId: input.interruptId,
    reason: input.reason,
    text: input.text,
    asrStreamId: input.asrStreamId
  })), [{ interruptId: "runtime-interrupt-barge-batch", reason: "barge_in", text: "もしもし", asrStreamId: "asr-call-barge-batch-0" }]);
  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.stable_batch" && entry.detail?.endsWith(":1")), true);
});

test("WebRTC voice ASR partial extends active stream interrupt timeout", async () => {
  const statuses: Array<{ state: string; detail?: string }> = [];
  const asr = new FakeAsrSession([
    { ok: true, type: "partial", streamId: "asr-call-barge-partial-0", text: "もし", stable: false }
  ]);
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => asr,
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    talkRuntime: {
      openSession() {},
      closeSession() {},
      ingestInput() {},
      interruptLatestOutput() {
        return { interruptId: "runtime-interrupt-barge-partial" };
      }
    },
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-barge-partial", userId: "browser-barge-partial", offerSdp: "offer" });
  await call.setSpeechActive(true);
  await call.acceptInboundAudioChunk(new Uint8Array([1, 2]), { startMs: 0, endMs: 100, durationMs: 100 });

  assert.equal(statuses.some((entry) => entry.state === "asr.partial" && entry.detail === "もし"), true);
  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.stable_input_timeout_extended" && entry.detail === "runtime-interrupt-barge-partial"), true);
});

test("WebRTC voice commits typed final text into the active manual interrupt batch", async () => {
  const latestInterrupts: Array<{ reason?: string; omitAssistantMessage?: boolean }> = [];
  const batches: unknown[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    talkRuntime: {
      openSession() {},
      ingestInput() {
        throw new Error("typed final should be committed through interrupt batch");
      },
      closeSession() {},
      interruptLatestOutput(input) {
        latestInterrupts.push({ reason: input.reason, omitAssistantMessage: input.omitAssistantMessage });
      },
      commitStableInputBatch(batch) {
        batches.push(batch);
      }
    },
    sleep: async () => {}
  });

  const call = await plugin.createCall({ callId: "call-typed-batch", userId: "browser-typed-batch", offerSdp: "offer" });
  await call.interrupt("manual");
  await call.acceptTextInput?.("typed final");

  assert.deepEqual(latestInterrupts, [{ reason: "manual", omitAssistantMessage: false }]);
  await waitFor(() => batches.length === 1);
  assert.deepEqual((batches[0] as { inputs: Array<{ reason: string; text: string; asrStreamId?: string }> }).inputs.map((input) => ({
    reason: input.reason,
    text: input.text,
    asrStreamId: input.asrStreamId
  })), [{ reason: "manual", text: "typed final", asrStreamId: "asr-call-typed-batch-0" }]);
});

test("WebRTC voice finalizes active typed interrupt without creating a second interrupt while remote playback still reports playing", async () => {
  const track = new RemotePlayingQueueTrack({
    outputId: "typed-output",
    playbackTextCache: "assistant still playing",
    playedMs: 10,
    totalMs: 100,
    status: "playing"
  });
  const interrupts: string[] = [];
  const batches: unknown[] = [];
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
    decodeAudioFileToFrames: async () => [],
    talkRuntime: {
      openSession() {},
      ingestInput() {
        throw new Error("typed final should be committed through interrupt batch");
      },
      closeSession() {},
      interruptOutput(input) {
        interrupts.push(input.outputId);
        return { interruptId: `runtime-interrupt-${interrupts.length}` };
      },
      commitStableInputBatch(batch) {
        batches.push(batch);
      }
    },
    sleep: async () => {}
  });

  const call = await plugin.createCall({ callId: "call-typed-stream-playing", userId: "browser-typed-stream-playing", offerSdp: "offer" });
  await call.interrupt("manual");
  await call.acceptTextInput?.("typed final");

  assert.deepEqual(interrupts, ["typed-output"]);
  await waitFor(() => batches.length === 1);
  assert.deepEqual((batches[0] as { inputs: Array<{ interruptId: string; reason: string; text: string }> }).inputs.map((input) => ({
    interruptId: input.interruptId,
    reason: input.reason,
    text: input.text
  })), [{ interruptId: "runtime-interrupt-1", reason: "manual", text: "typed final" }]);
});

test("WebRTC voice text draft extends active typed interrupt timeout without committing input", async () => {
  const statuses: Array<{ state: string; detail?: string }> = [];
  const batches: unknown[] = [];
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
        throw new Error("draft text should not be ingested");
      },
      interruptLatestOutput() {
        return { interruptId: "runtime-interrupt-draft" };
      },
      commitStableInputBatch(batch) {
        batches.push(batch);
      }
    },
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-typed-draft", userId: "browser-typed-draft", offerSdp: "offer" });
  await call.interrupt("manual");
  await call.acceptTextDraft?.("draft text");

  assert.equal(batches.length, 0);
  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.stable_input_timeout_extended" && entry.detail === "runtime-interrupt-draft"), true);
});

test("WebRTC voice closes an active manual interrupt batch when typed input is withdrawn", async () => {
  const batches: unknown[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    talkRuntime: {
      openSession() {},
      ingestInput() {
        throw new Error("withdrawn typed final should be committed through interrupt batch");
      },
      closeSession() {},
      interruptLatestOutput() {},
      commitStableInputBatch(batch) {
        batches.push(batch);
      }
    },
    sleep: async () => {}
  });

  const call = await plugin.createCall({ callId: "call-typed-withdrawn", userId: "browser-typed-withdrawn", offerSdp: "offer" });
  await call.interrupt("manual");
  await call.acceptTextInput?.("");

  await waitFor(() => batches.length === 1);
  assert.deepEqual((batches[0] as { inputs: Array<{ reason: string; text: string; asrStreamId?: string }> }).inputs.map((input) => ({
    reason: input.reason,
    text: input.text,
    asrStreamId: input.asrStreamId
  })), [{ reason: "manual", text: "-已撤回-", asrStreamId: "asr-call-typed-withdrawn-0" }]);
});

test("WebRTC voice ignores empty typed input when no interrupt batch is active", async () => {
  const ingested: unknown[] = [];
  const batches: unknown[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    talkRuntime: {
      openSession() {},
      ingestInput(input) {
        ingested.push(input);
      },
      closeSession() {},
      commitStableInputBatch(batch) {
        batches.push(batch);
      }
    },
    sleep: async () => {}
  });

  const call = await plugin.createCall({ callId: "call-empty-no-batch", userId: "browser-empty-no-batch", offerSdp: "offer" });
  await call.acceptTextInput?.("");

  assert.deepEqual(ingested, []);
  assert.deepEqual(batches, []);
});

test("WebRTC voice treats iOS dictation placeholder-only typed input as empty", async () => {
  const ingested: unknown[] = [];
  const batches: unknown[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    talkRuntime: {
      openSession() {},
      ingestInput(input) {
        ingested.push(input);
      },
      closeSession() {},
      commitStableInputBatch(batch) {
        batches.push(batch);
      }
    },
    sleep: async () => {}
  });

  const call = await plugin.createCall({ callId: "call-ios-dictation-empty", userId: "browser-ios-dictation-empty", offerSdp: "offer" });
  await call.acceptTextInput?.("\uFFFC\u200B\u200C\u200D\u2060\uFEFF");

  assert.deepEqual(ingested, []);
  assert.deepEqual(batches, []);
});

test("WebRTC voice closes active manual interrupt batch for iOS dictation placeholder-only final", async () => {
  const batches: unknown[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    talkRuntime: {
      openSession() {},
      ingestInput() {
        throw new Error("placeholder-only typed final should close the active interrupt batch");
      },
      closeSession() {},
      interruptLatestOutput() {},
      commitStableInputBatch(batch) {
        batches.push(batch);
      }
    },
    sleep: async () => {}
  });

  const call = await plugin.createCall({ callId: "call-ios-dictation-withdrawn", userId: "browser-ios-dictation-withdrawn", offerSdp: "offer" });
  await call.interrupt("manual");
  await call.acceptTextInput?.("\uFFFC\u200B\u200C\u200D\u2060\uFEFF");

  await waitFor(() => batches.length === 1);
  assert.deepEqual((batches[0] as { inputs: Array<{ reason: string; text: string; asrStreamId?: string }> }).inputs.map((input) => ({
    reason: input.reason,
    text: input.text,
    asrStreamId: input.asrStreamId
  })), [{ reason: "manual", text: "-已撤回-", asrStreamId: "asr-call-ios-dictation-withdrawn-0" }]);
});

test("WebRTC voice times out ASR final and commits interrupt batch as noise", async () => {
  const statuses: Array<{ state: string; detail?: string }> = [];
  const batches: unknown[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: {
      ...defaultConfig,
      timeouts: {
        ...defaultConfig.timeouts,
        asrFinalMs: 1
      }
    },
    createPeer: async () => new FakePeer(),
    createAsrSession: () => new FakeHangingAsrSession(),
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    talkRuntime: {
      openSession() {},
      ingestInput() {
        throw new Error("timed out barge-in final should be committed through interrupt batch");
      },
      closeSession() {},
      interruptLatestOutput() {},
      commitStableInputBatch(batch) {
        batches.push(batch);
      }
    },
    sleep: async () => {},
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-asr-final-timeout", userId: "browser-asr-final-timeout", offerSdp: "offer" });
  await call.setSpeechActive(true);
  const result = await call.setSpeechActive(false);

  assert.equal(result, undefined);
  assert.equal(statuses.some((entry) => entry.state === "asr.final.timeout" && entry.detail === "asr-call-asr-final-timeout-0:1"), true);
  await waitFor(() => batches.length === 1);
  assert.deepEqual((batches[0] as { inputs: Array<{ reason: string; text: string; asrStreamId?: string }> }).inputs.map((input) => ({
    reason: input.reason,
    text: input.text,
    asrStreamId: input.asrStreamId
  })), [{ reason: "asr_failure", text: "-杂音-", asrStreamId: "asr-call-asr-final-timeout-0" }]);
});

test("WebRTC voice marks stable batch commit failure and reopens playback gate", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  const asr = new FakeAsrSession([
    {
      ok: true,
      type: "final",
      streamId: "asr-call-batch-failure-0",
      result: {
        text: "もしもし",
        provider: "tencent"
      }
    }
  ]);
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => asr,
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [
      { sequence: 0, pcm: new Int16Array([8]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ],
    talkRuntime: {
      openSession() {},
      ingestInput() {},
      closeSession() {},
      interruptLatestOutput() {},
      commitStableInputBatch() {
        throw new Error("commit failed");
      }
    },
    sleep: async () => {},
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-batch-failure", userId: "browser-batch-failure", offerSdp: "offer" });
  await call.setSpeechActive(true);
  await call.setSpeechActive(false);
  await waitFor(() => statuses.some((entry) => entry.state === "talk_runtime.stable_batch.failed"));
  const playback = await call.playReplyText("gate reopened", "after-batch-failure");

  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.stable_batch.failed" && entry.detail?.includes("commit failed")), true);
  assert.equal(playback.status, "played");
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[8]]);
});

async function createBargeInBatchScenario() {
  const statuses: Array<{ state: string; detail?: string }> = [];
  const latestInterrupts: Array<{ reason?: string; omitAssistantMessage?: boolean }> = [];
  const batches: unknown[] = [];
  const asr = new FakeAsrSession([
    {
      ok: true,
      type: "final",
      streamId: "asr-call-barge-batch-0",
      result: {
        text: "もしもし",
        provider: "tencent"
      }
    }
  ]);
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => asr,
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    talkRuntime: {
      openSession() {},
      ingestInput() {
        throw new Error("final should be committed through interrupt batch");
      },
      closeSession() {},
      interruptLatestOutput(input) {
        latestInterrupts.push({ reason: input.reason, omitAssistantMessage: input.omitAssistantMessage });
        return { interruptId: "runtime-interrupt-barge-batch" };
      },
      commitStableInputBatch(batch) {
        batches.push(batch);
      }
    },
    sleep: async () => {},
    emitStatus: (event) => statuses.push(event)
  });
  const call = await plugin.createCall({ callId: "call-barge-batch", userId: "browser-barge-batch", offerSdp: "offer" });
  return { batches, call, latestInterrupts, statuses };
}
