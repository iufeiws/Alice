import { test } from "node:test";
import assert from "node:assert/strict";
import { createPhotoTools, type SelfieExecutorInput } from "../../../../src/capabilities/tools/photo/src/index.js";
import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";
import { createToolOutputTargetResolver } from "../../../../src/contexts/capabilities/src/tool-output-target.js";
import type { AgentOutput } from "../../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import {
  assetRootFromOutputDir,
  createTestStore,
  fakeJpegBytes,
  fs,
  makeAssetTempDir,
  makeTempDir,
  path,
  png1x1Bytes,
  selfieContext,
  writeReferenceFiles
} from "./photo-tools-helpers.js";

test("selfie_validContext_sendsImageAndPersistsMessages", async () => {
  const outputRoot = makeAssetTempDir("selfie-success");
  const referenceRoot = makeTempDir("selfie-ref");
  const outfitImage = path.join(makeTempDir("selfie-outfit"), "dress.jpg");
  const store = createTestStore("selfie-db");
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
      toolName: "Selfie",
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

test("selfie_2DinRealEnabled_usesReplacementReference", async () => {
  const outputRoot = makeAssetTempDir("selfie-2dinreal");
  const referenceRoot = makeTempDir("selfie-ref-2dinreal");
  const ref2DinReal = path.join(referenceRoot, "2dinreal-reference.jpg");
  const store = createTestStore("selfie-2dinreal-db");
  let executorInput: SelfieExecutorInput | undefined;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(ref2DinReal, "2dinreal-image");

  try {
    const tools = createPhotoTools({
      store,
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T12:00:00.000Z")),
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfie2DinRealEnabled: true,
      selfie2DinRealReferenceImage: ref2DinReal,
      selfie2DinRealPrompt: "  2DinReal prompt\n",
      selfieExecutor: async (input) => {
        executorInput = input;
        fs.writeFileSync(path.join(input.workDir, input.fileName), fakeJpegBytes);
        return { stdout: "ok" };
      },
      outputRouter: { async send() {} },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: path.join(referenceRoot, "missing-outfit.jpg") }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_2dinreal",
      toolName: "Selfie",
      input: { pose: "看镜头" }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(executorInput?.referenceImages.map((image) => path.basename(image)), [
      "2dinreal-reference.jpg",
      "magic-library-reference.jpg"
    ]);
    assert.match(executorInput?.prompt ?? "", /黑色薄纱短袖高领上衣\n\n  2DinReal prompt\n$/);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test("selfie_nonJpegOutput_convertsAttachmentToJpeg", async () => {
  const outputRoot = makeAssetTempDir("selfie-png-conversion");
  const referenceRoot = makeTempDir("selfie-ref-png-conversion");
  const store = createTestStore("selfie-png-conversion-db");
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
      toolName: "Selfie",
      input: { pose: "拍一张 PNG 结果的测试自拍" }
    }, { llmCapabilities: { supportsImage: true } });

    assert.equal(result.ok, true);
    assert.equal(sent[1].content.kind, "image");
    assert.match(sent[1].content.kind === "image" ? sent[1].content.assetId : "", /\/selfie_20260526_120000\.jpg$/);
    assert.equal(result.llmFollowupAttachments?.[0]?.mime, "image/jpeg");
    const finalBytes = fs.readFileSync(result.llmFollowupAttachments?.[0]?.path ?? "");
    assert.deepEqual([...finalBytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test("selfie_storedOnBodyReference_usesStandardPrompt", async () => {
  const outputRoot = makeAssetTempDir("selfie-on-body-reference");
  const referenceRoot = makeTempDir("selfie-ref-on-body-reference");
  const onBodyImage = path.join(makeTempDir("selfie-on-body-image"), "dress.On_Body_Ref.jpg");
  const store = createTestStore("selfie-on-body-db");
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
      toolName: "Selfie",
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

test("selfie_generatedOutfitImage_usesCurrentOutfitAsReference", async () => {
  const outputRoot = makeAssetTempDir("selfie-generated-outfit-reference");
  const referenceRoot = makeTempDir("selfie-ref-generated-outfit-reference");
  const outfitImage = path.join(makeTempDir("selfie-generated-outfit-image"), "uploaded.jpg");
  const store = createTestStore("selfie-generated-outfit-db");
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
      toolName: "Selfie",
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

test("selfie_voiceRequester_usesDefaultOutputTarget", async () => {
  const outputRoot = makeAssetTempDir("selfie-voice-requester");
  const referenceRoot = makeTempDir("selfie-ref-voice-requester");
  const store = createTestStore("selfie-voice-requester-db");
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
      toolName: "Selfie",
      input: { pose: "对镜头挥手" },
      requester: { plugin: "webrtc_voice", channelId: "call-1", userId: "browser-1" },
      externalSession: { scope: "dm", sessionId: "talk-session-1" }
    });

    assert.equal(result.ok, true);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((output) => output.target), [expectedTarget, expectedTarget]);
    assert.deepEqual(store.listMessagesForConversation("session-default", 10).map((message) => message.contentType), ["text", "image"]);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test("selfie_sameLoopFailure_blocksRetryUntilNextRun", async () => {
  const outputRoot = makeAssetTempDir("selfie-round-failure");
  const referenceRoot = makeTempDir("selfie-ref-round-failure");
  const store = createTestStore("selfie-round-failure-db");
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
      toolName: "Selfie",
      input: { pose: "失败自拍" }
    }, { llmSessionId: 123, agentLoopRunSeq: 4 });
    const sameRoundRetry = await tools.execute({
      id: "call_selfie_fail_2",
      toolName: "Selfie",
      input: { pose: "同轮重试" }
    }, { llmSessionId: 123, agentLoopRunSeq: 4 });
    const nextRoundRetry = await tools.execute({
      id: "call_selfie_fail_3",
      toolName: "Selfie",
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
