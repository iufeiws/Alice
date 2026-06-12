import { test } from "node:test";
import assert from "node:assert/strict";
import { createPhotoTools, type SelfieExecutorInput } from "../src/capabilities/tools/photo/src/index.js";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";
import { createAliceStore } from "../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { createToolOutputTargetResolver } from "../src/contexts/capabilities/src/tool-output-target.js";
import type { AgentOutput } from "../src/contexts/agent-loop/src/contracts/agent-contracts.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("selfie schema exposes action with 3:4 default", () => {
  const store = createAliceStore(path.join(makeTempDir("selfie-schema-db"), "alice.sqlite"));
  const tools = createPhotoTools({
    store,
    outputRouter: { async send() {} },
    getSelfieContext: selfieContext,
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
  });

  const selfie = tools.listTools()[0];
  assert.equal(selfie.name, "selfie");
  assert.deepEqual((selfie.inputSchema.properties as Record<string, unknown>).description, undefined);
  assert.deepEqual((selfie.inputSchema.properties as Record<string, { default?: string }>).aspectRatio.default, "3:4");
  assert.deepEqual(selfie.inputSchema.required, ["action"]);
});

test("selfie builds prompt and sends reference images in 1/2/3 order", async () => {
  const outputRoot = makeAssetTempDir("selfie-success");
  const referenceRoot = makeTempDir("selfie-ref");
  const outfitImage = path.join(makeTempDir("selfie-outfit"), "dress.jpg");
  const store = createAliceStore(path.join(makeTempDir("selfie-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const executorInputs: SelfieExecutorInput[] = [];
  let nextMessageId = 1;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");

  try {
    const tools = createPhotoTools({
      store,
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T12:00:00.000Z")),
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieExecutor: async (input) => {
        executorInputs.push(input);
        fs.writeFileSync(path.join(input.workDir, input.fileName), Buffer.from("fake-jpg"));
        return { stdout: "ok", stderr: "", lastMessage: "saved target file" };
      },
      outputRouter: {
        async send(output) {
          sent.push(output);
          return { messageId: `om_selfie_${nextMessageId++}` };
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getAppearanceDescription: () => "发色: 低饱和浅金色\n眼睛: 浅金色",
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie",
      toolName: "selfie",
      input: { action: "踮脚靠近镜头，比一个很小的剪刀手" }
    });

    assert.equal(result.ok, true);
    assert.equal(executorInputs[0].aspectRatio, "3:4");
    assert.equal(executorInputs[0].fileName, "selfie_20260526_120000.jpg");
    assert.match(executorInputs[0].prompt, /当前时间:\n12:00:00/);
    assert.match(executorInputs[0].prompt, /角色动作:\n踮脚靠近镜头/);
    assert.match(executorInputs[0].prompt, /发色: 低饱和浅金色/);
    assert.match(executorInputs[0].prompt, /说话声音很小/);
    assert.match(executorInputs[0].prompt, /黑色薄纱短袖高领上衣/);
    assert.deepEqual(executorInputs[0].referenceImages, [
      path.resolve(referenceRoot, "alice-character-reference.png"),
      path.resolve(outfitImage),
      path.resolve(referenceRoot, "magic-library-reference.png")
    ]);
    assert.equal(fs.existsSync(executorInputs[0].workDir), false);
    assert.equal(sent[0].content.kind, "text");
    assert.equal(sent[0].content.kind === "text" ? sent[0].content.text : "", "-少女拍照中-");
    assert.equal(sent[1].content.kind, "image");
    assert.match(sent[1].content.kind === "image" ? sent[1].content.assetId : "", /\/selfie_20260526_120000\.jpg$/);
    assert.equal(result.output, "照片已发送");
    assert.deepEqual(store.listMessagesForConversation("session-1", 10).map((message) => message.contentType), ["text", "image"]);
    assert.deepEqual(store.listMessagesForConversation("session-1", 10).map((message) => message.senderRole), ["system", "assistant"]);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie uses default output target for voice call requester", async () => {
  const outputRoot = makeAssetTempDir("selfie-voice-requester");
  const referenceRoot = makeTempDir("selfie-ref-voice-requester");
  const store = createAliceStore(path.join(makeTempDir("selfie-voice-requester-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  writeReferenceFiles(referenceRoot);

  try {
    const defaultTarget = { plugin: "feishu", channelId: "chat-default", sessionId: "session-default" };
    const expectedTarget = {
      plugin: "feishu",
      accountId: undefined,
      channelId: "chat-default",
      userId: undefined,
      sessionId: "session-default"
    };
    const tools = createPhotoTools({
      store,
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T12:00:00.000Z")),
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieExecutor: async (input) => {
        fs.writeFileSync(path.join(input.workDir, input.fileName), Buffer.from("fake-jpg"));
      },
      outputRouter: {
        async send(output) {
          sent.push(output);
          return { messageId: `om_voice_selfie_${sent.length}` };
        }
      },
      getSelfieContext: selfieContext,
      getDefaultTarget: () => defaultTarget,
      resolveOutputTarget: createToolOutputTargetResolver({
        getDefaultTarget: () => defaultTarget
      })
    });

    const result = await tools.execute({
      id: "call_selfie_voice",
      toolName: "selfie",
      input: { action: "对镜头挥手" },
      requester: { plugin: "webrtc_voice", channelId: "call-1", userId: "browser-1" },
      session: { scope: "dm", sessionId: "talk-session-1" }
    });

    assert.equal(result.ok, true);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((output) => output.target), [
      expectedTarget,
      expectedTarget
    ]);
    assert.deepEqual(store.listMessagesForConversation("session-default", 10).map((message) => message.contentType), ["text", "image"]);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test("selfie default api executor calls Image API directly", async () => {
  const outputRoot = makeAssetTempDir("selfie-api-direct");
  const referenceRoot = makeTempDir("selfie-ref-api-direct");
  const outfitImage = path.join(makeTempDir("selfie-outfit-api-direct"), "dress.jpg");
  const store = createAliceStore(path.join(makeTempDir("selfie-api-direct-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const previousFetch = globalThis.fetch;
  const previousRunner = process.env.ALICE_SELFIE_FAST_RUNNER;
  let nextMessageId = 1;
  let apiCalled = false;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");
  process.env.ALICE_SELFIE_FAST_RUNNER = "missing-runner-that-api-mode-must-not-use.mjs";
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
    assert.equal(form.get("output_format"), "jpeg");
    assert.equal(form.get("output_compression"), "45");
    assert.equal(form.getAll("image[]").length, 3);
    assert.match(String(form.get("prompt")), /画幅比例: 3:4/);
    return new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("api-direct-jpg").toString("base64") }]
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
      id: "call_selfie_api_direct",
      toolName: "selfie",
      input: { action: "靠近镜头" }
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

test("selfie codex mode calls alice-selfie-fast runner", async () => {
  const outputRoot = makeAssetTempDir("selfie-codex-mode");
  const referenceRoot = makeTempDir("selfie-ref-codex-mode");
  const outfitImage = path.join(makeTempDir("selfie-outfit-codex-mode"), "dress.jpg");
  const runnerDir = makeTempDir("selfie-codex-runner");
  const runnerPath = path.join(runnerDir, "runner.mjs");
  const configPath = path.join(makeTempDir("selfie-photo-config"), "config.json");
  const store = createAliceStore(path.join(makeTempDir("selfie-codex-mode-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const previousRunner = process.env.ALICE_SELFIE_FAST_RUNNER;
  let nextMessageId = 1;
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");
  fs.writeFileSync(runnerPath, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const configPath = process.argv[3];",
    "const input = JSON.parse(fs.readFileSync(configPath, 'utf8'));",
    "if (process.argv[2] !== '--tool-input') process.exit(2);",
    "if ('apiKey' in input) process.exit(3);",
    "if (process.env.SELFIE_IMAGE_API_KEY !== 'test-key') process.exit(4);",
    "fs.writeFileSync(path.join(input.workDir, input.fileName), Buffer.from('codex-runner-jpg'));",
    "console.error(`alice-selfie-fast completed; file=${input.fileName}`);"
  ].join("\n"));
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    selfieMode: "codex"
  })}\n`);
  process.env.ALICE_SELFIE_FAST_RUNNER = runnerPath;

  try {
    const tools = createPhotoTools({
      store,
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T12:00:00.000Z")),
      selfieConfigPath: configPath,
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
      id: "call_selfie_codex_mode",
      toolName: "selfie",
      input: { action: "转头看镜头" }
    });

    assert.equal(result.ok, true);
    assert.equal(sent[1].content.kind, "image");
    assert.equal(result.output, "照片已发送");
  } finally {
    if (previousRunner === undefined) {
      delete process.env.ALICE_SELFIE_FAST_RUNNER;
    } else {
      process.env.ALICE_SELFIE_FAST_RUNNER = previousRunner;
    }
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
    fs.rmSync(runnerDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test("selfie falls back to text outfit when the outfit reference image is missing", async () => {
  const outputRoot = makeAssetTempDir("selfie-missing-outfit");
  const referenceRoot = makeTempDir("selfie-ref-missing-outfit");
  const store = createAliceStore(path.join(makeTempDir("selfie-missing-outfit-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  let referenceImages: string[] = [];
  let referenceImagePrompt = "";
  writeReferenceFiles(referenceRoot);

  try {
    const tools = createPhotoTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieExecutor: async (input) => {
        referenceImages = input.referenceImages;
        referenceImagePrompt = input.referenceImagePrompt;
        fs.writeFileSync(path.join(input.workDir, input.fileName), "generated-image");
      },
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: path.join(referenceRoot, "missing.jpg") }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_missing_outfit",
      toolName: "selfie",
      input: { action: "看镜头" }
    });

    assert.equal(result.ok, true);
    assert.equal(referenceImages.length, 2);
    assert.deepEqual(referenceImages.map((image) => path.basename(image)), ["alice-character-reference.png", "magic-library-reference.png"]);
    assert.match(referenceImagePrompt, /不提供服装参考图/);
    assert.equal(sent[0].content.kind, "text");
    assert.equal(sent[0].content.kind === "text" ? sent[0].content.text : "", "-少女拍照中-");
    assert.equal(sent[1].content.kind, "image");
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test("selfie sends start notice before required reference failures", async () => {
  const outputRoot = makeAssetTempDir("selfie-missing-character");
  const referenceRoot = makeTempDir("selfie-ref-missing-character");
  const outfitImage = path.join(makeTempDir("selfie-outfit-missing-character"), "dress.jpg");
  const store = createAliceStore(path.join(makeTempDir("selfie-missing-character-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  writeReferenceFiles(referenceRoot);
  fs.rmSync(path.join(referenceRoot, "alice-character-reference.png"));
  fs.writeFileSync(outfitImage, "dress-image");

  try {
    const tools = createPhotoTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieExecutor: async () => {
        throw new Error("executor should not run");
      },
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_missing_character",
      toolName: "selfie",
      input: { action: "看镜头" }
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /character reference/);
    assert.equal(sent[0].content.kind === "text" ? sent[0].content.text : "", "-少女拍照中-");
    assert.equal(sent[1].content.kind === "text" ? sent[1].content.text : "", "-大失败-");
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie cleans up temporary directory when codex does not create the requested image", async () => {
  const outputRoot = makeAssetTempDir("selfie-missing");
  const referenceRoot = makeTempDir("selfie-ref-missing");
  const outfitImage = path.join(makeTempDir("selfie-outfit-missing"), "dress.jpg");
  const store = createAliceStore(path.join(makeTempDir("selfie-missing-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  let workDir = "";
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");

  try {
    const tools = createPhotoTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieAssetRoot: assetRootFromOutputDir(outputRoot),
      selfieExecutor: async (input) => {
        workDir = input.workDir;
        return { stdout: "done", lastMessage: "I could not create the requested file" };
      },
      outputRouter: {
        async send(output) {
          sent.push(output);
        }
      },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_missing",
      toolName: "selfie",
      input: { action: "missing file" }
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /not found/);
    assert.match(result.error ?? "", /I could not create/);
    assert.equal(fs.existsSync(workDir), false);
    assert.equal(sent[0].content.kind, "text");
    assert.equal(sent[0].content.kind === "text" ? sent[0].content.text : "", "-少女拍照中-");
    assert.equal(sent[1].content.kind, "text");
    assert.equal(sent[1].content.kind === "text" ? sent[1].content.text : "", "-大失败-");
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie rejects output directories outside assets", async () => {
  const referenceRoot = makeTempDir("selfie-ref-outside");
  const outfitImage = path.join(makeTempDir("selfie-outfit-outside"), "dress.jpg");
  const store = createAliceStore(path.join(makeTempDir("selfie-outside-db"), "alice.sqlite"));
  writeReferenceFiles(referenceRoot);
  fs.writeFileSync(outfitImage, "dress-image");
  try {
    const tools = createPhotoTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: makeTempDir("selfie-outside"),
      selfieExecutor: async () => {},
      outputRouter: { async send() {} },
      getSelfieContext: () => ({ ...selfieContext(), outfitImageUrl: outfitImage }),
      getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
    });

    const result = await tools.execute({
      id: "call_selfie_outside",
      toolName: "selfie",
      input: { action: "outside assets" }
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /inside assets/);
  } finally {
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

function selfieContext() {
  return {
    mainPrompt: [
      "你是爱丽丝",
      "",
      "外貌特征:",
      "发色: 低饱和浅金色",
      "眼睛: 浅金色",
      "",
      "你与 <user> 的根关系是造物和造主"
    ].join("\n"),
    personalityName: "弱气",
    personalityContent: "说话声音很小",
    outfitId: "gothic_lolita_black",
    outfitName: "黑色哥特洛丽塔",
    outfitContent: "黑色薄纱短袖高领上衣"
  };
}

function writeReferenceFiles(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "selfie-prompt.txt"), [
    "当前时间:",
    "{{time}}",
    "角色动作:",
    "{{action}}",
    "角色特征:",
    "{{appearance}}",
    "{{dailyShell/persona/content}}",
    "服装特征:",
    "{{outfit/content}}"
  ].join("\n"));
  fs.writeFileSync(path.join(root, "alice-character-reference.png"), "alice-image");
  fs.writeFileSync(path.join(root, "magic-library-reference.png"), "library-image");
}

function makeAssetTempDir(name: string): string {
  const dir = path.join(makeTempDir(`${name}-asset-root`), "assets", "generated", `test-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function assetRootFromOutputDir(outputDir: string): string {
  return path.resolve(outputDir, "..", "..");
}

function makeTempDir(name: string): string {
  const dir = path.join(process.cwd(), ".tmp-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
