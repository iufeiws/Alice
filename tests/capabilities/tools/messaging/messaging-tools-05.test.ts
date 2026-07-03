import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";
import { formatToolResultForLLM } from "../../../../src/contexts/agent-profile/src/application/llm-text-renderer.js";
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

test("tts plugin config reads Genie conversion settings from provider config", () => {
  const dir = makeTempDir("tts-config-conversion");
  const configPath = path.join(dir, "config.json");
  const providersDir = path.join(dir, "providers");
  fs.mkdirSync(providersDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    conversion: { provider: "genie" },
    translationEnabled: false
  }));
  fs.writeFileSync(path.join(providersDir, "genie.json"), JSON.stringify({
    enabled: true,
    baseURL: "192.168.0.103"
  }));

  const config = readTtsPluginConfig(configPath);

  assert.equal(config.conversion?.provider, "genie");
  assert.equal(config.conversion?.genie?.enabled, true);
  assert.equal(config.conversion?.genie?.baseURL, "http://192.168.0.103:8767");
  assert.equal(config.conversion?.genie?.localFallbackEnabled, true);
  assert.equal(config.remote?.baseURL, "http://192.168.0.103:8767");
});

test("tts plugin config requires prompt when translation is enabled", () => {
  const dir = makeTempDir("tts-config-missing-prompt");
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    translationEnabled: true
  }));

  assert.throws(() => readTtsPluginConfig(configPath), /tts translation prompt is required/);
});

test("tts plugin config can disable local Genie fallback", () => {
  const dir = makeTempDir("tts-config-local-fallback");
  const configPath = path.join(dir, "config.json");
  const providersDir = path.join(dir, "providers");
  fs.mkdirSync(providersDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    conversion: { provider: "genie" },
    translationEnabled: false
  }));
  fs.writeFileSync(path.join(providersDir, "genie.json"), JSON.stringify({
    enabled: true,
    baseURL: "192.168.0.103",
    localFallbackEnabled: false
  }));

  const config = readTtsPluginConfig(configPath);

  assert.equal(config.conversion?.genie?.enabled, true);
  assert.equal(config.conversion?.genie?.baseURL, "http://192.168.0.103:8767");
  assert.equal(config.conversion?.genie?.localFallbackEnabled, false);
  assert.equal(config.remote?.localFallbackEnabled, false);
});

test("tts plugin config reads Bailian conversion settings", () => {
  const dir = makeTempDir("tts-config-bailian");
  const configPath = path.join(dir, "config.json");
  const providersDir = path.join(dir, "providers");
  fs.mkdirSync(providersDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    conversion: { provider: "bailian" },
    translationEnabled: false
  }));
  fs.writeFileSync(path.join(providersDir, "bailian.json"), JSON.stringify({
    service: "qwen",
    endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    apiKey: "inline-key",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    workspaceId: "workspace-1",
    userAgent: "Alice-Test",
    model: "qwen3-tts-vc-2026-01-22",
    voice: "custom-voice",
    languageType: "Chinese",
    mode: "server_commit",
    responseFormat: "pcm",
    sampleRate: 24000,
    channels: 1,
    timeoutMs: 5000,
    extraParams: { volume: 50 }
  }));

  const config = readTtsPluginConfig(configPath);

  assert.equal(config.conversion?.provider, "bailian");
  assert.equal(config.conversion?.bailian?.service, "qwen");
  assert.equal(config.conversion?.bailian?.endpoint, "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
  assert.equal(config.conversion?.bailian?.apiKey, "inline-key");
  assert.equal(config.conversion?.bailian?.apiKeyEnv, "DASHSCOPE_API_KEY");
  assert.equal(config.conversion?.bailian?.workspaceId, "workspace-1");
  assert.equal(config.conversion?.bailian?.userAgent, "Alice-Test");
  assert.equal(config.conversion?.bailian?.model, "qwen3-tts-vc-2026-01-22");
  assert.equal(config.conversion?.bailian?.voice, "custom-voice");
  assert.equal(config.conversion?.bailian?.languageType, "Chinese");
  assert.equal(config.conversion?.bailian?.mode, "server_commit");
  assert.equal(config.conversion?.bailian?.sampleRate, 24000);
  assert.deepEqual(config.conversion?.bailian?.extraParams, { volume: 50 });
});

test("tts plugin config reads MiMo conversion settings from provider config", () => {
  const dir = makeTempDir("tts-config-mimo");
  const configPath = path.join(dir, "config.json");
  const providersDir = path.join(dir, "providers");
  fs.mkdirSync(providersDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    conversion: { provider: "mimo" },
    translationEnabled: false
  }));
  fs.writeFileSync(path.join(providersDir, "mimo.json"), JSON.stringify({
    mode: "voiceclone",
    apiKeyEnv: "MIMO_API_KEY",
    model: "wrong-model-is-ignored",
    voiceCloneAudioDataUrl: "data:audio/wav;base64,AAAA",
    extraParams: { seed: 1 }
  }));

  const config = readTtsPluginConfig(configPath);

  assert.equal(config.conversion?.provider, "mimo");
  assert.equal(config.conversion?.mimo?.mode, "voiceclone");
  assert.equal(Object.hasOwn(config.conversion?.mimo ?? {}, "model"), false);
  assert.equal(config.conversion?.mimo?.voiceCloneAudioDataUrl, "data:audio/wav;base64,AAAA");
  assert.deepEqual(config.conversion?.mimo?.extraParams, { seed: 1 });
});

test("tts plugin switch is read from plugin config at synthesis time", async () => {
  const dir = makeTempDir("tts-switch");
  const configPath = path.join(dir, "config.json");
  const synthesizedTexts: string[] = [];
  const writeConfig = (enabled: boolean) => fs.writeFileSync(configPath, JSON.stringify({
    enabled,
    apiPresetName: "fixed-flash",
    prompt: "Translate to Japanese.\nText:"
  }));
  writeConfig(false);
  const plugin = createTtsPlugin({
    configPath,
    baseSynthesizer: async ({ text }) => {
      synthesizedTexts.push(text);
      const filePath = path.join(dir, `${synthesizedTexts.length}.wav`);
      fs.writeFileSync(filePath, text);
      return { assetId: `generated/tts/${synthesizedTexts.length}.wav`, filePath };
    },
    llm: {
      async chat() {
        return { message: { role: "assistant", content: "日本語" } };
      }
    },
    promptRenderer: () => ({
      renderText: (text: string) => text,
      getVariable: () => "",
      listVariables: () => []
    }),
    resolveApiPreset(name) {
      assert.equal(name, "fixed-flash");
      return {
        name,
        baseURL: "https://example.invalid/v1",
        apiKey: "test-key",
        model: "flash"
      };
    }
  });

  await plugin.voiceSynthesizer({ text: "原文", time: createCurrentTimeProvider("UTC") });
  writeConfig(true);
  await plugin.voiceSynthesizer({ text: "原文", time: createCurrentTimeProvider("UTC") });

  assert.deepEqual(synthesizedTexts, ["原文", "日本語"]);
});

test("openai-api tts sends non-stream pcm speech request with full text chunk", async () => {
  const requests: Array<{ url: string; body: any; authorization: string | null }> = [];
  const usageEvents: any[] = [];
  const outputDir = path.join(makeTempDir("openai-api-tts-output"), "assets", "generated", "tts");
  const first = new Uint8Array(32_000 * 2);
  const second = new Uint8Array(32_000 * 2);
  second.fill(1);
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      authorization: init?.headers instanceof Headers ? init.headers.get("authorization") : (init?.headers as Record<string, string>)?.authorization ?? null
    });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      }
    }), { status: 200, headers: { "content-type": "application/octet-stream" } });
  };
  const synthesize = createOpenAiApiTtsVoiceSynthesizer({
    enabled: true,
    translationEnabled: false,
    prompt: "Read aloud.",
    conversion: {
      provider: "openai-api",
      openaiApi: {
        apiPresetName: "speech",
        model: "higgs-audio-v3-tts",
        voice: "default",
        sampleRate: 16_000,
        channels: 1
      }
    }
  }, {
    outputDir,
    fetch: fakeFetch as typeof fetch,
    recordTokenUsageEvent: (event) => usageEvents.push(event),
    resolveApiPreset(name) {
      assert.equal(name, "speech");
      return {
        name,
        baseURL: "https://api.boson.ai/v1",
        apiKey: "test-key",
        model: "preset-model"
      };
    }
  });

  const chunks = [];
  for await (const chunk of synthesize.streamAudioWithText!({
    text: "第一句。第二句。",
    time: createCurrentTimeProvider("UTC")
  })) {
    chunks.push([chunk.text, chunk.chunk.byteLength, chunk.sampleRateHz, chunk.channels]);
  }

  assert.equal(requests[0].url, "https://api.boson.ai/v1/audio/speech");
  assert.equal(requests[0].authorization, "Bearer test-key");
  assert.deepEqual(requests[0].body, {
    input: "第一句。第二句。",
    model: "higgs-audio-v3-tts",
    voice: "default",
    response_format: "pcm"
  });
  assert.deepEqual(chunks, [
    ["第一句。第二句。", 128_000, 16_000, 1]
  ]);
  assert.equal(usageEvents.length, 1);
  assert.equal(usageEvents[0].agentId, "tts");
  assert.equal(usageEvents[0].model, "tts:openai-api:higgs-audio-v3-tts");
  assert.deepEqual(usageEvents[0].result.usage, { inputTokens: 8, outputTokens: 0, totalTokens: 8 });

  const result = await synthesize({
    text: "保存音频。",
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-09T02:10:51.609Z"))
  });
  try {
    assert.equal(result.assetId, "generated/tts/2026-06-09T02_10_51.609-openai-api.wav");
    assert.equal(result.filePath, path.join(outputDir, "2026-06-09T02_10_51.609-openai-api.wav"));
    assert.equal(fs.existsSync(result.filePath), true);
    assert.equal(path.resolve(outputDir, path.basename(result.assetId)), path.resolve(result.filePath));
    const wav = fs.readFileSync(result.filePath);
    assert.equal(new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint32(24, true), 16_000);
    assert.equal(requests[1].body.response_format, "pcm");
    assert.equal("stream" in requests[1].body, false);
    assert.equal(usageEvents.length, 2);
    assert.deepEqual(usageEvents[1].result.usage, { inputTokens: 5, outputTokens: 0, totalTokens: 5 });
  } finally {
    fs.rmSync(result.filePath, { force: true });
  }
});

test("tts router applies selected provider text filters", async () => {
  const texts: string[] = [];
  const baseSynthesizer = (async (input) => {
    texts.push(input.text);
    return {
      assetId: "generated/tts/filter-test.wav",
      filePath: path.join(makeTempDir("tts-filter-route"), "filter-test.wav")
    };
  }) as VoiceSynthesizer;

  await synthesizeTtsRouted({
    text: "…第一句。\n…第二句。",
    time: createCurrentTimeProvider("UTC")
  }, {
    enabled: true,
    translationEnabled: false,
    prompt: "Read aloud.",
    conversion: {
      provider: "genie",
      genie: {
        textFilters: [
          { pattern: "^…+", flags: "gm", replacement: "" }
        ]
      }
    }
  }, {
    baseSynthesizer
  });

  assert.deepEqual(texts, ["第一句。\n第二句。"]);
});

test("bailian tts uses non-realtime HTTP SSE audio data and writes pcm wav", async () => {
  const outputDir = path.join(makeTempDir("bailian-tts-output"), "assets", "generated", "tts");
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  const usageEvents: any[] = [];
  const sse = [
    `data: ${JSON.stringify({ output: { audio: { data: Buffer.from(new Uint8Array([1, 2])).toString("base64") } } })}`,
    "",
    `data: ${JSON.stringify({ output: { audio: { data: Buffer.from(new Uint8Array([3, 4])).toString("base64") }, finish_reason: "stop" } })}`,
    ""
  ].join("\n");
  const synthesize = createBailianTtsVoiceSynthesizer({
    enabled: true,
    translationEnabled: false,
    prompt: "Read aloud.",
    conversion: {
      provider: "bailian",
      bailian: {
        service: "qwen",
        endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        apiKey: "inline-key",
        workspaceId: "workspace-1",
        userAgent: "Alice-Test",
        model: "qwen3-tts-vc-2026-01-22",
        voice: "custom-voice",
        languageType: "Chinese",
        mode: "server_commit",
        responseFormat: "pcm",
        sampleRate: 24000,
        channels: 1,
        extraParams: { volume: 50 }
      }
    }
  }, {
    outputDir,
    env: { DASHSCOPE_API_KEY: "env-key" },
    recordTokenUsageEvent: (event) => usageEvents.push(event),
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body))
      });
      return new Response(sse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    }
  });

  const chunks = [];
  for await (const chunk of synthesize.streamAudioWithText!({
    text: "第一句。",
    time: createCurrentTimeProvider("UTC")
  })) {
    chunks.push([chunk.text, Array.from(chunk.chunk), chunk.sampleRateHz, chunk.channels]);
  }

  assert.equal(requests[0].url, "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
  assert.equal(requests[0].headers.get("Authorization"), "Bearer inline-key");
  assert.equal(requests[0].headers.get("X-DashScope-WorkSpace"), "workspace-1");
  assert.equal(requests[0].headers.get("user-agent"), "Alice-Test");
  assert.equal(requests[0].headers.get("X-DashScope-SSE"), "enable");
  assert.deepEqual(requests[0].body, {
    model: "qwen3-tts-vc-2026-01-22",
    input: {
      volume: 50,
      text: "第一句。",
      voice: "custom-voice",
      language_type: "Chinese"
    }
  });
  assert.deepEqual(chunks, [
    ["第一句。", [1, 2, 3, 4], 24000, 1]
  ]);
  assert.equal(usageEvents.length, 1);
  assert.equal(usageEvents[0].agentId, "tts");
  assert.equal(usageEvents[0].model, "tts:bailian-qwen:qwen3-tts-vc-2026-01-22");
  assert.deepEqual(usageEvents[0].result.usage, { inputTokens: 4, outputTokens: 0, totalTokens: 4 });

  const result = await synthesize({
    text: "保存音频。",
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-10T02:10:51.609Z"))
  });
  try {
    assert.equal(result.assetId, "generated/tts/2026-06-10T02_10_51.609-bailian.wav");
    const wav = fs.readFileSync(result.filePath);
    assert.equal(new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint32(24, true), 24000);
    assert.equal(usageEvents.length, 2);
    assert.deepEqual(usageEvents[1].result.usage, { inputTokens: 5, outputTokens: 0, totalTokens: 5 });
  } finally {
    fs.rmSync(result.filePath, { force: true });
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
