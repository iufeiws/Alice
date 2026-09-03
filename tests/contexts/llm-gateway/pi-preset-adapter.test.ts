import test from "node:test";
import assert from "node:assert/strict";
import { createPiPresetSnapshot } from "../../../src/contexts/llm-gateway/src/pi-preset-adapter.js";

const preset = {
  name: "local",
  protocol: "openai-chat-completions" as const,
  credentialId: "credential-a",
  baseURL: "https://upstream.example/v1/",
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
    protocol: "openai-chat-completions",
    credentialId: "credential-a",
    baseURL: "https://upstream.example/v1",
    model: "model-a",
    temperature: 0.3,
    maxTokens: 1024,
    timeoutMs: 10_000,
    stream: true,
    useProxy: false,
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

test("Pi preset snapshot accepts project presets without an optional base URL", () => {
  const snapshot = createPiPresetSnapshot({
    ...preset,
    baseURL: ""
  });

  assert.equal(snapshot.baseURL, "");
  assert.equal(snapshot.credentialId, "credential-a");
});
