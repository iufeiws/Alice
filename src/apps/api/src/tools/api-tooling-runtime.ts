import { createApiCapabilitiesRuntime } from "./api-capabilities-runtime.js";
import { createApiSupportRuntime } from "../memory/api-support-runtime.js";

export function createApiToolingRuntime(input: {
  config: any;
  time: any;
  apiContextRuntime: any;
  apiLLMRuntime: any;
  apiRuntimeState: any;
  store: any;
  outputRouter: any;
  agentState: any;
  readLLMApiPresets(): any;
  resolvePromptApiPreset(kind: any): any;
  getDefaultTarget(): any;
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
    coreProfileStore: input.apiContextRuntime.coreProfileStore,
    agentState: input.agentState,
    getDefaultTarget: input.getDefaultTarget,
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
    toolPlugins: apiCapabilitiesRuntime.toolPlugins,
    llmRequests: apiCapabilitiesRuntime.llmRequests,
    visibleToolNames: apiCapabilitiesRuntime.visibleToolNames,
    adminLLMSessionRuntime: apiSupportRuntime.adminLLMSessionRuntime,
    sleepMemoryInductionRuntime: apiSupportRuntime.sleepMemoryInductionRuntime
  };
}
