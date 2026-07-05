import { test } from "node:test";
import { testPromptRuntime } from "../../../helpers/prompt-runtime.js";
import assert from "node:assert/strict";
import { createPhotoTools } from "../../../../src/capabilities/tools/photo/src/index.js";
import type { AgentOutput } from "../../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import {
  assetRootFromOutputDir,
  createTestStore,
  fakeJpegBytes,
  fs,
  makeAssetTempDir,
  makeTempDir,
  path,
  selfieContext,
  writeReferenceFiles
} from "./photo-tools-helpers.js";

test("selfie_missingOutfitImage_usesTextOutfitAndSendsImage", async () => {
  const outputRoot = makeAssetTempDir("selfie-missing-outfit");
  const referenceRoot = makeTempDir("selfie-ref-missing-outfit");
  const store = createTestStore("selfie-missing-outfit-db");
  const sent: AgentOutput[] = [];
  let referenceImages: string[] = [];
  let referenceImagePrompt = "";
  writeReferenceFiles(referenceRoot);

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
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
      toolName: "Selfie",
      input: { pose: "看镜头" }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(referenceImages.map((image) => path.basename(image)), ["alice-character-reference.jpg", "magic-library-reference.jpg"]);
    assert.equal(referenceImagePrompt, "");
    assert.equal(sent[0].content.kind === "text" ? sent[0].content.text : "", "-少女拍照中-");
    assert.equal(sent[1].content.kind, "image");
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test("selfie_worldWandererStreetviewAvailable_usesStreetviewAsThirdReference", async () => {
  const outputRoot = makeAssetTempDir("selfie-world-wanderer");
  const referenceRoot = makeTempDir("selfie-ref-world-wanderer");
  const outfitImage = path.join(makeTempDir("selfie-outfit-world-wanderer"), "dress.jpg");
  const streetViewImage = path.join(makeTempDir("selfie-streetview-world-wanderer"), "street.jpg");
  const store = createTestStore("selfie-world-wanderer-db");
  const sent: AgentOutput[] = [];
  let referenceImages: string[] = [];
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");
  fs.writeFileSync(streetViewImage, fakeJpegBytes);

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
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
      toolName: "Selfie",
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

test("selfie_worldWandererWithoutOutfit_keepsStreetviewReference", async () => {
  const outputRoot = makeAssetTempDir("selfie-world-wanderer-missing-outfit");
  const referenceRoot = makeTempDir("selfie-ref-world-wanderer-missing-outfit");
  const streetViewImage = path.join(makeTempDir("selfie-streetview-missing-outfit"), "street.jpg");
  const store = createTestStore("selfie-world-wanderer-missing-outfit-db");
  let referenceImages: string[] = [];
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(streetViewImage, fakeJpegBytes);

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
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
      toolName: "Selfie",
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

test("selfie_worldWandererLookupFails_returnsErrorWithoutRunningExecutor", async () => {
  const outputRoot = makeAssetTempDir("selfie-world-wanderer-fail");
  const referenceRoot = makeTempDir("selfie-ref-world-wanderer-fail");
  const outfitImage = path.join(makeTempDir("selfie-outfit-world-wanderer-fail"), "dress.jpg");
  const store = createTestStore("selfie-world-wanderer-fail-db");
  let executorCalled = false;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
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
      outputRouter: { async send() {} },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_world_wanderer_fail",
      toolName: "Selfie",
      input: { pose: "街景失败时自拍" }
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /streetview unavailable/);
    assert.equal(executorCalled, false);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie_worldWandererLookupFails_sendsFailureNotice", async () => {
  const outputRoot = makeAssetTempDir("selfie-world-wanderer-fail-notice");
  const referenceRoot = makeTempDir("selfie-ref-world-wanderer-fail-notice");
  const outfitImage = path.join(makeTempDir("selfie-outfit-world-wanderer-fail-notice"), "dress.jpg");
  const store = createTestStore("selfie-world-wanderer-fail-notice-db");
  const sent: AgentOutput[] = [];
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      getWorldWandererStreetViewReferenceImage: () => {
        throw new Error("streetview unavailable");
      },
      selfieExecutor: async () => {},
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    await tools.execute({
      id: "call_selfie_world_wanderer_fail",
      toolName: "Selfie",
      input: { pose: "街景失败时自拍" }
    });

    assert.equal(sent[1].content.kind === "text" ? sent[1].content.text : "", "-大失败-");
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie_requiredReferenceMissing_sendsStartThenFailureNotice", async () => {
  const outputRoot = makeAssetTempDir("selfie-missing-character");
  const referenceRoot = makeTempDir("selfie-ref-missing-character");
  const outfitImage = path.join(makeTempDir("selfie-outfit-missing-character"), "dress.jpg");
  const store = createTestStore("selfie-missing-character-db");
  const sent: AgentOutput[] = [];
  writeReferenceFiles(referenceRoot);
  fs.rmSync(path.join(referenceRoot, "alice-character-reference.jpg"));
  fs.writeFileSync(outfitImage, "dress-image");

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
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
      toolName: "Selfie",
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

test("selfie_generatedFileMissing_returnsMissingFileError", async () => {
  const outputRoot = makeAssetTempDir("selfie-missing");
  const referenceRoot = makeTempDir("selfie-ref-missing");
  const outfitImage = path.join(makeTempDir("selfie-outfit-missing"), "dress.jpg");
  const store = createTestStore("selfie-missing-db");
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieExecutor: async () => {
        return { stdout: "done", lastMessage: "I could not create the requested file" };
      },
      outputRouter: { async send() {} },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_missing",
      toolName: "Selfie",
      input: { pose: "missing file" }
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /not found/);
    assert.match(result.error ?? "", /I could not create/);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie_generatedFileMissing_cleansWorkDir", async () => {
  const outputRoot = makeAssetTempDir("selfie-missing-cleanup");
  const referenceRoot = makeTempDir("selfie-ref-missing-cleanup");
  const outfitImage = path.join(makeTempDir("selfie-outfit-missing-cleanup"), "dress.jpg");
  const store = createTestStore("selfie-missing-cleanup-db");
  let workDir = "";
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieExecutor: async (input) => {
        workDir = input.workDir;
        return { stdout: "done", lastMessage: "I could not create the requested file" };
      },
      outputRouter: { async send() {} },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    await tools.execute({
      id: "call_selfie_missing",
      toolName: "Selfie",
      input: { pose: "missing file" }
    });

    assert.equal(workDir.startsWith(outputRoot), true);
    assert.equal(fs.existsSync(workDir), false);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie_generatedFileMissing_sendsFailureNotice", async () => {
  const outputRoot = makeAssetTempDir("selfie-missing-notice");
  const referenceRoot = makeTempDir("selfie-ref-missing-notice");
  const outfitImage = path.join(makeTempDir("selfie-outfit-missing-notice"), "dress.jpg");
  const store = createTestStore("selfie-missing-notice-db");
  const sent: AgentOutput[] = [];
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieExecutor: async () => ({ stdout: "done", lastMessage: "I could not create the requested file" }),
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    await tools.execute({
      id: "call_selfie_missing",
      toolName: "Selfie",
      input: { pose: "missing file" }
    });

    assert.equal(sent[1].content.kind === "text" ? sent[1].content.text : "", "-大失败-");
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie_outputDirOutsideAssets_returnsContractError", async () => {
  const referenceRoot = makeTempDir("selfie-ref-outside");
  const outfitImage = path.join(makeTempDir("selfie-outfit-outside"), "dress.jpg");
  const store = createTestStore("selfie-outside-db");
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
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
      toolName: "Selfie",
      input: { pose: "outside assets" }
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /inside assets/);
  } finally {
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});
