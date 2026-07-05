import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebRtcVoiceRuntime } from "../../../src/apps/api/bootstrap/web-rtc-voice-runtime.js";
import { createWebRtcVoicePlugin, defaultWebRtcVoiceConfig, encodePcmL16StreamToOpusRtpFrames, WebRtcVoiceError, type ServerAudioFrame } from "../../../src/channels/webrtc-voice/src/index.js";
import { createTalkRuntime } from "../../../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createTalkStore } from "../../../src/contexts/talk-session/src/adapters/sqlite-talk-session-store.js";
import { ControlledQueueTrack, DelayedEnqueueTrack, FakeAsrSession, FakeHangingAsrSession, FakePeer, RemotePlayingQueueTrack, collectVoiceTextInput, defaultConfig, fakeVoiceSynthesizer, makeTempDir, tempFilePath, waitFor } from "./webrtc-voice-plugin-helpers.js";

const path = await import("node:path");

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
});

test("WebRTC voice does not replace current segment cache with empty or none stream text", async () => {
  const peer = new FakePeer();
  let call: any;
  const interrupts: Array<{ beforeText?: string; afterText?: string }> = [];
  const plugin = createWebRtcVoicePlugin({
    config: defaultConfig,
    createPeer: async () => peer,
    createAsrSession: () => new FakeAsrSession([]),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("file synthesizer should not be used");
    }, {
      async *stream() {
        yield { type: "audio" as const, sequence: 0, text: "当前段文本", chunk: new Uint8Array(2_560), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "audio" as const, sequence: 1, chunk: new Uint8Array(2_560), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "audio" as const, sequence: 2, text: "", chunk: new Uint8Array(2_560), contentType: "audio/L16; rate=32000; channels=1" };
        yield { type: "audio" as const, sequence: 3, text: "none", chunk: new Uint8Array(2_560), contentType: "audio/L16; rate=32000; channels=1" };
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
