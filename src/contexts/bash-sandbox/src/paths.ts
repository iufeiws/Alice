import path from "node:path";
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

export function resolveSandboxHostPath(config: BashSandboxConfig, containerPath: string, cwd?: string): string | undefined {
  const normalized = normalizeContainerPath(containerPath, cwd ?? config.workspaceDir);
  if (!normalized) return undefined;
  let best: { hostPath: string; containerPath: string } | undefined;
  for (const mount of [
    { hostPath: config.hostWorkspaceDir, containerPath: config.workspaceDir },
    { hostPath: config.hostCacheDir, containerPath: config.cacheDir },
    ...config.skillMounts.map((mount) => ({ hostPath: mount.hostPath, containerPath: mount.containerPath })),
    ...config.mounts.map((mount) => ({ hostPath: mount.hostPath, containerPath: mount.containerPath }))
  ]) {
    if (!isSameOrInside(normalized, mount.containerPath)) continue;
    if (!best || mount.containerPath.length > best.containerPath.length) best = mount;
  }
  if (!best) return undefined;
  const hostRoot = path.resolve(best.hostPath);
  const hostPath = path.resolve(hostRoot, normalized.slice(best.containerPath.length).replace(/^\/+/, ""));
  return isSameOrInside(hostPath, hostRoot) ? hostPath : undefined;
}

function isSameOrInside(value: string, root: string): boolean {
  const cleanRoot = root.replace(/\/+$/, "") || "/";
  return value === cleanRoot || value.startsWith(`${cleanRoot}/`);
}
