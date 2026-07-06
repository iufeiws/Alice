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

test("fallback voice synthesizer streams from local when remote stream fails before audio", async () => {
  const calls: string[] = [];
  const remote = Object.assign(async () => {
    throw new Error("not used");
  }, {
    async *streamAudio() {
      calls.push("remote");
      throw new Error("remote stream offline");
    }
  }) as any;
  const local = Object.assign(async () => {
    throw new Error("not used");
  }, {
    async *streamAudio() {
      calls.push("local");
      yield new Uint8Array([9, 1]);
    }
  }) as any;
  const synthesize = createFallbackVoiceSynthesizer(remote, local);

  const chunks = [];
  for await (const chunk of synthesize.streamAudio!({ text: "また後で", time: createCurrentTimeProvider("UTC") })) {
    chunks.push(Array.from(chunk));
  }

  assert.deepEqual(calls, ["remote", "local"]);
  assert.deepEqual(chunks, [[9, 1]]);
});

test("genie tts owned service shuts down on idle timeout", async () => {
  const fixture = makeTtsAssetFixture("tts-genie-idle");
  const calls: string[] = [];
  let healthCalls = 0;
  let idleCallback: (() => void) | undefined;
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${pathname}`);
    if (pathname === "/health") {
      healthCalls += 1;
      return new Response(JSON.stringify({ ok: healthCalls > 1 }), { status: healthCalls > 1 ? 200 : 503 });
    }
    if (pathname === "/shutdown") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const fakeSpawn = (() => {
    const child = new events.EventEmitter() as any;
    child.stdout = new events.EventEmitter();
    child.stderr = new events.EventEmitter();
    child.exitCode = null;
    child.kill = () => {
      child.emit("exit", null, "SIGTERM");
      return true;
    };
    return child;
  }) as any;
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieDataDir: fixture.modelDir,
    genieModelDir: fixture.modelDir,
    genieReferenceAudio: fixture.referenceAudio,
    genieReferenceText: "selfie/references/selfie-prompt.txt",
    genieOutputDir: "generated/tts",
    assetRoot: fixture.assetRoot,
    genieTimeoutMs: 1_000,
    genieIdleShutdownMs: 10
  }, {
    fetch: fakeFetch as typeof fetch,
    spawn: fakeSpawn,
    setTimeout: ((callback: () => void) => {
      idleCallback = callback;
      return { unref() {} };
    }) as any,
    clearTimeout: (() => {}) as any
  });

  try {
    await synthesize.prepare?.();
    idleCallback?.();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, ["GET /health", "GET /health", "POST /shutdown"]);
  } finally {
    fixture.cleanup();
  }
});

test("genie tts local service receives reference text content instead of text path", async () => {
  const fixture = makeTtsAssetFixture("tts-genie-reference-text-content");
  const referenceTextPath = path.join(fixture.root, "reference.txt");
  fs.writeFileSync(referenceTextPath, "明示的な参照テキスト\n");
  const calls: string[] = [];
  let healthCalls = 0;
  let spawnArgs: readonly string[] = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${pathname}`);
    if (pathname === "/health") {
      healthCalls += 1;
      return new Response(JSON.stringify({ ok: healthCalls > 1 }), { status: healthCalls > 1 ? 200 : 503 });
    }
    if (pathname === "/shutdown") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const fakeSpawn = ((_command: string, args: readonly string[]) => {
    spawnArgs = args;
    const child = new events.EventEmitter() as any;
    child.stdout = new events.EventEmitter();
    child.stderr = new events.EventEmitter();
    child.exitCode = null;
    child.kill = () => true;
    return child;
  }) as any;
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieDataDir: fixture.modelDir,
    genieModelDir: fixture.modelDir,
    genieReferenceAudio: fixture.referenceAudio,
    genieReferenceText: referenceTextPath,
    genieOutputDir: "generated/tts",
    assetRoot: fixture.assetRoot,
    genieTimeoutMs: 1_000,
    genieIdleShutdownMs: 0
  }, {
    fetch: fakeFetch as typeof fetch,
    spawn: fakeSpawn
  });

  try {
    await synthesize.prepare?.();
    const referenceTextIndex = spawnArgs.indexOf("--reference-text");
    assert.notEqual(referenceTextIndex, -1);
    assert.ok(spawnArgs[referenceTextIndex + 1]);
    assert.deepEqual(calls, ["GET /health", "GET /health"]);
  } finally {
    await synthesize.shutdown?.();
    fixture.cleanup();
  }
});

test("configured voice synthesizer falls back to moss when explicit genie service is unhealthy", async () => {
  let spawnCalls = 0;
  const calls: string[] = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(String(url));
    calls.push(`${parsed.port} ${init?.method ?? "GET"} ${parsed.pathname}`);
    if (parsed.port === "8767") return new Response(JSON.stringify({ ok: false }), { status: 503 });
    if (parsed.pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (parsed.pathname === "/synthesize") {
      const body = JSON.parse(String(init?.body)) as { outputPath: string };
      fs.mkdirSync(path.dirname(body.outputPath), { recursive: true });
      fs.writeFileSync(body.outputPath, "wav");
      return new Response(JSON.stringify({ ok: true, audioPath: body.outputPath }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const spawn = ((command: string, args: readonly string[]) => {
    if (command !== "ffmpeg") spawnCalls += 1;
    return fakeFfmpegSpawn()(command, args);
  }) as any;
  const synthesize = createConfiguredVoiceSynthesizer({
    backend: "genie-tts",
    genieBaseURL: "http://127.0.0.1:8767",
    genieBaseURLExplicit: true,
    mossBaseURL: "http://127.0.0.1:9876",
    mossReferenceAudio: "test.opus",
    mossOutputDir: "generated/tts",
    assetRoot: path.join(makeTempDir("tts-asset-root"), "assets"),
    mossIdleShutdownMs: 0,
    mossFfmpegCommand: "ffmpeg"
  }, { fetch: fakeFetch as typeof fetch, spawn });

  const time = createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z"));
  const result = await synthesize({ text: "晚点见", time });
  const secondResult = await synthesize({ text: "再试一次", time });

  assert.equal(typeof result.assetId, "string");
  assert.equal(typeof secondResult.assetId, "string");
  assert.equal(spawnCalls, 0);
  assert.deepEqual(calls, [
    "8767 GET /health",
    "9876 GET /health",
    "9876 POST /synthesize",
    "9876 GET /health",
    "9876 POST /synthesize"
  ]);
  await fsp.unlink(result.filePath);
  await fsp.unlink(secondResult.filePath);
});

test("send_chat voice keeps newline and escaped newline text in one audio message", async () => {
  const dir = makeTempDir("messaging-send-voice-newline");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  seedUserInbound(store, "wechat:dm:wx-user", "wechat");
  const sent: AgentOutput[] = [];
  const logs: Array<{ status?: string; summary: string }> = [];
  const synthesizedTexts: string[] = [];
  const tools = createMessagingTools({
    store,
    sleep: async () => {},
    wechatVoiceFallbackToText: false,
    voiceSynthesizer: async ({ text }) => {
      synthesizedTexts.push(text);
      const filePath = path.join(dir, "voice.wav");
      fs.writeFileSync(filePath, text);
      return { assetId: "generated/tts/voice.wav", filePath };
    },
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: `voice_${sent.length}` };
      }
    },
    appendMessageLog(input) {
      logs.push({ status: input.status, summary: input.summary });
    },
    getDefaultTarget: () => ({ plugin: "wechat", userId: "wx-user", sessionId: "wechat:dm:wx-user" })
  });

  const result = await tools.execute({
    id: "call_send_voice_newline",
    toolName: "Chat", input: { action: "send",  type: "voice", content: "第一句\n第二句\\n第三句" }
  });

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(synthesizedTexts, ["第一句\n第二句\n第三句"]);
  assert.deepEqual(sent.map((output) => output.content.kind === "audio" ? output.content.transcript : ""), ["第一句\n第二句\n第三句"]);
  assert.deepEqual(logs, [{ status: "sent", summary: "[语音]第一句\n第二句\n第三句" }]);
});

async function sendWechatVoiceWithTtsFailure(name: string) {
  const store = createAliceStore(path.join(makeTempDir(name), "alice.sqlite"));
  seedUserInbound(store, "wechat:dm:wx-user", "wechat");
  const logs: Array<{ status?: string; error?: string; summary: string }> = [];
  let sendCalls = 0;
  const tools = createMessagingTools({
    store,
    sleep: async () => {},
    wechatVoiceFallbackToText: false,
    voiceSynthesizer: async () => {
      throw new Error("tts unavailable");
    },
    outputRouter: {
      async send() {
        sendCalls += 1;
        return { messageId: "should-not-send" };
      }
    },
    getDefaultTarget: () => ({ plugin: "wechat", userId: "wx-user", sessionId: "wechat:dm:wx-user" }),
    appendMessageLog(input) {
      logs.push({ status: input.status, error: input.error, summary: input.summary });
    }
  });

  const result = await tools.execute({
    id: "call_send_voice_failed",
    toolName: "Chat", input: { action: "send",  type: "voice", content: "不要发文字" }
  });

  return { logs, result, sendCalls, store };
}

test("send_chat voice returns tts failure", async () => {
  const { result } = await sendWechatVoiceWithTtsFailure("messaging-send-voice-tts-failed");

  assert.equal(result.ok, false);
  assert.equal(result.ok, false);
});

test("send_chat voice tts failure does not send fallback text", async () => {
  const { sendCalls } = await sendWechatVoiceWithTtsFailure("messaging-send-voice-tts-failed-no-send");

  assert.equal(sendCalls, 0);
});

test("send_chat voice tts failure logs the failed synthesis", async () => {
  const { logs } = await sendWechatVoiceWithTtsFailure("messaging-send-voice-tts-failed-log");

  assert.equal(logs[0].status, "tts_failed");
  assert.equal(logs[0].summary, "不要发文字");
});

test("send_chat voice tts failure does not store outbound text", async () => {
  const { store } = await sendWechatVoiceWithTtsFailure("messaging-send-voice-tts-failed-store");

  assert.equal(store.listMessagesForConversation("wechat:dm:wx-user", 10).filter((message) => message.direction === "outbound").length, 0);
});

async function sendFailingWechatVoice(name: string) {
  const dir = makeTempDir(name);
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  seedUserInbound(store, "wechat:dm:wx-user", "wechat");
  const logs: Array<{ status?: string; error?: string; summary: string }> = [];
  let attempts = 0;
  let generatedPath = "";
  const trainingDir = path.join(dir, "tts-training", "voice-massage");
  const tools = createMessagingTools({
    store,
    sleep: async () => {},
    voiceMessageTtsTrainingOutputDir: trainingDir,
    wechatVoiceFallbackToText: false,
    voiceSynthesizer: async () => {
      generatedPath = path.join(dir, "voice.wav");
      fs.writeFileSync(generatedPath, "voice");
      return { assetId: "generated/tts/voice.wav", filePath: generatedPath };
    },
    outputRouter: {
      async send() {
        attempts += 1;
        throw new Error("wechat audio failed");
      }
    },
    getDefaultTarget: () => ({ plugin: "wechat", userId: "wx-user", sessionId: "wechat:dm:wx-user" }),
    appendMessageLog(input) {
      logs.push({ status: input.status, error: input.error, summary: input.summary });
    }
  });

  const result = await tools.execute({
    id: "call_send_voice_send_failed",
    toolName: "Chat", input: { action: "send",  type: "voice", content: "语音内容" }
  });
  await new Promise((resolve) => setImmediate(resolve));

  return { attempts, generatedPath, logs, result, store, trainingDir };
}

test("send_chat voice returns the send failure", async () => {
  const { result } = await sendFailingWechatVoice("messaging-send-voice-send-failed-result");

  assert.equal(result.ok, false);
  assert.equal(result.ok, false);
});

test("send_chat voice does not retry failed audio sends", async () => {
  const { attempts, logs } = await sendFailingWechatVoice("messaging-send-voice-send-failed-retry");

  assert.equal(attempts, 1);
  assert.equal(logs.some((entry) => entry.status === "retry_failed"), false);
});

test("send_chat voice removes generated files after send failure", async () => {
  const { generatedPath } = await sendFailingWechatVoice("messaging-send-voice-send-failed-cleanup");

  assert.equal(fs.existsSync(generatedPath), false);
});

test("send_chat voice records failed training sample", async () => {
  const { trainingDir } = await sendFailingWechatVoice("messaging-send-voice-send-failed-training");
  const trainingFiles = fs.readdirSync(trainingDir).sort();
  const audioFileName = trainingFiles.find((fileName) => fileName.endsWith(".wav"));

  assert.ok(audioFileName);
  const audioFilePath = path.join(trainingDir, audioFileName);
  assert.equal(fs.readFileSync(audioFilePath, "utf8"), "voice");
  assert.equal(JSON.parse(fs.readFileSync(`${audioFilePath}.json`, "utf8")).status, "failed");
});

test("send_chat voice logs failed outbound audio", async () => {
  const { logs } = await sendFailingWechatVoice("messaging-send-voice-send-failed-log");

  assert.equal(logs.filter((entry) => entry.status === "send_failed").length, 1);
});

test("send_chat voice stores failed outbound audio", async () => {
  const { store } = await sendFailingWechatVoice("messaging-send-voice-send-failed-store");
  const stored = store.listMessagesForConversation("wechat:dm:wx-user", 10).filter((message) => message.direction === "outbound");

  assert.equal(stored.length, 1);
  assert.equal(stored[0].contentType, "audio");
  assert.equal(stored[0].status, "send_failed");
});

test("send_chat normalizes prefixed feishu chat ids before sending", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-send-feishu-id"), "alice.sqlite"));
  seedUserInbound(store, "feishu:dm:oc_018825f465c5e6a00e32739f76f47271", "feishu");
  const sent: AgentOutput[] = [];
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    sleep: async () => {},
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: "sent_1" };
      }
    },
    getDefaultTarget: () => ({
      plugin: "feishu",
      channelId: "feishu:dm:oc_018825f465c5e6a00e32739f76f47271",
      sessionId: "feishu:dm:oc_018825f465c5e6a00e32739f76f47271"
    })
  });

  const result = await tools.execute({
    id: "call_send",
    toolName: "Chat", input: { action: "send",  content: "test" }
  });

  assert.equal(result.ok, true);
  assert.equal(sent[0].target.channelId, "oc_018825f465c5e6a00e32739f76f47271");
  assert.equal(sent[0].target.sessionId, "feishu:dm:oc_018825f465c5e6a00e32739f76f47271");
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
