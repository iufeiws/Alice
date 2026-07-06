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
  writeTtsPluginConfig,
  writePreset
} from "./admin-routes-helpers.js";
import type { LLMChatInput, StoredConversationMessage } from "./admin-routes-helpers.js";

test("admin plugin config patch writes tts preset reference", async () => {
  const { response, saved, savedGenie, presetName } = await patchTtsConfig();

  assert.equal(response.statusCode, 200);
  assert.equal(saved.enabled, true);
  assert.equal(saved.activePresetName, "genie-jp");
  assert.equal(saved.editPresetName, presetName);
  assert.equal(savedGenie.provider, "genie");
  assert.deepEqual(savedGenie.genie, { enabled: false, baseURL: "http://10.0.0.8:8767", localFallbackEnabled: false, language: "zh", modelDir: "assets/tts/preset/genie-jp/model", speed: 1.2, partSilenceSeconds: 0.45, splitText: false });
});

test("admin plugin config patch writes tts translation config", async () => {
  const { response, saved } = await patchTtsConfig();

  assert.equal(response.statusCode, 200);
  assert.equal(saved.translationPresetName, "default");
  assert.equal(saved.translationPresets.main.translationEnabled, false);
  assert.equal(saved.translationPresets.main.prompt, "New prompt");
  assert.equal(saved.translationPresets.main.apiPresetName, "voice");
});

test("admin plugin config patch writes tts reference text asset", async () => {
  const { response, assetRoot, presetName } = await patchTtsConfig();

  assert.equal(response.statusCode, 200);
  assert.equal(fs.readFileSync(path.join(assetRoot, "tts", "preset", presetName, "reference.txt"), "utf8"), "これは参照テキストです。");
});

test("admin plugin config patch does not persist edit fields", async () => {
  const { response, saved } = await patchTtsConfig();

  assert.equal(response.statusCode, 200);
  assert.equal(saved.newPresetName, undefined);
  assert.equal(saved.currentPreset, undefined);
});

async function patchTtsConfig() {
  const root = makeTempDir("admin-plugin-config");
  const assetRoot = path.join(root, "assets");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  writeTtsPluginConfig(root, { configPath, translation: { apiPresetName: "old", prompt: "Old prompt" } });
  writePreset(root, "voice");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { tts: { configPath, assetRoot } }
  };
  const handler = createAdminHandler(context);
  const presetName = `zh-${path.basename(root)}`;

  const response = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/tts/config", {
    enabled: true,
    newPresetName: presetName,
    newTranslationPresetName: "main",
    currentTranslation: {
      translationEnabled: false,
      prompt: "New prompt",
      apiPresetName: "voice"
    },
    currentPreset: {
      provider: "genie",
      genie: {
        enabled: false,
        baseURL: "10.0.0.8",
        localFallbackEnabled: false,
        language: "zh",
        referenceText: "これは参照テキストです。",
        speed: 1.2,
        partSilenceSeconds: 0.45,
        splitText: false
      }
    }
  }), response);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  const savedGenie = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), "presets", `${presetName}.json`), "utf8"));

  return { response, saved, savedGenie, assetRoot, presetName };
}

test("admin TTS config schema exposes group order", async () => {
  const { response, body } = await readTtsConfigSchema();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.configSchema.groups.map((group: { key: string }) => group.key), ["translation", "model_genie", "conversion_openai_api", "conversion_bailian", "conversion_mimo", "general"]);
});

test("admin TTS config schema exposes Genie preset fields", async () => {
  const { response, body } = await readTtsConfigSchema();
  const configField = body.configSchema.fields.find((field: { key: string }) => field.key === "editPresetName");
  const languageField = body.configSchema.fields.find((field: { key: string }) => field.key === "currentPreset.genie.language");
  const modelField = body.configSchema.fields.find((field: { key: string }) => field.key === "currentPreset.genie.modelDir");
  const remoteEnabledField = body.configSchema.fields.find((field: { key: string }) => field.key === "currentPreset.genie.enabled");
  const localFallbackField = body.configSchema.fields.find((field: { key: string }) => field.key === "currentPreset.genie.localFallbackEnabled");
  const remoteUrlField = body.configSchema.fields.find((field: { key: string }) => field.key === "currentPreset.genie.baseURL");

  assert.equal(response.statusCode, 200);
  assert.equal(configField.type, "select");
  assert.equal(configField.group, "model_genie");
  assert.deepEqual(configField.options.map((option: { value: string }) => option.value), ["genie-jp"]);
  assert.equal(languageField.type, "select");
  assert.equal(languageField.group, "model_genie");
  assert.deepEqual(languageField.options.map((option: { value: string }) => option.value), ["jp", "zh", "en"]);
  assert.equal(modelField.label, "Model Folder");
  assert.equal(modelField.group, "model_genie");
  assert.equal(remoteEnabledField.type, "switch");
  assert.equal(remoteEnabledField.group, "model_genie");
  assert.equal(localFallbackField.type, "switch");
  assert.equal(localFallbackField.group, "model_genie");
  assert.equal(remoteUrlField.type, "text");
  assert.equal(remoteUrlField.group, "model_genie");
});

test("admin TTS config schema exposes provider selector", async () => {
  const { response, body } = await readTtsConfigSchema();
  const providerField = body.configSchema.fields.find((field: { key: string }) => field.key === "currentPreset.provider");

  assert.equal(response.statusCode, 200);
  assert.equal(providerField.type, "select");
  assert.equal(providerField.group, "general");
});

test("admin TTS config schema exposes OpenAI conversion preset field", async () => {
  const { response, body } = await readTtsConfigSchema();
  const openAiPresetField = body.configSchema.fields.find((field: { key: string }) => field.key === "currentPreset.openaiApi.apiPresetName");

  assert.equal(response.statusCode, 200);
  assert.equal(openAiPresetField.type, "apiPresetSelect");
  assert.equal(openAiPresetField.group, "conversion_openai_api");
});

test("admin TTS config schema exposes Bailian conversion fields", async () => {
  const { response, body } = await readTtsConfigSchema();
  const bailianServiceField = body.configSchema.fields.find((field: { key: string }) => field.key === "currentPreset.bailian.service");
  const bailianKeyField = body.configSchema.fields.find((field: { key: string }) => field.key === "currentPreset.bailian.apiKey");
  const bailianModelField = body.configSchema.fields.find((field: { key: string }) => field.key === "currentPreset.bailian.model");

  assert.equal(response.statusCode, 200);
  assert.equal(bailianServiceField.type, "select");
  assert.deepEqual(bailianServiceField.options.map((option: { value: string }) => option.value), ["qwen", "cosy"]);
  assert.equal(bailianKeyField.type, "password");
  assert.equal(bailianKeyField.group, "conversion_bailian");
  assert.equal(bailianModelField.type, "text");
  assert.equal(bailianModelField.group, "conversion_bailian");
});

test("admin TTS config schema omits unsupported MiMo model field", async () => {
  const { response, body } = await readTtsConfigSchema();
  const mimoModelField = body.configSchema.fields.find((field: { key: string }) => field.key === "currentPreset.mimo.model");

  assert.equal(response.statusCode, 200);
  assert.equal(mimoModelField, undefined);
});

async function readTtsConfigSchema() {
  const root = makeTempDir("admin-tts-config-schema");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  writeTtsPluginConfig(root, { configPath, translation: { apiPresetName: "voice", prompt: "Translate:" } });
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { tts: { configPath } }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/tts/config", {}), response);
  const body = JSON.parse(response.body);
  return { response, body };
}

test("admin TTS config patch stores Bailian api key", async () => {
  const root = makeTempDir("admin-tts-bailian-key");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  writeTtsPluginConfig(root, {
    configPath,
    enabled: true,
    activePresetName: "bailian",
    preset: {
      provider: "bailian",
      bailian: {
        service: "qwen",
        endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        apiKeyEnv: "DASHSCOPE_API_KEY",
        model: "qwen3-tts-vc-2026-01-22",
        voice: "Cherry"
      }
    }
  });
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { tts: { configPath } }
  };
  const handler = createAdminHandler(context);

  const first = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/tts/config", {
    currentPreset: {
      provider: "bailian",
      bailian: {
        apiKey: "dashscope-secret",
        model: "qwen3-tts-vc-2026-01-22",
        voice: "Cherry"
      }
    }
  }), first);
  const firstSaved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const firstBailian = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), "presets", "bailian.json"), "utf8"));

  assert.equal(first.statusCode, 200);
  assert.equal(firstSaved.activePresetName, "bailian");
  assert.equal(firstBailian.bailian.apiKey, "dashscope-secret");
});

test("admin TTS config patch preserves Bailian api key when blank", async () => {
  const root = makeTempDir("admin-tts-bailian-key-preserve");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  writeTtsPluginConfig(root, {
    configPath,
    enabled: true,
    activePresetName: "bailian",
    preset: {
      provider: "bailian",
      bailian: {
        service: "qwen",
        endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        apiKey: "dashscope-secret",
        model: "qwen3-tts-vc-2026-01-22",
        voice: "Cherry"
      }
    }
  });
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { tts: { configPath } }
  };
  const handler = createAdminHandler(context);

  const second = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/tts/config", {
    currentPreset: {
      provider: "bailian",
      bailian: {
        apiKey: "",
        voice: "Cherry"
      }
    }
  }), second);
  const secondSaved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const secondBailian = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), "presets", "bailian.json"), "utf8"));

  assert.equal(second.statusCode, 200);
  assert.equal(secondSaved.activePresetName, "bailian");
  assert.equal(secondBailian.bailian.apiKey, "dashscope-secret");
});

test("admin TTS config patch switches Bailian service default endpoint", async () => {
  const root = makeTempDir("admin-tts-bailian-service");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  writeTtsPluginConfig(root, {
    configPath,
    enabled: true,
    activePresetName: "bailian",
    preset: { provider: "bailian", bailian: { service: "qwen", model: "qwen3-tts-vc-2026-01-22", voice: "Cherry" } }
  });
  const context = {
    ...baseContext(root, createMarkdownMemoryStore(root), createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"))),
    pluginConfigs: { tts: { configPath } }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/tts/config", {
    currentPreset: {
      provider: "bailian",
      bailian: {
        service: "cosy",
        model: "cosyvoice-v2",
        voice: "longxiaochun"
      }
    }
  }), response);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const savedBailian = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), "presets", "bailian.json"), "utf8"));

  assert.equal(response.statusCode, 200);
  assert.equal(saved.activePresetName, "bailian");
  assert.equal(savedBailian.bailian.service, "cosy");
  assert.equal(savedBailian.bailian.endpoint, "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer");
});

test("admin plugin test can run tts with translation disabled", async () => {
  const root = makeTempDir("admin-plugin-test-no-translate");
  const assetRoot = path.join(root, "assets");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  const ttsOutputDir = "generated/tts";
  const voicePath = path.join(assetRoot, "generated", "tts", `voice-${path.basename(root)}.opus`);
  let capturedText = "";
  fs.mkdirSync(path.dirname(voicePath), { recursive: true });
  writeTtsPluginConfig(root, { configPath, enabled: true, translation: { prompt: "Translate:" } });
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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

test("admin plugin enable updates tts config", async () => {
  const root = makeTempDir("admin-plugin-switch");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  writeTtsPluginConfig(root, { configPath, translation: { apiPresetName: "voice", prompt: "Translate:" } });
  writePreset(root, "voice");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { tts: { configPath } }
  };
  const handler = createAdminHandler(context);

  const enableResponse = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/tts/enable", {}), enableResponse);
  assert.equal(enableResponse.statusCode, 200);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).enabled, true);
});

test("admin plugin disable updates tts config", async () => {
  const root = makeTempDir("admin-plugin-disable");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  writeTtsPluginConfig(root, { configPath, enabled: true, translation: { apiPresetName: "voice" } });
  writePreset(root, "voice");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { tts: { configPath } }
  };
  const handler = createAdminHandler(context);

  const disableResponse = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/tts/disable", {}), disableResponse);
  assert.equal(disableResponse.statusCode, 200);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).enabled, false);
});
