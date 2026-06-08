import { createToolRuntime } from "./tool-runtime.js";
import { createPromptToolPreviewRuntime } from "./prompt-tool-preview-runtime.js";
import { createVoicePluginRuntime } from "./voice-plugin-runtime.js";
import { createLLMRequestsRuntime } from "./llm-requests-runtime.js";

export function createApiCapabilitiesRuntime(input: {
  config: any;
  time: any;
  promptProfileStore: any;
  readLLMApiPresets(): any[];
  store: any;
  outputRouter: any;
  dailyShellStore: any;
  diaryStore: any;
  coreProfileStore: any;
  agentState: any;
  getDefaultTarget(): any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog(input: any): unknown;
  llmLogRuntime: any;
  appendLLMUsageLog(result: any, modelFallback?: string): void;
  recordTokenUsageEvent(event: any): void;
  resolvePromptApiPreset(agentId: "chat" | "talk" | "memorize"): any;
  memoryStore: any;
}) {
  let getLLMRequestToolDefinition: (name: string) => any = () => undefined;
  const llmRequests = createLLMRequestsRuntime({
    getTool: (name) => getLLMRequestToolDefinition(name),
    appendLLMRequestLog: (request, agentId = "chat") => input.llmLogRuntime.appendRequestLog(request, agentId),
    appendLLMResponseLog: (result, agentId = "chat") => input.llmLogRuntime.appendResponseLog(result, agentId),
    appendLLMUsageLog: input.appendLLMUsageLog,
    recordTokenUsageEvent: input.recordTokenUsageEvent,
    time: input.time,
    resolvePromptApiPreset: input.resolvePromptApiPreset,
    appendLog: input.appendLog
  });

  const voicePluginRuntime = createVoicePluginRuntime({
    config: input.config,
    time: input.time,
    promptProfileStore: input.promptProfileStore,
    sendLLMRequest: (request) => llmRequests.send(request),
    readLLMApiPresets: input.readLLMApiPresets,
    appendLog: input.appendLog
  });

  const toolRuntime = createToolRuntime({
    config: input.config,
    store: input.store,
    outputRouter: input.outputRouter,
    time: input.time,
    voiceSynthesizer: voicePluginRuntime.ttsPlugin.voiceSynthesizer,
    promptProfileStore: input.promptProfileStore,
    dailyShellStore: input.dailyShellStore,
    diaryStore: input.diaryStore,
    coreProfileStore: input.coreProfileStore,
    agentState: input.agentState,
    getDefaultTarget: input.getDefaultTarget,
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog
  });

  const promptToolPreviewRuntime = createPromptToolPreviewRuntime({
    time: input.time,
    dailyShellStore: input.dailyShellStore,
    coreProfileStore: input.coreProfileStore,
    memoryStore: input.memoryStore,
    diaryStore: input.diaryStore,
    toolPlugins: toolRuntime.toolPlugins,
    llmRequests,
    messagingTools: toolRuntime.messagingTools
  });
  getLLMRequestToolDefinition = promptToolPreviewRuntime.getLLMRequestToolDefinition;

  return {
    ttsConfigPath: voicePluginRuntime.ttsConfigPath,
    ttsPlugin: voicePluginRuntime.ttsPlugin,
    asrPlugin: voicePluginRuntime.asrPlugin,
    messagingTools: toolRuntime.messagingTools,
    photoConfigPath: toolRuntime.photoConfigPath,
    photoTools: toolRuntime.photoTools,
    shellTools: toolRuntime.shellTools,
    bookcaseTools: toolRuntime.bookcaseTools,
    sleepCocoonTools: toolRuntime.sleepCocoonTools,
    toolPlugins: toolRuntime.toolPlugins,
    llmRequests,
    visibleToolSpecs: promptToolPreviewRuntime.visibleToolSpecs,
    visibleToolNames: promptToolPreviewRuntime.visibleToolNames,
    buildPromptPreviewMessages: promptToolPreviewRuntime.buildPromptPreviewMessages
  };
}
