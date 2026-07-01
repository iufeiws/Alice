import type { BashSandboxConfig } from "./config.js";

export function normalizeContainerPath(value: string, cwd: string): string | undefined {
  if (!value.trim()) return undefined;
  const raw = value.startsWith("/") ? value : `${cwd.replace(/\/+$/, "")}/${value}`;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

export function isAllowedCwd(config: BashSandboxConfig, cwd: string): boolean {
  return [
    config.workspaceDir,
    config.cacheDir,
    config.tmpDir,
    ...config.skillMounts.map((mount) => mount.containerPath),
    ...config.mounts.map((mount) => mount.containerPath)
  ].some((root) => isSameOrInside(cwd, root));
}

export function isReadOnlyPath(config: BashSandboxConfig, value: string): boolean {
  if (config.skillMounts.some((mount) => isSameOrInside(value, mount.containerPath))) return true;
  return config.mounts.some((mount) => mount.readOnly && isSameOrInside(value, mount.containerPath));
}

export function isWritablePath(config: BashSandboxConfig, value: string): boolean {
  if (isSameOrInside(value, config.workspaceDir) || isSameOrInside(value, config.cacheDir) || isSameOrInside(value, config.tmpDir)) return true;
  return config.mounts.some((mount) => !mount.readOnly && isSameOrInside(value, mount.containerPath));
}

export function commandMentionsPath(command: string, containerPath: string): boolean {
  return command === containerPath || command.includes(`${containerPath}/`) || command.includes(` ${containerPath}`);
}

function isSameOrInside(value: string, root: string): boolean {
  const cleanRoot = root.replace(/\/+$/, "") || "/";
  return value === cleanRoot || value.startsWith(`${cleanRoot}/`);
}
