import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../packages/config/src/index.js";

test("tts config defaults to genie tts backend with moss fallback settings", () => {
  const config = loadConfig({});

  assert.equal(config.tts.backend, "genie-tts");
  assert.equal(config.tts.genieBaseURL, "http://127.0.0.1:8767");
  assert.equal(config.tts.genieBaseURLExplicit, false);
  assert.equal(config.tts.geniePythonCommand, ".conda-moss/bin/python");
  assert.equal(config.tts.genieServiceScript, "scripts/genie_tts/service.py");
  assert.equal(config.tts.genieDataDir, "assets/tts/genie/GenieData");
  assert.equal(config.tts.genieModelDir, "assets/tts/genie/models/alice");
  assert.equal(config.tts.genieCharacterName, "alice");
  assert.equal(config.tts.genieLanguage, "zh");
  assert.equal(config.tts.genieReferenceAudio, "assets/tts/references/alice/reference.wav");
  assert.equal(config.tts.genieReferenceText, "assets/tts/references/alice/reference.txt");
  assert.equal(config.tts.mossBaseURL, "http://127.0.0.1:8765");
  assert.equal(config.tts.mossBaseURLExplicit, false);
  assert.equal(config.tts.mossPythonCommand, ".conda-moss/bin/python");
  assert.equal(config.tts.mossReferenceAudio, "assets/tts/references/alice/reference.wav");
  assert.equal(config.tts.mossIdleShutdownMs, 15 * 60 * 1000);
  assert.equal(config.tts.mossFfmpegCommand, "ffmpeg-static");
});

test("tts config reads moss onnx settings", () => {
  const config = loadConfig({
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

  assert.equal(config.tts.backend, "moss-onnx");
  assert.equal(config.tts.mossBaseURL, "http://127.0.0.2:8766");
  assert.equal(config.tts.mossBaseURLExplicit, false);
  assert.equal(config.tts.mossModelDir, "assets/tts/custom-models");
  assert.equal(config.tts.mossPythonCommand, "/opt/moss/bin/python");
  assert.equal(config.tts.mossReferenceAudio, "assets/tts/references/alice/reference.wav");
  assert.equal(config.tts.mossOutputDir, "assets/generated/moss");
  assert.equal(config.tts.mossIdleShutdownMs, 12345);
  assert.equal(config.tts.mossTimeoutMs, 23456);
  assert.equal(config.tts.mossFfmpegCommand, "/usr/local/bin/ffmpeg");
});

test("tts config reads genie tts settings", () => {
  const config = loadConfig({
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

  assert.equal(config.tts.backend, "genie-tts");
  assert.equal(config.tts.genieBaseURL, "http://127.0.0.3:8768");
  assert.equal(config.tts.genieBaseURLExplicit, false);
  assert.equal(config.tts.genieDataDir, "assets/tts/genie/custom-data");
  assert.equal(config.tts.genieModelDir, "assets/tts/genie/custom");
  assert.equal(config.tts.genieCharacterName, "custom-alice");
  assert.equal(config.tts.genieLanguage, "en");
  assert.equal(config.tts.genieReferenceAudio, "assets/tts/references/custom/reference.wav");
  assert.equal(config.tts.genieReferenceText, "assets/tts/references/custom/reference.txt");
  assert.equal(config.tts.genieOutputDir, "assets/generated/genie");
  assert.equal(config.tts.geniePythonCommand, "/opt/genie/bin/python");
  assert.equal(config.tts.genieIdleShutdownMs, 34567);
  assert.equal(config.tts.genieTimeoutMs, 45678);
  assert.equal(config.tts.genieFfmpegCommand, "/usr/bin/ffmpeg");
});

test("tts config marks explicit moss base url", () => {
  const config = loadConfig({
    MOSS_TTS_BASE_URL: "http://127.0.0.9:9000/"
  });

  assert.equal(config.tts.mossBaseURL, "http://127.0.0.9:9000");
  assert.equal(config.tts.mossBaseURLExplicit, true);
});

test("tts config marks explicit genie base url", () => {
  const config = loadConfig({
    GENIE_TTS_BASE_URL: "http://127.0.0.8:9001/"
  });

  assert.equal(config.tts.genieBaseURL, "http://127.0.0.8:9001");
  assert.equal(config.tts.genieBaseURLExplicit, true);
});
