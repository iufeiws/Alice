import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertPatchError,
  baseContext,
  createAdminHandler,
  createCalendarStore,
  createDailyShellStore,
  createDiaryStore,
  createMarkdownMemoryStore,
  createMemoryInductionPromptStore,
  createPromptProfileStore,
  createRawRequest,
  createRequest,
  createResponse,
  editToolClient,
  fs,
  makeTempDir,
  makeTinyWavBuffer,
  message,
  path,
  photoDefaults,
  promptStoragePath,
  runMemoryInductionForMessages,
  writePreset
} from "./admin-routes-helpers.js";
import type { LLMChatInput, StoredConversationMessage } from "./admin-routes-helpers.js";

test("admin plugin config patch writes tts config with preset reference only", async () => {
  const root = makeTempDir("admin-plugin-config");
  const assetRoot = path.join(root, "assets");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: false,
    apiPresetName: "old",
    prompt: "Old prompt"
  })}\n`);
  writePreset(root, "voice");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { tts: { configPath, assetRoot } }
  };
  const handler = createAdminHandler(context);
  const modelConfigName = `zh-${path.basename(root)}`;

  const response = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/tts/config", {
    enabled: true,
    remote: {
      enabled: false,
      baseURL: "10.0.0.8",
      localFallbackEnabled: false
    },
    newTranslationPresetName: "main",
    currentTranslation: {
      translationEnabled: false,
      prompt: "New prompt",
      apiPresetName: "voice"
    },
    voice: {
      newModelConfigName: modelConfigName,
      currentModel: {
        language: "zh",
        referenceText: "これは参照テキストです。",
        speed: 1.2,
        partSilenceSeconds: 0.45,
        splitText: false
      }
    }
  }), response);
  const body = JSON.parse(response.body);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  const savedGenie = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), "providers", "genie.json"), "utf8"));

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.configValue.translationPresetName, "default");
  assert.deepEqual(body.configValue.remote, { enabled: false, baseURL: "http://10.0.0.8:8767", localFallbackEnabled: false });
  assert.equal(body.configValue.translationPresets.main.apiPresetName, "voice");
  assert.equal(body.configValue.voice.modelConfigs[modelConfigName].language, "zh");
  assert.equal(saved.enabled, true);
  assert.equal(saved.remote, undefined);
  assert.deepEqual(savedGenie, { enabled: false, baseURL: "http://10.0.0.8:8767", localFallbackEnabled: false });
  assert.deepEqual(saved.conversion, { provider: "genie" });
  assert.equal(saved.translationPresetName, "default");
  assert.equal(saved.translationPresets.main.translationEnabled, false);
  assert.equal(saved.translationPresets.main.prompt, "New prompt");
  assert.equal(saved.translationPresets.main.apiPresetName, "voice");
  assert.equal(saved.api_preset, undefined);
  assert.equal(saved.voice.modelConfigName, "jp");
  assert.equal(saved.voice.newModelConfigName, undefined);
  assert.equal(saved.voice.currentModel, undefined);
  assert.equal(saved.voice.modelConfigs[modelConfigName].language, "zh");
  assert.equal(saved.voice.modelConfigs[modelConfigName].modelDir, undefined);
  assert.equal(saved.voice.modelConfigs[modelConfigName].referenceText, undefined);
  assert.equal(saved.voice.modelConfigs[modelConfigName].speed, 1.2);
  assert.equal(saved.voice.modelConfigs[modelConfigName].partSilenceSeconds, 0.45);
  assert.equal(saved.voice.modelConfigs[modelConfigName].splitText, false);
  assert.equal(fs.readFileSync(path.join(assetRoot, "tts", "preset", modelConfigName, "reference.txt"), "utf8"), "これは参照テキストです。");
});

test("admin TTS config schema exposes voice language and language model folder", async () => {
  const root = makeTempDir("admin-tts-config-schema");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled: false, apiPresetName: "voice", prompt: "Translate:" })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { tts: { configPath } }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/tts/config", {}), response);
  const body = JSON.parse(response.body);
  const configField = body.configSchema.fields.find((field: { key: string }) => field.key === "voice.modelEditPresetName");
  const languageField = body.configSchema.fields.find((field: { key: string }) => field.key === "voice.currentModel.language");
  const modelField = body.configSchema.fields.find((field: { key: string }) => field.key === "voice.currentModel.modelDir");
  const providerField = body.configSchema.fields.find((field: { key: string }) => field.key === "conversion.provider");
  const remoteEnabledField = body.configSchema.fields.find((field: { key: string }) => field.key === "conversion.genie.enabled");
  const localFallbackField = body.configSchema.fields.find((field: { key: string }) => field.key === "conversion.genie.localFallbackEnabled");
  const remoteUrlField = body.configSchema.fields.find((field: { key: string }) => field.key === "conversion.genie.baseURL");
  const openAiPresetField = body.configSchema.fields.find((field: { key: string }) => field.key === "conversion.openaiApi.apiPresetName");
  const bailianServiceField = body.configSchema.fields.find((field: { key: string }) => field.key === "conversion.bailian.service");
  const bailianKeyField = body.configSchema.fields.find((field: { key: string }) => field.key === "conversion.bailian.apiKey");
  const bailianModelField = body.configSchema.fields.find((field: { key: string }) => field.key === "conversion.bailian.model");
  const mimoModelField = body.configSchema.fields.find((field: { key: string }) => field.key === "conversion.mimo.model");

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.configSchema.groups.map((group: { key: string }) => group.key), ["translation", "model_genie", "conversion_openai_api", "conversion_bailian", "conversion_mimo", "general"]);
  assert.equal(configField.type, "select");
  assert.equal(configField.group, "model_genie");
  assert.deepEqual(configField.options.map((option: { value: string }) => option.value), ["jp"]);
  assert.equal(languageField.type, "select");
  assert.equal(languageField.group, "model_genie");
  assert.deepEqual(languageField.options.map((option: { value: string }) => option.value), ["jp", "zh", "en"]);
  assert.equal(modelField.label, "Model Folder");
  assert.equal(modelField.group, "model_genie");
  assert.equal(providerField.type, "select");
  assert.equal(providerField.group, "general");
  assert.equal(remoteEnabledField.type, "switch");
  assert.equal(remoteEnabledField.group, "model_genie");
  assert.equal(localFallbackField.type, "switch");
  assert.equal(localFallbackField.group, "model_genie");
  assert.equal(remoteUrlField.type, "text");
  assert.equal(remoteUrlField.group, "model_genie");
  assert.equal(openAiPresetField.type, "apiPresetSelect");
  assert.equal(openAiPresetField.group, "conversion_openai_api");
  assert.equal(bailianServiceField.type, "select");
  assert.deepEqual(bailianServiceField.options.map((option: { value: string }) => option.value), ["qwen", "cosy"]);
  assert.equal(bailianKeyField.type, "password");
  assert.equal(bailianKeyField.group, "conversion_bailian");
  assert.equal(bailianModelField.type, "text");
  assert.equal(bailianModelField.group, "conversion_bailian");
  assert.equal(mimoModelField, undefined);
});

test("admin TTS config patch stores Bailian api key and preserves it when blank", async () => {
  const root = makeTempDir("admin-tts-bailian-key");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    translationEnabled: false,
    prompt: "Read aloud.",
    conversion: {
      provider: "bailian",
      bailian: {
        service: "qwen",
        endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        apiKeyEnv: "DASHSCOPE_API_KEY",
        model: "qwen3-tts-vc-2026-01-22",
        voice: "Cherry"
      }
    }
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { tts: { configPath } }
  };
  const handler = createAdminHandler(context);

  const first = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/tts/config", {
    conversion: {
      provider: "bailian",
      bailian: {
        apiKey: "dashscope-secret",
        model: "qwen3-tts-vc-2026-01-22",
        voice: "Cherry"
      }
    }
  }), first);
  const firstSaved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const firstBailian = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), "providers", "bailian.json"), "utf8"));

  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body).ok, true);
  assert.deepEqual(firstSaved.conversion, { provider: "bailian" });
  assert.equal(firstBailian.apiKey, "dashscope-secret");

  const second = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/tts/config", {
    conversion: {
      provider: "bailian",
      bailian: {
        apiKey: "",
        voice: "Cherry"
      }
    }
  }), second);
  const secondSaved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const secondBailian = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), "providers", "bailian.json"), "utf8"));

  assert.equal(second.statusCode, 200);
  assert.equal(JSON.parse(second.body).ok, true);
  assert.deepEqual(secondSaved.conversion, { provider: "bailian" });
  assert.equal(secondBailian.apiKey, "dashscope-secret");
});

test("admin TTS config patch switches Bailian service default endpoint", async () => {
  const root = makeTempDir("admin-tts-bailian-service");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    translationEnabled: false,
    prompt: "Read aloud.",
    conversion: {
      provider: "bailian",
      bailian: {
        service: "qwen",
        model: "qwen3-tts-vc-2026-01-22",
        voice: "Cherry"
      }
    }
  })}\n`);
  const context = {
    ...baseContext(root, createMarkdownMemoryStore(root), createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]))),
    pluginConfigs: { tts: { configPath } }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/tts/config", {
    conversion: {
      provider: "bailian",
      bailian: {
        service: "cosy",
        model: "cosyvoice-v2",
        voice: "longxiaochun"
      }
    }
  }), response);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const savedBailian = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), "providers", "bailian.json"), "utf8"));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(saved.conversion, { provider: "bailian" });
  assert.equal(savedBailian.service, "cosy");
  assert.equal(savedBailian.endpoint, "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer");
});

test("admin plugin test can run tts with translation disabled", async () => {
  const root = makeTempDir("admin-plugin-test-no-translate");
  const assetRoot = path.join(root, "assets");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  const ttsOutputDir = "generated/tts";
  const voicePath = path.join(assetRoot, "generated", "tts", `voice-${path.basename(root)}.opus`);
  let capturedText = "";
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(voicePath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled: true, translationEnabled: false, prompt: "Translate:" })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  let llmCalls = 0;
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    config: {
      ...baseContext(root, memoryStore, promptStore).config,
      tts: { mossOutputDir: ttsOutputDir }
    },
    pluginConfigs: {
      tts: {
        configPath,
        assetRoot,
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
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/tts/test", { text: "晚点见" }), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.result.output, "晚点见");
  assert.equal(body.result.timing.translationMs, 0);
  assert.equal(capturedText, "晚点见");
  assert.equal(llmCalls, 0);
  fs.rmSync(voicePath, { force: true });
});

test("admin plugin enable and disable update tts config", async () => {
  const root = makeTempDir("admin-plugin-switch");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: false,
    apiPresetName: "voice",
    prompt: "Translate:"
  })}\n`);
  writePreset(root, "voice");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { tts: { configPath } }
  };
  const handler = createAdminHandler(context);

  const enableResponse = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/tts/enable", {}), enableResponse);
  assert.equal(enableResponse.statusCode, 200);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).enabled, true);

  const disableResponse = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/tts/disable", {}), disableResponse);
  assert.equal(disableResponse.statusCode, 200);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).enabled, false);
});
