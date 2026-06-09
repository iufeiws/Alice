import type { ScheduledTask } from "../../../platform/scheduler/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type DailyMaintenanceTaskDeps = {
  systemLogStore?: { cleanupOlderThan(retentionDays: number, now?: Date): number };
  ttsOutputDirs?: string[];
  ttsGeneratedCleanupEnabled?: boolean;
  nowIso(): string;
  log(level: "info" | "warn" | "error", message: string): void;
};

export function createDailyMaintenanceTasks(deps: DailyMaintenanceTaskDeps): ScheduledTask[] {
  const tasks: ScheduledTask[] = [
    {
      id: "system-log-retention",
      hour: 4,
      minute: 0,
      run() {
        const removed = deps.systemLogStore?.cleanupOlderThan(7) ?? 0;
        deps.log("info", `daily cleanup: removed ${removed} system log file(s) older than 7 days`);
      }
    }
  ];
  if (deps.ttsGeneratedCleanupEnabled !== false) {
    tasks.push({
      id: "tts-generated-retention",
      hour: 4,
      minute: 0,
      run() {
        const removed = cleanupPreviousTtsFiles(deps.ttsOutputDirs ?? [], deps.nowIso(), (message) => deps.log("warn", message));
        deps.log("info", `daily cleanup: removed ${removed} generated tts file(s) from previous days`);
      }
    });
  }
  return tasks;
}

export function cleanupPreviousTtsFiles(outputDirs: string[], nowIso: string, onWarning?: (message: string) => void): number {
  const today = nowIso.slice(0, 10).replace(/-/g, "");
  let removed = 0;
  const visited = new Set<string>();
  for (const outputDir of outputDirs) {
    let dir: string;
    try {
      dir = resolveAssetScopedPath(outputDir);
    } catch (error) {
      onWarning?.(`daily cleanup: generated tts directory skipped ${outputDir}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (visited.has(dir) || !fs.existsSync(dir)) continue;
    visited.add(dir);
    for (const fileName of fs.readdirSync(dir)) {
      if (!/^\d{8}_\d{6}(?:_\d{3})?(?:_\d+)?\.(?:wav|opus|mp3)$/i.test(fileName)) continue;
      const fileDate = fileName.slice(0, 8);
      if (fileDate >= today) continue;
      try {
        fs.rmSync(path.join(dir, fileName));
        removed += 1;
      } catch (error) {
        onWarning?.(`daily cleanup: generated tts file remove failed ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return removed;
}

function resolveAssetScopedPath(assetPath: string): string {
  const normalized = path.normalize(assetPath);
  const fullPath = path.isAbsolute(assetPath)
    ? path.resolve(assetPath)
    : normalized === "assets" || normalized.startsWith(`assets${path.sep}`)
      ? path.resolve(normalized)
      : path.resolve("assets", normalized);
  const assetRoot = path.resolve("assets");
  const relativeToAssets = path.relative(assetRoot, fullPath);
  if (!relativeToAssets || relativeToAssets.startsWith("..") || path.isAbsolute(relativeToAssets)) {
    throw new Error(`TTS cleanup directory must be inside assets: ${fullPath}`);
  }
  return fullPath;
}
