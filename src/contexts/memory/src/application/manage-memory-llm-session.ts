import { createLLMSessionBrowserRuntime } from "../../../llm-session/src/application/browse-llm-sessions.js";
import type { LLMSessionListItem, StoredLLMSession } from "../../../llm-session/src/adapters/sqlite-llm-session-store.js";

export function createMemoryLLMSessionRuntime(input: {
  listSessions(agentType: string, limit?: number): LLMSessionListItem[];
  readSession(sessionId: string): StoredLLMSession | undefined;
  readSessionMeta(sessionId: string): Record<string, unknown> | undefined;
}) {
  const browser = createLLMSessionBrowserRuntime({
    listSessions: input.listSessions,
    readSession: input.readSession,
    readSessionMeta: input.readSessionMeta,
    sources: [{
      name: "memorize",
      agentTypes: ["memorize"],
      limit: 100,
      mode: () => "memorize"
    }]
  });

  return {
    getMemoryLLMSessions: browser.getMemoryLLMSessions,
    getMemoryLLMSession: browser.getLLMSession
  };
}
