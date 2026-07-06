import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebRtcVoiceRuntime } from "../../../src/apps/api/bootstrap/web-rtc-voice-runtime.js";
import { createWebRtcVoicePlugin, defaultWebRtcVoiceConfig, encodePcmL16StreamToOpusRtpFrames, WebRtcVoiceError, type ServerAudioFrame } from "../../../src/channels/webrtc-voice/src/index.js";
import { createTalkRuntime } from "../../../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createTalkStore } from "../../../src/contexts/talk-session/src/adapters/sqlite-talk-session-store.js";
import { ControlledQueueTrack, DelayedEnqueueTrack, FakeAsrSession, FakeHangingAsrSession, FakePeer, RemotePlayingQueueTrack, collectVoiceTextInput, defaultConfig, fakeVoiceSynthesizer, makeTempDir, tempFilePath, waitFor } from "./webrtc-voice-plugin-helpers.js";

const path = await import("node:path");

test("WebRTC voice single-file TTS path submits one output and stops after interrupt", async () => {
  const peer = new FakePeer();
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
      if (sleeps === 1) call.interrupt("manual", "stream-output");
    }
  });

  call = await plugin.createCall({ callId: "call-5", userId: "browser-5", offerSdp: "offer" });
  const result = await call.playReplyText("第一句。第二句。第三句。", "stream-output");

  assert.equal(result.status, "interrupted");
  assert.deepEqual(synthesizedTexts, ["第一句。第二句。第三句。"]);
  assert.deepEqual(peer.outboundTrack?.frames.map((frame) => Array.from(frame.pcm)), [[1]]);
});

test("WebRTC voice uses streaming TTS audio chunks when available", async () => {
  const peer = new FakePeer();
  const streamedTexts: string[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream({ text }: { text: string | AsyncIterable<string> }) {
        const inputText = await collectVoiceTextInput(text);
        streamedTexts.push(inputText);
        yield { type: "translation_started" as const, sequence: 0, sourceChars: inputText.length };
        yield { type: "translation_done" as const, sequence: 0, translatedChars: 4 };
        yield {
          type: "audio" as const,
          sequence: 0,
          text: "stream text",
          textchunk: "ストリーム",
          chunk: new Uint8Array([9]),
          soundchunk: new Uint8Array([1, 2, 3, 4]),
          contentType: "audio/L16; rate=32000; channels=1"
        };
        yield { type: "part_done" as const, sequence: 0 };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16ToFrames: async (input) => {
      assert.deepEqual(Array.from(input.pcm), [1, 2, 3, 4]);
      assert.equal(input.inputSampleRateHz, 32_000);
      return [
        { sequence: 0, pcm: new Int16Array([9]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
      ];
    },
    archiveTtsOutput: async () => {
      return { filePath: tempFilePath("archive.wav") };
    }
  });

  const call = await plugin.createCall({ callId: "call-stream", userId: "browser-stream", offerSdp: "offer" });
  const result = await call.playReplyText("元の返事。", "stream-output");

  assert.equal(result.status, "played");
  assert.deepEqual(streamedTexts, ["元の返事。"]);
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[9]]);
});

test("WebRTC voice retries outbound write failures without dropping streaming frames", async () => {
  const peer = new FakePeer({ writeResults: [false, true, true] });
  const statuses: Array<{ state: string; detail?: string }> = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        yield { type: "audio" as const, sequence: 0, text: "第一段。", chunk: new Uint8Array([1]), contentType: "audio/pcm", sampleRateHz: 32_000, channels: 1 };
        yield { type: "done" as const };
      }
    }),
    encodePcmL16StreamToFrames: async function* () {
      yield { sequence: 0, pcm: new Int16Array([1]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
      yield { sequence: 1, pcm: new Int16Array([2]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
    },
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-write-retry", userId: "browser-write-retry", offerSdp: "offer" });
  const result = await call.playReplyText("第一段。", "output-write-retry", { chunkId: "chunk-write-retry" });

  assert.equal(result.status, "played");
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[1], [2]]);
  assert.equal(statuses.some((entry) => entry.state === "tts.playback.write_failed"), true);
});

test("WebRTC voice fails one chunk after repeated outbound write failures", async () => {
  const scenario = await createRepeatedWriteFailureScenario();

  await waitFor(() => scenario.statuses.some((entry) => entry.state === "tts.failed" && entry.detail?.includes("chunk=chunk-1")), 2_000);
  assert.deepEqual(scenario.playedChunks, []);
  await scenario.call.close("test_done");
});

test("WebRTC voice continues later chunks after one outbound write failure", async () => {
  const scenario = await createRepeatedWriteFailureScenario();

  await waitFor(() => scenario.claimedChunks.length === 2 && scenario.playedChunks.length === 1, 2_000);
  assert.deepEqual(scenario.claimedChunks, ["chunk-1", "chunk-2"]);
  assert.deepEqual(scenario.playedChunks, ["chunk-2"]);
  assert.deepEqual(scenario.peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[1]]);
  await scenario.call.close("test_done");
});

test("WebRTC voice closes the call and stops output pump when TTS cannot produce audio", async () => {
  const peer = new FakePeer();
  const claimedChunks: string[] = [];
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
      async *stream() {
        throw new Error("tts service unavailable");
      }
    }),
    encodePcmL16StreamToFrames: async function* (input) {
      for await (const _chunk of input.chunks) {
        yield { sequence: 0, pcm: new Int16Array([1]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
      }
    },
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    talkRuntime: {
      openSession() {},
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

  await plugin.createCall({ callId: "call-tts-fatal", userId: "browser-tts-fatal", offerSdp: "offer" });

  await waitFor(() => statuses.some((entry) => entry.state === "talk_runtime.close" && entry.detail === "tts_failed"), 2_000);
  await waitFor(() => claimedChunks.length === 2 && statuses.some((entry) => entry.state === "voice_call.output_pump.playback_failed"));
  assert.deepEqual(claimedChunks, ["chunk-1", "chunk-2"]);
  assert.equal(peer.closed, true);
  assert.equal(statuses.some((entry) => entry.state === "voice_call.output_pump.playback_failed" && entry.detail?.includes("tts service unavailable")), true);
});

test("WebRTC voice streaming PCM encoder reuses one ffmpeg process for chunked audio", async () => {
  const sampleRateHz = 32_000;
  const samples = Math.floor(sampleRateHz * 0.24);
  const pcm = new Int16Array(samples);
  for (let index = 0; index < samples; index += 1) {
    pcm[index] = Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRateHz) * 12_000);
  }
  async function* chunks() {
    const bytes = new Uint8Array(pcm.buffer);
    for (let offset = 0; offset < bytes.byteLength; offset += 2048) {
      yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + 2048));
    }
  }

  const frames: ServerAudioFrame[] = [];
  for await (const frame of encodePcmL16StreamToOpusRtpFrames({
    chunks: chunks(),
    inputSampleRateHz: sampleRateHz,
    inputChannels: 1,
    sampleRateHz: 48_000,
    channels: 1,
    frameMs: 20
  })) {
    frames.push(frame);
  }

  assert.equal(frames.length >= 8, true);
  assert.equal(frames.every((frame) => frame.rtpPayload && frame.rtpPayload.byteLength > 0), true);
  assert.equal(frames[0].rtpTimestampIncrement, 960);
});

test("WebRTC voice streaming PCM encoder flushes frames before the next TTS chunk", async () => {
  const sampleRateHz = 32_000;
  const samples = Math.floor(sampleRateHz * 0.5);
  const pcm = new Int16Array(samples);
  for (let index = 0; index < samples; index += 1) {
    pcm[index] = Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRateHz) * 12_000);
  }
  let releaseSecondChunk!: () => void;
  const secondChunkReady = new Promise<void>((resolve) => {
    releaseSecondChunk = resolve;
  });
  async function* chunks() {
    yield new Uint8Array(pcm.buffer);
    await secondChunkReady;
    yield new Uint8Array(pcm.buffer);
  }

  const iterator = encodePcmL16StreamToOpusRtpFrames({
    chunks: chunks(),
    inputSampleRateHz: sampleRateHz,
    inputChannels: 1,
    sampleRateHz: 48_000,
    channels: 1,
    frameMs: 20
  })[Symbol.asyncIterator]();
  try {
    const first = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<ServerAudioFrame>>((resolve) => setTimeout(() => resolve({ done: true, value: undefined as never }), 500))
    ]);
    assert.equal(first.done, false);
    assert.equal(Boolean(first.value.rtpPayload?.byteLength), true);
  } finally {
    releaseSecondChunk();
    await iterator.return?.();
  }
});

async function createRepeatedWriteFailureScenario() {
  const peer = new FakePeer({ writeResults: [false, false, false, true] });
  const claimedChunks: string[] = [];
  const playedChunks: string[] = [];
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
      async *stream({ text }: { text: string }) {
        yield { type: "audio" as const, sequence: 0, text, chunk: new Uint8Array([1]), contentType: "audio/pcm", sampleRateHz: 32_000, channels: 1 };
        yield { type: "done" as const };
      }
    }),
    encodePcmL16StreamToFrames: async function* () {
      yield { sequence: 0, pcm: new Int16Array([1]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
    },
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    talkRuntime: {
      openSession() {},
      closeSession() {},
      markAgentLoopReady() {},
      claimReadyOutputChunk(sessionId: number) {
        const chunk = chunks.shift();
        if (!chunk) return undefined;
        claimedChunks.push(chunk.chunkId);
        return { ...chunk, sessionId };
      },
      markOutputChunkPlayed(input) {
        playedChunks.push(input.chunkId);
      }
    },
    emitStatus: (event) => statuses.push(event)
  });
  const call = await plugin.createCall({ callId: "call-write-failure", userId: "browser-write-failure", offerSdp: "offer" });
  return { call, claimedChunks, peer, playedChunks, statuses };
}
