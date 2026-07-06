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

function isSameOrInside(value: string, root: string): boolean {
  const cleanRoot = root.replace(/\/+$/, "") || "/";
  return value === cleanRoot || value.startsWith(`${cleanRoot}/`);
}
