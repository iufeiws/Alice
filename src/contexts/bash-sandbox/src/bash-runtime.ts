import type { ToolCall, ToolExecutionContext } from "../../tool-execution/src/index.js";
import type { BashSandboxConfig, BashSandboxSkillMountConfig } from "./config.js";
import { addBashSandboxSkillMount } from "./config.js";
import type { DockerExecutor } from "./docker-executor.js";
import { createDockerBashExecutor } from "./docker-executor.js";
import { classifyBashCommand } from "./permission.js";
import { normalizeContainerPath } from "./paths.js";

export type BashRuntimeResult = {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  outputFiles?: {
    stdout?: { path: string; bytes: number };
    stderr?: { path: string; bytes: number };
  };
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  denied: boolean;
  denyReason?: string;
};

export type BashSandboxReadResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
};

export type BashSandboxRuntime = {
  mountSkill(mount: BashSandboxSkillMountConfig): BashSandboxSkillMountConfig;
  run(call: ToolCall, context?: ToolExecutionContext): Promise<BashRuntimeResult>;
  runFileTool(input: { toolName: "Read" | "Edit" | "Glob" | "Grep"; payload: Record<string, unknown>; timeoutMs?: number; outputLimitBytes?: number }): Promise<BashSandboxReadResult>;
  readFile(input: { payload: Record<string, unknown>; timeoutMs?: number; outputLimitBytes?: number }): Promise<BashSandboxReadResult>;
};

export function createBashSandboxRuntime(input: { config: BashSandboxConfig; executor?: DockerExecutor }): BashSandboxRuntime {
  const executor = input.executor ?? createDockerBashExecutor(input.config);
  return {
    mountSkill(mount) {
      return addBashSandboxSkillMount(input.config, mount);
    },
    async run(call, context) {
      const command = stringValue(call.input.command);
      const cwd = normalizeContainerPath(stringValue(call.input.cwd) || input.config.defaultCwd, input.config.defaultCwd) ?? input.config.defaultCwd;
      const timeoutMs = numberValue(call.input.timeoutMs, input.config.timeoutMs);
      const permission = classifyBashCommand({ command, cwd, config: input.config, skillId: stringValue(call.input.skillId) || undefined });
      if (permission.state === "deny") {
        return result(command, cwd, "", "", null, false, 0, false, true, permission.reason);
      }
      const executed = await executor.execute({
        command,
        cwd,
        timeoutMs,
        outputLimitBytes: input.config.outputLimitBytes,
        onStdout: (delta) => context?.reportProgress?.(delta),
        onStderr: (delta) => context?.reportProgress?.(`[stderr] ${delta}`)
      });
      const output = result(command, cwd, executed.stdout, executed.stderr, executed.exitCode, executed.timedOut, executed.durationMs, executed.truncated, false, undefined, executed.outputFiles);
      return output;
    },
    async runFileTool(toolInput) {
      if (!executor.runFileTool) throw new Error(`bash sandbox executor does not support ${toolInput.toolName}`);
      return await executor.runFileTool({
        toolName: toolInput.toolName,
        payload: toolInput.payload,
        timeoutMs: toolInput.timeoutMs ?? input.config.timeoutMs,
        outputLimitBytes: toolInput.outputLimitBytes ?? input.config.outputLimitBytes
      });
    },
    async readFile(readInput) {
      return await this.runFileTool({
        toolName: "Read",
        payload: readInput.payload,
        timeoutMs: readInput.timeoutMs ?? input.config.timeoutMs,
        outputLimitBytes: readInput.outputLimitBytes ?? input.config.outputLimitBytes
      });
    }
  };
}

function result(command: string, cwd: string, stdout: string, stderr: string, exitCode: number | null, timedOut: boolean, durationMs: number, truncated: boolean, denied: boolean, denyReason?: string, outputFiles?: BashRuntimeResult["outputFiles"]): BashRuntimeResult {
  return { command, cwd, stdout, stderr, outputFiles, exitCode, timedOut, durationMs, truncated, denied, denyReason };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
