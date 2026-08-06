import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";
import { createMessagingTools } from "../../../../src/capabilities/tools/messaging/src/index.js";
import { resolveSandboxHostPath } from "../../../../src/contexts/bash-sandbox/src/index.js";
import type { BashSandboxConfig } from "../../../../src/contexts/bash-sandbox/src/index.js";
import { createAliceStore } from "../../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { AgentOutput } from "../../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";

const fs = await import("node:fs");
const fsp = await import("node:fs/promises");
const path = await import("node:path");
const os = await import("node:os");

const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSandboxConfig(sandboxRoot: string): BashSandboxConfig {
  return {
    containerName: "alice-bash-sandbox",
    image: "cimg/python:3.13-browsers",
    defaultCwd: "/home/alice",
    hostWorkspaceDir: path.join(sandboxRoot, "workspace"),
    workspaceDir: "/home/alice",
    hostCacheDir: path.join(sandboxRoot, "cache"),
    cacheDir: "/cache",
    tmpDir: "/tmp",
    skillsDir: "/home/alice/.agent/skills",
    skillMounts: [],
    mounts: [],
    network: "none",
    timeoutMs: 60_000,
    outputLimitBytes: 30_000
  };
}

async function createSendFileHarness(name: string) {
  const sandboxRoot = makeTempDir(`${name}-sandbox`);
  const assetRoot = path.join(makeTempDir(`${name}-assets`), "assets");
  fs.mkdirSync(assetRoot, { recursive: true });
  const store = createAliceStore(path.join(makeTempDir(name), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    sleep: async () => {},
    config: {
      splitMultilineSendChat: false,
      limitConsecutiveSends: false,
      feishuTypingEmojiEnabled: true,
      mapMarkdownLikeToMarkdown: false
    },
    bashSandbox: makeSandboxConfig(sandboxRoot),
    sandboxSendAssetRoot: assetRoot,
    sandboxSendOutputDir: path.join(assetRoot, "plugin", "send-file"),
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: `sent_${sent.length}` };
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
  });
  return { tools, sandboxRoot, assetRoot, sent, store };
}

test("resolveSandboxHostPath maps container workspace path to host path", () => {
  const config = makeSandboxConfig("/tmp/sandbox-root");
  assert.equal(resolveSandboxHostPath(config, "/home/alice/a/b.txt"), "/tmp/sandbox-root/workspace/a/b.txt");
  assert.equal(resolveSandboxHostPath(config, "/cache/npm/c.txt"), "/tmp/sandbox-root/cache/npm/c.txt");
  assert.equal(resolveSandboxHostPath(config, "/etc/passwd"), undefined);
  assert.equal(resolveSandboxHostPath(config, "/tmp/x.txt"), undefined);
  assert.equal(resolveSandboxHostPath(config, "a/b.txt", "/home/alice"), "/tmp/sandbox-root/workspace/a/b.txt");
  assert.equal(resolveSandboxHostPath(config, "/home/alice/../etc/passwd"), undefined);
});

test("send_file_sends_image_when_file_has_png_magic_bytes", async () => {
  const { tools, sandboxRoot, assetRoot, sent } = await createSendFileHarness("send-file-image-magic");
  fs.mkdirSync(path.join(sandboxRoot, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(sandboxRoot, "workspace", "photo.bin"), Buffer.concat([pngMagic, Buffer.from("fake png body")]));

  const result = await tools.execute({
    id: "call_send_image",
    toolName: "Chat",
    input: { action: "send", type: "file", content: "/home/alice/photo.bin" }
  });

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  const output = sent[0];
  assert.equal(output.content.kind, "image");
  assert.ok(output.content.assetId.startsWith("plugin/send-file/photo_"));
  assert.ok(fs.existsSync(path.join(assetRoot, output.content.assetId)));
});

test("send_file_sends_image_for_png_extension", async () => {
  const { tools, sandboxRoot, assetRoot, sent } = await createSendFileHarness("send-file-image-ext");
  fs.mkdirSync(path.join(sandboxRoot, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(sandboxRoot, "workspace", "photo.png"), "not really an image");

  const result = await tools.execute({
    id: "call_send_image_ext",
    toolName: "Chat",
    input: { action: "send", type: "file", content: "/home/alice/photo.png" }
  });

  assert.equal(result.ok, true);
  assert.equal(sent[0].content.kind, "image");
  assert.ok(fs.existsSync(path.join(assetRoot, sent[0].content.assetId)));
});

test("send_file_sends_plain_file_with_filename", async () => {
  const { tools, sandboxRoot, assetRoot, sent } = await createSendFileHarness("send-file-plain");
  fs.mkdirSync(path.join(sandboxRoot, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(sandboxRoot, "workspace", "report.txt"), "hello world");

  const result = await tools.execute({
    id: "call_send_file",
    toolName: "Chat",
    input: { action: "send", type: "file", content: "/home/alice/report.txt" }
  });

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  const output = sent[0];
  assert.equal(output.content.kind, "file");
  assert.equal(output.content.filename, "report.txt");
  assert.ok(output.content.assetId.startsWith("plugin/send-file/report_"));
  assert.ok(fs.existsSync(path.join(assetRoot, output.content.assetId)));
});

test("send_file_fails_when_sandbox_not_configured", async () => {
  const store = createAliceStore(path.join(makeTempDir("send-file-no-sandbox"), "alice.sqlite"));
  const tools = createMessagingTools({
    store,
    sleep: async () => {},
    config: { splitMultilineSendChat: false, limitConsecutiveSends: false, feishuTypingEmojiEnabled: true, mapMarkdownLikeToMarkdown: false },
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
  });

  const result = await tools.execute({
    id: "call_send_file_no_sandbox",
    toolName: "Chat",
    input: { action: "send", type: "file", content: "/home/alice/report.txt" }
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /沙盒未配置/);
});

test("send_file_fails_for_path_outside_sandbox_mounts", async () => {
  const { tools } = await createSendFileHarness("send-file-outside");

  const result = await tools.execute({
    id: "call_send_file_outside",
    toolName: "Chat",
    input: { action: "send", type: "file", content: "/etc/passwd" }
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /不在允许的挂载目录内/);
});

test("send_file_fails_when_file_missing", async () => {
  const { tools } = await createSendFileHarness("send-file-missing");

  const result = await tools.execute({
    id: "call_send_file_missing",
    toolName: "Chat",
    input: { action: "send", type: "file", content: "/home/alice/missing.txt" }
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /文件不存在/);
});

test("send_file_fails_when_path_is_directory", async () => {
  const { tools, sandboxRoot } = await createSendFileHarness("send-file-dir");
  fs.mkdirSync(path.join(sandboxRoot, "workspace", "folder"), { recursive: true });

  const result = await tools.execute({
    id: "call_send_file_dir",
    toolName: "Chat",
    input: { action: "send", type: "file", content: "/home/alice/folder" }
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /不是文件/);
});

test("send_file_keeps_staged_asset_when_send_fails_for_retry", async () => {
  const sandboxRoot = makeTempDir("send-file-fail-sandbox");
  const assetRoot = path.join(makeTempDir("send-file-fail-assets"), "assets");
  fs.mkdirSync(path.join(sandboxRoot, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(sandboxRoot, "workspace", "report.txt"), "hello");

  const store = createAliceStore(path.join(makeTempDir("send-file-fail"), "alice.sqlite"));
  const failingTools = createMessagingTools({
    store,
    sleep: async () => {},
    config: { splitMultilineSendChat: false, limitConsecutiveSends: false, feishuTypingEmojiEnabled: true, mapMarkdownLikeToMarkdown: false },
    bashSandbox: makeSandboxConfig(sandboxRoot),
    sandboxSendAssetRoot: assetRoot,
    sandboxSendOutputDir: path.join(assetRoot, "plugin", "send-file"),
    outputRouter: {
      async send() {
        throw new Error("channel rejected");
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
  });

  const result = await failingTools.execute({
    id: "call_send_file_fail",
    toolName: "Chat",
    input: { action: "send", type: "file", content: "/home/alice/report.txt" }
  });

  assert.equal(result.ok, false);
  const stagedFiles = fs.readdirSync(path.join(assetRoot, "plugin", "send-file"));
  assert.equal(stagedFiles.length, 1, "staged asset must be kept so the send retry can reuse it");
});
