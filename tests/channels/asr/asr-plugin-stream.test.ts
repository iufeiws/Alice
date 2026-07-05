import { test } from "node:test";
import assert from "node:assert/strict";
import { createAsrInboundStreamSession, createAsrPlugin, type AsrPluginConfig } from "../../../src/channels/asr/src/index.js";
import { FakeWebSocket, jsonResponse, writeAsrConfigFixture } from "./asr-plugin-helpers.js";

test("inboundStream_chunksAndEnd_transcribesFinalAudio", async () => {
  const receivedFiles: Array<{ name: string; size: number; model: unknown }> = [];
  const config: AsrPluginConfig = {
    enabled: true,
    defaultProvider: "openai_compatible",
    providers: {
      openaiCompatible: {
        apiPresetName: "openai",
        responseFormat: "json"
      }
    }
  };
  const session = createAsrInboundStreamSession({
    type: "start",
    streamId: "stream-1",
    audio: {
      filename: "stream.wav",
      mimeType: "audio/wav"
    },
    language: "zh",
    metadata: {
      source: "unit-test"
    }
  }, config, {
    resolveApiPreset() {
      return {
        name: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "secret",
        model: "whisper-1",
        timeoutMs: 60_000,
        temperature: 0.2,
        stream: false,
        extraParams: {},
        followupExtraParams: {}
      };
    },
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      receivedFiles.push({ name: file.name, size: file.size, model: form.get("model") });
      return jsonResponse({ text: "[语音][0:0.020,0:5.000]  你有注意到我加了我发语音的功能吗？" });
    }
  });

  assert.deepEqual(await session.accept({
    type: "chunk",
    streamId: "stream-1",
    sequence: 0,
    bytes: new Uint8Array([1, 2]),
    timing: { startMs: 20, endMs: 2500, durationMs: 2480 }
  }), { ok: true, type: "ack", streamId: "stream-1", sequence: 0 });
  assert.deepEqual(await session.accept({
    type: "chunk",
    streamId: "stream-1",
    sequence: 1,
    bytes: new Uint8Array([3, 4, 5]),
    timing: { startMs: 2500, endMs: 5000, durationMs: 2500 }
  }), { ok: true, type: "ack", streamId: "stream-1", sequence: 1 });

  const result = await session.accept({
    type: "end",
    streamId: "stream-1",
    metadata: { durationMs: 5000 }
  });

  assert.equal(result.ok, true);
  assert.equal(result.type, "final");
  assert.equal(result.streamId, "stream-1");
  assert.equal(result.result?.text, "你有注意到我加了我发语音的功能吗？");
  assert.equal(result.result?.rawStream?.chunks, 2);
  assert.equal(result.result?.rawStream?.bytes, 5);
  assert.deepEqual(receivedFiles, [{ name: "stream.wav", size: 5, model: "whisper-1" }]);
});

test("pluginInboundStream_pluginDeps_reusesConfiguredDeps", async () => {
  const configPath = writeAsrConfigFixture("plugin-stream-deps.json", {
    enabled: true,
    defaultProvider: "openai_compatible",
    providers: {
      openaiCompatible: {
        apiPresetName: "plugin-preset",
        responseFormat: "json"
      }
    }
  });
  const calls: string[] = [];
  const plugin = createAsrPlugin({
    configPath,
    resolveApiPreset(name) {
      calls.push(`preset:${name}`);
      return {
        name,
        baseURL: "https://api.example.com/v1",
        apiKey: "secret",
        model: "stream-model"
      };
    },
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(`fetch:${(init?.body as FormData).get("model")}`);
      return jsonResponse({ text: "插件 deps 生效" });
    }
  });

  const session = plugin.createInboundStreamSession({
    type: "start",
    streamId: "plugin-stream",
    audio: {
      filename: "stream.wav",
      mimeType: "audio/wav"
    }
  });
  await session.accept({ type: "chunk", streamId: "plugin-stream", sequence: 0, bytes: new Uint8Array([1, 2, 3]) });
  const final = await session.accept({ type: "end", streamId: "plugin-stream" });

  assert.equal(final.ok, true);
  assert.equal(final.type, "final");
  assert.equal(final.result?.text, "插件 deps 生效");
  assert.deepEqual(calls, ["preset:plugin-preset", "fetch:stream-model"]);
});

test("pseudoStream_longPause_returnsStablePartials", async () => {
  const receivedFiles: Array<{ name: string; size: number; model: unknown }> = [];
  const responses = ["第一句", "第二句"];
  const config: AsrPluginConfig = {
    enabled: true,
    defaultProvider: "openai_compatible",
    providers: {
      openaiCompatible: {
        apiPresetName: "openai",
        responseFormat: "json"
      }
    }
  };
  const session = createAsrInboundStreamSession({
    type: "start",
    streamId: "pseudo-pause-stream",
    audio: {
      filename: "stream.wav",
      mimeType: "audio/wav"
    }
  }, config, {
    resolveApiPreset() {
      return {
        name: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "secret",
        model: "whisper-1",
        timeoutMs: 60_000,
        temperature: 0.2,
        stream: false,
        extraParams: {},
        followupExtraParams: {}
      };
    },
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      receivedFiles.push({ name: file.name, size: file.size, model: form.get("model") });
      return jsonResponse({ text: responses.shift() ?? "" });
    }
  });

  assert.deepEqual(await session.accept({
    type: "chunk",
    streamId: "pseudo-pause-stream",
    sequence: 0,
    bytes: new Uint8Array([1, 2]),
    timing: { startMs: 0, endMs: 1000, durationMs: 1000 }
  }), { ok: true, type: "ack", streamId: "pseudo-pause-stream", sequence: 0 });

  const partial = await session.accept({
    type: "chunk",
    streamId: "pseudo-pause-stream",
    sequence: 1,
    bytes: new Uint8Array([3, 4, 5]),
    timing: { startMs: 3000, endMs: 4200, durationMs: 1200 }
  });
  assert.equal(partial.ok, true);
  assert.equal(partial.type, "partial");
  assert.equal(partial.text, "第一句");
  assert.equal(partial.stable, true);

  const final = await session.accept({
    type: "end",
    streamId: "pseudo-pause-stream"
  });
  assert.equal(final.ok, true);
  assert.equal(final.type, "final");
  assert.equal(final.result?.text, "第一句\n第二句");
  assert.deepEqual(receivedFiles, [
    { name: "stream.wav", size: 2, model: "whisper-1" },
    { name: "stream.wav", size: 3, model: "whisper-1" }
  ]);
});

test("openaiCompatiblePseudoStream_pcm16_wrapsChunksAsWav", async () => {
  const receivedFiles: Array<{ name: string; type: string; size: number }> = [];
  const config: AsrPluginConfig = {
    enabled: true,
    defaultProvider: "openai_compatible",
    providers: {
      openaiCompatible: {
        apiPresetName: "openai",
        responseFormat: "json"
      }
    }
  };
  const session = createAsrInboundStreamSession({
    type: "start",
    streamId: "pcm-stream",
    audio: {
      filename: "call.pcm",
      mimeType: "audio/pcm",
      sampleRateHz: 16000,
      channels: 1,
      encoding: "pcm16"
    }
  }, config, {
    resolveApiPreset() {
      return {
        name: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "secret",
        model: "whisper-1",
        timeoutMs: 60_000,
        stream: false,
        extraParams: {},
        followupExtraParams: {}
      };
    },
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      receivedFiles.push({ name: file.name, type: file.type, size: file.size });
      return jsonResponse({ text: "はい" });
    }
  });

  await session.accept({
    type: "chunk",
    streamId: "pcm-stream",
    sequence: 0,
    bytes: new Uint8Array([1, 0, 2, 0])
  });
  const result = await session.accept({ type: "end", streamId: "pcm-stream" });

  assert.equal(result.ok, true);
  assert.deepEqual(receivedFiles, [{ name: "call.wav", type: "audio/wav", size: 48 }]);
});

test("inboundStream_outOfOrderChunk_returnsProtocolError", async () => {
  const config: AsrPluginConfig = {
    enabled: true,
    defaultProvider: "openai_compatible",
    providers: {
      openaiCompatible: {
        apiPresetName: "openai"
      }
    }
  };
  const session = createAsrInboundStreamSession({
    type: "start",
    streamId: "stream-2",
    audio: { filename: "stream.wav", mimeType: "audio/wav" }
  }, config, {});

  assert.deepEqual(await session.accept({ type: "chunk", streamId: "stream-2", sequence: 1, bytes: new Uint8Array([1]) }), {
    ok: false,
    type: "error",
    streamId: "stream-2",
    error: "out_of_order_chunk"
  });
});

test("inboundStream_abortClosesStream", async () => {
  const config: AsrPluginConfig = {
    enabled: true,
    defaultProvider: "openai_compatible",
    providers: {
      openaiCompatible: {
        apiPresetName: "openai"
      }
    }
  };
  const session = createAsrInboundStreamSession({
    type: "start",
    streamId: "stream-2",
    audio: { filename: "stream.wav", mimeType: "audio/wav" }
  }, config, {});

  assert.deepEqual(await session.accept({ type: "abort", streamId: "stream-2", reason: "caller_cancelled" }), {
    ok: true,
    type: "aborted",
    streamId: "stream-2",
    reason: "caller_cancelled"
  });
  assert.deepEqual(await session.accept({ type: "chunk", streamId: "stream-2", sequence: 0, bytes: new Uint8Array([1]) }), {
    ok: false,
    type: "error",
    streamId: "stream-2",
    error: "stream_closed"
  });
});

test("tencentInboundStream_configuredRealtime_opensWebsocketOnAudio", async () => {
  const sockets: FakeWebSocket[] = [];
  const config: AsrPluginConfig = {
    enabled: true,
    defaultProvider: "tencent",
    providers: {
      tencent: {
        appId: "1259220000",
        secretId: "secret-id",
        secretKey: "secret-key",
        engineModelType: "16k_zh",
        realtimeVoiceFormat: 12,
        realtimeNeedVad: 1
      }
    }
  };
  const session = createAsrInboundStreamSession({
    type: "start",
    streamId: "voice-stream-1",
    audio: { filename: "stream.wav", mimeType: "audio/wav" }
  }, config, {
    now: () => new Date("2026-06-03T00:00:00.000Z"),
    createWebSocket(url) {
      assert.match(url, /^wss:\/\/asr\.cloud\.tencent\.com\/asr\/v2\/1259220000\?/);
      assert.match(url, /engine_model_type=16k_zh/);
      assert.match(url, /voice_id=voice-stream-1/);
      assert.match(url, /voice_format=12/);
      assert.match(url, /needvad=1/);
      assert.match(url, /signature=/);
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    }
  });

  assert.equal(sockets.length, 0);
  assert.deepEqual(await session.accept({ type: "chunk", streamId: "voice-stream-1", sequence: 0, bytes: new Uint8Array([1, 2]) }), {
    ok: true,
    type: "ack",
    streamId: "voice-stream-1",
    sequence: 0
  });
  assert.deepEqual(sockets[0].sent, [new Uint8Array([1, 2])]);

  sockets[0].emitMessage(JSON.stringify({
    code: 0,
    message: "success",
    voice_id: "voice-stream-1",
    result: { slice_type: 1, index: 0, start_time: 0, end_time: 1500, voice_text_str: "你有注意到" }
  }));
  const partial = await session.accept({ type: "chunk", streamId: "voice-stream-1", sequence: 1, bytes: new Uint8Array([3]) });
  assert.equal(partial.ok, true);
  assert.equal(partial.type, "partial");
  assert.equal(partial.text, "你有注意到");
  assert.deepEqual(sockets[0].sent.at(-1), new Uint8Array([3]));

  sockets[0].emitMessage(JSON.stringify({
    code: 0,
    message: "success",
    voice_id: "voice-stream-1",
    result: { slice_type: 2, index: 0, start_time: 0, end_time: 3500, voice_text_str: "你有注意到我加了语音功能吗？" }
  }));
  const stable = await session.accept({ type: "chunk", streamId: "voice-stream-1", sequence: 2, bytes: new Uint8Array([4]) });
  assert.equal(stable.ok, true);
  assert.equal(stable.type, "partial");
  assert.equal(stable.text, "你有注意到我加了语音功能吗？");
  assert.equal(stable.stable, true);

  sockets[0].emitMessage(JSON.stringify({ code: 0, message: "success", voice_id: "voice-stream-1", final: 1 }));
  const final = await session.accept({ type: "end", streamId: "voice-stream-1" });
  assert.equal(final.ok, true);
  assert.equal(final.type, "final");
  assert.equal(final.result?.text, "你有注意到我加了语音功能吗？");
  assert.deepEqual(sockets[0].sent.at(-1), "{\"type\":\"end\"}");
  assert.equal(sockets[0].closed, true);
});

test("tencentInboundStream_noAudio_doesNotOpenWebsocket", async () => {
  const sockets: FakeWebSocket[] = [];
  const config: AsrPluginConfig = {
    enabled: true,
    defaultProvider: "tencent",
    providers: {
      tencent: {
        appId: "1259220000",
        secretId: "secret-id",
        secretKey: "secret-key",
        engineModelType: "16k_zh"
      }
    }
  };
  const session = createAsrInboundStreamSession({
    type: "start",
    streamId: "idle-stream",
    audio: { filename: "stream.pcm", mimeType: "audio/pcm", encoding: "pcm_s16le" }
  }, config, {
    createWebSocket() {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    }
  });

  assert.equal(sockets.length, 0);
  assert.deepEqual(await session.accept({ type: "end", streamId: "idle-stream" }), {
    ok: false,
    type: "error",
    streamId: "idle-stream",
    error: "empty_stream"
  });
  assert.equal(sockets.length, 0);
});
