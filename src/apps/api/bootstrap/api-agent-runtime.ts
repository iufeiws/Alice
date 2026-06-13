import { createAgentCoreRuntime } from "../../../contexts/agent-loop/src/runtime/agent-core-runtime.js";
import { createTalkRuntimeRuntime } from "../../../contexts/talk-session/src/runtime/talk-session-runtime.js";

export function createApiAgentRuntime(input: {
  config: any;
  activeLLM: any;
  llmRequests: any;
  currentChatLLMConfig(): any;
  currentTalkLLMConfig(): any;
  outputRouter: any;
  toolPlugins: any[];
  promptProfileStore: any;
  talkPromptProfileStore: any;
  dailyShellStore: any;
  time: any;
  coreProfileStore: any;
  memoryStore: any;
  diaryStore: any;
  agentState: any;
  getAgentInitiatedBehaviorPlans(): any[];
  initiatedBehaviorRunStore: any;
  agentLoopRuntime: any;
  conversationStore: any;
  getActiveLLMSession(): any;
  setLLMSessionBusy(busy: boolean): void;
  messagingTools: any;
  llmLogRuntime: any;
  resolvePromptApiPreset(agentId: "chat" | "talk" | "memorize"): any;
  visibleToolNames(profile: any): string[];
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  const { talkAgentLoop, talkRuntime } = createTalkRuntimeRuntime({
    isActiveTalkLLMSession: (sessionId) => input.agentLoopRuntime.isActiveTalkLLMSession(sessionId),
    getActiveTalkLLMSessionId: () => input.getActiveLLMSession()?.id,
    getTalkPromptProfile: () => input.talkPromptProfileStore.get(),
    time: input.time,
    dailyShellStore: input.dailyShellStore,
    getAppearanceDescription: () => input.coreProfileStore.get().appearanceDescription,
    memoryStore: input.memoryStore,
    diaryStore: input.diaryStore,
    visibleToolNames: input.visibleToolNames,
    toolPlugins: input.toolPlugins,
    getLLMConfig: input.currentTalkLLMConfig,
    sendRequest: (requestInput) => input.llmRequests.send(requestInput),
    agentLoopRuntime: input.agentLoopRuntime,
    createLLMSession: (occurredAt) => input.agentLoopRuntime.createTalkLLMSession(occurredAt).id,
    loadActiveTalkLLMSessionTranscript: () => input.agentLoopRuntime.loadActiveLLMSessionTranscript(),
    updateActiveTalkLLMSessionTranscript: (session) => input.agentLoopRuntime.updateActiveTalkLLMSessionTranscript(session),
    rewriteActiveTalkLLMSessionFromRuntime: (sessionId) => input.agentLoopRuntime.rewriteActiveTalkLLMSessionFromRuntime(sessionId),
    conversationStore: input.conversationStore,
    agentState: input.agentState,
    appendLog: input.appendLog
  });

  const core = createAgentCoreRuntime({
    config: input.config,
    activeLLM: input.activeLLM,
    agentLoopRuntime: input.agentLoopRuntime,
    llmRequests: input.llmRequests,
    currentChatLLMConfig: input.currentChatLLMConfig,
    outputRouter: input.outputRouter,
    toolPlugins: input.toolPlugins,
    promptProfileStore: input.promptProfileStore,
    dailyShellStore: input.dailyShellStore,
    time: input.time,
    coreProfileStore: input.coreProfileStore,
    memoryStore: input.memoryStore,
    diaryStore: input.diaryStore,
    agentState: input.agentState,
    getAgentInitiatedBehaviorPlans: input.getAgentInitiatedBehaviorPlans,
    initiatedBehaviorRunStore: input.initiatedBehaviorRunStore,
    loadActiveLLMSessionTranscript: () => input.agentLoopRuntime.loadActiveLLMSessionTranscript(),
    appendLLMRequestLog: (requestInput, agentId = "chat") => input.llmLogRuntime.appendRequestLog(requestInput, agentId),
    appendLLMResponseLog: (result, agentId = "chat", request) => input.llmLogRuntime.appendResponseLog(result, agentId, request),
    setLLMSessionBusy: input.setLLMSessionBusy,
    messagingTools: input.messagingTools,
    updateActiveLLMSessionTranscript: (session) => input.agentLoopRuntime.updateActiveLLMSessionTranscript(session),
    clearActiveLLMSession: (reason) => input.agentLoopRuntime.clearActiveLLMSession(reason),
    resolvePromptApiPreset: input.resolvePromptApiPreset,
    appendLog: input.appendLog,
    initialLLMSession: input.getActiveLLMSession()
  });

  return { talkAgentLoop, talkRuntime, core };
}
