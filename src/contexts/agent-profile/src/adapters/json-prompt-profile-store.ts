const fs = await import("node:fs");
const path = await import("node:path");

export function promptRootForMemoryRoot(memoryRoot: string): string {
  const normalized = path.normalize(memoryRoot);
  const parentDir = path.basename(normalized) === "memory-files" ? path.dirname(normalized) : normalized;
  return path.join(parentDir, "src", "contexts", "agent-profile", "prompts");
}

export function promptStoragePath(memoryRoot: string, fileName: string): string {
  const currentPath = path.join(promptRootForMemoryRoot(memoryRoot), fileName);
  fs.mkdirSync(path.dirname(currentPath), { recursive: true });
  return currentPath;
}
