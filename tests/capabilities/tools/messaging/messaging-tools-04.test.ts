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

async function sendVoiceMessage(name: string) {
  const dir = makeTempDir(name);
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  seedUserInbound(store, "custom:dm:user-1", "custom");
  const sent: AgentOutput[] = [];
  let generatedPath = "";
  const trainingDir = path.join(dir, "tts-training", "voice-massage");
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    sleep: async () => {},
    voiceMessageTtsTrainingOutputDir: trainingDir,
    voiceSynthesizer: async ({ text }) => {
      generatedPath = path.join(dir, "voice.wav");
      fs.writeFileSync(generatedPath, `voice:${text}`);
      return { assetId: "generated/tts/voice.wav", filePath: generatedPath };
    },
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: "voice_1" };
      }
    },
    getDefaultTarget: () => ({ plugin: "custom", userId: "user-1", sessionId: "custom:dm:user-1" })
  });

  const result = await tools.execute({
    id: "call_send_voice",
    toolName: "Chat", input: { action: "send",  type: "voice", content: "晚点见" }
  });

  return { generatedPath, result, sent, store, trainingDir };
}

test("send_chat voice synthesizes text and sends audio", async () => {
  const { result, sent } = await sendVoiceMessage("messaging-send-voice-audio");

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].content, { kind: "audio", assetId: "generated/tts/voice.wav", transcript: "晚点见" });
  assert.match(String(result.output), /Alice:\[语音\]晚点见/);
});

test("send_chat voice stores sent outbound audio", async () => {
  const { store } = await sendVoiceMessage("messaging-send-voice-store");
  const stored = store.listMessagesForConversation("custom:dm:user-1", 10).filter((message) => message.direction === "outbound");

  assert.equal(stored.length, 1);
  assert.equal(stored[0].contentType, "audio");
  assert.equal(stored[0].externalMessageId, "voice_1");
});

test("send_chat voice removes the generated audio file after send", async () => {
  const { generatedPath } = await sendVoiceMessage("messaging-send-voice-cleanup");

  assert.equal(fs.existsSync(generatedPath), false);
});

test("send_chat voice writes a sent training sample", async () => {
  const { trainingDir } = await sendVoiceMessage("messaging-send-voice-training");

  const trainingFiles = fs.readdirSync(trainingDir).sort();
  assert.equal(trainingFiles.length, 2);
  const audioFileName = trainingFiles.find((fileName) => fileName.endsWith(".wav"));
  assert.ok(audioFileName);
  const audioFilePath = path.join(trainingDir, audioFileName);
  assert.equal(fs.readFileSync(audioFilePath, "utf8"), "voice:晚点见");
  const metadata = JSON.parse(fs.readFileSync(`${audioFilePath}.json`, "utf8"));
  assert.equal(metadata.text, "晚点见");
  assert.equal(metadata.status, "sent");
  assert.equal(metadata.plugin, "custom");
  assert.equal(metadata.sessionId, "custom:dm:user-1");
  assert.equal(metadata.assetId, "generated/tts/voice.wav");
});

async function sendWechatVoiceTextFallback(name: string) {
  const store = createAliceStore(path.join(makeTempDir(name), "alice.sqlite"));
  seedUserInbound(store, "wechat:dm:wx-user", "wechat");
  const sent: AgentOutput[] = [];
  let ttsCalls = 0;
  const tools = createMessagingTools({
    store,
    sleep: async () => {},
    wechatVoiceFallbackToText: true,
    voiceSynthesizer: async () => {
      ttsCalls += 1;
      throw new Error("tts should not be called");
    },
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: "text_1" };
      }
    },
    getDefaultTarget: () => ({ plugin: "wechat", userId: "wx-user", sessionId: "wechat:dm:wx-user" })
  });

  const result = await tools.execute({
    id: "call_send_wechat_voice_text",
    toolName: "Chat", input: { action: "send",  type: "voice", content: "晚点见" }
  });

  return { result, sent, store, ttsCalls };
}

test("send_chat voice falls back to text for wechat", async () => {
  const { result, sent } = await sendWechatVoiceTextFallback("messaging-send-wechat-voice-text");

  assert.equal(result.ok, true);
  assert.deepEqual(sent.map((output) => output.content), [{ kind: "text", text: "晚点见" }]);
  assert.match(String(result.output), /Alice:晚点见/);
});

test("send_chat voice fallback skips tts for wechat", async () => {
  const { ttsCalls } = await sendWechatVoiceTextFallback("messaging-send-wechat-voice-text-no-tts");

  assert.equal(ttsCalls, 0);
});

test("send_chat voice fallback stores text for wechat", async () => {
  const { store } = await sendWechatVoiceTextFallback("messaging-send-wechat-voice-text-store");
  const stored = store.listMessagesForConversation("wechat:dm:wx-user", 10).filter((message) => message.direction === "outbound");

  assert.equal(stored.length, 1);
  assert.equal(stored[0].contentType, "text");
  assert.equal(stored[0].contentText, "晚点见");
  assert.equal(stored[0].externalMessageId, "text_1");
});

test("send_chat voice can keep audio synthesis for wechat when compatibility fallback is disabled", async () => {
  const dir = makeTempDir("messaging-send-wechat-voice-audio");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  seedUserInbound(store, "wechat:dm:wx-user", "wechat");
  const sent: AgentOutput[] = [];
  let ttsCalls = 0;
  const tools = createMessagingTools({
    store,
    sleep: async () => {},
    wechatVoiceFallbackToText: false,
    voiceSynthesizer: async ({ text }) => {
      ttsCalls += 1;
      const filePath = path.join(dir, "voice.wav");
      fs.writeFileSync(filePath, text);
      return { assetId: "generated/tts/voice.wav", filePath };
    },
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: "voice_1" };
      }
    },
    getDefaultTarget: () => ({ plugin: "wechat", userId: "wx-user", sessionId: "wechat:dm:wx-user" })
  });

  const result = await tools.execute({
    id: "call_send_wechat_voice_audio",
    toolName: "Chat", input: { action: "send",  type: "voice", content: "晚点见" }
  });

  assert.equal(result.ok, true);
  assert.equal(ttsCalls, 1);
  assert.deepEqual(sent[0].content, { kind: "audio", assetId: "generated/tts/voice.wav", transcript: "晚点见" });
});

test("tts plugin translates before tts while preserving original send_chat voice transcript", async () => {
  const dir = makeTempDir("messaging-tts");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  seedUserInbound(store, "wechat:dm:wx-user", "wechat");
  const sent: AgentOutput[] = [];
  const synthesizedTexts: string[] = [];
  const llmMessages: Array<{ role: string; content: string }> = [];
  const llmAgents: string[] = [];
  let generatedPath = "";
  const voiceSynthesizer = createTtsTranslationSynthesizer(ttsConfig({
    enabled: true,
    translationEnabled: true,
    apiPresetName: "fixed-flash",
    prompt: "Translate to Japanese.\nText:"
  }), {
    baseSynthesizer: async ({ text }) => {
      synthesizedTexts.push(text);
      generatedPath = path.join(dir, "voice.wav");
      fs.writeFileSync(generatedPath, `voice:${text}`);
      return { assetId: "generated/tts/voice.wav", filePath: generatedPath };
    },
    llmRequestSender: async (input) => {
      llmAgents.push(input.agentId);
      llmMessages.push(...input.messages.map((message) => ({ role: message.role, content: message.content })));
      return { message: { role: "assistant", content: "また後で会いましょう" } };
    },
    resolveApiPreset() {
      return {
        baseURL: "https://example.invalid/v1",
        apiKey: "test-key",
        model: "flash",
        temperature: 0,
        timeoutMs: 1000,
        extraParams: {}
      };
    },
    promptRenderer: () => ({
      renderText: (text: string) => text,
      getVariable: () => "",
      listVariables: () => []
    }),
    llm: {
      async chat(input) {
        llmMessages.push(...input.messages.map((message) => ({ role: message.role, content: message.content })));
        return { message: { role: "assistant", content: "direct chat should not be used" } };
      }
    }
  });
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    sleep: async () => {},
    wechatVoiceFallbackToText: false,
    voiceSynthesizer,
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: "voice_1" };
      }
    },
    getDefaultTarget: () => ({ plugin: "wechat", userId: "wx-user", sessionId: "wechat:dm:wx-user" })
  });

  const result = await tools.execute({
    id: "call_send_voice_japanese",
    toolName: "Chat", input: { action: "send",  type: "voice", content: "晚点见" }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(llmAgents, ["tts"]);
  assert.equal(llmMessages.some((message) => message.role === "user" && message.content === "晚点见"), true);
  assert.deepEqual(synthesizedTexts, ["また後で会いましょう"]);
  assert.deepEqual(sent[0].content, { kind: "audio", assetId: "generated/tts/voice.wav", transcript: "晚点见" });
  assert.match(String(result.output), /Alice:\[语音\]晚点见/);
  assert.doesNotMatch(String(result.output), /また後で会いましょう/);
});

test("tts plugin can skip translation and send original text to jp tts", async () => {
  const dir = makeTempDir("messaging-tts-no-translate");
  const synthesizedTexts: string[] = [];
  let llmCalls = 0;
  const voiceSynthesizer = createTtsTranslationSynthesizer(ttsConfig({
    enabled: true,
    translationEnabled: false,
    prompt: "Translate to Japanese.\nText:"
  }), {
    baseSynthesizer: async ({ text }) => {
      synthesizedTexts.push(text);
      const filePath = path.join(dir, "voice.wav");
      fs.writeFileSync(filePath, `voice:${text}`);
      return { assetId: "generated/tts/voice.wav", filePath };
    },
    llmRequestSender: async () => {
      llmCalls += 1;
      return { message: { role: "assistant", content: "日本語" } };
    }
  });

  await voiceSynthesizer({ text: "原文", time: createCurrentTimeProvider("UTC") });

  assert.equal(llmCalls, 0);
  assert.deepEqual(synthesizedTexts, ["原文"]);
});

test("tts translation skips symbol-only text without calling llm", async () => {
  let llmCalls = 0;
  const translated = await resolveTtsText(" ... ", ttsConfig({
    enabled: true,
    translationEnabled: true,
    prompt: "Translate to Japanese.\nText:"
  }), {
    baseSynthesizer: async () => {
      throw new Error("base synthesizer should not be used");
    },
    llmRequestSender: async () => {
      llmCalls += 1;
      return { message: { role: "assistant", content: "日本語" } };
    }
  });

  assert.equal(translated, " ... ");
  assert.equal(llmCalls, 0);
});

test("tts router returns a silence file for symbol-only text before backend request", async () => {
  let backendCalls = 0;
  const result = await synthesizeTtsRouted({
    text: "...",
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z"))
  }, ttsConfig({
    enabled: true,
    translationEnabled: false,
    prompt: "Translate to Japanese.\nText:"
  }), {
    baseSynthesizer: async () => {
      backendCalls += 1;
      throw new Error("base synthesizer should not be used");
    }
  });

  try {
    assert.equal(backendCalls, 0);
    assert.equal(result.assetId.endsWith("-silence.wav"), true);
    assert.equal(fs.existsSync(result.filePath), true);
    assert.equal(fs.statSync(result.filePath).size, 44 + 3 * 200 * 64);
  } finally {
    await fsp.rm(result.filePath, { force: true });
  }
});

test("tts plugin disabled mode still routes symbol-only text to silence before backend request", async () => {
  const dir = makeTempDir("tts-plugin-disabled-symbol-only");
  const configPath = path.join(dir, "config.json");
  writeTtsConfigFile(configPath, {
    enabled: false,
    translationEnabled: false,
    prompt: "Read aloud."
  });
  let backendCalls = 0;
  const plugin = createTtsPlugin({
    configPath,
    baseSynthesizer: async () => {
      backendCalls += 1;
      throw new Error("base synthesizer should not be used");
    }
  });

  const result = await plugin.voiceSynthesizer({
    text: "  ...  ",
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z"))
  });

  try {
    assert.equal(backendCalls, 0);
    assert.equal(result.assetId.endsWith("-silence.wav"), true);
    assert.equal(fs.existsSync(result.filePath), true);
  } finally {
    await fsp.rm(result.filePath, { force: true });
  }
});

test("tts router rate limits same provider to three requests per second", async () => {
  const requestStarts: number[] = [];
  let stampIndex = 0;
  const files: string[] = [];
  const providerId = `rate-limit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const config = ttsConfig({
    enabled: true,
    translationEnabled: false,
    conversion: {
      provider: "openai-api" as const,
      openaiApi: {
        baseURL: "https://example.invalid/v1",
        apiKey: "test-key",
        model: providerId,
        voice: "unit"
      }
    },
    prompt: "Read aloud."
  });
  const deps = {
    baseSynthesizer: async () => {
      throw new Error("base synthesizer should not be used");
    },
    fetch: async () => {
      requestStarts.push(Date.now());
      return new Response(new Uint8Array([1, 2]));
    }
  };
  const time = createCurrentTimeProvider("UTC", () => new Date(Date.UTC(2026, 4, 26, 0, 0, stampIndex++)));

  try {
    const results = await Promise.all([0, 1, 2, 3].map((index) => synthesizeTtsRouted({
      text: `text ${index}`,
      time
    }, config, deps)));
    files.push(...results.map((result) => result.filePath));
    assert.equal(requestStarts.length, 4);
    assert.equal(requestStarts[3]! - requestStarts[0]! >= 900, true);
  } finally {
    await Promise.all(files.map((filePath) => fsp.rm(filePath, { force: true })));
  }
});

test("tts plugin config reads switch, api preset, and prompt from plugin folder config", () => {
  const dir = makeTempDir("tts-config");
  const configPath = path.join(dir, "config.json");
  writeTtsConfigFile(configPath, {
    enabled: true,
    translationPresetName: "default",
    translationPresets: {
      default: {
        translationEnabled: true,
        apiPresetName: "fixed-flash",
        prompt: "Translate to Japanese.\nText:"
      }
    },
  }, "jp", { provider: "genie", genie: { enabled: true, baseURL: "http://127.0.0.1:8767", language: "jp", speed: 1.15, splitText: false, modelDir: "assets/tts/preset/jp/model" } });

  const config = readTtsPluginConfig(configPath);

  assert.equal(config.enabled, true);
  assert.equal(config.translationEnabled, true);
  assert.equal(config.apiPresetName, "fixed-flash");
  assert.equal(config.prompt, "Translate to Japanese.\nText:");
  assert.equal(config.activePresetName, "jp");
  assert.equal(config.activePreset?.genie?.splitText, false);
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
