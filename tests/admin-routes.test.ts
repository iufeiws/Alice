import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createApiRequestHandler } from "../apps/api/src/admin-routes.js";
import {
  createMarkdownMemoryStore,
  createMemoryInductionPromptStore,
  runMemoryInductionForMessages
} from "../core/agent/src/memory.js";
import type { LLMChatInput, LLMClient } from "../core/llm/src/index.js";
import { createDiaryStore } from "../packages/storage/src/diary-store.js";
import type { StoredConversationMessage } from "../packages/storage/src/sqlite-store.js";

const fs = await import("node:fs");
const path = await import("node:path");
const childProcess = await import("node:child_process");

test("llm api preset save stores extra params as part of the preset", async () => {
  const root = makeTempDir("admin-llm-preset-extra");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const context = baseContext(root, memoryStore, promptStore);
  const handler = createApiRequestHandler(context);

  const response = createResponse();
  await handler(createRequest("PUT", "/admin/api/config/llm-presets", {
    name: "Core Custom",
    baseURL: "https://core.example.test/v1",
    model: "core-custom",
    temperature: "0.4",
    timeoutMs: "90000",
    stream: true,
    extraParams: JSON.stringify({ top_p: 0.7, stream_options: { include_usage: true } }),
    followupExtraParams: JSON.stringify({ top_p: 0.2 })
  }), response);
  const body = JSON.parse(response.body);
  const saved = JSON.parse(fs.readFileSync(path.join(root, "config", "llm-api-presets.json"), "utf8"));

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(context.config.llm.timeoutMs, 60_000);
  assert.deepEqual(saved.presets[0], {
    name: "Core Custom",
    baseURL: "https://core.example.test/v1",
    model: "core-custom",
    temperature: 0.4,
    timeoutMs: 90_000,
    stream: true,
    extraParams: { top_p: 0.7, stream_options: { include_usage: true } },
    followupExtraParams: { top_p: 0.2 }
  });
});

test("llm api preset save accepts long timeout values", async () => {
  const root = makeTempDir("admin-llm-preset-timeout");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const handler = createApiRequestHandler(baseContext(root, memoryStore, promptStore));

  const response = createResponse();
  await handler(createRequest("PUT", "/admin/api/config/llm-presets", {
    name: "Long Timeout",
    baseURL: "https://core.example.test/v1",
    model: "core-custom",
    temperature: "0.4",
    timeoutMs: "600000",
    stream: true,
    extraParams: "{}",
    followupExtraParams: "{}"
  }), response);
  const saved = JSON.parse(fs.readFileSync(path.join(root, "config", "llm-api-presets.json"), "utf8"));

  assert.equal(response.statusCode, 200);
  assert.equal(saved.presets[0].timeoutMs, 600_000);
});

test("admin plugin list exposes japanese voice config card state", async () => {
  const root = makeTempDir("admin-plugin-list");
  const configPath = path.join(root, "plugins", "japanese-voice", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    apiPresetName: "voice",
    prompt: "Translate:"
  })}\n`);
  writePreset(root, "voice");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { japaneseVoice: { configPath } }
  };
  const handler = createApiRequestHandler(context);

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins", {}), response);
  const body = JSON.parse(response.body);
  const japaneseVoice = body.plugins.find((plugin: { id: string }) => plugin.id === "japanese-voice");

  assert.equal(response.statusCode, 200);
  assert.equal(japaneseVoice.status, "enabled");
  assert.equal(japaneseVoice.health, "healthy");
  assert.equal(japaneseVoice.configurable, true);
  assert.equal(japaneseVoice.switchable, true);
});

test("admin plugin list exposes ASR config card state", async () => {
  const root = makeTempDir("admin-asr-plugin-list");
  const configPath = path.join(root, "plugins", "asr", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    defaultProvider: "openai_compatible",
    providers: {
      openaiCompatible: {
        apiPresetName: "asr",
      }
    }
  })}\n`);
  writePreset(root, "asr");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { asr: { configPath } }
  };
  const handler = createApiRequestHandler(context);

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins", {}), response);
  const body = JSON.parse(response.body);
  const asr = body.plugins.find((plugin: { id: string }) => plugin.id === "asr");

  assert.equal(response.statusCode, 200);
  assert.equal(asr.status, "enabled");
  assert.equal(asr.health, "healthy");
  assert.equal(asr.kind, "asr");
  assert.equal(asr.configurable, true);
  assert.equal(asr.switchable, true);
});

test("admin plugin config patch writes japanese voice config with preset reference only", async () => {
  const root = makeTempDir("admin-plugin-config");
  const configPath = path.join(root, "plugins", "japanese-voice", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: false,
    apiPresetName: "old",
    prompt: "Old prompt"
  })}\n`);
  writePreset(root, "voice");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { japaneseVoice: { configPath } }
  };
  const handler = createApiRequestHandler(context);

  const response = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/japanese-voice/config", {
    enabled: true,
    translationEnabled: false,
    prompt: "New prompt",
    apiPresetName: "voice",
    voice: {
      modelDir: "assets/plugin/japanese-voice/model",
      referenceText: "これは参照テキストです。",
      speed: 1.2,
      partSilenceSeconds: 0.45,
      splitText: false
    }
  }), response);
  const body = JSON.parse(response.body);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.configValue.apiPresetName, "voice");
  assert.equal(body.configValue.api_preset, undefined);
  assert.equal(saved.enabled, true);
  assert.equal(saved.translationEnabled, false);
  assert.equal(saved.prompt, "New prompt");
  assert.equal(saved.apiPresetName, "voice");
  assert.equal(saved.api_preset, undefined);
  assert.equal(saved.voice.modelDir, "assets/plugin/japanese-voice/model");
  assert.equal(saved.voice.referenceText, "これは参照テキストです。");
  assert.equal(saved.voice.speed, 1.2);
  assert.equal(saved.voice.partSilenceSeconds, 0.45);
  assert.equal(saved.voice.splitText, false);
});

test("admin plugin test can run japanese voice tts with translation disabled", async () => {
  const root = makeTempDir("admin-plugin-test-no-translate");
  const configPath = path.join(root, "plugins", "japanese-voice", "config.json");
  const voicePath = path.join("assets", "generated", "tts", `voice-${path.basename(root)}.opus`);
  let capturedText = "";
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(voicePath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled: true, translationEnabled: false, prompt: "Translate:" })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  let llmCalls = 0;
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    config: {
      ...baseContext(root, memoryStore, promptStore).config,
      tts: { mossOutputDir: path.join("assets", "generated", "tts") }
    },
    pluginConfigs: {
      japaneseVoice: {
        configPath,
        testVoiceSynthesizer: async ({ text }: { text: string }) => {
          capturedText = text;
          fs.writeFileSync(voicePath, `voice:${text}`);
          return { assetId: "generated/tts/voice.opus", filePath: voicePath };
        }
      }
    },
    llmRequestSender: async () => {
      llmCalls += 1;
      return { message: { role: "assistant", content: "また後で" } };
    }
  };
  const handler = createApiRequestHandler(context);

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/japanese-voice/test", { text: "晚点见" }), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.result.output, "晚点见");
  assert.equal(body.result.timing.translationMs, 0);
  assert.equal(capturedText, "晚点见");
  assert.equal(llmCalls, 0);
  fs.rmSync(voicePath, { force: true });
});

test("admin plugin config patch writes ASR config with preset references only", async () => {
  const root = makeTempDir("admin-asr-plugin-config");
  const configPath = path.join(root, "plugins", "asr", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: false,
    defaultProvider: "openai_compatible",
    providers: {}
  })}\n`);
  writePreset(root, "asr-openai");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { asr: { configPath } }
  };
  const handler = createApiRequestHandler(context);

  const response = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/asr/config", {
    enabled: true,
    defaultProvider: "openai_compatible",
    providers: {
      openaiCompatible: {
        apiPresetName: "asr-openai",
        model: "whisper-1",
        responseFormat: "json"
      },
      tencent: {
        secretId: "secret-id",
        secretKey: "secret-key",
        endpoint: "https://asr.tencentcloudapi.com",
        region: "ap-guangzhou",
        engineModelType: "16k_zh",
        pollIntervalMs: 500,
        timeoutMs: 120000
      }
    }
  }), response);
  const body = JSON.parse(response.body);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.configValue.providers.openaiCompatible.apiPresetName, "asr-openai");
  assert.equal(body.configValue.providers.tencent.secretId, "secret-id");
  assert.equal(body.configValue.providers.tencent.secretKey, "secret-key");
  assert.equal(saved.providers.openaiCompatible.apiKey, undefined);
  assert.equal(saved.providers.tencent.secretKey, "secret-key");
  assert.equal(saved.providers.openaiCompatible.model, undefined);
  assert.equal(saved.providers.tencent.engineModelType, "16k_zh");
});

test("admin ASR plugin config schema groups general and provider settings", async () => {
  const root = makeTempDir("admin-asr-plugin-schema-groups");
  const configPath = path.join(root, "plugins", "asr", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: false,
    defaultProvider: "openai_compatible",
    providers: {}
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const handler = createApiRequestHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { asr: { configPath } }
  });

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/asr/config", {}), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.configSchema.groups.map((group: { key: string }) => group.key), ["general", "openai_compatible", "tencent"]);
  assert.equal(body.configSchema.fields.find((field: { key: string }) => field.key === "enabled").group, "general");
  assert.equal(body.configSchema.fields.find((field: { key: string }) => field.key === "providers.openaiCompatible.model"), undefined);
  assert.equal(body.configSchema.fields.find((field: { key: string }) => field.key === "providers.openaiCompatible.apiPresetName").group, "openai_compatible");
  assert.equal(body.configSchema.fields.find((field: { key: string }) => field.key === "providers.tencent.engineModelType").group, "tencent");
});

test("admin plugin enable and disable update japanese voice config", async () => {
  const root = makeTempDir("admin-plugin-switch");
  const configPath = path.join(root, "plugins", "japanese-voice", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: false,
    apiPresetName: "voice",
    prompt: "Translate:"
  })}\n`);
  writePreset(root, "voice");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { japaneseVoice: { configPath } }
  };
  const handler = createApiRequestHandler(context);

  const enableResponse = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/japanese-voice/enable", {}), enableResponse);
  assert.equal(enableResponse.statusCode, 200);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).enabled, true);

  const disableResponse = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/japanese-voice/disable", {}), disableResponse);
  assert.equal(disableResponse.statusCode, 200);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).enabled, false);
});

test("admin plugin enable and disable update ASR config", async () => {
  const root = makeTempDir("admin-asr-plugin-switch");
  const configPath = path.join(root, "plugins", "asr", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: false,
    defaultProvider: "openai_compatible",
    providers: {}
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { asr: { configPath } }
  };
  const handler = createApiRequestHandler(context);

  const enableResponse = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/asr/enable", {}), enableResponse);
  assert.equal(enableResponse.statusCode, 200);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).enabled, true);

  const disableResponse = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/asr/disable", {}), disableResponse);
  assert.equal(disableResponse.statusCode, 200);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).enabled, false);
});

test("admin plugin model folder upload flattens files under plugin model root", async () => {
  const root = makeTempDir("admin-plugin-asset");
  const configPath = path.join(root, "plugins", "japanese-voice", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled: false, apiPresetName: "voice", prompt: "Translate:" })}\n`);
  writePreset(root, "voice");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { japaneseVoice: { configPath } }
  };
  const handler = createApiRequestHandler(context);

  const response = createResponse();
  const fileName = `model-${path.basename(root)}.onnx`;
  await handler(createRawRequest("POST", "/admin/api/plugins/japanese-voice/assets/model", Buffer.from("model"), {
    "x-file-name": encodeURIComponent(fileName),
    "x-relative-dir": encodeURIComponent("uploaded-folder/nested")
  }), response);
  const body = JSON.parse(response.body);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const expectedAssetPath = `assets/plugin/japanese-voice/model/${fileName}`;

  assert.equal(response.statusCode, 200);
  assert.equal(body.assetPath, expectedAssetPath);
  assert.equal(saved.voice.modelDir, "assets/plugin/japanese-voice/model");
  assert.equal(fs.readFileSync(path.join("assets", "plugin", "japanese-voice", "model", fileName), "utf8"), "model");
  assert.equal(fs.existsSync(path.join("assets", "plugin", "japanese-voice", "model", "uploaded-folder", "nested", fileName)), false);
  fs.rmSync(path.join("assets", "plugin", "japanese-voice", "model", fileName), { force: true });
});

test("admin plugin ASR test audio upload stores plugin asset path", async () => {
  const root = makeTempDir("admin-asr-plugin-asset");
  const configPath = path.join(root, "plugins", "asr", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: false,
    defaultProvider: "openai_compatible",
    providers: {}
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { asr: { configPath } }
  };
  const handler = createApiRequestHandler(context);

  const response = createResponse();
  const fileName = `asr-${path.basename(root)}.wav`;
  await handler(createRawRequest("POST", "/admin/api/plugins/asr/assets/test-audio", Buffer.from("audio"), {
    "x-file-name": encodeURIComponent(fileName)
  }), response);
  const body = JSON.parse(response.body);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const expectedAssetPath = `assets/plugin/asr/test-audio/${fileName}`;

  assert.equal(response.statusCode, 200);
  assert.equal(body.assetPath, expectedAssetPath);
  assert.equal(saved.testAudioPath, expectedAssetPath);
  assert.equal(fs.readFileSync(path.join("assets", "plugin", "asr", "test-audio", fileName), "utf8"), "audio");
  fs.rmSync(path.join("assets", "plugin", "asr", "test-audio", fileName), { force: true });
});

test("admin plugin test runs japanese voice translation and tts with timing", async () => {
  const root = makeTempDir("admin-plugin-test");
  const configPath = path.join(root, "plugins", "japanese-voice", "config.json");
  const ttsOutputDir = path.join("assets", "generated", "tts");
  const voiceFileName = `voice-${path.basename(root)}.opus`;
  const voicePath = path.join(ttsOutputDir, voiceFileName);
  let capturedGenie: unknown;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(ttsOutputDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled: true, apiPresetName: "voice", prompt: "Translate:" })}\n`);
  writePreset(root, "voice");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const senderAgents: string[] = [];
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    config: {
      ...baseContext(root, memoryStore, promptStore).config,
      tts: { mossOutputDir: ttsOutputDir }
    },
    pluginConfigs: {
      japaneseVoice: {
        configPath,
        testVoiceSynthesizer: async ({ text, genie }: { text: string; genie?: unknown }) => {
          capturedGenie = genie;
          fs.writeFileSync(voicePath, `voice:${text}`);
          return { assetId: "generated/tts/voice.opus", filePath: voicePath };
        }
      }
    },
    llmRequestSender: async (input: any) => {
      senderAgents.push(input.agentId);
      return { message: { role: "assistant", content: "また後で" } };
    }
  };
  const handler = createApiRequestHandler(context);

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/japanese-voice/test", { text: "晚点见" }), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.result.input, "晚点见");
  assert.equal(body.result.output, "また後で");
  assert.equal(body.result.voice.audioUrl, `/admin/assets/tts/${voiceFileName}`);
  assert.equal(typeof body.result.timing.translationMs, "number");
  assert.equal(typeof body.result.timing.ttsMs, "number");
  assert.equal(typeof body.result.timing.totalMs, "number");
  assert.deepEqual(senderAgents, ["japanese-voice"]);
  assert.deepEqual(capturedGenie, { language: "jp", modelDir: undefined, referenceAudio: undefined, referenceText: undefined, splitText: false });
  fs.rmSync(voicePath, { force: true });
});

test("admin plugin test runs ASR transcriber with uploaded audio", async () => {
  const root = makeTempDir("admin-asr-plugin-test");
  const configPath = path.join(root, "plugins", "asr", "config.json");
  const audioPath = path.join("assets", "plugin", "asr", `test-${path.basename(root)}.wav`);
  let capturedAudioFile = "";
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(audioPath), { recursive: true });
  fs.writeFileSync(audioPath, "audio");
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    defaultProvider: "openai_compatible",
    testAudioPath: audioPath,
    providers: {
      openaiCompatible: {
        apiPresetName: "asr"
      }
    }
  })}\n`);
  writePreset(root, "asr");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: {
      asr: {
        configPath,
        testTranscriber: async (input: { audioFile: string }) => {
          capturedAudioFile = input.audioFile;
          return {
            text: "识别文本",
            provider: "openai_compatible",
            model: "whisper-1",
            durationMs: 12
          };
        }
      }
    }
  };
  const handler = createApiRequestHandler(context);

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/asr/test", {}), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(capturedAudioFile, audioPath);
  assert.equal(body.result.output, "识别文本");
  assert.equal(body.result.provider, "openai_compatible");
  assert.equal(body.result.model, "whisper-1");
  assert.equal(typeof body.result.timing.totalMs, "number");
  fs.rmSync(audioPath, { force: true });
});

test("memory run-day reuses Memorize preset, api settings, prompts, and target order", async () => {
  const root = makeTempDir("admin-memory-run-day");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "llm-api-presets.json"), `${JSON.stringify({
    presets: [{
      name: "Memorize Custom",
      baseURL: "https://memorize.example.test/v1",
      apiKey: "memorize-key",
      model: "memorize-model",
      temperature: 0.65,
      timeoutMs: 45_000,
      stream: false,
      extraParams: { top_p: 0.9 },
      followupExtraParams: {}
    }]
  })}\n`);
  fs.writeFileSync(path.join(root, "config", "prompt-api-profile.json"), `${JSON.stringify({
    memorizePresetName: "Memorize Custom"
  })}\n`);

  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  promptStore.save({
    commonLayers: [
      { id: "common", title: "Common", role: "system", enabled: true, order: 10, content: "custom memorize common prompt" }
    ],
    persistentLayers: [
      { id: "persistent", title: "Persistent", role: "user", enabled: true, order: 10, content: "persistent-only prompt" }
    ],
    userPreferencesLayers: [
      { id: "user", title: "User", role: "user", enabled: true, order: 10, content: "user-preferences-only prompt" }
    ],
    yesterdaySummaryLayers: [
      { id: "diary", title: "Diary", role: "user", enabled: true, order: 10, content: "diary-only prompt" }
    ]
  });

  const seen: LLMChatInput[] = [];
  let capturedPreset: any;
  const handler = createApiRequestHandler({
    ...baseContext(root, memoryStore, promptStore),
    store: {
      listMessagesByCreatedAtRange(startAt: string | undefined, endAt: string) {
        assert.equal(startAt, "2026-05-23T22:00:00.000");
        assert.equal(endAt, "2026-05-24T06:00:00.000");
        return [message("2026-05-24T01:00:00.000Z", "hello from selected day")];
      },
      listMessagesChronological() {
        return [];
      }
    },
    async runMemoryInductionForMessages(messages: StoredConversationMessage[], windowStartAt: string, windowEndAt: string, apiPreset: any) {
      capturedPreset = apiPreset;
      return runMemoryInductionForMessages({
        memoryStore,
        promptStore,
        messages,
        windowStartAt,
        windowEndAt,
        llm: editToolClient(seen, [
          addPatch("memory\n"),
          addPatch("user\n"),
          addPatch("diary\n")
        ]),
        config: {
          enabled: true,
          baseURL: apiPreset.baseURL,
          apiKey: apiPreset.apiKey,
          model: apiPreset.model,
          temperature: apiPreset.temperature,
          timeoutMs: apiPreset.timeoutMs,
          stream: apiPreset.stream,
          extraParams: apiPreset.extraParams,
          followupExtraParams: apiPreset.followupExtraParams
        },
        nowIso: () => "2026-05-24T06:00:00.000Z",
        timezone: "Asia/Shanghai",
        log() {}
      });
    }
  });

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/run-day", { date: "2026-05-24" }), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(capturedPreset.name, "Memorize Custom");
  assert.deepEqual(body.result.results.map((entry: any) => entry.target), ["persistent", "userPreferences", "yesterdaySummary"]);
  const targetRequests = [seen[0]];
  assert.deepEqual(targetRequests.map((input) => input.model), ["memorize-model"]);
  assert.deepEqual(targetRequests.map((input) => input.temperature), [0.65]);
  assert.deepEqual(targetRequests.map((input) => input.extraParams), [{ top_p: 0.9 }]);
  const promptText = targetRequests[0].messages.map((entry) => entry.content).join("\n");
  assert.match(promptText, /custom memorize common prompt/);
  assert.doesNotMatch(promptText, /persistent-only prompt/);
  assert.doesNotMatch(promptText, /user-preferences-only prompt/);
  assert.doesNotMatch(promptText, /diary-only prompt/);
});

test("memory run-target still processes all memory files in one workspace run", async () => {
  const root = makeTempDir("admin-memory-run-target");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  let capturedTarget = "";
  let capturedMessages: StoredConversationMessage[] = [];
  const handler = createApiRequestHandler({
    ...baseContext(root, memoryStore, promptStore),
    store: {
      listMessagesByCreatedAtRange(startAt: string | undefined, endAt: string) {
        assert.equal(startAt, "2026-05-23T22:00:00.000");
        assert.equal(endAt, "2026-05-24T06:00:00.000");
        return [message("2026-05-24T01:00:00.000Z", "hello from selected day")];
      },
      listMessagesChronological() {
        return [];
      }
    },
    async runMemoryInductionForMessages(messages: StoredConversationMessage[], windowStartAt: string, windowEndAt: string, apiPreset: any, target: string) {
      capturedTarget = target;
      capturedMessages = messages;
      return {
        ok: true,
        startedAt: "2026-05-24T06:00:00.000Z",
        windowStartAt,
        windowEndAt,
        messageCount: messages.length,
        results: [
          { target: "persistent", ok: true, edited: true, toolCalls: [] },
          { target: "userPreferences", ok: true, edited: true, toolCalls: [] },
          { target: "yesterdaySummary", ok: true, edited: true, toolCalls: [] }
        ]
      };
    }
  });

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/run-target", { date: "2026-05-24", target: "userPreferences" }), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(capturedTarget, "userPreferences");
  assert.equal(capturedMessages.length, 1);
  assert.deepEqual(body.result.results.map((entry: any) => entry.target), ["persistent", "userPreferences", "yesterdaySummary"]);
});

test("memory admin rejects concurrent run requests", async () => {
  const root = makeTempDir("admin-memory-run-concurrent");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  let activeRuns = 0;
  let maxActiveRuns = 0;
  const calls: Array<{ target?: string }> = [];
  let resolveFirstRun: () => void = () => {};
  let resolveFirstStarted: () => void = () => {};
  const firstRunRelease = new Promise<void>((resolve) => {
    resolveFirstRun = resolve;
  });
  const firstRunStarted = new Promise<void>((resolve) => {
    resolveFirstStarted = resolve;
  });
  const handler = createApiRequestHandler({
    ...baseContext(root, memoryStore, promptStore),
    store: {
      listMessagesByCreatedAtRange() {
        return [message("2026-05-24T01:00:00.000Z", "hello from selected day")];
      },
      listMessagesChronological() {
        return [];
      }
    },
    async runMemoryInductionForMessages(messages: StoredConversationMessage[], windowStartAt: string, windowEndAt: string, apiPreset: any, target?: string) {
      activeRuns += 1;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      calls.push({ target });
      if (calls.length === 1) {
        resolveFirstStarted();
        await firstRunRelease;
      }
      activeRuns -= 1;
      return {
        ok: true,
        startedAt: "2026-05-24T06:00:00.000Z",
        windowStartAt,
        windowEndAt,
        messageCount: messages.length,
        results: [{ target: target ?? "persistent", ok: true, edited: true, toolCalls: [] }]
      };
    }
  });

  const firstResponse = createResponse();
  const first = handler(createRequest("POST", "/admin/api/memory/run-day", { date: "2026-05-24", runId: "first" }), firstResponse);
  await firstRunStarted;

  const secondResponse = createResponse();
  const second = handler(createRequest("POST", "/admin/api/memory/run-target", { date: "2026-05-24", target: "userPreferences", runId: "second" }), secondResponse);
  await second;

  assert.equal(calls.length, 1);
  assert.equal(maxActiveRuns, 1);
  assert.equal(secondResponse.statusCode, 409);
  assert.equal(JSON.parse(secondResponse.body).error, "memory_run_already_running");

  resolveFirstRun();
  await first;

  assert.equal(calls.length, 1);
  assert.equal(maxActiveRuns, 1);
  assert.equal(firstResponse.statusCode, 200);
});

test("memory admin manual run requires sleeping state by default", async () => {
  const root = makeTempDir("admin-memory-run-sleep-only");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  let calls = 0;
  const handler = createApiRequestHandler({
    ...baseContext(root, memoryStore, promptStore),
    agentState: { getSnapshot: () => ({ state: "idle" }), setState() {} },
    store: {
      listMessagesByCreatedAtRange() {
        return [message("2026-05-24T01:00:00.000Z", "hello from selected day")];
      },
      listMessagesChronological() {
        return [];
      }
    },
    async runMemoryInductionForMessages() {
      calls += 1;
      return { ok: true, startedAt: "", windowEndAt: "", messageCount: 0, results: [] };
    }
  });

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/run-day", { date: "2026-05-24", runId: "idle" }), response);

  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).error, "memory_manual_run_requires_sleeping");
  assert.equal(calls, 0);
});

test("memory clear-session clears the console memorize session", async () => {
  const root = makeTempDir("admin-memory-clear-session");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  let cleared = false;
  const handler = createApiRequestHandler({
    ...baseContext(root, memoryStore, promptStore),
    clearMemoryInductionSession() {
      cleared = true;
    }
  });

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/clear-session", {}), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(cleared, true);
});

test("memory windows do not reseed sleep boundaries from persisted sleep system messages", async () => {
  const root = makeTempDir("admin-memory-no-persisted-sleep-boundary-reseed");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const recorded: Array<{ occurredAt: string; source: string; now: string }> = [];
  const boundaries = [
    { occurredAt: "2026-05-31T03:46:02.806", source: "inferred_gap" }
  ];
  const handler = createApiRequestHandler({
    ...baseContext(root, memoryStore, promptStore),
    store: {
      listMessagesByCreatedAtRange() {
        return [];
      },
      listMessagesChronological() {
        return [
          message("2026-05-31T07:07:15.653", "我也终于能睡了"),
          { ...message("2026-05-31T07:12:33.529", "-少女已入眠-"), direction: "outbound", senderRole: "system" }
        ];
      }
    },
    diaryStore: {
      listSleepBoundaries: () => boundaries,
      recordSleepBoundary(input: { occurredAt: string; source: string; now: string }) {
        recorded.push(input);
        boundaries.push({ occurredAt: input.occurredAt, source: input.source });
      }
    }
  });

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/memory", {}), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(recorded, []);
  assert.deepEqual(body.sleepDays, [{
    date: "2026-05-31",
    endAt: "2026-05-31T03:46:02.806",
    endAtUtc: "2026-05-30T19:46:02.806Z",
    source: "inferred_gap"
  }]);
});

test("memory git undo and redo are unavailable for SQL-backed memory", async () => {
  const root = makeTempDir("admin-memory-git-unavailable");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const handler = createApiRequestHandler(baseContext(root, memoryStore, promptStore));
  memoryStore.writeTarget("persistent", "persistent v1\n");

  let response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/undo-last", {}), response);
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "memory_git_unavailable");
  assert.equal(memoryStore.read().persistent, "persistent v1\n");

  response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/redo-last", {}), response);
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "memory_git_unavailable");
});

test("memory delete-latest-sql removes the latest entry for each SQL memory table", async () => {
  const root = makeTempDir("admin-memory-delete-latest-sql");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const handler = createApiRequestHandler({
    ...baseContext(root, memoryStore, promptStore)
  });

  memoryStore.writeTarget("persistent", "older memory\n", { now: "2026-05-30T08:00:00.000Z" });
  memoryStore.writeTarget("persistent", "latest memory\n", { now: "2026-06-01T08:00:00.000Z" });
  memoryStore.writeTarget("userPreferences", "older pref\n", { now: "2026-05-30T08:00:00.000Z" });
  memoryStore.writeTarget("userPreferences", "latest pref\n", { now: "2026-06-01T08:00:00.000Z" });
  memoryStore.writeTarget("yesterdaySummary", "older diary\n", { localDate: "2026-05-31", now: "2026-05-31T08:00:00.000Z" });
  memoryStore.writeTarget("yesterdaySummary", "latest diary\n", { localDate: "2026-06-01", now: "2026-06-01T08:00:00.000Z" });

  let response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/delete-latest-sql", { target: "persistent" }), response);
  let body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.entry.target, "persistent");
  assert.equal(memoryStore.read().persistent, "older memory\n");

  response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/delete-latest-sql", { target: "userPreferences" }), response);
  body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.entry.target, "userPreferences");
  assert.equal(memoryStore.read().userPreferences, "older pref\n");

  response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/delete-latest-sql", {}), response);
  body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.entry.target, "yesterdaySummary");
  assert.equal(body.entry.localDate, "2026-06-01");
  assert.equal(memoryStore.read().yesterdaySummary, "older diary\n");
});

test("memory delete-latest-sql reports when no diary entry exists", async () => {
  const root = makeTempDir("admin-memory-delete-latest-sql-empty");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "config", "memorize-prompts.json"));
  const diaryStore = createDiaryStore(path.join(root, "diary", "diary.sqlite"));
  const handler = createApiRequestHandler({
    ...baseContext(root, memoryStore, promptStore),
    diaryStore
  });

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/delete-latest-sql", {}), response);

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "no_memory_sql_record_to_delete");
});

function git(cwd: string, ...args: string[]): string {
  const result = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function baseContext(root: string, memoryStore: ReturnType<typeof createMarkdownMemoryStore>, promptStore: ReturnType<typeof createMemoryInductionPromptStore>) {
  return {
    config: {
      memoryFiles: { root },
      memorySummary: {
        enabled: true,
        manualRunRequiresSleeping: true,
        baseURL: "https://default.example.test/v1",
        apiKey: "default-key",
        model: "default-memory-model",
        temperature: 0.2,
        timeoutMs: 60_000,
        stream: false,
        extraParams: {},
        followupExtraParams: {}
      },
      llm: {
        provider: "stub",
        baseURL: "",
        apiKey: "",
        model: "core-model",
        temperature: 0.2,
        timeoutMs: 60_000,
        stream: false,
        extraParams: {},
        followupExtraParams: {}
      },
      plugins: { wechat: { enabled: false }, feishu: { enabled: false } },
      core: { timezone: "Asia/Shanghai" }
    },
    logs: [],
    messageLogs: [],
    llmRequestLogs: [],
    llmResponseLogs: [],
    getActiveLLMSession: () => undefined,
    getClearedLLMSessions: () => [],
    getMemoryLLMSessions: () => [],
    getLLMSession: () => undefined,
    store: undefined,
    getLLMRequestPreview: () => undefined,
    getLLMRequestProfilePreview: () => undefined,
    getTokenUsageReport: () => ({}),
    clearLLMChainCache() {},
    cancelActiveLLMRun: () => ({ ok: true, hadActiveRequest: false }),
    clearMemoryInductionSession() {},
    outputRouter: { listChannels: () => [] },
    feishuPairingStore: { list: () => [] },
    coreProfileStore: { get: () => ({ appearanceDescription: "" }) },
    promptProfileStore: { get: () => ({ userName: "user", layers: [], visibleTools: {} }), save: (profile: unknown) => profile },
    memoryStore,
    diaryStore: {
      listSleepBoundaries: () => [
        { occurredAt: "2026-05-23T22:00:00.000", source: "inferred_start" },
        { occurredAt: "2026-05-24T06:00:00.000", source: "sleep" }
      ],
      recordSleepBoundary() {}
    },
    memoryInductionPromptStore: promptStore,
    runMemoryInductionForMessages: async () => ({ ok: false, startedAt: "", windowEndAt: "", messageCount: 0, results: [] }),
    getDailyShell: () => "",
    dailyShellStore: { get: () => ({}), getConfig: () => ({}), render: () => "", reroll() {}, listSwitchLogs: () => [] },
    agentState: { getSnapshot: () => ({ state: "sleeping" }), setState() {} },
    messagingTools: emptyPlugin("messaging"),
    photoTools: emptyPlugin("photo"),
    shellTools: emptyPlugin("shell"),
    bookcaseTools: emptyPlugin("bookcase"),
    sleepCocoonTools: emptyPlugin("sleep-cocoon"),
    feishu: { async start() {}, async stop() {}, async send() {} },
    wechat: { async start() {}, async stop() {}, async send() {} },
    wechatStateStore: {
      listContacts: () => [],
      getCredentials: () => undefined,
      saveCredentials() {},
      clearCredentials() {}
    },
    runtime: { feishuStarted: false, wechatStarted: false },
    messageRuntime: { pauseHeartbeat() {}, resumeHeartbeat() {}, async processNow() {}, getStatus: () => ({}) },
    getLLM: () => editToolClient([], []),
    reloadLLM() {},
    time: {
      timeZone: "Asia/Shanghai",
      now: () => ({ iso: "2026-05-24T06:00:00.000Z", date: new Date("2026-05-24T06:00:00.000Z") })
    },
    setTimeZone() {},
    appendLog() {},
    appendMessageLog: () => ({})
  } as any;
}

function emptyPlugin(id: string) {
  return {
    id,
    listTools: () => [],
    async execute() {
      return { ok: false, error: "not implemented" };
    }
  };
}

function createRequest(method: string, url: string, body: Record<string, unknown>) {
  const request = Readable.from([JSON.stringify(body)]) as any;
  request.method = method;
  request.url = url;
  request.socket = { remoteAddress: "127.0.0.1" };
  request.headers = {};
  return request;
}

function createRawRequest(method: string, url: string, body: Buffer, headers: Record<string, string> = {}) {
  const request = Readable.from([body]) as any;
  request.method = method;
  request.url = url;
  request.socket = { remoteAddress: "127.0.0.1" };
  request.headers = headers;
  return request;
}

function writePreset(root: string, name: string) {
  const filePath = path.join(root, "config", "llm-api-presets.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const current = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : { presets: [] };
  const presets = Array.isArray(current.presets) ? current.presets.filter((entry: { name?: string }) => entry.name !== name) : [];
  presets.push({
    name,
    baseURL: "https://llm.example.test/v1",
    apiKey: "secret",
    model: "flash",
    temperature: 0.2,
    timeoutMs: 60_000,
    stream: false,
    extraParams: {},
    followupExtraParams: {}
  });
  fs.writeFileSync(filePath, `${JSON.stringify({ presets })}\n`);
}

function createResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(statusCode: number, headers: Record<string, string>) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk: string) {
      this.body = chunk;
    }
  };
}

function editToolClient(seen: LLMChatInput[], patches: string[]): LLMClient {
  let index = 0;
  let finishNext = false;
  return {
    async chat(input) {
      seen.push(input);
      if (finishNext) {
        finishNext = false;
        return { message: { role: "assistant", content: "done" } };
      }
      const patch = patches[index++] ?? addPatch("fallback\n");
      finishNext = true;
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: `edit_${index}`,
            type: "function",
            function: {
              name: "apply_patch",
              arguments: JSON.stringify({ patch })
            }
          }]
        }
      };
    }
  };
}

function addPatch(content: string): string {
  const lines = content.trimEnd().split("\n");
  return [
    "--- a/memory.md",
    "+++ b/memory.md",
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`)
  ].join("\n");
}

function message(createdAt: string, contentText: string): StoredConversationMessage {
  return {
    id: 1,
    plugin: "feishu",
    conversationId: "session",
    direction: "inbound",
    senderRole: "user",
    contentType: "text",
    contentText,
    createdAt,
    status: "sent",
    isRead: false,
    isRecalled: false,
    reactionsJson: "{}",
    lastEventAt: createdAt
  };
}

function makeTempDir(name: string): string {
  const dir = path.join(process.cwd(), ".tmp-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
