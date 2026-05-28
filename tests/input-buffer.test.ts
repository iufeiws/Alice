import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionDirtyFlagger } from "../core/input-buffer/src/index.js";
import { loadConfig } from "../packages/config/src/index.js";

test("session dirty flagger waits before processing a dirty session", async () => {
  const processed: string[] = [];
  const flagger = createSessionDirtyFlagger(
    () => 20,
    async (sessionId) => {
      processed.push(sessionId);
    }
  );

  flagger.markDirty("session-a");
  flagger.markDirty("session-a");
  await waitFor(() => processed.length === 1);

  assert.deepEqual(processed, ["session-a"]);
});

test("session dirty flagger does not process a dirty session concurrently", async () => {
  const processed: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const flagger = createSessionDirtyFlagger(
    () => 10,
    async (sessionId) => {
      processed.push(sessionId);
      if (processed.length === 1) {
        await firstBlocked;
      }
    }
  );

  flagger.markDirty("session-a");
  await waitFor(() => processed.length === 1);
  flagger.markDirty("session-a");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(processed.length, 1);

  releaseFirst();
  await waitFor(() => processed.length === 2);
  assert.deepEqual(processed, ["session-a", "session-a"]);
});

test("session dirty flagger separates sessions", async () => {
  const processed: string[] = [];
  const flagger = createSessionDirtyFlagger(
    () => 10,
    async (sessionId) => {
      processed.push(sessionId);
    }
  );

  flagger.markDirty("session-a");
  flagger.markDirty("session-b");
  await waitFor(() => processed.length === 2);

  assert.deepEqual(processed.sort(), ["session-a", "session-b"]);
});

test("agent inbound debounce config defaults to one second and can be overridden", () => {
  assert.equal(loadConfig({}).core.inboundDebounceMs, 1000);
  assert.equal(loadConfig({ AGENT_INBOUND_DEBOUNCE_MS: "2500" }).core.inboundDebounceMs, 2500);
  assert.equal(loadConfig({}).core.defaultTargetPlugin, "auto");
  assert.equal(loadConfig({ AGENT_DEFAULT_TARGET_PLUGIN: "wechat" }).core.defaultTargetPlugin, "wechat");
  assert.equal(loadConfig({ AGENT_DEFAULT_TARGET_PLUGIN: "feishu" }).core.defaultTargetPlugin, "feishu");
  assert.equal(loadConfig({ AGENT_DEFAULT_TARGET_PLUGIN: "bad" }).core.defaultTargetPlugin, "auto");
});

test("genie tts config has asset defaults and env overrides", () => {
  const defaults = loadConfig({}).tts;
  assert.equal(defaults.genieBaseURL, "http://127.0.0.1:8000");
  assert.equal(defaults.genieCharacterName, "alice");
  assert.equal(defaults.genieModelDir, "assets/tts/models/alice");
  assert.equal(defaults.genieLanguage, "zh");
  assert.equal(defaults.genieReferenceAudio, "assets/tts/reference/reference.wav");
  assert.equal(defaults.genieReferenceText, "assets/tts/reference/reference.txt");
  assert.equal(defaults.genieOutputDir, "assets/generated/tts");
  assert.equal(defaults.genieTimeoutMs, 120000);

  const custom = loadConfig({
    GENIE_TTS_BASE_URL: "http://localhost:9000/",
    GENIE_TTS_CHARACTER_NAME: "custom",
    GENIE_TTS_MODEL_DIR: "assets/tts/models/custom",
    GENIE_TTS_LANGUAGE: "jp",
    GENIE_TTS_REFERENCE_AUDIO: "assets/tts/reference/custom.wav",
    GENIE_TTS_REFERENCE_TEXT: "assets/tts/reference/custom.txt",
    GENIE_TTS_OUTPUT_DIR: "assets/generated/custom-tts",
    GENIE_TTS_TIMEOUT_MS: "5000"
  }).tts;
  assert.equal(custom.genieBaseURL, "http://localhost:9000");
  assert.equal(custom.genieCharacterName, "custom");
  assert.equal(custom.genieModelDir, "assets/tts/models/custom");
  assert.equal(custom.genieLanguage, "jp");
  assert.equal(custom.genieReferenceAudio, "assets/tts/reference/custom.wav");
  assert.equal(custom.genieReferenceText, "assets/tts/reference/custom.txt");
  assert.equal(custom.genieOutputDir, "assets/generated/custom-tts");
  assert.equal(custom.genieTimeoutMs, 5000);
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
