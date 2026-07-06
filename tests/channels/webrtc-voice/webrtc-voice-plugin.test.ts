import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebRtcVoiceRuntime } from "../../../src/apps/api/bootstrap/web-rtc-voice-runtime.js";
import { createWebRtcVoicePlugin, encodePcmL16StreamToOpusRtpFrames, WebRtcVoiceError, type ServerAudioFrame } from "../../../src/channels/webrtc-voice/src/index.js";
import { createTalkRuntime } from "../../../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createTalkStore } from "../../../src/contexts/talk-session/src/adapters/sqlite-talk-session-store.js";
import { ControlledQueueTrack, DelayedEnqueueTrack, FakeAsrSession, FakeHangingAsrSession, FakePeer, RemotePlayingQueueTrack, collectVoiceTextInput, defaultConfig, fakeVoiceSynthesizer, makeTempDir, tempFilePath, waitFor } from "./webrtc-voice-plugin-helpers.js";

const path = await import("node:path");

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
      markAgentLoopReady() {}
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
        return { sessionId: 1780830000000 };
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

  assert.equal(call.talkSessionId, 1780830000000);
  assert.equal((asrMetadata[0] as { talkSessionId?: number }).talkSessionId, 1780830000000);
  assert.equal((ingested[0] as { sessionId?: number }).sessionId, 1780830000000);
  assert.equal((closed[0] as { sessionId?: number }).sessionId, 1780830000000);
});

test("WebRTC voice sends base64 audio directly when talk preset supports audio", async () => {
  let asrCreated = 0;
  const ingested: any[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    supportsAudioInput: () => true,
    createPeer: async () => new FakePeer(),
    createAsrSession: () => {
      asrCreated += 1;
      return new FakeAsrSession([]);
    },
    voiceSynthesizer: fakeVoiceSynthesizer,
    decodeAudioFileToFrames: async () => [],
    talkRuntime: {
      openSession() {
        return { sessionId: 1780830000100 };
      },
      ingestInput(event) {
        ingested.push(event);
      }
    }
  });

  const call = await plugin.createCall({ callId: "call-direct-audio", userId: "browser-direct-audio", offerSdp: "offer" });
  await call.acceptInboundAudioChunk(new Uint8Array([1, 0, 2, 0]), { startMs: 0, endMs: 100, durationMs: 100 });
  await call.endInboundAudio();

  assert.equal(asrCreated, 0);
  assert.equal(ingested[0].kind, "audio.input.final");
  assert.equal(ingested[0].payload.kind, "audio");
  assert.equal(ingested[0].payload.format, "wav");
  assert.equal(Buffer.from(ingested[0].payload.data, "base64").subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(ingested[0].payload.sampleRateHz, 16000);
  assert.equal(ingested[0].payload.channels, 1);
  await call.close("test_done");
});

test("WebRTC runtime keeps ASR preflight when direct audio input is disabled", async () => {
  const runtime = createWebRtcVoiceRuntime({
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-28T00:00:00.000Z")),
    asrPlugin: {
      id: "asr",
      config: {
        enabled: true,
        defaultProvider: "openai_compatible",
        directAudioInputEnabled: false,
        providers: {}
      },
      transcribe: async () => ({ ok: false, error: "missing_audio_file" }),
      createInboundStreamSession: () => new FakeAsrSession([])
    },
    voiceSynthesizer: fakeVoiceSynthesizer,
    talkRuntime: {} as any,
    supportsAudioInput: () => true,
    readLLMApiPresets: () => [],
    appendLog: () => {}
  });

  await assert.rejects(
    runtime.plugin.createCall({ callId: "call-direct-disabled", userId: "browser-direct-disabled", offerSdp: "offer" }),
    (error) => error instanceof WebRtcVoiceError && error.code === "asr_preflight_failed"
  );
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

test("WebRTC voice playback synthesizes Japanese voice", async () => {
  const scenario = await createSingleFilePlaybackScenario();

  assert.equal(scenario.result.status, "played");
  assert.deepEqual(scenario.synthesizedTexts, ["晚点见"]);
  await scenario.call.close("test_done");
});

test("WebRTC voice playback decodes generated audio with outbound contract", async () => {
  const scenario = await createSingleFilePlaybackScenario();

  assert.deepEqual(scenario.decodedInputs, [{
    filePath: tempFilePath("reply.opus"),
    sampleRateHz: 48000,
    channels: 1,
    frameMs: 20
  }]);
  await scenario.call.close("test_done");
});

test("WebRTC voice playback writes decoded frames to outbound track", async () => {
  const scenario = await createSingleFilePlaybackScenario();

  assert.deepEqual(scenario.peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[1, 2], [3, 4]]);
  assert.equal(scenario.peer.outboundTrack?.stopped, false);
  await scenario.call.close("test_done");
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

test("callSetup_asrPreflightFails_rejectsBeforePeerCreation", async () => {
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
  assert.equal(statuses.some((entry) => entry.state === "asr.preflight.failed" && entry.detail === "boom"), true);
});

async function createSingleFilePlaybackScenario() {
  const peer = new FakePeer();
  const synthesizedTexts: string[] = [];
  const decodedInputs: Array<{ filePath: string; sampleRateHz: number; channels: number; frameMs: number }> = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async ({ text }: { text: string }) => {
      synthesizedTexts.push(text);
      return { assetId: "generated/tts/reply.opus", filePath: tempFilePath("reply.opus") };
    }, {}),
    decodeAudioFileToFrames: async (input) => {
      decodedInputs.push({
        filePath: input.filePath,
        sampleRateHz: input.sampleRateHz,
        channels: input.channels,
        frameMs: input.frameMs
      });
      return [
        { sequence: 0, pcm: new Int16Array([1, 2]), sampleRateHz: 48000, channels: 1, durationMs: 20 },
        { sequence: 1, pcm: new Int16Array([3, 4]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
      ];
    }
  });

  const call = await plugin.createCall({ callId: "call-2", userId: "browser-2", offerSdp: "offer" });
  const result = await call.playReplyText("晚点见", "output-1");
  return { call, decodedInputs, peer, result, synthesizedTexts };
}
