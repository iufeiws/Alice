import test from "node:test";
import assert from "node:assert/strict";
import { assertPiPresetCompatible, createPiPresetSnapshot, piModelConfig } from "../../../src/contexts/llm-gateway/src/pi-preset-adapter.js";

const preset = {
  name: "local",
  baseURL: "https://upstream.example/v1/",
  apiKey: "secret",
  model: "model-a",
  temperature: 0.3,
  timeoutMs: 10_000,
  stream: true,
  supportsImage: true,
  supportsAudio: false,
  maxTokens: 1024,
  extraParams: { top_p: 0.8 },
  followupExtraParams: {}
};

test("Pi preset snapshot retains only approved upstream fields", () => {
  const snapshot = createPiPresetSnapshot(preset);
  assert.deepEqual(snapshot, {
    name: "local",
    baseURL: "https://upstream.example/v1",
    apiKey: "secret",
    model: "model-a",
    temperature: 0.3,
    maxTokens: 1024,
    timeoutMs: 10_000,
    supportsImage: true,
    extraParams: { top_p: 0.8 }
  });
  assert.deepEqual(piModelConfig(snapshot, "http://host.docker.internal:3411/v1"), {
    id: "model-a",
    api: "openai-completions",
    baseUrl: "http://host.docker.internal:3411/v1",
    reasoning: false,
    input: ["text", "image"],
    temperature: 0.3,
    maxTokens: 1024
  });
});
test("Pi preset rejects request-shaping extra params instead of ignoring them", () => {
  assert.throws(() => assertPiPresetCompatible({
    extraParams: { tool_choice: "auto" },
    followupExtraParams: {}
  }), /pi_preset_incompatible_extra_param:tool_choice/);
  assert.throws(() => assertPiPresetCompatible({
    extraParams: { unknown_param: true },
    followupExtraParams: {}
  }), /pi_preset_incompatible_extra_param:unknown_param/);
  assert.throws(() => assertPiPresetCompatible({
    extraParams: {},
    followupExtraParams: { temperature: 0.2 }
  }), /pi_preset_followup_extra_params_unsupported/);
});
