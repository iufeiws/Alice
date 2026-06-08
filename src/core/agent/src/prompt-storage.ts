const fs = await import("node:fs");
const path = await import("node:path");

export function promptRootForMemoryRoot(memoryRoot: string): string {
  const normalized = path.normalize(memoryRoot);
  const parentDir = path.basename(normalized) === "memory-files" ? path.dirname(normalized) : normalized;
  const srcRootPrompt = path.join(parentDir, "src", "core", "prompt");
  const legacyRootPrompt = path.join(parentDir, "core", "prompt");

  if (directoryExists(srcRootPrompt)) return srcRootPrompt;
  if (directoryExists(legacyRootPrompt)) return legacyRootPrompt;
  return srcRootPrompt;
}

function directoryExists(value: string): boolean {
  try {
    return fs.existsSync(value) && fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

export function promptStoragePath(memoryRoot: string, fileName: string, legacySegments: string[]): string {
  const currentPath = path.join(promptRootForMemoryRoot(memoryRoot), fileName);
  const legacyPromptRoot = previousPromptRootForMemoryRoot(memoryRoot);
  migratePromptStorageFile(currentPath, path.join(legacyPromptRoot, fileName));
  return migratePromptStorageFile(currentPath, path.join(memoryRoot, ...legacySegments));
}

export function migratePromptStorageFile(currentPath: string, legacyPath: string): string {
  fs.mkdirSync(path.dirname(currentPath), { recursive: true });
  if (!fs.existsSync(currentPath) && fs.existsSync(legacyPath)) {
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    try {
      fs.renameSync(legacyPath, currentPath);
    } catch (error) {
      if (!isCrossDeviceRename(error)) throw error;
      fs.writeFileSync(currentPath, fs.readFileSync(legacyPath));
      fs.rmSync(legacyPath);
    }
  }
  return currentPath;
}

function isCrossDeviceRename(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EXDEV");
}

function previousPromptRootForMemoryRoot(memoryRoot: string): string {
  const normalized = path.normalize(memoryRoot);
  if (path.basename(normalized) === "memory-files") {
    return path.join(path.dirname(normalized), "core", "prompt");
  }
  return path.join(normalized, "core", "prompt");
}
