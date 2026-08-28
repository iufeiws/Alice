import { test } from "node:test";
import assert from "node:assert/strict";
import { createBashSandboxRuntime, classifyBashCommand } from "../../../src/contexts/bash-sandbox/src/index.js";
import { loadConfig } from "../../../src/apps/api/bootstrap/app-config-runtime.js";
import { fakeExecutor, testConfig, tmpDir } from "./bash-sandbox-helpers.js";

const fs = await import("node:fs");

test("bash sandbox runtime executes through the executor by default", async () => {
  const runtime = createBashSandboxRuntime({
    config: testConfig(),
    executor: fakeExecutor(async () => ({ stdout: "sandbox\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false }))
  });

  const output = await runtime.run({ id: "bash_1", toolName: "Bash", input: { command: "echo hello" } });

  assert.equal(output.denied, false);
  assert.equal(output.stdout, "sandbox\n");
});

test("bash sandbox runtime returns docker result without throwing on non-zero exit", async () => {
  const runtime = createBashSandboxRuntime({
    config: testConfig(),
    executor: fakeExecutor(async () => ({ stdout: "", stderr: "nope", exitCode: 2, timedOut: false, durationMs: 3, truncated: false }))
  });

  const output = await runtime.run({ id: "bash_2", toolName: "Bash", input: { command: "echo hello" } });

  assert.equal(output.denied, false);
  assert.equal(output.exitCode, 2);
  assert.equal(output.stderr, "nope");
});

test("permission gate only enforces sandbox entry boundary", () => {
  const config = testConfig();
  const cwd = config.workspaceDir;

  assert.equal(classifyBashCommand({ config, cwd, command: "echo hello" }).state, "allow");
  assert.match(denyReason(classifyBashCommand({ config, cwd, command: "" })), /required/);
  assert.match(denyReason(classifyBashCommand({ config, cwd: "/etc", command: "echo hello" })), /cwd/);
});

test("config mounts installed skills read-write at the sandbox home", () => {
  const config = loadConfig({});

  assert.deepEqual(config.bashSandbox.mounts.slice(0, 1).map((mount) => ({
    hostPath: mount.hostPath,
    containerPath: mount.containerPath,
    readOnly: mount.readOnly
  })), [
    { hostPath: fs.realpathSync(".agents"), containerPath: "/home/alice/.agents", readOnly: false }
  ]);
});

test("config mounts the minimal git-visible project tree and the complete memory-files directory", () => {
  const config = loadConfig({});
  const codebaseMounts = config.bashSandbox.mounts.filter((mount) => mount.containerPath.startsWith("/home/alice/codebase/"));

  assert.equal(codebaseMounts.some((mount) => mount.containerPath === "/home/alice/codebase/README.md" && mount.hostPath === fs.realpathSync("README.md") && !mount.readOnly), true);
  assert.equal(codebaseMounts.some((mount) => mount.containerPath === "/home/alice/codebase/src" && mount.hostPath === fs.realpathSync("src") && !mount.readOnly), true);
  assert.equal(codebaseMounts.some((mount) => mount.containerPath === "/home/alice/codebase/.gitignore"), false);
  assert.equal(codebaseMounts.some((mount) => mount.containerPath === "/home/alice/codebase/.vscode"), false);
  assert.equal(codebaseMounts.some((mount) => mount.containerPath === "/home/alice/codebase/.env"), false);
  assert.equal(codebaseMounts.some((mount) => mount.containerPath === "/home/alice/codebase/tests"), false);
  assert.equal(codebaseMounts.some((mount) => mount.containerPath.includes("__pycache__")), false);
  assert.deepEqual(codebaseMounts.filter((mount) => mount.containerPath === "/home/alice/codebase/memory-files"), [
    { id: "codebase_memory_files", hostPath: fs.realpathSync("memory-files"), containerPath: "/home/alice/codebase/memory-files", readOnly: false }
  ]);
  assert.equal(codebaseMounts.length < 100, true);
});

test("config includes an untracked file that is not ignored", () => {
  const relativePath = `.alice-codebase-visible-${process.pid}`;
  fs.writeFileSync(relativePath, "visible\n", "utf8");
  try {
    const config = loadConfig({});
    assert.equal(config.bashSandbox.mounts.some((mount) => mount.containerPath === `/home/alice/codebase/${relativePath}` && mount.hostPath === fs.realpathSync(relativePath)), true);
  } finally {
    fs.rmSync(relativePath, { force: true });
  }
});

test("config rejects sensitive host paths", () => {
  assert.throws(() => loadConfig({ BASH_SANDBOX_MOUNTS: JSON.stringify([{ hostPath: "/etc", containerPath: "/mnt/etc" }]) }), /sensitive host path/);
  const skillsDir = loadConfig({}).bashSandbox.skillsDir;
  assert.throws(() => loadConfig({ BASH_SANDBOX_MOUNTS: JSON.stringify([{ hostPath: tmpDir("mount"), containerPath: `${skillsDir}/generated`, readOnly: false }]) }), /skills mount/);
});

function denyReason(value: ReturnType<typeof classifyBashCommand>): string {
  return value.state === "deny" ? value.reason : "";
}
