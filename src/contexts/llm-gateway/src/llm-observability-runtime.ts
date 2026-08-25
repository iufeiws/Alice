import { createTokenUsageRuntime } from "./token-usage-runtime.js";
import { createLLMLogRuntime } from "./llm-log-runtime.js";

export function createLLMObservabilityRuntime(input: {
  time: any;
  tokenUsageStore: any;
  requestLogs: any[];
  responseLogs: any[];
  resolvePromptApiPreset(agentId: "chat" | "talk" | "memorize"): any;
  agentLoopRuntime: any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  const tokenUsageRuntime = createTokenUsageRuntime({
    getStore: () => input.tokenUsageStore,
    resolveModel: (agentId) => agentId === "talk" ? input.resolvePromptApiPreset("talk")?.model : agentId === "chat" ? input.resolvePromptApiPreset("chat")?.model : undefined,
    appendLog: input.appendLog
  });

  const llmLogRuntime = createLLMLogRuntime({
    time: input.time,
    requestLogs: input.requestLogs,
    responseLogs: input.responseLogs,
    ensureActiveSession: (time, agentId = "chat") => input.agentLoopRuntime.ensureCurrentLLMSession(time, agentId),
    getActiveSession: () => input.agentLoopRuntime.getActiveMainLLMSession(),
    noteRequest: (entry, agentId, transcriptMessages) => input.agentLoopRuntime.noteLLMRequest(entry, agentId, transcriptMessages),
    noteResponse: (entry) => input.agentLoopRuntime.noteLLMResponse(entry),
    appendUsageLog: tokenUsageRuntime.appendLLMUsageLog,
    resolveModel: (agentId) => agentId === "talk" ? input.resolvePromptApiPreset("talk")?.model : input.resolvePromptApiPreset("chat")?.model,
    recordTokenUsage: tokenUsageRuntime.recordTokenUsage
  });

  return {
    llmLogRuntime,
    recordTokenUsageEvent: tokenUsageRuntime.recordTokenUsageEvent,
    appendLLMUsageLog: tokenUsageRuntime.appendLLMUsageLog,
    getTokenUsageReport: tokenUsageRuntime.getTokenUsageReport
  };
}
