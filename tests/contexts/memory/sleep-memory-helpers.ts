import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { StoredConversationMessage } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { BashSandboxConfig, BashSandboxRuntime } from "../../../src/contexts/bash-sandbox/src/index.js";
import { createMemoryInductionPromptStore } from "../../../src/contexts/memory/src/memory.js";

export function memoryConfig() {
  return {
    enabled: true,
    baseURL: "https://api.deepseek.com",
    apiKey: "test",
    model: "deepseek-v4-pro",
    temperature: 0.8,
    timeoutMs: 120_000,
    stream: false,
    extraParams: {},
    followupExtraParams: {}
  };
}

export function message(createdAt: string, contentText: string): StoredConversationMessage {
  return {
    id: Number(createdAt.replace(/\D/g, "").slice(-8)),
    plugin: "feishu",
    conversationId: "session",
    direction: "inbound",
    senderRole: "user",
    contentType: "text",
    contentText,
    createdAt,
    status: "sent",
    isRead: false,
    isRecalled: false,
    reactionsJson: "{}",
    lastEventAt: createdAt
  };
}

export function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function createTestMemoryPromptStore(root: string) {
  const store = createMemoryInductionPromptStore(path.join(root, "prompts.json"));
  store.save({
    meta: {},
    messages: [{ meta: { title: "Test", enabled: true }, role: "user", content: "" }]
  });
  return store;
}

export function makeMemorySandbox(root: string): { config: BashSandboxConfig; runtime: BashSandboxRuntime } {
  const hostWorkspaceDir = path.join(root, "sandbox", "workspace");
  const config: BashSandboxConfig = {
    containerName: "test",
    image: "test",
    defaultCwd: "/alice",
    hostWorkspaceDir,
    workspaceDir: "/alice",
    hostCacheDir: path.join(root, "sandbox", "cache"),
    cacheDir: "/cache",
    tmpDir: "/tmp",
    skillsDir: "/alice/.agent/skills",
    skillMounts: [],
    mounts: [],
    network: "none",
    timeoutMs: 1000,
    outputLimitBytes: 100_000,
  };
  const runtime: BashSandboxRuntime = {
    mountSkill(mount) {
      config.skillMounts.push(mount);
      return mount;
    },
    async run() {
      throw new Error("bash is not available in memory sandbox tests");
    },
    async runFileTool() {
      throw new Error("memory tests must not execute file tools");
    },
    async readFile() {
      throw new Error("memory tests must not execute file tools");
    }
  };
  return { config, runtime };
}
