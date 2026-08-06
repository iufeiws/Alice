import { createApiLifecycleRuntime } from "./api-lifecycle-runtime.js";
import { createApiAdminRuntime } from "../bootstrap/api-admin-runtime.js";
import { createApiCommunicationRuntime } from "../bootstrap/api-communication-runtime.js";
import type { StoredMessageLog } from "../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";

export function createApiServerStackRuntime(input: {
  config: any;
  logs: unknown[];
  messageLogs: unknown[];
  systemLogStore: any;
  serviceLock: any;
  time: any;
  apiRuntimeState: any;
  apiContextRuntime: any;
  apiLLMRuntime: any;
  apiToolingRuntime: any;
  agentLoopRuntime: any;
  store: any;
  outputRouter: any;
  readLLMApiPresets(): any;
  chatAgent: any;
  talkRuntime: any;
  agentState: any;
  sleepCocoonEventRuntime: any;
  calendarEventRuntime: any;
  llmConfigRuntime: any;
  activeLLM: any;
  agentRunIndicatorRuntime?: any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog(input: Omit<StoredMessageLog, "id" | "time" | "timeUtc">): StoredMessageLog;
  processRestartContinuationStore?: any;
  piRelay?: any;
  piWorkerRuntime?: any;
}) {
  const apiCommunicationRuntime = createApiCommunicationRuntime({
    config: input.config,
    time: input.time,
    asrPlugin: input.apiToolingRuntime.asrPlugin,
    voiceSynthesizer: input.apiToolingRuntime.ttsPlugin.voiceSynthesizer,
    talkRuntime: input.talkRuntime,
    supportsAudioInput: () => input.llmConfigRuntime.currentTalkLLMConfig().supportsAudio === true,
    agentLoopRuntime: input.agentLoopRuntime,
    readLLMApiPresets: input.readLLMApiPresets,
    apiContextRuntime: input.apiContextRuntime,
    store: input.store,
    chatAgent: input.chatAgent,
    agentState: input.agentState,
    outputRouter: input.outputRouter,
    isLLMSessionActive: () => input.agentLoopRuntime.isRunning(),
    initiatedBehaviorRunStore: input.apiContextRuntime.initiatedBehaviorRunStore,
    getAgentInitiatedBehaviorPlans: input.apiContextRuntime.getAgentInitiatedBehaviorPlans,
    getDefaultMessagingTarget: () => input.apiContextRuntime.defaultTargetResolver.getDefaultMessagingTarget() as any,
    getSleepCocoonGoodnightEvent: () => input.sleepCocoonEventRuntime.maybeBuildGoodnightEvent(),
    getSleepCocoonWakeEvent: () => input.sleepCocoonEventRuntime.consumeMorningEvent(),
    getCalendarReminderEvent: () => input.calendarEventRuntime.consumeDueReminderEvent(),
    queueForceWakeEvent: () => input.sleepCocoonEventRuntime.queueForceWakeEvent({ agentInitiatedTriggerEvent: "sleep_cocoon.force_wake" }),
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog,
    processRestartContinuationStore: input.processRestartContinuationStore,
    recognizeImage: input.apiToolingRuntime.recognizeImage
  });
  input.agentRunIndicatorRuntime?.setDelegate(apiCommunicationRuntime.agentRunIndicator);
  const apiAdminRuntime = createApiAdminRuntime({
    config: input.config,
    logs: input.logs,
    messageLogs: input.messageLogs,
    llmRequestLogs: input.apiRuntimeState.llmRequestLogs,
    llmResponseLogs: input.apiRuntimeState.llmResponseLogs,
    apiContextRuntime: input.apiContextRuntime,
    adminLLMSessionRuntime: input.apiToolingRuntime.adminLLMSessionRuntime,
    apiCapabilitiesRuntime: input.apiToolingRuntime.apiCapabilitiesRuntime,
    getActiveMainLLMSession: () => input.agentLoopRuntime.getActiveMainLLMSession(),
    getCurrentLLMSessionSnapshot: () => input.agentLoopRuntime.getCurrentLLMSessionSnapshot(),
    store: input.store,
    getTokenUsageReport: input.apiLLMRuntime.getTokenUsageReport,
    chatAgent: input.chatAgent,
    cancelLLMRequest: () => input.apiToolingRuntime.llmRequests.cancelActive("admin_cancel"),
    outputRouter: input.outputRouter,
    sleepMemoryInductionRuntime: input.apiToolingRuntime.sleepMemoryInductionRuntime,
    llmSessionRoot: input.apiLLMRuntime.llmSessionArchive.root,
    time: input.time,
    agentState: input.agentState,
    feishu: apiCommunicationRuntime.feishu,
    wechat: apiCommunicationRuntime.wechat,
    messageRuntime: apiCommunicationRuntime.messageRuntime,
    getLLM: () => input.llmConfigRuntime.currentChatLLMConfig().client ?? input.activeLLM,
    setTimeZone: (timeZone) => input.time.setTimeZone(timeZone),
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog,
    piWorkerRuntime: input.piWorkerRuntime
  });
  const apiLifecycleRuntime = createApiLifecycleRuntime({
    config: input.config,
    runtimeState: apiAdminRuntime.runtimeState,
    chatAgent: input.chatAgent,
    systemLogStore: input.systemLogStore,
    time: input.time,
    ttsPlugin: input.apiToolingRuntime.ttsPlugin,
    messageRuntime: apiCommunicationRuntime.messageRuntime,
    requestHandler: apiAdminRuntime.requestHandler,
    webRtcVoiceRuntime: apiCommunicationRuntime.webRtcVoiceRuntime,
    serviceLock: input.serviceLock,
    appendLog: input.appendLog,
    registerChannels: () => {
      input.chatAgent.registerChannel(apiCommunicationRuntime.feishu);
      input.chatAgent.registerChannel(apiCommunicationRuntime.wechat);
    },
    piRelay: input.piRelay,
    piWorkerRuntime: input.piWorkerRuntime,
    refreshToolRegistry: input.apiToolingRuntime.refreshToolRegistry
  });

  return {
    apiCommunicationRuntime,
    apiAdminRuntime,
    apiLifecycleRuntime,
    start: () => apiLifecycleRuntime.start()
  };
}
