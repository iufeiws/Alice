import { createApiSessionRuntime } from "../../../contexts/llm-session/src/index.js";
import { createLLMObservabilityRuntime } from "../../../contexts/llm-gateway/src/llm-observability-runtime.js";

export function createApiLLMRuntime(input: {
  config: any;
  time: any;
  tokenUsageStore: any;
  apiRuntimeState: any;
  agentLoopRuntime: any;
  sessionClearCoordinator: any;
  resolvePromptApiPreset(kind: any): any;
  readLLMApiPresets(): any[];
  getConversationStartIndex(sessionId: number): number | undefined;
  buildTalkRuntimeMessages(sessionId: number): any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  const apiSessionRuntime = createApiSessionRuntime({
    config: input.config,
    time: input.time,
    sessionClearCoordinator: input.sessionClearCoordinator,
    getConversationStartIndex: input.getConversationStartIndex,
    buildTalkRuntimeMessages: input.buildTalkRuntimeMessages,
    appendLog: input.appendLog
  });
  const llmSessionArchive = apiSessionRuntime.llmSessionArchive;
  const llmSessionRuntime = apiSessionRuntime.llmSessionRuntime;
  apiSessionRuntime.restoreCurrentLLMSession();
  input.agentLoopRuntime.setLLMSessionRuntime(llmSessionRuntime);

  const llmObservabilityRuntime = createLLMObservabilityRuntime({
    time: input.time,
    tokenUsageStore: input.tokenUsageStore,
    requestLogs: input.apiRuntimeState.llmRequestLogs,
    responseLogs: input.apiRuntimeState.llmResponseLogs,
    resolvePromptApiPreset: input.resolvePromptApiPreset,
    resolveLLMApiPreset: (name) => input.readLLMApiPresets().find((preset) => preset.name === name),
    piPresetName: input.config.piWorkerConfig.llmPresetName,
    agentLoopRuntime: input.agentLoopRuntime,
    appendLog: input.appendLog
  });

  return {
    llmSessionArchive,
    llmSessionRuntime,
    llmLogRuntime: llmObservabilityRuntime.llmLogRuntime,
    recordTokenUsageEvent: llmObservabilityRuntime.recordTokenUsageEvent,
    appendLLMUsageLog: llmObservabilityRuntime.appendLLMUsageLog,
    getTokenUsageReport: llmObservabilityRuntime.getTokenUsageReport
  };
}
