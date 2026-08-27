import { createToolRuntime } from "../../../capabilities/tools/messaging/src/tool-runtime.js";
import { createPromptToolPreviewRuntime } from "../../../contexts/agent-profile/src/application/prompt-tool-preview-runtime.js";
import { createVoicePluginRuntime } from "./voice-plugin-runtime.js";
import { createLLMRequestsRuntime } from "../../../contexts/llm-gateway/src/llm-requests-runtime.js";
import { registerLLMToolLoopTools } from "../../../contexts/llm-gateway/src/llm-tool-loop.js";
import { createOpenAICompatibleClient } from "../../../contexts/llm-gateway/src/index.js";
import { readImageRecognitionConfig, recognizeImageWithPlugin, type ImageRecognitionTarget } from "../../../channels/image-recognition/src/index.js";
import type { PiWorkerRuntime } from "../../../contexts/pi-worker/src/index.js";
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
  shortMemoryStore: any;
  agentState: any;
  getDefaultTarget(): any;
  getGoogleStreetView(): any;
  getWorldWandererStreetViewReferenceImage?(): Promise<string | undefined> | string | undefined;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog(input: any): unknown;
  llmLogRuntime: any;
  appendLLMUsageLog(result: any, modelFallback?: string): void;
  recordTokenUsageEvent(event: any): { id: number } | undefined;
  resolvePromptApiPreset(agentId: "chat" | "talk" | "memorize"): any;
  memoryStore: any;
  randomEventStore: any;
  getApprovalService(): any;
  piWorkerRuntime?: PiWorkerRuntime;
}) {
  let getLLMRequestToolDefinition: (name: string) => any = () => undefined;
  const llmRequests = createLLMRequestsRuntime({
    getTool: (name) => getLLMRequestToolDefinition(name),
    appendLLMRequestLog: (request, agentId, transcriptMessages) => input.llmLogRuntime.appendRequestLog(request, agentId, transcriptMessages),
    appendLLMResponseLog: (result, agentId = "chat", request) => input.llmLogRuntime.appendResponseLog(result, agentId, request),
    appendLLMUsageLog: input.appendLLMUsageLog,
    time: input.time,
    resolvePromptApiPreset: input.resolvePromptApiPreset,
    appendLog: input.appendLog,
    subagentSessionRoot: path.join(input.config.memoryFiles.root, "llm-subagent-sessions.sqlite"),
    agentState: input.agentState
  });

  const voicePluginRuntime = createVoicePluginRuntime({
    config: input.config,
    promptContextRuntime: input.promptContextRuntime,
    sendLLMRequest: (request) => llmRequests.send(request),
    readLLMApiPresets: input.readLLMApiPresets,
    recordTokenUsageEvent: input.recordTokenUsageEvent,
    appendLog: input.appendLog
  });

  const recognizeImage = async (target: ImageRecognitionTarget) => {
    const imageInput = typeof target === "string"
      ? { imageFile: target }
      : { imageFile: Buffer.from(target.data, "base64"), mimeType: target.mimeType };
    const result = await recognizeImageWithPlugin(imageInput, readImageRecognitionConfig(), {
      resolveApiPreset(name) {
        return input.readLLMApiPresets().find((entry: { name?: string }) => entry.name === name);
      },
      createLlmClientFromPreset(preset) {
        if (!preset.baseURL || !preset.apiKey) return undefined;
        return createOpenAICompatibleClient({
          baseURL: preset.baseURL,
          apiKey: preset.apiKey,
          model: preset.model,
          temperature: preset.temperature,
          timeoutMs: preset.timeoutMs,
          useProxy: preset.useProxy === true,
          extraParams: preset.extraParams
        });
      },
      llmRequestSender: (request) => llmRequests.send(request),
      promptRenderer: input.promptContextRuntime,
      appendLog: input.appendLog
    });
    if ("ok" in result) throw new Error(`image recognition failed: ${result.error}`);
    return {
      text: result.text,
      provider: result.provider,
      model: result.model,
      durationMs: result.durationMs,
      requestId: result.requestId
    };
  };

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
    promptContextRuntime: input.promptContextRuntime,
    shortMemoryStore: input.shortMemoryStore,
    randomEventStore: input.randomEventStore,
    getApprovalService: input.getApprovalService,
    agentState: input.agentState,
    getDefaultTarget: input.getDefaultTarget,
    getGoogleStreetView: input.getGoogleStreetView,
    getWorldWandererStreetViewReferenceImage: input.getWorldWandererStreetViewReferenceImage,
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog,
    piWorkerRuntime: input.piWorkerRuntime,
    recognizeImage
  });
  const refreshToolRegistry = () => registerLLMToolLoopTools("default", toolRuntime.toolPlugins);
  refreshToolRegistry();

  const promptToolPreviewRuntime = createPromptToolPreviewRuntime({
    time: input.time,
    getPromptRenderer: () => input.promptContextRuntime,
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
    restartTools: toolRuntime.restartTools,
    photoConfigPath: toolRuntime.photoConfigPath,
    photoTools: toolRuntime.photoTools,
    wardrobeTools: toolRuntime.wardrobeTools,
    bookcaseTools: toolRuntime.bookcaseTools,
    sleepCocoonTools: toolRuntime.sleepCocoonTools,
    calendarTools: toolRuntime.calendarTools,
    bashRuntime: toolRuntime.bashRuntime,
    skillsTools: toolRuntime.skillsTools,
    skillsRegistry: toolRuntime.skillsRegistry,
    skillsLoader: toolRuntime.skillsLoader,
    toolPlugins: toolRuntime.toolPlugins,
    llmRequests,
    recognizeImage,
    visibleToolSpecs: promptToolPreviewRuntime.visibleToolSpecs,
    visibleToolNames: promptToolPreviewRuntime.visibleToolNames,
    buildPromptPreviewMessages: promptToolPreviewRuntime.buildPromptPreviewMessages
    ,refreshToolRegistry
  };
}
