import type { AppConfig } from "./app-config-runtime.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import type { SessionClearResult } from "../../../contexts/llm-session/src/application/session-clear-coordinator.js";
import { createAdminMemoryRuntime } from "../../../contexts/memory/src/application/admin-memory-runtime.js";
import type { AgentInitiatedBehaviorPlan } from "../../../contexts/initiative/src/domain/initiated-behavior.js";
import type { AgentInitiatedBehaviorConfigPatch } from "../../../contexts/initiative/src/adapters/json-initiated-behavior-store.js";
import type { LLMApiPreset } from "../../../contexts/llm-gateway/src/llm-api-profile.js";
import type { ShortMemoryStore } from "../../../contexts/memory/src/short-memory-store.js";
import type { PromptContextRuntime } from "../../../contexts/prompt-context/src/index.js";
import { createAdminRouteServices } from "./admin-api-service.js";
import type { AdminRuntimeContext, PromptVariableTree } from "./admin-route-context.js";
import { createApiRequestHandler } from "../routes/admin-routes.js";

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;
export function createAdminRequestHandlerRuntime(input: {
  config: AppConfig;
  logs: unknown[];
  messageLogs: unknown[];
  llmRequestLogs: unknown[];
  llmResponseLogs: unknown[];
  getCurrentLLMSession(): unknown;
  getCurrentTalkLLMSession(): unknown;
  getClearedLLMSessions(): unknown[];
  getTalkLLMSessions(): unknown[];
  getMemoryLLMSessions(): unknown[];
  getLLMSession(id: string): unknown;
  store: any;
  getLLMRequestPreview(): unknown | Promise<unknown>;
  getLLMRequestProfilePreview(apiPreset?: LLMApiPreset): unknown | Promise<unknown>;
  getTalkLLMRequestProfilePreview(apiPreset?: LLMApiPreset): unknown | Promise<unknown>;
  getPromptRenderer(): PromptContextRuntime;
  getPromptVariableTree(): PromptVariableTree;
  getTokenUsageReport(query: any): unknown;
  clearLLMChainCache(): SessionClearResult | Promise<SessionClearResult>;
  cancelActiveLLMRun(): { ok: true; hadActiveRequest: boolean; cleared: boolean; shortMemoryCaptured: boolean } | Promise<{ ok: true; hadActiveRequest: boolean; cleared: boolean; shortMemoryCaptured: boolean }>;
  clearMemoryInductionSession(): SessionClearResult | Promise<SessionClearResult>;
  outputRouter: any;
  feishuPairingStore: any;
  coreProfileStore: any;
  promptProfileStore: any;
  talkPromptProfileStore: any;
  getAgentInitiatedBehaviorPlans(): any[];
  setAgentInitiatedBehaviorEnabled(id: string, enabled: boolean): AgentInitiatedBehaviorPlan | undefined;
  createAgentInitiatedBehaviorConfig(id: string, patch: AgentInitiatedBehaviorConfigPatch): AgentInitiatedBehaviorPlan | undefined;
  deleteAgentInitiatedBehaviorConfig(id: string): AgentInitiatedBehaviorPlan | undefined;
  setAgentInitiatedBehaviorConfig(id: string, patch: AgentInitiatedBehaviorConfigPatch): AgentInitiatedBehaviorPlan | undefined;
  initiatedBehaviorRunStore: any;
  memoryStore: any;
  diaryStore: any;
  calendarStore: any;
  memoryInductionPromptStore: any;
  shortMemoryStore: Pick<ShortMemoryStore, "listLatest">;
  piWorker?: any;
  sleepMemoryInductionRuntime: { isActive(): boolean };
  ensureMemoryConsoleSession(windowEndAt: string, windowStartAt?: string): any;
  llmRequests: { send(input: any): Promise<any> };
  llmSessionRoot(): string;
  time: CurrentTimeProvider;
  getDailyShell(): string;
  dailyShellStore: any;
  agentState: any;
  messagingTools: any;
  finishAndWaitTools: any;
  restartTools: any;
  photoTools: any;
  wardrobeTools: any;
  bookcaseTools: any;
  sleepCocoonTools: any;
  calendarTools?: any;
  feishu: any;
  wechat: any;
  wechatStateStore: any;
  runtimeState: any;
  photoConfigPath: string;
  ttsConfigPath: string;
  messageRuntime: any;
  getLLM(): any;
  setTimeZone(timeZone: string): void;
  appendLog: AppendLog;
  appendMessageLog(input: any): unknown;
}) {
  const memoryAdminRuntime = createAdminMemoryRuntime({
    config: input.config,
    store: input.store,
    memoryStore: input.memoryStore,
    diaryStore: input.diaryStore,
    memoryInductionPromptStore: input.memoryInductionPromptStore,
    sandbox: input.piWorker,
    promptContextRuntime: input.getPromptRenderer(),
    agentState: input.agentState,
    isHeartbeatPaused: () => Boolean(input.messageRuntime.getStatus?.()?.heartbeatPaused),
    time: input.time,
    llmRequests: input.llmRequests,
    llmSessionRoot: input.llmSessionRoot,
    ensureMemoryConsoleSession: input.ensureMemoryConsoleSession,
    resolveMemorizeApiPreset: () => undefined,
    appendLog: input.appendLog
  });
  const runtimeContext: AdminRuntimeContext = {
    config: input.config,
    logs: input.logs,
    messageLogs: input.messageLogs,
    llmRequestLogs: input.llmRequestLogs,
    llmResponseLogs: input.llmResponseLogs,
    getCurrentLLMSession: input.getCurrentLLMSession,
    getCurrentTalkLLMSession: input.getCurrentTalkLLMSession,
    getClearedLLMSessions: input.getClearedLLMSessions,
    getTalkLLMSessions: input.getTalkLLMSessions,
    getMemoryLLMSessions: input.getMemoryLLMSessions,
    getLLMSession: input.getLLMSession,
    store: input.store,
    getLLMRequestPreview: input.getLLMRequestPreview,
    getLLMRequestProfilePreview: input.getLLMRequestProfilePreview,
    getTalkLLMRequestProfilePreview: input.getTalkLLMRequestProfilePreview,
    getPromptRenderer: input.getPromptRenderer,
    getPromptVariableTree: input.getPromptVariableTree,
    getTokenUsageReport: input.getTokenUsageReport,
    clearLLMChainCache: input.clearLLMChainCache,
    cancelActiveLLMRun: input.cancelActiveLLMRun,
    clearMemoryInductionSession: input.clearMemoryInductionSession,
    outputRouter: input.outputRouter,
    feishuPairingStore: input.feishuPairingStore,
    coreProfileStore: input.coreProfileStore,
    promptProfileStore: input.promptProfileStore,
    talkPromptProfileStore: input.talkPromptProfileStore,
    getAgentInitiatedBehaviorPlans: input.getAgentInitiatedBehaviorPlans,
    setAgentInitiatedBehaviorEnabled: input.setAgentInitiatedBehaviorEnabled,
    createAgentInitiatedBehaviorConfig: input.createAgentInitiatedBehaviorConfig,
    deleteAgentInitiatedBehaviorConfig: input.deleteAgentInitiatedBehaviorConfig,
    setAgentInitiatedBehaviorConfig: input.setAgentInitiatedBehaviorConfig,
    initiatedBehaviorRunStore: input.initiatedBehaviorRunStore,
    memoryStore: input.memoryStore,
    diaryStore: input.diaryStore,
    calendarStore: input.calendarStore,
    memoryInductionPromptStore: input.memoryInductionPromptStore,
    shortMemoryStore: input.shortMemoryStore,
    memorySandbox: input.piWorker,
    piWorker: input.piWorker,
    memoryAdminRuntime,
    getDailyShell: input.getDailyShell,
    dailyShellStore: input.dailyShellStore,
    agentState: input.agentState,
    messagingTools: input.messagingTools,
    finishAndWaitTools: input.finishAndWaitTools,
    restartTools: input.restartTools,
    photoTools: input.photoTools,
    wardrobeTools: input.wardrobeTools,
    bookcaseTools: input.bookcaseTools,
    sleepCocoonTools: input.sleepCocoonTools,
    calendarTools: input.calendarTools,
    feishu: input.feishu,
    wechat: input.wechat,
    wechatStateStore: input.wechatStateStore,
    runtime: input.runtimeState,
    pluginConfigs: {
      photo: { configPath: input.photoConfigPath },
      tts: { configPath: input.ttsConfigPath },
      asr: { configPath: "config/plugin/asr/config.json" },
      googleStreetView: { configPath: "config/plugin/google-streetview/config.json" },
      worldWanderer: { configPath: "config/plugin/world-wanderer/config.json" }
    },
    llmRequestSender: input.llmRequests.send,
    messageRuntime: input.messageRuntime,
    getLLM: input.getLLM,
    time: input.time,
    setTimeZone: input.setTimeZone,
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog
  };

  return createApiRequestHandler({ services: createAdminRouteServices(runtimeContext) });
}
