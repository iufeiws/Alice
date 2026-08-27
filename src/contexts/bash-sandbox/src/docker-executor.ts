import type { BashSandboxConfig } from "./config.js";

const childProcess = await import("node:child_process");
const crypto = await import("node:crypto");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const { StringDecoder } = await import("node:string_decoder");

const PROXY_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
const WRAPPER_CONTAINER_DIR = "/sandbox/bin";
const WRAPPER_HOST_DIR = path.resolve("src/contexts/bash-sandbox/wrappers");
const PI_WORKER_RUNTIME_CONTAINER_DIR = "/sandbox/pi-worker";
const PI_WORKER_RUNTIME_HOST_DIR = path.resolve("src/contexts/pi-worker/runtime");
// v2: worker 以 --no-use-env-proxy 启动, 直连宿主 relay, 避免容器内
// HTTP_PROXY(host.docker.internal:7890 -> mihomo) 劫持 host↔容器本地流量。
const PI_WORKER_CONTAINER_REVISION = "pi-worker-runtime-v2";
const ALICE_CONTAINER_USER_REVISION = "alice-user-v1";
const CONTAINER_MOUNT_KEY_LABEL = "com.alice.sandbox.mount-key";

export type DockerExecutorResult = {
  stdout: string;
  stderr: string;
  outputFiles?: {
    stdout?: DockerOutputFile;
    stderr?: DockerOutputFile;
  };
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
};

export type DockerOutputFile = {
  path: string;
  bytes: number;
};

export type DockerExecutor = {
  execute(input: { command: string; cwd: string; timeoutMs: number; outputLimitBytes: number; onStdout?(delta: string): void; onStderr?(delta: string): void }): Promise<DockerExecutorResult>;
  runFileTool?(input: { toolName: "Read" | "Edit" | "Glob" | "Grep"; payload: Record<string, unknown>; timeoutMs: number; outputLimitBytes: number }): Promise<DockerExecutorResult>;
  readFile?(input: { payload: Record<string, unknown>; timeoutMs: number; outputLimitBytes: number }): Promise<DockerExecutorResult>;
};

export async function ensureDockerSandboxContainer(config: BashSandboxConfig): Promise<void> {
  await ensureContainer(config);
}

export async function recreateDockerSandboxContainer(config: BashSandboxConfig): Promise<void> {
  const inspect = await execFile("docker", ["inspect", "-f", "{{.State.Running}}", config.containerName], 10_000, 4096);
  if (inspect.exitCode === 0) {
    const remove = await execFile("docker", ["rm", "-f", config.containerName], 10_000, 4096);
    if (remove.exitCode !== 0) throw new Error(remove.stderr || "failed to remove sandbox container");
  }
  await ensureContainer(config);
}

export function createDockerBashExecutor(config: BashSandboxConfig): DockerExecutor {
  let mountKey = "";
  return {
    async execute(input) {
      mountKey = await ensureContainer(config);
      const startedAt = Date.now();
      const seconds = Math.max(1, Math.ceil(input.timeoutMs / 1000));
      const captured = await runCapturedCommand(config, input.command, input.cwd, seconds, input.timeoutMs + 2000, input.onStdout, input.onStderr);
      const output = await readCapturedOutput(config, captured.stdoutPath, captured.stderrPath, input.outputLimitBytes);
      const timedOut = captured.timedOut || captured.exitCode === 124 || captured.exitCode === 137;
      return { ...output, exitCode: captured.exitCode, timedOut, durationMs: Date.now() - startedAt };
    },
    async runFileTool(input) {
      mountKey = await ensureContainer(config);
      const startedAt = Date.now();
      const result = await execFile("docker", ["exec", config.containerName, `/sandbox/bin/${input.toolName}`, JSON.stringify(input.payload)], input.timeoutMs, input.outputLimitBytes);
      return { ...result, durationMs: Date.now() - startedAt, truncated: false };
    },
    async readFile(input) {
      return await this.runFileTool!({ toolName: "Read", ...input });
    }
  };
}

async function runCapturedCommand(config: BashSandboxConfig, command: string, cwd: string, seconds: number, timeoutMs: number, onStdout?: (delta: string) => void, onStderr?: (delta: string) => void): Promise<{ stdoutPath: string; stderrPath: string; exitCode: number | null; timedOut: boolean }> {
  const id = crypto.randomUUID();
  const stdoutPath = containerTmpPath(config, `alice-bash-output-${id}.stdout`);
  const stderrPath = containerTmpPath(config, `alice-bash-output-${id}.stderr`);
  const script = [
    "mkdir -p \"$(dirname \"$2\")\" \"$(dirname \"$3\")\"",
    "timeout -k 1s \"${4}s\" bash -lc \"$1\" > >(tee \"$2\") 2> >(tee \"$3\" >&2)"
  ].join("\n");
  const result = await execFile("docker", ["exec", "-w", cwd, config.containerName, "bash", "-lc", script, "alice-bash-capture", command, stdoutPath, stderrPath, String(seconds)], timeoutMs, 8192, onStdout, onStderr);
  return { stdoutPath, stderrPath, exitCode: result.exitCode, timedOut: result.timedOut };
}

async function readCapturedOutput(config: BashSandboxConfig, stdoutPath: string, stderrPath: string, outputLimitBytes: number): Promise<Omit<DockerExecutorResult, "exitCode" | "timedOut" | "durationMs">> {
  const stdoutBytes = await containerFileSize(config, stdoutPath);
  const stderrBytes = await containerFileSize(config, stderrPath);
  const truncated = stdoutBytes + stderrBytes > outputLimitBytes;
  if (!truncated) {
    const stdout = await readContainerFileHead(config, stdoutPath, stdoutBytes);
    const stderr = await readContainerFileHead(config, stderrPath, stderrBytes);
    await removeContainerFiles(config, stdoutPath, stderrPath);
    return {
      stdout,
      stderr,
      truncated: false
    };
  }

  const stdoutLimit = previewLimit(stdoutBytes, stderrBytes, outputLimitBytes, "stdout");
  const stderrLimit = previewLimit(stderrBytes, stdoutBytes, outputLimitBytes, "stderr");
  const stdoutPreview = await readContainerFileHead(config, stdoutPath, stdoutLimit);
  const stderrPreview = await readContainerFileHead(config, stderrPath, stderrLimit);
  return {
    stdout: formatTruncatedStream("stdout", stdoutPath, stdoutBytes, stdoutPreview),
    stderr: formatTruncatedStream("stderr", stderrPath, stderrBytes, stderrPreview),
    outputFiles: {
      ...(stdoutBytes > 0 ? { stdout: { path: stdoutPath, bytes: stdoutBytes } } : {}),
      ...(stderrBytes > 0 ? { stderr: { path: stderrPath, bytes: stderrBytes } } : {})
    },
    truncated: true
  };
}

async function containerFileSize(config: BashSandboxConfig, filePath: string): Promise<number> {
  const result = await execFile("docker", ["exec", config.containerName, "sh", "-c", "wc -c < \"$1\"", "sh", filePath], 10_000, 1024);
  if (result.exitCode !== 0) throw new Error(result.stderr || `failed to stat bash output file: ${filePath}`);
  return Number(result.stdout.trim()) || 0;
}

async function readContainerFileHead(config: BashSandboxConfig, filePath: string, limitBytes: number): Promise<string> {
  if (limitBytes <= 0) return "";
  const result = await execFile("docker", ["exec", config.containerName, "head", "-c", String(limitBytes), filePath], 10_000, limitBytes + 1024);
  if (result.exitCode !== 0) throw new Error(result.stderr || `failed to read bash output file: ${filePath}`);
  return result.stdout;
}

async function removeContainerFiles(config: BashSandboxConfig, ...filePaths: string[]): Promise<void> {
  const result = await execFile("docker", ["exec", config.containerName, "rm", "-f", ...filePaths], 10_000, 1024);
  if (result.exitCode !== 0) throw new Error(result.stderr || "failed to remove bash output temp files");
}

async function ensureContainer(config: BashSandboxConfig): Promise<string> {
  const image = await ensureSandboxImage(config);
  fs.mkdirSync(config.hostWorkspaceDir, { recursive: true });
  fs.mkdirSync(config.hostCacheDir, { recursive: true });
  if (config.piWorker?.enabled) fs.mkdirSync(path.resolve(config.piWorker.hostDir), { recursive: true });
  const agentMount = config.mounts.find((mount) => mount.id === "agent");
  if (agentMount) fs.mkdirSync(agentMount.hostPath, { recursive: true });
  const nextMountKey = containerMountKey(config);
  const inspect = await execFile("docker", ["inspect", "-f", `{{.State.Running}}|{{index .Config.Labels "${CONTAINER_MOUNT_KEY_LABEL}"}}`, config.containerName], 10_000, 4096);
  const [running, savedMountKey] = inspect.stdout.trim().split("|");
  const matchesMountKey = savedMountKey === mountKeyDigest(config);
  if (inspect.exitCode === 0 && running === "true" && matchesMountKey) return nextMountKey;
  if (inspect.exitCode === 0) {
    if (matchesMountKey) {
      const start = await execFile("docker", ["start", config.containerName], 10_000, 4096);
      if (start.exitCode !== 0) throw new Error(start.stderr || "failed to start bash sandbox container");
      return nextMountKey;
    }
    const remove = await execFile("docker", ["rm", "-f", config.containerName], 10_000, 4096);
    if (remove.exitCode !== 0) throw new Error(remove.stderr || "failed to recreate bash sandbox container");
  }
  const create = await execFile("docker", createContainerArgs(config, image), 30_000, 8192);
  if (create.exitCode !== 0) throw new Error(create.stderr || "failed to create bash sandbox container");
  return nextMountKey;
}

async function ensureSandboxImage(config: BashSandboxConfig): Promise<string> {
  await ensureBaseImage(config);
  const image = aliceUserImageName(config.image);
  const inspect = await execFile("docker", ["image", "inspect", image], 10_000, 4096);
  if (inspect.exitCode === 0) return image;

  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alice-sandbox-image-"));
  try {
    const dockerfile = path.join(buildRoot, "Dockerfile");
    fs.writeFileSync(dockerfile, aliceUserDockerfile);
    const build = await execFile("docker", [
      "build",
      "--build-arg", `BASE_IMAGE=${config.image}`,
      "-t", image,
      "-f", dockerfile,
      buildRoot
    ], 10 * 60_000, 64 * 1024);
    if (build.exitCode !== 0) throw new Error(build.stderr || `failed to build sandbox image: ${image}`);
    return image;
  } finally {
    fs.rmSync(buildRoot, { recursive: true, force: true });
  }
}

async function ensureBaseImage(config: BashSandboxConfig): Promise<void> {
  const image = config.image;
  const inspect = await execFile("docker", ["image", "inspect", image], 10_000, 4096);
  if (inspect.exitCode === 0) return;
  const pull = await execFile("docker", ["pull", image], 10 * 60_000, 64 * 1024);
  if (pull.exitCode !== 0) throw new Error(pull.stderr || `failed to pull bash sandbox image: ${image}`);
}

function createContainerArgs(config: BashSandboxConfig, image: string): string[] {
  const args = [
    "run",
    "-d",
    "--name", config.containerName,
    "--network", config.network === "none" ? "none" : "bridge",
    "--read-only",
    "--tmpfs", config.tmpDir,
    "--label", `${CONTAINER_MOUNT_KEY_LABEL}=${mountKeyDigest(config)}`,
    "--user", "alice",
    "-e", `HOME=${config.workspaceDir}`,
    "-e", `BASH_ENV=${config.workspaceDir}/.bashrc`,
    "-e", `NPM_CONFIG_CACHE=${config.cacheDir}/npm`,
    "-e", `PIP_CACHE_DIR=${config.cacheDir}/pip`,
    "-e", `PATH=${WRAPPER_CONTAINER_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    "-v", `${config.hostWorkspaceDir}:${config.workspaceDir}:rw`,
    "-v", `${config.hostCacheDir}:${config.cacheDir}:rw`,
    "-w", config.defaultCwd
  ];
  if (fs.existsSync(WRAPPER_HOST_DIR)) args.push("-v", `${WRAPPER_HOST_DIR}:${WRAPPER_CONTAINER_DIR}:ro`);
  if (config.network === "configured") {
    args.push("--add-host", "host.docker.internal:host-gateway");
    for (const name of PROXY_ENV_NAMES) {
      const value = process.env[name];
      if (value !== undefined) args.push("-e", `${name}=${containerProxyEnvValue(value)}`);
    }
  }
  if (config.cpuLimit) args.push("--cpus", config.cpuLimit);
  if (config.memoryLimit) args.push("--memory", config.memoryLimit);
  if (config.pidsLimit) args.push("--pids-limit", String(config.pidsLimit));
  if (config.piWorker?.enabled) {
    args.push("-p", `127.0.0.1:${config.piWorker.port}:8790`);
    args.push("-e", `PI_WORKER_TOKEN=${config.piWorker.workerToken ?? ""}`);
    args.push("-e", `PI_MAX_CONCURRENCY=${config.piWorker.maxConcurrency ?? 2}`);
    args.push("-e", `PI_MAX_QUEUE_SIZE=${config.piWorker.maxQueueSize ?? 20}`);
    args.push("-e", `PI_TASK_TIMEOUT_SECONDS=${config.piWorker.taskTimeoutSeconds ?? 21_600}`);
    args.push("-e", `PI_AGENT_TIMEZONE=${config.piWorker.timezone ?? "Asia/Singapore"}`);
    args.push("-e", `PI_SESSION_ROOT=${config.piWorker.containerDir}`);
    args.push("-v", `${path.resolve(config.piWorker.hostDir)}:${config.piWorker.containerDir}:rw`);
    if (fs.existsSync(PI_WORKER_RUNTIME_HOST_DIR)) {
      args.push("-v", `${PI_WORKER_RUNTIME_HOST_DIR}:${PI_WORKER_RUNTIME_CONTAINER_DIR}:ro`);
    }
  }
  for (const mount of config.mounts) args.push("-v", `${mount.hostPath}:${mount.containerPath}:${mount.readOnly ? "ro" : "rw"}`);
  for (const mount of config.skillMounts) args.push("-v", `${mount.hostPath}:${mount.containerPath}:${mount.readOnly ? "ro" : "rw"}`);
  if (config.piWorker?.enabled) {
    args.push(
      image,
      "sh",
      "-lc",
      "export NODE_PATH=\"$(npm root -g)\"; exec node --no-use-env-proxy /sandbox/pi-worker/worker.mjs"
    );
  } else {
    args.push(image, "sleep", "infinity");
  }
  return args;
}

function aliceUserImageName(baseImage: string): string {
  const digest = crypto.createHash("sha256").update(`${ALICE_CONTAINER_USER_REVISION}:${baseImage}`).digest("hex").slice(0, 16);
  return `alice-bash-sandbox:${digest}`;
}

const aliceUserDockerfile = `ARG BASE_IMAGE
FROM \${BASE_IMAGE}
USER root
RUN set -eu; \\
  if getent passwd alice >/dev/null 2>&1; then \\
    test "\$(id -u alice)" = "1000"; \\
  else \\
    if getent passwd 1000 >/dev/null 2>&1; then \\
      echo "uid 1000 is already assigned to another user" >&2; exit 1; \\
    fi; \\
    if ! getent group 1000 >/dev/null 2>&1; then groupadd --gid 1000 alice; fi; \\
    useradd --uid 1000 --gid 1000 --create-home --shell /bin/sh alice; \\
  fi; \\
  mkdir -p /home/alice; chown alice /home/alice; \\
  if ! command -v pi >/dev/null 2>&1; then npm install -g @earendil-works/pi-coding-agent@latest; fi
USER alice
`;

function containerTmpPath(config: BashSandboxConfig, filename: string): string {
  return `${config.tmpDir.replace(/\/+$/, "") || "/tmp"}/${filename}`;
}

function previewLimit(streamBytes: number, otherBytes: number, outputLimitBytes: number, stream: "stdout" | "stderr"): number {
  if (streamBytes === 0) return 0;
  if (otherBytes === 0) return outputLimitBytes;
  const firstHalf = Math.floor(outputLimitBytes / 2);
  return stream === "stdout" ? firstHalf : outputLimitBytes - firstHalf;
}

function formatTruncatedStream(stream: "stdout" | "stderr", filePath: string, bytes: number, preview: string): string {
  if (bytes === 0) return "";
  return `[truncated ${stream}: full output saved to ${filePath} (${bytes} bytes)]\n${preview}`;
}

function containerMountKey(config: BashSandboxConfig): string {
  return JSON.stringify({
    image: config.image,
    skills: config.skillMounts.map((mount) => [mount.hostPath, mount.containerPath, mount.readOnly]),
    mounts: config.mounts.map((mount) => [mount.hostPath, mount.containerPath, mount.readOnly]),
    wrappers: fs.existsSync(WRAPPER_HOST_DIR) ? WRAPPER_HOST_DIR : undefined,
    piWorker: config.piWorker ? [PI_WORKER_CONTAINER_REVISION, config.piWorker.hostDir, config.piWorker.containerDir, config.piWorker.port, config.piWorker.maxConcurrency, config.piWorker.maxQueueSize, config.piWorker.taskTimeoutSeconds, config.piWorker.timezone, fs.existsSync(PI_WORKER_RUNTIME_HOST_DIR) ? PI_WORKER_RUNTIME_HOST_DIR : undefined] : undefined
  });
}

function mountKeyDigest(config: BashSandboxConfig): string {
  return crypto.createHash("sha256").update(containerMountKey(config)).digest("hex");
}

function execFile(command: string, args: string[], timeoutMs: number, outputLimitBytes: number, onStdout?: (delta: string) => void, onStderr?: (delta: string) => void): Promise<Omit<DockerExecutorResult, "durationMs" | "truncated">> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: dockerProcessEnv() });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const next = Buffer.concat([stdout, chunk]);
      stdout = next.subarray(0, outputLimitBytes);
      onStdout?.(stdoutDecoder.write(chunk));
    });
    child.stderr.on("data", (chunk) => {
      const next = Buffer.concat([stderr, chunk]);
      stderr = next.subarray(0, outputLimitBytes);
      onStderr?.(stderrDecoder.write(chunk));
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onStdout?.(stdoutDecoder.end());
      onStderr?.(stderrDecoder.end());
      resolve({
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        exitCode: code,
        timedOut: signal === "SIGKILL"
      });
    });
  });
}

function dockerProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  for (const name of PROXY_ENV_NAMES) env[name] = process.env[name];
  return env;
}

function containerProxyEnvValue(value: string): string {
  return value
    .replace(/(^|\/\/)(127\.0\.0\.1|localhost)(?=[:/]|$)/g, "$1host.docker.internal")
    .replace(/^(127\.0\.0\.1|localhost)(?=[:/]|$)/, "host.docker.internal");
}
