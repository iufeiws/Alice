import { test } from "node:test";
import assert from "node:assert/strict";
import { recognizeImageWithPlugin, type ImageRecognitionConfig } from "../../../src/channels/image-recognition/src/index.js";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";

function multimodalPreset(name = "mimo") {
  return {
    name,
    baseURL: "https://api.example.test/v1",
    apiKey: "secret",
    model: "mimo-v2.5",
    temperature: 0.2,
    timeoutMs: 120_000,
    stream: false,
    extraParams: { presetValue: true },
    followupExtraParams: {}
  };
}

test("recognizeImageWithPlugin_sendsImagePromptAndPluginExtraParams", async () => {
  let capturedRequest: any;
  const config: ImageRecognitionConfig = {
    enabled: true,
    apiPresetName: "mimo",
    prompt: "configured prompt",
    extraParams: {
      max_completion_tokens: 8192
    }
  };

  const result = await recognizeImageWithPlugin({
    imageFile: new Uint8Array([1, 2, 3]),
    filename: "photo.jpg",
    mimeType: "image/jpeg"
  }, config, {
    promptRenderer: testPromptRuntime(),
    resolveApiPreset(name) {
      assert.equal(name, "mimo");
      return multimodalPreset(name);
    },
    createLlmClientFromPreset(preset) {
      assert.equal(preset.model, "mimo-v2.5");
      return { async chat() { return { message: { role: "assistant", content: "" } }; } };
    },
    async llmRequestSender(request) {
      capturedRequest = request;
      return {
        id: "chatcmpl_image",
        model: "mimo-v2.5",
        finishReason: "stop",
        message: {
          role: "assistant",
          content: "一张图片描述"
        }
      };
    }
  });

  assert.equal("ok" in result, false);
  if ("ok" in result) assert.fail(result.error);
  assert.ok(result.text);
  assert.equal(result.provider, "multimodal_llm");
  assert.equal(result.model, "mimo-v2.5");
  assert.equal(result.requestId, "chatcmpl_image");
  assert.equal(capturedRequest.agentId, "image_recognition");
  assert.equal(capturedRequest.presetName, "mimo");
  assert.equal(capturedRequest.stream, false);
  assert.deepEqual(capturedRequest.toolNames, []);
  assert.deepEqual(capturedRequest.extraParams, config.extraParams);
  assert.equal(capturedRequest.messages[0].role, "user");
  assert.equal(capturedRequest.messages[0].content[0].type, "image_url");
  assert.equal(typeof capturedRequest.messages[0].content[0].image_url.url, "string");
  assert.ok(capturedRequest.messages[0].content[1].text);
  assert.deepEqual(capturedRequest.metadata, {
    pluginId: "image-recognition",
    filename: "photo.jpg",
    mimeType: "image/jpeg"
  });
});

test("recognizeImageWithPlugin_rejectsNonImageMime", async () => {
  const result = await recognizeImageWithPlugin({
    imageFile: new Uint8Array([1]),
    filename: "note.txt",
    mimeType: "text/plain"
  }, {
    enabled: true,
    apiPresetName: "mimo",
    prompt: "configured prompt"
  }, {
    promptRenderer: testPromptRuntime(),
    resolveApiPreset() {
      return multimodalPreset();
    },
    createLlmClientFromPreset() {
      return { async chat() { return { message: { role: "assistant", content: "" } }; } };
    },
    async llmRequestSender() {
      throw new Error("should not send non-image");
    }
  });

  assert.equal("ok" in result, true);
  if (!("ok" in result)) assert.fail("expected image recognition error");
  assert.equal(result.ok, false);
});
