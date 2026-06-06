import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebRtcVoicePlugin, defaultWebRtcVoiceConfig, encodePcmL16StreamToOpusRtpFrames, WebRtcVoiceError, type ServerAudioFrame, type WebRtcVoiceConfig } from "../plugins/webrtc-voice/src/index.js";
import type { AsrInboundStreamAcceptResult, AsrInboundStreamSession } from "../plugins/asr/src/index.js";
import { createTalkRuntime } from "../apps/api/src/talk-runtime.js";
import { createCurrentTimeProvider } from "../core/time/src/index.js";
import { createTalkStore } from "../packages/storage/src/talk-store.js";

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
  assert.match(html, /id="assistantOutputText"/);
  assert.match(html, /id="userInputText"/);
  assert.match(html, /tts\.output_text/);
  assert.match(html, /audio\.transcript\.final/);
  assert.match(html, /これは疑似ストリーミング音声のテストです。/);
  assert.match(html, /"sampleRateHz":16000/);
  assert.match(html, /"encoding":"pcm_s16le"/);
  assert.match(html, /addTransceiver\("audio", \{ direction: "recvonly" \}\)/);
  assert.doesNotMatch(html, /addTrack\(track/);
  assert.doesNotMatch(html, /startVad/);
  assert.doesNotMatch(html, /noiseGate/);
  assert.doesNotMatch(html, /estimateNoiseFloor/);
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
      return { assetId: "generated/tts/reply.opus", filePath: "/tmp/reply.opus" };
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
  assert.deepEqual(decodedFiles, ["/tmp/reply.opus"]);
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[1, 2], [3, 4]]);
  assert.equal(peer.outboundTrack?.stopped, false);
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
      return { assetId: "generated/tts/reply.opus", filePath: "/tmp/reply.opus" };
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
    voiceSynthesizer: Object.assign(async ({ text }: { text: string }) => {
      synthesizedTexts.push(text);
      return { assetId: "generated/tts/greeting.opus", filePath: "/tmp/greeting.opus" };
    }, {}),
    decodeAudioFileToFrames: async () => [
      { sequence: 0, pcm: new Int16Array([7]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ],
    talkRuntime: {
      openSession() {},
      ingestInput() {},
      closeSession() {},
      startAgentLoop(sessionId: string) {
        startedLoops.push(sessionId);
      },
      markOutputChunkPlayed(chunkId: string) {
        playedChunks.push(chunkId);
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
      }
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-runtime-output", userId: "browser-runtime-output", offerSdp: "offer" });

  assert.equal(statuses.some((entry) => entry.state === "voice_call.waiting" && entry.detail === "webrtc_voice:call-runtime-output"), true);
  await waitFor(() => (peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).length ?? 0) >= 1);
  assert.deepEqual(synthesizedTexts, ["接通测试。"]);
  assert.deepEqual(playedChunks, ["chunk-greeting"]);
  assert.deepEqual(startedLoops, ["webrtc_voice:call-runtime-output", "webrtc_voice:call-runtime-output"]);
  assert.equal(statuses.some((entry) => entry.state === "voice_call.connected" && entry.detail === "webrtc_voice:call-runtime-output"), true);
  assert.equal(sleeps[0], 1000);
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[7]]);
  await call.close("test_done");
});

test("WebRTC voice claims next TalkRuntime chunk after TTS is queued, before current playback ends", async () => {
  const peer = new FakePeer();
  const claimedChunks: string[] = [];
  const synthesizedTexts: string[] = [];
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
      async *stream({ text }: { text: string }) {
        synthesizedTexts.push(text);
        yield { type: "audio" as const, sequence: 0, chunk: new Uint8Array([1, 2]), contentType: "audio/L16; rate=32000; channels=1" };
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
      markOutputChunkPlayed() {},
      claimReadyOutputChunk(sessionId: string) {
        const chunk = chunks.shift();
        if (!chunk || sessionId !== chunk.sessionId) return undefined;
        claimedChunks.push(chunk.chunkId);
        return chunk;
      }
    },
    sleep: async (ms) => {
      if (ms === 20) await playbackSleep;
    }
  });

  const call = await plugin.createCall({ callId: "call-overlap", userId: "browser-overlap", offerSdp: "offer" });
  await waitFor(() => claimedChunks.length === 2 && synthesizedTexts.length === 2);

  assert.deepEqual(claimedChunks, ["chunk-1", "chunk-2"]);
  assert.deepEqual(synthesizedTexts, ["第一段。", "第二段。"]);
  assert.ok((peer.outboundTrack?.frames.length ?? 0) < 60);

  releasePlaybackSleep();
  await call.close("test_done");
});

test("WebRTC voice starts the next TalkRuntime loop after chunk is queued, before playback ends", async () => {
  const peer = new FakePeer();
  const startedLoops: string[] = [];
  let releasePlaybackSleep!: () => void;
  const playbackSleep = new Promise<void>((resolve) => {
    releasePlaybackSleep = resolve;
  });
  let claimed = false;
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        yield { type: "audio" as const, sequence: 0, chunk: new Uint8Array([1, 2]), contentType: "audio/L16; rate=32000; channels=1" };
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
      startAgentLoop(sessionId: string) {
        startedLoops.push(sessionId);
      },
      markOutputChunkPlayed() {},
      claimReadyOutputChunk(sessionId: string) {
        if (claimed || sessionId !== "webrtc_voice:call-loop-after-claim") return undefined;
        claimed = true;
        return { sessionId, outputId: "output-1", chunkId: "chunk-1", text: "第一段。" };
      }
    },
    sleep: async (ms) => {
      if (ms === 20) await playbackSleep;
    }
  });

  const call = await plugin.createCall({ callId: "call-loop-after-claim", userId: "browser-loop-after-claim", offerSdp: "offer" });
  await waitFor(() => startedLoops.length >= 2);

  assert.deepEqual(startedLoops, ["webrtc_voice:call-loop-after-claim", "webrtc_voice:call-loop-after-claim"]);
  assert.ok((peer.outboundTrack?.frames.length ?? 0) < 60);

  releasePlaybackSleep();
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
    { state: "asr.stream.started", detail: "asr-call-3-0" },
    { state: "talk_runtime.open.todo", detail: "webrtc_voice:call-3" },
    { state: "asr.partial", detail: "もし" },
    { state: "talk_runtime.ingress.todo", detail: "audio.transcript.final: もしもし" }
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
  call.interrupt("manual");
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
  call.interrupt("manual", "output-2");

  assert.equal(peer.outboundTrack?.stopped, false);
  assert.equal(call.playbackQueue.length, 0);
  assert.deepEqual(statuses.at(-1), { state: "talk_runtime.interrupt.todo", detail: "manual:output-2" });
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
      return { assetId: `generated/tts/${text}.opus`, filePath: `/tmp/${text}.opus` };
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
  assert.deepEqual(interrupts, [{ outputId: "current-output", elapsedMs: 20, totalMs: 40 }]);
});

test("WebRTC voice manual interrupt discards queued later TTS playback", async () => {
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
      }
    },
    sleep: async (ms) => {
      if (ms === 20) await playbackSleep;
    }
  });

  const call = await plugin.createCall({ callId: "call-discard-queued", userId: "browser-discard-queued", offerSdp: "offer" });
  const first = call.playReplyText("第一段。", "output-1");
  const second = call.playReplyText("第二段。", "output-2");
  await waitFor(() => (peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).length ?? 0) === 1);

  call.interrupt("manual");
  releasePlaybackSleep();

  assert.equal((await first).status, "interrupted");
  assert.equal((await second).status, "interrupted");
  assert.deepEqual(interrupts, ["output-1"]);
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[1]]);
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
  call.interrupt("manual");

  assert.deepEqual(latestInterrupts, ["webrtc_voice:call-interrupt-latest:manual"]);
  assert.deepEqual(ingestedKinds, []);
});

test("WebRTC voice barge-in between playback segments interrupts the queued next output", async () => {
  const interrupts: Array<{ outputId: string; omitAssistantMessage?: boolean; breakpointCharIndex?: number }> = [];
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
      return { assetId: "generated/tts/queued.opus", filePath: "/tmp/queued.opus" };
    }, {}),
    decodeAudioFileToFrames: async () => [
      { sequence: 0, pcm: new Int16Array([17]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ],
    talkRuntime: {
      openSession() {},
      closeSession() {},
      ingestInput() {},
      interruptOutput(input) {
        interrupts.push({
          outputId: input.outputId,
          omitAssistantMessage: input.omitAssistantMessage,
          breakpointCharIndex: input.breakpointCharIndex
        });
      }
    }
  });

  const call = await plugin.createCall({ callId: "call-between-segments", userId: "browser-between-segments", offerSdp: "offer" });
  const playback = call.playReplyText("第二段已经生成但还没有开始播放。", "output-17");
  await waitFor(() => call.playbackQueue.some((item) => item.outputId === "output-17" && item.status === "queued"));

  await call.setSpeechActive(true);
  await waitFor(() => interrupts.length === 1);

  assert.deepEqual(interrupts, [{ outputId: "output-17", omitAssistantMessage: true, breakpointCharIndex: undefined }]);
  resolveVoice();
  assert.equal((await playback).status, "interrupted");
  await call.close("test_done");
});

test("WebRTC voice pauses runtime output claiming while interrupt queue is not drained", async () => {
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
      return { assetId: text, filePath: `/tmp/${text}.opus` };
    }, {}),
    decodeAudioFileToFrames: async (input) => [
      { sequence: 0, pcm: new Int16Array([input.filePath.includes("第二段") ? 2 : 1]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ],
    talkRuntime: {
      openSession() {},
      ingestInput() {},
      closeSession() {},
      startAgentLoop() {},
      markOutputChunkPlayed() {},
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
  await waitFor(() => (peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).length ?? 0) === 1);
  call.interrupt("manual");
  await waitFor(() => interruptStarted);
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[1]]);
  assert.deepEqual(claimedChunks, ["chunk-1"]);
  assert.deepEqual(synthesizedTexts, ["第一段。"]);

  resolveInterrupt();
  releasePlaybackSleep();
  await waitFor(() => claimedChunks.length === 2 && synthesizedTexts.includes("第二段。"));
  assert.deepEqual(claimedChunks, ["chunk-1", "chunk-2"]);
  assert.deepEqual(synthesizedTexts, ["第一段。", "第二段。"]);
  await call.close("test_done");
});

test("WebRTC voice pseudo-streams TTS by sentence and stops later parts after interrupt", async () => {
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
      return { assetId: `generated/tts/${synthesizedTexts.length}.opus`, filePath: `/tmp/${synthesizedTexts.length}.opus` };
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
  assert.deepEqual(synthesizedTexts, ["第一句。"]);
  assert.deepEqual(peer.outboundTrack?.frames.map((frame) => Array.from(frame.pcm)), [[1]]);
  assert.equal(call.playbackQueue.length, 0);
  assert.equal(statuses.some((entry) => entry.state === "tts.part.playing" && entry.detail === "1/3"), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.interrupted" && entry.detail === "stream-output"), true);
});

test("WebRTC voice uses streaming TTS audio chunks when available", async () => {
  const peer = new FakePeer();
  const statuses: Array<{ state: string; detail?: string }> = [];
  const streamedTexts: string[] = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream({ text }: { text: string }) {
        streamedTexts.push(text);
        yield { type: "translation_started" as const, sequence: 0, sourceChars: text.length };
        yield { type: "translation_done" as const, sequence: 0, translatedChars: 4 };
        yield { type: "audio" as const, sequence: 0, chunk: new Uint8Array([1, 2, 3, 4]), contentType: "audio/L16; rate=32000; channels=1" };
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
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-stream", userId: "browser-stream", offerSdp: "offer" });
  const result = await call.playReplyText("ストリーム", "stream-output");

  assert.equal(result.status, "played");
  assert.deepEqual(streamedTexts, ["ストリーム"]);
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[9]]);
  assert.equal(statuses.some((entry) => entry.state === "tts.stream.started"), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.stream.frames_sent" && entry.detail === "sent=1"), true);
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
        yield { type: "audio" as const, sequence: 0, chunk: new Uint8Array([1, 2]), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "done" as const };
      }
    }),
    decodeAudioFileToFrames: async () => {
      throw new Error("file decoder should not be used");
    },
    encodePcmL16StreamToFrames: async function* (input) {
      const chunks: number[] = [];
      for await (const chunk of input.chunks) chunks.push(chunk.byteLength);
      assert.deepEqual(chunks, [2]);
      yield { sequence: 0, pcm: new Int16Array([1]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
      yield { sequence: 1, pcm: new Int16Array([2]), sampleRateHz: 48000, channels: 1, durationMs: 20 };
    },
    emitStatus: (event) => statuses.push(event)
  });

  const call = await plugin.createCall({ callId: "call-stream-queue", userId: "browser-stream-queue", offerSdp: "offer" });
  const result = await call.playReplyText("queue", "queue-output");

  assert.equal(result.status, "played");
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[1], [2]]);
  assert.equal(statuses.some((entry) => entry.state === "tts.queue.waiting"), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.queue.ready"), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.queue.producer_done"), true);
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
  assert.equal(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).length, 60);
  assert.deepEqual(sleeps.slice(0, 4), [1000, 20, 20, 20]);
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
  assert.equal(peer.outboundTrack?.frames.some((frame) => Array.from(frame.pcm).join(",") === "99"), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.queue.producer_done"), true);
  assert.equal(statuses.some((entry) => entry.state === "tts.queue.underrun"), false);
  assert.equal(statuses.some((entry) => entry.state === "tts.queue.rtp_keepalive"), false);
});

test("WebRTC voice does not barge in before streaming TTS writes audio", async () => {
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

  assert.equal(result.status, "played");
  assert.deepEqual(peer.outboundTrack?.frames.filter((frame) => frame.pcm.length > 0).map((frame) => Array.from(frame.pcm)), [[7]]);
  assert.equal(statuses.some((entry) => entry.state === "tts.barge_in"), false);
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
      return { assetId: `generated/tts/${synthesizedTexts.length}.opus`, filePath: `/tmp/${synthesizedTexts.length}.opus` };
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
  assert.deepEqual(synthesizedTexts, ["第一句。"]);
  assert.equal(statuses.some((entry) => entry.state === "tts.barge_in" && entry.detail === "barge-output"), true);
  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.interrupt.todo" && entry.detail === "barge_in:barge-output"), true);
});

test("WebRTC voice plays the first pseudo-stream part before the next TTS part completes", async () => {
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
      return { assetId: `generated/tts/${text}.opus`, filePath: `/tmp/${text}.opus` };
    }, {}),
    decodeAudioFileToFrames: async (input) => [
      { sequence: 0, pcm: new Int16Array([input.filePath.includes("第一") ? 1 : 2]), sampleRateHz: 48000, channels: 1, durationMs: 20 }
    ]
  });

  const call = await plugin.createCall({ callId: "call-first-part-immediate", userId: "browser-first-part-immediate", offerSdp: "offer" });
  const playback = call.playReplyText("第一句。第二句。", "part-output");
  await waitFor(() => (peer.outboundTrack?.frames.length ?? 0) === 1);

  assert.deepEqual(peer.outboundTrack?.frames.map((frame) => Array.from(frame.pcm)), [[1]]);
  releaseSecondPart();
  assert.equal((await playback).status, "played");
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
      return { assetId: `generated/tts/${text}.opus`, filePath: `/tmp/${text}.opus` };
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
  await waitFor(() => (peer.outboundTrack?.frames.length ?? 0) === 1);
  call.interrupt("manual", "output-first");

  const second = call.playReplyText("第二句。", "output-second");
  await waitFor(() => call.playbackQueue.some((item) => item.outputId === "output-second"));
  call.interrupt("manual", "output-second");

  assert.equal((await first).status, "interrupted");
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
      return { assetId: `generated/tts/${text}.opus`, filePath: `/tmp/${text}.opus` };
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
  assert.deepEqual(interrupts, [{ elapsedMs: 20, totalMs: 60 }]);
});

test("WebRTC voice sends chunk-derived breakpoint index and context to TalkRuntime on barge-in", async () => {
  const peer = new FakePeer();
  let call: any;
  let sleeps = 0;
  const interrupts: Array<{ outputId: string; breakpointCharIndex?: number; beforeText?: string; afterText?: string }> = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async ({ text }: { text: string }) => {
      return { assetId: `generated/tts/${text}.opus`, filePath: `/tmp/${text}.opus` };
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
          breakpointCharIndex: input.breakpointCharIndex,
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
    outputStartCharIndex: 10,
    outputEndCharIndex: 17,
    originalText: "测试这一段语音"
  });

  assert.equal(result.status, "interrupted");
  assert.deepEqual(interrupts, [{
    outputId: "breakpoint-output",
    breakpointCharIndex: 14,
    beforeText: "测试这一",
    afterText: "段语音"
  }]);
});

async function fakeVoiceSynthesizer() {
  return { assetId: "generated/tts/fake.opus", filePath: "/tmp/fake.opus" };
}

class FakePeer {
  readonly withoutOutboundTrack: boolean;
  readonly candidates: unknown[] = [];
  closed = false;
  outboundTrack?: FakeOutboundTrack;

  constructor(input: { withoutOutboundTrack?: boolean } = {}) {
    this.withoutOutboundTrack = Boolean(input.withoutOutboundTrack);
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
    this.outboundTrack = new FakeOutboundTrack();
    return this.outboundTrack;
  }

  close() {
    this.closed = true;
  }
}

class FakeOutboundTrack {
  frames: ServerAudioFrame[] = [];
  stopped = false;

  async writeFrame(frame: ServerAudioFrame) {
    this.frames.push(frame);
    return true;
  }

  stop() {
    this.stopped = true;
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

function makeTempDir(name: string): string {
  const dir = path.join(process.cwd(), ".tmp-tests", `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
