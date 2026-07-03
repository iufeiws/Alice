import { test } from "node:test";
import assert from "node:assert/strict";
import { createPhotoTools } from "../../../../src/capabilities/tools/photo/src/index.js";
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

test("selfie_openaiMode_callsImageApiDirectly", async () => {
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
    assert.doesNotMatch(String(form.get("prompt")), /画幅比例|API生成约束|输入图片顺序/);
    return new Response(JSON.stringify({
      data: [{ b64_json: fakeJpegBytes.toString("base64") }]
    }), { status: 200, statusText: "OK" });
  }) as typeof fetch;

  try {
    const tools = createPhotoTools({
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
    assert.equal(sent[1].content.kind, "image");
    assert.equal(result.output, "照片已发送");
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

test("selfie_openaiRelayMode_usesRelayEditsRoute", async () => {
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
    assert.doesNotMatch(String(form.get("prompt")), /画幅比例|API生成约束|输入图片顺序/);
    return new Response(JSON.stringify({
      data: [{ b64_json: fakeJpegBytes.toString("base64") }]
    }), { status: 200, statusText: "OK" });
  }) as typeof fetch;

  try {
    const tools = createPhotoTools({
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
    assert.equal(sent[1].content.kind, "image");
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
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
    const tools = createPhotoTools({
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
    assert.match(joinedLogs, /Image API relayEdits request failed/);
    assert.match(joinedLogs, /url=http:\/\/localhost:3000\/v1\/images\/edits/);
    assert.match(joinedLogs, /code=ECONNREFUSED/);
    assert.match(joinedLogs, /address=127\.0\.0\.1/);
    assert.equal(sent[1].content.kind === "text" ? sent[1].content.text : "", "-大失败-");
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test("selfie_codexMode_copiesGeneratedImage", async () => {
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
    "const prompt = args.at(-1) || '';",
    "if (args[0] !== 'exec') process.exit(2);",
    "if (args[1] !== '-C') process.exit(12);",
    "if (fs.readdirSync(args[2]).length !== 3) process.exit(13);",
    "const imageArgs = args.filter((arg) => arg.startsWith('--image='));",
    "if (imageArgs.some((arg) => path.dirname(arg.slice('--image='.length)) !== args[2])) process.exit(14);",
    "if (!args.includes('--ephemeral')) process.exit(3);",
    "if (!args.includes('--ignore-user-config')) process.exit(15);",
    "if (!args.includes('--disable') || !args.includes('plugins') || !args.includes('apps')) process.exit(16);",
    "if (!args.includes('-m') || !args.includes('gpt-5.4-mini')) process.exit(17);",
    "if (!args.includes('-c') || !args.includes('model_reasoning_effort=\"low\"')) process.exit(18);",
    "if (args.includes('--output-last-message')) process.exit(4);",
    "if (prompt.includes('Apply these skill instructions exactly:')) process.exit(5);",
    "if (prompt.includes('Task prompt:')) process.exit(6);",
    "if (prompt.includes('Task metadata:')) process.exit(7);",
    "if (!prompt.includes('1024x1536')) process.exit(9);",
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
    selfieCodexCommand: codexPath
  })}\n`);
  process.env.CODEX_HOME = codexHome;

  try {
    const tools = createPhotoTools({
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
    assert.equal(codexArgs.includes("--ephemeral"), true);
    assert.equal(codexArgs.includes("--ignore-user-config"), true);
    assert.equal(codexArgs.includes("plugins"), true);
    assert.equal(codexArgs.includes("apps"), true);
    assert.equal(codexArgs.includes("gpt-5.4-mini"), true);
    assert.equal(codexArgs.includes('model_reasoning_effort="low"'), true);
    assert.equal(codexArgs.includes("--output-last-message"), false);
    const imageArgs = codexArgs.filter((arg) => arg.startsWith("--image="));
    assert.equal(imageArgs.length, 3);
    assert.deepEqual(imageArgs.map((arg) => path.basename(arg.slice("--image=".length))), ["reference-1.jpg", "reference-2.jpg", "reference-3.jpg"]);
    assert.equal(sent[1].content.kind, "image");
    const sentAssetId = sent[1].content.kind === "image" ? sent[1].content.assetId : "";
    const finalBytes = fs.readFileSync(path.join(assetRootFromOutputDir(outputRoot), sentAssetId));
    assert.deepEqual([...finalBytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.equal(result.output, "照片已发送");
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

test("selfie_codexRunnerFailure_logsOutputAndSendsFailureNotice", async () => {
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
    const tools = createPhotoTools({
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
    assert.match(joinedLogs, /=== codex stdout ===/);
    assert.match(joinedLogs, /"type":"turn\.started"/);
    assert.match(joinedLogs, /=== codex stderr ===/);
    assert.match(joinedLogs, /codex stderr failure detail/);
    assert.match(joinedLogs, /codex-stdout\.jsonl/);
    assert.equal(sent[1].content.kind === "text" ? sent[1].content.text : "", "-大失败-");
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
