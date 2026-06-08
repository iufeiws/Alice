import type { ActiveLLMSession, LLMRequestLogEntry, LLMResponseLogEntry } from "../../../../core/session/src/llm-session-types.js";

export function createApiRuntimeState() {
  const llmRequestLogs: LLMRequestLogEntry[] = [];
  const llmResponseLogs: LLMResponseLogEntry[] = [];
  let activeLLMSession: ActiveLLMSession | undefined;
  let llmSessionBusy = false;

  return {
    llmRequestLogs,
    llmResponseLogs,
    getActiveLLMSession: () => activeLLMSession,
    setActiveLLMSession: (session: ActiveLLMSession | undefined) => {
      activeLLMSession = session;
    },
    isLLMSessionBusy: () => llmSessionBusy,
    setLLMSessionBusy: (busy: boolean) => {
      llmSessionBusy = busy;
    }
  };
}
