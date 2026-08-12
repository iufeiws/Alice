import { createChatAgentRuntime } from "../../../contexts/agent-loop/src/runtime/chat-agent-runtime.js";
import { createTalkRuntimeRuntime } from "../../../contexts/talk-session/src/runtime/talk-session-runtime.js";
import type { PromptContextRuntime } from "../../../contexts/prompt-context/src/index.js";
import { restartToolName } from "../../../capabilities/tools/restart/profile.js";

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
  time: any;
  getPromptRenderer(): PromptContextRuntime;
  agentState: any;
  getAgentInitiatedBehaviorPlans(): any[];
  initiatedBehaviorRunStore: any;
  agentLoopRuntime: any;
  conversationStore: any;
  messagingTools: any;
  llmLogRuntime: any;
  resolvePromptApiPreset(agentId: "chat" | "talk" | "memorize"): any;
  visibleToolNames(profile: any): string[];
  agentRunIndicator?: any;
  processRestartContinuationStore?: any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  const { talkAgentLoop, talkRuntime } = createTalkRuntimeRuntime({
    isActiveTalkLLMSession: (sessionId) => input.agentLoopRuntime.isActiveTalkLLMSession(sessionId),
    getCurrentTalkLLMSessionId: () => {
      const active = input.agentLoopRuntime.getActiveMainLLMSession();
      if (!active || active.agentId !== "talk") return undefined;
      // LLM 会话 id 为字符串(UTC 毫秒时间戳), talk 会话 id 仍为数字, 在边界转换。
      if (typeof active.id === "number") return active.id;
      const parsed = Number(active.id);
      return Number.isFinite(parsed) ? parsed : undefined;
    },
    getTalkPromptProfile: () => input.talkPromptProfileStore.get(),
    time: input.time,
    getPromptRenderer: input.getPromptRenderer,
    visibleToolNames: (profile) => input.visibleToolNames(profile).filter((name: string) => name !== restartToolName),
    toolPlugins: input.toolPlugins.filter((plugin: { id?: string }) => plugin.id !== "subagent"),
    getLLMConfig: input.currentTalkLLMConfig,
    sendRequest: (requestInput) => input.llmRequests.send(requestInput),
    flushResponseTranscript: ({ request, result }) => input.llmRequests.flushResponseTranscript?.(request, result.message),
    agentLoopRuntime: input.agentLoopRuntime,
    createLLMSession: (occurredAt) => Number(input.agentLoopRuntime.createTalkLLMSession(occurredAt).id),
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
    time: input.time,
    getPromptRenderer: input.getPromptRenderer,
    agentState: input.agentState,
    getAgentInitiatedBehaviorPlans: input.getAgentInitiatedBehaviorPlans,
    initiatedBehaviorRunStore: input.initiatedBehaviorRunStore,
    loadCurrentLLMSessionTranscript: () => input.agentLoopRuntime.loadCurrentLLMSessionTranscript(),
    appendLLMRequestLog: (requestInput, agentId = "chat") => input.llmLogRuntime.appendRequestLog(requestInput, agentId),
    appendLLMResponseLog: (result, agentId = "chat", request) => input.llmLogRuntime.appendResponseLog(result, agentId, request),
    messagingTools: input.messagingTools,
    updateCurrentLLMSessionTranscript: (session) => input.agentLoopRuntime.updateCurrentLLMSessionTranscript(session),
    clearCurrentLLMSession: (reason) => input.agentLoopRuntime.clearCurrentLLMSession(reason),
    resolvePromptApiPreset: input.resolvePromptApiPreset,
    agentRunIndicator: input.agentRunIndicator,
    appendLog: input.appendLog,
    initialLLMSession: input.agentLoopRuntime.loadCurrentLLMSessionTranscript(),
    processRestartContinuationStore: input.processRestartContinuationStore
  });

  return { talkAgentLoop, talkRuntime, chatAgent };
}
