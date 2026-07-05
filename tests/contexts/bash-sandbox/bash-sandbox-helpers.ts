import type { BashSandboxConfig, DockerExecutor } from "../../../src/contexts/bash-sandbox/src/index.js";
import type { FeishuDynamicCardClient } from "../../../src/channels/feishu/src/types.js";

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

export type FakeBashCardCall =
  | { kind: "create"; receiveId: string; command: string; content: string }
  | { kind: "append"; cardId: string; command: string; content: string; sequence: number }
  | { kind: "update"; cardId: string; block: "title" | "content"; content: string; sequence: number }
  | { kind: "stream"; cardId: string; enabled: boolean; sequence: number };

export function testConfig(overrides: Partial<BashSandboxConfig> = {}): BashSandboxConfig {
  const root = tmpDir("bash-sandbox");
  return {
    containerName: "test-bash-sandbox",
    image: "cimg/python:3.13-browsers",
    defaultCwd: "/workspace",
    hostWorkspaceDir: path.join(root, "workspace"),
    workspaceDir: "/workspace",
    hostCacheDir: path.join(root, "cache"),
    cacheDir: "/cache",
    tmpDir: "/tmp",
    skillMounts: [{ id: "demo", hostPath: path.join(root, "skills", "demo"), containerPath: "/skills/demo", readOnly: true }],
    mounts: [],
    network: "none",
    timeoutMs: 1000,
    outputLimitBytes: 30_000,
    auditLogPath: path.join(root, "audit.jsonl"),
    ...overrides
  };
}

export function fakeExecutor(run: DockerExecutor["execute"]): DockerExecutor {
  return { execute: run };
}

export function fakeFeishuCardClient(): FeishuDynamicCardClient & { calls: FakeBashCardCall[]; contents: string[] } {
  const calls: FakeBashCardCall[] = [];
  const contents: string[] = [];
  return {
    calls,
    contents,
    isStarted: () => true,
    async createAgentRunCard() {
      throw new Error("unused");
    },
    async updateAgentRunCard() {
      throw new Error("unused");
    },
    async setAgentRunCardStreaming() {
      throw new Error("unused");
    },
    async resolveAgentRunCardId() {
      return {};
    },
    async createBashRunCard(input) {
      calls.push({ kind: "create", receiveId: input.receiveId, command: input.command, content: input.content });
      contents.push(input.content);
      return { messageId: "om_bash", cardId: "card_bash" };
    },
    async appendBashRunCardPanel(input) {
      calls.push({ kind: "append", cardId: input.cardId, command: input.command, content: input.content, sequence: input.sequence });
      contents.push(input.content);
    },
    async updateBashRunCard(input) {
      calls.push({ kind: "update", cardId: input.cardId, block: input.block, content: input.content, sequence: input.sequence });
      contents.push(input.content);
    },
    async setBashRunCardStreaming(input) {
      calls.push({ kind: "stream", cardId: input.cardId, enabled: input.enabled, sequence: input.sequence });
    }
  };
}

export function writeSkill(root: string, relative: string, frontmatter: string, body: string): string {
  const skillRoot = path.join(root, relative);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`);
  return skillRoot;
}

export function tmpDir(name: string): string {
  const root = path.join(os.tmpdir(), "alice-tests");
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, `${name}-`));
}
