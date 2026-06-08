import { createApiAgentRuntime } from "./api-agent-runtime.js";

export function createApiAgentStackRuntime(input: {
  config: any;
  activeLLM: any;
  llmConfigRuntime: any;
  outputRouter: any;
  apiToolingRuntime: any;
  apiContextRuntime: any;
  apiLLMRuntime: any;
  apiRuntimeState: any;
  agentState: any;
  time: any;
  resolvePromptApiPreset(kind: any): any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  const apiAgentRuntime = createApiAgentRuntime({
    config: input.config,
    activeLLM: input.activeLLM,
    llmRequests: input.apiToolingRuntime.llmRequests,
    currentChatLLMConfig: () => input.llmConfigRuntime.currentChatLLMConfig(),
    currentTalkLLMConfig: () => input.llmConfigRuntime.currentTalkLLMConfig(),
    outputRouter: input.outputRouter,
    toolPlugins: input.apiToolingRuntime.toolPlugins,
    promptProfileStore: input.apiContextRuntime.promptProfileStore,
    talkPromptProfileStore: input.apiContextRuntime.talkPromptProfileStore,
    dailyShellStore: input.apiContextRuntime.dailyShellStore,
    time: input.time,
    coreProfileStore: input.apiContextRuntime.coreProfileStore,
    memoryStore: input.apiContextRuntime.memoryStore,
    diaryStore: input.apiContextRuntime.diaryStore,
    agentState: input.agentState,
    getAgentInitiatedBehaviorPlans: input.apiContextRuntime.getAgentInitiatedBehaviorPlans,
    initiatedBehaviorRunStore: input.apiContextRuntime.initiatedBehaviorRunStore,
    activeLLMSessionRuntime: input.apiLLMRuntime.activeLLMSessionRuntime,
    getActiveLLMSession: input.apiRuntimeState.getActiveLLMSession,
    setLLMSessionBusy: input.apiRuntimeState.setLLMSessionBusy,
    messagingTools: input.apiToolingRuntime.messagingTools,
    llmLogRuntime: input.apiLLMRuntime.llmLogRuntime,
    resolvePromptApiPreset: input.resolvePromptApiPreset,
    visibleToolNames: input.apiToolingRuntime.visibleToolNames,
    appendLog: input.appendLog
  });

  return {
    apiAgentRuntime,
    talkAgentLoop: apiAgentRuntime.talkAgentLoop,
    talkRuntime: apiAgentRuntime.talkRuntime,
    core: apiAgentRuntime.core
  };
}
