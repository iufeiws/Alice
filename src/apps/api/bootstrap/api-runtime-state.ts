import type { LLMRequestLogEntry, LLMResponseLogEntry } from "../../../contexts/llm-session/src/index.js";

export function createApiRuntimeState() {
  const llmRequestLogs: LLMRequestLogEntry[] = [];
  const llmResponseLogs: LLMResponseLogEntry[] = [];

  return {
    llmRequestLogs,
    llmResponseLogs
  };
}
