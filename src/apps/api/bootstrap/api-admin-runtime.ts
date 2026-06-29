import { createAdminRequestHandlerRuntime } from "./admin-context-runtime.js";
import type { ApiRuntimeState } from "../server/api-lifecycle-runtime.js";

export function createApiAdminRuntime(input: {
  config: any;
  logs: unknown[];
  messageLogs: unknown[];
  llmRequestLogs: unknown[];
  llmResponseLogs: unknown[];
  apiContextRuntime: any;
  adminLLMSessionRuntime: any;
  apiCapabilitiesRuntime: any;
  getActiveMainLLMSession(): any;
  getCurrentLLMSessionSnapshot(): unknown;
  store: any;
  getTokenUsageReport(query: any): unknown;
  chatAgent: any;
  cancelLLMRequest(): boolean;
  setLLMSessionBusy(busy: boolean): void;
  outputRouter: any;
  sleepMemoryInductionRuntime: { isActive(): boolean };
  llmSessionRoot(): string;
  time: any;
  agentState: any;
  feishu: any;
  wechat: any;
  messageRuntime: any;
  getLLM(): any;
  setTimeZone(timeZone: string): void;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog(input: any): unknown;
}) {
  const runtimeState: ApiRuntimeState = { feishuStarted: false, wechatStarted: false };
  const requestHandler = createAdminRequestHandlerRuntime({
    config: input.config,
    logs: input.logs,
    messageLogs: input.messageLogs,
    llmRequestLogs: input.llmRequestLogs,
    llmResponseLogs: input.llmResponseLogs,
    getCurrentLLMSession: () => input.getActiveMainLLMSession()?.agentId === "talk" ? undefined : input.getCurrentLLMSessionSnapshot(),
    getCurrentTalkLLMSession: () => input.getActiveMainLLMSession()?.agentId === "talk" ? input.getCurrentLLMSessionSnapshot() : undefined,
    getClearedLLMSessions: input.adminLLMSessionRuntime.llmSessionListRuntime.getClearedLLMSessions,
    getTalkLLMSessions: input.adminLLMSessionRuntime.llmSessionListRuntime.getTalkLLMSessions,
    getMemoryLLMSessions: input.adminLLMSessionRuntime.llmSessionBrowserRuntime.getMemoryLLMSessions,
    getLLMSession: input.adminLLMSessionRuntime.llmSessionBrowserRuntime.getLLMSession,
    store: input.store,
    getLLMRequestPreview: input.adminLLMSessionRuntime.getLLMRequestPreview,
    getLLMRequestProfilePreview: input.adminLLMSessionRuntime.getLLMRequestProfilePreview,
    getTalkLLMRequestProfilePreview: input.adminLLMSessionRuntime.getTalkLLMRequestProfilePreview,
    getTokenUsageReport: input.getTokenUsageReport,
    clearLLMChainCache: () => input.chatAgent.clearLLMSession("admin_clear"),
    cancelActiveLLMRun: () => {
      const hadActiveRequest = input.cancelLLMRequest();
      input.chatAgent.clearLLMSession("admin_cancel");
      input.setLLMSessionBusy(false);
      input.apiCapabilitiesRuntime.messagingTools.noteLLMSessionCompleted();
      return { ok: true, hadActiveRequest };
    },
    clearMemoryInductionSession: () => input.adminLLMSessionRuntime.memoryConsoleRuntime.clearSession(),
    outputRouter: input.outputRouter,
    feishuPairingStore: input.apiContextRuntime.feishuPairingStore,
    coreProfileStore: input.apiContextRuntime.coreProfileStore,
    promptProfileStore: input.apiContextRuntime.promptProfileStore,
    talkPromptProfileStore: input.apiContextRuntime.talkPromptProfileStore,
    getAgentInitiatedBehaviorPlans: input.apiContextRuntime.getAgentInitiatedBehaviorPlans,
    setAgentInitiatedBehaviorEnabled: input.apiContextRuntime.setAgentInitiatedBehaviorEnabled,
    createAgentInitiatedBehaviorConfig: input.apiContextRuntime.createAgentInitiatedBehaviorConfig,
    deleteAgentInitiatedBehaviorConfig: input.apiContextRuntime.deleteAgentInitiatedBehaviorConfig,
    setAgentInitiatedBehaviorConfig: input.apiContextRuntime.setAgentInitiatedBehaviorConfig,
    initiatedBehaviorRunStore: input.apiContextRuntime.initiatedBehaviorRunStore,
    memoryStore: input.apiContextRuntime.memoryStore,
    diaryStore: input.apiContextRuntime.diaryStore,
    calendarStore: input.apiContextRuntime.calendarStore,
    memoryInductionPromptStore: input.apiContextRuntime.memoryInductionPromptStore,
    sleepMemoryInductionRuntime: input.sleepMemoryInductionRuntime,
    ensureMemoryConsoleSession: (windowEndAt, windowStartAt) => input.adminLLMSessionRuntime.memoryConsoleRuntime.ensureSession(windowEndAt, windowStartAt),
    llmRequests: input.apiCapabilitiesRuntime.llmRequests,
    llmSessionRoot: input.llmSessionRoot,
    time: input.time,
    getDailyShell: () => input.apiContextRuntime.dailyShellStore.render(input.time.now().date, input.time.timeZone),
    dailyShellStore: input.apiContextRuntime.dailyShellStore,
    agentState: input.agentState,
    messagingTools: input.apiCapabilitiesRuntime.messagingTools,
    finishAndWaitTools: input.apiCapabilitiesRuntime.finishAndWaitTools,
    photoTools: input.apiCapabilitiesRuntime.photoTools,
    shellTools: input.apiCapabilitiesRuntime.shellTools,
    bookcaseTools: input.apiCapabilitiesRuntime.bookcaseTools,
    sleepCocoonTools: input.apiCapabilitiesRuntime.sleepCocoonTools,
    calendarTools: input.apiCapabilitiesRuntime.calendarTools,
    feishu: input.feishu,
    wechat: input.wechat,
    wechatStateStore: input.apiContextRuntime.wechatStateStore,
    runtimeState,
    photoConfigPath: input.apiCapabilitiesRuntime.photoConfigPath,
    ttsConfigPath: input.apiCapabilitiesRuntime.ttsConfigPath,
    messageRuntime: input.messageRuntime,
    getLLM: input.getLLM,
    setTimeZone: input.setTimeZone,
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog
  });

  return { runtimeState, requestHandler };
}
