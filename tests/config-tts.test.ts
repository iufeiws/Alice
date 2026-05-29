import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../packages/config/src/index.js";

test("tts config defaults to moss onnx backend", () => {
  const config = loadConfig({});

  assert.equal(config.tts.backend, "moss-onnx");
  assert.equal(config.tts.mossBaseURL, "http://127.0.0.1:8765");
  assert.equal(config.tts.mossBaseURLExplicit, false);
  assert.equal(config.tts.mossPythonCommand, ".conda-moss/bin/python");
  assert.equal(config.tts.mossReferenceAudio, "assets/tts/references/alice/reference.wav");
  assert.equal(config.tts.mossIdleShutdownMs, 15 * 60 * 1000);
  assert.equal(config.tts.mossFfmpegCommand, "ffmpeg-static");
});

test("tts config reads moss onnx settings", () => {
  const config = loadConfig({
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

test("tts config marks explicit moss base url", () => {
  const config = loadConfig({
    MOSS_TTS_BASE_URL: "http://127.0.0.9:9000/"
  });

  assert.equal(config.tts.mossBaseURL, "http://127.0.0.9:9000");
  assert.equal(config.tts.mossBaseURLExplicit, true);
});
