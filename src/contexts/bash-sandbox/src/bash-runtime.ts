import type { ToolCall } from "../../agent-loop/src/contracts/agent-contracts.js";
import type { BashSandboxConfig } from "./config.js";
import type { DockerExecutor } from "./docker-executor.js";
import { createDockerBashExecutor } from "./docker-executor.js";
import { appendBashAuditEvent } from "./audit.js";
import { classifyBashCommand } from "./permission.js";
import { commandMentionsPath, normalizeContainerPath } from "./paths.js";

export type BashRuntimeResult = {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  denied: boolean;
  denyReason?: string;
};

export type BashSandboxRuntime = {
  setReporter(reporter: BashRunReporter | undefined): void;
  run(call: ToolCall): Promise<BashRuntimeResult>;
};

export type BashRunReporter = {
  begin(input: { call: ToolCall; command: string; cwd: string }): Promise<BashRunReportSession | undefined> | BashRunReportSession | undefined;
};

export type BashRunReportSession = {
  appendStdout(delta: string): Promise<void> | void;
  appendStderr(delta: string): Promise<void> | void;
  finish(result: BashRuntimeResult): Promise<void> | void;
  fail(error: unknown): Promise<void> | void;
};

export function createBashSandboxRuntime(input: { config: BashSandboxConfig; executor?: DockerExecutor }): BashSandboxRuntime {
  const executor = input.executor ?? createDockerBashExecutor(input.config);
  let reporter: BashRunReporter | undefined;
  return {
    setReporter(nextReporter) {
      reporter = nextReporter;
    },
    async run(call) {
      const command = stringValue(call.input.command);
      const cwd = normalizeContainerPath(stringValue(call.input.cwd) || input.config.defaultCwd, input.config.defaultCwd) ?? input.config.defaultCwd;
      const timeoutMs = numberValue(call.input.timeoutMs, input.config.timeoutMs);
      const report = await reporter?.begin({ call, command, cwd });
      const permission = classifyBashCommand({ command, cwd, config: input.config, skillId: stringValue(call.input.skillId) || undefined });
      if (permission.state === "deny") {
        const denied = result(command, cwd, "", "", null, false, 0, false, true, permission.reason);
        appendBashAuditEvent(input.config, audit(call, denied, permission, input.config));
        await report?.finish(denied);
        return denied;
      }
      try {
        const executed = await executor.execute({
          command,
          cwd,
          timeoutMs,
          outputLimitBytes: input.config.outputLimitBytes,
          onStdout: (delta) => void report?.appendStdout(delta),
          onStderr: (delta) => void report?.appendStderr(delta)
        });
        const output = result(command, cwd, executed.stdout, executed.stderr, executed.exitCode, executed.timedOut, executed.durationMs, executed.truncated, false);
        appendBashAuditEvent(input.config, audit(call, output, permission, input.config));
        await report?.finish(output);
        return output;
      } catch (error) {
        await report?.fail(error);
        throw error;
      }
    }
  };
}

function result(command: string, cwd: string, stdout: string, stderr: string, exitCode: number | null, timedOut: boolean, durationMs: number, truncated: boolean, denied: boolean, denyReason?: string): BashRuntimeResult {
  return { command, cwd, stdout, stderr, exitCode, timedOut, durationMs, truncated, denied, denyReason };
}

function audit(call: ToolCall, output: BashRuntimeResult, permission: ReturnType<typeof classifyBashCommand>, config: BashSandboxConfig) {
  return {
    command: output.command,
    cwd: output.cwd,
    caller: call.requester?.plugin,
    toolCallId: call.id,
    permission,
    network: config.network,
    optionalMounts: config.mounts
      .filter((mount) => commandMentionsPath(output.command, mount.containerPath))
      .map((mount) => ({ id: mount.id, containerPath: mount.containerPath, readOnly: mount.readOnly })),
    durationMs: output.durationMs,
    exitCode: output.exitCode,
    timedOut: output.timedOut,
    truncated: output.truncated
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
