import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createApiRequestHandler } from "../src/apps/api/routes/admin-routes.js";
import { createAdminRouteServices } from "../src/apps/api/bootstrap/admin-api-service.js";
import {
  createMarkdownMemoryStore,
  createMemoryInductionPromptStore,
  runMemoryInductionForMessages
} from "../src/contexts/memory/src/memory.js";
import { promptStoragePath } from "../src/contexts/agent-profile/src/adapters/json-prompt-profile-store.js";
import { createPromptProfileStore } from "../src/contexts/agent-profile/src/application/build-system-prompt.js";
import type { LLMChatInput, LLMClient } from "../src/contexts/llm-gateway/src/index.js";
import { createDiaryStore } from "../src/platform/storage/src/diary-store.js";
import { createCalendarStore } from "../src/platform/storage/src/calendar-store.js";
import type { StoredConversationMessage } from "../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";

const fs = await import("node:fs");
const path = await import("node:path");
const childProcess = await import("node:child_process");

function createAdminHandler(context: any) {
  return createApiRequestHandler({ services: createAdminRouteServices(context) });
}

async function assertPatchError(handler: ReturnType<typeof createAdminHandler>, url: string, body: Record<string, unknown>, error: string) {
  const response = createResponse();
  await handler(createRequest("PATCH", url, body), response);
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, error);
}

test("voice call app page renders outside the plugin page", async () => {
  const root = makeTempDir("voice-call-page");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const handler = createAdminHandler(baseContext(root, memoryStore, promptStore));

  const response = createResponse();
  await handler(createRequest("GET", "/voice-call", {}), response);

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Alice Voice Call/);
  assert.match(response.body, /class="voice-call-app"/);
  assert.match(response.body, /\/voice-call\/api\/config/);
  assert.match(response.body, /\/voice-call\/api\/signaling/);
  assert.match(response.body, /\/voice-call\/assets\/alice-default-portrait\.png/);
  assert.match(response.body, /addTransceiver\("audio", \{ direction: "recvonly" \}\)/);
  assert.match(response.body, /text\.length <= 1/);
  assert.match(response.body, /sendSignal\(\{ type: "interrupt", reason: "manual" \}\)/);
  assert.doesNotMatch(response.body, /realtime_voice/);
  assert.match(response.body, /navigator\.mediaDevices\.getUserMedia/);
  assert.doesNotMatch(response.body, /addTrack\(track/);
  assert.doesNotMatch(response.body, /startSpeechStateLoop/);
});

test("voice call app config defines frontend and signaling routes", async () => {
  const root = makeTempDir("voice-call-config");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const handler = createAdminHandler(baseContext(root, memoryStore, promptStore));

  const response = createResponse();
  await handler(createRequest("GET", "/voice-call/api/config", {}), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.routes.page, "/voice-call");
  assert.equal(body.routes.config, "/voice-call/api/config");
  assert.equal(body.routes.signaling, "/voice-call/api/signaling");
  assert.equal(body.ui.portraitUrl, "/voice-call/assets/alice-default-portrait.png");
});

test("llm api preset save stores extra params as part of the preset", async () => {
  const root = makeTempDir("admin-llm-preset-extra");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const context = baseContext(root, memoryStore, promptStore);
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("PUT", "/admin/api/config/llm-presets", {
    name: "Chat Custom",
    baseURL: "https://chat.example.test/v1",
    model: "chat-custom",
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
    name: "Chat Custom",
    baseURL: "https://chat.example.test/v1",
    model: "chat-custom",
    temperature: 0.4,
    timeoutMs: 90_000,
    stream: true,
    supportsImage: false,
    supportsAudio: false,
    extraParams: { top_p: 0.7, stream_options: { include_usage: true } },
    followupExtraParams: { top_p: 0.2 }
  });
});

test("llm api preset save accepts long timeout values", async () => {
  const root = makeTempDir("admin-llm-preset-timeout");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const handler = createAdminHandler(baseContext(root, memoryStore, promptStore));

  const response = createResponse();
  await handler(createRequest("PUT", "/admin/api/config/llm-presets", {
    name: "Long Timeout",
    baseURL: "https://chat.example.test/v1",
    model: "chat-custom",
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

test("admin birthday save writes a birthday calendar entry", async () => {
  const root = makeTempDir("admin-birthday");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    calendarStore: createCalendarStore(path.join(root, "alice.sqlite"))
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("PUT", "/admin/api/calendar/birthday", {
    calendarSystem: "lunar",
    month: 6,
    day: 1,
    year: 2025,
    isLeapMonth: true
  }), response);

  assert.equal(response.statusCode, 200);
  const birthday = context.calendarStore.latestBirthday();
  assert.equal(birthday?.kind, "birthday");
  assert.equal(birthday?.calendarSystem, "lunar");
  assert.equal(birthday?.isLeapMonth, true);
});

test("prompt api profile saves chat binding and migrates legacy core binding", async () => {
  const root = makeTempDir("admin-prompt-api-profile-chat");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "llm-api-presets.json"), `${JSON.stringify({
    presets: [
      {
        name: "Chat Custom",
        baseURL: "https://chat.example.test/v1",
        model: "chat-custom",
        temperature: 0.4,
        timeoutMs: 90_000,
        stream: true,
        extraParams: {},
        followupExtraParams: {}
      },
      {
        name: "Talk Custom",
        baseURL: "https://talk.example.test/v1",
        model: "talk-custom",
        temperature: 0.3,
        timeoutMs: 90_000,
        stream: true,
        extraParams: {},
        followupExtraParams: {}
      },
      {
        name: "Memorize Custom",
        baseURL: "https://memorize.example.test/v1",
        model: "memorize-custom",
        temperature: 0.5,
        timeoutMs: 90_000,
        stream: false,
        extraParams: {},
        followupExtraParams: {}
      }
    ]
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const handler = createAdminHandler(baseContext(root, memoryStore, promptStore));

  const response = createResponse();
  await handler(createRequest("PUT", "/admin/api/prompt-api-profile", {
    corePresetName: "Chat Custom",
    talkPresetName: "Talk Custom",
    memorizePresetName: "Memorize Custom"
  }), response);
  const body = JSON.parse(response.body);
  const saved = JSON.parse(fs.readFileSync(promptStoragePath(root, "prompt-api-profile.json", ["config", "prompt-api-profile.json"]), "utf8"));

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(saved, {
    chatPresetName: "Chat Custom",
    talkPresetName: "Talk Custom",
    memorizePresetName: "Memorize Custom"
  });
});

test("talk prompt profile saves independently from chat prompt profile", async () => {
  const root = makeTempDir("admin-talk-prompt-profile");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const context = baseContext(root, memoryStore, promptStore);
  context.promptProfileStore = createPromptProfileStore(path.join(root, "chat-prompt-profile.json"));
  context.talkPromptProfileStore = createPromptProfileStore(path.join(root, "talk-prompt-profile.json"));
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("PUT", "/admin/api/talk-prompt-profile", {
    userName: "talk-user",
    visibleTools: {},
    layers: [{ id: "talk-role", role: "system", enabled: true, order: 10, content: "talk" }]
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(context.talkPromptProfileStore.get().userName, "talk-user");
  assert.equal(context.talkPromptProfileStore.get().layers[0]?.id, "talk-role");
  assert.notEqual(context.promptProfileStore.get().userName, "talk-user");
});

test("agent state admin route exposes and accepts calling state", async () => {
  const root = makeTempDir("admin-agent-state-calling");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  let currentState = "calling";
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    agentState: {
      getSnapshot: () => ({ state: currentState, intimacy: 50 }),
      setState(state: string) {
        currentState = state;
        return { state: currentState, intimacy: 50 };
      },
      setIntimacy(intimacy: number) {
        return { state: currentState, intimacy };
      }
    }
  });

  const getResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/agent-state", {}), getResponse);
  const getBody = JSON.parse(getResponse.body);

  assert.equal(getResponse.statusCode, 200);
  assert.equal(getBody.state.state, "calling");
  assert.ok(getBody.states.includes("calling"));

  const putResponse = createResponse();
  await handler(createRequest("PUT", "/admin/api/agent-state", { state: "calling" }), putResponse);
  const putBody = JSON.parse(putResponse.body);

  assert.equal(putResponse.statusCode, 200);
  assert.equal(currentState, "calling");
  assert.equal(putBody.state.state, "calling");
  assert.ok(putBody.states.includes("calling"));
});

test("admin messaging runtime rejects missing Feishu target", async () => {
  const root = makeTempDir("admin-messaging-missing-target");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const handler = createAdminHandler(baseContext(root, memoryStore, promptStore));

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/tools/messaging/view", {}), response);

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "missing_feishu_target");
});

test("admin shell runtime exposes shell config", async () => {
  const root = makeTempDir("admin-shell-config");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const handler = createAdminHandler(baseContext(root, memoryStore, promptStore));

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/shell", {}), response);

  assert.equal(response.statusCode, 200);
  assert.ok("todayVariables" in JSON.parse(response.body));
});

test("admin tts runtime rejects missing preview text", async () => {
  const root = makeTempDir("admin-tts-preview-missing-text");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const handler = createAdminHandler(baseContext(root, memoryStore, promptStore));

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/tts/generate", {}), response);

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "text_required");
});

test("initiated behavior config patch preserves tool request prompt layers", async () => {
  const root = makeTempDir("admin-initiated-behavior-tool-layer");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const context = baseContext(root, memoryStore, promptStore);
  let receivedPatch: unknown;
  context.setAgentInitiatedBehaviorConfig = (_id: string, patch: unknown) => {
    receivedPatch = patch;
    return {
      id: "sleep_morning",
      kind: "event",
      enabled: true,
      triggerEvent: "sleep_cocoon.wake",
      steps: []
    };
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("PATCH", "/admin/api/initiated-behaviors/sleep_morning", {
    promptProfile: {
      layers: [{
        id: "fake_check",
        title: "Fake Check",
        role: "tool_request",
        enabled: true,
        content: "",
        order: 10,
        thinking: "check first",
        toolCalls: [{
          toolName: "check_chat",
          toolCallId: "call_check",
          toolArguments: "{\"target\":\"dm\"}"
        }]
      }]
    }
  }), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(receivedPatch, {
    promptProfile: {
      layers: [{
        id: "fake_check",
        title: "Fake Check",
        role: "tool_request",
        enabled: true,
        content: "",
        order: 10,
        thinking: "check first",
        toolCalls: [{
          toolName: "check_chat",
          toolCallId: "call_check",
          toolArguments: "{\"target\":\"dm\"}"
        }]
      }]
    }
  });
});

test("initiated behavior config patch rejects system prompt layers", async () => {
  const root = makeTempDir("admin-initiated-behavior-system-layer");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const context = baseContext(root, memoryStore, promptStore);
  context.setAgentInitiatedBehaviorConfig = () => {
    throw new Error("system layer should not reach setter");
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("PATCH", "/admin/api/initiated-behaviors/sleep_morning", {
    promptProfile: {
      layers: [{
        id: "bad",
        title: "Bad",
        role: "system",
        enabled: true,
        content: "break prefix",
        order: 10
      }]
    }
  }), response);

  assert.equal(response.statusCode, 400);
  assert.match(response.body, /invalid_initiated_behavior_prompt_layer_role/);
});

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

test("admin plugin config patch writes photo selfie mode without storing api key", async () => {
  const root = makeTempDir("admin-photo-plugin-config");
  const configPath = path.join(root, "config", "plugin", "photo", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    selfieMode: "openai"
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const base = baseContext(root, memoryStore, promptStore);
  const context = {
    ...base,
    config: {
      ...base.config,
      photo: {
        ...photoDefaults(),
        selfieImageApiKey: "secret-image-key",
        selfieImageApiRelayKey: "secret-relay-key"
      }
    },
    pluginConfigs: { photo: { configPath } }
  };
  const handler = createAdminHandler(context);

  const schemaResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/photo/config", {}), schemaResponse);
  const schemaBody = JSON.parse(schemaResponse.body);
  const modeField = schemaBody.configSchema.fields.find((field: { key: string }) => field.key === "selfieMode");
  const fieldGroups = new Map(schemaBody.configSchema.fields.map((field: { key: string; group: string }) => [field.key, field.group]));

  assert.equal(schemaResponse.statusCode, 200);
  assert.deepEqual(modeField.options.map((option: { value: string }) => option.value), ["openai", "openaiRelay", "codex"]);
  assert.deepEqual(schemaBody.configSchema.groups.map((group: { key: string }) => group.key), ["general", "openai", "openai_relay", "codex", "storage"]);
  assert.equal(fieldGroups.get("selfieImageApiKeySet"), "openai");
  assert.equal(fieldGroups.get("selfieImageApiKey"), "openai");
  assert.equal(fieldGroups.get("selfieImageApiBaseURL"), "openai");
  assert.equal(fieldGroups.get("selfieImageApiModel"), "openai");
  assert.equal(fieldGroups.get("selfieImageApiTimeoutMs"), "openai");
  assert.equal(fieldGroups.get("selfieImageApiRelayKeySet"), "openai_relay");
  assert.equal(fieldGroups.get("selfieImageApiRelayKey"), "openai_relay");
  assert.equal(fieldGroups.get("selfieImageApiRelayBaseURL"), "openai_relay");
  assert.equal(fieldGroups.get("selfieImageApiRelayModel"), "openai_relay");
  assert.equal(fieldGroups.get("selfieImageApiRelayTimeoutMs"), "openai_relay");
  assert.equal(schemaBody.configValue.selfieImageApiKeySet, true);
  assert.equal(schemaBody.configValue.selfieImageApiRelayKeySet, true);
  assert.equal(schemaBody.configValue.selfieImageApiKey, undefined);
  assert.equal(schemaBody.configValue.selfieImageApiRelayKey, undefined);

  const response = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/photo/config", {
    enabled: true,
    selfieMode: "openaiRelay",
    selfieCodexCommand: "codex",
    selfieCodexTimeoutMs: 240000,
    selfieOutputDir: "assets/generated/selfies",
    selfieReferenceDir: "assets/selfie/references",
    selfieImageApiKey: "new-openai-key",
    selfieImageApiBaseURL: "https://api.openai.com/v1",
    selfieImageApiRelayKey: "new-relay-key",
    selfieImageApiRelayBaseURL: "https://relay.example.test/v1",
    selfieImageApiModel: "gpt-image-2",
    selfieImageApiSize: "768x1024",
    selfieImageApiQuality: "low",
    selfieImageApiModeration: "low",
    selfieImageApiOutputFormat: "jpeg",
    selfieImageApiOutputCompression: 45,
    selfieImageApiTimeoutMs: 120000,
    selfieImageApiRelayModel: "relay-image-model",
    selfieImageApiRelaySize: "1024x1536",
    selfieImageApiRelayQuality: "medium",
    selfieImageApiRelayModeration: "auto",
    selfieImageApiRelayOutputFormat: "webp",
    selfieImageApiRelayOutputCompression: 77,
    selfieImageApiRelayTimeoutMs: 90000,
    selfieMaxBytes: 10 * 1024 * 1024
  }), response);
  const body = JSON.parse(response.body);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.configValue.selfieMode, "openaiRelay");
  assert.equal(body.configValue.selfieImageApiKeySet, true);
  assert.equal(body.configValue.selfieImageApiRelayKeySet, true);
  assert.equal(saved.selfieMode, "openaiRelay");
  assert.equal(saved.selfieCodexTimeoutMs, 240000);
  assert.equal(saved.selfieImageApiKey, "new-openai-key");
  assert.equal(saved.selfieImageApiRelayKey, "new-relay-key");
  assert.equal(saved.selfieImageApiRelayBaseURL, "https://relay.example.test/v1");
  assert.equal(saved.selfieImageApiModeration, "low");
  assert.equal(saved.selfieImageApiRelayModel, "relay-image-model");
  assert.equal(saved.selfieImageApiRelayOutputFormat, "webp");
  assert.equal(saved.selfieImageApiKeySet, undefined);
  assert.equal(saved.selfieImageApiRelayKeySet, undefined);
});

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

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.configValue.translationPresetName, "default");
  assert.deepEqual(body.configValue.remote, { enabled: false, baseURL: "http://10.0.0.8:8767", localFallbackEnabled: false });
  assert.equal(body.configValue.translationPresets.main.apiPresetName, "voice");
  assert.equal(body.configValue.voice.modelConfigs[modelConfigName].language, "zh");
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.remote, { enabled: false, baseURL: "http://10.0.0.8:8767", localFallbackEnabled: false });
  assert.equal(saved.conversion.genie.localFallbackEnabled, false);
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

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.configSchema.groups.map((group: { key: string }) => group.key), ["translation", "model_genie", "conversion_openai_api", "conversion_bailian", "general"]);
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

  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body).ok, true);
  assert.equal(firstSaved.conversion.bailian.apiKey, "dashscope-secret");

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

  assert.equal(second.statusCode, 200);
  assert.equal(JSON.parse(second.body).ok, true);
  assert.equal(secondSaved.conversion.bailian.apiKey, "dashscope-secret");
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

  assert.equal(response.statusCode, 200);
  assert.equal(saved.conversion.bailian.service, "cosy");
  assert.equal(saved.conversion.bailian.endpoint, "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer");
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

test("admin plugin config patch rejects invalid submitted values instead of falling back", async () => {
  const root = makeTempDir("admin-plugin-invalid-inputs");
  const photoConfigPath = path.join(root, "config", "plugin", "photo", "config.json");
  const asrConfigPath = path.join(root, "config", "plugin", "asr", "config.json");
  const worldConfigPath = path.join(root, "config", "plugin", "world-wanderer", "config.json");
  const ttsConfigPath = path.join(root, "config", "plugin", "tts", "config.json");
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
      tts: { configPath: ttsConfigPath }
    }
  });

  await assertPatchError(handler, "/admin/api/plugins/photo/config", { selfieMode: "bad" }, "invalid_selfie_mode");
  await assertPatchError(handler, "/admin/api/plugins/photo/config", { selfieCodexTimeoutMs: "abc" }, "invalid_selfie_codex_timeout");
  await assertPatchError(handler, "/admin/api/plugins/asr/config", { defaultProvider: "bad" }, "invalid_asr_provider");
  await assertPatchError(handler, "/admin/api/plugins/world_wanderer/config", { initialLocation: "[]" }, "invalid_initial_location");
  await assertPatchError(handler, "/admin/api/plugins/tts/config", { conversion: { bailian: { service: "bad" } } }, "invalid_bailian_service");
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
  assert.deepEqual(body.configSchema.groups.map((group: { key: string }) => group.key), ["general", "openai_compatible", "tencent"]);
  assert.equal(body.configSchema.fields.find((field: { key: string }) => field.key === "enabled").group, "general");
  assert.equal(body.configSchema.fields.find((field: { key: string }) => field.key === "providers.openaiCompatible.model"), undefined);
  assert.equal(body.configSchema.fields.find((field: { key: string }) => field.key === "providers.openaiCompatible.apiPresetName").group, "openai_compatible");
  assert.equal(body.configSchema.fields.find((field: { key: string }) => field.key === "providers.tencent.engineModelType").group, "tencent");
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

test("admin plugin model folder upload flattens files under plugin model root", async () => {
  const root = makeTempDir("admin-plugin-asset");
  const assetRoot = path.join(root, "assets");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled: false, apiPresetName: "voice", prompt: "Translate:" })}\n`);
  writePreset(root, "voice");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { tts: { configPath, assetRoot } }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  const fileName = `model-${path.basename(root)}.onnx`;
  await handler(createRawRequest("POST", "/admin/api/plugins/tts/assets/model", Buffer.from("model"), {
    "x-file-name": encodeURIComponent(fileName),
    "x-relative-dir": encodeURIComponent("uploaded-folder/nested")
  }), response);
  const body = JSON.parse(response.body);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const expectedAssetPath = `assets/tts/preset/jp/model/${fileName}`;

  assert.equal(response.statusCode, 200);
  assert.equal(body.assetPath, expectedAssetPath);
  assert.equal(saved.voice.modelConfigs.jp.modelDir, undefined);
  assert.equal(fs.readFileSync(path.join(assetRoot, "tts", "preset", "jp", "model", fileName), "utf8"), "model");
  assert.equal(fs.existsSync(path.join(assetRoot, "tts", "preset", "jp", "model", "uploaded-folder", "nested", fileName)), false);
});

test("admin plugin TTS reference audio upload converts to preset wav", async () => {
  const root = makeTempDir("admin-plugin-reference-audio");
  const assetRoot = path.join(root, "assets");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled: false, translationEnabled: false, apiPresetName: "voice" })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { tts: { configPath, assetRoot } }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRawRequest("POST", "/admin/api/plugins/tts/assets/reference-audio", makeTinyWavBuffer(), {
    "x-file-name": encodeURIComponent("voice-sample.mp3"),
    "x-preset-name": encodeURIComponent("jp")
  }), response);
  const body = JSON.parse(response.body);
  const referenceWavPath = path.join(assetRoot, "tts", "preset", "jp", "reference.wav");

  assert.equal(response.statusCode, 200);
  assert.equal(body.assetPath, "assets/tts/preset/jp/reference.wav");
  assert.equal(fs.existsSync(referenceWavPath), true);
  assert.equal(fs.existsSync(path.join(assetRoot, "tts", "preset", "jp", "reference.mp3")), false);
  assert.equal(fs.readFileSync(referenceWavPath).subarray(0, 4).toString("ascii"), "RIFF");
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

test("admin plugin test runs tts translation and tts with prompt variables and timing", async () => {
  const root = makeTempDir("admin-plugin-test");
  const assetRoot = path.join(root, "assets");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  const ttsOutputDir = "generated/tts";
  const voiceFileName = `voice-${path.basename(root)}.opus`;
  const voicePath = path.join(assetRoot, "generated", "tts", voiceFileName);
  let capturedGenie: unknown;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(voicePath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    translationPresetName: "main",
    translationPresets: {
      main: {
        translationEnabled: true,
        apiPresetName: "voice",
        prompt: "Translate for {{user}} at {{date}}:"
      }
    },
    voice: {
      modelConfigName: "zh-main",
      modelConfigs: {
        "zh-main": { language: "zh", splitText: false }
      }
    }
  })}\n`);
  writePreset(root, "voice");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const senderAgents: string[] = [];
  const systemPrompts: string[] = [];
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
        testVoiceSynthesizer: async ({ text, genie }: { text: string; genie?: unknown }) => {
          capturedGenie = genie;
          fs.writeFileSync(voicePath, `voice:${text}`);
          return { assetId: "generated/tts/voice.opus", filePath: voicePath };
        }
      }
    },
    llmRequestSender: async (input: any) => {
      senderAgents.push(input.agentId);
      systemPrompts.push(String(input.messages[0]?.content ?? ""));
      return { message: { role: "assistant", content: "また後で" } };
    }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/tts/test", { text: "晚点见" }), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.result.input, "晚点见");
  assert.equal(body.result.output, "また後で");
  assert.equal(body.result.voice.audioUrl, `/admin/assets/tts/${voiceFileName}`);
  assert.equal(typeof body.result.timing.translationMs, "number");
  assert.equal(typeof body.result.timing.ttsMs, "number");
  assert.equal(typeof body.result.timing.totalMs, "number");
  assert.deepEqual(senderAgents, ["tts"]);
  assert.deepEqual(systemPrompts, ["Translate for user at 2026-05-24:"]);
  assert.deepEqual(capturedGenie, { language: "zh", modelDir: "assets/tts/preset/zh-main/model", referenceAudio: undefined, referenceText: undefined, splitText: false });
  fs.rmSync(voicePath, { force: true });
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
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
  const handler = createAdminHandler({
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
  assert.equal(fs.existsSync(path.join(root, "src", "contexts", "agent-profile", "prompts", "prompt-api-profile.json")), true);
  assert.equal(fs.existsSync(path.join(root, "config", "prompt-api-profile.json")), false);
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  let capturedTarget = "";
  let capturedMessages: StoredConversationMessage[] = [];
  const handler = createAdminHandler({
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
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
  const handler = createAdminHandler({
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

test("memory admin manual run requires paused heartbeat or sleeping state by default", async () => {
  const root = makeTempDir("admin-memory-run-paused-or-sleep");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  let calls = 0;
  const handler = createAdminHandler({
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
  const body = JSON.parse(response.body);
  assert.equal(body.error, "memory_manual_run_requires_paused_or_sleeping");
  assert.deepEqual(body.gate, { allowed: false, agentState: "idle", heartbeatPaused: false });
  assert.equal(calls, 0);
});

test("memory admin manual run is allowed when heartbeat is paused", async () => {
  const root = makeTempDir("admin-memory-run-heartbeat-paused");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  let calls = 0;
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    agentState: { getSnapshot: () => ({ state: "idle" }), setState() {} },
    messageRuntime: { pauseHeartbeat() {}, resumeHeartbeat() {}, async processNow() {}, getStatus: () => ({ heartbeatPaused: true }) },
    store: {
      listMessagesByCreatedAtRange() {
        return [message("2026-05-24T01:00:00.000Z", "hello from selected day")];
      },
      listMessagesChronological() {
        return [];
      }
    },
    async runMemoryInductionForMessages(messages: StoredConversationMessage[], windowStartAt: string | undefined, windowEndAt: string) {
      calls += 1;
      return { ok: true, startedAt: "2026-05-24T06:00:00.000Z", windowStartAt, windowEndAt, messageCount: messages.length, results: [] };
    }
  });

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/run-day", { date: "2026-05-24", runId: "paused" }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).ok, true);
  assert.equal(calls, 1);
});

test("memory clear-session clears the console memorize session", async () => {
  const root = makeTempDir("admin-memory-clear-session");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  let cleared = false;
  const handler = createAdminHandler({
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const recorded: Array<{ occurredAt: string; source: string; now: string }> = [];
  const boundaries = [
    { occurredAt: "2026-05-31T03:46:02.806", source: "inferred_gap" }
  ];
  const handler = createAdminHandler({
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const handler = createAdminHandler(baseContext(root, memoryStore, promptStore));
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const handler = createAdminHandler({
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const diaryStore = createDiaryStore(path.join(root, "diary", "diary.sqlite"));
  const handler = createAdminHandler({
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
    coreProfileStore: { get: () => ({ appearanceDescription: "", librarySetting: "" }) },
    promptProfileStore: { get: () => ({ userName: "user", layers: [], visibleTools: {} }), save: (profile: unknown) => profile },
    talkPromptProfileStore: { get: () => ({ userName: "user", layers: [], visibleTools: {} }), save: (profile: unknown) => profile },
    memoryStore,
    diaryStore: {
      listSleepBoundaries: () => [
        { occurredAt: "2026-05-23T22:00:00.000", source: "inferred_start" },
        { occurredAt: "2026-05-24T06:00:00.000", source: "sleep" }
      ],
      latestWakeBoundary: () => undefined,
      recordSleepBoundary() {}
    },
    calendarStore: {
      latestBirthday: () => undefined,
      listEntries: () => [],
      replaceBirthday() {
        throw new Error("calendar_store_unavailable");
      }
    },
    memoryInductionPromptStore: promptStore,
    runMemoryInductionForMessages: async () => ({ ok: false, startedAt: "", windowEndAt: "", messageCount: 0, results: [] }),
    getDailyShell: () => "",
    dailyShellStore: {
      get: () => ({
        date: "2026-05-24",
        createdAt: "2026-05-24T06:00:00.000Z",
        personality: { id: "default", name: "Default", content: "" },
        relationship: { id: "default", name: "Default", content: "" },
        outfit: { id: "default", name: "Default", content: "" }
      }),
      getConfig: () => ({}),
      render: () => "",
      reroll() {},
      listSwitchLogs: () => []
    },
    agentState: { getSnapshot: () => ({ state: "sleeping" }), setState() {} },
    messagingTools: emptyPlugin("messaging"),
    photoTools: emptyPlugin("photo"),
    shellTools: emptyPlugin("shell"),
    bookcaseTools: emptyPlugin("bookcase"),
    sleepCocoonTools: emptyPlugin("sleep-cocoon"),
    calendarTools: emptyPlugin("calendar"),
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

function photoDefaults() {
  return {
    selfieReferenceDir: "assets/selfie/references",
    selfieOutputDir: "assets/generated/selfies",
    selfieCodexCommand: "codex",
    selfieCodexTimeoutMs: 180_000,
    selfieImageApiBaseURL: "https://api.openai.com/v1",
    selfieImageApiRelayBaseURL: "https://api.openai.com/v1",
    selfieImageApiModel: "gpt-image-2",
    selfieImageApiSize: "768x1024",
    selfieImageApiQuality: "low",
    selfieImageApiModeration: "low",
    selfieImageApiOutputFormat: "jpeg",
    selfieImageApiOutputCompression: 45,
    selfieImageApiTimeoutMs: 120_000,
    selfieImageApiRelayModel: "gpt-image-2",
    selfieImageApiRelaySize: "768x1024",
    selfieImageApiRelayQuality: "low",
    selfieImageApiRelayModeration: "low",
    selfieImageApiRelayOutputFormat: "jpeg",
    selfieImageApiRelayOutputCompression: 45,
    selfieImageApiRelayTimeoutMs: 120_000,
    selfieMaxBytes: 10 * 1024 * 1024
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

function makeTinyWavBuffer(): Buffer {
  const sampleRate = 8_000;
  const channels = 1;
  const bitsPerSample = 16;
  const samples = 400;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = samples * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((i / sampleRate) * Math.PI * 2 * 440) * 1_000);
    buffer.writeInt16LE(value, 44 + (i * bytesPerSample));
  }
  return buffer;
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
