import type { BashSandboxConfig } from "./config.js";
import type { BashPermissionDecision } from "./permission.js";

const fs = await import("node:fs");
const path = await import("node:path");

type BashAuditEvent = {
  command: string;
  cwd: string;
  caller?: string;
  toolCallId: string;
  permission: BashPermissionDecision;
  network: BashSandboxConfig["network"];
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
};

export function appendBashAuditEvent(config: BashSandboxConfig, event: BashAuditEvent): void {
  fs.mkdirSync(path.dirname(config.auditLogPath), { recursive: true });
  fs.appendFileSync(config.auditLogPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}
