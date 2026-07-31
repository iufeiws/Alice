import { createApiAgentRuntime } from "./api-agent-runtime.js";
import { createAgentRunIndicatorRuntime } from "../../../contexts/agent-run-indicator/src/index.js";

export function createApiAgentStackRuntime(input: {
  config: any;
  activeLLM: any;
  llmConfigRuntime: any;
  outputRouter: any;
  apiToolingRuntime: any;
  apiContextRuntime: any;
  apiLLMRuntime: any;
  apiRuntimeState: any;
  agentLoopRuntime: any;
  store: any;
  agentState: any;
  time: any;
  resolvePromptApiPreset(kind: any): any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  processRestartContinuationStore?: any;
}) {
  const agentRunIndicatorRuntime = createAgentRunIndicatorRuntime();
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
    time: input.time,
    getPromptRenderer: () => input.apiContextRuntime.promptContextRuntime,
    agentState: input.agentState,
    getAgentInitiatedBehaviorPlans: input.apiContextRuntime.getAgentInitiatedBehaviorPlans,
    initiatedBehaviorRunStore: input.apiContextRuntime.initiatedBehaviorRunStore,
    agentLoopRuntime: input.agentLoopRuntime,
    conversationStore: input.store,
    messagingTools: input.apiToolingRuntime.messagingTools,
    llmLogRuntime: input.apiLLMRuntime.llmLogRuntime,
    resolvePromptApiPreset: input.resolvePromptApiPreset,
    visibleToolNames: input.apiToolingRuntime.visibleToolNames,
    agentRunIndicator: agentRunIndicatorRuntime,
    appendLog: input.appendLog,
    processRestartContinuationStore: input.processRestartContinuationStore
  });

  return {
    apiAgentRuntime,
    talkAgentLoop: apiAgentRuntime.talkAgentLoop,
    talkRuntime: apiAgentRuntime.talkRuntime,
    chatAgent: apiAgentRuntime.chatAgent,
    agentRunIndicatorRuntime
  };
}
