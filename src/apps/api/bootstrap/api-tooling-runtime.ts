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
    memoryStore: input.apiContextRuntime.memoryStore
  });
  const apiSupportRuntime = createApiSupportRuntime({
    config: input.config,
    time: input.time,
    apiContextRuntime: input.apiContextRuntime,
    apiLLMRuntime: input.apiLLMRuntime,
    apiRuntimeState: input.apiRuntimeState,
    store: input.store,
    getDefaultTarget: input.getDefaultTarget,
    resolvePromptApiPreset: input.resolvePromptApiPreset,
    buildPromptPreviewMessages: apiCapabilitiesRuntime.buildPromptPreviewMessages,
    visibleToolSpecs: apiCapabilitiesRuntime.visibleToolSpecs,
    getLLMRequestSender: () => apiCapabilitiesRuntime.llmRequests.send,
    sendMemoryFailureNotice: input.sendMemoryFailureNotice,
    appendLog: input.appendLog
  });

  return {
    apiCapabilitiesRuntime,
    apiSupportRuntime,
    ttsPlugin: apiCapabilitiesRuntime.ttsPlugin,
    asrPlugin: apiCapabilitiesRuntime.asrPlugin,
    messagingTools: apiCapabilitiesRuntime.messagingTools,
    finishAndWaitTools: apiCapabilitiesRuntime.finishAndWaitTools,
    bashRuntime: apiCapabilitiesRuntime.bashRuntime,
    toolPlugins: apiCapabilitiesRuntime.toolPlugins,
    llmRequests: apiCapabilitiesRuntime.llmRequests,
    skillsRegistry: input.apiContextRuntime.skillsRegistry,
    visibleToolNames: apiCapabilitiesRuntime.visibleToolNames,
    adminLLMSessionRuntime: apiSupportRuntime.adminLLMSessionRuntime,
    sleepMemoryInductionRuntime: apiSupportRuntime.sleepMemoryInductionRuntime
  };
}
