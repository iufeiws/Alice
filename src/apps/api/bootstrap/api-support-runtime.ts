import { createAdminLLMSessionRuntime } from "../../../contexts/llm-session/src/index.js";
import { createSleepMemoryBridgeRuntime } from "../../../contexts/memory/src/sleep-memory-bridge-runtime.js";

export function createApiSupportRuntime(input: {
  config: any;
  time: any;
  apiContextRuntime: any;
  apiLLMRuntime: any;
  apiRuntimeState: any;
  bashRuntime: any;
  store: any;
  getDefaultTarget(): any;
  resolvePromptApiPreset(kind: any): any;
  buildPromptPreviewMessages(profile: any, event: any, includeFakeCheckChat?: boolean): Promise<any>;
  visibleToolSpecs(profile: any): any;
  getLLMRequestSender(): any;
  sendMemoryFailureNotice(): Promise<void>;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  const adminLLMSessionRuntime = createAdminLLMSessionRuntime({
    sessionRoot: input.apiLLMRuntime.llmSessionArchive.root,
    time: input.time,
    archive: input.apiLLMRuntime.llmSessionArchive,
    requestLogs: input.apiRuntimeState.llmRequestLogs,
    getActiveSession: () => input.apiLLMRuntime.llmSessionArchive.readCurrent(),
    listRecentMessages: () => input.store?.listMessages(500) ?? [],
    getPromptProfile: () => input.apiContextRuntime.promptProfileStore.get(),
    getTalkPromptProfile: () => input.apiContextRuntime.talkPromptProfileStore.get(),
    getDefaultTarget: input.getDefaultTarget,
    resolveChatPreset: () => input.resolvePromptApiPreset("chat"),
    buildPromptPreviewMessages: input.buildPromptPreviewMessages,
    visibleToolSpecs: input.visibleToolSpecs
  });
  const sleepMemoryInductionRuntime = createSleepMemoryBridgeRuntime({
    config: input.config,
    memoryStore: input.apiContextRuntime.memoryStore,
    promptStore: input.apiContextRuntime.memoryInductionPromptStore,
    promptContextRuntime: input.apiContextRuntime.promptContextRuntime,
    sandbox: {
      config: input.config.bashSandbox,
      runtime: input.bashRuntime
    },
    stateStore: input.apiContextRuntime.sleepMemoryStateStore,
    diaryStore: input.apiContextRuntime.diaryStore,
    getMessageStore: () => input.store,
    getLLMRequestSender: input.getLLMRequestSender,
    resolveMemoryPreset: () => input.resolvePromptApiPreset("memorize"),
    time: input.time,
    sessionRoot: input.apiLLMRuntime.llmSessionArchive.root,
    sendFailureNotice: input.sendMemoryFailureNotice,
    appendLog: input.appendLog
  });

  return {
    adminLLMSessionRuntime,
    sleepMemoryInductionRuntime
  };
}
