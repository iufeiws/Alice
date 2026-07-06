import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../../../src/apps/api/bootstrap/app-config-runtime.js";

function loadTtsConfig(env: Record<string, string> = {}) {
  return loadConfig(env).tts;
}

test("tts config defaults to genie tts backend", () => {
  const config = loadTtsConfig();

  assert.equal(config.backend, "genie-tts");
});

test("tts config defaults local service URLs without marking them explicit", () => {
  const config = loadTtsConfig();

  assert.equal(config.genieBaseURL, "http://127.0.0.1:8767");
  assert.equal(config.genieBaseURLExplicit, false);
  assert.equal(config.mossBaseURL, "http://127.0.0.1:8765");
  assert.equal(config.mossBaseURLExplicit, false);
});

test("tts config defaults genie voice assets", () => {
  const config = loadTtsConfig();

  assert.equal(config.genieDataDir, "assets/tts/genie/GenieData");
  assert.equal(config.genieModelDir, "assets/tts/genie/models/alice");
  assert.equal(config.genieCharacterName, "alice");
  assert.equal(config.genieLanguage, "zh");
  assert.equal(config.genieReferenceAudio, "assets/tts/references/alice/reference.wav");
  assert.equal(config.genieReferenceText, "assets/tts/references/alice/reference.txt");
});

test("tts config defaults local service process settings", () => {
  const config = loadTtsConfig();

  assert.equal(config.geniePythonCommand, ".conda-moss/bin/python");
  assert.equal(config.genieServiceScript, "scripts/genie_tts/service.py");
  assert.equal(config.genieIdleShutdownMs, 15 * 60 * 1000);
  assert.equal(config.genieFfmpegCommand, "ffmpeg-static");
  assert.equal(config.mossPythonCommand, ".conda-moss/bin/python");
  assert.equal(config.mossIdleShutdownMs, 15 * 60 * 1000);
  assert.equal(config.mossFfmpegCommand, "ffmpeg-static");
});

test("project username comes from project env", () => {
  const config = loadConfig({
    PROJECT_USERNAME: "Y"
  });

  assert.equal(config.project.username, "Y");
});

test("core config can enable heartbeat auto start", () => {
  const config = loadConfig({
    AGENT_HEARTBEAT_PAUSED: "false"
  });

  assert.equal(config.core.heartbeatPaused, false);
});

test("memory summary config is independent from core llm config", () => {
  const config = loadConfig({
    LLM_API_KEY: "core-key",
    LLM_BASE_URL: "https://core.example/v1",
    DEEPSEEK_API_KEY: "deepseek-key"
  });

  assert.equal(config.llm.apiKey, "core-key");
  assert.equal(config.memorySummary.apiKey, "deepseek-key");
  assert.equal(config.memorySummary.baseURL, "https://core.example/v1");
  assert.equal(config.memorySummary.model, "deepseek-v4-pro");
  assert.equal(config.memorySummary.temperature, 0.8);
  assert.deepEqual(config.memorySummary.extraParams, { thinking: { type: "enabled" }, reasoning_effort: "high" });
});

test("memory summary config may reuse core auth settings but not core model settings", () => {
  const config = loadConfig({
    LLM_API_KEY: "core-key",
    LLM_BASE_URL: "https://core.example/v1",
    LLM_MODEL: "deepseek-chat",
    LLM_TEMPERATURE: "0.2"
  });

  assert.equal(config.memorySummary.apiKey, "core-key");
  assert.equal(config.memorySummary.baseURL, "https://core.example/v1");
  assert.equal(config.memorySummary.model, "deepseek-v4-pro");
  assert.equal(config.memorySummary.temperature, 0.8);
});

test("memory manual run requires sleeping by default", () => {
  assert.equal(loadConfig({}).memorySummary.manualRunRequiresSleeping, true);
});

test("memory manual run sleeping requirement can be disabled", () => {
  assert.equal(loadConfig({ MEMORY_MANUAL_RUN_REQUIRES_SLEEPING: "false" }).memorySummary.manualRunRequiresSleeping, false);
});

test("tts config reads moss onnx settings", () => {
  const config = loadTtsConfig({
    TTS_BACKEND: "moss-onnx",
    MOSS_TTS_HOST: "127.0.0.2",
    MOSS_TTS_PORT: "8766",
    MOSS_TTS_MODEL_DIR: "assets/tts/custom-models",
    MOSS_TTS_REFERENCE_AUDIO: "assets/tts/references/alice/reference.wav",
    MOSS_TTS_OUTPUT_DIR: "assets/generated/moss",
    MOSS_TTS_PYTHON_COMMAND: "/opt/moss/bin/python",
    MOSS_TTS_IDLE_SHUTDOWN_MS: "12345",
    MOSS_TTS_TIMEOUT_MS: "23456",
    MOSS_TTS_FFMPEG_COMMAND: "/usr/local/bin/ffmpeg"
  });

  assert.equal(config.backend, "moss-onnx");
  assert.equal(config.mossBaseURL, "http://127.0.0.2:8766");
  assert.equal(config.mossBaseURLExplicit, false);
  assert.equal(config.mossModelDir, "assets/tts/custom-models");
  assert.equal(config.mossPythonCommand, "/opt/moss/bin/python");
  assert.equal(config.mossReferenceAudio, "assets/tts/references/alice/reference.wav");
  assert.equal(config.mossOutputDir, "assets/generated/moss");
  assert.equal(config.mossIdleShutdownMs, 12345);
  assert.equal(config.mossTimeoutMs, 23456);
  assert.equal(config.mossFfmpegCommand, "/usr/local/bin/ffmpeg");
});

test("tts config reads genie tts settings", () => {
  const config = loadTtsConfig({
    GENIE_TTS_HOST: "127.0.0.3",
    GENIE_TTS_PORT: "8768",
    GENIE_TTS_DATA_DIR: "assets/tts/genie/custom-data",
    GENIE_TTS_MODEL_DIR: "assets/tts/genie/custom",
    GENIE_TTS_CHARACTER_NAME: "custom-alice",
    GENIE_TTS_LANGUAGE: "en",
    GENIE_TTS_REFERENCE_AUDIO: "assets/tts/references/custom/reference.wav",
    GENIE_TTS_REFERENCE_TEXT: "assets/tts/references/custom/reference.txt",
    GENIE_TTS_OUTPUT_DIR: "assets/generated/genie",
    GENIE_TTS_PYTHON_COMMAND: "/opt/genie/bin/python",
    GENIE_TTS_IDLE_SHUTDOWN_MS: "34567",
    GENIE_TTS_TIMEOUT_MS: "45678",
    GENIE_TTS_FFMPEG_COMMAND: "/usr/bin/ffmpeg"
  });

  assert.equal(config.backend, "genie-tts");
  assert.equal(config.genieBaseURL, "http://127.0.0.3:8768");
  assert.equal(config.genieBaseURLExplicit, false);
  assert.equal(config.genieDataDir, "assets/tts/genie/custom-data");
  assert.equal(config.genieModelDir, "assets/tts/genie/custom");
  assert.equal(config.genieCharacterName, "custom-alice");
  assert.equal(config.genieLanguage, "en");
  assert.equal(config.genieReferenceAudio, "assets/tts/references/custom/reference.wav");
  assert.equal(config.genieReferenceText, "assets/tts/references/custom/reference.txt");
  assert.equal(config.genieOutputDir, "assets/generated/genie");
  assert.equal(config.geniePythonCommand, "/opt/genie/bin/python");
  assert.equal(config.genieIdleShutdownMs, 34567);
  assert.equal(config.genieTimeoutMs, 45678);
  assert.equal(config.genieFfmpegCommand, "/usr/bin/ffmpeg");
});

test("tts config trims and marks explicit moss base url", () => {
  const config = loadTtsConfig({
    MOSS_TTS_BASE_URL: "http://127.0.0.9:9000/"
  });

  assert.equal(config.mossBaseURL, "http://127.0.0.9:9000");
  assert.equal(config.mossBaseURLExplicit, true);
});

test("tts config trims and marks explicit genie base url", () => {
  const config = loadTtsConfig({
    GENIE_TTS_BASE_URL: "http://127.0.0.8:9001/"
  });

  assert.equal(config.genieBaseURL, "http://127.0.0.8:9001");
  assert.equal(config.genieBaseURLExplicit, true);
});
