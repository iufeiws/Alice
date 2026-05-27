import { test } from "node:test";
import assert from "node:assert/strict";
import { createMediaTools, type SelfieExecutorInput } from "../plugins/media/src/index.js";
import { createCurrentTimeProvider } from "../core/time/src/index.js";
import { createAliceStore } from "../packages/storage/src/sqlite-store.js";
import type { AgentOutput } from "../packages/types/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("selfie schema exposes action with 3:4 default", () => {
  const store = createAliceStore(path.join(makeTempDir("selfie-schema-db"), "alice.sqlite"));
  const tools = createMediaTools({
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
    const tools = createMediaTools({
      store,
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T12:00:00.000Z")),
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
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
    assert.match(executorInputs[0].prompt, /角色动作:\n踮脚靠近镜头/);
    assert.match(executorInputs[0].prompt, /发色: 低饱和浅金色/);
    assert.match(executorInputs[0].prompt, /弱气/);
    assert.match(executorInputs[0].prompt, /黑色哥特洛丽塔/);
    assert.deepEqual(executorInputs[0].referenceImages, [
      path.resolve(referenceRoot, "alice-character-reference.png"),
      path.resolve(outfitImage),
      path.resolve(referenceRoot, "magic-library-reference.png")
    ]);
    assert.equal(fs.existsSync(executorInputs[0].workDir), false);
    assert.equal(sent[0].content.kind, "text");
    assert.equal(sent[0].content.kind === "text" ? sent[0].content.text : "", "(少女拍照中...)");
    assert.equal(sent[1].content.kind, "image");
    assert.match(sent[1].content.kind === "image" ? sent[1].content.assetId : "", /\/selfie_20260526_120000\.jpg$/);
    assert.equal((result.output as { sent?: boolean; messageId?: string }).sent, true);
    assert.equal((result.output as { messageId?: string }).messageId, "om_selfie_2");
    assert.deepEqual(store.listMessagesForConversation("session-1", 10).map((message) => message.contentType), ["text", "image"]);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfitImage), { recursive: true, force: true });
  }
});

test("selfie fails before codex when the outfit reference image is missing", async () => {
  const outputRoot = makeAssetTempDir("selfie-missing-outfit");
  const referenceRoot = makeTempDir("selfie-ref-missing-outfit");
  const store = createAliceStore(path.join(makeTempDir("selfie-missing-outfit-db"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  let called = false;
  writeReferenceFiles(referenceRoot);

  try {
    const tools = createMediaTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
      selfieExecutor: async () => {
        called = true;
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

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /outfit reference/);
    assert.equal(called, false);
    assert.deepEqual(sent, []);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(referenceRoot, { recursive: true, force: true });
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
    const tools = createMediaTools({
      store,
      selfieReferenceDir: referenceRoot,
      selfieOutputDir: outputRoot,
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
    assert.equal(sent[0].content.kind === "text" ? sent[0].content.text : "", "(少女拍照中...)");
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
    const tools = createMediaTools({
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
    "角色动作:",
    "{{action}}",
    "角色特征:",
    "{{char}}",
    "{{persenality}}",
    "服装特征:",
    "{{dress}}"
  ].join("\n"));
  fs.writeFileSync(path.join(root, "alice-character-reference.png"), "alice-image");
  fs.writeFileSync(path.join(root, "magic-library-reference.png"), "library-image");
}

function makeAssetTempDir(name: string): string {
  const relative = path.join("assets", "generated", `test-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(relative, { recursive: true });
  return relative;
}

function makeTempDir(name: string): string {
  const dir = path.join("/tmp", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
