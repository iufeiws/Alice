import type { BashSandboxConfig } from "./config.js";

const childProcess = await import("node:child_process");
const crypto = await import("node:crypto");
const fs = await import("node:fs");
const path = await import("node:path");

const PROXY_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
const WRAPPER_CONTAINER_DIR = "/sandbox/bin";
const WRAPPER_HOST_DIR = path.resolve("src/contexts/bash-sandbox/wrappers");

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

export function createDockerBashExecutor(config: BashSandboxConfig): DockerExecutor {
  let mountKey = "";
  return {
    async execute(input) {
      mountKey = await ensureContainer(config, mountKey);
      const startedAt = Date.now();
      const seconds = Math.max(1, Math.ceil(input.timeoutMs / 1000));
      const captured = await runCapturedCommand(config, input.command, input.cwd, seconds, input.timeoutMs + 2000);
      const output = await readCapturedOutput(config, captured.stdoutPath, captured.stderrPath, input.outputLimitBytes);
      const timedOut = captured.timedOut || captured.exitCode === 124 || captured.exitCode === 137;
      output.stdout && input.onStdout?.(output.stdout);
      output.stderr && input.onStderr?.(output.stderr);
      return { ...output, exitCode: captured.exitCode, timedOut, durationMs: Date.now() - startedAt };
    },
    async runFileTool(input) {
      mountKey = await ensureContainer(config, mountKey);
      const startedAt = Date.now();
      const result = await execFile("docker", ["exec", config.containerName, `/sandbox/bin/${input.toolName}`, JSON.stringify(input.payload)], input.timeoutMs, input.outputLimitBytes);
      return { ...result, durationMs: Date.now() - startedAt, truncated: false };
    },
    async readFile(input) {
      return await this.runFileTool!({ toolName: "Read", ...input });
    }
  };
}

async function runCapturedCommand(config: BashSandboxConfig, command: string, cwd: string, seconds: number, timeoutMs: number): Promise<{ stdoutPath: string; stderrPath: string; exitCode: number | null; timedOut: boolean }> {
  const id = crypto.randomUUID();
  const stdoutPath = containerTmpPath(config, `alice-bash-output-${id}.stdout`);
  const stderrPath = containerTmpPath(config, `alice-bash-output-${id}.stderr`);
  const script = [
    "mkdir -p \"$(dirname \"$2\")\" \"$(dirname \"$3\")\"",
    "timeout -k 1s \"${4}s\" bash -lc \"$1\" >\"$2\" 2>\"$3\""
  ].join("\n");
  const result = await execFile("docker", ["exec", "-w", cwd, config.containerName, "bash", "-lc", script, "alice-bash-capture", command, stdoutPath, stderrPath, String(seconds)], timeoutMs, 8192);
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

async function ensureContainer(config: BashSandboxConfig, currentMountKey: string): Promise<string> {
  await ensureImage(config);
  fs.mkdirSync(config.hostWorkspaceDir, { recursive: true });
  fs.mkdirSync(config.hostCacheDir, { recursive: true });
  const nextMountKey = containerMountKey(config);
  const inspect = await execFile("docker", ["inspect", "-f", "{{.State.Running}}", config.containerName], 10_000, 4096);
  if (inspect.exitCode === 0 && inspect.stdout.trim() === "true" && currentMountKey === nextMountKey) return currentMountKey;
  if (inspect.exitCode === 0) {
    if (currentMountKey === nextMountKey) {
      const start = await execFile("docker", ["start", config.containerName], 10_000, 4096);
      if (start.exitCode !== 0) throw new Error(start.stderr || "failed to start bash sandbox container");
      return nextMountKey;
    }
    const remove = await execFile("docker", ["rm", "-f", config.containerName], 10_000, 4096);
    if (remove.exitCode !== 0) throw new Error(remove.stderr || "failed to recreate bash sandbox container");
  }
  const create = await execFile("docker", createContainerArgs(config), 30_000, 8192);
  if (create.exitCode !== 0) throw new Error(create.stderr || "failed to create bash sandbox container");
  return nextMountKey;
}

async function ensureImage(config: BashSandboxConfig): Promise<void> {
  const inspect = await execFile("docker", ["image", "inspect", config.image], 10_000, 4096);
  if (inspect.exitCode === 0) return;
  const pull = await execFile("docker", ["pull", config.image], 10 * 60_000, 64 * 1024);
  if (pull.exitCode !== 0) throw new Error(pull.stderr || `failed to pull bash sandbox image: ${config.image}`);
}

function createContainerArgs(config: BashSandboxConfig): string[] {
  const args = [
    "run",
    "-d",
    "--name", config.containerName,
    "--network", config.network === "none" ? "none" : "bridge",
    "--read-only",
    "--tmpfs", config.tmpDir,
    "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "-e", `HOME=${config.workspaceDir}`,
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
  for (const mount of config.skillMounts) args.push("-v", `${mount.hostPath}:${mount.containerPath}:${mount.readOnly ? "ro" : "rw"}`);
  for (const mount of config.mounts) args.push("-v", `${mount.hostPath}:${mount.containerPath}:${mount.readOnly ? "ro" : "rw"}`);
  args.push(config.image, "sleep", "infinity");
  return args;
}

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
    skills: config.skillMounts.map((mount) => [mount.hostPath, mount.containerPath, mount.readOnly]),
    mounts: config.mounts.map((mount) => [mount.hostPath, mount.containerPath, mount.readOnly]),
    wrappers: fs.existsSync(WRAPPER_HOST_DIR) ? WRAPPER_HOST_DIR : undefined
  });
}

function execFile(command: string, args: string[], timeoutMs: number, outputLimitBytes: number): Promise<Omit<DockerExecutorResult, "durationMs" | "truncated">> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: dockerProcessEnv() });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const next = Buffer.concat([stdout, chunk]);
      stdout = next.subarray(0, outputLimitBytes);
    });
    child.stderr.on("data", (chunk) => {
      const next = Buffer.concat([stderr, chunk]);
      stderr = next.subarray(0, outputLimitBytes);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
