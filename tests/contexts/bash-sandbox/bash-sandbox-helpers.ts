import type { BashSandboxConfig, DockerExecutor } from "../../../src/contexts/bash-sandbox/src/index.js";

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

export function testConfig(overrides: Partial<BashSandboxConfig> = {}): BashSandboxConfig {
  const root = tmpDir("bash-sandbox");
  const skillsDir = "/home/alice/.agent/skills";
  return {
    containerName: "test-bash-sandbox",
    image: "cimg/python:3.13-browsers",
    defaultCwd: "/home/alice",
    hostWorkspaceDir: path.join(root, "alice"),
    workspaceDir: "/home/alice",
    hostCacheDir: path.join(root, "cache"),
    cacheDir: "/cache",
    tmpDir: "/tmp",
    skillsDir,
    skillMounts: [{ id: "demo", hostPath: path.join(root, "skills", "demo"), containerPath: path.posix.join(skillsDir, "demo"), readOnly: true }],
    mounts: [],
    network: "none",
    timeoutMs: 1000,
    outputLimitBytes: 30_000,
    ...overrides
  };
}

export function fakeExecutor(run: DockerExecutor["execute"]): DockerExecutor {
  return { execute: run };
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
