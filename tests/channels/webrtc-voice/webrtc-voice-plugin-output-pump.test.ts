import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebRtcVoiceRuntime } from "../../../src/apps/api/bootstrap/web-rtc-voice-runtime.js";
import { createWebRtcVoicePlugin, defaultWebRtcVoiceConfig, encodePcmL16StreamToOpusRtpFrames, WebRtcVoiceError, type ServerAudioFrame } from "../../../src/channels/webrtc-voice/src/index.js";
import { createTalkRuntime } from "../../../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createTalkStore } from "../../../src/contexts/talk-session/src/adapters/sqlite-talk-session-store.js";
import { ControlledQueueTrack, DelayedEnqueueTrack, FakeAsrSession, FakeHangingAsrSession, FakePeer, RemotePlayingQueueTrack, collectVoiceTextInput, defaultConfig, fakeVoiceSynthesizer, makeTempDir, tempFilePath, waitFor } from "./webrtc-voice-plugin-helpers.js";

const path = await import("node:path");

test("WebRTC voice waits for TalkRuntime output before TTS synthesis", async () => {
  const scenario = await createRuntimeOutputScenario();

  assert.equal(scenario.statuses.some((entry) => entry.state === "voice_call.waiting" && entry.detail === String(scenario.call.talkSessionId)), true);
  await waitFor(() => scenario.synthesizedTexts.length === 1);
  assert.deepEqual(scenario.startedLoops, [scenario.call.talkSessionId]);
  assert.deepEqual(scenario.synthesizedTexts, ["接通测试。"]);
  await scenario.call.close("test_done");
});

test("WebRTC voice reports connected after first TTS audio", async () => {
  const scenario = await createRuntimeOutputScenario();

  await waitFor(() => scenario.statuses.some((entry) => entry.state === "voice_call.connected" && entry.detail === String(scenario.call.talkSessionId)));
  assert.deepEqual(scenario.playedChunks, []);
  await scenario.call.close("test_done");
});

test("WebRTC voice delays playback and writes frames", async () => {
  const scenario = await createRuntimeOutputScenario();

  await waitFor(() => (scenario.peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).length ?? 0) === 1);
  assert.equal(scenario.sleeps.includes(20), true);
  assert.deepEqual(scenario.peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[7]]);
  await scenario.call.close("test_done");
});

test("WebRTC voice claims next TalkRuntime chunk after current TTS stream finishes before playback ends", async () => {
  const peer = new FakePeer();
  const claimedChunks: string[] = [];
  const synthesizedTexts: string[] = [];
  const sleeps: number[] = [];
  let releasePlaybackSleep!: () => void;
  const playbackSleep = new Promise<void>((resolve) => {
    releasePlaybackSleep = resolve;
  });
  const chunks = [
    { sessionId: 0, outputId: "output-1", chunkId: "chunk-1", text: "第一段。" },
    { sessionId: 0, outputId: "output-2", chunkId: "chunk-2", text: "第二段。" }
  ];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream({ text, onInputBufferIdle }: { text: AsyncIterable<string> | string; onInputBufferIdle?: () => void | Promise<void> }) {
        assert.notEqual(typeof text, "string");
        synthesizedTexts.push(await collectVoiceTextInput(text));
        await onInputBufferIdle?.();
        yield { type: "audio" as const, sequence: 0, text: "原文播放片段", chunk: new Uint8Array([1, 2]), contentType: "audio/L16; rate=32000; channels=1" };
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
      }
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      if (ms > 0) await playbackSleep;
    }
  });

  const call = await plugin.createCall({ callId: "call-overlap", userId: "browser-overlap", offerSdp: "offer" });
  await waitFor(() => claimedChunks.length === 2 && synthesizedTexts.length === 2, 2_000);

  assert.deepEqual(claimedChunks, ["chunk-1", "chunk-2"]);
  assert.deepEqual(synthesizedTexts, ["第一段。", "第二段。"]);
  assert.equal(sleeps.filter((ms) => ms === 20).length <= 1, true);

  releasePlaybackSleep();
  await call.close("test_done");
});

test("WebRTC voice barge-in uses playback consumer text when next queued chunk has no audio yet", async () => {
  const peer = new FakePeer();
  const claimedChunks: string[] = [];
  const synthesizedTexts: string[] = [];
  const statuses: Array<{ state: string; detail?: string }> = [];
  const interrupts: Array<{ outputId: string; elapsedMs?: number; totalMs?: number; beforeText?: string; afterText?: string }> = [];
  const chunks = [
    { sessionId: 0, outputId: "output-1", chunkId: "chunk-1", text: "啊——！老板！电话通了通了！" },
    { sessionId: 0, outputId: "output-2", chunkId: "chunk-2", text: "第二段还在翻译后等待音频。" }
  ];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream({ text, onInputBufferIdle }: { text: AsyncIterable<string> | string; onInputBufferIdle?: () => void | Promise<void> }) {
        assert.notEqual(typeof text, "string");
        const inputText = await collectVoiceTextInput(text);
        synthesizedTexts.push(inputText);
        await onInputBufferIdle?.();
        if (inputText === "啊——！老板！电话通了通了！") {
          yield { type: "audio" as const, sequence: 0, text: inputText, chunk: new Uint8Array(1_280), contentType: "audio/L16; rate=32000; channels=1" };
          yield { type: "done" as const };
          return;
        }
        yield { type: "translation_started" as const, sequence: 0, sourceChars: inputText.length };
        yield { type: "translation_done" as const, sequence: 0, translatedChars: inputText.length };
        await new Promise<void>(() => undefined);
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      for await (const _chunk of input.chunks) {
        yield { sequence: 0, pcm: new Int16Array([1]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
      }
    },
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
      interruptOutput(input) {
        interrupts.push({
          outputId: input.outputId,
          elapsedMs: input.elapsedMs,
          totalMs: input.totalMs,
          beforeText: input.breakpointContext?.beforeText,
          afterText: input.breakpointContext?.afterText
        });
      }
    },
    sleep: async () => {},
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-consumer-target", userId: "browser-consumer-target", offerSdp: "offer" });
  await waitFor(() => claimedChunks.length === 2 && synthesizedTexts.length === 2 && (peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).length ?? 0) >= 1, 2_000);
  await call.setSpeechActive(true);

  assert.deepEqual(claimedChunks, ["chunk-1", "chunk-2"]);
  assert.equal(statuses.some((entry) => entry.state === "tts.stream.translation_done"), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.barge_in" && entry.detail === "output-1"), true);
  assert.equal(interrupts.length, 1);
  assert.equal(interrupts[0]?.outputId, "output-1");
  assert.equal(interrupts[0]?.totalMs, 20);
  assert.equal(interrupts[0]?.beforeText ?? interrupts[0]?.afterText, "啊——！老板！电话通了通了！");
  await call.close("test_done");
});

test("WebRTC voice closes the call after current TTS stream failure", async () => {
  const scenario = await createStreamFailureScenario();

  await waitFor(() => scenario.statuses.some((entry) => entry.state === "talk_runtime.close" && entry.detail === "tts_failed"), 2_000);
  assert.equal(scenario.peer.closed, true);
});

test("WebRTC voice does not synthesize later TalkRuntime chunks after current TTS stream failure", async () => {
  const scenario = await createStreamFailureScenario();

  await waitFor(() => scenario.claimedChunks.length === 2 && scenario.statuses.some((entry) => entry.state === "voice_call.output_pump.playback_failed"));
  assert.deepEqual(scenario.claimedChunks, ["chunk-1", "chunk-2"]);
  assert.deepEqual(scenario.synthesizedTexts, ["第一段。"]);
});

test("WebRTC voice writes no frames for a failed current TTS stream", async () => {
  const scenario = await createStreamFailureScenario();

  await waitFor(() => scenario.statuses.some((entry) => entry.state === "voice_call.output_pump.playback_failed" && entry.detail === "stream failed"));
  assert.deepEqual(scenario.peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), []);
});

test("WebRTC voice feeds buffered TalkRuntime output into one TTS plugin stream", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  const streamedText: string[] = [];
  let streamCalls = 0;
  const outputs = [
    { sessionId: 0, outputId: "output-buffered", text: "碎块一", status: "streaming" },
    { sessionId: 0, outputId: "output-buffered", text: "二三", status: "streaming" },
    { sessionId: 0, outputId: "output-buffered", text: "四五六", status: "streaming" },
    { sessionId: 0, outputId: "output-buffered", text: "七八\n", status: "finished" }
  ];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream({ text }: { text: AsyncIterable<string> }) {
        streamCalls += 1;
        for await (const part of text) streamedText.push(part);
        yield { type: "audio" as const, sequence: 0, text: streamedText.join(""), chunk: new Uint8Array([1, 2]), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      for await (const _chunk of input.chunks) {
        yield { sequence: 0, pcm: new Int16Array([1]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
      }
    },
    talkRuntime: {
      openSession() {},
      ingestInput() {},
      closeSession() {},
      markAgentLoopReady() {},
      claimBufferedOutputText(sessionId: number) {
        const output = outputs.shift();
        return output ? { ...output, sessionId } : undefined;
      }
    },
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-buffered-stream", userId: "browser-buffered-stream", offerSdp: "offer" });

  await waitFor(() => streamedText.length === 4);
  assert.equal(streamCalls, 1);
  assert.deepEqual(streamedText, ["碎块一", "二三", "四五六", "七八\n"]);
  assert.equal(statuses.filter((entry) => entry.state === "tts.stream.started").length, 1);

  await call.close("test_done");
});

test("WebRTC voice skips finished blank buffered output without starting empty TTS playback", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  const streamedText: string[] = [];
  let streamCalls = 0;
  const outputs = [
    { sessionId: 0, outputId: "output-blank-finish", text: "第一段。", status: "streaming" },
    { sessionId: 0, outputId: "output-blank-finish", text: "\n", status: "finished" }
  ];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream({ text }: { text: AsyncIterable<string> }) {
        streamCalls += 1;
        for await (const part of text) streamedText.push(part);
        yield { type: "audio" as const, sequence: 0, text: streamedText.join(""), chunk: new Uint8Array([1, 2]), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      for await (const _chunk of input.chunks) {
        yield { sequence: 0, pcm: new Int16Array([1]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
      }
    },
    talkRuntime: {
      openSession() {},
      ingestInput() {},
      closeSession() {},
      markAgentLoopReady() {},
      claimBufferedOutputText(sessionId: number) {
        const output = outputs.shift();
        return output ? { ...output, sessionId } : undefined;
      }
    },
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-blank-finish", userId: "browser-blank-finish", offerSdp: "offer" });

  await waitFor(() => statuses.some((entry) => entry.state === "voice_call.output_empty_skipped"));
  await waitFor(() => (peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).length ?? 0) === 1);
  assert.equal(streamCalls, 1);
  assert.deepEqual(streamedText, ["第一段。"]);
  assert.equal(statuses.some((entry) => entry.state === "voice_call.tts_fatal"), false);
  assert.equal(statuses.some((entry) => entry.state === "tts.failed"), false);
  assert.equal(peer.closed, false);

  await call.close("test_done");
});

test("WebRTC voice waits for remote worker playback idle before requesting foreground idle ACK", async () => {
  const scenario = await createRemoteIdleScenario();

  await waitFor(() => scenario.track.enqueued.length === 1 && scenario.track.waitingSettlements === 1);
  scenario.track.settle(0, { itemId: scenario.track.enqueued[0]!.itemId, status: "played", framesWritten: 1, playedMs: 20, totalMs: 20 });
  await waitFor(() => scenario.track.waitingIdleResolvers === 1);
  assert.equal(scenario.statuses.some((entry) => entry.state === "voice_call.playback_idle_ack.request"), false);
  scenario.track.resolveIdle();
  await waitFor(() => scenario.statuses.some((entry) => entry.state === "voice_call.playback_idle_ack.request"));
  await scenario.call.close("test_done");
});

test("WebRTC voice waits for frontend ACK before marking TalkRuntime idle", async () => {
  const scenario = await createRemoteIdleScenario();

  await waitFor(() => scenario.track.enqueued.length === 1 && scenario.track.waitingSettlements === 1);
  scenario.track.settle(0, { itemId: scenario.track.enqueued[0]!.itemId, status: "played", framesWritten: 1, playedMs: 20, totalMs: 20 });
  await waitFor(() => scenario.track.waitingIdleResolvers === 1);
  scenario.track.resolveIdle();
  await waitFor(() => scenario.statuses.some((entry) => entry.state === "voice_call.playback_idle_ack.request"));
  assert.deepEqual(scenario.foregroundIdle, []);

  const request = scenario.statuses.find((entry) => entry.state === "voice_call.playback_idle_ack.request");
  const ackId = JSON.parse(request?.detail ?? "{}").ackId;
  assert.equal(typeof ackId, "string");
  scenario.call.ackPlaybackIdle?.(ackId);
  await waitFor(() => scenario.foregroundIdle.length === 1);
  assert.deepEqual(scenario.foregroundIdle, [scenario.call.talkSessionId]);
  await scenario.call.close("test_done");
});

async function createRuntimeOutputScenario() {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  const sleeps: number[] = [];
  const synthesizedTexts: string[] = [];
  const startedLoops: number[] = [];
  const playedChunks: string[] = [];
  let claimed = false;
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream({ text, onInputBufferIdle }: { text: AsyncIterable<string> | string; onInputBufferIdle?: () => void | Promise<void> }) {
        synthesizedTexts.push(await collectVoiceTextInput(text));
        await onInputBufferIdle?.();
        yield { type: "audio_file" as const, sequence: 0, text: synthesizedTexts.at(-1), assetId: "asset-runtime-output", filePath: "/tmp/runtime-output.wav" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      return [{ sequence: 0, pcm: new Int16Array([7]), sampleRateHz: 48000, channels: 1, durationMs: 20 }];
    },
    encodePcmL16StreamToFrames: async function* (input) {
      for await (const _chunk of input.chunks) {
        yield { sequence: 0, pcm: new Int16Array([7]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
      }
    },
    talkRuntime: {
      openSession() {},
      ingestInput() {},
      closeSession() {},
      markAgentLoopReady(sessionId: number) {
        startedLoops.push(sessionId);
      },
      claimReadyOutputChunk(sessionId: number) {
        if (claimed) return undefined;
        claimed = true;
        return {
          sessionId,
          outputId: "output-greeting",
          chunkId: "chunk-greeting",
          text: "接通测试。",
          outputTextLength: 5
        };
      },
      markOutputChunkPlayed(input: { sessionId: number; chunkId: string }) {
        playedChunks.push(`${input.sessionId}:${input.chunkId}`);
      }
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    emitStatus: (event) => statuses.push(event)
  });
  const call = await plugin.createCall({ callId: "call-runtime-output", userId: "browser-runtime-output", offerSdp: "offer" });
  return { call, peer, playedChunks, sleeps, startedLoops, statuses, synthesizedTexts };
}

async function createStreamFailureScenario() {
  const peer = new FakePeer();
  const claimedChunks: string[] = [];
  const synthesizedTexts: string[] = [];
  const statuses: Array<{ state: string; detail?: string }> = [];
  const chunks = [
    { sessionId: 0, outputId: "output-1", chunkId: "chunk-1", text: "第一段。" },
    { sessionId: 0, outputId: "output-2", chunkId: "chunk-2", text: "第二段。" }
  ];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream({ text, onInputBufferIdle }: { text: AsyncIterable<string> | string; onInputBufferIdle?: () => void | Promise<void> }) {
        const inputText = await collectVoiceTextInput(text);
        synthesizedTexts.push(inputText);
        await onInputBufferIdle?.();
        if (inputText === "第一段。") throw new Error("stream failed");
        yield { type: "audio" as const, sequence: 0, chunk: new Uint8Array([1, 2]), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      for await (const _chunk of input.chunks) {
        yield { sequence: 0, pcm: new Int16Array([2]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
      }
    },
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
      }
    },
    emitStatus: (event) => statuses.push(event)
  });
  await plugin.createCall({ callId: "call-stream-failure", userId: "browser-stream-failure", offerSdp: "offer" });
  return { claimedChunks, peer, statuses, synthesizedTexts };
}

async function createRemoteIdleScenario() {
  const track = new ControlledQueueTrack();
  const statuses: Array<{ state: string; detail?: string }> = [];
  const foregroundIdle: number[] = [];
  let claimed = false;
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
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("single-file synthesizer should not be used");
    }, {
      async *stream({ text }: { text: AsyncIterable<string> | string }) {
        await collectVoiceTextInput(text);
        yield { type: "audio_file" as const, sequence: 0, text: "远端播放片段", assetId: "asset-remote-idle", filePath: "/tmp/remote-idle.wav" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used with enqueueAudioFile track");
    },
    talkRuntime: {
      openSession() {},
      ingestInput() {},
      closeSession() {},
      markAgentLoopReady() {},
      claimReadyOutputChunk(sessionId: number) {
        if (claimed) return undefined;
        claimed = true;
        return { sessionId, outputId: "output-remote-idle", chunkId: "chunk-remote-idle", text: "第一段。" };
      },
      markForegroundPlaybackIdle(input: { sessionId: number }) {
        foregroundIdle.push(input.sessionId);
      }
    },
    emitStatus: (event) => statuses.push(event)
  });
  const call = await plugin.createCall({ callId: "call-remote-idle", userId: "browser-remote-idle", offerSdp: "offer" });
  return { call, foregroundIdle, statuses, track };
}
