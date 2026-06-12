import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebRtcVoicePlugin, defaultWebRtcVoiceConfig, encodePcmL16StreamToOpusRtpFrames, WebRtcVoiceError, type PlaybackConsumerSnapshot, type PlaybackItemSettled, type ServerAudioFrame, type ServerOutboundAudioTrack, type WebRtcVoiceConfig } from "../src/channels/webrtc-voice/src/index.js";
import type { AsrInboundStreamAcceptResult, AsrInboundStreamSession } from "../src/channels/asr/src/index.js";
import { createTalkRuntime } from "../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";
import { createTalkStore } from "../src/contexts/talk-session/src/adapters/sqlite-talk-session-store.js";

const fs = await import("node:fs");
const path = await import("node:path");

const defaultConfig: WebRtcVoiceConfig = {
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

test("WebRTC voice call page exposes signaling and remote audio playback shell", () => {
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => []
  });

  const html = plugin.renderCallPage();

  assert.match(html, /\/plugins\/webrtc-voice\/signaling/);
  assert.match(html, /RTCPeerConnection/);
  assert.match(html, /getUserMedia/);
  assert.match(html, /Hold to talk/);
  assert.match(html, /id="testSpeakText"/);
  assert.match(html, /id="typedInterruptInput"/);
  assert.match(html, /Type more than 1 character to interrupt; press Enter to submit\./);
  assert.match(html, /text\.length <= 1/);
  assert.match(html, /addEventListener\("keydown"/);
  assert.match(html, /event\.key !== "Enter"/);
  assert.doesNotMatch(html, /typedInputFinalIdleMs/);
  assert.doesNotMatch(html, /setTimeout\(\(\) => \{/);
  assert.match(html, /type: "interrupt", reason: "manual"/);
  assert.match(html, /type: "text-draft", text/);
  assert.match(html, /type: "ping"/);
  assert.match(html, /message\.type === "pong"/);
  assert.match(html, /-已撤回-/);
  assert.match(html, /normalizeTypedInputText/);
  assert.match(html, /\\uFFFC/);
  assert.match(html, /type: "text-input", text: payloadText/);
  assert.match(html, /id="assistantOutputText"/);
  assert.match(html, /id="userInputText"/);
  assert.match(html, /tts\.output_text/);
  assert.match(html, /tts\.playback\.consumer/);
  assert.match(html, /audio\.transcript\.final/);
  assert.match(html, /message\.state === "asr\.partial"/);
  assert.match(html, /partialTranscript\.textContent = text;/);
  assert.match(html, /これは疑似ストリーミング音声のテストです。/);
  assert.match(html, /"sampleRateHz":16000/);
  assert.match(html, /"encoding":"pcm_s16le"/);
  assert.match(html, /addTransceiver\("audio", \{ direction: "recvonly" \}\)/);
  assert.doesNotMatch(html, /addTrack\(track/);
  assert.doesNotMatch(html, /startVad/);
  assert.doesNotMatch(html, /noiseGate/);
  assert.doesNotMatch(html, /estimateNoiseFloor/);
  assert.doesNotMatch(html, /remoteAudio state/);
  assert.match(html, /remoteAudio/);
  assert.match(html, /unlocks autoplay in the Call gesture/);
});

test("WebRTC voice defaults inbound push-to-talk audio to PCM16 16k mono", () => {
  const config = defaultWebRtcVoiceConfig();

  assert.equal(config.inboundAudio.sampleRateHz, 16_000);
  assert.equal(config.inboundAudio.channels, 1);
  assert.equal(config.inboundAudio.encoding, "pcm_s16le");
  assert.equal(config.inboundAudio.chunkMs, 100);
});

test("WebRTC voice records talk timestamps with configured local time and UTC", async () => {
  const opened: unknown[] = [];
  const time = createCurrentTimeProvider("Asia/Tokyo", () => new Date("2026-06-07T07:53:49.829Z"));
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    time,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    talkRuntime: {
      openSession(input) {
        opened.push(input);
      },
      startAgentLoop() {}
    }
  });

  await plugin.createCall({ callId: "call-timezone", userId: "browser-timezone", offerSdp: "offer" });

  assert.equal((opened[0] as { occurredAt?: string }).occurredAt, "2026-06-07T16:53:49.829");
  assert.equal((opened[0] as { occurredAtUtc?: string }).occurredAtUtc, "2026-06-07T07:53:49.829Z");
});

test("WebRTC voice caches TalkRuntime returned session id for runtime submissions", async () => {
  const asr = new FakeAsrSession([
    {
      ok: true,
      type: "final",
      streamId: "asr-call-returned-session-0",
      result: {
        text: "もしもし",
        provider: "tencent"
      }
    }
  ]);
  const asrMetadata: unknown[] = [];
  const ingested: unknown[] = [];
  const closed: unknown[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: (start) => {
      asrMetadata.push(start.metadata);
      return asr;
    },
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    talkRuntime: {
      openSession() {
        return { sessionId: "1780830000000" };
      },
      ingestInput(event) {
        ingested.push(event);
      },
      closeSession(input) {
        closed.push(input);
      }
    }
  });

  const call = await plugin.createCall({ callId: "call-returned-session", userId: "browser-returned-session", offerSdp: "offer" });
  await call.endInboundAudio();
  await call.close("manual");

  assert.equal(call.talkSessionId, "1780830000000");
  assert.equal((asrMetadata[0] as { talkSessionId?: string }).talkSessionId, "1780830000000");
  assert.equal((ingested[0] as { sessionId?: string }).sessionId, "1780830000000");
  assert.equal((closed[0] as { sessionId?: string }).sessionId, "1780830000000");
});

test("WebRTC voice call requires a server outbound audio track", async () => {
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer({ withoutOutboundTrack: true }),
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => []
  });

  await assert.rejects(
    plugin.createCall({ callId: "call-1", userId: "browser-1", offerSdp: "offer" }),
    (error) => error instanceof WebRtcVoiceError && error.code === "outbound_track_failed"
  );
});

test("WebRTC voice playback synthesizes Japanese voice and writes frames to outbound track", async () => {
  const peer = new FakePeer();
  const synthesizedTexts: string[] = [];
  const decodedFiles: string[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async ({ text }: { text: string }) => {
      synthesizedTexts.push(text);
      return { assetId: "generated/tts/reply.opus", filePath: tempFilePath("reply.opus") };
    }, {}),
    decodeAudioFileToFrames: async (input) => {
      decodedFiles.push(input.filePath);
      assert.equal(input.sampleRateHz, 48000);
      assert.equal(input.channels, 1);
      assert.equal(input.frameMs, 20);
      return [
        { sequence: 0, pcm: new Int16Array([1, 2]), sampleRateHz: 48000, channels: 1, durationMs: 20 },
        { sequence: 1, pcm: new Int16Array([3, 4]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
      ];
    }
  });

  const call = await plugin.createCall({ callId: "call-2", userId: "browser-2", offerSdp: "offer" });
  const result = await call.playReplyText("晚点见", "output-1");

  assert.equal(result.status, "played");
  assert.deepEqual(synthesizedTexts, ["晚点见"]);
  assert.deepEqual(decodedFiles, [tempFilePath("reply.opus")]);
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[1, 2], [3, 4]]);
  assert.equal(peer.outboundTrack?.stopped, false);
  await call.close("test_done");
});

test("WebRTC voice drains TTS-owned ready chunks into the playback queue without playback settlement backpressure", async () => {
  const track = new ControlledQueueTrack();
  const backendRequests: string[] = [];
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
      async *stream(input: { beforeBackendRequest?(request: { sequence: number; text: string }): Promise<void> | void }) {
        for (const [sequence, text] of ["第一段。", "第二段。", "第三段。"].entries()) {
          await input.beforeBackendRequest?.({ sequence, text });
          backendRequests.push(text);
          yield {
            type: "audio_file" as const,
            sequence,
            text,
            textchunk: text,
            assetId: `generated/tts/${sequence}.opus`,
            filePath: tempFilePath(`${sequence}.opus`)
          };
          yield { type: "part_done" as const, sequence };
        }
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used with enqueueAudioFile track");
    }
  });

  const call = await plugin.createCall({ callId: "call-backpressure", userId: "browser-backpressure", offerSdp: "offer" });
  const playback = call.playReplyText("第一段。第二段。第三段。", "output-backpressure");

  await waitFor(() => backendRequests.length === 3 && track.enqueued.length === 3);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(backendRequests, ["第一段。", "第二段。", "第三段。"]);
  track.settle(0, { itemId: track.enqueued[0]!.itemId, status: "played", framesWritten: 1, playedMs: 20, totalMs: 20 });
  track.settle(1, { itemId: track.enqueued[1]!.itemId, status: "played", framesWritten: 1, playedMs: 20, totalMs: 20 });
  track.settle(2, { itemId: track.enqueued[2]!.itemId, status: "played", framesWritten: 1, playedMs: 20, totalMs: 20 });

  const result = await playback;
  assert.equal(result.status, "played");
  assert.deepEqual(backendRequests, ["第一段。", "第二段。", "第三段。"]);
  await call.close("test_done");
});

test("WebRTC voice rejects concurrent playReplyText calls on the same call", async () => {
  const track = new DelayedEnqueueTrack();
  const backendRequests: string[] = [];
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
      async *stream(input: { text: string | AsyncIterable<string>; beforeBackendRequest?(request: { sequence: number; text: string }): Promise<void> | void }) {
        const text = await collectVoiceTextInput(input.text);
        await input.beforeBackendRequest?.({ sequence: 0, text });
        backendRequests.push(text);
        yield {
          type: "audio_file" as const,
          sequence: 0,
          text,
          textchunk: text,
          assetId: `generated/tts/${text}.opus`,
          filePath: tempFilePath(`${text}.opus`)
        };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used with enqueueAudioFile track");
    }
  });

  const call = await plugin.createCall({ callId: "call-enqueue-backpressure", userId: "browser-enqueue-backpressure", offerSdp: "offer" });
  const first = call.playReplyText("one", "output-one");
  await assert.rejects(call.playReplyText("two", "output-two"), /playReplyText is already active/);

  await waitFor(() => backendRequests.length === 1 && track.pendingEnqueues.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(backendRequests, ["one"]);
  track.resolveEnqueue(0);
  await waitFor(() => track.waitingSettlements >= 1);
  track.settle(0, { itemId: track.enqueued[0]!.itemId, status: "played", framesWritten: 1, playedMs: 20, totalMs: 20 });

  assert.equal((await first).status, "played");
  await call.close("test_done");
});

test("WebRTC voice passes injected project time to TTS synthesis", async () => {
  const peer = new FakePeer();
  const timeZones: string[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-06-07T08:00:00.000Z")),
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async ({ time }: { time: { timeZone: string } }) => {
      timeZones.push(time.timeZone);
      return { assetId: "generated/tts/reply.opus", filePath: tempFilePath("reply.opus") };
    }, {}),
    decodeAudioFileToFrames: async () => [
      { sequence: 0, pcm: new Int16Array([1, 2]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ]
  });

  const call = await plugin.createCall({ callId: "call-tts-time", userId: "browser-tts-time", offerSdp: "offer" });
  await call.playReplyText("晚点见", "output-time");

  assert.deepEqual(timeZones, ["Asia/Shanghai"]);
  await call.close("test_done");
});

test("WebRTC voice strips parenthesized text before TTS when enabled", async () => {
  const synthesizedTexts: string[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async ({ text }: { text: string }) => {
      synthesizedTexts.push(text);
      return { assetId: "generated/tts/reply.opus", filePath: tempFilePath("reply.opus") };
    }, {}),
    decodeAudioFileToFrames: async () => [
      { sequence: 0, pcm: new Int16Array([1]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ]
  });

  const call = await plugin.createCall({ callId: "call-filter", userId: "browser-filter", offerSdp: "offer" });
  await call.playReplyText("你好(动作描写)，继续说（内心活动）。", "filter-output");

  assert.deepEqual(synthesizedTexts, ["你好，继续说。"]);
  await call.close("test_done");
});

test("WebRTC voice fails before call setup when ASR preflight fails", async () => {
  let peerCreated = false;
  const statuses: Array<{ state: string; detail?: string }> = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => {
      peerCreated = true;
      return new FakePeer();
    },
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    testAsr: async () => ({ ok: false, error: "provider_request_failed", message: "boom" }),
    emitStatus: (event) => statuses.push(event)
  });

  await assert.rejects(
    plugin.createCall({ callId: "call-asr-preflight", userId: "browser-asr-preflight", offerSdp: "offer" }),
    (error) => error instanceof WebRtcVoiceError && error.code === "asr_preflight_failed"
  );
  assert.equal(peerCreated, false);
  assert.deepEqual(statuses, [
    { state: "asr.preflight.started", detail: "checking" },
    { state: "asr.preflight.failed", detail: "boom" }
  ]);
});

test("WebRTC voice waits for TalkRuntime output, reports connected after first TTS audio, then delays playback", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  const sleeps: number[] = [];
  const synthesizedTexts: string[] = [];
  const startedLoops: string[] = [];
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
        assert.notEqual(typeof text, "string");
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
      startAgentLoop(sessionId: string) {
        startedLoops.push(sessionId);
      },
      claimReadyOutputChunk(sessionId: string) {
        if (sessionId !== "webrtc_voice:call-runtime-output" || claimed) return undefined;
        claimed = true;
        return {
          sessionId,
          outputId: "output-greeting",
          chunkId: "chunk-greeting",
          text: "接通测试。",
          outputTextLength: 5
        };
      },
      markOutputChunkPlayed(input: { sessionId: string; chunkId: string }) {
        playedChunks.push(`${input.sessionId}:${input.chunkId}`);
      }
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-runtime-output", userId: "browser-runtime-output", offerSdp: "offer" });

  assert.equal(statuses.some((entry) => entry.state === "voice_call.waiting" && entry.detail === "webrtc_voice:call-runtime-output"), true);
  await waitFor(() => synthesizedTexts.length === 1);
  assert.deepEqual(synthesizedTexts, ["接通测试。"]);
  assert.deepEqual(startedLoops, ["webrtc_voice:call-runtime-output"]);
  assert.deepEqual(playedChunks, []);
  await waitFor(() => statuses.some((entry) => entry.state === "voice_call.connected" && entry.detail === "webrtc_voice:call-runtime-output"));
  assert.equal(sleeps.includes(20), true);
  assert.equal(sleeps.includes(1000), false);
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[7]]);
  await call.close("test_done");
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
    { sessionId: "webrtc_voice:call-overlap", outputId: "output-1", chunkId: "chunk-1", text: "第一段。" },
    { sessionId: "webrtc_voice:call-overlap", outputId: "output-2", chunkId: "chunk-2", text: "第二段。" }
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
      startAgentLoop() {},
      claimReadyOutputChunk(sessionId: string) {
        const chunk = chunks.shift();
        if (!chunk || sessionId !== chunk.sessionId) return undefined;
        claimedChunks.push(chunk.chunkId);
        return chunk;
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
    { sessionId: "webrtc_voice:call-consumer-target", outputId: "output-1", chunkId: "chunk-1", text: "啊——！老板！电话通了通了！" },
    { sessionId: "webrtc_voice:call-consumer-target", outputId: "output-2", chunkId: "chunk-2", text: "第二段还在翻译后等待音频。" }
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
      startAgentLoop() {},
      claimReadyOutputChunk(sessionId: string) {
        const chunk = chunks.shift();
        if (!chunk || sessionId !== chunk.sessionId) return undefined;
        claimedChunks.push(chunk.chunkId);
        return chunk;
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

test("WebRTC voice does not synthesize later TalkRuntime chunks after current TTS stream failure closes the call", async () => {
  const peer = new FakePeer();
  const claimedChunks: string[] = [];
  const synthesizedTexts: string[] = [];
  const statuses: Array<{ state: string; detail?: string }> = [];
  const chunks = [
    { sessionId: "webrtc_voice:call-stream-failure", outputId: "output-1", chunkId: "chunk-1", text: "第一段。" },
    { sessionId: "webrtc_voice:call-stream-failure", outputId: "output-2", chunkId: "chunk-2", text: "第二段。" }
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
      startAgentLoop() {},
      claimReadyOutputChunk(sessionId: string) {
        const chunk = chunks.shift();
        if (!chunk || sessionId !== chunk.sessionId) return undefined;
        claimedChunks.push(chunk.chunkId);
        return chunk;
      }
    },
    emitStatus: (event) => statuses.push(event)
  });

  await plugin.createCall({ callId: "call-stream-failure", userId: "browser-stream-failure", offerSdp: "offer" });
  await waitFor(() => statuses.some((entry) => entry.state === "talk_runtime.close" && entry.detail === "tts_failed"), 2_000);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(claimedChunks, ["chunk-1", "chunk-2"]);
  assert.deepEqual(synthesizedTexts, ["第一段。"]);
  assert.equal(statuses.some((entry) => entry.state === "voice_call.output_pump.playback_failed" && entry.detail === "stream failed"), true);
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), []);
  assert.equal(peer.closed, true);
});

test("WebRTC voice feeds buffered TalkRuntime output into one TTS plugin stream", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  const streamedText: string[] = [];
  let streamCalls = 0;
  const outputs = [
    { sessionId: "webrtc_voice:call-buffered-stream", outputId: "output-buffered", text: "碎块一", status: "streaming" },
    { sessionId: "webrtc_voice:call-buffered-stream", outputId: "output-buffered", text: "二三", status: "streaming" },
    { sessionId: "webrtc_voice:call-buffered-stream", outputId: "output-buffered", text: "四五六", status: "streaming" },
    { sessionId: "webrtc_voice:call-buffered-stream", outputId: "output-buffered", text: "七八\n", status: "finished" }
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
      startAgentLoop() {},
      claimBufferedOutputText(sessionId: string) {
        const output = outputs.shift();
        return output && output.sessionId === sessionId ? output : undefined;
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
    { sessionId: "webrtc_voice:call-blank-finish", outputId: "output-blank-finish", text: "第一段。", status: "streaming" },
    { sessionId: "webrtc_voice:call-blank-finish", outputId: "output-blank-finish", text: "\n", status: "finished" }
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
      startAgentLoop() {},
      claimBufferedOutputText(sessionId: string) {
        const output = outputs.shift();
        return output && output.sessionId === sessionId ? output : undefined;
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
  assert.equal(statuses.some((entry) => entry.state === "tts.failed" && entry.detail?.includes("no_frames_sent")), false);
  assert.equal(peer.closed, false);

  await call.close("test_done");
});

test("WebRTC voice waits for remote worker playback idle and frontend ACK before marking TalkRuntime idle", async () => {
  const track = new ControlledQueueTrack();
  const statuses: Array<{ state: string; detail?: string }> = [];
  const foregroundIdle: string[] = [];
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
      startAgentLoop() {},
      claimReadyOutputChunk(sessionId: string) {
        if (claimed || sessionId !== "webrtc_voice:call-remote-idle") return undefined;
        claimed = true;
        return { sessionId, outputId: "output-remote-idle", chunkId: "chunk-remote-idle", text: "第一段。" };
      },
      markForegroundPlaybackIdle(input: { sessionId: string }) {
        foregroundIdle.push(input.sessionId);
      }
    },
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-remote-idle", userId: "browser-remote-idle", offerSdp: "offer" });
  await waitFor(() => track.enqueued.length === 1 && track.waitingSettlements === 1);
  track.settle(0, { itemId: track.enqueued[0]!.itemId, status: "played", framesWritten: 1, playedMs: 20, totalMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(foregroundIdle, []);

  track.resolveIdle();
  await waitFor(() => statuses.some((entry) => entry.state === "voice_call.playback_idle_ack.request"));
  assert.deepEqual(foregroundIdle, []);

  const request = statuses.find((entry) => entry.state === "voice_call.playback_idle_ack.request");
  const ackId = JSON.parse(request?.detail ?? "{}").ackId;
  assert.equal(typeof ackId, "string");
  call.ackPlaybackIdle?.(ackId);
  await waitFor(() => foregroundIdle.length === 1);
  assert.deepEqual(foregroundIdle, ["webrtc_voice:call-remote-idle"]);
  await call.close("test_done");
});

test("WebRTC voice ASR final is marked as TalkRuntime TODO and not ingested yet", async () => {
  const statuses: Array<{ state: string; detail?: string }> = [];
  const asr = new FakeAsrSession([
    { ok: true, type: "partial", streamId: "asr-call-3", text: "もし", stable: false },
    {
      ok: true,
      type: "final",
      streamId: "asr-call-3",
      result: {
        text: "もしもし",
        provider: "tencent"
      }
    }
  ]);
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: (start) => {
      assert.equal(start.streamId, "asr-call-3-0");
      assert.equal(start.language, "ja");
      assert.equal(start.audio.sampleRateHz, 16_000);
      assert.equal(start.audio.channels, 1);
      assert.equal(start.audio.encoding, "pcm_s16le");
      assert.equal(start.audio.mimeType, "audio/pcm");
      assert.equal(start.metadata?.talkRuntimeIngress, "todo");
      return asr;
    },
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-3", userId: "browser-3", offerSdp: "offer" });
  const partial = await call.acceptInboundAudioChunk(new Uint8Array([1, 2]), { startMs: 0, endMs: 100, durationMs: 100 });
  const final = await call.endInboundAudio();

  assert.equal(partial?.type, "partial");
  assert.equal(final?.type, "final");
  assert.equal(call.talkRuntimeIngressStatus, "todo");
  assert.deepEqual(statuses, [
    { state: "tts.prepare.started", detail: "connecting" },
    { state: "tts.prepare.ready", detail: "connected" },
    { state: "talk_runtime.open.todo", detail: "webrtc_voice:call-3", callId: "call-3" },
    { state: "asr.stream.started", detail: "asr-call-3-0", callId: "call-3" },
    { state: "asr.partial", detail: "もし", callId: "call-3" },
    { state: "talk_runtime.ingress.todo", detail: "audio.transcript.final: もしもし", callId: "call-3" },
    { state: "asr.stream.final", detail: "asr-call-3-0 chunks=1 bytes=2 durationMs=100 result=final:4", callId: "call-3" }
  ]);
});

test("WebRTC voice uses injected TalkRuntime for session open, final transcript, interrupt, and close", async () => {
  const statuses: Array<{ state: string; detail?: string }> = [];
  const talkRuntime = createTalkRuntime({
    store: createTalkStore(path.join(makeTempDir("webrtc-talk-runtime"), "talk.sqlite")),
    time: createCurrentTimeProvider("Asia/Tokyo", () => new Date("2026-06-06T15:00:00.000Z"))
  });
  const asr = new FakeAsrSession([
    {
      ok: true,
      type: "final",
      streamId: "asr-call-talk-runtime-0",
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
    talkRuntime,
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-talk-runtime", userId: "browser-talk-runtime", offerSdp: "offer" });
  assert.equal(call.talkRuntimeIngressStatus, "connected");
  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.open" && entry.detail === "webrtc_voice:call-talk-runtime"), true);

  await call.endInboundAudio();
  assert.deepEqual(talkRuntime.buildNextLoopMessages(call.talkSessionId), [
    { role: "user", content: "もしもし" }
  ]);
  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.ingress" && entry.detail === "audio.transcript.final: もしもし"), true);

  talkRuntime.appendAssistantDelta({ sessionId: call.talkSessionId, outputId: "output-talk-runtime", delta: "まだ話している途中です。" });
  await call.interrupt("manual");
  assert.equal(talkRuntime.store.listSegments(call.talkSessionId).some((segment) => segment.kind === "interrupt"), true);
  assert.equal(talkRuntime.store.getOutput("output-talk-runtime")?.status, "interrupted");

  await call.close("manual");
  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.close" && entry.detail === "manual"), true);
});

test("WebRTC voice passes local ICE callback into server peer creation", async () => {
  let callbackSeen = false;
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async (input) => {
      callbackSeen = typeof input.onLocalIceCandidate === "function";
      input.onLocalIceCandidate?.({ candidate: "candidate:server" });
      return new FakePeer();
    },
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => []
  });
  const candidates: unknown[] = [];

  await plugin.createCall({
    callId: "call-ice",
    userId: "browser-ice",
    offerSdp: "offer",
    onLocalIceCandidate: (candidate) => candidates.push(candidate)
  });

  assert.equal(callbackSeen, true);
  assert.deepEqual(candidates, [{ candidate: "candidate:server" }]);
});

test("WebRTC voice restarts ASR stream after recoverable provider failure", async () => {
  const statuses: Array<{ state: string; detail?: string }> = [];
  const sessions: FakeAsrSession[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => {
      const session = new FakeAsrSession(sessions.length === 0
        ? [{ ok: false, type: "error", streamId: "asr-call-recover-0", error: "provider_request_failed", message: "boom" }]
        : []);
      sessions.push(session);
      return session;
    },
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-recover", userId: "browser-recover", offerSdp: "offer" });
  const failed = await call.acceptInboundAudioChunk(new Uint8Array([1]));
  const next = await call.acceptInboundAudioChunk(new Uint8Array([2]));

  assert.equal(failed?.ok, false);
  assert.equal(next?.ok, true);
  assert.equal(call.asrStreamId, "asr-call-recover-1");
  assert.equal(sessions.length, 2);
  assert.equal(statuses.some((entry) => entry.state === "asr.stream.restarted" && entry.detail === "asr-call-recover-1:provider_request_failed"), true);
});

test("WebRTC voice interrupt stops outbound playback queue and records interrupt status", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [
      { sequence: 0, pcm: new Int16Array([1]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ],
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-4", userId: "browser-4", offerSdp: "offer" });
  await call.playReplyText("再生中", "output-2");
  await call.interrupt("manual", "output-2");

  assert.equal(peer.outboundTrack?.stopped, false);
  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.interrupt.todo" && entry.detail === "manual:output-2"), true);
});

test("WebRTC voice manual interrupt targets current TalkRuntime output without explicit output id", async () => {
  const peer = new FakePeer();
  let call: any;
  let sleeps = 0;
  const interrupts: Array<{ outputId: string; elapsedMs?: number; totalMs?: number }> = [];
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
      ingestInput() {},
      closeSession() {},
      interruptOutput(input) {
        interrupts.push({ outputId: input.outputId, elapsedMs: input.elapsedMs, totalMs: input.totalMs });
      }
    },
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) call.interrupt("manual");
    }
  });

  call = await plugin.createCall({ callId: "call-manual-current", userId: "browser-manual-current", offerSdp: "offer" });
  const result = await call.playReplyText("第一句。", "current-output");

  assert.equal(result.status, "interrupted");
  assert.deepEqual(interrupts, [{ outputId: "current-output", elapsedMs: 0, totalMs: 40 }]);
});

test("WebRTC voice manual interrupt rejects queued later TTS playback", async () => {
  const peer = new FakePeer();
  const interrupts: string[] = [];
  let releasePlaybackSleep!: () => void;
  const playbackSleep = new Promise<void>((resolve) => {
    releasePlaybackSleep = resolve;
  });
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream({ text }: { text: string }) {
        const byte = text === "第一段。" ? 1 : 9;
        yield { type: "audio" as const, sequence: 0, chunk: new Uint8Array([byte]), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      for await (const chunk of input.chunks) {
        const byte = chunk[0] ?? 0;
        for (let index = 0; index < 3; index += 1) {
          yield { sequence: index, pcm: new Int16Array([byte]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
        }
      }
    },
    talkRuntime: {
      openSession() {},
      ingestInput() {},
      closeSession() {},
      interruptOutput(input) {
        interrupts.push(input.outputId);
      },
      interruptLatestOutput(input) {
        interrupts.push(`latest:${input.reason}`);
      }
    },
    sleep: async (ms) => {
      if (ms === 20) await playbackSleep;
    }
  });

  const call = await plugin.createCall({ callId: "call-discard-queued", userId: "browser-discard-queued", offerSdp: "offer" });
  const first = call.playReplyText("第一段。", "output-1");
  await assert.rejects(call.playReplyText("第二段。", "output-2"), /playReplyText is already active/);

  await call.interrupt("manual");
  releasePlaybackSleep();

  assert.equal(["played", "interrupted"].includes((await first).status), true);
  assert.deepEqual(interrupts, ["latest:manual"]);
});

test("WebRTC voice manual interrupt asks TalkRuntime to interrupt latest output when no playback target exists", async () => {
  const latestInterrupts: string[] = [];
  const ingestedKinds: string[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    talkRuntime: {
      openSession() {},
      closeSession() {},
      ingestInput(event) {
        ingestedKinds.push(event.kind);
      },
      interruptLatestOutput(input) {
        latestInterrupts.push(`${input.sessionId}:${input.reason}`);
      }
    }
  });

  const call = await plugin.createCall({ callId: "call-interrupt-latest", userId: "browser-interrupt-latest", offerSdp: "offer" });
  await call.interrupt("manual");

  assert.deepEqual(latestInterrupts, ["webrtc_voice:call-interrupt-latest:manual"]);
  assert.deepEqual(ingestedKinds, []);
});

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
    { sessionId: "webrtc_voice:call-pause-pump", outputId: "output-1", chunkId: "chunk-1", text: "第一段。" },
    { sessionId: "webrtc_voice:call-pause-pump", outputId: "output-2", chunkId: "chunk-2", text: "第二段。" }
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
      startAgentLoop() {},
      claimReadyOutputChunk(sessionId: string) {
        const chunk = chunks.shift();
        if (!chunk || chunk.sessionId !== sessionId) return undefined;
        claimedChunks.push(chunk.chunkId);
        return chunk;
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
  assert.equal(claimedChunks.includes("chunk-1"), true);

  resolveInterrupt();
  releasePlaybackSleep();
  await waitFor(() => claimedChunks.length === 2 && synthesizedTexts.includes("第二段。"));
  assert.deepEqual(claimedChunks, ["chunk-1", "chunk-2"]);
  assert.deepEqual(synthesizedTexts, ["第一段。", "第二段。"]);
  await call.close("test_done");
});

test("WebRTC voice single-file TTS path submits one output and stops after interrupt", async () => {
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
      if (sleeps === 1) call.interrupt("manual", "stream-output");
    },
    emitStatus: (event) => statuses.push(event)
  });

  call = await plugin.createCall({ callId: "call-5", userId: "browser-5", offerSdp: "offer" });
  const result = await call.playReplyText("第一句。第二句。第三句。", "stream-output");

  assert.equal(result.status, "interrupted");
  assert.deepEqual(synthesizedTexts, ["第一句。第二句。第三句。"]);
  assert.deepEqual(peer.outboundTrack?.frames.map((frame) => Array.from(frame.pcm)), [[1]]);
  assert.equal(statuses.some((entry) => entry.state === "tts.part.playing"), false);
  assert.equal(statuses.some((entry) => entry.state === "tts.interrupted" && entry.detail?.includes("stream-output")), true);
});

test("WebRTC voice uses streaming TTS audio chunks when available", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  const streamedTexts: string[] = [];
  const archives: unknown[] = [];
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
          text: "legacy text",
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
    archiveTtsOutput: async (input) => {
      archives.push(input);
      return { filePath: tempFilePath("archive.wav") };
    },
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-stream", userId: "browser-stream", offerSdp: "offer" });
  const result = await call.playReplyText("元の返事。", "stream-output");

  assert.equal(result.status, "played");
  assert.deepEqual(streamedTexts, ["元の返事。"]);
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[9]]);
  assert.equal(archives.length, 1);
  assert.deepEqual((archives[0] as any).audio.chunks.map((chunk: Uint8Array) => Array.from(chunk)), [[1, 2, 3, 4]]);
  assert.equal((archives[0] as any).audio.sampleRateHz, 32_000);
  assert.equal((archives[0] as any).callId, "call-stream");
  assert.equal((archives[0] as any).talkSessionId, "webrtc_voice:call-stream");
  assert.equal((archives[0] as any).outputId, "stream-output");
  assert.equal((archives[0] as any).originalText, "元の返事。");
  assert.equal((archives[0] as any).text, "ストリーム");
  assert.equal((archives[0] as any).speakText, "ストリーム");
  assert.equal((archives[0] as any).source, "stream");
  assert.equal((archives[0] as any).status, "queued");
  assert.equal(statuses.some((entry) => entry.state === "tts.stream.started"), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.played" && entry.detail === "stream-output"), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.archive.saved" && entry.detail === tempFilePath("archive.wav")), true);
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
  assert.equal(statuses.some((entry) => entry.state === "tts.playback.write_failed" && entry.detail?.includes("chunk=chunk-write-retry")), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.played" && entry.detail?.includes("chunk=chunk-write-retry")), true);
});

test("WebRTC voice fails a chunk after repeated outbound write failures and continues later chunks", async () => {
  const peer = new FakePeer({ writeResults: [false, false, false, true] });
  const claimedChunks: string[] = [];
  const playedChunks: string[] = [];
  const statuses: Array<{ state: string; detail?: string }> = [];
  const chunks = [
    { sessionId: "webrtc_voice:call-write-failure", outputId: "output-1", chunkId: "chunk-1", text: "第一段。" },
    { sessionId: "webrtc_voice:call-write-failure", outputId: "output-2", chunkId: "chunk-2", text: "第二段。" }
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
    encodePcmL16StreamToFrames: async function* (_input) {
      yield { sequence: 0, pcm: new Int16Array([1]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
    },
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    talkRuntime: {
      openSession() {},
      closeSession() {},
      startAgentLoop() {},
      claimReadyOutputChunk(sessionId: string) {
        const chunk = chunks.shift();
        if (!chunk || chunk.sessionId !== sessionId) return undefined;
        claimedChunks.push(chunk.chunkId);
        return chunk;
      },
      markOutputChunkPlayed(input) {
        playedChunks.push(input.chunkId);
      }
    },
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-write-failure", userId: "browser-write-failure", offerSdp: "offer" });

  await waitFor(() => claimedChunks.length === 2 && playedChunks.length === 1, 2_000);
  assert.deepEqual(claimedChunks, ["chunk-1", "chunk-2"]);
  assert.deepEqual(playedChunks, ["chunk-2"]);
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[1]]);
  assert.equal(statuses.some((entry) => entry.state === "tts.failed" && entry.detail?.includes("chunk=chunk-1")), true);
  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.chunk_played" && entry.detail?.includes("chunk=chunk-2")), true);
  await call.close("test_done");
});

test("WebRTC voice closes the call and stops output pump when TTS cannot produce audio", async () => {
  const peer = new FakePeer();
  const claimedChunks: string[] = [];
  const statuses: Array<{ state: string; detail?: string }> = [];
  const chunks = [
    { sessionId: "webrtc_voice:call-tts-fatal", outputId: "output-1", chunkId: "chunk-1", text: "第一段。" },
    { sessionId: "webrtc_voice:call-tts-fatal", outputId: "output-2", chunkId: "chunk-2", text: "第二段。" }
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
      startAgentLoop() {},
      claimReadyOutputChunk(sessionId: string) {
        const chunk = chunks.shift();
        if (!chunk || chunk.sessionId !== sessionId) return undefined;
        claimedChunks.push(chunk.chunkId);
        return chunk;
      }
    },
    emitStatus: (event) => statuses.push(event)
  });

  await plugin.createCall({ callId: "call-tts-fatal", userId: "browser-tts-fatal", offerSdp: "offer" });

  await waitFor(() => statuses.some((entry) => entry.state === "talk_runtime.close" && entry.detail === "tts_failed"), 2_000);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(claimedChunks, ["chunk-1", "chunk-2"]);
  assert.equal(peer.closed, true);
  assert.equal(peer.outboundTrack?.stopped, true);
  assert.equal(statuses.some((entry) => entry.state === "voice_call.output_pump.playback_failed" && entry.detail?.includes("tts service unavailable")), true);
  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.close" && entry.detail === "tts_failed"), true);
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
  assert.equal(statuses.some((entry) => entry.state === "tts.queue.waiting"), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.queue.ready"), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.queue.producer_done"), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.queue.encoded"), false);
  assert.equal(statuses.some((entry) => entry.state === "tts.stream.frames_sent" && entry.detail?.includes("queued=")), false);
  assert.equal(statuses.some((entry) => entry.state === "tts.stream.audio_text"), false);
  assert.equal(statuses.some((entry) => entry.state === "tts.playing_text" && entry.detail === "原文播放片段"), true);
  assert.deepEqual(statuses.filter((entry) => entry.state === "tts.playback.consumer"), [
    { state: "tts.playback.consumer", detail: "前文=原文播放片段 时长=60ms", callId: "call-stream-queue" }
  ]);
  assert.ok(statuses.findIndex((entry) => entry.state === "voice_call.connected") < statuses.findIndex((entry) => entry.state === "tts.playback.consumer"));
  assert.equal(statuses.some((entry) => entry.state === "tts.playback.consumer" && entry.detail === "前文= 时长=20ms"), false);
  await waitFor(() => statuses.some((entry) => entry.state === "voice_call.playback_text_cache" && entry.detail === JSON.stringify({ chunkId: "queue-output", text: "原文播放片段" })));
  assert.equal(statuses.filter((entry) => entry.state === "voice_call.playback_text_cache").at(-1)?.detail, JSON.stringify({ chunkId: "queue-output", text: "原文播放片段" }));
  assert.equal(statuses.filter((entry) => entry.state === "tts.playing_text").at(-1)?.detail, "原文播放片段");
  assert.equal(statuses.some((entry) => entry.state === "tts.playing_text.missing"), true);
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
  assert.equal(result.failureReason, undefined);
  assert.equal(statuses.some((entry) => entry.state === "tts.interrupted" && entry.detail?.includes("zero-interrupt-output")), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.failed" && entry.detail?.includes("zero-interrupt-output")), false);
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
  assert.ok(finalFrameIndex > 60);
});

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

test("WebRTC voice starts barge-in batch on speech start and commits ASR final as the result", async () => {
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
  await call.setSpeechActive(true);
  await call.setSpeechActive(false);

  assert.deepEqual(latestInterrupts, [{ reason: "barge_in", omitAssistantMessage: true }]);
  await waitFor(() => batches.length === 1);
  assert.deepEqual((batches[0] as { inputs: Array<{ interruptId: string; reason: string; text: string; asrStreamId?: string }> }).inputs.map((input) => ({
    interruptId: input.interruptId,
    reason: input.reason,
    text: input.text,
    asrStreamId: input.asrStreamId
  })), [{ interruptId: "runtime-interrupt-barge-batch", reason: "barge_in", text: "もしもし", asrStreamId: "asr-call-barge-batch-0" }]);
  assert.equal(statuses.some((entry) => entry.state === "tts.barge_in"), true);
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

test("WebRTC voice stores stream text with audio and uses it for breakpoint context", async () => {
  const peer = new FakePeer();
  let call: any;
  let sleeps = 0;
  const interrupts: Array<{ elapsedMs?: number; totalMs?: number; beforeText?: string; afterText?: string }> = [];
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
          text: "第一段内容。",
          chunk: new Uint8Array(2_560),
          contentType: "audio/L16; rate=32000; channels=1"
        };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16ToFrames: async () => [
      { sequence: 0, pcm: new Int16Array([1]), sampleRateHz: 48000, channels: 1, durationMs: 20 },
      { sequence: 1, pcm: new Int16Array([2]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ],
    talkRuntime: {
      openSession() {},
      ingestInput() {},
      closeSession() {},
      interruptOutput(input) {
        interrupts.push({
          elapsedMs: input.elapsedMs,
          totalMs: input.totalMs,
          beforeText: input.breakpointContext?.beforeText,
          afterText: input.breakpointContext?.afterText
        });
      }
    },
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) {
        await call.setSpeechActive(true);
      }
    }
  });

  call = await plugin.createCall({ callId: "call-stream-breakpoint", userId: "browser-stream-breakpoint", offerSdp: "offer" });
  const result = await call.playReplyText("完整输出里的第一段内容。后面还有别的话。", "stream-breakpoint-output", {
    originalText: "第一段内容。"
  });

  assert.equal(result.status, "interrupted");
  assert.deepEqual(interrupts, [{
    elapsedMs: 0,
    totalMs: 40,
    beforeText: undefined,
    afterText: "第一段内容。"
  }]);
});

test("WebRTC voice maps barge-in context by current chunk playback ratio", async () => {
  const peer = new FakePeer();
  let call: any;
  let interrupted = false;
  let nowMs = 0;
  const interrupts: Array<{ elapsedMs?: number; totalMs?: number; beforeText?: string; afterText?: string }> = [];
  const text = "这个声音……是老板你的声音吧！";
  const statuses: Array<{ state: string; detail?: string }> = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    now: () => new Date(nowMs),
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        yield { type: "audio" as const, sequence: 0, text, chunk: new Uint8Array(65_536), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "audio" as const, sequence: 1, chunk: new Uint8Array(65_536), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      let sequence = 0;
      for await (const _chunk of input.chunks) {
        for (let index = 0; index < 50; index += 1) {
          yield { sequence, pcm: new Int16Array([sequence]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
          sequence += 1;
        }
      }
    },
    talkRuntime: {
      openSession() {},
      ingestInput() {},
      closeSession() {},
      interruptOutput(input) {
        interrupts.push({
          elapsedMs: input.elapsedMs,
          totalMs: input.totalMs,
          beforeText: input.breakpointContext?.beforeText,
          afterText: input.breakpointContext?.afterText
        });
      }
    },
    emitStatus: (event) => statuses.push(event),
    sleep: async (ms) => {
      nowMs += ms;
      if (!interrupted && nowMs >= 1000) {
        interrupted = true;
        await call.setSpeechActive(true);
      }
    }
  });

  call = await plugin.createCall({ callId: "call-ratio-breakpoint", userId: "browser-ratio-breakpoint", offerSdp: "offer" });
  const result = await call.playReplyText(text, "ratio-breakpoint-output", {
    originalText: text
  });

  assert.equal(result.status, "interrupted");
  await waitFor(() => interrupts.length === 1);
  assert.deepEqual(interrupts, [{
    elapsedMs: 980,
    totalMs: 1024,
    beforeText: "这个声音……是老板你的声音吧",
    afterText: "！"
  }]);
  assert.equal(statuses.some((entry) => entry.state === "tts.stream.audio_text"), false);
});

test("WebRTC voice treats zero playedMs with known totalMs as all after text", async () => {
  const peer = new FakePeer();
  let call: any;
  let interrupted = false;
  const interrupts: Array<{ elapsedMs?: number; totalMs?: number; beforeText?: string; afterText?: string }> = [];
  const text = "刚开始播放的这一段";
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        yield { type: "audio" as const, sequence: 0, text, chunk: new Uint8Array(65_536), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      for await (const _chunk of input.chunks) {
        for (let sequence = 0; sequence < 60; sequence += 1) {
          yield { sequence, pcm: new Int16Array([sequence]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
        }
      }
    },
    talkRuntime: {
      openSession() {},
      ingestInput() {},
      closeSession() {},
      interruptOutput(input) {
        interrupts.push({
          elapsedMs: input.elapsedMs,
          totalMs: input.totalMs,
          beforeText: input.breakpointContext?.beforeText,
          afterText: input.breakpointContext?.afterText
        });
      }
    },
    sleep: async () => {
      if (!interrupted) {
        interrupted = true;
        await call.setSpeechActive(true);
      }
    }
  });

  call = await plugin.createCall({ callId: "call-zero-played-known-total", userId: "browser-zero-played-known-total", offerSdp: "offer" });
  const result = await call.playReplyText(text, "zero-played-known-total-output", { originalText: text });

  assert.equal(result.status, "interrupted");
  await waitFor(() => interrupts.length === 1);
  assert.deepEqual(interrupts, [{
    elapsedMs: 0,
    totalMs: 1024,
    beforeText: undefined,
    afterText: text
  }]);
});

test("WebRTC voice keeps consumer cache until the next stream text is consumed", async () => {
  const peer = new FakePeer();
  let call: any;
  let sleeps = 0;
  const statuses: Array<{ state: string; detail?: string }> = [];
  const interrupts: Array<{ beforeText?: string; afterText?: string }> = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        yield { type: "audio" as const, sequence: 0, text: "上一段。", chunk: new Uint8Array(2_560), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "audio" as const, sequence: 1, text: "下一段。", chunk: new Uint8Array(2_560), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      for await (const _chunk of input.chunks) {
        yield { sequence: 0, pcm: new Int16Array([1]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
        yield { sequence: 1, pcm: new Int16Array([2]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
      }
    },
    talkRuntime: {
      openSession() {},
      ingestInput() {},
      closeSession() {},
      interruptOutput(input) {
        interrupts.push({
          beforeText: input.breakpointContext?.beforeText,
          afterText: input.breakpointContext?.afterText
        });
      }
    },
    emitStatus: (event) => statuses.push(event),
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 2) await call.setSpeechActive(true);
    }
  });

  call = await plugin.createCall({ callId: "call-between-segments", userId: "browser-between-segments", offerSdp: "offer" });
  const result = await call.playReplyText("上一段。下一段。", "between-segments-output");

  assert.equal(result.status, "interrupted");
  await waitFor(() => interrupts.length === 1);
  assert.deepEqual(interrupts, [{ beforeText: undefined, afterText: "上一段。" }]);
  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.interrupt.breakpoint" && entry.detail === "前文= 后文=上一段。"), true);
});

test("WebRTC voice does not replace current segment cache with empty or none stream text", async () => {
  const peer = new FakePeer();
  let call: any;
  const interrupts: Array<{ beforeText?: string; afterText?: string }> = [];
  const yieldedTexts: Array<string | undefined> = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        yieldedTexts.push("当前段文本");
        yield { type: "audio" as const, sequence: 0, text: "当前段文本", chunk: new Uint8Array(2_560), contentType: "audio/L16; rate=32000; channels=1" };
        yieldedTexts.push(undefined);
        yield { type: "audio" as const, sequence: 1, chunk: new Uint8Array(2_560), contentType: "audio/L16; rate=32000; channels=1" };
        yieldedTexts.push("");
        yield { type: "audio" as const, sequence: 2, text: "", chunk: new Uint8Array(2_560), contentType: "audio/L16; rate=32000; channels=1" };
        yieldedTexts.push("none");
        yield { type: "audio" as const, sequence: 3, text: "none", chunk: new Uint8Array(2_560), contentType: "audio/L16; rate=32000; channels=1" };
        yieldedTexts.push("None");
        yield { type: "audio" as const, sequence: 4, text: "None", chunk: new Uint8Array(2_560), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      let sequence = 0;
      for await (const _chunk of input.chunks) {
        yield { sequence, pcm: new Int16Array([sequence]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
        sequence += 1;
      }
    },
    talkRuntime: {
      openSession() {},
      ingestInput() {},
      closeSession() {},
      interruptOutput(input) {
        interrupts.push({
          beforeText: input.breakpointContext?.beforeText,
          afterText: input.breakpointContext?.afterText
        });
      }
    },
    sleep: async () => {
      if (interrupts.length === 0) await call.setSpeechActive(true);
    }
  });

  call = await plugin.createCall({ callId: "call-empty-none-cache", userId: "browser-empty-none-cache", offerSdp: "offer" });
  const result = await call.playReplyText("当前段文本", "empty-none-cache-output");

  assert.equal(result.status, "interrupted");
  await waitFor(() => interrupts.length === 1);
  assert.deepEqual(interrupts, [{ beforeText: undefined, afterText: "当前段文本" }]);
  assert.deepEqual(yieldedTexts, ["当前段文本", undefined, ""]);
});

test("WebRTC voice sends breakpoint context without index to TalkRuntime on barge-in", async () => {
  const peer = new FakePeer();
  let call: any;
  let sleeps = 0;
  const interrupts: Array<{ outputId: string; beforeText?: string; afterText?: string }> = [];
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
      ingestInput() {},
      closeSession() {},
      interruptOutput(input) {
        interrupts.push({
          outputId: input.outputId,
          beforeText: input.breakpointContext?.beforeText,
          afterText: input.breakpointContext?.afterText
        });
      }
    },
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) await call.setSpeechActive(true);
    }
  });

  call = await plugin.createCall({ callId: "call-barge-breakpoint", userId: "browser-barge-breakpoint", offerSdp: "offer" });
  const result = await call.playReplyText("测试这一段语音", "breakpoint-output", {
    originalText: "测试这一段语音"
  });

  assert.equal(result.status, "interrupted");
  assert.deepEqual(interrupts, [{
    outputId: "breakpoint-output",
    beforeText: undefined,
    afterText: "测试这一段语音"
  }]);
});

async function fakeVoiceSynthesizer() {
  return { assetId: "generated/tts/fake.opus", filePath: tempFilePath("fake.opus") };
}

class FakePeer {
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

class ControlledQueueTrack implements ServerOutboundAudioTrack {
  readonly enqueued: Array<{ itemId: string; outputId?: string; filePath: string; assetId: string; text?: string }> = [];
  private readonly settlements: Array<{ resolve(value: PlaybackItemSettled): void }> = [];
  private readonly idleWaiters: Array<{ resolve(value: boolean): void }> = [];
  stopped = false;

  get waitingSettlements() {
    return this.settlements.length;
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

class RemotePlayingQueueTrack extends ControlledQueueTrack {
  constructor(private readonly snapshot: PlaybackConsumerSnapshot) {
    super();
  }

  getCurrentPlayback() {
    return this.snapshot;
  }
}

class DelayedEnqueueTrack extends ControlledQueueTrack {
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

class FakeAsrSession implements AsrInboundStreamSession {
  readonly streamId = "fake-stream";
  private readonly results: AsrInboundStreamAcceptResult[];

  constructor(results: AsrInboundStreamAcceptResult[]) {
    this.results = [...results];
  }

  async accept(): Promise<AsrInboundStreamAcceptResult> {
    return this.results.shift() ?? { ok: true, type: "ack", streamId: this.streamId, sequence: 0 };
  }
}

class FakeHangingAsrSession implements AsrInboundStreamSession {
  readonly streamId = "fake-hanging-stream";

  async accept(): Promise<AsrInboundStreamAcceptResult> {
    return new Promise<AsrInboundStreamAcceptResult>(() => undefined);
  }
}

function makeTempDir(name: string): string {
  const dir = path.join(process.cwd(), ".tmp-tests", `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tempFilePath(fileName: string): string {
  const dir = path.join(process.cwd(), ".tmp-tests", "webrtc-voice-files");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, fileName);
}

async function collectVoiceTextInput(text: string | AsyncIterable<string>): Promise<string> {
  if (typeof text === "string") return text;
  let result = "";
  for await (const part of text) result += part;
  return result;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
