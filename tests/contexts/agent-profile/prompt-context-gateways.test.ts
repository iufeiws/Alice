import { test } from "node:test";
import assert from "node:assert/strict";
import { createLLMRequests } from "../../../src/contexts/llm-gateway/src/llm-requests.js";
import { resolveTtsText } from "../../../src/channels/tts/src/index.js";
import { transcribeMultimodalLlm } from "../../../src/channels/asr/src/multimodal-llm.js";
import { recognizeImageWithPlugin } from "../../../src/channels/image-recognition/src/index.js";
import { createPhotoTools, type SelfieExecutorInput } from "../../../src/capabilities/tools/photo/src/index.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";
import { testLLMApiPreset } from "../../helpers/llm-api-preset.js";
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
} from "../../capabilities/tools/photo/photo-tools-helpers.js";

const unresolvedVariable = /\{\{\s*[a-zA-Z0-9_/]+\s*\}\}/;

test("LLM tool gateway resolves scoped prompt variables", () => {
  const requests = createLLMRequests({
    getTool: () => ({
      name: "RuntimeTool",
      description: "pose=${{pose}}",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string", description: "round=${{round}}" } }
      },
      execute: async () => ({ callId: "unused", ok: true })
    })
  });

  const tools = requests.buildTools(["RuntimeTool"], testPromptRuntime().withVariables({ pose: "看镜头", round: 2 }));
  const serialized = JSON.stringify(tools);

  assert.match(serialized, /看镜头/);
  assert.doesNotMatch(serialized, unresolvedVariable);
});

test("TTS gateway resolves scoped prompt variables before its LLM request", async () => {
  let systemPrompt = "";
  const runtime = testPromptRuntime().withVariables({ speakingStyle: "轻声" });

  await resolveTtsText("你好", {
    translationEnabled: true,
    prompt: "Translate with ${{speakingStyle}}.",
    apiPresetName: "test"
  } as any, {
    baseSynthesizer: async () => ({ assetId: "unused", filePath: "unused" }),
    promptRenderer: runtime,
    resolveApiPreset: () => testLLMApiPreset({ model: "test" }),
    llmRequestSender: async (input) => {
      systemPrompt = input.messages[0]?.content ?? "";
      return { message: { role: "assistant", content: "こんにちは" } };
    }
  });

  assert.equal(systemPrompt, "Translate with 轻声.");
  assert.doesNotMatch(systemPrompt, unresolvedVariable);
});

test("Photo gateway resolves scoped prompt variables before image generation", async () => {
  const outputRoot = makeAssetTempDir("prompt-context-photo-gateway");
  const referenceRoot = makeTempDir("prompt-context-photo-gateway-ref");
  const outfitImage = path.join(makeTempDir("prompt-context-photo-gateway-outfit"), "dress.jpg");
  const executorInputs: SelfieExecutorInput[] = [];
  let messageId = 0;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");

  try {
    const tools = createPhotoTools({
      store: createTestStore("prompt-context-photo-gateway-store"),
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T12:00:00.000Z")),
      promptContextRuntime: testPromptRuntime(),
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieExecutor: async (input) => {
        executorInputs.push(input);
        fs.writeFileSync(path.join(input.workDir, input.fileName), fakeJpegBytes);
        return { stdout: "ok", stderr: "", lastMessage: "saved" };
      },
      outputRouter: { send: async () => ({ messageId: `photo-${++messageId}` }) },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({ id: "photo-1", toolName: "Selfie", input: { pose: "看镜头挥手" } });
    assert.equal(result.ok, true, result.error);
    assert.match(executorInputs[0].prompt, /看镜头挥手/);
    assert.doesNotMatch(executorInputs[0].prompt, unresolvedVariable);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("ASR and image-recognition gateways reject prompts without a runtime", async () => {
  await assert.rejects(
    () => transcribeMultimodalLlm({ audioFile: new Uint8Array([1]), filename: "audio.wav" }, {
      enabled: true,
      defaultProvider: "multimodal_llm",
      providers: { multimodalLlm: { prompt: "${{runtimeValue}}" } }
    }, {}),
    /prompt_context_runtime_required/
  );

  const imageResult = await recognizeImageWithPlugin(
    { imageFile: new Uint8Array([1]), filename: "image.jpg" },
    { enabled: true, prompt: "${{runtimeValue}}" },
    {}
  );
  assert.deepEqual(imageResult, {
    ok: false,
    error: "provider_request_failed",
    message: "prompt_context_runtime_required"
  });
});
