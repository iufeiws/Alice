import { createApiCapabilitiesRuntime } from "./api-capabilities-runtime.js";
import { createApiSupportRuntime } from "./api-support-runtime.js";

export function createApiToolingRuntime(input: {
  config: any;
  time: any;
  apiContextRuntime: any;
  apiLLMRuntime: any;
  apiRuntimeState: any;
  agentLoopRuntime: any;
  store: any;
  outputRouter: any;
  agentState: any;
  readLLMApiPresets(): any;
  resolvePromptApiPreset(kind: any): any;
  getDefaultTarget(): any;
  getGoogleStreetView(): any;
  getWorldWandererStreetViewReferenceImage?(): Promise<string | undefined> | string | undefined;
  sendMemoryFailureNotice(): Promise<void>;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog(input: any): unknown;
  sessionClearCoordinator: any;
  getApprovalService(): any;
  piWorkerRuntime?: any;
}) {
  const apiCapabilitiesRuntime = createApiCapabilitiesRuntime({
    config: input.config,
    time: input.time,
    promptProfileStore: input.apiContextRuntime.promptProfileStore,
    readLLMApiPresets: input.readLLMApiPresets,
    store: input.store,
    outputRouter: input.outputRouter,
    dailyShellStore: input.apiContextRuntime.dailyShellStore,
    diaryStore: input.apiContextRuntime.diaryStore,
    calendarStore: input.apiContextRuntime.calendarStore,
    coreProfileStore: input.apiContextRuntime.coreProfileStore,
    skillsRegistry: input.apiContextRuntime.skillsRegistry,
    promptContextRuntime: input.apiContextRuntime.promptContextRuntime,
    agentState: input.agentState,
    getDefaultTarget: input.getDefaultTarget,
    getGoogleStreetView: input.getGoogleStreetView,
    getWorldWandererStreetViewReferenceImage: input.getWorldWandererStreetViewReferenceImage,
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog,
    llmLogRuntime: input.apiLLMRuntime.llmLogRuntime,
    appendLLMUsageLog: input.apiLLMRuntime.appendLLMUsageLog,
    recordTokenUsageEvent: input.apiLLMRuntime.recordTokenUsageEvent,
    resolvePromptApiPreset: input.resolvePromptApiPreset,
    memoryStore: input.apiContextRuntime.memoryStore,
    randomEventStore: input.apiContextRuntime.randomEventStore,
    getApprovalService: input.getApprovalService,
    piWorkerRuntime: input.piWorkerRuntime
  });
  const apiSupportRuntime = createApiSupportRuntime({
    config: input.config,
    time: input.time,
    apiContextRuntime: input.apiContextRuntime,
    apiLLMRuntime: input.apiLLMRuntime,
    apiRuntimeState: input.apiRuntimeState,
    bashRuntime: apiCapabilitiesRuntime.bashRuntime,
    store: input.store,
    getDefaultTarget: input.getDefaultTarget,
    resolvePromptApiPreset: input.resolvePromptApiPreset,
    buildPromptPreviewMessages: apiCapabilitiesRuntime.buildPromptPreviewMessages,
    visibleToolSpecs: apiCapabilitiesRuntime.visibleToolSpecs,
    getLLMRequestSender: () => apiCapabilitiesRuntime.llmRequests.send,
    sendMemoryFailureNotice: input.sendMemoryFailureNotice,
    appendLog: input.appendLog,
    sessionClearCoordinator: input.sessionClearCoordinator,
    // §7.3/§10: Memorize 手工 clear 进入 Main Agent clearing 占用(kind memorize), 与 Chat/Talk 清除互斥。
    acquireMainAgentClear: (clearInput) => input.agentLoopRuntime.beginClearSession(clearInput),
    piWorkerRuntime: input.piWorkerRuntime
  });

  return {
    apiCapabilitiesRuntime,
    apiSupportRuntime,
    ttsPlugin: apiCapabilitiesRuntime.ttsPlugin,
    asrPlugin: apiCapabilitiesRuntime.asrPlugin,
    messagingTools: apiCapabilitiesRuntime.messagingTools,
    finishAndWaitTools: apiCapabilitiesRuntime.finishAndWaitTools,
    restartTools: apiCapabilitiesRuntime.restartTools,
    bashRuntime: apiCapabilitiesRuntime.bashRuntime,
    toolPlugins: apiCapabilitiesRuntime.toolPlugins,
    llmRequests: apiCapabilitiesRuntime.llmRequests,
    recognizeImage: apiCapabilitiesRuntime.recognizeImage,
    skillsRegistry: input.apiContextRuntime.skillsRegistry,
    visibleToolNames: apiCapabilitiesRuntime.visibleToolNames,
    piWorkerRuntime: input.piWorkerRuntime,
    refreshToolRegistry: apiCapabilitiesRuntime.refreshToolRegistry,
    adminLLMSessionRuntime: apiSupportRuntime.adminLLMSessionRuntime,
    sleepMemoryInductionRuntime: apiSupportRuntime.sleepMemoryInductionRuntime
  };
}
