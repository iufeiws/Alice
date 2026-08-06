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
    { hostPath: fs.realpathSync(".agents/skills"), containerPath: config.bashSandbox.skillsDir, readOnly: false }
  ]);
});

test("config mounts the project codebase read-write inside the sandbox", () => {
  const config = loadConfig({});

  assert.deepEqual(config.bashSandbox.mounts.filter((mount) => mount.containerPath.startsWith("/alice/codebase/")), [
    { id: "codebase_src", hostPath: fs.realpathSync("src"), containerPath: "/alice/codebase/src", readOnly: false },
    { id: "codebase_memory_files", hostPath: fs.realpathSync("memory-files"), containerPath: "/alice/codebase/memory-files", readOnly: false },
    { id: "codebase_tests", hostPath: fs.realpathSync("tests"), containerPath: "/alice/codebase/tests", readOnly: false },
    { id: "codebase_scripts", hostPath: fs.realpathSync("scripts"), containerPath: "/alice/codebase/scripts", readOnly: false },
    { id: "codebase_docs", hostPath: fs.realpathSync("docs"), containerPath: "/alice/codebase/docs", readOnly: false }
  ]);
});

test("config rejects sensitive host paths", () => {
  assert.throws(() => loadConfig({ BASH_SANDBOX_MOUNTS: JSON.stringify([{ hostPath: "/etc", containerPath: "/mnt/etc" }]) }), /sensitive host path/);
  const skillsDir = loadConfig({}).bashSandbox.skillsDir;
  assert.throws(() => loadConfig({ BASH_SANDBOX_MOUNTS: JSON.stringify([{ hostPath: tmpDir("mount"), containerPath: `${skillsDir}/generated`, readOnly: false }]) }), /skills mount/);
});

function denyReason(value: ReturnType<typeof classifyBashCommand>): string {
  return value.state === "deny" ? value.reason : "";
}
