import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertPatchError,
  baseContext,
  createAdminHandler,
  createCalendarStore,
  createDailyShellStore,
  createDiaryStore,
  createMarkdownMemoryStore,
  createMemoryInductionPromptStore,
  createPromptProfileStore,
  createRawRequest,
  createRequest,
  createResponse,
  editToolClient,
  fs,
  makeTempDir,
  makeTinyWavBuffer,
  message,
  path,
  photoDefaults,
  promptStoragePath,
  runMemoryInductionForMessages,
  writeTtsPluginConfig,
  writePreset
} from "./admin-routes-helpers.js";
import type { LLMChatInput, StoredConversationMessage } from "./admin-routes-helpers.js";

test("admin plugin model folder upload flattens files under plugin model root", async () => {
  const root = makeTempDir("admin-plugin-asset");
  const assetRoot = path.join(root, "assets");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  writeTtsPluginConfig(root, { configPath, translation: { apiPresetName: "voice", prompt: "Translate:" } });
  writePreset(root, "voice");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { tts: { configPath, assetRoot } }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  const fileName = `model-${path.basename(root)}.onnx`;
  await handler(createRawRequest("POST", "/admin/api/plugins/tts/assets/model", Buffer.from("model"), {
    "x-file-name": encodeURIComponent(fileName),
    "x-relative-dir": encodeURIComponent("uploaded-folder/nested")
  }), response);
  const body = JSON.parse(response.body);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const savedPreset = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), "presets", "genie-jp.json"), "utf8"));
  const expectedAssetPath = `assets/tts/preset/genie-jp/model/${fileName}`;

  assert.equal(response.statusCode, 200);
  assert.equal(body.assetPath, expectedAssetPath);
  assert.equal(saved.activePresetName, "genie-jp");
  assert.equal(savedPreset.genie.modelDir, "assets/tts/preset/genie-jp/model");
  assert.equal(fs.readFileSync(path.join(assetRoot, "tts", "preset", "genie-jp", "model", fileName), "utf8"), "model");
  assert.equal(fs.existsSync(path.join(assetRoot, "tts", "preset", "genie-jp", "model", "uploaded-folder", "nested", fileName)), false);
});

test("admin plugin TTS reference audio upload converts to preset wav", async () => {
  const root = makeTempDir("admin-plugin-reference-audio");
  const assetRoot = path.join(root, "assets");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  writeTtsPluginConfig(root, { configPath, translation: { apiPresetName: "voice" } });
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    pluginConfigs: { tts: { configPath, assetRoot } }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRawRequest("POST", "/admin/api/plugins/tts/assets/reference-audio", makeTinyWavBuffer(), {
    "x-file-name": encodeURIComponent("voice-sample.mp3"),
    "x-preset-name": encodeURIComponent("jp")
  }), response);
  const body = JSON.parse(response.body);
  const referenceWavPath = path.join(assetRoot, "tts", "preset", "jp", "reference.wav");

  assert.equal(response.statusCode, 200);
  assert.equal(body.assetPath, "assets/tts/preset/jp/reference.wav");
  assert.equal(fs.existsSync(referenceWavPath), true);
  assert.equal(fs.existsSync(path.join(assetRoot, "tts", "preset", "jp", "reference.mp3")), false);
  assert.equal(fs.readFileSync(referenceWavPath).subarray(0, 4).toString("ascii"), "RIFF");
});

test("admin plugin TTS MiMo voice clone upload stores data url in provider config", async () => {
  const root = makeTempDir("admin-plugin-mimo-audio");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  writeTtsPluginConfig(root, {
    configPath,
    enabled: true,
    activePresetName: "mimo",
    preset: { provider: "mimo", mimo: { mode: "preset", baseURL: "https://api.xiaomimimo.com/v1", voice: "mimo_default" } }
  });
  const context = {
    ...baseContext(root, createMarkdownMemoryStore(root), createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]))),
    pluginConfigs: { tts: { configPath } }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRawRequest("POST", "/admin/api/plugins/tts/assets/mimo-voiceclone-audio", Buffer.from("audio-bytes"), {
    "x-file-name": encodeURIComponent("clone.mp3")
  }), response);
  const body = JSON.parse(response.body);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const savedMimo = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), "presets", "mimo.json"), "utf8"));

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(saved.activePresetName, "mimo");
  assert.equal(savedMimo.mimo.mode, "voiceclone");
  assert.equal(savedMimo.mimo.voiceCloneAudioDataUrl, `data:audio/mpeg;base64,${Buffer.from("audio-bytes").toString("base64")}`);
  assert.equal(body.configValue.currentPreset.mimo.voiceCloneAudioDataUrlSet, true);
});

test("admin plugin test translates input before synthesis", async () => {
  const fixture = await runTtsPluginTest();

  assert.equal(fixture.response.statusCode, 200);
  assert.equal(fixture.body.result.input, "晚点见");
  assert.equal(fixture.body.result.output, "また後で");
  assert.equal(fixture.synthesizedText, "また後で");
});

test("admin plugin test returns generated TTS asset url", async () => {
  const fixture = await runTtsPluginTest();

  assert.equal(fixture.response.statusCode, 200);
  assert.equal(fixture.body.result.voice.audioUrl, `/admin/assets/tts/${fixture.voiceFileName}`);
});

test("admin plugin test reports timing metrics", async () => {
  const fixture = await runTtsPluginTest();

  assert.equal(fixture.response.statusCode, 200);
  assert.equal(typeof fixture.body.result.timing.translationMs, "number");
  assert.equal(typeof fixture.body.result.timing.ttsMs, "number");
  assert.equal(typeof fixture.body.result.timing.totalMs, "number");
});

test("admin plugin test sends translation through TTS agent", async () => {
  const fixture = await runTtsPluginTest();

  assert.equal(fixture.response.statusCode, 200);
  assert.deepEqual(fixture.senderAgents, ["tts"]);
});

test("admin plugin test passes Genie preset to synthesizer", async () => {
  const fixture = await runTtsPluginTest();

  assert.equal(fixture.response.statusCode, 200);
  assert.deepEqual(fixture.capturedGenie, { language: "zh", modelDir: "assets/tts/preset/zh-main/model", referenceAudio: undefined, referenceText: undefined, splitText: false });
});

async function runTtsPluginTest() {
  const root = makeTempDir("admin-plugin-test");
  const assetRoot = path.join(root, "assets");
  const configPath = path.join(root, "config", "plugin", "tts", "config.json");
  const ttsOutputDir = "generated/tts";
  const voiceFileName = `voice-${path.basename(root)}.opus`;
  const voicePath = path.join(assetRoot, "generated", "tts", voiceFileName);
  let capturedGenie: unknown;
  let synthesizedText = "";
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(voicePath), { recursive: true });
  writeTtsPluginConfig(root, {
    configPath,
    enabled: true,
    activePresetName: "zh-main",
    translation: {
      translationPresetName: "main",
      translationPresets: {
        main: {
          translationEnabled: true,
          apiPresetName: "voice",
          prompt: "Translate for {{user}} at {{date}}:"
        }
      }
    },
    preset: { provider: "genie", genie: { enabled: true, baseURL: "http://127.0.0.1:8767", language: "zh", modelDir: "assets/tts/preset/zh-main/model", splitText: false } }
  });
  writePreset(root, "voice");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const senderAgents: string[] = [];
  const context = {
    ...baseContext(root, memoryStore, promptStore),
    config: {
      ...baseContext(root, memoryStore, promptStore).config,
      tts: { mossOutputDir: ttsOutputDir }
    },
    pluginConfigs: {
      tts: {
        configPath,
        assetRoot,
        testVoiceSynthesizer: async ({ text, genie }: { text: string; genie?: unknown }) => {
          capturedGenie = genie;
          synthesizedText = text;
          fs.writeFileSync(voicePath, `voice:${text}`);
          return { assetId: "generated/tts/voice.opus", filePath: voicePath };
        }
      }
    },
    llmRequestSender: async (input: any) => {
      senderAgents.push(input.agentId);
      return { message: { role: "assistant", content: "また後で" } };
    }
  };
  const handler = createAdminHandler(context);

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/plugins/tts/test", { text: "晚点见" }), response);
  const body = JSON.parse(response.body);

  fs.rmSync(voicePath, { force: true });
  return { response, body, capturedGenie, senderAgents, synthesizedText, voiceFileName };
}
