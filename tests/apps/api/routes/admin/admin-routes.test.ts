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

test("voice call app page renders outside the plugin page", async () => {
  const root = makeTempDir("voice-call-page");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler(baseContext(root, memoryStore, promptStore));

  const response = createResponse();
  await handler(createRequest("GET", "/voice-call", {}), response);

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Alice Voice Call/);
  assert.match(response.body, /class="voice-call-app"/);
  assert.match(response.body, /\/voice-call\/api\/config/);
  assert.match(response.body, /\/voice-call\/api\/signaling/);
  assert.match(response.body, /\/voice-call\/assets\/alice-default-portrait\.png/);
  assert.doesNotMatch(response.body, /realtime_voice/);
});

test("voice call app config defines frontend and signaling routes", async () => {
  const root = makeTempDir("voice-call-config");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
  const saved = JSON.parse(fs.readFileSync(path.join(root, "config", "llm-api-presets.json"), "utf8")).presets[0];

  assert.equal(response.statusCode, 200);
  assert.deepEqual({
    extraParams: saved.extraParams,
    followupExtraParams: saved.followupExtraParams
  }, {
    extraParams: { top_p: 0.7, stream_options: { include_usage: true } },
    followupExtraParams: { top_p: 0.2 }
  });
});

test("llm api preset save accepts long timeout values", async () => {
  const root = makeTempDir("admin-llm-preset-timeout");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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

test("prompt api profile saves chat binding", async () => {
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler(baseContext(root, memoryStore, promptStore));

  const response = createResponse();
  await handler(createRequest("PUT", "/admin/api/prompt-api-profile", {
    chatPresetName: "Chat Custom",
    talkPresetName: "Talk Custom",
    memorizePresetName: "Memorize Custom"
  }), response);
  const body = JSON.parse(response.body);
  const saved = JSON.parse(fs.readFileSync(promptStoragePath(root, "prompt-api-profile.json"), "utf8"));

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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = baseContext(root, memoryStore, promptStore);
  context.promptProfileStore = createPromptProfileStore(path.join(root, "chat-prompt-profile.json"));
  context.talkPromptProfileStore = createPromptProfileStore(path.join(root, "talk-prompt-profile.json"));
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("PUT", "/admin/api/talk-prompt-profile", {
    visibleTools: {},
    layers: [{ id: "talk-role", title: "Talk Role", role: "system", enabled: true, order: 10, content: "talk" }]
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(context.talkPromptProfileStore.get().layers[0]?.id, "talk-role");
  assert.equal(context.promptProfileStore.get().layers[0]?.id, undefined);
});

test("agent state admin route exposes calling state", async () => {
  const root = makeTempDir("admin-agent-state-calling");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
});

test("agent state admin route accepts calling state", async () => {
  const root = makeTempDir("admin-agent-state-set-calling");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  let currentState = "idle";
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

  const putResponse = createResponse();
  await handler(createRequest("PUT", "/admin/api/agent-state", { state: "calling" }), putResponse);
  const putBody = JSON.parse(putResponse.body);

  assert.equal(putResponse.statusCode, 200);
  assert.equal(currentState, "calling");
  assert.equal(putBody.state.state, "calling");
});

test("admin messaging runtime rejects missing Feishu target", async () => {
  const root = makeTempDir("admin-messaging-missing-target");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler(baseContext(root, memoryStore, promptStore));

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/tools/messaging/view", {}), response);

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "missing_feishu_target");
});

test("admin shell runtime exposes shell config", async () => {
  const root = makeTempDir("admin-shell-config");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler(baseContext(root, memoryStore, promptStore));

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/shell", {}), response);

  assert.equal(response.statusCode, 200);
  assert.ok("todayVariables" in JSON.parse(response.body));
});

test("admin tts legacy preview route is not available", async () => {
  const root = makeTempDir("admin-tts-preview-missing-text");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler(baseContext(root, memoryStore, promptStore));

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/tts/generate", {}), response);

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error, "not_found");
});

test("initiated behavior config patch preserves tool request prompt layers", async () => {
  const root = makeTempDir("admin-initiated-behavior-tool-layer");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
          toolName: "Chat",
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
        name: "{{user}}",
        enabled: true,
        content: "",
        order: 10,
        thinking: "check first",
        toolCalls: [{
          toolName: "Chat",
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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

test("admin initiated behavior create route custom plans", async () => {
  const root = makeTempDir("admin-initiated-behavior-custom");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = baseContext(root, memoryStore, promptStore);
  let receivedCreate: unknown;
  context.createAgentInitiatedBehaviorConfig = (id: string, patch: unknown) => {
    receivedCreate = { id, patch };
    return { id, custom: true, kind: "event", enabled: true, triggerEvent: "custom.check", steps: [] };
  };
  const handler = createAdminHandler(context);

  const createResponseBody = createResponse();
  await handler(createRequest("POST", "/admin/api/initiated-behaviors", {
    id: "custom_check",
    kind: "event",
    triggerEvent: "custom.check",
    promptProfile: { layers: [] }
  }), createResponseBody);

  assert.equal(createResponseBody.statusCode, 200);
  assert.deepEqual(receivedCreate, {
    id: "custom_check",
    patch: {
      kind: "event",
      triggerEvent: "custom.check",
      promptProfile: { layers: [] }
    }
  });
});

test("admin initiated behavior delete route custom plans", async () => {
  const root = makeTempDir("admin-initiated-behavior-custom-delete");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const context = baseContext(root, memoryStore, promptStore);
  let receivedDelete = "";
  context.deleteAgentInitiatedBehaviorConfig = (id: string) => {
    receivedDelete = id;
    return id === "custom_check" ? { id, custom: true, kind: "event", enabled: true, steps: [] } : undefined;
  };
  const handler = createAdminHandler(context);

  const deleteResponse = createResponse();
  await handler(createRequest("DELETE", "/admin/api/initiated-behaviors/custom_check", {}), deleteResponse);

  assert.equal(deleteResponse.statusCode, 200);
  assert.equal(receivedDelete, "custom_check");
});
