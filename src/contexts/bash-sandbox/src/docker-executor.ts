import type { BashSandboxConfig } from "./config.js";

const childProcess = await import("node:child_process");
const fs = await import("node:fs");

const PROXY_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];

export type DockerExecutorResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
};

export type DockerExecutor = {
  execute(input: { command: string; cwd: string; timeoutMs: number; outputLimitBytes: number; onStdout?(delta: string): void; onStderr?(delta: string): void }): Promise<DockerExecutorResult>;
};

export function createDockerBashExecutor(config: BashSandboxConfig): DockerExecutor {
  let mountedSkillKey = "";
  return {
    async execute(input) {
      mountedSkillKey = await ensureContainer(config, mountedSkillKey);
      const startedAt = Date.now();
      const seconds = Math.max(1, Math.ceil(input.timeoutMs / 1000));
      const result = await execFile("docker", ["exec", "-w", input.cwd, config.containerName, "timeout", "-k", "1s", `${seconds}s`, "bash", "-lc", input.command], input.timeoutMs + 2000, input.outputLimitBytes, input);
      return { ...result, timedOut: result.timedOut || result.exitCode === 124 || result.exitCode === 137, durationMs: Date.now() - startedAt };
    }
  };
}

async function ensureContainer(config: BashSandboxConfig, mountedSkillKey: string): Promise<string> {
  await ensureImage(config);
  fs.mkdirSync(config.hostWorkspaceDir, { recursive: true });
  fs.mkdirSync(config.hostCacheDir, { recursive: true });
  const nextSkillKey = skillMountKey(config);
  const inspect = await execFile("docker", ["inspect", "-f", "{{.State.Running}}", config.containerName], 10_000, 4096);
  if (inspect.exitCode === 0 && inspect.stdout.trim() === "true" && mountedSkillKey === nextSkillKey) return mountedSkillKey;
  if (inspect.exitCode === 0) {
    if (mountedSkillKey === nextSkillKey) {
      const start = await execFile("docker", ["start", config.containerName], 10_000, 4096);
      if (start.exitCode !== 0) throw new Error(start.stderr || "failed to start bash sandbox container");
      return nextSkillKey;
    }
    const remove = await execFile("docker", ["rm", "-f", config.containerName], 10_000, 4096);
    if (remove.exitCode !== 0) throw new Error(remove.stderr || "failed to recreate bash sandbox container");
  }
  const create = await execFile("docker", createContainerArgs(config), 30_000, 8192);
  if (create.exitCode !== 0) throw new Error(create.stderr || "failed to create bash sandbox container");
  return nextSkillKey;
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
    "-v", `${config.hostWorkspaceDir}:${config.workspaceDir}:rw`,
    "-v", `${config.hostCacheDir}:${config.cacheDir}:rw`,
    "-w", config.defaultCwd
  ];
  if (config.network === "configured") {
    for (const name of PROXY_ENV_NAMES) args.push("-e", name);
  }
  if (config.cpuLimit) args.push("--cpus", config.cpuLimit);
  if (config.memoryLimit) args.push("--memory", config.memoryLimit);
  if (config.pidsLimit) args.push("--pids-limit", String(config.pidsLimit));
  for (const mount of config.skillMounts) args.push("-v", `${mount.hostPath}:${mount.containerPath}:${mount.readOnly ? "ro" : "rw"}`);
  for (const mount of config.mounts) args.push("-v", `${mount.hostPath}:${mount.containerPath}:${mount.readOnly ? "ro" : "rw"}`);
  args.push(config.image, "sleep", "infinity");
  return args;
}

function skillMountKey(config: BashSandboxConfig): string {
  return JSON.stringify(config.skillMounts.map((mount) => [mount.hostPath, mount.containerPath, mount.readOnly]));
}

function execFile(command: string, args: string[], timeoutMs: number, outputLimitBytes: number, stream: Pick<Parameters<DockerExecutor["execute"]>[0], "onStdout" | "onStderr"> = {}): Promise<Omit<DockerExecutorResult, "durationMs">> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: dockerProcessEnv() });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stream.onStdout?.(chunk.toString("utf8"));
      const next = Buffer.concat([stdout, chunk]);
      truncated ||= next.length > outputLimitBytes;
      stdout = next.subarray(0, outputLimitBytes);
    });
    child.stderr.on("data", (chunk) => {
      stream.onStderr?.(chunk.toString("utf8"));
      const next = Buffer.concat([stderr, chunk]);
      truncated ||= next.length > outputLimitBytes;
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
        timedOut: signal === "SIGKILL",
        truncated
      });
    });
  });
}

function dockerProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  for (const name of PROXY_ENV_NAMES) env[name] = process.env[name];
  return env;
}
