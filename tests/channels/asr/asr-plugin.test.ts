import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { transcribeWithAsrPlugin, type AsrPluginConfig } from "../../../src/channels/asr/src/index.js";
import { assertAsrError, assertAsrSuccess, jsonResponse, writeAsrConfigFixture, writeAudioFixture } from "./asr-plugin-helpers.js";

test("openaiCompatible_validAudio_sendsMultipartAndReturnsText", async () => {
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
      assert.ok((requestInit.body as FormData).has("model"));
      assert.ok((requestInit.body as FormData).has("language"));
      assert.ok((requestInit.body as FormData).has("prompt"));
      return jsonResponse({ text: "你好 Alice" });
    }
  });

  assertAsrSuccess(result);
  assert.equal(requests.length, 1);
  assert.equal(result.provider, "openai_compatible");
  assert.ok(result.model);
  assert.ok(result.language);
  assert.equal(typeof result.durationMs, "number");
});

test("tencent_validAudio_createsTaskPollsAndReturnsText", async () => {
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
  assert.equal(result.provider, "tencent");
  assert.ok(result.model);
  assert.equal(result.requestId, "describe-request");
});

test("providerTimeout_configuredPreset_passesAbortSignal", async () => {
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
  assert.ok(result.text);
});

test("tencent_largeLocalFile_splitsAndCombinesChunks", async () => {
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
  assert.ok(result.text);
});

test("providerRequest_firstTimeout_retriesAndReturnsText", async () => {
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
  assert.ok(result.text);
});

test("asrPlugin_disabled_returnsDisabledError", async () => {
  const audioPath = writeAudioFixture("empty.wav");
  const result = await transcribeWithAsrPlugin({ audioFile: audioPath }, {
    enabled: false,
    defaultProvider: "openai_compatible",
    providers: {}
  }, {});

  assertAsrError(result);
  assert.equal(result.ok, false);
});

test("asrPlugin_emptyTranscription_returnsEmptyError", async () => {
  const audioPath = writeAudioFixture("empty.wav");
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
        timeoutMs: 60_000,
        temperature: 0.2,
        stream: false,
        extraParams: {},
        followupExtraParams: {}
      };
    },
    fetch: async () => jsonResponse({ text: "" })
  });

  assertAsrError(result);
  assert.equal(result.ok, false);
});
