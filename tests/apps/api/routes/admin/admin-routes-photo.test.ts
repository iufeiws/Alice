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

test("admin photo plugin config exposes selfie schema", async () => {
  const root = makeTempDir("admin-photo-plugin-config");
  const configPath = path.join(root, "config", "plugin", "photo", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    selfieMode: "openai"
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const base = baseContext(root, memoryStore, promptStore);
  const context = {
    ...base,
    config: {
      ...base.config,
      photo: {
        ...photoDefaults(),
        selfieImageApiKey: "secret-image-key",
        selfieImageApiRelayKey: "secret-relay-key",
        selfieXaiCredentialId: "xai-credential"
      }
    },
    pluginConfigs: { photo: { configPath } }
  };
  const handler = createAdminHandler(context);

  const schemaResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/photo/config", {}), schemaResponse);
  const schemaBody = JSON.parse(schemaResponse.body);
  assert.equal(schemaResponse.statusCode, 200);
  assert.ok(Array.isArray(schemaBody.configSchema.groups));
  assert.ok(Array.isArray(schemaBody.configSchema.fields));
  assert.ok(schemaBody.configSchema.groups.some((group: { key: string; label: string }) => group.key === "main_prompt" && group.label === "Main Prompt"));
  assert.ok(!schemaBody.configSchema.groups.some((group: { key: string }) => group.key === "storage"));
  assert.deepEqual(
    schemaBody.configSchema.fields.filter((field: { key: string; group: string }) => field.group === "main_prompt").map((field: { key: string }) => field.key),
    [
      "selfieDefaultPose",
      "selfieDefaultExpression",
      "selfieDefaultHair",
      "selfieDefaultComposition",
      "selfieReferenceDir",
      "selfiePromptTemplate",
      "selfieCharacterReferenceImage",
      "selfieOutputDir",
      "selfieMaxBytes"
    ]
  );
  assert.equal(schemaBody.configValue.selfieDefaultPose, "");
  assert.equal(schemaBody.configValue.selfieDefaultExpression, "");
  assert.equal(schemaBody.configValue.selfieDefaultHair, "");
  assert.equal(schemaBody.configValue.selfieDefaultComposition, "镜头距离为超近景, 一臂距离, 人物占画面80%以上");
});

test("admin photo plugin config hides selfie api keys", async () => {
  const root = makeTempDir("admin-photo-plugin-hidden-keys");
  const configPath = path.join(root, "config", "plugin", "photo", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    selfieMode: "openai"
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const base = baseContext(root, memoryStore, promptStore);
  const context = {
    ...base,
    config: {
      ...base.config,
      photo: {
        ...photoDefaults(),
        selfieImageApiKey: "secret-image-key",
        selfieImageApiRelayKey: "secret-relay-key",
        selfieXaiCredentialId: "xai-credential"
      }
    },
    pluginConfigs: { photo: { configPath } }
  };
  const handler = createAdminHandler(context);

  const schemaResponse = createResponse();
  await handler(createRequest("GET", "/admin/api/plugins/photo/config", {}), schemaResponse);
  const schemaBody = JSON.parse(schemaResponse.body);

  assert.equal(schemaBody.configValue.selfieImageApiKeySet, true);
  assert.equal(schemaBody.configValue.selfieImageApiRelayKeySet, true);
  assert.equal(schemaBody.configValue.selfieXaiCredentialSet, true);
  assert.equal(schemaBody.configValue.selfieImageApiKey, undefined);
  assert.equal(schemaBody.configValue.selfieImageApiRelayKey, undefined);
  assert.equal(schemaBody.configValue.selfieXaiCredentialId, "xai-credential");
});

test("admin plugin config patch writes photo general, codex, and main prompt fields", async () => {
  const { response, body, saved } = await patchPhotoConfig();

  assert.equal(response.statusCode, 200);
  assert.equal(body.configValue.selfieMode, "openaiRelay");
  assert.equal(saved.selfieMode, "openaiRelay");
  assert.equal(saved.selfieCodexExtraPrompt, "configured extra prompt");
  assert.equal(saved.selfieCodexTimeoutMs, 240000);
  assert.equal(saved.selfieOutputDir, "assets/generated/selfies");
  assert.equal(saved.selfieReferenceDir, "assets/selfie/references");
  assert.equal(saved.selfieMaxBytes, 10 * 1024 * 1024);
  assert.equal(saved.selfieDefaultPose, "看镜头挥手");
  assert.equal(saved.selfieDefaultExpression, "开心地笑");
  assert.equal(saved.selfieDefaultHair, "齐肩短发");
  assert.equal(saved.selfieDefaultComposition, "半身构图");
});

test("admin plugin config patch writes photo OpenAI image API fields", async () => {
  const { response, saved } = await patchPhotoConfig();

  assert.equal(response.statusCode, 200);
  assert.equal(saved.selfieImageApiKey, "new-openai-key");
  assert.equal(saved.selfieImageApiBaseURL, "https://api.openai.com/v1");
  assert.equal(saved.selfieImageApiModel, "gpt-image-2");
  assert.equal(saved.selfieImageApiModeration, "low");
});

test("admin plugin config patch writes photo relay image API fields", async () => {
  const { response, saved } = await patchPhotoConfig();

  assert.equal(response.statusCode, 200);
  assert.equal(saved.selfieImageApiRelayKey, "new-relay-key");
  assert.equal(saved.selfieImageApiRelayBaseURL, "https://relay.example.test/v1");
  assert.equal(saved.selfieImageApiRelayModel, "relay-image-model");
  assert.equal(saved.selfieImageApiRelayOutputFormat, "webp");
});

test("admin plugin config patch writes photo xAI image API fields", async () => {
  const { response, saved } = await patchPhotoConfig();

  assert.equal(response.statusCode, 200);
  assert.equal(saved.selfieXaiCredentialId, "xai-credential");
  assert.equal(saved.selfieXaiImageApiBaseURL, "https://api.x.ai/v1");
  assert.equal(saved.selfieXaiImageApiModel, "grok-imagine-image-2.0");
  assert.equal(saved.selfieXaiImageApiAspectRatio, "2:3");
  assert.equal(saved.selfieXaiImageApiResolution, "2k");
  assert.equal(saved.selfieXaiImageApiQuality, "medium");
});

test("admin plugin config patch writes photo on-body fields", async () => {
  const { response, saved } = await patchPhotoConfig();

  assert.equal(response.statusCode, 200);
  assert.equal(saved.autoGenerateOutfitOnBody, true);
  assert.equal(saved.onBodyReferenceImage, "assets/selfie/references/full-body-reference.jpg");
  assert.equal(saved.onBodyPrompt, "configured-prompt");
});

test("admin plugin config patch writes photo 2DinReal fields", async () => {
  const { response, saved } = await patchPhotoConfig();

  assert.equal(response.statusCode, 200);
  assert.equal(saved.selfie2DinRealEnabled, true);
  assert.equal(saved.selfie2DinRealReferenceImage, "assets/selfie/references/2dinreal-reference.jpg");
  assert.equal(saved.selfie2DinRealPrompt, "  2DinReal prompt\n");
});

test("admin plugin config patch returns photo key markers without storing them", async () => {
  const { response, body, saved } = await patchPhotoConfig();

  assert.equal(response.statusCode, 200);
  assert.equal(body.configValue.selfieImageApiKeySet, true);
  assert.equal(body.configValue.selfieImageApiRelayKeySet, true);
  assert.equal(saved.selfieImageApiKeySet, undefined);
  assert.equal(saved.selfieImageApiRelayKeySet, undefined);
});

async function patchPhotoConfig() {
  const root = makeTempDir("admin-photo-plugin-config-patch");
  const configPath = path.join(root, "config", "plugin", "photo", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    selfieMode: "openai"
  })}\n`);
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
    credentialStore: {
      ...base.credentialStore,
      get: (id: string) => id === "xai-credential"
        ? { id, label: "xAI", kind: "api_key", provider: "xai", status: "connected" }
        : base.credentialStore.get(id)
    },
    pluginConfigs: { photo: { configPath } }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("PATCH", "/admin/api/plugins/photo/config", {
    enabled: true,
    selfieMode: "openaiRelay",
    selfieCodexCommand: "codex",
    selfieCodexExtraPrompt: "configured extra prompt",
    selfieCodexTimeoutMs: 240000,
    selfieOutputDir: "assets/generated/selfies",
    selfieReferenceDir: "assets/selfie/references",
    selfieDefaultPose: "看镜头挥手",
    selfieDefaultExpression: "开心地笑",
    selfieDefaultHair: "齐肩短发",
    selfieDefaultComposition: "半身构图",
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
    selfieXaiCredentialId: "xai-credential",
    selfieXaiImageApiBaseURL: "https://api.x.ai/v1",
    selfieXaiImageApiModel: "grok-imagine-image-2.0",
    selfieXaiImageApiAspectRatio: "2:3",
    selfieXaiImageApiResolution: "2k",
    selfieXaiImageApiQuality: "medium",
    selfieXaiImageApiTimeoutMs: 90000,
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

  return { response, body, saved };
}

test("admin photo on-body generation writes beside outfit image", async () => {
  const { response, body, expectedImageUrl, outputPath } = await runSuccessfulOnBodyGeneration();

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(body.imageUrl, expectedImageUrl);
  assert.equal(fs.existsSync(outputPath), true);
});

test("admin photo on-body generation renders configured outfit prompt", async () => {
  const { response, renderedPrompt, expectedPrompt } = await runSuccessfulOnBodyGeneration();

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(renderedPrompt, expectedPrompt);
});

test("admin photo on-body generation marks successful outfit attempts", async () => {
  const { response, attempted } = await runSuccessfulOnBodyGeneration();

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(attempted, true);
});

async function runSuccessfulOnBodyGeneration() {
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
    onBodyPrompt: "configured-prompt ${{targetOutfit/content}}"
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
    const expectedImageUrl = path.join(path.dirname(path.relative(root, outfitPath)), "dress_1.On_Body_Ref.jpg");
    const outputPath = path.join(path.dirname(outfitPath), "dress_1.On_Body_Ref.jpg");
    const attempted = dailyShellStore.getConfig(new Date("2026-05-24T06:00:00.000Z"), "Asia/Shanghai").outfits.find((outfit) => outfit.id === "dress_1")?.onBodyGenerationAttempted;
    const expectedPrompt = "configured-prompt black dress";
    return { response, body, expectedImageUrl, outputPath, renderedPrompt, expectedPrompt, attempted };
  } finally {
    globalThis.fetch = previousFetch;
    process.chdir(previousCwd);
  }
}

test("admin photo on-body generation marks requests before upstream call", async () => {
  let sawLockedRequest = false;
  const fixture = createOnBodyFailureFixture((_prompt, readAttempted) => {
    sawLockedRequest = true;
    assert.equal(readAttempted("busy"), true);
    return new Response("upstream busy", { status: 503, statusText: "Service Unavailable" });
  });

  try {
    const response = await fixture.post("busy");

    assert.equal(response.statusCode, 503);
    assert.equal(sawLockedRequest, true);
  } finally {
    fixture.restore();
  }
});

test("admin photo on-body generation clears failed first attempts", async () => {
  const fixture = createOnBodyFailureFixture(() => new Response("upstream busy", { status: 503, statusText: "Service Unavailable" }));

  try {
    const response = await fixture.post("busy");
    const outfits = fixture.outfits();

    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.body).onBodyGenerationAttempted, undefined);
    assert.equal(outfits.find((outfit) => outfit.id === "busy")?.onBodyGenerationAttempted, undefined);
  } finally {
    fixture.restore();
  }
});

test("admin photo on-body generation keeps failed retry attempts", async () => {
  const fixture = createOnBodyFailureFixture(() => new Response("upstream busy", { status: 503, statusText: "Service Unavailable" }));

  try {
    const response = await fixture.post("retry");
    const outfits = fixture.outfits();

    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.body).onBodyGenerationAttempted, true);
    assert.equal(outfits.find((outfit) => outfit.id === "retry")?.onBodyGenerationAttempted, true);
    assert.equal(outfits.find((outfit) => outfit.id === "retry")?.onBodyImageUrl, fixture.retryOnBodyImageUrl);
  } finally {
    fixture.restore();
  }
});

test("admin photo on-body generation marks blocked retries as attempted", async () => {
  const fixture = createOnBodyFailureFixture((_prompt, readAttempted) => {
    if (readAttempted("blocked") === true) return new Response(JSON.stringify({ error: { message: "rejected by safety system" } }), { status: 400, statusText: "Bad Request" });
    return new Response("upstream busy", { status: 503, statusText: "Service Unavailable" });
  });

  try {
    const response = await fixture.post("blocked");
    const outfits = fixture.outfits();

    assert.equal(response.statusCode, 500);
    assert.equal(JSON.parse(response.body).onBodyGenerationAttempted, true);
    assert.equal(outfits.find((outfit) => outfit.id === "blocked")?.onBodyGenerationAttempted, true);
    assert.equal(outfits.find((outfit) => outfit.id === "blocked")?.onBodyImageUrl, fixture.blockedOnBodyImageUrl);
  } finally {
    fixture.restore();
  }
});

function createOnBodyFailureFixture(fetchResponse: (prompt: string, readAttempted: (id: string) => boolean | undefined) => Response) {
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
    onBodyPrompt: "configured-prompt ${{outfit/content}}"
  })}\n`);
  const previousFetch = globalThis.fetch;
  let readOutfitAttempted = (_id: string) => undefined as boolean | undefined;
  globalThis.fetch = (async (_url, init) => {
    const prompt = String((init?.body as FormData).get("prompt"));
    return fetchResponse(prompt, readOutfitAttempted);
  }) as typeof fetch;
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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

  return {
    blockedOnBodyImageUrl,
    retryOnBodyImageUrl,
    outfits: () => dailyShellStore.getConfig(new Date("2026-05-24T06:00:00.000Z"), "Asia/Shanghai").outfits,
    async post(outfitId: "blocked" | "busy" | "retry") {
      const response = createResponse();
      await handler(createRequest("POST", "/admin/api/plugins/photo/on-body", {
        outfitId,
        outfitImageUrl: path.relative(root, path.join(outfitDir, `${outfitId}.jpg`))
      }), response);
      return response;
    },
    restore() {
      globalThis.fetch = previousFetch;
      process.chdir(previousCwd);
    }
  };
}
