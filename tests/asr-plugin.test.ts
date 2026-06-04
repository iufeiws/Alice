import { test } from "node:test";
import assert from "node:assert/strict";
import { createAsrInboundStreamSession, transcribeWithAsrPlugin, type AsrPluginConfig } from "../plugins/asr/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("openai compatible ASR sends multipart transcription request and normalizes text", async () => {
  const audioPath = writeAudioFixture("openai-compatible.wav");
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const config: AsrPluginConfig = {
    enabled: true,
    defaultProvider: "openai_compatible",
    providers: {
      openaiCompatible: {
        apiPresetName: "siliconflow",
        responseFormat: "json"
      }
    }
  };

  const result = await transcribeWithAsrPlugin({
    audioFile: audioPath,
    filename: "speech.wav",
    language: "zh",
    prompt: "Alice"
  }, config, {
    resolveApiPreset(name: string) {
      assert.equal(name, "siliconflow");
      return {
        name,
        baseURL: "https://api.siliconflow.cn/v1",
        apiKey: "secret",
        model: "FunAudioLLM/SenseVoiceSmall",
        timeoutMs: 60_000,
        temperature: 0.2,
        stream: false,
        extraParams: {},
        followupExtraParams: {}
      };
    },
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const requestInit = init ?? {};
      requests.push({ url: String(url), init: requestInit });
      assert.equal(String(url), "https://api.siliconflow.cn/v1/audio/transcriptions");
      assert.equal(requestInit.method, "POST");
      assert.equal((requestInit.headers as Record<string, string>).authorization, "Bearer secret");
      assert.ok(requestInit.body instanceof FormData);
      assert.equal((requestInit.body as FormData).get("model"), "FunAudioLLM/SenseVoiceSmall");
      assert.equal((requestInit.body as FormData).get("language"), "zh");
      assert.equal((requestInit.body as FormData).get("prompt"), "Alice");
      return jsonResponse({ text: "你好 Alice" });
    }
  });

  assertAsrSuccess(result);
  assert.equal(requests.length, 1);
  assert.equal(result.text, "你好 Alice");
  assert.equal(result.provider, "openai_compatible");
  assert.equal(result.model, "FunAudioLLM/SenseVoiceSmall");
  assert.equal(result.language, "zh");
  assert.equal(typeof result.durationMs, "number");
});

test("tencent ASR creates a task, polls status, and normalizes result text", async () => {
  const audioPath = writeAudioFixture("tencent.wav");
  const actions: string[] = [];
  const config: AsrPluginConfig = {
    enabled: true,
    defaultProvider: "tencent",
    providers: {
      tencent: {
        secretId: "secret-id",
        secretKey: "secret-key",
        region: "ap-guangzhou",
        engineModelType: "16k_zh",
        pollIntervalMs: 1,
        timeoutMs: 1000
      }
    }
  };

  const result = await transcribeWithAsrPlugin({ audioFile: audioPath, filename: "speech.wav" }, config, {
    sleep: async () => {},
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      actions.push(headers["x-tc-action"]);
      assert.match(headers.authorization, /^TC3-HMAC-SHA256 Credential=secret-id\//);
      assert.equal(headers["x-tc-region"], "ap-guangzhou");
      const body = JSON.parse(String(init?.body));
      if (headers["x-tc-action"] === "CreateRecTask") {
        assert.equal(body.EngineModelType, "16k_zh");
        assert.equal(body.SourceType, 1);
        assert.equal(body.ProjectId, undefined);
        assert.equal(typeof body.Data, "string");
        assert.equal(body.DataLen, fs.statSync(audioPath).size);
        return jsonResponse({ Response: { Data: { TaskId: 42 }, RequestId: "create-request" } });
      }
      assert.equal(headers["x-tc-action"], "DescribeTaskStatus");
      assert.equal(body.TaskId, 42);
      return jsonResponse({
        Response: {
          Data: {
            Status: 2,
            Result: "腾讯云识别结果"
          },
          RequestId: "describe-request"
        }
      });
    }
  });

  assertAsrSuccess(result);
  assert.deepEqual(actions, ["CreateRecTask", "DescribeTaskStatus"]);
  assert.equal(result.text, "腾讯云识别结果");
  assert.equal(result.provider, "tencent");
  assert.equal(result.model, "16k_zh");
  assert.equal(result.requestId, "describe-request");
});

test("ASR provider requests include abort signals for configured timeouts", async () => {
  const audioPath = writeAudioFixture("timeout-signal.wav");
  const result = await transcribeWithAsrPlugin({ audioFile: audioPath }, {
    enabled: true,
    defaultProvider: "openai_compatible",
    providers: {
      openaiCompatible: {
        apiPresetName: "openai"
      }
    }
  }, {
    resolveApiPreset() {
      return {
        name: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "secret",
        model: "whisper-1",
        timeoutMs: 1234,
        temperature: 0.2,
        stream: false,
        extraParams: {},
        followupExtraParams: {}
      };
    },
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      assert.ok(init?.signal instanceof AbortSignal);
      assert.equal(init.signal.aborted, false);
      return jsonResponse({ text: "ok" });
    }
  });

  assertAsrSuccess(result);
  assert.equal(result.text, "ok");
});

test("Tencent ASR splits local files larger than provider upload limit and sends every chunk", async () => {
  const audioPath = writeAudioFixture("tencent-large.wav", 5 * 1024 * 1024 + 1);
  let createCalls = 0;
  const taskIds = [101, 102];
  const result = await transcribeWithAsrPlugin({ audioFile: audioPath }, {
    enabled: true,
    defaultProvider: "tencent",
    providers: {
      tencent: {
        secretId: "secret-id",
        secretKey: "secret-key",
        engineModelType: "16k_zh",
        pollIntervalMs: 1,
        timeoutMs: 1000
      }
    }
  }, {
    sleep: async () => {},
    splitAudio: async (input) => {
      assert.equal(input.filePath, audioPath);
      assert.equal(input.maxChunkBytes, 5 * 1024 * 1024);
      return [
        { bytes: new Uint8Array(10).fill(1), filename: "chunk-1.wav" },
        { bytes: new Uint8Array(10).fill(2), filename: "chunk-2.wav" }
      ];
    },
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body));
      if (headers["x-tc-action"] === "CreateRecTask") {
        createCalls += 1;
        assert.equal(body.DataLen, 10);
        return jsonResponse({ Response: { Data: { TaskId: taskIds[createCalls - 1] }, RequestId: `create-${createCalls}` } });
      }
      assert.equal(headers["x-tc-action"], "DescribeTaskStatus");
      return jsonResponse({
        Response: {
          Data: {
            Status: 2,
            Result: body.TaskId === 101 ? "第一段" : "第二段"
          },
          RequestId: `describe-${body.TaskId}`
        }
      });
    }
  });

  assertAsrSuccess(result);
  assert.equal(createCalls, 2);
  assert.equal(result.text, "第一段\n第二段");
});

test("ASR retries timed out provider requests before returning failure", async () => {
  const audioPath = writeAudioFixture("retry-timeout.wav");
  let calls = 0;
  const result = await transcribeWithAsrPlugin({ audioFile: audioPath }, {
    enabled: true,
    defaultProvider: "openai_compatible",
    providers: {
      openaiCompatible: {
        apiPresetName: "openai",
        retryCount: 1,
        retryBackoffMs: 1
      }
    }
  }, {
    sleep: async () => {},
    resolveApiPreset() {
      return {
        name: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "secret",
        model: "whisper-1",
        timeoutMs: 1000,
        temperature: 0.2,
        stream: false,
        extraParams: {},
        followupExtraParams: {}
      };
    },
    fetch: async () => {
      calls += 1;
      if (calls === 1) throw new Error("timeout");
      return jsonResponse({ text: "retry ok" });
    }
  });

  assertAsrSuccess(result);
  assert.equal(calls, 2);
  assert.equal(result.text, "retry ok");
});

test("ASR plugin returns unified errors for disabled and empty transcription states", async () => {
  const audioPath = writeAudioFixture("empty.wav");
  const disabled = await transcribeWithAsrPlugin({ audioFile: audioPath }, {
    enabled: false,
    defaultProvider: "openai_compatible",
    providers: {}
  }, {});

  assertAsrError(disabled);
  assert.equal(disabled.ok, false);
  assert.equal(disabled.error, "asr_disabled");

  const empty = await transcribeWithAsrPlugin({ audioFile: audioPath }, {
    enabled: true,
    defaultProvider: "openai_compatible",
    providers: {
      openaiCompatible: {
        apiPresetName: "openai"
      }
    }
  }, {
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
    fetch: async () => jsonResponse({ text: "" })
  });

  assertAsrError(empty);
  assert.equal(empty.ok, false);
  assert.equal(empty.error, "empty_transcription");
});

test("ASR inbound stream protocol buffers chunks and transcribes final audio without timing metadata in text", async () => {
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

test("ASR pseudo stream cuts on conservative long pauses and returns stable partials", async () => {
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

test("ASR inbound stream protocol rejects out-of-order chunks and supports abort", async () => {
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

test("Tencent ASR inbound stream uses native websocket streaming when configured", async () => {
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

class FakeWebSocket {
  sent: Array<string | Uint8Array> = [];
  closed = false;
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  send(data: string | Uint8Array) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    const entries = this.listeners.get(type) ?? [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }

  emitMessage(data: string) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data });
  }
}

function writeAudioFixture(fileName: string, size = 14): string {
  const dir = path.join("/tmp", "alice-asr-plugin-tests");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, new Uint8Array(size).fill(1));
  return filePath;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function assertAsrSuccess(result: unknown): asserts result is { text: string; provider: string; model?: string; language?: string; durationMs?: number; requestId?: string } {
  assert.equal(typeof result, "object");
  assert.ok(result !== null);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "ok"), false);
}

function assertAsrError(result: unknown): asserts result is { ok: false; error: string } {
  assert.equal(typeof result, "object");
  assert.ok(result !== null);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "ok"), true);
  assert.equal((result as { ok?: unknown }).ok, false);
}
