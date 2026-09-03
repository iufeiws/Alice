import { test } from "node:test";
import assert from "node:assert/strict";
import { transcribeWithAsrPlugin, type AsrPluginConfig } from "../../../src/channels/asr/src/index.js";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";
import { assertAsrError, assertAsrSuccess } from "./asr-plugin-helpers.js";

function multimodalPreset(name = "mimo") {
  return {
    name,
    baseURL: "https://api.example.test/v1",
    credentialId: "test-credential",
    model: "mimo-v2.5",
    temperature: 0.2,
    timeoutMs: 120_000,
    stream: false,
    extraParams: {},
    followupExtraParams: {}
  };
}

test("multimodalLlm_toolCall_returnsSpeechTextAndRequestContract", async () => {
  const audioFile = new Uint8Array([1, 2, 3]);
  let capturedRequest: any;
  const config: AsrPluginConfig = {
    enabled: true,
    defaultProvider: "multimodal_llm",
    providers: {
      multimodalLlm: {
        apiPresetName: "mimo",
        prompt: "configured prompt",
        extraParams: {
          tool_choice: {
            type: "function",
            function: { name: "submit_audio_context" }
          }
        }
      }
    }
  };

  const result = await transcribeWithAsrPlugin({
    audioFile,
    filename: "speech.wav",
    mimeType: "audio/wav",
    metadata: { source: "unit-test" }
  }, config, {
    promptRenderer: testPromptRuntime(),
    resolveApiPreset(name: string) {
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
        id: "chatcmpl_asr",
        model: "mimo-v2.5",
        finishReason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "submit_audio_context",
              arguments: JSON.stringify({ speakText: "こんにちは", emotion: "calm", description: "" })
            }
          }]
        }
      };
    }
  });

  assertAsrSuccess(result);
  assert.equal(result.provider, "multimodal_llm");
  assert.equal(result.model, "mimo-v2.5");
  assert.equal(result.requestId, "chatcmpl_asr");
  assert.equal(capturedRequest.agentId, "asr");
  assert.equal(capturedRequest.presetName, "mimo");
  assert.equal(capturedRequest.stream, false);
  assert.deepEqual(capturedRequest.toolNames, ["submit_audio_context"]);
  assert.equal(capturedRequest.inlineTools[0].name, "submit_audio_context");
  assert.deepEqual(capturedRequest.extraParams, config.providers.multimodalLlm?.extraParams);
  assert.equal(capturedRequest.messages[0].role, "user");
  assert.equal(capturedRequest.messages[0].content[0].type, "input_audio");
  assert.equal(typeof capturedRequest.messages[0].content[0].input_audio.data, "string");
  assert.equal(capturedRequest.toolVariables, undefined);
  assert.deepEqual(capturedRequest.metadata, {
    pluginId: "asr",
    provider: "multimodal_llm",
    filename: "speech.wav",
    mimeType: "audio/wav"
  });
});

test("multimodalLlm_emptySpeech_returnsDescriptionText", async () => {
  const result = await transcribeWithAsrPlugin({
    audioFile: new Uint8Array([1, 2, 3]),
    filename: "noise.mp3",
    mimeType: "audio/mpeg"
  }, {
    enabled: true,
    defaultProvider: "multimodal_llm",
    providers: {
      multimodalLlm: {
        apiPresetName: "mimo",
        prompt: "configured prompt"
      }
    }
  }, {
    promptRenderer: testPromptRuntime(),
    resolveApiPreset() {
      return multimodalPreset();
    },
    createLlmClientFromPreset() {
      return { async chat() { return { message: { role: "assistant", content: "" } }; } };
    },
    async llmRequestSender() {
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "submit_audio_context",
              arguments: JSON.stringify({ speakText: "", emotion: "", description: "door knock" })
            }
          }]
        }
      };
    }
  });

  assertAsrSuccess(result);
  assert.ok(result.text);
});

test("multimodalLlm_defaultConfig_sendsToolRequestAndReturnsText", async () => {
  let capturedRequest: any;
  const result = await transcribeWithAsrPlugin({
    audioFile: new Uint8Array([1]),
    filename: "speech.wav"
  }, {
    enabled: true,
    defaultProvider: "multimodal_llm",
    providers: {
      multimodalLlm: {
        apiPresetName: "mimo"
      }
    }
  }, {
    promptRenderer: testPromptRuntime(),
    resolveApiPreset() {
      return multimodalPreset();
    },
    createLlmClientFromPreset() {
      return { async chat() { return { message: { role: "assistant", content: "" } }; } };
    },
    async llmRequestSender(request) {
      capturedRequest = request;
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "submit_audio_context",
              arguments: JSON.stringify({ speakText: "default prompt works", emotion: "calm", description: "" })
            }
          }]
        }
      };
    }
  });

  assertAsrSuccess(result);
  assert.deepEqual(capturedRequest.toolNames, ["submit_audio_context"]);
  assert.equal(capturedRequest.inlineTools[0].name, "submit_audio_context");
  assert.equal(capturedRequest.extraParams.tool_choice.function.name, "submit_audio_context");
});

test("multimodalLlm_missingPrompt_returnsProviderConfigError", async () => {
  const result = await transcribeWithAsrPlugin({
    audioFile: new Uint8Array([1]),
    filename: "speech.wav"
  }, {
    enabled: true,
    defaultProvider: "multimodal_llm",
    providers: {
      multimodalLlm: {
        apiPresetName: "mimo",
        prompt: ""
      }
    }
  }, {
    promptRenderer: testPromptRuntime(),
    resolveApiPreset() {
      return multimodalPreset();
    },
    createLlmClientFromPreset() {
      return { async chat() { return { message: { role: "assistant", content: "" } }; } };
    },
    async llmRequestSender() {
      throw new Error("should not send without prompt");
    }
  });
  assertAsrError(result);
  assert.equal(result.error, "missing_provider_config");
});

test("multimodalLlm_missingToolCall_returnsProviderRequestError", async () => {
  const result = await transcribeWithAsrPlugin({
    audioFile: new Uint8Array([1]),
    filename: "speech.wav"
  }, {
    enabled: true,
    defaultProvider: "multimodal_llm",
    providers: {
      multimodalLlm: {
        apiPresetName: "mimo",
        prompt: "configured prompt"
      }
    }
  }, {
    promptRenderer: testPromptRuntime(),
    resolveApiPreset() {
      return multimodalPreset();
    },
    createLlmClientFromPreset() {
      return { async chat() { return { message: { role: "assistant", content: "" } }; } };
    },
    async llmRequestSender() {
      return { message: { role: "assistant", content: "no tool" } };
    }
  });
  assertAsrError(result);
  assert.equal(result.error, "provider_request_failed");
  assert.equal(result.message, "multimodal_llm_asr_missing_tool_call");
});
