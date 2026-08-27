import type { LLMRequestLogEntry, LLMResponseLogInfo } from "../../../contexts/llm-session/src/index.js";

export function createApiRuntimeState() {
  const llmRequestLogs: LLMRequestLogEntry[] = [];
  const llmResponseLogs: LLMResponseLogInfo[] = [];

  return {
    llmRequestLogs,
    llmResponseLogs
  };
}
