import { createLLMSessionBrowserRuntime } from "../../../llm-session/src/application/browse-llm-sessions.js";

export function createMemoryLLMSessionRuntime(input: {
  sessionRoot(): string;
  collectFiles(dir: string, files: string[]): void;
  relativePath(filePath: string): string;
}) {
  const browser = createLLMSessionBrowserRuntime({
    sessionRoot: input.sessionRoot,
    collectFiles: input.collectFiles,
    relativePath: input.relativePath,
    sources: [{
      name: "memorize",
      subdir: "memorize",
      limit: 100,
      accept: (metadata) => metadata.agent === "memorize",
      id: ({ metadata, relativePath }) => typeof metadata.sessionId === "string"
        ? metadata.sessionId
        : `memorize:${relativePath}`,
      mode: (metadata) => typeof metadata.mode === "string" ? metadata.mode : "memorize"
    }]
  });

  return {
    getMemoryLLMSessions: browser.getMemoryLLMSessions,
    getMemoryLLMSession: browser.getLLMSession
  };
}
