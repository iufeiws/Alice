import test from "node:test";
import assert from "node:assert/strict";
import { createPiPresetSnapshot } from "../../../src/contexts/llm-gateway/src/pi-preset-adapter.js";

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
});
test("Pi preset snapshot accepts project preset parameters and ignores followup-only parameters", () => {
  const snapshot = createPiPresetSnapshot({
    ...preset,
    extraParams: {
      stream_options: { include_usage: true },
      tool_choice: "auto",
      unknown_project_parameter: "preserve"
    },
    followupExtraParams: {
      reasoning_effort: "high"
    }
  });

  assert.deepEqual(snapshot.extraParams, {
    stream_options: { include_usage: true },
    tool_choice: "auto",
    unknown_project_parameter: "preserve"
  });
});

test("Pi preset snapshot accepts project presets without optional upstream credentials", () => {
  const snapshot = createPiPresetSnapshot({
    ...preset,
    baseURL: "",
    apiKey: undefined
  });

  assert.equal(snapshot.baseURL, "");
  assert.equal(snapshot.apiKey, undefined);
});
