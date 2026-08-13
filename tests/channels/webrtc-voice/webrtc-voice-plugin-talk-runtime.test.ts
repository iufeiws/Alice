import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebRtcVoiceRuntime } from "../../../src/apps/api/bootstrap/web-rtc-voice-runtime.js";
import { createWebRtcVoicePlugin, defaultWebRtcVoiceConfig, encodePcmL16StreamToOpusRtpFrames, WebRtcVoiceError, type ServerAudioFrame } from "../../../src/channels/webrtc-voice/src/index.js";
import { createTalkRuntime } from "../../../src/contexts/talk-session/src/application/talk-session-runtime.js";
import type { SessionClearRequest } from "../../../src/contexts/llm-session/src/application/session-clear-coordinator.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createTalkStore } from "../../../src/contexts/talk-session/src/adapters/sqlite-talk-session-store.js";
import { ControlledQueueTrack, DelayedEnqueueTrack, FakeAsrSession, FakeHangingAsrSession, FakePeer, RemotePlayingQueueTrack, collectVoiceTextInput, defaultConfig, fakeVoiceSynthesizer, makeTempDir, tempFilePath, waitFor } from "./webrtc-voice-plugin-helpers.js";

const path = await import("node:path");

test("asrFinal_talkRuntimeIngressTodo_marksTodoWithoutIngesting", async () => {
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
  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.open.todo" && entry.detail === String(call.talkSessionId)), true);
  assert.equal(statuses.some((entry) => entry.state === "asr.partial"), true);
  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.ingress.todo"), true);
  assert.equal(statuses.some((entry) => entry.state === "asr.stream.final"), true);
});

test("WebRTC voice opens injected TalkRuntime session", async () => {
  const { call, statuses } = await createCallWithInjectedTalkRuntime("open");

  try {
    assert.equal(call.talkRuntimeIngressStatus, "connected");
    assert.equal(statuses.some((entry) => entry.state === "talk_runtime.open" && entry.detail === String(call.talkSessionId)), true);
  } finally {
    await call.close("test_done");
  }
});

test("WebRTC voice ingests final transcript into injected TalkRuntime", async () => {
  const { call, statuses, talkRuntime } = await createCallWithInjectedTalkRuntime("final");

  try {
    await call.endInboundAudio();
    assert.deepEqual(talkRuntime.buildNextLoopMessagePatch(call.talkSessionId).messages, [
      { role: "user", content: "もしもし" }
    ]);
    assert.equal(statuses.some((entry) => entry.state === "talk_runtime.ingress" && entry.detail === "audio.transcript.final: もしもし"), true);
  } finally {
    await call.close("test_done");
  }
});

test("WebRTC voice records manual interrupt in injected TalkRuntime", async () => {
  const { call, talkRuntime } = await createCallWithInjectedTalkRuntime("interrupt");

  try {
    talkRuntime.appendAssistantDelta({ sessionId: call.talkSessionId, outputId: "output-talk-runtime", delta: "まだ話している途中です。" });
    await call.interrupt("manual");

    assert.equal(talkRuntime.store.listSegments(call.talkSessionId).some((segment) => segment.kind === "interrupt"), true);
    assert.equal(talkRuntime.store.getOutput("output-talk-runtime")?.status, "interrupted");
  } finally {
    await call.close("test_done");
  }
});

test("WebRTC voice closes injected TalkRuntime session", async () => {
  const { call, statuses } = await createCallWithInjectedTalkRuntime("close");

  await call.close("manual");

  assert.equal(statuses.some((entry) => entry.state === "talk_runtime.close" && entry.detail === "manual"), true);
});

async function createCallWithInjectedTalkRuntime(suffix: string) {
  const statuses: Array<{ state: string; detail?: string }> = [];
  const talkRuntime = createTalkRuntime({
    store: createTalkStore(path.join(makeTempDir(`webrtc-talk-runtime-${suffix}`), "talk.sqlite")),
    time: createCurrentTimeProvider("Asia/Tokyo", () => new Date("2026-06-06T15:00:00.000Z")),
    // §7.1: coordinator 为统一入口, 任何 clear 路径都必须经过它。
    sessionClearCoordinator: {
      async clearSession(request: SessionClearRequest) {
        if (!request.exists()) return { cleared: false, shortMemoryCaptured: false };
        await request.clear();
        return { cleared: true, shortMemoryCaptured: false };
      }
    },
    acquireMainAgentClear: () => ({ acquired: true, token: "test-clear", release() {} }),
    rewriteActiveTalkLLMSessionFromRuntime() {},
    clearActiveTalkLLMSession() {}
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
  return { call, statuses, talkRuntime };
}

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

  assert.deepEqual(latestInterrupts, [`${call.talkSessionId}:manual`]);
  assert.deepEqual(ingestedKinds, []);
});
