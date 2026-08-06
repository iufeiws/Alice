export type PiSandboxConfig = {
  llmPresetName: string;
  sandboxCwd: string;
  maxConcurrency: number;
  maxQueueSize: number;
  taskTimeoutSeconds: number;
  taskResultRetentionSeconds: number;
  toolTimeoutSeconds: number;
  workerStartupTimeoutMs: number;
  relayHost: string;
  relayPort: number;
  workerHost: string;
  workerPort: number;
};

export const defaultPiSandboxConfig: PiSandboxConfig = {
  llmPresetName: "",
  sandboxCwd: "/alice",
  maxConcurrency: 2,
  maxQueueSize: 20,
  taskTimeoutSeconds: 900,
  taskResultRetentionSeconds: 86_400,
  toolTimeoutSeconds: 60_000,
  workerStartupTimeoutMs: 60_000,
  relayHost: "0.0.0.0",
  relayPort: 3411,
  workerHost: "127.0.0.1",
  workerPort: 3412
};

const fs = await import("node:fs");
const path = await import("node:path");

export function readPiSandboxConfig(filePath = "config/plugin/pi/config.json"): PiSandboxConfig {
  if (!fs.existsSync(filePath)) return { ...defaultPiSandboxConfig };
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PiSandboxConfig>;
  return validatePiSandboxConfig(parsed);
}

export function writePiSandboxConfig(config: PiSandboxConfig, filePath = "config/plugin/pi/config.json"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(validatePiSandboxConfig(config), null, 2)}\n`);
}

export function validatePiSandboxConfig(value: Partial<PiSandboxConfig>): PiSandboxConfig {
  const config: PiSandboxConfig = { ...defaultPiSandboxConfig, ...value };
  if (typeof config.llmPresetName !== "string") throw new Error("invalid_pi_llm_preset_name");
  if (!config.sandboxCwd.startsWith("/")) throw new Error("invalid_pi_sandbox_cwd");
  positiveInteger(config.maxConcurrency, "max_concurrency", 1, 64);
  positiveInteger(config.maxQueueSize, "max_queue_size", 0, 10_000);
  positiveInteger(config.taskTimeoutSeconds, "task_timeout_seconds", 1, 86_400);
  positiveInteger(config.taskResultRetentionSeconds, "task_result_retention_seconds", 1, 31_536_000);
  positiveInteger(config.toolTimeoutSeconds, "tool_timeout_ms", 1_000, 3_600_000);
  positiveInteger(config.workerStartupTimeoutMs, "worker_startup_timeout_ms", 1_000, 600_000);
  port(config.relayPort, "relay_port");
  port(config.workerPort, "worker_port");
  if (!config.relayHost.trim() || !config.workerHost.trim()) throw new Error("invalid_pi_host");
  return { ...config };
}

function positiveInteger(value: number, name: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid_pi_${name}`);
}

function port(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`invalid_pi_${name}`);
}
