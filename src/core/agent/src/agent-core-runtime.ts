import { createAgentCore } from "./index.js";
import { createAllowAllPolicy } from "../../policy/src/index.js";
import { createIntentRouter } from "../../router/src/index.js";
import { createSessionResolver } from "../../session/src/index.js";

export function createAgentCoreRuntime(input: {
  config: any;
  activeLLM: any;
  llmRequests: any;
  currentChatLLMConfig(): any;
  outputRouter: any;
  toolPlugins: any[];
  promptProfileStore: any;
  dailyShellStore: any;
  time: any;
  coreProfileStore: any;
  memoryStore: any;
  diaryStore: any;
  agentState: any;
  getAgentInitiatedBehaviorPlans(): any[];
  initiatedBehaviorRunStore: any;
  loadActiveLLMSessionTranscript(): any;
  appendLLMRequestLog(input: any, agentId?: "chat" | "talk"): void;
  appendLLMResponseLog(result: any, agentId?: "chat" | "talk"): void;
  setLLMSessionBusy(busy: boolean): void;
  messagingTools: any;
  updateActiveLLMSessionTranscript(session: any): void;
  clearActiveLLMSession(reason: any): void;
  resolvePromptApiPreset(agentId: "chat" | "talk" | "memorize"): any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  initialLLMSession: any;
}) {
  return createAgentCore({
    config: input.config,
    llm: input.activeLLM,
    llmRequestSender: input.llmRequests.send,
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
    getMemorySnapshot: () => input.memoryStore.read(),
    getWakeBoundary: () => input.diaryStore.latestWakeBoundary(),
    state: input.agentState,
    time: input.time,
    getAgentInitiatedBehaviorPlans: input.getAgentInitiatedBehaviorPlans,
    recordAgentInitiatedBehaviorRun(run) {
      input.initiatedBehaviorRunStore.record(run);
    },
    loadLLMSession: input.loadActiveLLMSessionTranscript,
    onLLMRequestPrepared: input.appendLLMRequestLog,
    onLLMResponseReceived: input.appendLLMResponseLog,
    onLLMHeartbeatStarted() {
      input.llmRequests.resetCancel();
      input.setLLMSessionBusy(true);
      input.messagingTools.noteLLMRequestStarted();
    },
    onLLMSessionUpdated(session) {
      input.updateActiveLLMSessionTranscript(session);
    },
    onLLMSessionCleared(reason) {
      input.setLLMSessionBusy(false);
      input.messagingTools.noteLLMSessionCompleted();
      input.clearActiveLLMSession(reason);
    },
    onLLMSessionRebuilt() {
      input.clearActiveLLMSession("mode_transition");
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
      if (event.kind === "wait_chat_resume_error") input.appendLog("error", `wait_chat resume failed: ${event.error ?? "unknown error"}`);
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
