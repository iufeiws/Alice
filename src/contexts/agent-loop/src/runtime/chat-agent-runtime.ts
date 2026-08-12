import { createChatAgent } from "../application/chat-agent.js";
import { createAllowAllPolicy } from "../ports/policy.js";
import { createIntentRouter } from "../application/intent-router.js";
import { createSessionResolver } from "../application/session-resolver.js";
import type { PromptContextRuntime } from "../../../prompt-context/src/index.js";

export function createChatAgentRuntime(input: {
  config: any;
  activeLLM: any;
  agentLoopRuntime: any;
  llmRequests: any;
  currentChatLLMConfig(): any;
  outputRouter: any;
  toolPlugins: any[];
  promptProfileStore: any;
  time: any;
  getPromptRenderer(): PromptContextRuntime;
  agentState: any;
  getAgentInitiatedBehaviorPlans(): any[];
  initiatedBehaviorRunStore: any;
  loadCurrentLLMSessionTranscript(): any;
  appendLLMRequestLog(input: any, agentId?: "chat" | "talk"): any;
  appendLLMResponseLog(result: any, agentId?: "chat" | "talk", request?: any): void;
  messagingTools: any;
  updateCurrentLLMSessionTranscript(session: any): void;
  clearCurrentLLMSession(reason: any): void;
  resolvePromptApiPreset(agentId: "chat" | "talk" | "memorize"): any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  initialLLMSession: any;
  agentRunIndicator?: any;
  processRestartContinuationStore?: any;
}) {
  return createChatAgent({
    config: input.config,
    llm: input.activeLLM,
    llmRequestSender: input.llmRequests.send,
    flushResponseTranscript: input.llmRequests.flushResponseTranscript,
    agentRunIndicator: input.agentRunIndicator,
    onAgentRunIndicatorError(error) {
      input.appendLog("error", `agent run indicator failed: ${error instanceof Error ? error.message : String(error)}`);
    },
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
    getPromptRenderer: input.getPromptRenderer,
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
      input.messagingTools.noteLLMRequestStarted();
    },
    onLLMSessionUpdated(session) {
      input.updateCurrentLLMSessionTranscript(session);
    },
    onLLMSessionCleared(reason) {
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
      input.llmRequests.resetCancel();
    },
    createLLMSessionId(occurredAt) {
      const sessionId = input.agentLoopRuntime.ensureCurrentLLMSession(occurredAt, "chat").id;
      if (typeof sessionId !== "number" || !Number.isFinite(sessionId)) throw new Error("chat_llm_session_id_invalid");
      return sessionId;
    },
    initialLLMSession: input.initialLLMSession,
    processRestartContinuationStore: input.processRestartContinuationStore
  });
}
