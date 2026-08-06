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

test("admin plugin list exposes tts config card state", async () => {
  const root = makeTempDir("admin-plugin-list");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  writeTtsPluginConfig(root, { configPath, enabled: true });
  writePreset(root, "voice");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { tts: { configPath } }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins", {}), response);
  const body = JSON.parse(response.body);
  const tts = body.plugins.find((plugin: { id: string }) => plugin.id === "tts");

  assert.equal(response.statusCode, 200);
  assert.equal(tts.status, "enabled");
  assert.equal(tts.health, "healthy");
  assert.equal(tts.description, "Select the active TTS preset and synthesize send_chat voice through its configured provider.");
  assert.equal(tts.configurable, true);
  assert.equal(tts.switchable, true);
});

test("admin plugin list exposes ASR config card state", async () => {
  const root = makeTempDir("admin-asr-plugin-list");
  const configPath = path.join(root, "config", "plugin", "asr", "config.json");
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { asr: { configPath } }
  };
  const handler = createAdminHandler(context);

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

test("admin plugin list exposes photo selfie config card state", async () => {
  const root = makeTempDir("admin-photo-plugin-list");
  const configPath = path.join(root, "config", "plugin", "photo", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    selfieMode: "codex"
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const base = baseContext(root, memoryStore, promptStore);
  const context = {
    ...base,
    config: {
      ...base.config,
      photo: photoDefaults()
    },
    pluginConfigs: { photo: { configPath } }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins", {}), response);
  const body = JSON.parse(response.body);
  const photo = body.plugins.find((plugin: { id: string }) => plugin.id === "photo");

  assert.equal(response.statusCode, 200);
  assert.equal(photo.status, "enabled");
  assert.equal(photo.health, "healthy");
  assert.equal(photo.kind, "tool");
  assert.equal(photo.configurable, true);
  assert.equal(photo.switchable, true);
  assert.equal(photo.configSource, configPath);
});

test("admin plugin config exposes messaging config values", async () => {
  const root = makeTempDir("admin-messaging-plugin");
  const configPath = path.join(root, "config", "plugin", "messaging", "config.json");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { messaging: { configPath } }
  };
  const handler = createAdminHandler(context);

  const configResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/messaging/config", {}), configResponse);
  const configBody = JSON.parse(configResponse.body);

  assert.equal(configResponse.statusCode, 200);
  assert.equal(typeof configBody.configValue, "object");
});

test("admin plugin config exposes messaging config schema", async () => {
  const root = makeTempDir("admin-messaging-plugin-schema");
  const configPath = path.join(root, "config", "plugin", "messaging", "config.json");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { messaging: { configPath } }
  });

  const configResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/messaging/config", {}), configResponse);
  const configBody = JSON.parse(configResponse.body);

  assert.ok(Array.isArray(configBody.configSchema.fields));
});

test("admin plugin config patch returns messaging config values", async () => {
  const root = makeTempDir("admin-messaging-plugin-patch");
  const configPath = path.join(root, "config", "plugin", "messaging", "config.json");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { messaging: { configPath } }
  });

  const patchResponse = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/messaging/config", {
    splitMultilineSendChat: false,
    limitConsecutiveSends: false,
    feishuTypingEmojiEnabled: false
  }), patchResponse);
  const patchBody = JSON.parse(patchResponse.body);

  assert.equal(patchResponse.statusCode, 200);
  assert.deepEqual(patchBody.configValue, {
    splitMultilineSendChat: false,
    limitConsecutiveSends: false,
    feishuTypingEmojiEnabled: false,
    mapMarkdownLikeToMarkdown: false
  });
});

test("admin plugin config patch persists messaging config", async () => {
  const root = makeTempDir("admin-messaging-plugin-save");
  const configPath = path.join(root, "config", "plugin", "messaging", "config.json");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { messaging: { configPath } }
  });

  const patchResponse = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/messaging/config", {
    splitMultilineSendChat: false,
    limitConsecutiveSends: false,
    feishuTypingEmojiEnabled: false
  }), patchResponse);

  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
    splitMultilineSendChat: false,
    limitConsecutiveSends: false,
    feishuTypingEmojiEnabled: false,
    mapMarkdownLikeToMarkdown: false
  });
});

test("admin plugin list exposes bash sandbox config card state", async () => {
  const root = makeTempDir("admin-bash-sandbox-plugin");
  const envPath = path.join(root, ".env");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { bashSandbox: { envPath } }
  };
  const handler = createAdminHandler(context);

  const listResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins", {}), listResponse);
  const listBody = JSON.parse(listResponse.body);
  const plugin = listBody.plugins.find((entry: { id: string }) => entry.id === "bash_sandbox");

  assert.equal(plugin.status, "enabled");
  assert.equal(plugin.kind, "tool");
  assert.equal(plugin.configurable, true);
  assert.equal(plugin.switchable, false);
  assert.equal(plugin.configSource, envPath);
});

test("admin plugin config exposes bash sandbox env settings", async () => {
  const root = makeTempDir("admin-bash-sandbox-plugin-schema");
  const envPath = path.join(root, ".env");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { bashSandbox: { envPath } }
  });

  const configResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/bash_sandbox/config", {}), configResponse);
  const configBody = JSON.parse(configResponse.body);

  assert.equal(configResponse.statusCode, 200);
  assert.equal(typeof configBody.configValue, "object");
  assert.ok(Array.isArray(configBody.configSchema.fields));
});

test("admin plugin config never exposes pi worker tokens", async () => {
  const root = makeTempDir("admin-bash-sandbox-plugin-redact");
  const envPath = path.join(root, ".env");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const base = baseContext(root, memoryStore, promptStore);
  base.config.bashSandbox.network = "configured";
  base.config.bashSandbox.piWorker = {
    enabled: true,
    hostDir: path.join(root, "pi-sessions"),
    containerDir: "/alice/.agent/pi-sessions",
    port: 8790,
    workerToken: "secret-worker-token",
    sandboxCwd: "/alice",
    maxConcurrency: 2,
    maxQueueSize: 20,
    taskTimeoutSeconds: 900,
    timezone: "Asia/Singapore"
  };
  const handler = createAdminHandler({
    ...base,
    pluginConfigs: { bashSandbox: { envPath } }
  });

  const configResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/bash_sandbox/config", {}), configResponse);
  const configBody = JSON.parse(configResponse.body);
  assert.equal(configResponse.statusCode, 200);
  assert.equal(configBody.configValue.piWorker.port, 8790);
  assert.equal(configBody.configValue.piWorker.relayUrl, undefined);
  assert.equal(configBody.configValue.piWorker.workerToken, undefined);

  const patchResponse = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/bash_sandbox/config", { image: "node:22-bookworm" }), patchResponse);
  const patchBody = JSON.parse(patchResponse.body);
  assert.equal(patchResponse.statusCode, 200);
  assert.equal(patchBody.configValue.piWorker.relayUrl, undefined);
  assert.equal(patchBody.configValue.piWorker.workerToken, undefined);
});

test("admin plugin config patch returns bash sandbox restart requirement", async () => {
  const { patchResponse, patchBody } = await patchBashSandboxConfig();

  assert.equal(patchResponse.statusCode, 200);
  assert.equal(patchBody.restartRequired, true);
});

test("admin plugin config patch does not mutate active bash sandbox runtime config", async () => {
  const { patchResponse, context } = await patchBashSandboxConfig();

  assert.equal(patchResponse.statusCode, 200);
  assert.equal(context.config.bashSandbox.network, "none");
});

async function patchBashSandboxConfig() {
  const root = makeTempDir("admin-bash-sandbox-plugin-patch");
  const envPath = path.join(root, ".env");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const base = baseContext(root, memoryStore, promptStore);
  const context = {
    ...base,
    pluginConfigs: { bashSandbox: { envPath } }
  };
  const handler = createAdminHandler(context);

  const patchResponse = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/bash_sandbox/config", {
    network: "configured",
    image: "node:22-bookworm",
    timeoutMs: 120_000,
    outputLimitBytes: 262_144,
    pidsLimit: "",
    mounts: JSON.stringify([{ id: "data", hostPath: path.join(root, "data"), containerPath: "/mnt/data", readOnly: true }])
  }), patchResponse);
  const patchBody = JSON.parse(patchResponse.body);

  return { patchResponse, patchBody, context };
}

test("admin plugin config patch persists bash sandbox env settings", async () => {
  const root = makeTempDir("admin-bash-sandbox-plugin-save");
  const envPath = path.join(root, ".env");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { bashSandbox: { envPath } }
  });

  const patchResponse = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/bash_sandbox/config", {
    network: "configured",
    image: "node:22-bookworm",
    pidsLimit: ""
  }), patchResponse);
  const saved = fs.readFileSync(envPath, "utf8");

  assert.match(saved, /^BASH_SANDBOX_NETWORK=configured$/m);
  assert.match(saved, /^BASH_SANDBOX_IMAGE=node:22-bookworm$/m);
  assert.doesNotMatch(saved, /^BASH_SANDBOX_PIDS_LIMIT=/m);
});

test("admin plugin config reads persisted bash sandbox env settings", async () => {
  const root = makeTempDir("admin-bash-sandbox-plugin-read-save");
  const envPath = path.join(root, ".env");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { bashSandbox: { envPath } }
  });

  const patchResponse = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/bash_sandbox/config", {
    network: "configured",
    image: "node:22-bookworm"
  }), patchResponse);

  const savedConfigResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/bash_sandbox/config", {}), savedConfigResponse);
  const savedConfigBody = JSON.parse(savedConfigResponse.body);
  assert.equal(savedConfigBody.configValue.network, "configured");
  assert.equal(savedConfigBody.configValue.image, "node:22-bookworm");
});

test("admin plugin list exposes world wanderer config card state", async () => {
  const root = makeTempDir("admin-world-wanderer-plugin");
  const configPath = path.join(root, "config", "plugin", "world-wanderer", "config.json");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { worldWanderer: { configPath } }
  };
  const handler = createAdminHandler(context);

  const listResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins", {}), listResponse);
  const listBody = JSON.parse(listResponse.body);
  const plugin = listBody.plugins.find((entry: { id: string }) => entry.id === "world_wanderer");

  assert.equal(listResponse.statusCode, 200);
  assert.equal(plugin.status, "disabled");
  assert.equal(plugin.kind, "context");
  assert.equal(plugin.configurable, true);
  assert.equal(plugin.switchable, true);
});

test("admin plugin config exposes world wanderer config values", async () => {
  const root = makeTempDir("admin-world-wanderer-plugin-values");
  const configPath = path.join(root, "config", "plugin", "world-wanderer", "config.json");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { worldWanderer: { configPath } }
  });

  const configResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/world_wanderer/config", {}), configResponse);
  const configBody = JSON.parse(configResponse.body);

  assert.equal(configResponse.statusCode, 200);
  assert.equal(typeof configBody.configValue, "object");
  assert.equal(typeof configBody.runtimeState, "object");
});

test("admin plugin config exposes world wanderer values without creating sqlite storage", async () => {
  const root = makeTempDir("admin-world-wanderer-plugin-values-no-sqlite");
  const configPath = path.join(root, "config", "plugin", "world-wanderer", "config.json");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { worldWanderer: { configPath } }
  });

  const configResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/world_wanderer/config", {}), configResponse);

  assert.equal(configResponse.statusCode, 200);
  assert.equal(fs.existsSync(path.join(root, "alice.sqlite")), false);
});

test("admin plugin config exposes world wanderer config schema", async () => {
  const root = makeTempDir("admin-world-wanderer-plugin-schema");
  const configPath = path.join(root, "config", "plugin", "world-wanderer", "config.json");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { worldWanderer: { configPath } }
  });

  const configResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/world_wanderer/config", {}), configResponse);
  const configBody = JSON.parse(configResponse.body);

  assert.ok(Array.isArray(configBody.configSchema.fields));
});

test("admin plugin config patch persists world wanderer config", async () => {
  const root = makeTempDir("admin-world-wanderer-plugin-save");
  const configPath = path.join(root, "config", "plugin", "world-wanderer", "config.json");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { worldWanderer: { configPath } }
  });

  const patchResponse = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/world_wanderer/config", {
    enabled: true,
    speedMetersPerSecond: 1.2,
    recentHistoryLimit: 50,
    maxPanosPerIdle: 6,
    noveltyWeight: 7,
    forwardWeight: 3,
    roadContinuityWeight: 2,
    uturnPenalty: 5,
    loopPenalty: 11,
    selectionTemperature: 0.8,
    libraryPrompt: "街景图书馆",
    mapsJavaScriptApiKey: "browser-map-key",
    initialLocation: JSON.stringify({ lat: 41.01, lng: 28.99 }),
    initialHeading: 120
  }), patchResponse);

  assert.equal(patchResponse.statusCode, 200);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(saved.enabled, true);
  assert.equal(saved.speedMetersPerSecond, 1.2);
  assert.equal(saved.recentHistoryLimit, 50);
  assert.equal(saved.maxPanosPerIdle, 6);
  assert.equal(saved.noveltyWeight, 7);
  assert.equal(saved.forwardWeight, 3);
  assert.equal(saved.roadContinuityWeight, 2);
  assert.equal(saved.uturnPenalty, 5);
  assert.equal(saved.loopPenalty, 11);
  assert.equal(saved.selectionTemperature, 0.8);
  assert.equal(saved.libraryPrompt, "街景图书馆");
  assert.equal(saved.mapsJavaScriptApiKey, "browser-map-key");
  assert.deepEqual(saved.initialLocation, { lat: 41.01, lng: 28.99 });
  assert.equal("headingJitterDegrees" in saved, false);
});

test("admin Pi plugin validates preset and exposes the final prompt preview", async () => {
  const root = makeTempDir("admin-pi-plugin");
  const configPath = path.join(root, "config", "plugin", "pi-worker", "config.json");
  writePreset(root, "pi-preset");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ llmPresetName: "pi-preset" })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const base = baseContext(root, memoryStore, promptStore);
  const context = {
    ...base,
    pluginConfigs: { piWorker: { configPath } },
    piWorker: {
      runtime: {
        async previewPrompt() {
          return { sessionId: "preview-1", systemPrompt: "final system prompt" };
        },
        async health() {
          return { ready: true };
        }
      }
    }
  };
  const handler = createAdminHandler(context);

  const configResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/pi_worker/config", {}), configResponse);
  const configBody = JSON.parse(configResponse.body);
  assert.equal(configResponse.statusCode, 200);
  assert.equal(configBody.configValue.llmPresetName, "pi-preset");
  assert.ok(configBody.configSchema.fields.some((field: { key: string; options?: Array<{ value: string }> }) => field.key === "llmPresetName" && field.options?.some((option) => option.value === "pi-preset")));

  const previewResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/pi_worker/preview", {}), previewResponse);
  assert.deepEqual(JSON.parse(previewResponse.body), { ok: true, sessionId: "preview-1", systemPrompt: "final system prompt" });

  await assertPatchError(handler, "/admin/api/plugins/pi_worker/config", { llmPresetName: "missing" }, "pi_llm_preset_not_found");
});

test("admin Pi plugin saves project presets with project extra params", async () => {
  const root = makeTempDir("admin-pi-project-preset");
  const configPath = path.join(root, "config", "plugin", "pi-worker", "config.json");
  writePreset(root, "pi-preset");
  const presetPath = path.join(root, "config", "llm-api-presets.json");
  const presetFile = JSON.parse(fs.readFileSync(presetPath, "utf8"));
  presetFile.presets[0].extraParams = {
    stream_options: { include_usage: true },
    tool_choice: "auto",
    project_specific_parameter: "preserve"
  };
  presetFile.presets[0].followupExtraParams = { reasoning_effort: "high" };
  fs.writeFileSync(presetPath, `${JSON.stringify(presetFile)}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  let previewPresetName = "";
  let restartReason = "";
  const base = baseContext(root, memoryStore, promptStore);
  const context = {
    ...base,
    pluginConfigs: { piWorker: { configPath } },
    piWorker: {
      runtime: {
        async previewPrompt(input: { presetName: string }) {
          previewPresetName = input.presetName;
          return { sessionId: "preview-1", systemPrompt: "final system prompt" };
        },
        async health() {
          return { ready: true };
        },
        async restart(reason: "mount_changed" | "admin" | "wake" | "config") {
          restartReason = reason;
        }
      }
    }
  };
  const handler = createAdminHandler(context);

  const patchResponse = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/pi_worker/config", { llmPresetName: "pi-preset" }), patchResponse);
  assert.equal(patchResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(patchResponse.body), {
    ok: true,
    restartRequired: false,
    plugin: JSON.parse(patchResponse.body).plugin,
    configValue: JSON.parse(patchResponse.body).configValue
  });
  assert.equal(restartReason, "config");
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).llmPresetName, "pi-preset");

  const previewResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/pi_worker/preview", {}), previewResponse);
  assert.deepEqual(JSON.parse(previewResponse.body), { ok: true, sessionId: "preview-1", systemPrompt: "final system prompt" });
  assert.equal(previewPresetName, "pi-preset");
});

test("prompt variables use empty world wanderer library prompt without fallback", async () => {
  const root = makeTempDir("admin-world-wanderer-library-variable");
  const configPath = path.join(root, "config", "plugin", "world-wanderer", "config.json");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    coreProfileStore: { get: () => ({ appearanceDescription: "", librarySetting: "core library" }) },
    pluginConfigs: { worldWanderer: { configPath } }
  };
  const handler = createAdminHandler(context);

  let response = createResponse();
  await handler(createRequest("GET", "/admin/api/prompt-profile", {}), response);
  assert.equal(JSON.parse(response.body).variables.library.content, "core library");

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled: true, libraryPrompt: "" }, null, 2)}\n`);

  response = createResponse();
  await handler(createRequest("GET", "/admin/api/prompt-profile", {}), response);
  assert.equal(JSON.parse(response.body).variables.library.content, "");
});

test("admin plugin config exposes Google Street View radius schema", async () => {
  const root = makeTempDir("admin-google-streetview-plugin-config");
  const configPath = path.join(root, "config", "plugin", "google-streetview", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    apiKey: "",
    imageSize: "640x640",
    heading: 0,
    pitch: 0,
    fov: 90,
    initialRadiusMeters: 50,
    radiusExpansionFactor: 2,
    maxRadiusMeters: 1000,
    randomAttempts: 8,
    coordinatePrecision: 5,
    outputDir: "assets/plugin/google-streetview",
    regions: []
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { googleStreetView: { configPath } }
  };
  const handler = createAdminHandler(context);

  const configResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/google_streetview/config", {}), configResponse);
  const configBody = JSON.parse(configResponse.body);
  assert.equal(configResponse.statusCode, 200);
  assert.ok(Array.isArray(configBody.configSchema.fields));
});

test("admin plugin config patch stores Google Street View api key", async () => {
  const root = makeTempDir("admin-google-streetview-plugin-config-key");
  const configPath = path.join(root, "config", "plugin", "google-streetview", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    apiKey: "",
    imageSize: "640x640",
    heading: 0,
    pitch: 0,
    fov: 90,
    initialRadiusMeters: 50,
    radiusExpansionFactor: 2,
    maxRadiusMeters: 1000,
    randomAttempts: 8,
    coordinatePrecision: 5,
    outputDir: "assets/plugin/google-streetview",
    regions: []
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { googleStreetView: { configPath } }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/google_streetview/config", {
    enabled: true,
    apiKey: "google-secret",
    imageSize: "640x640",
    heading: 0,
    pitch: 0,
    fov: 90,
    initialRadiusMeters: 50,
    radiusExpansionFactor: 2,
    maxRadiusMeters: 1000,
    randomAttempts: 8,
    coordinatePrecision: 5,
    outputDir: "assets/plugin/google-streetview",
    regions: "[]"
  }), response);

  assert.equal(response.statusCode, 200);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(saved.apiKey, "google-secret");
});

test("admin plugin config patch hides Google Street View api key", async () => {
  const root = makeTempDir("admin-google-streetview-plugin-config-hide-key");
  const configPath = path.join(root, "config", "plugin", "google-streetview", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled: true, apiKey: "" })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { googleStreetView: { configPath } }
  });

  const response = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/google_streetview/config", {
    apiKey: "google-secret"
  }), response);
  const body = JSON.parse(response.body);

  assert.equal(body.configValue.apiKeySet, true);
  assert.equal(body.configValue.apiKey, undefined);
});

test("admin plugin config patch preserves Google Street View api key when blank", async () => {
  const root = makeTempDir("admin-google-streetview-plugin-config-preserve-key");
  const configPath = path.join(root, "config", "plugin", "google-streetview", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled: true, apiKey: "google-secret" })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { googleStreetView: { configPath } }
  });

  const preserveResponse = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/google_streetview/config", {
    apiKey: ""
  }), preserveResponse);

  assert.equal(preserveResponse.statusCode, 200);
  const preserved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(preserved.apiKey, "google-secret");
});
