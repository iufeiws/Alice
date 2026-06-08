import { createTokenUsageRuntime } from "./token-usage-runtime.js";
import { createLLMLogRuntime } from "./llm-log-runtime.js";

export function createLLMObservabilityRuntime(input: {
  time: any;
  tokenUsageStore: any;
  requestLogs: any[];
  responseLogs: any[];
  resolvePromptApiPreset(agentId: "chat" | "talk" | "memorize"): any;
  activeLLMSessionRuntime: any;
  getActiveSession(): any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  const tokenUsageRuntime = createTokenUsageRuntime({
    getStore: () => input.tokenUsageStore,
    resolveModel: (agentId) => input.resolvePromptApiPreset(agentId === "talk" ? "talk" : "chat")?.model,
    appendLog: input.appendLog
  });

  const llmLogRuntime = createLLMLogRuntime({
    time: input.time,
    requestLogs: input.requestLogs,
    responseLogs: input.responseLogs,
    ensureActiveSession: (time, agentId = "chat") => input.activeLLMSessionRuntime.ensureActiveLLMSession(time, agentId),
    getActiveSession: input.getActiveSession,
    noteRequest: (entry, agentId = "chat") => input.activeLLMSessionRuntime.noteActiveLLMRequest(entry, agentId),
    noteResponse: (entry) => input.activeLLMSessionRuntime.noteActiveLLMResponse(entry),
    appendUsageLog: tokenUsageRuntime.appendLLMUsageLog,
    resolveModel: (agentId) => input.resolvePromptApiPreset(agentId === "talk" ? "talk" : "chat")?.model,
    recordTokenUsage: tokenUsageRuntime.recordTokenUsage
  });

  return {
    llmLogRuntime,
    recordTokenUsageEvent: tokenUsageRuntime.recordTokenUsageEvent,
    appendLLMUsageLog: tokenUsageRuntime.appendLLMUsageLog,
    getTokenUsageReport: tokenUsageRuntime.getTokenUsageReport
  };
}
