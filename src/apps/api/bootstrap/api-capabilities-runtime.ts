import { createToolRuntime } from "../../../capabilities/tools/messaging/src/tool-runtime.js";
import { createPromptToolPreviewRuntime } from "../../../contexts/agent-profile/src/application/prompt-tool-preview-runtime.js";
import { createVoicePluginRuntime } from "./voice-plugin-runtime.js";
import { createLLMRequestsRuntime } from "../../../contexts/llm-gateway/src/llm-requests-runtime.js";
const path = await import("node:path");

export function createApiCapabilitiesRuntime(input: {
  config: any;
  time: any;
  promptProfileStore: any;
  readLLMApiPresets(): any[];
  store: any;
  outputRouter: any;
  dailyShellStore: any;
  diaryStore: any;
  calendarStore: any;
  coreProfileStore: any;
  skillsRegistry: any;
  promptContextRuntime: any;
  agentState: any;
  getDefaultTarget(): any;
  getGoogleStreetView(): any;
  getWorldWandererStreetViewReferenceImage?(): Promise<string | undefined> | string | undefined;
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
    appendLLMResponseLog: (result, agentId = "chat", request) => input.llmLogRuntime.appendResponseLog(result, agentId, request),
    appendLLMUsageLog: input.appendLLMUsageLog,
    recordTokenUsageEvent: input.recordTokenUsageEvent,
    time: input.time,
    resolvePromptApiPreset: input.resolvePromptApiPreset,
    appendLog: input.appendLog,
    subagentSessionRoot: path.join(input.config.memoryFiles.root, "llm-sessions", "sub_agent")
  });

  const voicePluginRuntime = createVoicePluginRuntime({
    config: input.config,
    time: input.time,
    sendLLMRequest: (request) => llmRequests.send(request),
    readLLMApiPresets: input.readLLMApiPresets,
    recordTokenUsageEvent: input.recordTokenUsageEvent,
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
    calendarStore: input.calendarStore,
    coreProfileStore: input.coreProfileStore,
    skillsRegistry: input.skillsRegistry,
    agentState: input.agentState,
    getDefaultTarget: input.getDefaultTarget,
    getGoogleStreetView: input.getGoogleStreetView,
    getWorldWandererStreetViewReferenceImage: input.getWorldWandererStreetViewReferenceImage,
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog
  });

  const promptToolPreviewRuntime = createPromptToolPreviewRuntime({
    time: input.time,
    getPromptVariables: () => input.promptContextRuntime.getPromptVariables(),
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
    finishAndWaitTools: toolRuntime.finishAndWaitTools,
    photoConfigPath: toolRuntime.photoConfigPath,
    photoTools: toolRuntime.photoTools,
    shellTools: toolRuntime.shellTools,
    bookcaseTools: toolRuntime.bookcaseTools,
    sleepCocoonTools: toolRuntime.sleepCocoonTools,
    calendarTools: toolRuntime.calendarTools,
    bashTools: toolRuntime.bashTools,
    bashRuntime: toolRuntime.bashRuntime,
    skillsTools: toolRuntime.skillsTools,
    skillsRegistry: toolRuntime.skillsRegistry,
    skillsLoader: toolRuntime.skillsLoader,
    toolPlugins: toolRuntime.toolPlugins,
    llmRequests,
    visibleToolSpecs: promptToolPreviewRuntime.visibleToolSpecs,
    visibleToolNames: promptToolPreviewRuntime.visibleToolNames,
    buildPromptPreviewMessages: promptToolPreviewRuntime.buildPromptPreviewMessages
  };
}
