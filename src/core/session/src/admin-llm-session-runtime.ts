import { createMemoryConsoleRuntime } from "../../agent/src/memory-console-runtime.js";
import { createMemoryLLMSessionRuntime } from "./memory-llm-session-runtime.js";
import { createLLMSessionListRuntime } from "./llm-session-list-runtime.js";
import { createLLMRequestPreviewRuntime } from "./llm-request-preview-runtime.js";

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
    getLLMRequestPreview: llmRequestPreviewRuntime.getLLMRequestPreview,
    getLLMRequestProfilePreview: llmRequestPreviewRuntime.getLLMRequestProfilePreview,
    getTalkLLMRequestProfilePreview: llmRequestPreviewRuntime.getTalkLLMRequestProfilePreview
  };
}
