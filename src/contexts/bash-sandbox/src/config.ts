const path = await import("node:path");

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
  readOnly: boolean;
};

export type PiWorkerContainerConfig = {
  enabled: boolean;
  image?: string;
  hostDir: string;
  containerDir: string;
  port: number;
  relayUrl?: string;
  relayToken?: string;
  sandboxCwd?: string;
  maxConcurrency?: number;
  maxQueueSize?: number;
  taskTimeoutSeconds?: number;
  timezone?: string;
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
  skillsDir: string;
  skillMounts: BashSandboxSkillMountConfig[];
  mounts: BashSandboxMountConfig[];
  network: "none" | "configured";
  timeoutMs: number;
  outputLimitBytes: number;
  cpuLimit?: string;
  memoryLimit?: string;
  pidsLimit?: number;
  piWorker?: PiWorkerContainerConfig;
};

export function validateBashSandboxConfig(config: BashSandboxConfig): BashSandboxConfig {
  const normalized: BashSandboxConfig = {
    ...config,
    hostWorkspaceDir: path.resolve(config.hostWorkspaceDir),
    hostCacheDir: path.resolve(config.hostCacheDir),
    skillMounts: config.skillMounts.map((mount) => ({ ...mount, hostPath: path.resolve(mount.hostPath) })),
    mounts: config.mounts.map((mount) => ({ ...mount, hostPath: path.resolve(mount.hostPath) }))
  };
  if (!normalized.workspaceDir.startsWith("/") || !normalized.cacheDir.startsWith("/") || !normalized.tmpDir.startsWith("/") || !normalized.skillsDir.startsWith("/")) {
    throw new Error("bashSandbox workspaceDir/cacheDir/tmpDir/skillsDir must be absolute container paths");
  }
  rejectSensitiveHostPath(normalized.hostWorkspaceDir);
  rejectSensitiveHostPath(normalized.hostCacheDir);
  for (const entry of [...normalized.skillMounts, ...normalized.mounts]) {
    rejectSensitiveHostPath(entry.hostPath);
    if (!entry.containerPath.startsWith("/")) throw new Error(`bashSandbox mount ${entry.containerPath} must be absolute`);
  }
  if (normalized.piWorker) {
    if (!normalized.piWorker.hostDir || !normalized.piWorker.containerDir.startsWith("/") || !Number.isInteger(normalized.piWorker.port) || normalized.piWorker.port < 1 || normalized.piWorker.port > 65_535) {
      throw new Error("invalid bashSandbox Pi Worker configuration");
    }
    rejectSensitiveHostPath(path.resolve(normalized.piWorker.hostDir));
  }
  const skillsRoot = normalized.skillsDir.replace(/\/+$/, "");
  for (const mount of normalized.mounts) {
    if (!mount.readOnly && mount.containerPath !== skillsRoot && isSameOrInside(mount.containerPath, skillsRoot)) {
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

export function addBashSandboxSkillMount(config: BashSandboxConfig, mount: BashSandboxSkillMountConfig): BashSandboxSkillMountConfig {
  const normalized = {
    ...mount,
    hostPath: path.resolve(mount.hostPath)
  };
  rejectSensitiveHostPath(normalized.hostPath);
  const skillsRoot = config.skillsDir.replace(/\/+$/, "");
  if (!isSameOrInside(normalized.containerPath, skillsRoot) || normalized.containerPath === skillsRoot) {
    throw new Error(`skill mount must be under ${skillsRoot}: ${normalized.containerPath}`);
  }
  const existing = config.skillMounts.findIndex((entry) => entry.id === normalized.id || entry.containerPath === normalized.containerPath);
  if (existing >= 0) config.skillMounts[existing] = normalized;
  else config.skillMounts.push(normalized);
  return normalized;
}

function rejectSensitiveHostPath(hostPath: string): void {
  const resolved = path.resolve(hostPath);
  const sensitive = ["/root", "/etc", "/var/run", "/run", "/proc", "/sys", "/dev"];
  if (resolved === "/" || sensitive.some((entry) => resolved === entry || resolved.startsWith(`${entry}/`))) {
    throw new Error(`sensitive host path is not allowed for bashSandbox mount: ${hostPath}`);
  }
  if (/(^|[/\\])(?:\.ssh|\.aws|\.config|\.docker|id_rsa|id_ed25519|credentials|token)([/\\]|$)/i.test(resolved)) {
    throw new Error(`credential-like host path is not allowed for bashSandbox mount: ${hostPath}`);
  }
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
