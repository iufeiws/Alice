import { createMemoryConsoleRuntime } from "../../../../contexts/memory/src/memory-console-runtime.js";
import { createMemoryLLMSessionRuntime } from "../../../../contexts/memory/src/application/manage-memory-llm-session.js";
import { createLLMSessionBrowserRuntime } from "./browse-llm-sessions.js";
import { createLLMSessionListRuntime } from "./list-llm-sessions.js";
import { createLLMRequestPreviewRuntime } from "../../../llm-gateway/src/llm-request-preview-runtime.js";

export function createAdminLLMSessionRuntime(input: {
  sessionRoot(): string;
  time: any;
  archive: any;
  sessionClearCoordinator: any;
  /** Main Agent clearing 占用获取口(§7.3): 转发给 Memorize memory console clearSession。 */
  acquireMainAgentClear: (input: { kind: "chat" | "talk" | "memorize"; sessionId: string }) => any;
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
    time: input.time,
    sessionClearCoordinator: input.sessionClearCoordinator,
    acquireMainAgentClear: input.acquireMainAgentClear
  });
  const memoryLLMSessionRuntime = createMemoryLLMSessionRuntime({
    listSessions: (agentType, limit) => input.archive.listSessions(agentType, limit),
    readSession: (sessionId) => input.archive.readSession(sessionId),
    readSessionMeta: (sessionId) => input.archive.readSessionMeta(sessionId)
  });
  const llmSessionListRuntime = createLLMSessionListRuntime({
    archive: input.archive
  });
  const llmSessionBrowserRuntime = createLLMSessionBrowserRuntime({
    getActiveSession: input.getActiveSession,
    listSessions: (agentType, limit) => input.archive.listSessions(agentType, limit),
    readSession: (sessionId) => input.archive.readSession(sessionId),
    readSessionMeta: (sessionId) => input.archive.readSessionMeta(sessionId),
    sources: [{
      name: "runtime",
      agentTypes: ["chat", "talk"]
    }, {
      name: "memorize",
      agentTypes: ["memorize"],
      limit: 100,
      mode: () => "memorize"
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
