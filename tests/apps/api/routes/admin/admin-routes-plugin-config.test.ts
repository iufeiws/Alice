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

test("admin plugin list exposes tts config card state", async () => {
  const root = makeTempDir("admin-plugin-list");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
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

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins", {}), response);
  const body = JSON.parse(response.body);
  const tts = body.plugins.find((plugin: { id: string }) => plugin.id === "tts");

  assert.equal(response.statusCode, 200);
  assert.equal(body.plugins.some((plugin: { id: string }) => plugin.id === "feishu"), false);
  assert.equal(tts.status, "enabled");
  assert.equal(tts.health, "healthy");
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
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

test("admin plugin config exposes and writes messaging config", async () => {
  const root = makeTempDir("admin-messaging-plugin");
  const configPath = path.join(root, "config", "plugin", "messaging", "config.json");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { messaging: { configPath } }
  };
  const handler = createAdminHandler(context);

  const configResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/messaging/config", {}), configResponse);
  const configBody = JSON.parse(configResponse.body);

  assert.equal(configResponse.statusCode, 200);
  assert.equal(configBody.configValue.splitMultilineSendChat, true);
  assert.equal(configBody.configValue.limitConsecutiveSends, true);
  assert.equal(configBody.configValue.feishuTypingEmojiEnabled, true);
  assert.match(JSON.stringify(configBody.configSchema), /splitMultilineSendChat/);
  assert.deepEqual(configBody.configSchema.groups, [
    { key: "general", label: "General" },
    { key: "feishu", label: "Feishu" }
  ]);
  assert.match(JSON.stringify(configBody.configSchema), /feishuTypingEmojiEnabled/);

  const patchResponse = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/messaging/config", {
    splitMultilineSendChat: false,
    limitConsecutiveSends: false,
    feishuTypingEmojiEnabled: false
  }), patchResponse);
  const patchBody = JSON.parse(patchResponse.body);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(patchResponse.statusCode, 200);
  assert.deepEqual(patchBody.configValue, {
    splitMultilineSendChat: false,
    limitConsecutiveSends: false,
    feishuTypingEmojiEnabled: false
  });
  assert.deepEqual(saved, patchBody.configValue);
});

test("admin plugin config exposes and writes bash sandbox env settings for restart", async () => {
  const root = makeTempDir("admin-bash-sandbox-plugin");
  const envPath = path.join(root, ".env");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
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

  const configResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/bash_sandbox/config", {}), configResponse);
  const configBody = JSON.parse(configResponse.body);

  assert.equal(configResponse.statusCode, 200);
  assert.equal(configBody.configValue.network, "none");
  assert.ok(configBody.configSchema.fields.some((field: { key: string }) => field.key === "mounts"));

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
  const saved = fs.readFileSync(envPath, "utf8");

  assert.equal(patchResponse.statusCode, 200);
  assert.equal(patchBody.restartRequired, true);
  assert.equal(patchBody.configValue.network, "configured");
  assert.equal(patchBody.configValue.image, "node:22-bookworm");
  assert.equal(context.config.bashSandbox.network, "none");
  assert.match(saved, /^BASH_SANDBOX_NETWORK=configured$/m);
  assert.match(saved, /^BASH_SANDBOX_IMAGE=node:22-bookworm$/m);
  assert.doesNotMatch(saved, /^BASH_SANDBOX_PIDS_LIMIT=/m);

  const savedConfigResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/bash_sandbox/config", {}), savedConfigResponse);
  const savedConfigBody = JSON.parse(savedConfigResponse.body);
  assert.equal(savedConfigBody.configValue.network, "configured");
  assert.equal(savedConfigBody.configValue.image, "node:22-bookworm");
});

test("admin plugin config exposes and writes world wanderer config", async () => {
  const root = makeTempDir("admin-world-wanderer-plugin");
  const configPath = path.join(root, "config", "plugin", "world-wanderer", "config.json");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
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

  const configResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/world_wanderer/config", {}), configResponse);
  const configBody = JSON.parse(configResponse.body);

  assert.equal(configResponse.statusCode, 200);
  assert.equal(configBody.configValue.enabled, false);
  assert.deepEqual(configBody.configValue.initialLocation, { lat: 41.0086, lng: 28.9802 });
  assert.equal(configBody.configValue.libraryPrompt, "");
  assert.equal(configBody.configValue.mapsJavaScriptApiKey, "");
  assert.deepEqual(configBody.runtimeState.pathStack, []);
  assert.equal(fs.existsSync(path.join(root, "alice.sqlite")), false);
  assert.ok(configBody.configSchema.fields.some((field: { key: string }) => field.key === "libraryPrompt"));
  assert.ok(configBody.configSchema.fields.some((field: { key: string }) => field.key === "mapsJavaScriptApiKey"));
  assert.ok(configBody.configSchema.fields.some((field: { key: string }) => field.key === "maxPanosPerIdle"));
  assert.ok(configBody.configSchema.fields.some((field: { key: string }) => field.key === "selectionTemperature"));
  assert.equal(configBody.configSchema.fields.some((field: { key: string }) => field.key === "headingJitterDegrees"), false);

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

test("prompt variables use empty world wanderer library prompt without fallback", async () => {
  const root = makeTempDir("admin-world-wanderer-library-variable");
  const configPath = path.join(root, "config", "plugin", "world-wanderer", "config.json");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
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

test("admin plugin config patch stores Google Street View api key", async () => {
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { googleStreetView: { configPath } }
  };
  const handler = createAdminHandler(context);

  const configResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/google_streetview/config", {}), configResponse);
  const configBody = JSON.parse(configResponse.body);
  const radiusField = configBody.configSchema.fields.find((field: { key: string }) => field.key === "radiusExpansionFactor");
  assert.equal(configResponse.statusCode, 200);
  assert.equal(radiusField.step, 0.01);

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
  const body = JSON.parse(response.body);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(body.ok, true);
  assert.equal(body.configValue.apiKeySet, true);
  assert.equal(body.configValue.apiKey, undefined);
  assert.equal(saved.apiKey, "google-secret");

  const preserveResponse = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/google_streetview/config", {
    apiKey: ""
  }), preserveResponse);

  assert.equal(preserveResponse.statusCode, 200);
  const preserved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(preserved.apiKey, "google-secret");
});
