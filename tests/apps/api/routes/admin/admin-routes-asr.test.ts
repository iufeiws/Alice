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
  writePreset,
  writeTtsPluginConfig
} from "./admin-routes-helpers.js";
import type { LLMChatInput, StoredConversationMessage } from "./admin-routes-helpers.js";

test("admin plugin config patch writes ASR general and OpenAI compatible fields", async () => {
  const { response, saved } = await patchAsrConfig();

  assert.equal(response.statusCode, 200);
  assert.equal(saved.providers.openaiCompatible.apiPresetName, "asr-openai");
  assert.equal(saved.directAudioInputEnabled, true);
  assert.equal(saved.providers.openaiCompatible.apiKey, undefined);
  assert.equal(saved.providers.openaiCompatible.model, undefined);
});

test("admin plugin config patch writes ASR multimodal LLM fields", async () => {
  const { response, saved } = await patchAsrConfig();

  assert.equal(response.statusCode, 200);
  assert.equal(saved.providers.multimodalLlm.apiPresetName, "asr-openai");
  assert.equal(saved.providers.multimodalLlm.extraParams.tool_choice.function.name, "submit_audio_context");
});

test("admin plugin config patch writes ASR Tencent fields", async () => {
  const { response, saved } = await patchAsrConfig();

  assert.equal(response.statusCode, 200);
  assert.equal(saved.providers.tencent.secretKey, "secret-key");
  assert.ok(saved.providers.tencent.engineModelType);
});

async function patchAsrConfig() {
  const root = makeTempDir("admin-asr-plugin-config");
  const configPath = path.join(root, "config", "plugin", "asr", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: false,
    defaultProvider: "openai_compatible",
    providers: {}
  })}\n`);
  writePreset(root, "asr-openai");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { asr: { configPath } }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/asr/config", {
    enabled: true,
    defaultProvider: "openai_compatible",
    directAudioInputEnabled: true,
    providers: {
      openaiCompatible: {
        apiPresetName: "asr-openai",
        model: "whisper-1",
        responseFormat: "json"
      },
      multimodalLlm: {
        apiPresetName: "asr-openai",
        prompt: "configured prompt",
        extraParams: "{\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"submit_audio_context\"}}}"
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
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  return { response, saved };
}

test("admin photo plugin config rejects invalid selfie mode", async () => {
  const root = makeTempDir("admin-plugin-invalid-inputs");
  const photoConfigPath = path.join(root, "config", "plugin", "photo", "config.json");
  fs.mkdirSync(path.dirname(photoConfigPath), { recursive: true });
  fs.writeFileSync(photoConfigPath, `${JSON.stringify({ enabled: true, selfieMode: "codex" })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const base = baseContext(root, memoryStore, promptStore);
  const handler = createAdminHandler({
    ...base,
    config: { ...base.config, photo: photoDefaults() },
    pluginConfigs: { photo: { configPath: photoConfigPath } }
  });

  await assertPatchError(handler, "/admin/api/plugins/photo/config", { selfieMode: "bad" }, "invalid_selfie_mode");
});

test("admin photo plugin config rejects invalid selfie timeout", async () => {
  const root = makeTempDir("admin-plugin-invalid-photo-timeout");
  const photoConfigPath = path.join(root, "config", "plugin", "photo", "config.json");
  fs.mkdirSync(path.dirname(photoConfigPath), { recursive: true });
  fs.writeFileSync(photoConfigPath, `${JSON.stringify({ enabled: true, selfieMode: "codex" })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const base = baseContext(root, memoryStore, promptStore);
  const handler = createAdminHandler({
    ...base,
    config: { ...base.config, photo: photoDefaults() },
    pluginConfigs: { photo: { configPath: photoConfigPath } }
  });

  await assertPatchError(handler, "/admin/api/plugins/photo/config", { selfieCodexTimeoutMs: "abc" }, "invalid_selfie_codex_timeout");
});

test("admin ASR plugin config rejects invalid provider", async () => {
  const root = makeTempDir("admin-plugin-invalid-asr");
  const asrConfigPath = path.join(root, "config", "plugin", "asr", "config.json");
  fs.mkdirSync(path.dirname(asrConfigPath), { recursive: true });
  fs.writeFileSync(asrConfigPath, `${JSON.stringify({ enabled: true, defaultProvider: "openai_compatible", providers: { openaiCompatible: {} } })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { asr: { configPath: asrConfigPath } }
  });

  await assertPatchError(handler, "/admin/api/plugins/asr/config", { defaultProvider: "bad" }, "invalid_asr_provider");
});

test("admin world wanderer plugin config rejects invalid initial location", async () => {
  const root = makeTempDir("admin-plugin-invalid-world");
  const worldConfigPath = path.join(root, "config", "plugin", "world-wanderer", "config.json");
  fs.mkdirSync(path.dirname(worldConfigPath), { recursive: true });
  fs.writeFileSync(worldConfigPath, `${JSON.stringify({ enabled: true })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { worldWanderer: { configPath: worldConfigPath } }
  });

  await assertPatchError(handler, "/admin/api/plugins/world_wanderer/config", { initialLocation: "[]" }, "invalid_initial_location");
});

test("admin TTS plugin config rejects invalid Bailian service", async () => {
  const root = makeTempDir("admin-plugin-invalid-tts");
  const ttsConfigPath = path.join(root, "config", "plugin", "tts", "config.json");
  writeTtsPluginConfig(root, {
    configPath: ttsConfigPath,
    enabled: true,
    activePresetName: "bailian",
    preset: {
      provider: "bailian",
      bailian: {
        service: "qwen",
        endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        model: "qwen3-tts-vc-2026-01-22",
        voice: "Cherry"
      }
    }
  });
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { tts: { configPath: ttsConfigPath } }
  });

  await assertPatchError(handler, "/admin/api/plugins/tts/config", { currentPreset: { provider: "bailian", bailian: { service: "bad" } } }, "invalid_bailian_service");
});

test("admin bash sandbox plugin config rejects invalid network", async () => {
  const root = makeTempDir("admin-plugin-invalid-bash-network");
  const bashSandboxEnvPath = path.join(root, ".env");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { bashSandbox: { envPath: bashSandboxEnvPath } }
  });

  await assertPatchError(handler, "/admin/api/plugins/bash_sandbox/config", { network: "bad" }, "invalid_bash_sandbox_network");
});

test("admin bash sandbox plugin config rejects invalid mounts", async () => {
  const root = makeTempDir("admin-plugin-invalid-bash-mounts");
  const bashSandboxEnvPath = path.join(root, ".env");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { bashSandbox: { envPath: bashSandboxEnvPath } }
  });

  await assertPatchError(handler, "/admin/api/plugins/bash_sandbox/config", { mounts: "{}" }, "invalid_bash_sandbox_mounts");
});

async function readAsrConfigSchema(name: string) {
  const root = makeTempDir(name);
  const configPath = path.join(root, "config", "plugin", "asr", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: false,
    defaultProvider: "openai_compatible",
    providers: {}
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { asr: { configPath } }
  });

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/asr/config", {}), response);
  const body = JSON.parse(response.body);

  return { body, response };
}

test("admin ASR plugin config exposes schema", async () => {
  const { body, response } = await readAsrConfigSchema("admin-asr-plugin-schema-groups");

  assert.equal(response.statusCode, 200);
  assert.ok(Array.isArray(body.configSchema.groups));
  assert.ok(Array.isArray(body.configSchema.fields));
});

test("admin plugin enable updates ASR config", async () => {
  const root = makeTempDir("admin-asr-plugin-switch");
  const configPath = path.join(root, "config", "plugin", "asr", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: false,
    defaultProvider: "openai_compatible",
    providers: {}
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { asr: { configPath } }
  };
  const handler = createAdminHandler(context);

  const enableResponse = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/asr/enable", {}), enableResponse);
  assert.equal(enableResponse.statusCode, 200);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).enabled, true);
});

test("admin plugin disable updates ASR config", async () => {
  const root = makeTempDir("admin-asr-plugin-disable");
  const configPath = path.join(root, "config", "plugin", "asr", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    defaultProvider: "openai_compatible",
    providers: {}
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { asr: { configPath } }
  };
  const handler = createAdminHandler(context);

  const disableResponse = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/asr/disable", {}), disableResponse);
  assert.equal(disableResponse.statusCode, 200);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).enabled, false);
});

test("admin plugin ASR test audio upload stores plugin asset path", async () => {
  const root = makeTempDir("admin-asr-plugin-asset");
  const assetRoot = path.join(root, "assets");
  const configPath = path.join(root, "config", "plugin", "asr", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: false,
    defaultProvider: "openai_compatible",
    providers: {}
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { asr: { configPath, assetRoot } }
  };
  const handler = createAdminHandler(context);

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
  assert.equal(fs.readFileSync(path.join(assetRoot, "plugin", "asr", "test-audio", fileName), "utf8"), "audio");
});

test("admin plugin test runs ASR transcriber with uploaded audio", async () => {
  const root = makeTempDir("admin-asr-plugin-test");
  const assetRoot = path.join(root, "assets");
  const configPath = path.join(root, "config", "plugin", "asr", "config.json");
  const audioAssetPath = path.join("assets", "plugin", "asr", `test-${path.basename(root)}.wav`);
  const audioPath = path.join(assetRoot, "plugin", "asr", `test-${path.basename(root)}.wav`);
  let capturedAudioFile = "";
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(audioPath), { recursive: true });
  fs.writeFileSync(audioPath, "audio");
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    defaultProvider: "openai_compatible",
    testAudioPath: audioAssetPath,
    providers: {
      openaiCompatible: {
        apiPresetName: "asr"
      }
    }
  })}\n`);
  writePreset(root, "asr");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: {
      asr: {
        configPath,
        assetRoot,
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
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/asr/test", {}), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(capturedAudioFile, audioPath);
  assert.equal(typeof body.result.output, "string");
  assert.equal(body.result.provider, "openai_compatible");
  assert.equal(body.result.model, "whisper-1");
  assert.equal(typeof body.result.timing.totalMs, "number");
  fs.rmSync(audioPath, { force: true });
});

test("admin plugin test sends multimodal LLM ASR request contract", async () => {
  const { response, capturedRequest } = await runMultimodalLlmAsrTest();

  assert.equal(response.statusCode, 200);
  assert.equal(capturedRequest.agentId, "asr");
  assert.equal(capturedRequest.presetName, "asr");
  assert.deepEqual(capturedRequest.toolNames, ["submit_audio_context"]);
  assert.deepEqual(capturedRequest.extraParams, {
    tool_choice: {
      type: "function",
      function: { name: "submit_audio_context" }
    }
  });
});

test("admin plugin test parses multimodal LLM ASR tool-call output", async () => {
  const { response, body } = await runMultimodalLlmAsrTest();

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.result.output, "string");
  assert.equal(body.result.provider, "multimodal_llm");
  assert.equal(body.result.model, "flash");
  assert.equal(body.result.requestId, "admin-asr-request");
});

async function runMultimodalLlmAsrTest() {
  const root = makeTempDir("admin-asr-plugin-test-multimodal");
  const assetRoot = path.join(root, "assets");
  const configPath = path.join(root, "config", "plugin", "asr", "config.json");
  const audioAssetPath = path.join("assets", "plugin", "asr", `test-${path.basename(root)}.wav`);
  const audioPath = path.join(assetRoot, "plugin", "asr", `test-${path.basename(root)}.wav`);
  let capturedRequest: any;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(audioPath), { recursive: true });
  fs.writeFileSync(audioPath, "audio");
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    defaultProvider: "multimodal_llm",
    testAudioPath: audioAssetPath,
    providers: {
      multimodalLlm: {
        apiPresetName: "asr",
        prompt: "configured prompt",
        extraParams: {
          tool_choice: {
            type: "function",
            function: { name: "submit_audio_context" }
          }
        }
      }
    }
  })}\n`);
  writePreset(root, "asr");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: {
      asr: {
        configPath,
        assetRoot
      }
    },
    llmRequestSender: async (request: any) => {
      capturedRequest = request;
      return {
        id: "admin-asr-request",
        model: "flash",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "submit_audio_context",
              arguments: JSON.stringify({ speakText: "后台识别", emotion: "calm", description: "" })
            }
          }]
        }
      };
    }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/asr/test", {}), response);
  const body = JSON.parse(response.body);

  fs.rmSync(audioPath, { force: true });
  return { response, body, capturedRequest };
}
