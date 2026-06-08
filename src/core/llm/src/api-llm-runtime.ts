import { createApiSessionRuntime } from "../../session/api-session-runtime.js";
import { createLLMObservabilityRuntime } from "./llm-observability-runtime.js";

export function createApiLLMRuntime(input: {
  config: any;
  time: any;
  tokenUsageStore: any;
  apiRuntimeState: any;
  resolvePromptApiPreset(kind: any): any;
  getConversationStartIndex(sessionId: string): number | undefined;
  buildTalkRuntimeMessages(sessionId: string): any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  const apiSessionRuntime = createApiSessionRuntime({
    config: input.config,
    time: input.time,
    getSession: input.apiRuntimeState.getActiveLLMSession,
    setSession: input.apiRuntimeState.setActiveLLMSession,
    getConversationStartIndex: input.getConversationStartIndex,
    buildTalkRuntimeMessages: input.buildTalkRuntimeMessages,
    appendLog: input.appendLog
  });
  const llmSessionArchive = apiSessionRuntime.llmSessionArchive;
  const activeLLMSessionRuntime = apiSessionRuntime.activeLLMSessionRuntime;
  apiSessionRuntime.restoreActiveLLMSession();

  const llmObservabilityRuntime = createLLMObservabilityRuntime({
    time: input.time,
    tokenUsageStore: input.tokenUsageStore,
    requestLogs: input.apiRuntimeState.llmRequestLogs,
    responseLogs: input.apiRuntimeState.llmResponseLogs,
    resolvePromptApiPreset: input.resolvePromptApiPreset,
    activeLLMSessionRuntime,
    getActiveSession: input.apiRuntimeState.getActiveLLMSession,
    appendLog: input.appendLog
  });

  return {
    llmSessionArchive,
    activeLLMSessionRuntime,
    llmLogRuntime: llmObservabilityRuntime.llmLogRuntime,
    recordTokenUsageEvent: llmObservabilityRuntime.recordTokenUsageEvent,
    appendLLMUsageLog: llmObservabilityRuntime.appendLLMUsageLog,
    getTokenUsageReport: llmObservabilityRuntime.getTokenUsageReport
  };
}
