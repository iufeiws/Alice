import type { LLMRequestLogEntry, LLMResponseLogEntry } from "../../../contexts/llm-session/src/index.js";

export function createApiRuntimeState() {
  const llmRequestLogs: LLMRequestLogEntry[] = [];
  const llmResponseLogs: LLMResponseLogEntry[] = [];
  let llmSessionBusy = false;

  return {
    llmRequestLogs,
    llmResponseLogs,
    isLLMSessionBusy: () => llmSessionBusy,
    setLLMSessionBusy: (busy: boolean) => {
      llmSessionBusy = busy;
    }
  };
}
