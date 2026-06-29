import { createChatAgent } from "../application/chat-agent.js";
import { createAllowAllPolicy } from "../ports/policy.js";
import { createIntentRouter } from "../application/intent-router.js";
import { createSessionResolver } from "../application/session-resolver.js";
import { buildCalendarContext } from "../../../../capabilities/tools/calendar/src/index.js";

export function createChatAgentRuntime(input: {
  config: any;
  activeLLM: any;
  agentLoopRuntime?: any;
  llmRequests: any;
  currentChatLLMConfig(): any;
  outputRouter: any;
  toolPlugins: any[];
  promptProfileStore: any;
  dailyShellStore: any;
  time: any;
  coreProfileStore: any;
  getLibrarySetting?(): string;
  memoryStore: any;
  diaryStore: any;
  calendarStore?: any;
  agentState: any;
  getAgentInitiatedBehaviorPlans(): any[];
  initiatedBehaviorRunStore: any;
  loadCurrentLLMSessionTranscript(): any;
  appendLLMRequestLog(input: any, agentId?: "chat" | "talk"): any;
  appendLLMResponseLog(result: any, agentId?: "chat" | "talk", request?: any): void;
  setLLMSessionBusy(busy: boolean): void;
  messagingTools: any;
  updateCurrentLLMSessionTranscript(session: any): void;
  clearCurrentLLMSession(reason: any): void;
  resolvePromptApiPreset(agentId: "chat" | "talk" | "memorize"): any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  initialLLMSession: any;
}) {
  return createChatAgent({
    config: input.config,
    llm: input.activeLLM,
    llmRequestSender: input.llmRequests.send,
    appendLoopSessionContext: input.agentLoopRuntime
      ? (contextInput: any) => input.agentLoopRuntime.appendSessionContext(contextInput)
      : undefined,
    setActiveLoopSessionContext: input.agentLoopRuntime
      ? (contextInput: any) => input.agentLoopRuntime.setActiveSessionContext(contextInput)
      : undefined,
    clearActiveLoopSessionContext: input.agentLoopRuntime
      ? (contextInput: any) => input.agentLoopRuntime.clearActiveSessionContext(contextInput)
      : undefined,
    createActiveLoopSessionContext: input.agentLoopRuntime
      ? (contextInput: any) => input.agentLoopRuntime.createActiveSessionContext(contextInput)
      : undefined,
    prepareChatLoopSessionContext: input.agentLoopRuntime
      ? (contextInput: any) => input.agentLoopRuntime.prepareChatSessionContext(contextInput)
      : undefined,
    ensureChatLoopSessionContext: input.agentLoopRuntime
      ? (contextInput: any) => input.agentLoopRuntime.ensureChatSessionContext(contextInput)
      : undefined,
    getLLMConfig: input.currentChatLLMConfig,
    isLLMRunCancelled: () => input.llmRequests.isCancelRequested(),
    outputRouter: input.outputRouter,
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    tools: input.toolPlugins,
    getPromptProfile: () => input.promptProfileStore.get(),
    getDailyShell: () => input.dailyShellStore.render(input.time.now().date, input.time.timeZone),
    getDailyShellRaw: () => input.dailyShellStore.get(input.time.now().date, input.time.timeZone),
    getAppearanceDescription: () => input.coreProfileStore.get().appearanceDescription,
    getLibrarySetting: input.getLibrarySetting,
    getMemorySnapshot: () => input.memoryStore.read(),
    getWakeBoundary: () => input.diaryStore.latestWakeBoundary(),
    getCalendarContext: input.calendarStore
      ? () => buildCalendarContext({
        calendarStore: input.calendarStore,
        time: input.time,
        userName: input.promptProfileStore.get().userName
      })
      : undefined,
    state: input.agentState,
    time: input.time,
    getAgentInitiatedBehaviorPlans: input.getAgentInitiatedBehaviorPlans,
    recordAgentInitiatedBehaviorRun(run) {
      input.initiatedBehaviorRunStore.record(run);
    },
    loadLLMSession: input.loadCurrentLLMSessionTranscript,
    onLLMRequestPrepared: (request) => input.appendLLMRequestLog(request, "chat"),
    onLLMResponseReceived: (result, request) => input.appendLLMResponseLog(result, "chat", request),
    onLLMHeartbeatStarted() {
      input.llmRequests.resetCancel();
      input.setLLMSessionBusy(true);
      input.messagingTools.noteLLMRequestStarted();
    },
    onLLMSessionUpdated(session) {
      input.updateCurrentLLMSessionTranscript(session);
    },
    onLLMSessionCleared(reason) {
      input.setLLMSessionBusy(false);
      input.messagingTools.noteLLMSessionCompleted();
      input.clearCurrentLLMSession(reason);
    },
    onLLMSessionRebuilt() {
      input.clearCurrentLLMSession("mode_transition");
      input.messagingTools.noteLLMSessionCompleted();
      input.messagingTools.noteLLMRequestStarted();
    },
    onLLMLog(event) {
      const mode = event.stream ? "stream" : "non-stream";
      const fallbackModel = input.resolvePromptApiPreset("chat")?.model;
      if (event.kind === "call_start") {
        input.appendLog("info", `llm call start: round=${event.round} mode=${mode} model=${event.model ?? fallbackModel ?? "(no preset)"}`);
      }
      if (event.kind === "rate_limited") input.appendLog("warn", `llm call skipped: active session reached 10 requests in 60s model=${event.model ?? fallbackModel ?? "(no preset)"}`);
      if (event.kind === "finish_and_wait_resume_error") input.appendLog("error", `finish_and_wait resume failed: ${event.error ?? "unknown error"}`);
      if (event.kind === "stream_start") input.appendLog("info", `llm stream start: round=${event.round} model=${event.model ?? fallbackModel ?? "(no preset)"}`);
      if (event.kind === "stream_end") input.appendLog("info", `llm stream end: round=${event.round} model=${event.model ?? fallbackModel ?? "(no preset)"}`);
      if (event.kind === "response_received") input.appendLog("info", `llm response received: round=${event.round} mode=${mode} model=${event.model ?? fallbackModel ?? "(no preset)"}`);
    },
    onLLMSessionCompleted() {
      input.setLLMSessionBusy(false);
      input.llmRequests.resetCancel();
    },
    initialLLMSession: input.initialLLMSession
  });
}
