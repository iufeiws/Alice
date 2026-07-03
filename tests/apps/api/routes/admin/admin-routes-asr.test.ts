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

test("admin plugin config patch writes ASR config with preset references only", async () => {
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
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
  const body = JSON.parse(response.body);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.configValue.directAudioInputEnabled, true);
  assert.equal(body.configValue.providers.openaiCompatible.apiPresetName, "asr-openai");
  assert.equal(body.configValue.providers.multimodalLlm.apiPresetName, "asr-openai");
  assert.equal(body.configValue.providers.multimodalLlm.prompt, "configured prompt");
  assert.equal(body.configValue.providers.multimodalLlm.extraParams.tool_choice.function.name, "submit_audio_context");
  assert.equal(body.configValue.providers.tencent.secretId, "secret-id");
  assert.equal(body.configValue.providers.tencent.secretKey, "secret-key");
  assert.equal(saved.providers.openaiCompatible.apiKey, undefined);
  assert.equal(saved.directAudioInputEnabled, true);
  assert.equal(saved.providers.tencent.secretKey, "secret-key");
  assert.equal(saved.providers.openaiCompatible.model, undefined);
  assert.equal(saved.providers.multimodalLlm.extraParams.tool_choice.function.name, "submit_audio_context");
  assert.equal(saved.providers.tencent.engineModelType, "16k_zh");
});

test("admin plugin config patch rejects invalid submitted values instead of falling back", async () => {
  const root = makeTempDir("admin-plugin-invalid-inputs");
  const photoConfigPath = path.join(root, "config", "plugin", "photo", "config.json");
  const asrConfigPath = path.join(root, "config", "plugin", "asr", "config.json");
  const worldConfigPath = path.join(root, "config", "plugin", "world-wanderer", "config.json");
  const ttsConfigPath = path.join(root, "config", "plugin", "tts", "config.json");
  const bashSandboxEnvPath = path.join(root, ".env");
  fs.mkdirSync(path.dirname(photoConfigPath), { recursive: true });
  fs.mkdirSync(path.dirname(asrConfigPath), { recursive: true });
  fs.mkdirSync(path.dirname(worldConfigPath), { recursive: true });
  fs.mkdirSync(path.dirname(ttsConfigPath), { recursive: true });
  fs.writeFileSync(photoConfigPath, `${JSON.stringify({ enabled: true, selfieMode: "codex" })}\n`);
  fs.writeFileSync(asrConfigPath, `${JSON.stringify({ enabled: true, defaultProvider: "openai_compatible", providers: { openaiCompatible: {} } })}\n`);
  fs.writeFileSync(worldConfigPath, `${JSON.stringify({ enabled: true })}\n`);
  fs.writeFileSync(ttsConfigPath, `${JSON.stringify({
    enabled: true,
    translationEnabled: false,
    conversion: {
      provider: "bailian",
      bailian: {
        service: "qwen",
        endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        model: "qwen3-tts-vc-2026-01-22",
        voice: "Cherry"
      }
    }
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const base = baseContext(root, memoryStore, promptStore);
  const handler = createAdminHandler({
    ...base,
    config: { ...base.config, photo: photoDefaults() },
    pluginConfigs: {
      photo: { configPath: photoConfigPath },
      asr: { configPath: asrConfigPath },
      worldWanderer: { configPath: worldConfigPath },
      tts: { configPath: ttsConfigPath },
      bashSandbox: { envPath: bashSandboxEnvPath }
    }
  });

  await assertPatchError(handler, "/admin/api/plugins/photo/config", { selfieMode: "bad" }, "invalid_selfie_mode");
  await assertPatchError(handler, "/admin/api/plugins/photo/config", { selfieCodexTimeoutMs: "abc" }, "invalid_selfie_codex_timeout");
  await assertPatchError(handler, "/admin/api/plugins/asr/config", { defaultProvider: "bad" }, "invalid_asr_provider");
  await assertPatchError(handler, "/admin/api/plugins/world_wanderer/config", { initialLocation: "[]" }, "invalid_initial_location");
  await assertPatchError(handler, "/admin/api/plugins/tts/config", { conversion: { bailian: { service: "bad" } } }, "invalid_bailian_service");
  await assertPatchError(handler, "/admin/api/plugins/bash_sandbox/config", { network: "bad" }, "invalid_bash_sandbox_network");
  await assertPatchError(handler, "/admin/api/plugins/bash_sandbox/config", { mounts: "{}" }, "invalid_bash_sandbox_mounts");
});

test("admin ASR plugin config schema groups general and provider settings", async () => {
  const root = makeTempDir("admin-asr-plugin-schema-groups");
  const configPath = path.join(root, "config", "plugin", "asr", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: false,
    defaultProvider: "openai_compatible",
    providers: {}
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { asr: { configPath } }
  });

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/asr/config", {}), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.configSchema.groups.map((group: { key: string }) => group.key), ["general", "openai_compatible", "multimodal_llm", "tencent"]);
  assert.equal(body.configSchema.fields.find((field: { key: string }) => field.key === "enabled").group, "general");
  assert.equal(body.configSchema.fields.find((field: { key: string }) => field.key === "directAudioInputEnabled").type, "switch");
  assert.equal(body.configSchema.fields.find((field: { key: string }) => field.key === "providers.openaiCompatible.model"), undefined);
  assert.equal(body.configSchema.fields.find((field: { key: string }) => field.key === "providers.openaiCompatible.apiPresetName").group, "openai_compatible");
  assert.equal(body.configSchema.fields.find((field: { key: string }) => field.key === "providers.multimodalLlm.apiPresetName").group, "multimodal_llm");
  assert.equal(body.configSchema.fields.find((field: { key: string }) => field.key === "providers.multimodalLlm.extraParams").type, "textarea");
  const protocolField = body.configSchema.fields.find((field: { key: string }) => field.key === "providers.multimodalLlm.protocolCall");
  assert.equal(protocolField.type, "readonlyTextarea");
  assert.equal(typeof body.configValue.providers.multimodalLlm.prompt, "string");
  assert.equal(body.configValue.providers.multimodalLlm.extraParams.tool_choice.function.name, "submit_audio_context");
  assert.equal(body.configSchema.fields.find((field: { key: string }) => field.key === "providers.tencent.engineModelType").group, "tencent");
});

test("admin plugin enable and disable update ASR config", async () => {
  const root = makeTempDir("admin-asr-plugin-switch");
  const configPath = path.join(root, "config", "plugin", "asr", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: false,
    defaultProvider: "openai_compatible",
    providers: {}
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { asr: { configPath } }
  };
  const handler = createAdminHandler(context);

  const enableResponse = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/asr/enable", {}), enableResponse);
  assert.equal(enableResponse.statusCode, 200);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).enabled, true);

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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
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
  assert.equal(body.result.output, "识别文本");
  assert.equal(body.result.provider, "openai_compatible");
  assert.equal(body.result.model, "whisper-1");
  assert.equal(typeof body.result.timing.totalMs, "number");
  fs.rmSync(audioPath, { force: true });
});

test("admin plugin test runs multimodal LLM ASR through llm request dependencies", async () => {
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
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

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.result.output, "[语音][calm]后台识别");
  assert.equal(body.result.provider, "multimodal_llm");
  assert.equal(body.result.model, "flash");
  assert.equal(body.result.requestId, "admin-asr-request");
  assert.equal(capturedRequest.agentId, "asr");
  assert.equal(capturedRequest.client && typeof capturedRequest.client.chat, "function");
  assert.equal(capturedRequest.presetName, "asr");
  assert.deepEqual(capturedRequest.toolNames, ["submit_audio_context"]);
  assert.deepEqual(capturedRequest.extraParams, {
    tool_choice: {
      type: "function",
      function: { name: "submit_audio_context" }
    }
  });
  fs.rmSync(audioPath, { force: true });
});
