const path = await import("node:path");
const fs = await import("node:fs");

export type BashSandboxMountConfig = {
  id: string;
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
};

export type BashSandboxSkillMountConfig = {
  id: string;
  hostPath: string;
  containerPath: string;
  readOnly: true;
};

export type BashSandboxConfig = {
  containerName: string;
  image: string;
  defaultCwd: string;
  hostWorkspaceDir: string;
  workspaceDir: string;
  hostCacheDir: string;
  cacheDir: string;
  tmpDir: string;
  skillMounts: BashSandboxSkillMountConfig[];
  mounts: BashSandboxMountConfig[];
  network: "none" | "configured";
  timeoutMs: number;
  outputLimitBytes: number;
  cpuLimit?: string;
  memoryLimit?: string;
  pidsLimit?: number;
  auditLogPath: string;
};

export function validateBashSandboxConfig(config: BashSandboxConfig): BashSandboxConfig {
  const normalized: BashSandboxConfig = {
    ...config,
    hostWorkspaceDir: path.resolve(config.hostWorkspaceDir),
    hostCacheDir: path.resolve(config.hostCacheDir),
    skillMounts: config.skillMounts.map((mount) => ({ ...mount, hostPath: path.resolve(mount.hostPath), readOnly: true })),
    mounts: config.mounts.map((mount) => ({ ...mount, hostPath: path.resolve(mount.hostPath) }))
  };
  if (!normalized.workspaceDir.startsWith("/") || !normalized.cacheDir.startsWith("/") || !normalized.tmpDir.startsWith("/")) {
    throw new Error("bashSandbox workspaceDir/cacheDir/tmpDir must be absolute container paths");
  }
  rejectSensitiveHostPath(normalized.hostWorkspaceDir);
  rejectSensitiveHostPath(normalized.hostCacheDir);
  for (const entry of [...normalized.skillMounts, ...normalized.mounts]) {
    rejectSensitiveHostPath(entry.hostPath);
    if (!entry.containerPath.startsWith("/")) throw new Error(`bashSandbox mount ${entry.containerPath} must be absolute`);
  }
  for (const mount of normalized.skillMounts) {
    if (!mount.readOnly) throw new Error("bashSandbox skill mounts must be read-only");
  }
  for (const mount of normalized.mounts) {
    if (!mount.readOnly && (isSameOrInside(mount.containerPath, "/skills") || normalized.skillMounts.some((skill) => isSameOrInside(mount.containerPath, skill.containerPath)))) {
      throw new Error("bashSandbox optional mounts cannot write under skills mount");
    }
  }
  return normalized;
}

export function parseBashSandboxMounts(value: unknown): BashSandboxMountConfig[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`invalid bashSandbox mount at index ${index}`);
    const mount = entry as Record<string, unknown>;
    return {
      id: stringValue(mount.id) || `mount_${index}`,
      hostPath: requiredString(mount.hostPath, `bashSandbox.mounts[${index}].hostPath`),
      containerPath: requiredString(mount.containerPath, `bashSandbox.mounts[${index}].containerPath`),
      readOnly: mount.readOnly !== false
    };
  });
}

export function parseBashSandboxSkillMounts(value: unknown): BashSandboxSkillMountConfig[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`invalid bashSandbox skill mount at index ${index}`);
    const mount = entry as Record<string, unknown>;
    return {
      id: stringValue(mount.id) || `skill_${index}`,
      hostPath: requiredString(mount.hostPath, `bashSandbox.skillMounts[${index}].hostPath`),
      containerPath: requiredString(mount.containerPath, `bashSandbox.skillMounts[${index}].containerPath`),
      readOnly: true
    };
  });
}

export function defaultBashSandboxSkillMounts(skillsRoot: string): BashSandboxSkillMountConfig[] {
  const root = path.resolve(skillsRoot);
  if (!fs.existsSync(root)) return [];
  return findSkillRoots(fs, root)
    .map((hostPath) => ({ hostPath, relative: path.relative(root, hostPath).split(path.sep).join("/") }))
    .filter((entry) => entry.relative && !entry.relative.split("/").includes("external"))
    .map((entry) => ({
      id: entry.relative,
      hostPath: entry.hostPath,
      containerPath: `/skills/${entry.relative}`,
      readOnly: true
    }));
}

export function rejectSensitiveHostPath(hostPath: string): void {
  const resolved = path.resolve(hostPath);
  const sensitive = ["/root", "/etc", "/var/run", "/run", "/proc", "/sys", "/dev"];
  if (resolved === "/" || sensitive.some((entry) => resolved === entry || resolved.startsWith(`${entry}/`))) {
    throw new Error(`sensitive host path is not allowed for bashSandbox mount: ${hostPath}`);
  }
  if (/(^|[/\\])(?:\.ssh|\.aws|\.config|\.docker|id_rsa|id_ed25519|credentials|token)([/\\]|$)/i.test(resolved)) {
    throw new Error(`credential-like host path is not allowed for bashSandbox mount: ${hostPath}`);
  }
}

function findSkillRoots(fs: typeof import("node:fs"), root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const found: string[] = [];
  if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) found.push(root);
  for (const entry of entries) {
    if (entry.isDirectory()) found.push(...findSkillRoots(fs, path.join(root, entry.name)));
  }
  return found;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`${name} is required`);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isSameOrInside(value: string, root: string): boolean {
  return value === root || value.startsWith(`${root.replace(/\/+$/, "")}/`);
}
