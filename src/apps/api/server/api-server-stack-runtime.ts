import { createApiLifecycleRuntime } from "./api-lifecycle-runtime.js";
import { createApiAdminRuntime } from "../routes/api-admin-runtime.js";
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
  core: any;
  talkRuntime: any;
  agentState: any;
  sleepCocoonEventRuntime: any;
  llmConfigRuntime: any;
  activeLLM: any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog(input: Omit<StoredMessageLog, "id" | "time" | "timeUtc">): StoredMessageLog;
}) {
  const apiCommunicationRuntime = createApiCommunicationRuntime({
    config: input.config,
    time: input.time,
    asrPlugin: input.apiToolingRuntime.asrPlugin,
    voiceSynthesizer: input.apiToolingRuntime.ttsPlugin.voiceSynthesizer,
    talkRuntime: input.talkRuntime,
    agentLoopRuntime: input.agentLoopRuntime,
    readLLMApiPresets: input.readLLMApiPresets,
    apiContextRuntime: input.apiContextRuntime,
    store: input.store,
    core: input.core,
    agentState: input.agentState,
    outputRouter: input.outputRouter,
    isLLMSessionActive: input.apiRuntimeState.isLLMSessionBusy,
    dailyShellStore: input.apiContextRuntime.dailyShellStore,
    initiatedBehaviorRunStore: input.apiContextRuntime.initiatedBehaviorRunStore,
    getAgentInitiatedBehaviorPlans: input.apiContextRuntime.getAgentInitiatedBehaviorPlans,
    getDefaultMessagingTarget: () => input.apiContextRuntime.defaultTargetResolver.getDefaultMessagingTarget() as any,
    getSleepCocoonGoodnightEvent: () => input.sleepCocoonEventRuntime.maybeBuildGoodnightEvent(),
    getSleepCocoonWakeEvent: () => input.sleepCocoonEventRuntime.consumeMorningEvent(),
    queueForceWakeEvent: () => input.sleepCocoonEventRuntime.queueForceWakeEvent({ sleepCocoonForceWake: true }),
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog
  });
  const apiAdminRuntime = createApiAdminRuntime({
    config: input.config,
    logs: input.logs,
    messageLogs: input.messageLogs,
    llmRequestLogs: input.apiRuntimeState.llmRequestLogs,
    llmResponseLogs: input.apiRuntimeState.llmResponseLogs,
    apiContextRuntime: input.apiContextRuntime,
    adminLLMSessionRuntime: input.apiToolingRuntime.adminLLMSessionRuntime,
    apiCapabilitiesRuntime: input.apiToolingRuntime.apiCapabilitiesRuntime,
    getActiveSession: input.apiRuntimeState.getActiveLLMSession,
    getActiveLLMSessionSnapshot: () => input.apiLLMRuntime.activeLLMSessionRuntime.getActiveLLMSessionSnapshot(),
    store: input.store,
    getTokenUsageReport: input.apiLLMRuntime.getTokenUsageReport,
    core: input.core,
    cancelLLMRequest: () => input.apiToolingRuntime.llmRequests.cancelActive("admin_cancel"),
    setLLMSessionBusy: input.apiRuntimeState.setLLMSessionBusy,
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
    appendMessageLog: input.appendMessageLog
  });
  const apiLifecycleRuntime = createApiLifecycleRuntime({
    config: input.config,
    runtimeState: apiAdminRuntime.runtimeState,
    core: input.core,
    systemLogStore: input.systemLogStore,
    time: input.time,
    ttsPlugin: input.apiToolingRuntime.ttsPlugin,
    messageRuntime: apiCommunicationRuntime.messageRuntime,
    requestHandler: apiAdminRuntime.requestHandler,
    webRtcVoiceRuntime: apiCommunicationRuntime.webRtcVoiceRuntime,
    serviceLock: input.serviceLock,
    appendLog: input.appendLog,
    registerChannels: () => {
      input.core.registerChannel(apiCommunicationRuntime.feishu);
      input.core.registerChannel(apiCommunicationRuntime.wechat);
    }
  });

  return {
    apiCommunicationRuntime,
    apiAdminRuntime,
    apiLifecycleRuntime,
    start: () => apiLifecycleRuntime.start()
  };
}
