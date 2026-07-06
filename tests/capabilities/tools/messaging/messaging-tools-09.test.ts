import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";
import { createMessagingTools } from "../../../../src/capabilities/tools/messaging/src/index.js";
import { createFinishAndWaitTools } from "../../../../src/capabilities/tools/finish-and-wait/src/index.js";
import { collectTtsStreamText, createBailianTtsVoiceSynthesizer, createConfiguredVoiceSynthesizer, createFallbackVoiceSynthesizer, createGenieTtsVoiceSynthesizer, createMimoTtsVoiceSynthesizer, createMossOnnxVoiceSynthesizer, createOpenAiApiTtsVoiceSynthesizer, createTtsPcmProgressTextMapper, createTtsPlugin, createTtsRemoteAwareVoiceSynthesizer, createTtsTranslationSynthesizer, resolveTtsText, splitTtsStreamParts, splitTtsTextChunks, synthesizeTtsRouted, ttsGenieOverrides, readTtsPluginConfig, type VoiceSynthesizer } from "../../../../src/channels/tts/src/index.js";
import { createAliceStore } from "../../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { AgentOutput } from "../../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";

const fs = await import("node:fs");
const fsp = await import("node:fs/promises");
const path = await import("node:path");
const os = await import("node:os");
const events = await import("node:events");

const genieRequiredModelFiles = [
  "t2s_encoder_fp32.bin",
  "t2s_encoder_fp32.onnx",
  "t2s_first_stage_decoder_fp32.onnx",
  "t2s_shared_fp16.bin",
  "t2s_stage_decoder_fp32.onnx",
  "vits_fp16.bin",
  "vits_fp32.onnx"
];

function writeTtsConfigFile(configPath: string, input: any, presetName: string, preset: any) {
  fs.mkdirSync(path.join(path.dirname(configPath), "presets"), { recursive: true });
  const { translationEnabled, apiPresetName, prompt, translationPresets, translationPresetName = "default", ...rest } = input;
  fs.writeFileSync(configPath, JSON.stringify({
    ...rest,
    activePresetName: presetName,
    editPresetName: presetName,
    translationPresetName,
    translationPresets: translationPresets ?? { [translationPresetName]: { translationEnabled, apiPresetName, prompt } }
  }));
  fs.writeFileSync(path.join(path.dirname(configPath), "presets", `${presetName}.json`), JSON.stringify(preset));
}

async function runGenieUploadRetryScenario(scenario: "model" | "reference") {
  const fixture = makeTtsAssetFixture(`tts-genie-remote-${scenario}-missing`);
  fs.writeFileSync(path.join(fixture.root, "reference.txt"), "参照テキスト\n");
  const resolvedModelDir = path.resolve("assets", fixture.modelDir);
  const streamQueries: Array<Record<string, string>> = [];
  const streamBodies: string[] = [];
  const uploadBodies: Uint8Array[] = [];
  const uploadContentTypes: Array<string | undefined> = [];
  const uploadModelDirs: Array<string | null> = [];
  let streamAttempts = 0;
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (parsed.pathname === "/stream-input") {
      streamAttempts += 1;
      streamQueries.push(Object.fromEntries(parsed.searchParams.entries()));
      streamBodies.push(String(init?.body));
      if (streamAttempts === 1) {
        return new Response(JSON.stringify(scenario === "model" ? {
          ok: false,
          code: "MODEL_NOT_UPLOADED",
          modelDir: resolvedModelDir,
          uploadUrl: `/models/upload?modelDir=${encodeURIComponent(resolvedModelDir)}`
        } : {
          ok: false,
          code: "REFERENCE_NOT_UPLOADED",
          error: "reference files are missing"
        }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(scenario === "model" ? [7, 8] : [9, 10]));
          controller.close();
        }
      }), { status: 200, headers: { "content-type": "audio/L16; rate=32000; channels=1" } });
    }
    if (parsed.pathname === "/models/upload") {
      uploadModelDirs.push(parsed.searchParams.get("modelDir"));
      uploadContentTypes.push(init?.headers && (init.headers as Record<string, string>)["content-type"]);
      uploadBodies.push(init?.body as Uint8Array);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected request: ${parsed.pathname}`);
  };
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieBaseURL: "http://127.0.0.1:8767",
    genieBaseURLExplicit: true,
    genieOutputDir: "generated/tts",
    assetRoot: fixture.assetRoot,
    genieIdleShutdownMs: 0
  }, { fetch: fakeFetch as typeof fetch, spawn: fakeFfmpegSpawn() });

  try {
    const chunks = [];
    for await (const chunk of synthesize.streamAudio!({
      text: "第一段。",
      time: createCurrentTimeProvider("UTC"),
      genie: scenario === "model" ? {
        language: "zh",
        modelDir: fixture.modelDir,
        referenceText: "参照テキスト",
        splitText: false
      } : {
        language: "zh",
        modelDir: fixture.modelDir
      }
    })) {
      chunks.push(Array.from(chunk));
    }
    return { chunks, resolvedModelDir, streamBodies, streamQueries, uploadBodies, uploadContentTypes, uploadModelDirs };
  } finally {
    fixture.cleanup();
  }
}

test("genie remote stream uploads missing model archive", async () => {
  const result = await runGenieUploadRetryScenario("model");

  assert.equal(result.uploadBodies.length, 1);
  assert.equal(result.uploadContentTypes[0], "application/zip");
  assert.equal(result.uploadModelDirs[0], result.resolvedModelDir);
  assert.deepEqual(Array.from(result.uploadBodies[0].slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
});

test("genie remote stream retries original stream-input after missing model upload", async () => {
  const result = await runGenieUploadRetryScenario("model");

  assert.equal(result.streamQueries.length, 2);
  assert.deepEqual(result.streamQueries[1], result.streamQueries[0]);
  assert.equal(result.streamBodies.length, 2);
});

test("genie remote stream returns audio after missing model upload retry", async () => {
  const result = await runGenieUploadRetryScenario("model");

  assert.equal(result.chunks.length, 1);
});

test("genie remote text stream decodes ndjson audio text chunks", async () => {
  const fixture = makeTtsAssetFixture("tts-genie-remote-ndjson");
  fs.writeFileSync(path.join(fixture.root, "reference.txt"), "参照テキスト\n");
  const streamQueries: Array<Record<string, string>> = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (parsed.pathname === "/stream-input") {
      streamQueries.push(Object.fromEntries(parsed.searchParams.entries()));
      const body = [
        JSON.stringify({
          type: "audio",
          text: "これは一文目です。",
          format: "s16le",
          sampleRate: 32000,
          channels: 1,
          audioBase64: "AQI="
        }),
        JSON.stringify({
          type: "audio",
          text: "二文目です。",
          format: "s16le",
          sampleRate: 32000,
          channels: 1,
          audioBase64: "AwQ="
        }),
        JSON.stringify({ type: "done" })
      ].join("\n") + "\n";
      return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }
    throw new Error("unexpected request");
  };
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieBaseURL: "http://127.0.0.1:8767",
    genieBaseURLExplicit: true,
    genieOutputDir: "generated/tts",
    assetRoot: fixture.assetRoot,
    genieIdleShutdownMs: 0
  }, { fetch: fakeFetch as typeof fetch, spawn: fakeFfmpegSpawn() });

  try {
    const chunks = [];
    for await (const chunk of synthesize.streamAudioWithText!({
      text: "これは一文目です。二文目です。",
      time: createCurrentTimeProvider("UTC"),
      genie: {
        language: "jp",
        modelDir: fixture.modelDir,
        referenceText: "参照テキスト"
      }
    })) {
      chunks.push([chunk.text, Array.from(chunk.chunk)]);
    }

    assert.equal(streamQueries[0].responseFormat, "ndjson");
    assert.deepEqual(chunks, [
      ["これは一文目です。", [1, 2]],
      ["二文目です。", [3, 4]]
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("genie remote stream uploads missing reference files", async () => {
  const result = await runGenieUploadRetryScenario("reference");

  assert.equal(result.uploadBodies.length, 1);
  assert.equal(result.uploadContentTypes[0], "application/zip");
  assert.equal(result.uploadModelDirs[0], result.resolvedModelDir);
});

test("genie remote stream retries original stream-input after missing reference upload", async () => {
  const result = await runGenieUploadRetryScenario("reference");

  assert.equal(result.streamQueries.length, 2);
  assert.deepEqual(result.streamQueries[1], result.streamQueries[0]);
});

test("genie remote stream returns audio after missing reference upload retry", async () => {
  const result = await runGenieUploadRetryScenario("reference");

  assert.equal(result.chunks.length, 1);
});

test("fallback voice synthesizer uses local synthesis when remote synthesis fails", async () => {
  const logs: string[] = [];
  const calls: string[] = [];
  const remote = Object.assign(async () => {
    calls.push("remote");
    throw new Error("remote offline");
  }, {}) as any;
  const local = Object.assign(async () => {
    calls.push("local");
    return { assetId: "generated/tts/local.opus", filePath: path.join(makeTempDir("fallback-local-tts"), "assets", "generated", "tts", "local.opus") };
  }, {}) as any;
  const synthesize = createFallbackVoiceSynthesizer(remote, local, {
    appendLog: (_level, message) => logs.push(message)
  });

  const result = await synthesize({ text: "また後で", time: createCurrentTimeProvider("UTC") });

  assert.deepEqual(calls, ["remote", "local"]);
  assert.equal(result.assetId, "generated/tts/local.opus");
  assert.equal(logs.length > 0, true);
});

test("remote-aware tts does not prepare local Genie when API provider is selected", async () => {
  const dir = makeTempDir("tts-remote-aware-api");
  const configPath = path.join(dir, "config.json");
  writeTtsConfigFile(configPath, {
    enabled: true,
    translationEnabled: false,
    prompt: "Read aloud."
  }, "openai-api", { provider: "openai-api", openaiApi: {
    baseURL: "https://tts.example.test/v1",
    model: "voice-model",
    voice: "voice"
  } });
  const calls: string[] = [];
  const synthesize = createTtsRemoteAwareVoiceSynthesizer({ ttsConfigPath: configPath }, {
    fetch: (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response("", { status: 503 });
    }) as typeof fetch,
    spawn: (() => {
      throw new Error("local Genie should not start");
    }) as any
  });

  await synthesize.prepare?.();
  synthesize.noteActivity?.();

  assert.deepEqual(calls, []);
});

test("remote-aware tts disabled local fallback does not start local Genie after remote failure", async () => {
  const dir = makeTempDir("tts-remote-aware-no-local-fallback");
  const configPath = path.join(dir, "config.json");
  writeTtsConfigFile(configPath, {
    enabled: true,
    translationEnabled: false,
    prompt: "Read aloud."
  }, "genie-remote", { provider: "genie", genie: {
    enabled: true,
    baseURL: "192.168.0.103",
    localFallbackEnabled: false
  } });
  const calls: string[] = [];
  const logs: string[] = [];
  const synthesize = createTtsRemoteAwareVoiceSynthesizer({ ttsConfigPath: configPath }, {
    fetch: (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response("", { status: 503 });
    }) as typeof fetch,
    spawn: (() => {
      throw new Error("local Genie should not start");
    }) as any,
    appendLog: (_level, message) => logs.push(message)
  });

  await assert.rejects(
    () => synthesize({ text: "また後で", time: createCurrentTimeProvider("UTC") }),
    /Genie TTS service is not healthy/
  );

  assert.equal(calls.length > 0, true);
});

test("remote-aware tts retries fetch failed stream before audio", async () => {
  const dir = makeTempDir("tts-remote-aware-stream-retry");
  const configPath = path.join(dir, "config.json");
  writeTtsConfigFile(configPath, {
    enabled: true,
    translationEnabled: false,
    prompt: ""
  }, "genie-remote", { provider: "genie", genie: {
    enabled: true,
    baseURL: "remote.test",
    localFallbackEnabled: false
  } });
  const calls: string[] = [];
  const logs: string[] = [];
  const synthesize = createTtsRemoteAwareVoiceSynthesizer({ ttsConfigPath: configPath }, {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      calls.push(`${init?.method ?? "GET"} ${parsed.pathname}`);
      if (parsed.pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (parsed.pathname === "/stream") {
        if (calls.filter((call) => call === "POST /stream").length < 3) throw new Error("fetch failed");
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.close();
          }
        }), { status: 200, headers: { "content-type": "audio/L16; rate=32000; channels=1" } });
      }
      throw new Error(`unexpected request: ${parsed.pathname}`);
    }) as typeof fetch,
    spawn: (() => {
      throw new Error("local Genie should not start");
    }) as any,
    appendLog: (_level, message) => logs.push(message)
  });

  const chunks = [];
  for await (const chunk of synthesize.streamAudioWithText!({ text: "第一段。", time: createCurrentTimeProvider("UTC") })) {
    chunks.push(Array.from(chunk.chunk));
  }

  assert.deepEqual(calls, ["GET /health", "POST /stream", "GET /health", "POST /stream", "GET /health", "POST /stream"]);
  assert.equal(chunks.length, 1);
  assert.equal(logs.length > 0, true);
});

async function eventually(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let seedInboundCounter = 0;

function seedUserInbound(store: ReturnType<typeof createAliceStore>, conversationId: string, plugin: string): void {
  seedInboundCounter += 1;
  store.upsertInboundMessage({
    plugin,
    externalMessageId: `seed_user_inbound_${seedInboundCounter}`,
    conversationId,
    senderId: "user-1",
    senderRole: "user",
    contentType: "text",
    contentText: "user reply",
    createdAt: new Date(Date.parse("2026-05-25T00:00:00.000Z") + seedInboundCounter).toISOString()
  });
}

function makeTtsAssetFixture(prefix: string): { root: string; assetRoot: string; modelDir: string; referenceAudio: string; cleanup(): void } {
  const assetRoot = path.join(makeTempDir(`${prefix}-asset-root`), "assets");
  const root = path.join(assetRoot, "generated", `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const modelDir = path.join(root, "model");
  const referenceAudio = path.join(root, "reference.wav");
  fs.mkdirSync(modelDir, { recursive: true });
  for (const fileName of genieRequiredModelFiles) {
    fs.writeFileSync(path.join(modelDir, fileName), "model");
  }
  fs.writeFileSync(referenceAudio, "wav");
  return {
    root,
    assetRoot,
    modelDir,
    referenceAudio,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function fakeFfmpegSpawn(): any {
  return ((command: string, args: readonly string[]) => {
    const child = new events.EventEmitter() as any;
    child.stdout = new events.EventEmitter();
    child.stderr = new events.EventEmitter();
    child.exitCode = null;
    process.nextTick(() => {
      if (command === "ffmpeg") {
        if (args.includes("-f") && args.includes("s16le") && String(args[args.length - 1]) === "-") {
          const pcm = new Uint8Array(2000);
          for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
            pcm[offset] = 0xff;
            pcm[offset + 1] = 0x3f;
          }
          child.stdout.emit("data", pcm);
        } else {
          fs.writeFileSync(String(args[args.length - 1]), "opus");
        }
      }
      child.emit("exit", 0, null);
    });
    return child;
  }) as any;
}
