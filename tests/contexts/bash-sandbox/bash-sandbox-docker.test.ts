import { test } from "node:test";
import assert from "node:assert/strict";
import { createDockerBashExecutor } from "../../../src/contexts/bash-sandbox/src/index.js";
import { testConfig, tmpDir } from "./bash-sandbox-helpers.js";

const childProcess = await import("node:child_process");
const fs = await import("node:fs");
const path = await import("node:path");

test("docker executor prepares a missing image", async () => {
  const { calls } = await runWithFakeDocker();

  assert.equal(calls.some((call) => call === "image inspect cimg/python:3.13-browsers"), true);
  assert.equal(calls.some((call) => call === "pull cimg/python:3.13-browsers"), true);
});

test("docker executor runs with configured sandbox contract", async () => {
  const progress: string[] = [];
  const { calls, result } = await runWithFakeDocker((delta) => progress.push(delta));
  const runCall = calls.find((call) => call.startsWith("run ")) ?? "";

  assert.match(runCall, /--network bridge/);
  assert.match(runCall, /--add-host host\.docker\.internal:host-gateway/);
  assert.match(runCall, /HTTPS_PROXY=http:\/\/host\.docker\.internal:7890/);
  assert.match(runCall, /NO_PROXY=localhost,127\.0\.0\.1/);
  assert.match(runCall, /PATH=\/sandbox\/bin:/);
  assert.match(runCall, /HOME=\/alice/);
  assert.match(runCall, /-w \/alice/);
  assert.match(runCall, /\/sandbox\/bin:ro/);
  assert.match(runCall, /\/assets-host:\/assets:ro/);
  assert.ok(runCall.indexOf(":/alice/skills:rw") < runCall.indexOf(":/alice/skills/demo:ro"));
  assert.equal(result.stdout.trim(), "docker-ok");
  assert.equal(progress.join(""), "docker-ok");
  assert.equal(result.streamedBeforeCommandFinished, true);
});

async function runWithFakeDocker(onStdout?: (delta: string) => void) {
  const root = tmpDir("fake-docker");
  const bin = path.join(root, "bin");
  const log = path.join(root, "docker.log");
  const commandDone = path.join(root, "command.done");
  const streamAck = path.join(root, "stream.ack");
  fs.mkdirSync(bin, { recursive: true });
  const docker = path.join(bin, "docker");
  fs.writeFileSync(docker, `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1 $2" = "image inspect" ]; then exit 1; fi
if [ "$1" = "pull" ]; then exit 0; fi
if [ "$1" = "inspect" ]; then exit 1; fi
if [ "$1" = "run" ]; then exit 0; fi
if [ "$1" = "exec" ]; then
  shift
  if [ "$1" = "-w" ]; then shift 3; else shift; fi
  if [ "$1" = "bash" ]; then
    state=0
    for arg in "$@"; do
      if [ "$state" = "1" ]; then state=2; continue; fi
      if [ "$state" = "2" ]; then stdout_file="$arg"; state=3; continue; fi
      if [ "$state" = "3" ]; then stderr_file="$arg"; state=4; continue; fi
      if [ "$arg" = "alice-bash-capture" ]; then state=1; fi
    done
    printf docker-ok | tee "$stdout_file"
    while [ ! -f "${streamAck}" ]; do sleep 0.01; done
    touch "${commandDone}"
    : > "$stderr_file"
    exit 0
  fi
  if [ "$1" = "sh" ]; then wc -c < "$5"; exit 0; fi
  if [ "$1" = "head" ]; then head -c "$3" "$4"; exit 0; fi
  if [ "$1" = "rm" ]; then rm -f "$3" "$4"; exit 0; fi
fi
exit 64
`);
  fs.chmodSync(docker, 0o755);
  const previousPath = process.env.PATH;
  const previousHttpsProxy = process.env.HTTPS_PROXY;
  const previousNoProxy = process.env.NO_PROXY;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
  process.env.NO_PROXY = "localhost,127.0.0.1";
  try {
    const config = testConfig({
      network: "configured",
      hostWorkspaceDir: path.join(root, "alice"),
      hostCacheDir: path.join(root, "cache"),
      mounts: [
        { id: "skills", hostPath: path.join(root, "installed-skills"), containerPath: "/alice/skills", readOnly: false },
        { id: "assets", hostPath: path.join(root, "assets-host"), containerPath: "/assets", readOnly: true }
      ]
    });
    let streamedBeforeCommandFinished = false;
    const result = await createDockerBashExecutor(config).execute({
      command: "echo ok",
      cwd: config.workspaceDir,
      timeoutMs: 1000,
      outputLimitBytes: 1024,
      onStdout(delta) {
        if (delta && !fs.existsSync(commandDone)) {
          streamedBeforeCommandFinished = true;
          fs.writeFileSync(streamAck, "");
        }
        onStdout?.(delta);
      }
    });
    const calls = fs.readFileSync(log, "utf8").trim().split(/\r?\n/);
    return { calls, result: { ...result, streamedBeforeCommandFinished } };
  } finally {
    process.env.PATH = previousPath;
    if (previousHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previousHttpsProxy;
    if (previousNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previousNoProxy;
  }
}

test("docker executor saves full output in container tmp when preview limit is exceeded", async (t) => {
  if (process.env.BASH_SANDBOX_DOCKER_TEST !== "1") {
    t.skip("set BASH_SANDBOX_DOCKER_TEST=1 to run Docker integration");
    return;
  }
  const config = testConfig({ containerName: `alice-bash-sandbox-truncate-test-${process.pid}` });
  try {
    const result = await createDockerBashExecutor(config).execute({ command: "printf 1234567890", cwd: config.workspaceDir, timeoutMs: 5000, outputLimitBytes: 5 });
    assert.equal(result.truncated, true);
    assert.ok(result.stdout);
    assert.equal(result.outputFiles?.stdout?.bytes, 10);
    const saved = childProcess.spawnSync("docker", ["exec", config.containerName, "cat", result.outputFiles!.stdout!.path], { encoding: "utf8" });
    assert.equal(saved.stdout, "1234567890");
  } finally {
    childProcess.spawnSync("docker", ["rm", "-f", config.containerName], { stdio: "ignore" });
  }
});

test("docker executor runs in a fixed container when explicitly enabled", async (t) => {
  if (process.env.BASH_SANDBOX_DOCKER_TEST !== "1") {
    t.skip("set BASH_SANDBOX_DOCKER_TEST=1 to run Docker integration");
    return;
  }
  const config = testConfig({ containerName: `alice-bash-sandbox-test-${process.pid}` });
  for (const mount of config.skillMounts) fs.mkdirSync(mount.hostPath, { recursive: true });
  try {
    const result = await createDockerBashExecutor(config).execute({ command: "echo docker-ok", cwd: config.workspaceDir, timeoutMs: 5000, outputLimitBytes: 1024 });
    assert.equal(result.stdout.trim(), "docker-ok");
    assert.equal(result.exitCode, 0);

    const findResult = await createDockerBashExecutor(config).execute({ command: "find / -maxdepth 1 -type d | sort", cwd: config.workspaceDir, timeoutMs: 5000, outputLimitBytes: 4096 });
    assert.ok(findResult.stdout);
  } finally {
    childProcess.spawnSync("docker", ["rm", "-f", config.containerName], { stdio: "ignore" });
  }
});
