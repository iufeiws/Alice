import { createTokenUsageRuntime } from "./token-usage-runtime.js";
import { createLLMLogRuntime } from "./llm-log-runtime.js";

export function createLLMObservabilityRuntime(input: {
  time: any;
  tokenUsageStore: any;
  requestLogs: any[];
  responseLogs: any[];
  resolvePromptApiPreset(agentId: "chat" | "talk" | "memorize"): any;
  resolveLLMApiPreset(name: string): any;
  piPresetName?: string;
  agentLoopRuntime: any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  const tokenUsageRuntime = createTokenUsageRuntime({
    getStore: () => input.tokenUsageStore,
    resolveModel: (agentId) => agentId === "talk" ? input.resolvePromptApiPreset("talk")?.model : agentId === "chat" ? input.resolvePromptApiPreset("chat")?.model : undefined,
    resolvePreset: (agentId) => agentId === "chat" || agentId === "talk" || agentId === "memorize"
      ? input.resolvePromptApiPreset(agentId)
      : agentId === "pi" && input.piPresetName ? input.resolveLLMApiPreset(input.piPresetName) : undefined,
    now: () => input.time.now().date,
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
    resolveModel: (agentId) => agentId === "talk" ? input.resolvePromptApiPreset("talk")?.model : input.resolvePromptApiPreset("chat")?.model
  });

  return {
    llmLogRuntime,
    recordTokenUsageEvent: tokenUsageRuntime.recordTokenUsageEvent,
    appendLLMUsageLog: tokenUsageRuntime.appendLLMUsageLog,
    getTokenUsageReport: tokenUsageRuntime.getTokenUsageReport
  };
}
