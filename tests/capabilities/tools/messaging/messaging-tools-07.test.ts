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

function ttsConfig(input: any): any {
  const preset = input.preset ?? (input.conversion
    ? {
      provider: input.conversion.provider,
      genie: input.conversion.genie,
      openaiApi: input.conversion.openaiApi,
      bailian: input.conversion.bailian,
      mimo: input.conversion.mimo
    }
    : { provider: "genie", genie: { enabled: true, baseURL: "http://127.0.0.1:8767", localFallbackEnabled: true, language: "jp", modelDir: "assets/tts/preset/test/model" } });
  return { ...input, activePresetName: "test", presets: { test: preset }, activePreset: preset };
}

function writeTtsConfigFile(configPath: string, input: any, presetName = "test", preset: any = { provider: "genie", genie: { enabled: true, baseURL: "http://127.0.0.1:8767", localFallbackEnabled: true, language: "jp", modelDir: "assets/tts/preset/test/model" } }) {
  fs.mkdirSync(path.join(path.dirname(configPath), "presets"), { recursive: true });
  const { translationEnabled, apiPresetName, prompt, conversion: _conversion, voice: _voice, translationPresets, translationPresetName = "default", ...rest } = input;
  fs.writeFileSync(configPath, JSON.stringify({
    ...rest,
    activePresetName: presetName,
    editPresetName: presetName,
    translationPresetName,
    translationPresets: translationPresets ?? { [translationPresetName]: { translationEnabled, apiPresetName, prompt } }
  }));
  fs.writeFileSync(path.join(path.dirname(configPath), "presets", `${presetName}.json`), JSON.stringify(preset));
}

test("tts plugin does not expose direct backend streamAudio entrypoints", async () => {
  const synthesize = createTtsTranslationSynthesizer({
    enabled: true,
    translationEnabled: true,
    api_preset: {
      baseURL: "https://example.invalid/v1",
      apiKey: "test-key",
      model: "flash"
    },
    prompt: "Translate to Japanese.\nText:"
  }, {
    baseSynthesizer: Object.assign(async () => {
      throw new Error("non-stream synthesizer should not be used");
    }, {
      async *streamAudioWithText() {
        yield { text: "should not stream", chunk: new Uint8Array([1]) };
      },
      async *streamAudio() {
        yield new Uint8Array([1]);
      }
    })
  });

  const runtimeSynthesizer = synthesize as unknown as { streamAudioWithText?: unknown; streamAudio?: unknown };
  assert.equal(runtimeSynthesizer.streamAudioWithText, undefined);
  assert.equal(runtimeSynthesizer.streamAudio, undefined);
});

test("tts stream never hard-cuts source text between punctuation boundaries", async () => {
  const dir = makeTempDir("tts-stream-no-hard-cut");
  const configPath = path.join(dir, "config.json");
  writeTtsConfigFile(configPath, {
    enabled: true,
    apiPresetName: "fixed-flash",
    prompt: "Translate to Japanese.\nText:"
  });
  const backendTexts: string[] = [];
  let fileIndex = 0;
  const plugin = createTtsPlugin({
    configPath,
    baseSynthesizer: async ({ text }) => {
      backendTexts.push(text);
      fileIndex += 1;
      const filePath = path.join(dir, `voice-${fileIndex}.wav`);
      fs.writeFileSync(filePath, `voice:${text}`);
      return { assetId: `generated/tts/voice-${fileIndex}.wav`, filePath };
    },
    llmRequestSender: async () => ({
      message: { role: "assistant", content: "老板から返信があるか確認してるんだよ！" }
    }),
    promptRenderer: () => ({
      renderText: (text: string) => text,
      getVariable: () => "",
      listVariables: () => []
    }),
    resolveApiPreset() {
      return {
        baseURL: "https://example.invalid/v1",
        apiKey: "test-key",
        model: "flash"
      };
    }
  });

  const events = [];
  for await (const event of plugin.voiceSynthesizer.stream!({
    text: "着手机看老板有没有回消息呢！",
    time: createCurrentTimeProvider("UTC"),
    source: "send_chat.voice"
  })) {
    events.push(event);
  }

  assert.deepEqual(backendTexts, ["老板から返信があるか確認してるんだよ！"]);
  assert.deepEqual(events.filter((event) => event.type === "audio_file").map((event: any) => [event.text, event.textchunk, path.basename(event.filePath)]), [
    ["着手机看老板有没有回消息呢！", "老板から返信があるか確認してるんだよ！", "voice-1.wav"]
  ]);
});

test("tts stream text collection preserves full conversation order", async () => {
  const text = await collectTtsStreamText(["第一句", "。", "第二句"]);
  assert.equal(text, "第一句。第二句");
});

test("tts stream splitter only flushes on configured sentence endings before hard limit", async () => {
  const parts: string[] = [];
  for await (const part of splitTtsStreamParts(["第一行，先不断\n第二行还不断．第三句"], {
    minFlushChars: 4,
    maxFlushChars: 40,
    softBoundaryChars: 4
  })) {
    parts.push(part);
  }

  assert.deepEqual(parts, ["第一行，先不断\n第二行还不断．", "第三句"]);
});

test("tts passes Genie language and plugin voice assets as per-request overrides", () => {
  const overrides = ttsGenieOverrides(ttsConfig({
    enabled: true,
    translationEnabled: true,
    apiPresetName: "fixed-flash",
    api_preset: {
      baseURL: "",
      model: "flash"
    },
    prompt: "Translate to Japanese.\nText:",
    preset: {
      provider: "genie",
      genie: {
        language: "jp",
        speed: 1.15,
        partSilenceSeconds: 0.35,
        splitText: false
      }
    }
  }));

  assert.deepEqual(overrides, {
    language: "jp",
    modelDir: "assets/tts/preset/test/model",
    referenceAudio: undefined,
    referenceText: undefined,
    speed: 1.15,
    partSilenceSeconds: 0.35,
    splitText: false
  });
});

test("tts passes configured voice language to Genie overrides", () => {
  const overrides = ttsGenieOverrides(ttsConfig({
    enabled: true,
    translationEnabled: false,
    api_preset: {
      baseURL: "",
      model: "flash"
    },
    prompt: "Read aloud.",
    preset: {
      provider: "genie",
      genie: {
        language: "zh"
      }
    }
  }));

  assert.equal(overrides.language, "zh");
  assert.equal(overrides.modelDir, "assets/tts/preset/test/model");
});

test("send_chat voice sends bracketed transcript text on feishu", async () => {
  const dir = makeTempDir("messaging-send-voice-feishu-transcript");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  seedUserInbound(store, "feishu:dm:oc_1", "feishu");
  const sent: AgentOutput[] = [];
  const logs: Array<{ status?: string; summary: string }> = [];
  let generatedPath = "";
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    sleep: async () => {},
    voiceSynthesizer: async ({ text }) => {
      generatedPath = path.join(dir, "voice.wav");
      fs.writeFileSync(generatedPath, `voice:${text}`);
      return { assetId: "generated/tts/voice.wav", filePath: generatedPath };
    },
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: `sent_${sent.length}` };
      }
    },
    appendMessageLog(input) {
      logs.push({ status: input.status, summary: input.summary });
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "oc_1", sessionId: "feishu:dm:oc_1" })
  });

  const result = await tools.execute({
    id: "call_send_voice_feishu_transcript",
    toolName: "Chat", input: { action: "send",  type: "voice", content: "晚点见" }
  });

  assert.equal(result.ok, true);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].content, { kind: "audio", assetId: "generated/tts/voice.wav", transcript: "晚点见" });
  assert.deepEqual(sent[1].content, { kind: "markdown", markdown: "晚点见" });
  assert.equal(fs.existsSync(generatedPath), false);
  assert.match(String(result.output), /Alice:\[语音\]晚点见/);
  assert.doesNotMatch(String(result.output), /Alice:\[晚点见\]/);
  const stored = store.listMessagesForConversation("feishu:dm:oc_1", 10).filter((message) => message.direction === "outbound");
  assert.equal(stored.length, 1);
  assert.deepEqual(stored.map((message) => message.contentText), ["[语音]晚点见"]);
  assert.deepEqual(logs, [{ status: "sent", summary: "[语音]晚点见" }]);
});

test("send_chat voice sends plain markdown transcript for feishu core before channel render", async () => {
  const dir = makeTempDir("messaging-send-voice-feishu-core-transcript");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  seedUserInbound(store, "feishu:dm:oc_1", "feishu");
  const sent: AgentOutput[] = [];
  let generatedPath = "";
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    sleep: async () => {},
    voiceSynthesizer: async ({ text }) => {
      generatedPath = path.join(dir, "voice.wav");
      fs.writeFileSync(generatedPath, `voice:${text}`);
      return { assetId: "generated/tts/voice.wav", filePath: generatedPath };
    },
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: `sent_${sent.length}` };
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "oc_1", sessionId: "feishu:dm:oc_1" })
  });

  const result = await tools.execute({
    id: "call_send_voice_feishu_core_transcript",
    toolName: "Chat", input: { action: "send",  type: "voice", content: "晚点见", alice: "core" }
  });

  assert.equal(result.ok, true);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].content, { kind: "audio", assetId: "generated/tts/voice.wav", transcript: "晚点见" });
  assert.deepEqual(sent[1].content, { kind: "markdown", markdown: "晚点见" });
  assert.equal(fs.existsSync(generatedPath), false);
  assert.match(String(result.output), /\[语音\]晚点见/);
  const stored = store.listMessagesForConversation("feishu:dm:oc_1", 10).filter((message) => message.direction === "outbound");
  assert.deepEqual(stored.map((message) => message.senderName), ["core"]);
});

test("send_chat voice retries feishu transcript without storing it", async () => {
  const dir = makeTempDir("messaging-send-voice-feishu-transcript-retry");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  seedUserInbound(store, "feishu:dm:oc_1", "feishu");
  const sent: AgentOutput[] = [];
  const logs: Array<{ status?: string; summary: string }> = [];
  const warnings: string[] = [];
  let generatedPath = "";
  let transcriptAttempts = 0;
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    sleep: async () => {},
    voiceSynthesizer: async ({ text }) => {
      generatedPath = path.join(dir, "voice.wav");
      fs.writeFileSync(generatedPath, `voice:${text}`);
      return { assetId: "generated/tts/voice.wav", filePath: generatedPath };
    },
    outputRouter: {
      async send(output) {
        sent.push(output);
        if (output.content.kind === "markdown") {
          transcriptAttempts += 1;
          if (transcriptAttempts === 1) throw new Error("temporary feishu failure");
        }
        return { messageId: `sent_${sent.length}` };
      }
    },
    appendMessageLog(input) {
      logs.push({ status: input.status, summary: input.summary });
    },
    appendLog(level, message) {
      if (level === "warn") warnings.push(message);
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "oc_1", sessionId: "feishu:dm:oc_1" })
  });

  const result = await tools.execute({
    id: "call_send_voice_feishu_transcript_retry",
    toolName: "Chat", input: { action: "send",  type: "voice", content: "晚点见" }
  });

  assert.equal(result.ok, true);
  assert.equal(transcriptAttempts, 2);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((output) => output.content.kind), ["audio", "markdown", "markdown"]);
  assert.equal(fs.existsSync(generatedPath), false);
  const stored = store.listMessagesForConversation("feishu:dm:oc_1", 10).filter((message) => message.direction === "outbound");
  assert.equal(stored.length, 1);
  assert.deepEqual(stored.map((message) => message.contentText), ["[语音]晚点见"]);
  assert.deepEqual(logs, [{ status: "sent", summary: "[语音]晚点见" }]);
  assert.deepEqual(warnings, []);
});

test("moss onnx voice synthesizer calls service and returns opus asset", async () => {
  const calls: string[] = [];
  const dir = makeTempDir("moss-onnx-voice");
  const outputDir = "generated/tts";
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${pathname}`);
    if (pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, ready: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (pathname === "/synthesize") {
      const body = JSON.parse(String(init?.body)) as { outputPath: string };
      fs.mkdirSync(path.dirname(body.outputPath), { recursive: true });
      fs.writeFileSync(body.outputPath, "wav");
      return new Response(JSON.stringify({ ok: true, audioPath: body.outputPath, sampleRate: 48000, durationSeconds: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const fakeSpawn = ((command: string, args: readonly string[]) => {
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
          const outputPath = String(args[args.length - 1]);
          fs.writeFileSync(outputPath, "opus");
        }
      }
      child.emit("exit", 0, null);
    });
    return child;
  }) as any;
  const synthesize = createMossOnnxVoiceSynthesizer({
    backend: "moss-onnx",
    mossBaseURL: "http://127.0.0.1:9876",
    mossReferenceAudio: "test.opus",
    mossOutputDir: outputDir,
    assetRoot: path.join(dir, "assets"),
    mossTimeoutMs: 1_000,
    mossIdleShutdownMs: 0,
    mossFfmpegCommand: "ffmpeg"
  }, { fetch: fakeFetch as typeof fetch, spawn: fakeSpawn });

  const result = await synthesize({ text: "晚点见", time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")) });

  assert.match(result.assetId, /^generated\/tts\/20260526_000000_000\.opus$/);
  assert.equal(fs.existsSync(result.filePath), true);
  assert.equal(fs.readFileSync(result.filePath, "utf8"), "opus");
  assert.deepEqual(calls, ["GET /health", "POST /synthesize"]);
  await fsp.unlink(result.filePath);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("moss onnx voice synthesizer does not spawn when explicit base url is unhealthy", async () => {
  let spawnCalls = 0;
  const fakeFetch = async (): Promise<Response> => new Response(JSON.stringify({ ok: false }), { status: 503 });
  const fakeSpawn = (() => {
    spawnCalls += 1;
    throw new Error("spawn should not be called");
  }) as any;
  const synthesize = createMossOnnxVoiceSynthesizer({
    backend: "moss-onnx",
    mossBaseURL: "http://127.0.0.1:9876",
    mossBaseURLExplicit: true,
    mossReferenceAudio: "test.opus",
    mossOutputDir: "generated/tts",
    assetRoot: path.join(makeTempDir("tts-asset-root"), "assets"),
    mossTimeoutMs: 1_000,
    mossIdleShutdownMs: 0,
    mossFfmpegCommand: "ffmpeg"
  }, { fetch: fakeFetch as typeof fetch, spawn: fakeSpawn });

  await assert.rejects(
    synthesize({ text: "晚点见", time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")) }),
    /custom MOSS_TTS_BASE_URL disables local auto-start/
  );
  assert.equal(spawnCalls, 0);
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
