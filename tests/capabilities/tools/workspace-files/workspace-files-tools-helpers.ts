import { createWorkspaceFilesTools, type WorkspaceFilesToolPlugin } from "../../../../src/capabilities/tools/workspace-files/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");

export { fs, path };

export function makeWorkspace(name: string): { root: string; tools: WorkspaceFilesToolPlugin } {
  const root = path.join(os.tmpdir(), "alice-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(root, { recursive: true });
  return { root, tools: createWorkspaceFilesTools({ root }) };
}

export function makeGitRepo(root: string): void {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
}
