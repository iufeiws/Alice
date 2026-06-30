import { test } from "node:test";
import assert from "node:assert/strict";
import { createPhotoTools, readPhotoPluginConfig, type SelfieExecutorInput } from "../src/capabilities/tools/photo/src/index.js";
import { runPhotoProvider } from "../src/capabilities/tools/photo/src/photo-provider.js";
import { createOutfitOnBodyGenerationAttempt } from "../src/contexts/capabilities/src/outfit-on-body-runtime.js";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";
import { createAliceStore } from "../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { createToolOutputTargetResolver } from "../src/contexts/capabilities/src/tool-output-target.js";
import type { AgentOutput } from "../src/contexts/agent-loop/src/contracts/agent-contracts.js";

const fs = await import("node:fs");
const path = await import("node:path");

const fakeJpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const png1x1Bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

test("selfie schema exposes pose only", () => {
  const store = createAliceStore(path.join(makeTempDir("selfie-schema-db"), "alice.sqlite"));
  const tools = createPhotoTools({
    store,
    outputRouter: { async send() {} },
    getSelfieContext: selfieContext,
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
  });

  const selfie = tools.listTools()[0];
  assert.equal(selfie.name, "selfie");
  assert.deepEqual((selfie.inputSchema.properties as Record<string, unknown>).description, undefined);
  assert.equal((selfie.inputSchema.properties as Record<string, unknown>).aspectRatio, undefined);
  assert.deepEqual(selfie.inputSchema.required, ["pose"]);
});

test("photo config rejects invalid persisted values", () => {
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

test("photo config reads on-body generation settings", () => {
  const configPath = path.join(makeTempDir("on-body-config"), "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    autoGenerateOutfitOnBody: true,
    onBodyReferenceImage: "assets/ref/full-body.jpg",
    onBodyPrompt: "use image 1 as body reference and image 2 as outfit reference",
    selfieOnBodyPrompt: "use image 1 as on-body reference and image 2 as scene reference"
  }));

  const config = readPhotoPluginConfig(configPath);

  assert.equal(readPhotoPluginConfig(path.join(makeTempDir("on-body-default-config"), "missing.json")).autoGenerateOutfitOnBody, false);
  assert.equal(config.autoGenerateOutfitOnBody, true);
  assert.equal(config.onBodyReferenceImage, "assets/ref/full-body.jpg");
  assert.equal(config.onBodyPrompt, "use image 1 as body reference and image 2 as outfit reference");
  assert.equal(config.selfieOnBodyPrompt, "use image 1 as on-body reference and image 2 as scene reference");
});

test("photo provider limiter rejects duplicate content and third concurrent request", async () => {
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
  const first = runPhotoProvider(providerInput("same", ["a.jpg"]), executor);
  const duplicate = await runPhotoProvider(providerInput("same", ["a.jpg"]), executor)
    .then(() => "", (error) => error instanceof Error ? error.message : String(error));
  const second = runPhotoProvider(providerInput("other", ["b.jpg"]), executor);
  const third = await runPhotoProvider(providerInput("third", ["c.jpg"]), executor)
    .then(() => "", (error) => error instanceof Error ? error.message : String(error));

  release();
  await Promise.all([first, second]);
  const afterRelease = await runPhotoProvider(providerInput("same", ["a.jpg"]), async () => ({ stdout: "released" }));

  assert.equal(duplicate, "photo provider duplicate request is already running");
  assert.equal(third, "photo provider concurrency limit reached");
  assert.deepEqual(started, ["same", "other"]);
  assert.deepEqual(afterRelease, { stdout: "released" });
});

test("outfit on-body auto generation is disabled by default", async () => {
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

test("photo tool entry returns config errors to the agent", async () => {
  const configPath = path.join(makeTempDir("selfie-tool-invalid-config"), "config.json");
  const store = createAliceStore(path.join(makeTempDir("selfie-tool-invalid-config-db"), "alice.sqlite"));
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
    toolName: "selfie",
    input: { pose: "测试坏配置" }
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /invalid selfieMode: api/);
});

test("selfie builds prompt and sends reference images in 1/2/3 order", async () => {
  const outputRoot = makeAssetTempDir("selfie-success");
  const referenceRoot = makeTempDir("selfie-ref");
  const outfitImage = path.join(makeTempDir("selfie-outfit"), "dress.jpg");
  const store = createAliceStore(path.join(makeTempDir("selfie-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const executorInputs: SelfieExecutorInput[] = [];
  let nextMessageId = 1;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");

  try {
    const tools = createPhotoTools({
      store,
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T12:00:00.000Z")),
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieExecutor: async (input) => {
        executorInputs.push(input);
        fs.writeFileSync(path.join(input.workDir, input.fileName), fakeJpegBytes);
        return { stdout: "ok", stderr: "", lastMessage: "saved target file" };
      },
      outputRouter: {
        async send(output) {
          sent.push(output);
          return { messageId: `om_selfie_${nextMessageId++}` };
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getAppearanceDescription: () => "发色: 低饱和浅金色\n眼睛: 浅金色",
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie",
      toolName: "selfie",
      input: { pose: "踮脚靠近镜头，比一个很小的剪刀手" }
    }, { llmCapabilities: { supportsImage: true } });

    assert.equal(result.ok, true);
    assert.equal("aspectRatio" in executorInputs[0], false);
    assert.equal(executorInputs[0].fileName, "selfie_20260526_120000.jpg");
    assert.equal(executorInputs[0].prompt.includes("踮脚靠近镜头"), true);
    assert.equal(executorInputs[0].prompt.includes("发色: 低饱和浅金色"), true);
    assert.equal(executorInputs[0].prompt.includes("说话声音很小"), true);
    assert.equal(executorInputs[0].prompt.includes("黑色薄纱短袖高领上衣"), true);
    assert.doesNotMatch(executorInputs[0].prompt, /\{\{[^}]+\}\}/);
    assert.deepEqual(executorInputs[0].referenceImages, [
      path.resolve(referenceRoot, "alice-character-reference.jpg"),
      path.resolve(outfitImage),
      path.resolve(referenceRoot, "magic-library-reference.jpg")
    ]);
    assert.equal(fs.existsSync(executorInputs[0].workDir), false);
    assert.equal(sent[0].content.kind, "text");
    assert.equal(sent[0].content.kind === "text" ? sent[0].content.text : "", "-少女拍照中-");
    assert.equal(sent[1].content.kind, "image");
    assert.match(sent[1].content.kind === "image" ? sent[1].content.assetId : "", /\/selfie_20260526_120000\.jpg$/);
    assert.equal(result.output, "照片已发送");
    assert.equal(result.llmFollowupAttachments?.[0]?.kind, "image");
    assert.match(result.llmFollowupAttachments?.[0]?.path ?? "", /selfie_20260526_120000\.jpg$/);
    assert.equal(result.llmFollowupAttachments?.[0]?.mime, "image/jpeg");
    assert.deepEqual(store.listMessagesForConversation("session-1", 10).map((message) => message.contentType), ["text", "image"]);
    assert.deepEqual(store.listMessagesForConversation("session-1", 10).map((message) => message.senderRole), ["system", "assistant"]);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie converts generated non-JPEG bytes to JPEG before sending", async () => {
  const outputRoot = makeAssetTempDir("selfie-png-conversion");
  const referenceRoot = makeTempDir("selfie-ref-png-conversion");
  const store = createAliceStore(path.join(makeTempDir("selfie-png-conversion-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  writeReferenceFiles(referenceRoot);

  try {
    const tools = createPhotoTools({
      store,
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T12:00:00.000Z")),
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieExecutor: async (input) => {
        fs.writeFileSync(path.join(input.workDir, input.fileName), png1x1Bytes);
      },
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: selfieContext,
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_png_conversion",
      toolName: "selfie",
      input: { pose: "拍一张 PNG 结果的测试自拍" }
    }, { llmCapabilities: { supportsImage: true } });

    assert.equal(result.ok, true);
    assert.equal(sent[1].content.kind, "image");
    assert.match(sent[1].content.kind === "image" ? sent[1].content.assetId : "", /\/selfie_20260526_120000\.jpg$/);
    assert.equal(result.llmFollowupAttachments?.[0]?.mime, "image/jpeg");
    const finalPath = result.llmFollowupAttachments?.[0]?.path ?? "";
    const finalBytes = fs.readFileSync(finalPath);
    assert.equal(finalBytes[0], 0xff);
    assert.equal(finalBytes[1], 0xd8);
    assert.equal(finalBytes[2], 0xff);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test("selfie uses stored on-body reference with the standard selfie prompt", async () => {
  const outputRoot = makeAssetTempDir("selfie-on-body-reference");
  const referenceRoot = makeTempDir("selfie-ref-on-body-reference");
  const onBodyImage = path.join(makeTempDir("selfie-on-body-image"), "dress.On_Body_Ref.jpg");
  const store = createAliceStore(path.join(makeTempDir("selfie-on-body-db"), "alice.sqlite"));
  let executorInput: SelfieExecutorInput | undefined;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(onBodyImage, "on-body-image");

  try {
    const tools = createPhotoTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieOnBodyPrompt: "on-body prompt {{pose}} {{outfit/content}}",
      selfieExecutor: async (input) => {
        executorInput = input;
        fs.writeFileSync(path.join(input.workDir, input.fileName), fakeJpegBytes);
      },
      outputRouter: { async send() {} },
      getSelfieContext: () => ({ ...selfieContext(), onBodyImageUrl: onBodyImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_on_body",
      toolName: "selfie",
      input: { pose: "看镜头" }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(executorInput?.referenceImages.map((image) => path.basename(image)), [
      "alice-character-reference.jpg",
      "dress.On_Body_Ref.jpg",
      "magic-library-reference.jpg"
    ]);
    assert.match(executorInput?.prompt ?? "", /角色动作:\n看镜头/);
    assert.doesNotMatch(executorInput?.prompt ?? "", /on-body prompt/);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(onBodyImage), { recursive: true, force: true });
  }
});

test("selfie uses current outfit image as on-body reference when marked generated", async () => {
  const outputRoot = makeAssetTempDir("selfie-generated-outfit-reference");
  const referenceRoot = makeTempDir("selfie-ref-generated-outfit-reference");
  const outfitImage = path.join(makeTempDir("selfie-generated-outfit-image"), "uploaded.jpg");
  const store = createAliceStore(path.join(makeTempDir("selfie-generated-outfit-db"), "alice.sqlite"));
  let referenceImages: string[] = [];
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "uploaded-on-body-image");

  try {
    const tools = createPhotoTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieOnBodyPrompt: "generated outfit prompt {{pose}}",
      selfieExecutor: async (input) => {
        referenceImages = input.referenceImages;
        fs.writeFileSync(path.join(input.workDir, input.fileName), fakeJpegBytes);
      },
      outputRouter: { async send() {} },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage, outfitImageGenerated: true }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_generated_outfit",
      toolName: "selfie",
      input: { pose: "挥手" }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(referenceImages.map((image) => path.basename(image)), [
      "alice-character-reference.jpg",
      "uploaded.jpg",
      "magic-library-reference.jpg"
    ]);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie uses default output target for voice call requester", async () => {
  const outputRoot = makeAssetTempDir("selfie-voice-requester");
  const referenceRoot = makeTempDir("selfie-ref-voice-requester");
  const store = createAliceStore(path.join(makeTempDir("selfie-voice-requester-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  writeReferenceFiles(referenceRoot);

  try {
    const defaultTarget = { plugin: "feishu", channelId: "chat-default", sessionId: "session-default" };
    const expectedTarget = {
      plugin: "feishu",
      accountId: undefined,
      channelId: "chat-default",
      userId: undefined,
      sessionId: "session-default"
    };
    const tools = createPhotoTools({
      store,
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T12:00:00.000Z")),
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieExecutor: async (input) => {
        fs.writeFileSync(path.join(input.workDir, input.fileName), fakeJpegBytes);
      },
      outputRouter: {
        async send(output) {
          sent.push(output);
          return { messageId: `om_voice_selfie_${sent.length}` };
        }
      },
      getSelfieContext: selfieContext,
      getDefaultTarget: () => defaultTarget,
      resolveOutputTarget: createToolOutputTargetResolver({
        getDefaultTarget: () => defaultTarget
      })
    });

    const result = await tools.execute({
      id: "call_selfie_voice",
      toolName: "selfie",
      input: { pose: "对镜头挥手" },
      requester: { plugin: "webrtc_voice", channelId: "call-1", userId: "browser-1" },
      externalSession: { scope: "dm", sessionId: "talk-session-1" }
    });

    assert.equal(result.ok, true);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((output) => output.target), [
      expectedTarget,
      expectedTarget
    ]);
    assert.deepEqual(store.listMessagesForConversation("session-default", 10).map((message) => message.contentType), ["text", "image"]);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test("selfie blocks retries in the same agent loop run after generation failure", async () => {
  const outputRoot = makeAssetTempDir("selfie-round-failure");
  const referenceRoot = makeTempDir("selfie-ref-round-failure");
  const store = createAliceStore(path.join(makeTempDir("selfie-round-failure-db"), "alice.sqlite"));
  let executorCalls = 0;
  writeReferenceFiles(referenceRoot);

  try {
    const tools = createPhotoTools({
      store,
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T12:00:00.000Z")),
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieExecutor: async () => {
        executorCalls += 1;
        throw new Error("image api failed");
      },
      outputRouter: { async send() {} },
      getSelfieContext: selfieContext,
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const first = await tools.execute({
      id: "call_selfie_fail_1",
      toolName: "selfie",
      input: { pose: "失败自拍" }
    }, { llmSessionId: 123, agentLoopRunSeq: 4 });

    const sameRoundRetry = await tools.execute({
      id: "call_selfie_fail_2",
      toolName: "selfie",
      input: { pose: "同轮重试" }
    }, { llmSessionId: 123, agentLoopRunSeq: 4 });

    const nextRoundRetry = await tools.execute({
      id: "call_selfie_fail_3",
      toolName: "selfie",
      input: { pose: "下一轮重试" }
    }, { llmSessionId: 123, agentLoopRunSeq: 5 });

    assert.equal(first.ok, false);
    assert.match(first.error ?? "", /image api failed/);
    assert.equal(sameRoundRetry.ok, false);
    assert.equal(sameRoundRetry.error, "selfie is blocked in this agent loop run after a previous failure");
    assert.equal(nextRoundRetry.ok, false);
    assert.match(nextRoundRetry.error ?? "", /image api failed/);
    assert.equal(executorCalls, 2);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test("selfie default openai executor calls Image API directly", async () => {
  const outputRoot = makeAssetTempDir("selfie-openai-direct");
  const referenceRoot = makeTempDir("selfie-ref-openai-direct");
  const outfitImage = path.join(makeTempDir("selfie-outfit-openai-direct"), "dress.jpg");
  const store = createAliceStore(path.join(makeTempDir("selfie-openai-direct-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const previousFetch = globalThis.fetch;
  const previousRunner = process.env.ALICE_SELFIE_FAST_RUNNER;
  let nextMessageId = 1;
  let apiCalled = false;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");
  process.env.ALICE_SELFIE_FAST_RUNNER = "missing-runner-that-openai-mode-must-not-use.mjs";
  globalThis.fetch = (async (url, init) => {
    apiCalled = true;
    assert.equal(String(url), "https://api.openai.com/v1/images/edits");
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, { authorization: "Bearer test-key" });
    const form = init?.body as FormData;
    assert.equal(form.get("model"), "gpt-image-2");
    assert.equal(form.get("n"), "1");
    assert.equal(form.get("size"), "768x1024");
    assert.equal(form.get("quality"), "low");
    assert.equal(form.get("moderation"), "low");
    assert.equal(form.get("output_format"), "jpeg");
    assert.equal(form.get("output_compression"), "45");
    assert.equal(form.getAll("image[]").length, 3);
    assert.doesNotMatch(String(form.get("prompt")), /画幅比例|API生成约束|输入图片顺序/);
    return new Response(JSON.stringify({
      data: [{ b64_json: fakeJpegBytes.toString("base64") }]
    }), { status: 200, statusText: "OK" });
  }) as typeof fetch;

  try {
    const tools = createPhotoTools({
      store,
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T12:00:00.000Z")),
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieImageApiKey: "test-key",
      outputRouter: {
        async send(output) {
          sent.push(output);
          return { messageId: `om_selfie_${nextMessageId++}` };
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_openai_direct",
      toolName: "selfie",
      input: { pose: "靠近镜头" }
    });

    assert.equal(apiCalled, true);
    assert.equal(result.ok, true);
    assert.equal(sent[1].content.kind, "image");
    assert.equal(result.output, "照片已发送");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRunner === undefined) {
      delete process.env.ALICE_SELFIE_FAST_RUNNER;
    } else {
      process.env.ALICE_SELFIE_FAST_RUNNER = previousRunner;
    }
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie openai executor uses openai relay edits route with image field", async () => {
  const outputRoot = makeAssetTempDir("selfie-api-relay");
  const referenceRoot = makeTempDir("selfie-ref-api-relay");
  const outfitImage = path.join(makeTempDir("selfie-outfit-api-relay"), "dress.jpg");
  const store = createAliceStore(path.join(makeTempDir("selfie-api-relay-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const previousFetch = globalThis.fetch;
  let apiCalled = false;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");

  globalThis.fetch = (async (url, init) => {
    apiCalled = true;
    assert.equal(String(url), "https://relay.example.test/v1/images/edits");
    assert.deepEqual(init?.headers, { authorization: "Bearer relay-key" });
    const form = init?.body as FormData;
    assert.equal(form.get("model"), "relay-image-model");
    assert.equal(form.get("n"), "1");
    assert.equal(form.get("size"), "1024x1536");
    assert.equal(form.get("quality"), "medium");
    assert.equal(form.get("moderation"), null);
    assert.equal(form.get("output_format"), null);
    assert.equal(form.get("output_compression"), null);
    assert.equal(form.get("response_format"), null);
    assert.equal(form.getAll("image").length, 3);
    assert.equal(form.getAll("image[]").length, 0);
    assert.deepEqual(form.getAll("image").map((value) => value instanceof File ? value.name : ""), [
      "alice-character-reference.jpg",
      "dress.jpg",
      "magic-library-reference.jpg"
    ]);
    assert.doesNotMatch(String(form.get("prompt")), /画幅比例|API生成约束|输入图片顺序/);
    return new Response(JSON.stringify({
      data: [{ b64_json: fakeJpegBytes.toString("base64") }]
    }), { status: 200, statusText: "OK" });
  }) as typeof fetch;

  try {
    const tools = createPhotoTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieMode: "openaiRelay",
      selfieImageApiKey: "openai-key",
      selfieImageApiBaseURL: "https://api.openai.com/v1",
      selfieImageApiRelayKey: "relay-key",
      selfieImageApiRelayBaseURL: "https://relay.example.test/v1",
      selfieImageApiRelayModel: "relay-image-model",
      selfieImageApiRelaySize: "1024x1536",
      selfieImageApiRelayQuality: "medium",
      selfieImageApiRelayModeration: "auto",
      selfieImageApiRelayOutputFormat: "webp",
      selfieImageApiRelayOutputCompression: 77,
      selfieImageApiRelayTimeoutMs: 90_000,
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_api_relay",
      toolName: "selfie",
      input: { pose: "relay route" }
    });

    assert.equal(result.ok, true);
    assert.equal(apiCalled, true);
    assert.equal(sent[1].content.kind, "image");
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie openai relay fetch failure logs url and cause details", async () => {
  const outputRoot = makeAssetTempDir("selfie-api-relay-failure");
  const referenceRoot = makeTempDir("selfie-ref-api-relay-failure");
  const store = createAliceStore(path.join(makeTempDir("selfie-api-relay-failure-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const logs: string[] = [];
  const previousFetch = globalThis.fetch;
  writeReferenceFiles(referenceRoot);

  globalThis.fetch = (async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), {
      code: "ECONNREFUSED",
      errno: -111,
      syscall: "connect",
      address: "127.0.0.1",
      port: 3000
    });
    throw Object.assign(new Error("fetch failed"), { cause });
  }) as typeof fetch;

  try {
    const tools = createPhotoTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieMode: "openaiRelay",
      selfieImageApiRelayKey: "relay-key",
      selfieImageApiRelayBaseURL: "http://localhost:3000/v1",
      appendLog: (_level, message) => logs.push(message),
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: selfieContext,
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_api_relay_fetch_failure",
      toolName: "selfie",
      input: { pose: "relay failure" }
    });

    const joinedLogs = logs.join("\n");
    assert.equal(result.ok, false);
    assert.match(joinedLogs, /Image API relayEdits request failed/);
    assert.match(joinedLogs, /url=http:\/\/localhost:3000\/v1\/images\/edits/);
    assert.match(joinedLogs, /code=ECONNREFUSED/);
    assert.match(joinedLogs, /address=127\.0\.0\.1/);
    assert.equal(sent[1].content.kind === "text" ? sent[1].content.text : "", "-大失败-");
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test("selfie codex mode calls alice-selfie-fast runner and copies new generated image", async () => {
  const outputRoot = makeAssetTempDir("selfie-codex-mode");
  const referenceRoot = makeTempDir("selfie-ref-codex-mode");
  const outfitImage = path.join(makeTempDir("selfie-outfit-codex-mode"), "dress.jpg");
  const codexDir = makeTempDir("selfie-codex-command");
  const codexPath = path.join(codexDir, "fake-codex.mjs");
  const generatedDir = makeTempDir("selfie-codex-generated");
  const codexHome = makeTempDir("selfie-codex-home");
  const generatedPath = path.join(codexHome, "generated_images", "run-1", "generated.png");
  const argsPath = path.join(codexDir, "args.json");
  const configPath = path.join(makeTempDir("selfie-photo-config"), "config.json");
  const store = createAliceStore(path.join(makeTempDir("selfie-codex-mode-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const previousCodexHome = process.env.CODEX_HOME;
  let nextMessageId = 1;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");
  fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
  fs.writeFileSync(codexPath, [
    "#!/usr/bin/env node",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
    "const args = process.argv.slice(2);",
    "const prompt = args.at(-1) || '';",
    "if (args[0] !== 'exec') process.exit(2);",
    "if (args[1] !== '-C') process.exit(12);",
    "if (fs.readdirSync(args[2]).length !== 3) process.exit(13);",
    "const imageArgs = args.filter((arg) => arg.startsWith('--image='));",
    "if (imageArgs.some((arg) => path.dirname(arg.slice('--image='.length)) !== args[2])) process.exit(14);",
    "if (!args.includes('--ephemeral')) process.exit(3);",
    "if (!args.includes('--ignore-user-config')) process.exit(15);",
    "if (!args.includes('--disable') || !args.includes('plugins') || !args.includes('apps')) process.exit(16);",
    "if (!args.includes('-m') || !args.includes('gpt-5.4-mini')) process.exit(17);",
    "if (!args.includes('-c') || !args.includes('model_reasoning_effort=\"low\"')) process.exit(18);",
    "if (args.includes('--output-last-message')) process.exit(4);",
    "if (prompt.includes('Apply these skill instructions exactly:')) process.exit(5);",
    "if (prompt.includes('Task prompt:')) process.exit(6);",
    "if (prompt.includes('Task metadata:')) process.exit(7);",
    "if (!prompt.includes('1024x1536')) process.exit(9);",
    "if (process.env.SELFIE_IMAGE_API_KEY === 'test-key') process.exit(10);",
    "if (process.env.OPENAI_API_KEY) process.exit(11);",
    `fs.mkdirSync(${JSON.stringify(path.dirname(generatedPath))}, { recursive: true });`,
    `fs.writeFileSync(${JSON.stringify(generatedPath)}, Buffer.from(${JSON.stringify(png1x1Bytes.toString("base64"))}, "base64"));`,
    "console.log(JSON.stringify({ type: 'done' }));"
  ].join("\n"));
  fs.chmodSync(codexPath, 0o755);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    selfieMode: "codex",
    selfieCodexCommand: codexPath
  })}\n`);
  process.env.CODEX_HOME = codexHome;

  try {
    const tools = createPhotoTools({
      store,
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T12:00:00.000Z")),
      selfieConfigPath: configPath,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieImageApiKey: "test-key",
      selfieCodexTimeoutMs: 60_000,
      outputRouter: {
        async send(output) {
          sent.push(output);
          return { messageId: `om_selfie_${nextMessageId++}` };
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_codex_mode",
      toolName: "selfie",
      input: { pose: "转头看镜头" }
    });

    assert.equal(result.ok, true);
    const codexArgs = JSON.parse(fs.readFileSync(argsPath, "utf8")) as string[];
    assert.deepEqual(codexArgs.slice(0, 2), ["exec", "-C"]);
    assert.equal(codexArgs.includes("--ephemeral"), true);
    assert.equal(codexArgs.includes("--ignore-user-config"), true);
    assert.equal(codexArgs.includes("plugins"), true);
    assert.equal(codexArgs.includes("apps"), true);
    assert.equal(codexArgs.includes("gpt-5.4-mini"), true);
    assert.equal(codexArgs.includes('model_reasoning_effort="low"'), true);
    assert.equal(codexArgs.includes("--output-last-message"), false);
    const imageArgs = codexArgs.filter((arg) => arg.startsWith("--image="));
    assert.equal(imageArgs.length, 3);
    assert.deepEqual(imageArgs.map((arg) => path.basename(arg.slice("--image=".length))), ["reference-1.jpg", "reference-2.jpg", "reference-3.jpg"]);
    assert.equal(sent[1].content.kind, "image");
    const sentAssetId = sent[1].content.kind === "image" ? sent[1].content.assetId : "";
    const finalPath = path.join(assetRootFromOutputDir(outputRoot), sentAssetId);
    const finalBytes = fs.readFileSync(finalPath);
    assert.equal(finalBytes[0], 0xff);
    assert.equal(finalBytes[1], 0xd8);
    assert.equal(finalBytes[2], 0xff);
    assert.equal(result.output, "照片已发送");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
    fs.rmSync(generatedDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test("selfie codex mode logs codex stdout and stderr when runner fails", async () => {
  const outputRoot = makeAssetTempDir("selfie-codex-fail-log");
  const referenceRoot = makeTempDir("selfie-ref-codex-fail-log");
  const outfitImage = path.join(makeTempDir("selfie-outfit-codex-fail-log"), "dress.jpg");
  const codexDir = makeTempDir("selfie-codex-fail-command");
  const codexPath = path.join(codexDir, "fake-codex-fail.mjs");
  const codexHome = makeTempDir("selfie-codex-fail-home");
  const configPath = path.join(makeTempDir("selfie-codex-fail-config"), "config.json");
  const store = createAliceStore(path.join(makeTempDir("selfie-codex-fail-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const logs: string[] = [];
  const previousCodexHome = process.env.CODEX_HOME;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");
  fs.writeFileSync(codexPath, [
    "#!/usr/bin/env node",
    "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'test-thread' }));",
    "console.log(JSON.stringify({ type: 'turn.started' }));",
    "console.error('codex stderr failure detail');",
    "process.exit(23);"
  ].join("\n"));
  fs.chmodSync(codexPath, 0o755);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    selfieMode: "codex",
    selfieCodexCommand: codexPath,
    selfieCodexTimeoutMs: 60_000
  })}\n`);
  process.env.CODEX_HOME = codexHome;

  try {
    const tools = createPhotoTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieConfigPath: configPath,
      appendLog: (_level, message) => logs.push(message),
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_codex_fail_log",
      toolName: "selfie",
      input: { pose: "fail and log codex output" }
    });

    const joinedLogs = logs.join("\n");
    assert.equal(result.ok, false);
    assert.match(joinedLogs, /=== codex stdout ===/);
    assert.match(joinedLogs, /"type":"turn\.started"/);
    assert.match(joinedLogs, /=== codex stderr ===/);
    assert.match(joinedLogs, /codex stderr failure detail/);
    assert.match(joinedLogs, /codex-stdout\.jsonl/);
    assert.equal(sent[1].content.kind === "text" ? sent[1].content.text : "", "-大失败-");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test("selfie falls back to text outfit when the outfit reference image is missing", async () => {
  const outputRoot = makeAssetTempDir("selfie-missing-outfit");
  const referenceRoot = makeTempDir("selfie-ref-missing-outfit");
  const store = createAliceStore(path.join(makeTempDir("selfie-missing-outfit-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  let referenceImages: string[] = [];
  let referenceImagePrompt = "";
  writeReferenceFiles(referenceRoot);

  try {
    const tools = createPhotoTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieExecutor: async (input) => {
        referenceImages = input.referenceImages;
        referenceImagePrompt = input.referenceImagePrompt;
        fs.writeFileSync(path.join(input.workDir, input.fileName), fakeJpegBytes);
      },
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: path.join(referenceRoot, "missing.jpg") }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_missing_outfit",
      toolName: "selfie",
      input: { pose: "看镜头" }
    });

    assert.equal(result.ok, true);
    assert.equal(referenceImages.length, 2);
    assert.deepEqual(referenceImages.map((image) => path.basename(image)), ["alice-character-reference.jpg", "magic-library-reference.jpg"]);
    assert.equal(referenceImagePrompt, "");
    assert.equal(sent[0].content.kind, "text");
    assert.equal(sent[0].content.kind === "text" ? sent[0].content.text : "", "-少女拍照中-");
    assert.equal(sent[1].content.kind, "image");
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test("selfie uses world wanderer streetview as reference image 3 when outfit is available", async () => {
  const outputRoot = makeAssetTempDir("selfie-world-wanderer");
  const referenceRoot = makeTempDir("selfie-ref-world-wanderer");
  const outfitImage = path.join(makeTempDir("selfie-outfit-world-wanderer"), "dress.jpg");
  const streetViewImage = path.join(makeTempDir("selfie-streetview-world-wanderer"), "street.jpg");
  const store = createAliceStore(path.join(makeTempDir("selfie-world-wanderer-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  let referenceImages: string[] = [];
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");
  fs.writeFileSync(streetViewImage, fakeJpegBytes);

  try {
    const tools = createPhotoTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      getWorldWandererStreetViewReferenceImage: () => streetViewImage,
      selfieExecutor: async (input) => {
        referenceImages = input.referenceImages;
        fs.writeFileSync(path.join(input.workDir, input.fileName), fakeJpegBytes);
      },
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_world_wanderer",
      toolName: "selfie",
      input: { pose: "在当前位置自拍" }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(referenceImages.map((image) => path.basename(image)), [
      "alice-character-reference.jpg",
      "dress.jpg",
      "street.jpg"
    ]);
    assert.equal(sent[1].content.kind, "image");
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
    fs.rmSync(path.dirname(streetViewImage), { recursive: true, force: true });
  }
});

test("selfie does not keep streetview as image 3 when outfit reference is missing", async () => {
  const outputRoot = makeAssetTempDir("selfie-world-wanderer-missing-outfit");
  const referenceRoot = makeTempDir("selfie-ref-world-wanderer-missing-outfit");
  const streetViewImage = path.join(makeTempDir("selfie-streetview-missing-outfit"), "street.jpg");
  const store = createAliceStore(path.join(makeTempDir("selfie-world-wanderer-missing-outfit-db"), "alice.sqlite"));
  let referenceImages: string[] = [];
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(streetViewImage, fakeJpegBytes);

  try {
    const tools = createPhotoTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      getWorldWandererStreetViewReferenceImage: () => streetViewImage,
      selfieExecutor: async (input) => {
        referenceImages = input.referenceImages;
        fs.writeFileSync(path.join(input.workDir, input.fileName), fakeJpegBytes);
      },
      outputRouter: { async send() {} },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: path.join(referenceRoot, "missing.jpg") }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_world_wanderer_missing_outfit",
      toolName: "selfie",
      input: { pose: "服装图缺失时自拍" }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(referenceImages.map((image) => path.basename(image)), [
      "alice-character-reference.jpg",
      "street.jpg"
    ]);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(streetViewImage), { recursive: true, force: true });
  }
});

test("selfie fails when world wanderer streetview lookup fails", async () => {
  const outputRoot = makeAssetTempDir("selfie-world-wanderer-fail");
  const referenceRoot = makeTempDir("selfie-ref-world-wanderer-fail");
  const outfitImage = path.join(makeTempDir("selfie-outfit-world-wanderer-fail"), "dress.jpg");
  const store = createAliceStore(path.join(makeTempDir("selfie-world-wanderer-fail-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  let executorCalled = false;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");

  try {
    const tools = createPhotoTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      getWorldWandererStreetViewReferenceImage: () => {
        throw new Error("streetview unavailable");
      },
      selfieExecutor: async () => {
        executorCalled = true;
      },
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_world_wanderer_fail",
      toolName: "selfie",
      input: { pose: "街景失败时自拍" }
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /streetview unavailable/);
    assert.equal(executorCalled, false);
    assert.equal(sent[0].content.kind === "text" ? sent[0].content.text : "", "-少女拍照中-");
    assert.equal(sent[1].content.kind === "text" ? sent[1].content.text : "", "-大失败-");
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie sends start notice before required reference failures", async () => {
  const outputRoot = makeAssetTempDir("selfie-missing-character");
  const referenceRoot = makeTempDir("selfie-ref-missing-character");
  const outfitImage = path.join(makeTempDir("selfie-outfit-missing-character"), "dress.jpg");
  const store = createAliceStore(path.join(makeTempDir("selfie-missing-character-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  writeReferenceFiles(referenceRoot);
  fs.rmSync(path.join(referenceRoot, "alice-character-reference.jpg"));
  fs.writeFileSync(outfitImage, "dress-image");

  try {
    const tools = createPhotoTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieExecutor: async () => {
        throw new Error("executor should not run");
      },
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_missing_character",
      toolName: "selfie",
      input: { pose: "看镜头" }
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /character reference/);
    assert.equal(sent[0].content.kind === "text" ? sent[0].content.text : "", "-少女拍照中-");
    assert.equal(sent[1].content.kind === "text" ? sent[1].content.text : "", "-大失败-");
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie cleans up temporary directory when codex does not create the requested image", async () => {
  const outputRoot = makeAssetTempDir("selfie-missing");
  const referenceRoot = makeTempDir("selfie-ref-missing");
  const outfitImage = path.join(makeTempDir("selfie-outfit-missing"), "dress.jpg");
  const store = createAliceStore(path.join(makeTempDir("selfie-missing-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  let workDir = "";
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");

  try {
    const tools = createPhotoTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieExecutor: async (input) => {
        workDir = input.workDir;
        return { stdout: "done", lastMessage: "I could not create the requested file" };
      },
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_missing",
      toolName: "selfie",
      input: { pose: "missing file" }
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /not found/);
    assert.match(result.error ?? "", /I could not create/);
    assert.equal(fs.existsSync(workDir), false);
    assert.equal(sent[0].content.kind, "text");
    assert.equal(sent[0].content.kind === "text" ? sent[0].content.text : "", "-少女拍照中-");
    assert.equal(sent[1].content.kind, "text");
    assert.equal(sent[1].content.kind === "text" ? sent[1].content.text : "", "-大失败-");
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie rejects output directories outside assets", async () => {
  const referenceRoot = makeTempDir("selfie-ref-outside");
  const outfitImage = path.join(makeTempDir("selfie-outfit-outside"), "dress.jpg");
  const store = createAliceStore(path.join(makeTempDir("selfie-outside-db"), "alice.sqlite"));
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");
  try {
    const tools = createPhotoTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: makeTempDir("selfie-outside"),
      selfieExecutor: async () => {},
      outputRouter: { async send() {} },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_outside",
      toolName: "selfie",
      input: { pose: "outside assets" }
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /inside assets/);
  } finally {
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

function providerInput(prompt: string, referenceImages: string[]): SelfieExecutorInput {
  return {
    command: "",
    workDir: "",
    fileName: "image.jpg",
    prompt,
    referenceImages,
    referenceImagePrompt: "",
    timeoutMs: 1000,
    apiBaseURL: "https://api.example.test/v1",
    apiEndpoint: "edits",
    apiModel: "image-model",
    apiSize: "768x1024",
    apiQuality: "low",
    apiModeration: "low",
    apiOutputFormat: "jpeg",
    apiOutputCompression: 45,
    apiTimeoutMs: 1000
  };
}

function selfieContext() {
  return {
    mainPrompt: [
      "你是爱丽丝",
      "",
      "外貌特征:",
      "发色: 低饱和浅金色",
      "眼睛: 浅金色",
      "",
      "你与 <user> 的根关系是造物和造主"
    ].join("\n"),
    personalityName: "弱气",
    personalityContent: "说话声音很小",
    outfitId: "gothic_lolita_black",
    outfitName: "黑色哥特洛丽塔",
    outfitContent: "黑色薄纱短袖高领上衣"
  };
}

function writeReferenceFiles(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "selfie-prompt.txt"), [
    "当前时间:",
    "{{time}}",
    "角色动作:",
    "{{pose}}",
    "角色特征:",
    "{{appearance}}",
    "{{dailyShell/persona/content}}",
    "服装特征:",
    "{{outfit/content}}"
  ].join("\n"));
  fs.writeFileSync(path.join(root, "alice-character-reference.jpg"), "alice-image");
  fs.writeFileSync(path.join(root, "magic-library-reference.jpg"), "library-image");
}

function makeAssetTempDir(name: string): string {
  const dir = path.join(makeTempDir(`${name}-asset-root`), "assets", "generated", `test-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function assetRootFromOutputDir(outputDir: string): string {
  return path.resolve(outputDir, "..", "..");
}

function makeTempDir(name: string): string {
  const dir = path.join(process.cwd(), ".tmp-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
