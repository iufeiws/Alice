import { createChatAgentRuntime } from "../../../contexts/agent-loop/src/runtime/chat-agent-runtime.js";
import { createTalkRuntimeRuntime } from "../../../contexts/talk-session/src/runtime/talk-session-runtime.js";
import type { LLMTextVariables } from "../../../contexts/agent-profile/src/application/llm-text-renderer.js";

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
  getLibrarySetting?(): string;
  getAvailableSkills?(): string;
  getPromptVariables(): LLMTextVariables;
  memoryStore: any;
  diaryStore: any;
  calendarStore?: any;
  agentState: any;
  getAgentInitiatedBehaviorPlans(): any[];
  initiatedBehaviorRunStore: any;
  agentLoopRuntime: any;
  conversationStore: any;
  setLLMSessionBusy(busy: boolean): void;
  messagingTools: any;
  llmLogRuntime: any;
  resolvePromptApiPreset(agentId: "chat" | "talk" | "memorize"): any;
  visibleToolNames(profile: any): string[];
  agentRunIndicator?: any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  const { talkAgentLoop, talkRuntime } = createTalkRuntimeRuntime({
    isActiveTalkLLMSession: (sessionId) => input.agentLoopRuntime.isActiveTalkLLMSession(sessionId),
    getCurrentTalkLLMSessionId: () => {
      const active = input.agentLoopRuntime.getActiveMainLLMSession();
      return active?.agentId === "talk" && typeof active.id === "number" ? active.id : undefined;
    },
    getTalkPromptProfile: () => input.talkPromptProfileStore.get(),
    time: input.time,
    dailyShellStore: input.dailyShellStore,
    getAppearanceDescription: () => input.coreProfileStore.get().appearanceDescription,
    getLibrarySetting: input.getLibrarySetting,
    getAvailableSkills: input.getAvailableSkills,
    getPromptVariables: input.getPromptVariables,
    memoryStore: input.memoryStore,
    diaryStore: input.diaryStore,
    visibleToolNames: input.visibleToolNames,
    toolPlugins: input.toolPlugins,
    getLLMConfig: input.currentTalkLLMConfig,
    sendRequest: (requestInput) => input.llmRequests.send(requestInput),
    agentLoopRuntime: input.agentLoopRuntime,
    createLLMSession: (occurredAt) => input.agentLoopRuntime.createTalkLLMSession(occurredAt).id,
    loadActiveTalkLLMSessionTranscript: () => input.agentLoopRuntime.loadCurrentLLMSessionTranscript(),
    updateActiveTalkLLMSessionTranscript: (session) => input.agentLoopRuntime.updateActiveTalkLLMSessionTranscript(session),
    rewriteActiveTalkLLMSessionFromRuntime: (sessionId) => input.agentLoopRuntime.rewriteActiveTalkLLMSessionFromRuntime(sessionId),
    conversationStore: input.conversationStore,
    agentState: input.agentState,
    appendLog: input.appendLog
  });

  const chatAgent = createChatAgentRuntime({
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
    getLibrarySetting: input.getLibrarySetting,
    getPromptVariables: input.getPromptVariables,
    memoryStore: input.memoryStore,
    diaryStore: input.diaryStore,
    calendarStore: input.calendarStore,
    agentState: input.agentState,
    getAgentInitiatedBehaviorPlans: input.getAgentInitiatedBehaviorPlans,
    initiatedBehaviorRunStore: input.initiatedBehaviorRunStore,
    loadCurrentLLMSessionTranscript: () => input.agentLoopRuntime.loadCurrentLLMSessionTranscript(),
    appendLLMRequestLog: (requestInput, agentId = "chat") => input.llmLogRuntime.appendRequestLog(requestInput, agentId),
    appendLLMResponseLog: (result, agentId = "chat", request) => input.llmLogRuntime.appendResponseLog(result, agentId, request),
    setLLMSessionBusy: input.setLLMSessionBusy,
    messagingTools: input.messagingTools,
    updateCurrentLLMSessionTranscript: (session) => input.agentLoopRuntime.updateCurrentLLMSessionTranscript(session),
    clearCurrentLLMSession: (reason) => input.agentLoopRuntime.clearCurrentLLMSession(reason),
    resolvePromptApiPreset: input.resolvePromptApiPreset,
    agentRunIndicator: input.agentRunIndicator,
    appendLog: input.appendLog,
    initialLLMSession: input.agentLoopRuntime.loadCurrentLLMSessionTranscript()
  });

  return { talkAgentLoop, talkRuntime, chatAgent };
}
