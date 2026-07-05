import { test } from "node:test";
import assert from "node:assert/strict";
import { createPhotoTools, readPhotoPluginConfig, type SelfieExecutorInput } from "../../../../src/capabilities/tools/photo/src/index.js";
import { runImageGenerationProvider } from "../../../../src/channels/image-generation/src/index.js";
import { createOutfitOnBodyGenerationAttempt } from "../../../../src/contexts/capabilities/src/outfit-on-body-runtime.js";
import {
  createTestStore,
  fs,
  makeTempDir,
  path,
  providerInput,
  selfieContext
} from "./photo-tools-helpers.js";

test("selfie_schema_exposesPoseOnly", () => {
  const store = createTestStore("selfie-schema-db");
  const tools = createPhotoTools({
    store,
    outputRouter: { async send() {} },
    getSelfieContext: selfieContext,
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
  });

  const selfie = tools.listTools()[0];
  assert.equal(selfie.name, "Selfie");
  assert.equal((selfie.inputSchema.properties as Record<string, unknown>).description, undefined);
  assert.equal((selfie.inputSchema.properties as Record<string, unknown>).aspectRatio, undefined);
  assert.deepEqual(selfie.inputSchema.required, ["pose"]);
});

test("photoConfig_invalidPersistedValues_throwsConfigError", () => {
  const configPath = path.join(makeTempDir("selfie-invalid-config"), "config.json");

  fs.writeFileSync(configPath, JSON.stringify({ selfieMode: "api" }));
  assert.throws(() => readPhotoPluginConfig(configPath), /invalid selfieMode: api/);

  fs.writeFileSync(configPath, JSON.stringify({ selfieImageApiOutputFormat: "gif" }));
  assert.throws(() => readPhotoPluginConfig(configPath), /invalid selfieImageApiOutputFormat: gif/);

  fs.writeFileSync(configPath, JSON.stringify({ selfieCodexTimeoutMs: "abc" }));
  assert.throws(() => readPhotoPluginConfig(configPath), /invalid selfieCodexTimeoutMs: abc/);

  fs.writeFileSync(configPath, "{bad");
  assert.throws(() => readPhotoPluginConfig(configPath), /invalid photo plugin config JSON/);
});

test("photoConfig_onBodySettings_readsPersistedValues", () => {
  const configPath = path.join(makeTempDir("on-body-config"), "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    autoGenerateOutfitOnBody: true,
    onBodyReferenceImage: "assets/ref/full-body.jpg",
    onBodyPrompt: "use image 1 as body reference and image 2 as outfit reference",
    selfieOnBodyPrompt: "use image 1 as on-body reference and image 2 as scene reference",
    selfieCodexExtraPrompt: "  codex extra prompt\n",
    selfie2DinRealEnabled: true,
    selfie2DinRealReferenceImage: "assets/ref/2dinreal.jpg",
    selfie2DinRealPrompt: "  use 2DinReal\n"
  }));

  const config = readPhotoPluginConfig(configPath);

  assert.equal(readPhotoPluginConfig(path.join(makeTempDir("on-body-default-config"), "missing.json")).autoGenerateOutfitOnBody, false);
  assert.equal(config.autoGenerateOutfitOnBody, true);
  assert.equal(config.onBodyReferenceImage, "assets/ref/full-body.jpg");
  assert.equal(config.onBodyPrompt, "use image 1 as body reference and image 2 as outfit reference");
  assert.equal(config.selfieOnBodyPrompt, "use image 1 as on-body reference and image 2 as scene reference");
  assert.equal(config.selfieCodexExtraPrompt, "  codex extra prompt\n");
  assert.equal(config.selfie2DinRealEnabled, true);
  assert.equal(config.selfie2DinRealReferenceImage, "assets/ref/2dinreal.jpg");
  assert.equal(config.selfie2DinRealPrompt, "  use 2DinReal\n");
});

test("imageGenerationGateway_duplicateRequest_rejectsWhileOriginalRuns", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executor = async (input: SelfieExecutorInput) => {
    await gate;
    return { stdout: input.prompt };
  };
  const first = runImageGenerationProvider(providerInput("same", ["a.jpg"]), executor);
  const duplicate = await runImageGenerationProvider(providerInput("same", ["a.jpg"]), executor)
    .then(() => "", (error) => error instanceof Error ? error.message : String(error));

  release();
  await first;

  assert.equal(duplicate, "image generation duplicate request is already running");
});

test("imageGenerationGateway_concurrencyLimit_rejectsExtraRequest", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  const executor = async (input: SelfieExecutorInput) => {
    started.push(input.prompt);
    await gate;
    return { stdout: input.prompt };
  };
  const first = runImageGenerationProvider(providerInput("same", ["a.jpg"]), executor);
  const second = runImageGenerationProvider(providerInput("other", ["b.jpg"]), executor);
  const overLimit = await runImageGenerationProvider(providerInput("third", ["c.jpg"]), executor)
    .then(() => "", (error) => error instanceof Error ? error.message : String(error));

  release();
  await Promise.all([first, second]);

  assert.equal(overLimit, "image generation concurrency limit reached");
  assert.deepEqual(started, ["same", "other"]);
});

test("imageGenerationGateway_finishedRequest_releasesDuplicateKey", async () => {
  await runImageGenerationProvider(providerInput("same", ["a.jpg"]), async () => ({ stdout: "first" }));
  const afterRelease = await runImageGenerationProvider(providerInput("same", ["a.jpg"]), async () => ({ stdout: "released" }));

  assert.deepEqual(afterRelease, { stdout: "released" });
});

test("outfitOnBodyAutoGeneration_defaultConfig_doesNotFetch", async () => {
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    throw new Error("fetch should not run");
  }) as typeof fetch;
  const attempt = createOutfitOnBodyGenerationAttempt({
    config: { photo: {} },
    dailyShellStore: {},
    time: {},
    promptProfileStore: {},
    coreProfileStore: {},
    photoConfigPath: path.join(makeTempDir("on-body-auto-default"), "missing.json"),
    appendLog() {}
  });

  try {
    await attempt({ id: "o1", name: "O One", content: "outfit", imageUrl: "missing.jpg" });
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(fetchCount, 0);
});

test("photoTool_invalidConfig_returnsErrorToAgent", async () => {
  const configPath = path.join(makeTempDir("selfie-tool-invalid-config"), "config.json");
  const store = createTestStore("selfie-tool-invalid-config-db");
  fs.writeFileSync(configPath, JSON.stringify({ selfieMode: "api" }));
  const tools = createPhotoTools({
    store,
    outputRouter: { async send() {} },
    selfieConfigPath: configPath,
    getSelfieContext: selfieContext,
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
  });

  const result = await tools.execute({
    id: "call_selfie_bad_config",
    toolName: "Selfie",
    input: { pose: "测试坏配置" }
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /invalid selfieMode: api/);
});
