import type { BashSandboxConfig } from "./config.js";
import { normalizeContainerPath } from "./paths.js";

export function resolveSandboxWorkspacePath(config: BashSandboxConfig, value: string): string | undefined {
  return normalizeContainerPath(value, config.workspaceDir);
}
