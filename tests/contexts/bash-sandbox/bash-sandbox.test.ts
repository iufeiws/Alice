import { test } from "node:test";
import assert from "node:assert/strict";
import { createBashTools } from "../../../src/capabilities/tools/bash/src/index.js";
import { createBashSandboxRuntime, classifyBashCommand } from "../../../src/contexts/bash-sandbox/src/index.js";
import { loadConfig } from "../../../src/apps/api/bootstrap/app-config-runtime.js";
import { fakeExecutor, testConfig, tmpDir } from "./bash-sandbox-helpers.js";

const fs = await import("node:fs");

test("bash tool executes through sandbox runtime by default", async () => {
  const tools = createBashTools({
    runtime: createBashSandboxRuntime({
      config: testConfig(),
      executor: fakeExecutor(async () => ({ stdout: "sandbox\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false }))
    })
  });

  const result = await tools.execute({ id: "bash_1", toolName: "Bash", input: { command: "echo hello" } });
  const output = JSON.parse(String(result.output));

  assert.equal(result.ok, true);
  assert.equal(output.denied, false);
  assert.equal(output.stdout, "sandbox\n");
});

test("bash tool returns docker result without throwing on non-zero exit", async () => {
  const tools = createBashTools({
    runtime: createBashSandboxRuntime({
      config: testConfig(),
      executor: fakeExecutor(async () => ({ stdout: "", stderr: "nope", exitCode: 2, timedOut: false, durationMs: 3, truncated: false }))
    })
  });

  const result = await tools.execute({ id: "bash_2", toolName: "Bash", input: { command: "echo hello" } });
  const output = JSON.parse(String(result.output));

  assert.equal(result.ok, true);
  assert.equal(output.denied, false);
  assert.equal(output.exitCode, 2);
  assert.equal(output.stderr, "nope");
});

test("bash tool includes host submission results without changing sandbox output", async () => {
  const tools = createBashTools({
    runtime: createBashSandboxRuntime({
      config: testConfig(),
      executor: fakeExecutor(async () => ({ stdout: "marker\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false }))
    }),
    async handleResult(result) {
      assert.equal(result.stdout, "marker\n");
      return { type: "test", status: "approved" };
    }
  });

  const result = await tools.execute({ id: "bash_submission", toolName: "Bash", input: { command: "submit" } });
  const output = JSON.parse(String(result.output));

  assert.equal(output.stdout, "marker\n");
  assert.deepEqual(output.submission, { type: "test", status: "approved" });
});

test("bash runtime writes audit events for sandbox execution", async () => {
  const config = testConfig({ outputLimitBytes: 5, mounts: [{ id: "data", hostPath: tmpDir("data"), containerPath: "/mnt/data", readOnly: true }] });
  const runtime = createBashSandboxRuntime({
    config,
    executor: fakeExecutor(async () => ({ stdout: "abcdef", stderr: "", outputFiles: { stdout: { path: "/tmp/full.out", bytes: 6 } }, exitCode: 124, timedOut: true, durationMs: 9, truncated: true }))
  });

  await runtime.run({ id: "deny", toolName: "Bash", input: { command: "curl https://example.com" } });
  await runtime.run({ id: "timeout", toolName: "Bash", input: { command: "ls /mnt/data" } });
  const events = fs.readFileSync(config.auditLogPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));

  assert.equal(events[0].permission.state, "allow");
  assert.equal(events[1].permission.state, "allow");
  assert.equal(events[1].timedOut, true);
  assert.equal(events[1].truncated, true);
  assert.equal("optionalMounts" in events[1], false);
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
