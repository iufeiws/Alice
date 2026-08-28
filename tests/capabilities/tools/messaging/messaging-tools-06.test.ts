import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";
import { createMessagingTools } from "../../../../src/capabilities/tools/messaging/src/index.js";
import { createFinishAndWaitTools } from "../../../../src/capabilities/tools/finish-and-wait/src/index.js";
import { collectTtsStreamText, createBailianTtsVoiceSynthesizer, createConfiguredVoiceSynthesizer, createFallbackVoiceSynthesizer, createGenieTtsVoiceSynthesizer, createMimoTtsVoiceSynthesizer, createMossOnnxVoiceSynthesizer, createOpenAiApiTtsVoiceSynthesizer, createTtsPcmProgressTextMapper, createTtsPlugin, createTtsRemoteAwareVoiceSynthesizer, createTtsTranslationSynthesizer, resolveTtsText, splitTtsStreamParts, splitTtsTextChunks, synthesizeTtsRouted, ttsGenieOverrides, readTtsPluginConfig, type VoiceSynthesizer } from "../../../../src/channels/tts/src/index.js";
import { createAliceStore } from "../../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { AgentOutput } from "../../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { testPromptRuntime } from "../../../helpers/prompt-runtime.js";
import { setOpenAICallObserver } from "../../../../src/contexts/llm-gateway/src/llm-upstream-requester.js";

const fs = await import("node:fs");
const fsp = await import("node:fs/promises");
const path = await import("node:path");
const os = await import("node:os");
const events = await import("node:events");

const genieRequiredModelFiles = [
  "t2s_encoder_fp32.bin",
  "t2s_encoder_fp32.onnx",
  "t2s_first_stage_decoder_fp32.onnx",
  "t2s_shared_fp16.bin",
  "t2s_stage_decoder_fp32.onnx",
  "vits_fp16.bin",
  "vits_fp32.onnx"
];

function ttsConfig(input: any): any {
  const preset = input.preset ?? (input.conversion
    ? {
      provider: input.conversion.provider,
      genie: input.conversion.genie,
      openaiApi: input.conversion.openaiApi,
      bailian: input.conversion.bailian,
      mimo: input.conversion.mimo
    }
    : { provider: "genie", genie: { enabled: true, baseURL: "http://127.0.0.1:8767", localFallbackEnabled: true, language: "jp", modelDir: "assets/tts/preset/test/model" } });
  return { ...input, activePresetName: "test", presets: { test: preset }, activePreset: preset };
}

function writeTtsConfigFile(configPath: string, input: any, presetName = "test", preset: any = { provider: "genie", genie: { enabled: true, baseURL: "http://127.0.0.1:8767", localFallbackEnabled: true, language: "jp", modelDir: "assets/tts/preset/test/model" } }) {
  fs.mkdirSync(path.join(path.dirname(configPath), "presets"), { recursive: true });
  const { translationEnabled, apiPresetName, prompt, conversion: _conversion, voice: _voice, translationPresets, translationPresetName = "default", ...rest } = input;
  fs.writeFileSync(configPath, JSON.stringify({
    ...rest,
    activePresetName: presetName,
    editPresetName: presetName,
    translationPresetName,
    translationPresets: translationPresets ?? { [translationPresetName]: { translationEnabled, apiPresetName, prompt } }
  }));
  fs.writeFileSync(path.join(path.dirname(configPath), "presets", `${presetName}.json`), JSON.stringify(preset));
}

test("bailian tts uses CosyVoice SpeechSynthesizer endpoint and parameters", async () => {
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  const synthesize = createBailianTtsVoiceSynthesizer({
    enabled: true,
    translationEnabled: false,
    prompt: "Read aloud.",
    ...ttsConfig({ conversion: {
      provider: "bailian",
      bailian: {
        service: "cosy",
        apiKey: "inline-key",
        model: "cosyvoice-v2",
        voice: "longxiaochun",
        responseFormat: "pcm",
        sampleRate: 24000,
        channels: 1,
        extraParams: { volume: 50 }
      }
    } })
  }, {
    env: { DASHSCOPE_API_KEY: "env-key" },
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body))
      });
      return new Response(new Uint8Array([5, 6]), {
        status: 200,
        headers: { "Content-Type": "audio/wav" }
      });
    }
  });

  const chunks = [];
  for await (const chunk of synthesize.streamAudioWithText!({
    text: "第一句。",
    time: createCurrentTimeProvider("UTC")
  })) {
    chunks.push([chunk.text, Array.from(chunk.chunk), chunk.sampleRateHz, chunk.channels]);
  }

  assert.equal(requests[0].url, "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer");
  assert.equal(requests[0].headers.get("Authorization"), "Bearer inline-key");
  assert.deepEqual(requests[0].body, {
    model: "cosyvoice-v2",
    input: {
      text: "第一句。"
    },
    parameters: {
      volume: 50,
      voice: "longxiaochun",
      format: "pcm",
      sample_rate: 24000
    }
  });
  assert.deepEqual(chunks, [
    ["第一句。", [5, 6], 24000, 1]
  ]);
});

test("mimo tts voiceclone sends chat completions audio voice data url", async () => {
  const outputDir = path.join(makeTempDir("mimo-tts-output"), "assets", "generated", "tts");
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  const audio = Buffer.from("wav-bytes");
  const callEvents: any[] = [];
  setOpenAICallObserver((event) => { callEvents.push(event); });
  const synthesize = createMimoTtsVoiceSynthesizer({
    enabled: true,
    translationEnabled: false,
    prompt: "unused",
    ...ttsConfig({ conversion: {
      provider: "mimo",
      mimo: {
        mode: "voiceclone",
        apiKey: "mimo-key",
        voiceCloneAudioDataUrl: "data:audio/wav;base64,AAAA",
        audioFormat: "wav",
        sampleRate: 24000,
        channels: 1
      }
    } })
  }, {
    outputDir,
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body))
      });
      return new Response(JSON.stringify({
        model: "mimo-v2.5-tts-voiceclone",
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
        choices: [{
          message: {
            audio: { data: audio.toString("base64") }
          }
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  try {
    const result = await synthesize({
      text: "保存音频。",
      time: createCurrentTimeProvider("UTC", () => new Date("2026-06-11T02:10:51.609Z"))
    });
    assert.equal(requests[0].url, "https://api.xiaomimimo.com/v1/chat/completions");
    assert.equal(requests[0].headers.get("api-key"), "mimo-key");
    assert.deepEqual(requests[0].body, {
      model: "mimo-v2.5-tts-voiceclone",
      messages: [{ role: "assistant", content: "保存音频。" }],
      audio: {
        format: "wav",
        voice: "data:audio/wav;base64,AAAA"
      }
    });
    assert.equal(result.assetId, "generated/tts/2026-06-11T02_10_51.609-mimo.wav");
    assert.deepEqual(fs.readFileSync(result.filePath), audio);
    assert.equal(callEvents.length, 1);
    assert.equal(callEvents[0].agentId, "tts");
    assert.equal(callEvents[0].requestedModel, "mimo-v2.5-tts-voiceclone");
    assert.deepEqual(callEvents[0].usage, {
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
      cacheHitTokens: undefined,
      cacheMissTokens: undefined
    });
    fs.rmSync(result.filePath, { force: true });
  } finally {
    setOpenAICallObserver(undefined);
  }
});

test("tts PCM progress mapper falls back to UTF character slices without punctuation", () => {
  const mapper = createTtsPcmProgressTextMapper("abcdef", 6, { sampleRate: 1000, channels: 1, bytesPerSample: 1 });

  assert.equal(mapper.take(2), "ab");
  assert.equal(mapper.take(2), "cd");
  assert.equal(mapper.take(2), "ef");
});

test("tts text chunk splitter keeps special characters and only splits on sentence endings", () => {
  assert.deepEqual(
    splitTtsTextChunks("嗯，之前只拆句号。问号？现在，符号！都拆开；再拼接。后面．再来一点。没"),
    ["嗯，之前只拆句号。问号？", "现在，符号！都拆开；再拼接。后面．再来一点。没"]
  );
});

test("tts text chunk splitter batches fixed backend text by sentence-ending blocks", () => {
  assert.deepEqual(
    splitTtsTextChunks("aaaaaa,bbbbbb!cccccc,dddddd!ee."),
    ["aaaaaa,bbbbbb!", "cccccc,dddddd!ee."]
  );
});

test("tts stream buffers input into takeable segments before translation and chunks backend text after translation", async () => {
  const dir = makeTempDir("tts-stream-two-stage-splitting");
  const configPath = path.join(dir, "config.json");
  writeTtsConfigFile(configPath, {
    enabled: true,
    translationEnabled: true,
    apiPresetName: "fixed-flash",
    prompt: "Translate to Japanese.\nText:"
  });
  const sourceParts = [
    "入口一入口一入口一入口一入口一入口一入口一。",
    "入口二入口二入口二入口二入口二入口二入口二。",
    "入口三入口三入口三入口三入口三入口三入口三。"
  ];
  const translatedOutputs = [
    "aaaaaa,bbbbbb!cccccc,dddddd!ee.",
    "kkkkkk,llllll!",
    "mmmmmm,nnnnnn!oo."
  ];
  const translatedInputs: string[] = [];
  const backendRequests: string[] = [];
  let fileIndex = 0;
  const plugin = createTtsPlugin({
    configPath,
    baseSynthesizer: async ({ text }) => {
      backendRequests.push(text);
      fileIndex += 1;
      const filePath = path.join(dir, `voice-${fileIndex}.wav`);
      fs.writeFileSync(filePath, `voice:${text}`);
      return { assetId: `generated/tts/voice-${fileIndex}.wav`, filePath };
    },
    llmRequestSender: async (input) => {
      const text = String(input.messages.at(-1)?.content ?? "");
      translatedInputs.push(text);
      return { message: { role: "assistant", content: translatedOutputs[translatedInputs.length - 1] ?? "" } };
    },
    promptRenderer: () => testPromptRuntime(),
    resolveApiPreset() {
      return {
        baseURL: "https://example.invalid/v1",
        apiKey: "test-key",
        model: "flash"
      };
    }
  });

  for await (const _event of plugin.voiceSynthesizer.stream!({
    text: sourceParts,
    time: createCurrentTimeProvider("UTC"),
    source: "send_chat.voice",
    streamId: "two-stage-splitting"
  })) {
    // Exhaust the stream.
  }

  assert.deepEqual(translatedInputs, sourceParts);
  assert.deepEqual(backendRequests, [
    "aaaaaa,bbbbbb!",
    "cccccc,dddddd!ee.",
    "kkkkkk,llllll!",
    "mmmmmm,nnnnnn!oo."
  ]);
});

async function streamTranslatedTts(name: string) {
  const dir = makeTempDir(name);
  const configPath = path.join(dir, "config.json");
  writeTtsConfigFile(configPath, {
    enabled: true,
    apiPresetName: "fixed-flash",
    prompt: "Translate to Japanese.\nText:"
  }, "test", { provider: "genie", genie: { enabled: true, baseURL: "http://127.0.0.1:8767", localFallbackEnabled: true, language: "jp", modelDir: "assets/tts/preset/test/model", splitText: true } });
  const translatedInputs: string[] = [];
  const streamedTexts: string[] = [];
  const streamedGenie: unknown[] = [];
  const logs: string[] = [];
  let fileIndex = 0;
  const plugin = createTtsPlugin({
    configPath,
    baseSynthesizer: async ({ text, genie }) => {
      streamedTexts.push(text);
      streamedGenie.push(genie);
      fileIndex += 1;
      const filePath = path.join(dir, `voice-${fileIndex}.wav`);
      fs.writeFileSync(filePath, `voice:${text}`);
      return { assetId: `generated/tts/voice-${fileIndex}.wav`, filePath };
    },
    llmRequestSender: async (input) => {
      const text = String(input.messages.at(-1)?.content ?? "");
      translatedInputs.push(text);
      return { message: { role: "assistant", content: `ja:${translatedInputs.length}` } };
    },
    promptRenderer: () => testPromptRuntime(),
    resolveApiPreset() {
      return {
        baseURL: "https://example.invalid/v1",
        apiKey: "test-key",
        model: "flash"
      };
    },
    appendLog: (_level, message) => logs.push(message)
  });

  const streamEvents = [];
  for await (const event of plugin.voiceSynthesizer.stream!({
    text: ["第一句第一句啊。", "第二句第二句啊。"],
    time: createCurrentTimeProvider("UTC"),
    source: "send_chat.voice",
    streamId: "stream-1"
  })) {
    streamEvents.push(event);
  }

  return { logs, streamEvents, streamedGenie, streamedTexts, translatedInputs };
}

test("tts stream translates the full conversation once", async () => {
  const { streamedTexts, translatedInputs } = await streamTranslatedTts("tts-stream-translation");

  assert.deepEqual(translatedInputs, ["第一句第一句啊。第二句第二句啊。"]);
  assert.deepEqual(streamedTexts, ["ja:1"]);
});

test("tts stream passes Genie overrides to the backend", async () => {
  const { streamedGenie } = await streamTranslatedTts("tts-stream-genie-overrides");

  assert.equal(streamedGenie.every((genie: any) => genie?.speed === undefined && genie?.splitText === true), true);
});

test("tts stream yields the expected stream contract", async () => {
  const { streamEvents } = await streamTranslatedTts("tts-stream-contract");

  assert.deepEqual(streamEvents.map((event) => event.type), [
    "translation_started",
    "translation_done",
    "audio_file",
    "part_done",
    "done"
  ]);
  assert.deepEqual(streamEvents.filter((event) => event.type === "audio_file").map((event: any) => [event.sequence, event.text, event.textchunk, path.basename(event.filePath)]), [
    [0, "第一句第一句啊。第二句第二句啊。", "ja:1", "voice-1.wav"]
  ]);
});

test("tts stream logs completion with generated file count", async () => {
  const { logs } = await streamTranslatedTts("tts-stream-log");

  assert.equal(logs.length > 0, true);
});

test("tts stream maps returned translated audio text back to source punctuation", async () => {
  const dir = makeTempDir("tts-stream-source-text");
  const configPath = path.join(dir, "config.json");
  writeTtsConfigFile(configPath, {
    enabled: true,
    apiPresetName: "fixed-flash",
    prompt: "Translate to Japanese.\nText:"
  });
  const backendTexts: string[] = [];
  let fileIndex = 0;
  const plugin = createTtsPlugin({
    configPath,
    baseSynthesizer: async ({ text }) => {
      backendTexts.push(text);
      fileIndex += 1;
      const filePath = path.join(dir, `voice-${fileIndex}.wav`);
      fs.writeFileSync(filePath, `voice:${text}`);
      return { assetId: `generated/tts/voice-${fileIndex}.wav`, filePath };
    },
    llmRequestSender: async () => ({
      message: { role: "assistant", content: "これは一文目です。二文目です。" }
    }),
    promptRenderer: () => testPromptRuntime(),
    resolveApiPreset() {
      return {
        baseURL: "https://example.invalid/v1",
        apiKey: "test-key",
        model: "flash"
      };
    }
  });

  const events = [];
  for await (const event of plugin.voiceSynthesizer.stream!({
    text: "第一句。第二句。",
    time: createCurrentTimeProvider("UTC"),
    source: "send_chat.voice"
  })) {
    events.push(event);
  }

  assert.deepEqual(backendTexts, ["これは一文目です。二文目です。"]);
  assert.deepEqual(events.filter((event) => event.type === "audio_file").map((event: any) => [event.text, event.textchunk, path.basename(event.filePath)]), [
    ["第一句。第二句。", "これは一文目です。二文目です。", "voice-1.wav"]
  ]);
});

test("tts stream returns original text with symbol-length silence for symbol-only input", async () => {
  const dir = makeTempDir("tts-stream-symbol-only");
  const configPath = path.join(dir, "config.json");
  writeTtsConfigFile(configPath, {
    enabled: true,
    apiPresetName: "fixed-flash",
    prompt: "Translate to Japanese.\nText:"
  });
  let llmCalls = 0;
  let streamCalls = 0;
  const logs: string[] = [];
  const plugin = createTtsPlugin({
    configPath,
    baseSynthesizer: Object.assign(async () => {
      throw new Error("non-stream synthesizer should not be used");
    }, {
      async *streamAudioWithText() {
        streamCalls += 1;
        yield { text: "should not stream", chunk: new Uint8Array([1]) };
      }
    }),
    llmRequestSender: async () => {
      llmCalls += 1;
      return { message: { role: "assistant", content: "日本語" } };
    },
    resolveApiPreset() {
      return {
        baseURL: "https://example.invalid/v1",
        apiKey: "test-key",
        model: "flash"
      };
    },
    appendLog: (_level, message) => logs.push(message)
  });

  const events = [];
  for await (const event of plugin.voiceSynthesizer.stream!({
    text: "！？…",
    time: createCurrentTimeProvider("UTC"),
    source: "send_chat.voice",
    streamId: "symbol-stream"
  })) {
    events.push(event);
  }

  assert.equal(llmCalls, 0);
  assert.equal(streamCalls, 0);
  assert.deepEqual(events.map((event) => event.type), ["translation_started", "translation_done", "audio_file", "part_done", "done"]);
  const audioFile = events.find((event) => event.type === "audio_file") as any;
  try {
    assert.equal(audioFile.text, "！？…");
    assert.equal(audioFile.textchunk, "！？…");
    assert.equal(fs.statSync(audioFile.filePath).size, 44 + 3 * 200 * 64);
  } finally {
    await fsp.rm(audioFile.filePath, { force: true });
  }
  assert.equal(logs.length > 0, true);
});

async function eventually(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let seedInboundCounter = 0;

function seedUserInbound(store: ReturnType<typeof createAliceStore>, conversationId: string, plugin: string): void {
  seedInboundCounter += 1;
  store.upsertInboundMessage({
    plugin,
    externalMessageId: `seed_user_inbound_${seedInboundCounter}`,
    conversationId,
    senderId: "user-1",
    senderRole: "user",
    contentType: "text",
    contentText: "user reply",
    createdAt: new Date(Date.parse("2026-05-25T00:00:00.000Z") + seedInboundCounter).toISOString()
  });
}

function makeTtsAssetFixture(prefix: string): { root: string; assetRoot: string; modelDir: string; referenceAudio: string; cleanup(): void } {
  const assetRoot = path.join(makeTempDir(`${prefix}-asset-root`), "assets");
  const root = path.join(assetRoot, "generated", `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const modelDir = path.join(root, "model");
  const referenceAudio = path.join(root, "reference.wav");
  fs.mkdirSync(modelDir, { recursive: true });
  for (const fileName of genieRequiredModelFiles) {
    fs.writeFileSync(path.join(modelDir, fileName), "model");
  }
  fs.writeFileSync(referenceAudio, "wav");
  return {
    root,
    assetRoot,
    modelDir,
    referenceAudio,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function fakeFfmpegSpawn(): any {
  return ((command: string, args: readonly string[]) => {
    const child = new events.EventEmitter() as any;
    child.stdout = new events.EventEmitter();
    child.stderr = new events.EventEmitter();
    child.exitCode = null;
    process.nextTick(() => {
      if (command === "ffmpeg") {
        if (args.includes("-f") && args.includes("s16le") && String(args[args.length - 1]) === "-") {
          const pcm = new Uint8Array(2000);
          for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
            pcm[offset] = 0xff;
            pcm[offset + 1] = 0x3f;
          }
          child.stdout.emit("data", pcm);
        } else {
          fs.writeFileSync(String(args[args.length - 1]), "opus");
        }
      }
      child.emit("exit", 0, null);
    });
    return child;
  }) as any;
}
