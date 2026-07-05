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

test("configured voice synthesizer falls back to moss when genie model is missing", async () => {
  const calls: string[] = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${pathname}`);
    if (pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (pathname === "/synthesize") {
      const body = JSON.parse(String(init?.body)) as { outputPath: string };
      fs.mkdirSync(path.dirname(body.outputPath), { recursive: true });
      fs.writeFileSync(body.outputPath, "wav");
      return new Response(JSON.stringify({ ok: true, audioPath: body.outputPath }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const synthesize = createConfiguredVoiceSynthesizer({
    backend: "genie-tts",
    genieModelDir: "assets/tts/genie/models/not-found",
    mossBaseURL: "http://127.0.0.1:9876",
    mossReferenceAudio: "test.opus",
    mossOutputDir: "generated/tts",
    assetRoot: path.join(makeTempDir("tts-asset-root"), "assets"),
    mossIdleShutdownMs: 0,
    mossFfmpegCommand: "ffmpeg"
  }, { fetch: fakeFetch as typeof fetch, spawn: fakeFfmpegSpawn() });

  const result = await synthesize({ text: "晚点见", time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")) });

  assert.match(result.assetId, /^generated\/tts\/20260526_000000_000\.opus$/);
  assert.deepEqual(calls, ["GET /health", "POST /synthesize"]);
  await fsp.unlink(result.filePath);
});

test("genie tts voice synthesizer calls service and returns opus asset", async () => {
  const fixture = makeTtsAssetFixture("tts-genie-call");
  const calls: string[] = [];
  const requestedTexts: string[] = [];
  const requestedOverrides: Array<Record<string, unknown>> = [];
  const ffmpegArgs: string[][] = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${pathname}`);
    if (pathname === "/health") return new Response(JSON.stringify({ ok: true, ready: true }), { status: 200 });
    if (pathname === "/synthesize") {
      const body = JSON.parse(String(init?.body)) as { text: string; outputPath: string } & Record<string, unknown>;
      requestedTexts.push(body.text);
      requestedOverrides.push({
        language: body.language,
        modelDir: body.modelDir,
        referenceAudioPath: body.referenceAudioPath,
        referenceText: body.referenceText,
        partSilenceSeconds: body.partSilenceSeconds,
        splitText: body.splitText
      });
      fs.mkdirSync(path.dirname(body.outputPath), { recursive: true });
      fs.writeFileSync(body.outputPath, "wav");
      return new Response(JSON.stringify({ ok: true, audioPath: body.outputPath }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const ffmpegSpawn = fakeFfmpegSpawn();
  const spawn = ((command: string, args: readonly string[]) => {
    if (command === "ffmpeg") ffmpegArgs.push([...args]);
    return ffmpegSpawn(command, args);
  }) as any;
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieBaseURL: "http://127.0.0.1:8767",
    genieOutputDir: "generated/tts",
    assetRoot: fixture.assetRoot,
    genieIdleShutdownMs: 0,
    genieFfmpegCommand: "ffmpeg"
  }, { fetch: fakeFetch as typeof fetch, spawn });

  try {
    const text = "啊……\n等等、、、可以吗？？";
    const result = await synthesize({
      text,
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
      genie: {
        language: "jp",
        modelDir: fixture.modelDir,
        referenceAudio: fixture.referenceAudio,
        referenceText: "参照テキスト",
        speed: 1.25,
        partSilenceSeconds: 0.4,
        splitText: false
      }
    });

    assert.match(result.assetId, /^generated\/tts\/20260526_000000_000\.opus$/);
    assert.equal(fs.readFileSync(result.filePath, "utf8"), "opus");
    assert.deepEqual(calls, ["GET /health", "POST /synthesize"]);
    assert.deepEqual(requestedTexts, [text]);
    assert.deepEqual(requestedOverrides, [{
      language: "jp",
      modelDir: path.resolve("assets", fixture.modelDir),
      referenceAudioPath: path.resolve("assets", fixture.referenceAudio),
      referenceText: "参照テキスト",
      partSilenceSeconds: 0.4,
      splitText: false
    }]);
    assert.ok(ffmpegArgs.some((args) => args.includes("-filter:a") && args.includes("atempo=1.25")));
    await fsp.unlink(result.filePath);
  } finally {
    fixture.cleanup();
  }
});

test("genie tts recovers generated file when synthesize response times out", async () => {
  const calls: string[] = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${pathname}`);
    if (pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (pathname === "/synthesize") {
      const body = JSON.parse(String(init?.body)) as { outputPath: string };
      fs.mkdirSync(path.dirname(body.outputPath), { recursive: true });
      fs.writeFileSync(body.outputPath, "wav");
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieBaseURL: "http://127.0.0.1:8767",
    genieOutputDir: "generated/tts",
    assetRoot: path.join(makeTempDir("tts-asset-root"), "assets"),
    genieTimeoutMs: 5,
    genieIdleShutdownMs: 0,
    genieFfmpegCommand: "ffmpeg"
  }, { fetch: fakeFetch as typeof fetch, spawn: fakeFfmpegSpawn() });

  const result = await synthesize({
    text: "また後で",
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z"))
  });

  assert.deepEqual(calls, ["GET /health", "POST /synthesize"]);
  assert.match(result.assetId, /^generated\/tts\/20260526_000000_000\.opus$/);
  assert.equal(fs.readFileSync(result.filePath, "utf8"), "opus");
  await fsp.unlink(result.filePath);
});

test("genie tts exposes streaming PCM chunks through streamAudio", async () => {
  const calls: string[] = [];
  const requestBodies: unknown[] = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${pathname}`);
    if (pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (pathname === "/stream") {
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        }
      }), { status: 200, headers: { "content-type": "audio/L16; rate=32000; channels=1" } });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieBaseURL: "http://127.0.0.1:8767",
    genieOutputDir: "generated/tts",
    assetRoot: path.join(makeTempDir("tts-asset-root"), "assets"),
    genieIdleShutdownMs: 0
  }, { fetch: fakeFetch as typeof fetch, spawn: fakeFfmpegSpawn() });

  const chunks = [];
  for await (const chunk of synthesize.streamAudio!({
    text: "また後で",
    time: createCurrentTimeProvider("UTC"),
    genie: {
      language: "jp",
      splitText: true
    }
  })) {
    chunks.push(Array.from(chunk));
  }

  assert.deepEqual(calls, ["GET /health", "POST /stream"]);
  assert.deepEqual(requestBodies, [{ text: "また後で", language: "jp", splitText: true }]);
  assert.deepEqual(chunks, [[1, 2], [3, 4]]);
});

test("genie tts can synthesize an opus asset from remote stream audio", async () => {
  const calls: string[] = [];
  const requestBodies: Array<Record<string, unknown>> = [];
  const ffmpegArgs: string[][] = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${pathname}`);
    if (pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (pathname === "/stream") {
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0xff, 0x3f, 0x00, 0x40]));
          controller.close();
        }
      }), { status: 200, headers: { "content-type": "audio/L16; rate=32000; channels=1" } });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const ffmpegSpawn = fakeFfmpegSpawn();
  const spawn = ((command: string, args: readonly string[]) => {
    if (command === "ffmpeg") ffmpegArgs.push([...args]);
    return ffmpegSpawn(command, args);
  }) as any;
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieBaseURL: "http://127.0.0.1:8767",
    genieOutputDir: "generated/tts",
    assetRoot: path.join(makeTempDir("tts-asset-root"), "assets"),
    genieIdleShutdownMs: 0,
    genieFfmpegCommand: "ffmpeg",
    genieUseStreamForSynthesis: true
  }, { fetch: fakeFetch as typeof fetch, spawn });

  const result = await synthesize({
    text: "また後で",
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    genie: {
      language: "jp",
      speed: 1.15,
      splitText: true
    }
  });

  assert.deepEqual(calls, ["GET /health", "POST /stream"]);
  assert.deepEqual(requestBodies, [{ text: "また後で", language: "jp", splitText: true }]);
  assert.match(result.assetId, /^generated\/tts\/20260526_000000_000\.opus$/);
  assert.equal(fs.readFileSync(result.filePath, "utf8"), "opus");
  assert.ok(ffmpegArgs.some((args) => args.includes("-filter:a") && args.includes("atempo=1.15")));
  await fsp.unlink(result.filePath);
});

test("genie explicit remote synthesizes wav bytes through synthesize without server outputPath", async () => {
  const fixture = makeTtsAssetFixture("tts-genie-remote-synthesize");
  const calls: string[] = [];
  const requestBodies: Array<Record<string, unknown>> = [];
  const uploadBodies: Uint8Array[] = [];
  const ffmpegArgs: string[][] = [];
  let synthesizeAttempts = 0;
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(String(url));
    calls.push(`${init?.method ?? "GET"} ${parsed.pathname}`);
    if (parsed.pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (parsed.pathname === "/synthesize") {
      synthesizeAttempts += 1;
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (synthesizeAttempts === 1) {
        return new Response(JSON.stringify({
          ok: false,
          code: "MODEL_NOT_UPLOADED",
          modelDir: path.resolve("assets", fixture.modelDir),
          uploadUrl: `/models/upload?modelDir=${encodeURIComponent(path.resolve("assets", fixture.modelDir))}`
        }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), { status: 200, headers: { "content-type": "audio/wav" } });
    }
    if (parsed.pathname === "/models/upload") {
      uploadBodies.push(init?.body as Uint8Array);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const ffmpegSpawn = fakeFfmpegSpawn();
  const spawn = ((command: string, args: readonly string[]) => {
    if (command === "ffmpeg") ffmpegArgs.push([...args]);
    return ffmpegSpawn(command, args);
  }) as any;
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieBaseURL: "http://127.0.0.1:8767",
    genieBaseURLExplicit: true,
    genieOutputDir: "generated/tts",
    assetRoot: fixture.assetRoot,
    genieIdleShutdownMs: 0,
    genieFfmpegCommand: "ffmpeg"
  }, { fetch: fakeFetch as typeof fetch, spawn });

  try {
    const result = await synthesize({
      text: "第一段。",
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
      genie: {
        language: "zh",
        modelDir: fixture.modelDir,
        referenceAudio: fixture.referenceAudio,
        referenceText: "参照テキスト",
        speed: 1.15,
        splitText: false
      }
    });

    assert.deepEqual(calls, ["GET /health", "POST /synthesize", "POST /models/upload", "POST /synthesize"]);
    assert.equal(uploadBodies.length, 1);
    assert.deepEqual(requestBodies, [
      {
        text: "第一段。",
        language: "zh",
        modelDir: path.resolve("assets", fixture.modelDir),
        referenceText: "参照テキスト",
        splitText: false
      },
      {
        text: "第一段。",
        language: "zh",
        modelDir: path.resolve("assets", fixture.modelDir),
        referenceText: "参照テキスト",
        splitText: false
      }
    ]);
    assert.match(result.assetId, /^generated\/tts\/20260526_000000_000\.opus$/);
    assert.equal(fs.readFileSync(result.filePath, "utf8"), "opus");
    assert.ok(ffmpegArgs.some((args) => args.includes("-filter:a") && args.includes("atempo=1.15")));
    await fsp.unlink(result.filePath);
  } finally {
    fixture.cleanup();
  }
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
