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
  assert.deepEqual(schemaBody.configSchema.groups.map((group: { key: string }) => group.key), ["general", "openai", "openai_relay", "codex", "storage", "on_body", "2dinreal"]);
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
  assert.equal(fieldGroups.get("autoGenerateOutfitOnBody"), "general");
  assert.equal(fieldGroups.get("onBodyReferenceImage"), "on_body");
  assert.equal(fieldGroups.get("onBodyPrompt"), "on_body");
  assert.equal(fieldGroups.get("selfie2DinRealEnabled"), "general");
  assert.equal(fieldGroups.get("selfie2DinRealReferenceImage"), "2dinreal");
  assert.equal(fieldGroups.get("selfie2DinRealPrompt"), "2dinreal");
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
    selfieMaxBytes: 10 * 1024 * 1024,
    autoGenerateOutfitOnBody: true,
    onBodyReferenceImage: "assets/selfie/references/full-body-reference.jpg",
    onBodyPrompt: "configured-prompt",
    selfie2DinRealEnabled: true,
    selfie2DinRealReferenceImage: "assets/selfie/references/2dinreal-reference.jpg",
    selfie2DinRealPrompt: "  2DinReal prompt\n"
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
  assert.equal(saved.autoGenerateOutfitOnBody, true);
  assert.equal(saved.onBodyReferenceImage, "assets/selfie/references/full-body-reference.jpg");
  assert.equal(saved.onBodyPrompt, "configured-prompt");
  assert.equal(saved.selfie2DinRealEnabled, true);
  assert.equal(saved.selfie2DinRealReferenceImage, "assets/selfie/references/2dinreal-reference.jpg");
  assert.equal(saved.selfie2DinRealPrompt, "  2DinReal prompt\n");
  assert.equal(saved.selfieImageApiKeySet, undefined);
  assert.equal(saved.selfieImageApiRelayKeySet, undefined);
});

test("admin photo on-body generation writes beside outfit image", async () => {
  const root = makeTempDir("admin-photo-on-body");
  const previousCwd = process.cwd();
  process.chdir(root);
  const configPath = path.join(root, "config", "plugin", "photo", "config.json");
  const referencePath = path.join(root, "assets", "selfie", "references", "full-body-reference.jpg");
  const outfitPath = path.join(root, "memory-files", "shell", "outfits", "dress_1.jpg");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(referencePath), { recursive: true });
  fs.mkdirSync(path.dirname(outfitPath), { recursive: true });
  fs.writeFileSync(referencePath, "reference");
  fs.writeFileSync(outfitPath, "outfit");
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    selfieMode: "openai",
    selfieImageApiKey: "image-key",
    onBodyReferenceImage: path.relative(root, referencePath),
    onBodyPrompt: "configured-prompt {{outfit/content}}"
  })}\n`);
  const previousFetch = globalThis.fetch;
  let renderedPrompt = "";
  globalThis.fetch = (async (_url, init) => {
    renderedPrompt = String((init?.body as FormData).get("prompt"));
    return new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") }]
    }));
  }) as typeof fetch;
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const dailyShellStore = createDailyShellStore(root);
  dailyShellStore.saveOption("outfits", {
    id: "dress_1",
    name: "Dress 1",
    content: "black dress",
    imageUrl: path.relative(root, outfitPath)
  });
  const base = baseContext(root, memoryStore, promptStore);
  const context = {
    ...base,
    config: { ...base.config, photo: photoDefaults() },
    pluginConfigs: { photo: { configPath } },
    dailyShellStore
  };
  const handler = createAdminHandler(context);

  try {
    const response = createResponse();
    await handler(createRequest("POST", "/admin/api/plugins/photo/on-body", {
      outfitId: "dress_1",
      outfitName: "Dress 1",
      outfitContent: "black dress",
      outfitImageUrl: path.relative(root, outfitPath)
    }), response);
    const body = JSON.parse(response.body);
    const expectedPath = path.join(path.dirname(path.relative(root, outfitPath)), "dress_1.On_Body_Ref.jpg");

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(body.ok, true);
    assert.equal(body.imageUrl, expectedPath);
    assert.equal(renderedPrompt, "configured-prompt black dress");
    assert.equal(fs.existsSync(path.join(path.dirname(outfitPath), "dress_1.On_Body_Ref.jpg")), true);
    assert.equal(dailyShellStore.getConfig(new Date("2026-05-24T06:00:00.000Z"), "Asia/Shanghai").outfits.find((outfit) => outfit.id === "dress_1")?.onBodyGenerationAttempted, true);
  } finally {
    globalThis.fetch = previousFetch;
    process.chdir(previousCwd);
  }
});

test("admin photo on-body generation locks requests and clears only failed first attempts", async () => {
  const root = makeTempDir("admin-photo-on-body-errors");
  const previousCwd = process.cwd();
  process.chdir(root);
  const configPath = path.join(root, "config", "plugin", "photo", "config.json");
  const referencePath = path.join(root, "assets", "selfie", "references", "full-body-reference.jpg");
  const outfitDir = path.join(root, "memory-files", "shell", "outfits");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(referencePath), { recursive: true });
  fs.mkdirSync(outfitDir, { recursive: true });
  fs.writeFileSync(referencePath, "reference");
  fs.writeFileSync(path.join(outfitDir, "blocked.jpg"), "outfit");
  fs.writeFileSync(path.join(outfitDir, "busy.jpg"), "outfit");
  fs.writeFileSync(path.join(outfitDir, "retry.jpg"), "outfit");
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    selfieMode: "openai",
    selfieImageApiKey: "image-key",
    onBodyReferenceImage: path.relative(root, referencePath),
    onBodyPrompt: "configured-prompt {{outfit/content}}"
  })}\n`);
  const previousFetch = globalThis.fetch;
  let readOutfitAttempted = (_id: string) => undefined as boolean | undefined;
  globalThis.fetch = (async (_url, init) => {
    const prompt = String((init?.body as FormData).get("prompt"));
    if (prompt.includes("blocked")) return new Response(JSON.stringify({ error: { message: "rejected by safety system" } }), { status: 400, statusText: "Bad Request" });
    if (prompt.includes("busy")) assert.equal(readOutfitAttempted("busy"), true);
    if (prompt.includes("retry")) assert.equal(readOutfitAttempted("retry"), true);
    return new Response("upstream busy", { status: 503, statusText: "Service Unavailable" });
  }) as typeof fetch;
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const dailyShellStore = createDailyShellStore(root);
  const blockedOnBodyImageUrl = path.relative(root, path.join(outfitDir, "blocked.On_Body_Ref.jpg"));
  const retryOnBodyImageUrl = path.relative(root, path.join(outfitDir, "retry.On_Body_Ref.jpg"));
  readOutfitAttempted = (id) => dailyShellStore.getConfig(new Date("2026-05-24T06:00:00.000Z"), "Asia/Shanghai").outfits.find((outfit) => outfit.id === id)?.onBodyGenerationAttempted;
  dailyShellStore.saveOption("outfits", {
    id: "blocked",
    name: "Blocked",
    content: "blocked",
    imageUrl: path.relative(root, path.join(outfitDir, "blocked.jpg")),
    onBodyImageUrl: blockedOnBodyImageUrl
  });
  dailyShellStore.saveOption("outfits", { id: "busy", name: "Busy", content: "busy", imageUrl: path.relative(root, path.join(outfitDir, "busy.jpg")) });
  dailyShellStore.saveOption("outfits", {
    id: "retry",
    name: "Retry",
    content: "retry",
    imageUrl: path.relative(root, path.join(outfitDir, "retry.jpg")),
    onBodyImageUrl: retryOnBodyImageUrl
  });
  const base = baseContext(root, memoryStore, promptStore);
  const handler = createAdminHandler({
    ...base,
    config: { ...base.config, photo: photoDefaults() },
    pluginConfigs: { photo: { configPath } },
    dailyShellStore
  });

  try {
    const blocked = createResponse();
    await handler(createRequest("POST", "/admin/api/plugins/photo/on-body", {
      outfitId: "blocked",
      outfitImageUrl: path.relative(root, path.join(outfitDir, "blocked.jpg"))
    }), blocked);
    const busy = createResponse();
    await handler(createRequest("POST", "/admin/api/plugins/photo/on-body", {
      outfitId: "busy",
      outfitImageUrl: path.relative(root, path.join(outfitDir, "busy.jpg"))
    }), busy);
    const retry = createResponse();
    await handler(createRequest("POST", "/admin/api/plugins/photo/on-body", {
      outfitId: "retry",
      outfitImageUrl: path.relative(root, path.join(outfitDir, "retry.jpg"))
    }), retry);
    const outfits = dailyShellStore.getConfig(new Date("2026-05-24T06:00:00.000Z"), "Asia/Shanghai").outfits;

    assert.equal(blocked.statusCode, 500);
    assert.equal(JSON.parse(blocked.body).onBodyGenerationAttempted, true);
    assert.equal(busy.statusCode, 503);
    assert.equal(JSON.parse(busy.body).onBodyGenerationAttempted, undefined);
    assert.equal(retry.statusCode, 503);
    assert.equal(JSON.parse(retry.body).onBodyGenerationAttempted, true);
    assert.equal(outfits.find((outfit) => outfit.id === "blocked")?.onBodyGenerationAttempted, true);
    assert.equal(outfits.find((outfit) => outfit.id === "blocked")?.onBodyImageUrl, blockedOnBodyImageUrl);
    assert.equal(outfits.find((outfit) => outfit.id === "busy")?.onBodyGenerationAttempted, undefined);
    assert.equal(outfits.find((outfit) => outfit.id === "retry")?.onBodyGenerationAttempted, true);
    assert.equal(outfits.find((outfit) => outfit.id === "retry")?.onBodyImageUrl, retryOnBodyImageUrl);
  } finally {
    globalThis.fetch = previousFetch;
    process.chdir(previousCwd);
  }
});
