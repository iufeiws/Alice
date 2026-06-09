import { createMemoryConsoleRuntime } from "../../../../contexts/memory/src/memory-console-runtime.js";
import { createMemoryLLMSessionRuntime } from "../../../../contexts/memory/src/application/manage-memory-llm-session.js";
import { createLLMSessionBrowserRuntime } from "./browse-llm-sessions.js";
import { createLLMSessionListRuntime } from "./list-llm-sessions.js";
import { createLLMRequestPreviewRuntime } from "../../../llm-gateway/src/llm-request-preview-runtime.js";

export function createAdminLLMSessionRuntime(input: {
  sessionRoot(): string;
  time: any;
  archive: any;
  requestLogs: any[];
  getActiveSession(): any;
  listRecentMessages(): any[];
  getPromptProfile(): any;
  getTalkPromptProfile(): any;
  getDefaultTarget(): any;
  resolveChatPreset(): any;
  buildPromptPreviewMessages(profile: any, event: any, includeFakeCheckChat?: boolean): Promise<any>;
  visibleToolSpecs(profile: any): any;
}) {
  const memoryConsoleRuntime = createMemoryConsoleRuntime({
    sessionRoot: input.sessionRoot,
    time: input.time
  });
  const memoryLLMSessionRuntime = createMemoryLLMSessionRuntime({
    sessionRoot: input.sessionRoot,
    collectFiles: input.archive.collectFiles,
    relativePath: input.archive.relativePath
  });
  const llmSessionListRuntime = createLLMSessionListRuntime({
    archive: input.archive,
    getActiveSession: input.getActiveSession
  });
  const llmSessionBrowserRuntime = createLLMSessionBrowserRuntime({
    sessionRoot: input.sessionRoot,
    collectFiles: input.archive.collectFiles,
    relativePath: input.archive.relativePath,
    getActiveSession: input.getActiveSession,
    sources: [{
      name: "runtime",
      accept: (metadata) => metadata.agent !== "memorize",
      id: ({ metadata, relativePath }) => String(metadata.sessionId ?? relativePath)
    }, {
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
  const llmRequestPreviewRuntime = createLLMRequestPreviewRuntime({
    requestLogs: input.requestLogs,
    hasActiveSession: () => Boolean(input.getActiveSession()),
    listRecentMessages: input.listRecentMessages,
    getPromptProfile: input.getPromptProfile,
    getTalkPromptProfile: input.getTalkPromptProfile,
    getDefaultTarget: input.getDefaultTarget,
    resolveChatPreset: input.resolveChatPreset,
    time: input.time,
    buildPromptPreviewMessages: input.buildPromptPreviewMessages,
    visibleToolSpecs: input.visibleToolSpecs
  });

  return {
    memoryConsoleRuntime,
    memoryLLMSessionRuntime,
    llmSessionListRuntime,
    llmSessionBrowserRuntime,
    getLLMRequestPreview: llmRequestPreviewRuntime.getLLMRequestPreview,
    getLLMRequestProfilePreview: llmRequestPreviewRuntime.getLLMRequestProfilePreview,
    getTalkLLMRequestProfilePreview: llmRequestPreviewRuntime.getTalkLLMRequestProfilePreview
  };
}
