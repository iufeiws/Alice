import { test } from "node:test";
import assert from "node:assert/strict";
import { createDockerBashExecutor, ensureDockerPiWorkerProcess, ensureDockerSandboxContainer, stopDockerSandboxContainer } from "../../../src/contexts/bash-sandbox/src/index.js";
import { testConfig, tmpDir } from "./bash-sandbox-helpers.js";

const childProcess = await import("node:child_process");
const fs = await import("node:fs");
const path = await import("node:path");

test("docker executor prepares a missing image", async () => {
  const { calls } = await runWithFakeDocker();

  assert.equal(calls.some((call) => call === "image inspect cimg/python:3.13-browsers"), true);
  assert.equal(calls.some((call) => call === "pull cimg/python:3.13-browsers"), true);
  assert.equal(calls.some((call) => call.startsWith("build --build-arg BASE_IMAGE=cimg/python:3.13-browsers")), true);
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
  assert.match(runCall, /--user alice/);
  assert.match(runCall, /--label com\.alice\.sandbox\.mount-key=/);
  assert.match(runCall, /--tmpfs \/tmp/);
  assert.match(runCall, /HOME=\/home\/alice/);
  assert.match(runCall, /BASH_ENV=\/home\/alice\/\.bashrc/);
  assert.match(runCall, /-w \/home\/alice/);
  assert.match(runCall, /\/sandbox\/bin:ro/);
  assert.match(runCall, /\/assets-host:\/assets:ro/);
  assert.match(runCall, /\/codebase\/README\.md:\/home\/alice\/codebase\/README\.md:rw/);
  assert.match(runCall, /:\/home\/alice\/\.agents:rw/);
  assert.ok(runCall.indexOf(":/home/alice/.agents:rw") < runCall.indexOf(":/home/alice/.agents/skills/demo:ro"));
  assert.equal(result.stdout.trim(), "docker-ok");
  assert.equal(progress.join(""), "docker-ok");
  assert.equal(result.streamedBeforeCommandFinished, true);
});

test("docker executor uses a configured tmp bind mount instead of tmpfs", async () => {
  const { calls } = await runWithFakeDocker(undefined, false, true);
  const runCall = calls.find((call) => call.startsWith("run ")) ?? "";

  assert.match(runCall, /:\/tmp:rw/);
  assert.doesNotMatch(runCall, /--tmpfs \/tmp/);
});

test("sandbox container starts independently from the Pi worker", async () => {
  const { calls } = await runWithFakeDocker(undefined, true);
  const runCall = calls.find((call) => call.startsWith("run ")) ?? "";
  assert.match(runCall, /alice-bash-sandbox:/);
  assert.match(runCall, /PI_TASK_TIMEOUT_SECONDS=21600/);
  assert.match(runCall, /sleep infinity$/);
  assert.doesNotMatch(runCall, /worker\.mjs/);
});

test("Pi worker is started lazily inside the existing sandbox container", async () => {
  const root = tmpDir("fake-docker-pi-worker");
  const bin = path.join(root, "bin");
  const log = path.join(root, "docker.log");
  fs.mkdirSync(bin, { recursive: true });
  const docker = path.join(bin, "docker");
  fs.writeFileSync(docker, `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
  fs.chmodSync(docker, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  try {
    const config = testConfig({
      piWorker: { enabled: true, hostDir: path.join(root, "pi-sessions"), containerDir: "/home/alice/.pi-sessions", port: 8790 }
    });
    await ensureDockerPiWorkerProcess(config);
    const call = fs.readFileSync(log, "utf8");
    assert.match(call, /^exec test-bash-sandbox sh -c /);
    assert.match(call, /worker\.mjs/);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("container creation removes only stale empty codebase mount points", async () => {
  const stalePaths: { emptyFile?: string; emptyDirectory?: string; retainedMount?: string; nonEmptyFile?: string } = {};
  await runWithFakeDocker(undefined, false, false, ({ config }) => {
    const codebaseRoot = path.join(config.hostWorkspaceDir, "codebase");
    stalePaths.emptyFile = path.join(codebaseRoot, ".gitignore");
    stalePaths.emptyDirectory = path.join(codebaseRoot, ".vscode");
    stalePaths.retainedMount = path.join(codebaseRoot, "README.md");
    stalePaths.nonEmptyFile = path.join(codebaseRoot, "local-note.txt");
    fs.mkdirSync(stalePaths.emptyDirectory, { recursive: true });
    fs.writeFileSync(stalePaths.emptyFile, "");
    fs.writeFileSync(path.join(stalePaths.emptyDirectory, "settings.json"), "");
    fs.writeFileSync(stalePaths.retainedMount, "");
    fs.writeFileSync(stalePaths.nonEmptyFile, "keep");
  });
  assert.equal(fs.existsSync(stalePaths.emptyFile!), false);
  assert.equal(fs.existsSync(stalePaths.emptyDirectory!), false);
  assert.equal(fs.existsSync(stalePaths.retainedMount!), true);
  assert.equal(fs.readFileSync(stalePaths.nonEmptyFile!, "utf8"), "keep");
});

test("container startup repairs Docker-owned staging paths before stale cleanup", async () => {
  const root = tmpDir("fake-docker-owned-mount-point");
  const bin = path.join(root, "bin");
  const workspace = path.join(root, "workspace");
  const staleDirectory = path.join(workspace, "codebase", ".vscode");
  fs.mkdirSync(staleDirectory, { recursive: true });
  fs.writeFileSync(path.join(staleDirectory, "settings.json"), "");
  fs.chmodSync(staleDirectory, 0o555);
  fs.mkdirSync(bin, { recursive: true });
  const docker = path.join(bin, "docker");
  fs.writeFileSync(docker, `#!/bin/sh
if [ "$1 $2" = "image inspect" ]; then exit 0; fi
if [ "$1" = "inspect" ]; then exit 1; fi
if [ "$1 $2" = "run --rm" ]; then chmod 755 "${staleDirectory}"; exit 0; fi
if [ "$1" = "run" ]; then printf 'container-owned-test\n'; exit 0; fi
exit 64
`);
  fs.chmodSync(docker, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  try {
    await ensureDockerSandboxContainer(testConfig({ hostWorkspaceDir: workspace, hostCacheDir: path.join(root, "cache") }));
    assert.equal(fs.existsSync(staleDirectory), false);
  } finally {
    if (fs.existsSync(staleDirectory)) fs.chmodSync(staleDirectory, 0o755);
    process.env.PATH = previousPath;
  }
});

test("sandbox cleanup state compensates an unclean stop and records a clean managed stop", async () => {
  const root = tmpDir("fake-docker-cleanup-state");
  const bin = path.join(root, "bin");
  const dockerStatePath = path.join(root, "docker.state");
  const dockerLabelPath = path.join(root, "docker.label");
  fs.mkdirSync(bin, { recursive: true });
  const docker = path.join(bin, "docker");
  fs.writeFileSync(docker, `#!/bin/sh
if [ "$1 $2" = "image inspect" ]; then exit 0; fi
if [ "$1" = "inspect" ]; then
  if [ ! -f "${dockerStatePath}" ]; then exit 1; fi
  state="$(cat "${dockerStatePath}")"
  label="$(cat "${dockerLabelPath}")"
  if [ "$state" = "running" ]; then running=true; else running=false; fi
  printf '%s|%s|container-1\n' "$running" "$label"
  exit 0
fi
if [ "$1" = "run" ]; then
  previous=
  for argument in "$@"; do
    if [ "$previous" = "--label" ]; then printf '%s' "\${argument#*=}" > "${dockerLabelPath}"; fi
    previous="$argument"
  done
  printf running > "${dockerStatePath}"
  printf 'container-1\n'
  exit 0
fi
if [ "$1" = "start" ]; then printf running > "${dockerStatePath}"; exit 0; fi
if [ "$1" = "stop" ]; then printf stopped > "${dockerStatePath}"; exit 0; fi
if [ "$1" = "rm" ]; then rm -f "${dockerStatePath}" "${dockerLabelPath}"; exit 0; fi
exit 64
`);
  fs.chmodSync(docker, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  try {
    const config = testConfig({
      hostWorkspaceDir: path.join(root, "workspace"),
      hostCacheDir: path.join(root, "cache")
    });
    await ensureDockerSandboxContainer(config);
    const cleanupStatePath = path.join(root, "workspace.codebase-mount-cleanup.json");
    assert.equal(JSON.parse(fs.readFileSync(cleanupStatePath, "utf8")).state, "dirty");

    const staleDirectory = path.join(config.hostWorkspaceDir, "codebase", ".vscode");
    fs.mkdirSync(staleDirectory, { recursive: true });
    fs.writeFileSync(path.join(staleDirectory, "settings.json"), "");
    fs.writeFileSync(dockerStatePath, "stopped");
    await ensureDockerSandboxContainer(config);
    assert.equal(fs.existsSync(staleDirectory), false);
    assert.equal(JSON.parse(fs.readFileSync(cleanupStatePath, "utf8")).state, "dirty");

    const staleFile = path.join(config.hostWorkspaceDir, "codebase", ".gitignore");
    fs.writeFileSync(staleFile, "");
    await stopDockerSandboxContainer(config);
    assert.equal(fs.existsSync(staleFile), false);
    assert.equal(JSON.parse(fs.readFileSync(cleanupStatePath, "utf8")).state, "clean");
    assert.equal(fs.readFileSync(dockerStatePath, "utf8"), "stopped");
  } finally {
    process.env.PATH = previousPath;
  }
});

async function runWithFakeDocker(
  onStdout?: (delta: string) => void,
  withPiWorker = false,
  mountTmp = false,
  prepareWorkspace?: (input: { config: ReturnType<typeof testConfig> }) => void
) {
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
if [ "$1" = "build" ]; then exit 0; fi
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
      ...(withPiWorker ? {
        piWorker: {
          enabled: true,
          hostDir: path.join(root, "pi-sessions"),
          containerDir: "/home/alice/.pi-sessions",
          port: 8790
        }
      } : {}),
      mounts: [
        { id: "agent", hostPath: path.join(root, "agent"), containerPath: "/home/alice/.agents", readOnly: false },
        { id: "assets", hostPath: path.join(root, "assets-host"), containerPath: "/assets", readOnly: true },
        { id: "codebase_file:README.md", hostPath: path.join(root, "codebase", "README.md"), containerPath: "/home/alice/codebase/README.md", readOnly: false },
        ...(mountTmp ? [{ id: "tmp", hostPath: path.join(root, "tmp"), containerPath: "/tmp", readOnly: false }] : [])
      ]
    });
    prepareWorkspace?.({ config });
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
