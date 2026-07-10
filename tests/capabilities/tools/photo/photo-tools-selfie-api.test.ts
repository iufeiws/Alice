import { test } from "node:test";
import { testPromptRuntime } from "../../../helpers/prompt-runtime.js";
import assert from "node:assert/strict";
import { createPhotoTools } from "../../../../src/capabilities/tools/photo/src/index.js";
import { runOpenAIAPISelfie } from "../../../../src/channels/image-generation/src/openai-api-provider.js";
import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";
import type { AgentOutput } from "../../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import {
  assetRootFromOutputDir,
  createTestStore,
  fakeJpegBytes,
  fs,
  makeAssetTempDir,
  makeTempDir,
  path,
  png1x1Bytes,
  selfieContext,
  writeReferenceFiles
} from "./photo-tools-helpers.js";

test("selfie_openaiMode_sendsImageApiRequestContract", async () => {
  const outputRoot = makeAssetTempDir("selfie-openai-direct");
  const referenceRoot = makeTempDir("selfie-ref-openai-direct");
  const outfitImage = path.join(makeTempDir("selfie-outfit-openai-direct"), "dress.jpg");
  const store = createTestStore("selfie-openai-direct-db");
  const sent: AgentOutput[] = [];
  const previousFetch = globalThis.fetch;
  const previousRunner = process.env.ALICE_SELFIE_FAST_RUNNER;
  let nextMessageId = 1;
  let apiCalled = false;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");
  process.env.ALICE_SELFIE_FAST_RUNNER = "missing-runner-that-openai-mode-must-not-use.mjs";
  globalThis.fetch = (async (url, init) => {
    apiCalled = true;
    assert.equal(String(url), "https://api.openai.com/v1/images/edits");
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, { authorization: "Bearer test-key" });
    const form = init?.body as FormData;
    assert.equal(form.get("model"), "gpt-image-2");
    assert.equal(form.get("n"), "1");
    assert.equal(form.get("size"), "768x1024");
    assert.equal(form.get("quality"), "low");
    assert.equal(form.get("moderation"), "low");
    assert.equal(form.get("output_format"), "jpeg");
    assert.equal(form.get("output_compression"), "45");
    assert.equal(form.getAll("image[]").length, 3);
    return new Response(JSON.stringify({
      data: [{ b64_json: fakeJpegBytes.toString("base64") }]
    }), { status: 200, statusText: "OK" });
  }) as typeof fetch;

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
      store,
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T12:00:00.000Z")),
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieImageApiKey: "test-key",
      outputRouter: {
        async send(output) {
          sent.push(output);
          return { messageId: `om_selfie_${nextMessageId++}` };
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_openai_direct",
      toolName: "Selfie",
      input: { pose: "靠近镜头" }
    });

    assert.equal(apiCalled, true);
    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRunner === undefined) {
      delete process.env.ALICE_SELFIE_FAST_RUNNER;
    } else {
      process.env.ALICE_SELFIE_FAST_RUNNER = previousRunner;
    }
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie_openaiMode_sendsGeneratedImage", async () => {
  const outputRoot = makeAssetTempDir("selfie-openai-direct-send");
  const referenceRoot = makeTempDir("selfie-ref-openai-direct-send");
  const store = createTestStore("selfie-openai-direct-send-db");
  const sent: AgentOutput[] = [];
  const previousFetch = globalThis.fetch;
  writeReferenceFiles(referenceRoot);
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({
      data: [{ b64_json: fakeJpegBytes.toString("base64") }]
    }), { status: 200, statusText: "OK" });
  }) as typeof fetch;

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieImageApiKey: "test-key",
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: selfieContext,
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_openai_direct_send",
      toolName: "Selfie",
      input: { pose: "靠近镜头" }
    });

    assert.equal(result.ok, true);
    assert.equal(sent[1].content.kind, "image");
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test("selfie_openaiRelayMode_sendsRelayRequestContract", async () => {
  const outputRoot = makeAssetTempDir("selfie-api-relay");
  const referenceRoot = makeTempDir("selfie-ref-api-relay");
  const outfitImage = path.join(makeTempDir("selfie-outfit-api-relay"), "dress.jpg");
  const store = createTestStore("selfie-api-relay-db");
  const sent: AgentOutput[] = [];
  const previousFetch = globalThis.fetch;
  let apiCalled = false;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");

  globalThis.fetch = (async (url, init) => {
    apiCalled = true;
    assert.equal(String(url), "https://relay.example.test/v1/images/edits");
    assert.deepEqual(init?.headers, { authorization: "Bearer relay-key" });
    const form = init?.body as FormData;
    assert.equal(form.get("model"), "relay-image-model");
    assert.equal(form.get("n"), "1");
    assert.equal(form.get("size"), "1024x1536");
    assert.equal(form.get("quality"), "medium");
    assert.equal(form.get("moderation"), null);
    assert.equal(form.get("output_format"), null);
    assert.equal(form.get("output_compression"), null);
    assert.equal(form.get("response_format"), null);
    assert.equal(form.getAll("image").length, 3);
    assert.equal(form.getAll("image[]").length, 0);
    assert.deepEqual(form.getAll("image").map((value) => value instanceof File ? value.name : ""), [
      "alice-character-reference.jpg",
      "dress.jpg",
      "magic-library-reference.jpg"
    ]);
    return new Response(JSON.stringify({
      data: [{ b64_json: fakeJpegBytes.toString("base64") }]
    }), { status: 200, statusText: "OK" });
  }) as typeof fetch;

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieMode: "openaiRelay",
      selfieImageApiKey: "openai-key",
      selfieImageApiBaseURL: "https://api.openai.com/v1",
      selfieImageApiRelayKey: "relay-key",
      selfieImageApiRelayBaseURL: "https://relay.example.test/v1",
      selfieImageApiRelayModel: "relay-image-model",
      selfieImageApiRelaySize: "1024x1536",
      selfieImageApiRelayQuality: "medium",
      selfieImageApiRelayModeration: "auto",
      selfieImageApiRelayOutputFormat: "webp",
      selfieImageApiRelayOutputCompression: 77,
      selfieImageApiRelayTimeoutMs: 90_000,
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_api_relay",
      toolName: "Selfie",
      input: { pose: "relay route" }
    });

    assert.equal(result.ok, true);
    assert.equal(apiCalled, true);
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie_openaiApiProvider_usesConfiguredFetchTimeouts", async () => {
  const workDir = makeTempDir("selfie-api-timeouts");
  const imagePath = path.join(workDir, "reference.jpg");
  const previousFetch = globalThis.fetch;
  let timeoutOptions: { headersTimeout?: number; bodyTimeout?: number } | undefined;
  fs.writeFileSync(imagePath, "reference-image");
  globalThis.fetch = (async (_url, init) => {
    timeoutOptions = undiciDispatcherOptions((init as RequestInit & { dispatcher?: unknown } | undefined)?.dispatcher);
    return new Response(JSON.stringify({
      data: [{ b64_json: fakeJpegBytes.toString("base64") }]
    }), { status: 200, statusText: "OK" });
  }) as typeof fetch;

  try {
    await runOpenAIAPISelfie({
      command: "",
      workDir,
      fileName: "selfie.jpg",
      prompt: "pose",
      codexExtraPrompt: "",
      referenceImages: [imagePath],
      referenceImagePrompt: "",
      timeoutMs: 600_000,
      apiKey: "relay-key",
      apiBaseURL: "https://relay.example.test/v1",
      apiEndpoint: "relayEdits",
      apiModel: "relay-image-model",
      apiSize: "1024x1536",
      apiQuality: "medium",
      apiModeration: "auto",
      apiOutputFormat: "webp",
      apiOutputCompression: 77,
      apiTimeoutMs: 600_000
    });

    assert.equal(timeoutOptions?.headersTimeout, 601_000);
    assert.equal(timeoutOptions?.bodyTimeout, 601_000);
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

function undiciDispatcherOptions(dispatcher: unknown): { headersTimeout?: number; bodyTimeout?: number } | undefined {
  if (!dispatcher || typeof dispatcher !== "object") return undefined;
  const optionsSymbol = Object.getOwnPropertySymbols(dispatcher).find((symbol) => symbol.description === "options");
  return optionsSymbol ? (dispatcher as Record<symbol, { headersTimeout?: number; bodyTimeout?: number }>)[optionsSymbol] : undefined;
}

test("selfie_openaiRelayMode_sendsGeneratedImage", async () => {
  const outputRoot = makeAssetTempDir("selfie-api-relay-send");
  const referenceRoot = makeTempDir("selfie-ref-api-relay-send");
  const store = createTestStore("selfie-api-relay-send-db");
  const sent: AgentOutput[] = [];
  const previousFetch = globalThis.fetch;
  writeReferenceFiles(referenceRoot);
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({
      data: [{ b64_json: fakeJpegBytes.toString("base64") }]
    }), { status: 200, statusText: "OK" });
  }) as typeof fetch;

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieMode: "openaiRelay",
      selfieImageApiRelayKey: "relay-key",
      selfieImageApiRelayBaseURL: "https://relay.example.test/v1",
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: selfieContext,
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_api_relay_send",
      toolName: "Selfie",
      input: { pose: "relay route" }
    });

    assert.equal(result.ok, true);
    assert.equal(sent[1].content.kind, "image");
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test("selfie_openaiRelayFetchFailure_logsCauseAndSendsFailureNotice", async () => {
  const outputRoot = makeAssetTempDir("selfie-api-relay-failure");
  const referenceRoot = makeTempDir("selfie-ref-api-relay-failure");
  const store = createTestStore("selfie-api-relay-failure-db");
  const sent: AgentOutput[] = [];
  const logs: string[] = [];
  const previousFetch = globalThis.fetch;
  writeReferenceFiles(referenceRoot);

  globalThis.fetch = (async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), {
      code: "ECONNREFUSED",
      errno: -111,
      syscall: "connect",
      address: "127.0.0.1",
      port: 3000
    });
    throw Object.assign(new Error("fetch failed"), { cause });
  }) as typeof fetch;

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieMode: "openaiRelay",
      selfieImageApiRelayKey: "relay-key",
      selfieImageApiRelayBaseURL: "http://localhost:3000/v1",
      appendLog: (_level, message) => logs.push(message),
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: selfieContext,
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_api_relay_fetch_failure",
      toolName: "Selfie",
      input: { pose: "relay failure" }
    });

    const joinedLogs = logs.join("\n");
    assert.equal(result.ok, false);
    assert.ok(joinedLogs);
    assert.equal(sent[1].content.kind, "text");
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test("selfie_codexMode_sendsCodexCommandContract", async () => {
  const outputRoot = makeAssetTempDir("selfie-codex-mode");
  const referenceRoot = makeTempDir("selfie-ref-codex-mode");
  const outfitImage = path.join(makeTempDir("selfie-outfit-codex-mode"), "dress.jpg");
  const codexDir = makeTempDir("selfie-codex-command");
  const codexPath = path.join(codexDir, "fake-codex.mjs");
  const codexHome = makeTempDir("selfie-codex-home");
  const generatedPath = path.join(codexHome, "generated_images", "run-1", "generated.png");
  const argsPath = path.join(codexDir, "args.json");
  const configPath = path.join(makeTempDir("selfie-photo-config"), "config.json");
  const store = createTestStore("selfie-codex-mode-db");
  const sent: AgentOutput[] = [];
  const previousCodexHome = process.env.CODEX_HOME;
  let nextMessageId = 1;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");
  fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
  fs.writeFileSync(codexPath, [
    "#!/usr/bin/env node",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
    "const args = process.argv.slice(2);",
    "if (args[0] !== 'exec') process.exit(2);",
    "if (args[1] !== '-C') process.exit(12);",
    "if (fs.readdirSync(args[2]).length !== 3) process.exit(13);",
    "const imageArgs = args.filter((arg) => arg.startsWith('--image='));",
    "if (imageArgs.some((arg) => path.dirname(arg.slice('--image='.length)) !== args[2])) process.exit(14);",
    "if (!args.includes('--ephemeral')) process.exit(3);",
    "if (!args.includes('--ignore-user-config')) process.exit(15);",
    "if (!args.includes('--disable') || !args.includes('plugins') || !args.includes('apps')) process.exit(16);",
    "if (!args.includes('--enable') || !args.includes('image_generation')) process.exit(19);",
    "if (!args.includes('-m') || !args.includes('gpt-5.4-mini')) process.exit(17);",
    "if (!args.includes('-c') || !args.includes('model_reasoning_effort=\"low\"')) process.exit(18);",
    "if (args.includes('--output-last-message')) process.exit(4);",
    "if (process.env.SELFIE_IMAGE_API_KEY === 'test-key') process.exit(10);",
    "if (process.env.OPENAI_API_KEY) process.exit(11);",
    `fs.mkdirSync(${JSON.stringify(path.dirname(generatedPath))}, { recursive: true });`,
    `fs.writeFileSync(${JSON.stringify(generatedPath)}, Buffer.from(${JSON.stringify(png1x1Bytes.toString("base64"))}, "base64"));`,
    "console.log(JSON.stringify({ type: 'done' }));"
  ].join("\n"));
  fs.chmodSync(codexPath, 0o755);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    selfieMode: "codex",
    selfieCodexCommand: codexPath,
    selfieCodexExtraPrompt: "configured codex extra prompt"
  })}\n`);
  process.env.CODEX_HOME = codexHome;

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
      store,
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T12:00:00.000Z")),
      selfieConfigPath: configPath,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieImageApiKey: "test-key",
      selfieCodexTimeoutMs: 60_000,
      outputRouter: {
        async send(output) {
          sent.push(output);
          return { messageId: `om_selfie_${nextMessageId++}` };
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_codex_mode",
      toolName: "Selfie",
      input: { pose: "转头看镜头" }
    });

    assert.equal(result.ok, true);
    const codexArgs = JSON.parse(fs.readFileSync(argsPath, "utf8")) as string[];
    assert.deepEqual(codexArgs.slice(0, 2), ["exec", "-C"]);
    assert.equal(codexArgs.at(-2), "--");
    const imageArgs = codexArgs.filter((arg) => arg.startsWith("--image="));
    assert.equal(imageArgs.length, 3);
    assert.equal(imageArgs.every((arg) => path.basename(arg.slice("--image=".length)).length > 0), true);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test("selfie_codexMode_sendsCodexPromptContract", async () => {
  const outputRoot = makeAssetTempDir("selfie-codex-prompt");
  const referenceRoot = makeTempDir("selfie-ref-codex-prompt");
  const codexDir = makeTempDir("selfie-codex-prompt-command");
  const codexPath = path.join(codexDir, "fake-codex.mjs");
  const codexHome = makeTempDir("selfie-codex-prompt-home");
  const generatedPath = path.join(codexHome, "generated_images", "run-1", "generated.png");
  const argsPath = path.join(codexDir, "args.json");
  const configPath = path.join(makeTempDir("selfie-codex-prompt-config"), "config.json");
  const store = createTestStore("selfie-codex-prompt-db");
  const previousCodexHome = process.env.CODEX_HOME;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(codexPath, [
    "#!/usr/bin/env node",
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
    `fs.mkdirSync(${JSON.stringify(path.dirname(generatedPath))}, { recursive: true });`,
    `fs.writeFileSync(${JSON.stringify(generatedPath)}, Buffer.from(${JSON.stringify(png1x1Bytes.toString("base64"))}, "base64"));`
  ].join("\n"));
  fs.chmodSync(codexPath, 0o755);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    selfieMode: "codex",
    selfieCodexCommand: codexPath,
    selfieCodexExtraPrompt: "configured codex extra prompt"
  })}\n`);
  process.env.CODEX_HOME = codexHome;

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
      store,
      selfieConfigPath: configPath,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      outputRouter: { async send() {} },
      getSelfieContext: selfieContext,
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_codex_prompt",
      toolName: "Selfie",
      input: { pose: "转头看镜头" }
    });

    assert.equal(result.ok, true);
    const codexArgs = JSON.parse(fs.readFileSync(argsPath, "utf8")) as string[];
    assert.equal(typeof codexArgs.at(-1), "string");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test("selfie_codexMode_convertsGeneratedAssetAndSendsResult", async () => {
  const outputRoot = makeAssetTempDir("selfie-codex-copy");
  const referenceRoot = makeTempDir("selfie-ref-codex-copy");
  const codexDir = makeTempDir("selfie-codex-copy-command");
  const codexPath = path.join(codexDir, "fake-codex.mjs");
  const codexHome = makeTempDir("selfie-codex-copy-home");
  const generatedPath = path.join(codexHome, "generated_images", "run-1", "generated.png");
  const configPath = path.join(makeTempDir("selfie-codex-copy-config"), "config.json");
  const store = createTestStore("selfie-codex-copy-db");
  const sent: AgentOutput[] = [];
  const previousCodexHome = process.env.CODEX_HOME;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(codexPath, [
    "#!/usr/bin/env node",
    "import fs from 'node:fs';",
    `fs.mkdirSync(${JSON.stringify(path.dirname(generatedPath))}, { recursive: true });`,
    `fs.writeFileSync(${JSON.stringify(generatedPath)}, Buffer.from(${JSON.stringify(png1x1Bytes.toString("base64"))}, "base64"));`
  ].join("\n"));
  fs.chmodSync(codexPath, 0o755);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    selfieMode: "codex",
    selfieCodexCommand: codexPath
  })}\n`);
  process.env.CODEX_HOME = codexHome;

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
      store,
      selfieConfigPath: configPath,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: selfieContext,
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_codex_copy",
      toolName: "Selfie",
      input: { pose: "转头看镜头" }
    });

    assert.equal(result.ok, true);
    assert.equal(sent[1].content.kind, "image");
    const sentAssetId = sent[1].content.kind === "image" ? sent[1].content.assetId : "";
    const finalBytes = fs.readFileSync(path.join(assetRootFromOutputDir(outputRoot), sentAssetId));
    assert.deepEqual([...finalBytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test("selfie_codexRunnerFailure_logsRunnerOutput", async () => {
  const outputRoot = makeAssetTempDir("selfie-codex-fail-log");
  const referenceRoot = makeTempDir("selfie-ref-codex-fail-log");
  const outfitImage = path.join(makeTempDir("selfie-outfit-codex-fail-log"), "dress.jpg");
  const codexDir = makeTempDir("selfie-codex-fail-command");
  const codexPath = path.join(codexDir, "fake-codex-fail.mjs");
  const codexHome = makeTempDir("selfie-codex-fail-home");
  const configPath = path.join(makeTempDir("selfie-codex-fail-config"), "config.json");
  const store = createTestStore("selfie-codex-fail-db");
  const sent: AgentOutput[] = [];
  const logs: string[] = [];
  const previousCodexHome = process.env.CODEX_HOME;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");
  fs.writeFileSync(codexPath, [
    "#!/usr/bin/env node",
    "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'test-thread' }));",
    "console.log(JSON.stringify({ type: 'turn.started' }));",
    "console.error('codex stderr failure detail');",
    "process.exit(23);"
  ].join("\n"));
  fs.chmodSync(codexPath, 0o755);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    selfieMode: "codex",
    selfieCodexCommand: codexPath,
    selfieCodexTimeoutMs: 60_000
  })}\n`);
  process.env.CODEX_HOME = codexHome;

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieConfigPath: configPath,
      appendLog: (_level, message) => logs.push(message),
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_codex_fail_log",
      toolName: "Selfie",
      input: { pose: "fail and log codex output" }
    });

    const joinedLogs = logs.join("\n");
    assert.equal(result.ok, false);
    assert.ok(joinedLogs);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test("selfie_codexRunnerFailure_sendsFailureNotice", async () => {
  const outputRoot = makeAssetTempDir("selfie-codex-fail-notice");
  const referenceRoot = makeTempDir("selfie-ref-codex-fail-notice");
  const codexDir = makeTempDir("selfie-codex-fail-notice-command");
  const codexPath = path.join(codexDir, "fake-codex-fail.mjs");
  const codexHome = makeTempDir("selfie-codex-fail-notice-home");
  const configPath = path.join(makeTempDir("selfie-codex-fail-notice-config"), "config.json");
  const store = createTestStore("selfie-codex-fail-notice-db");
  const sent: AgentOutput[] = [];
  const previousCodexHome = process.env.CODEX_HOME;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(codexPath, [
    "#!/usr/bin/env node",
    "process.exit(23);"
  ].join("\n"));
  fs.chmodSync(codexPath, 0o755);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    selfieMode: "codex",
    selfieCodexCommand: codexPath,
    selfieCodexTimeoutMs: 60_000
  })}\n`);
  process.env.CODEX_HOME = codexHome;

  try {
    const tools = createPhotoTools({ promptContextRuntime: testPromptRuntime(),
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieConfigPath: configPath,
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: selfieContext,
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_codex_fail_notice",
      toolName: "Selfie",
      input: { pose: "fail and send notice" }
    });

    assert.equal(result.ok, false);
    assert.equal(sent[1].content.kind, "text");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});
