import type { AppConfig } from "./app-config-runtime.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import { createAdminMemoryRuntime } from "../../../contexts/memory/src/application/admin-memory-runtime.js";
import type { AgentInitiatedBehaviorPlan } from "../../../contexts/initiative/src/domain/initiated-behavior.js";
import type { LLMApiPreset } from "../../../contexts/llm-gateway/src/llm-api-profile.js";
import { createAdminRouteServices } from "./admin-api-service.js";
import type { AdminRuntimeContext } from "./admin-route-context.js";
import { createApiRequestHandler } from "../routes/admin-routes.js";

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;
type AgentInitiatedBehaviorConfigPatch = {
  enabled?: boolean;
  kind?: AgentInitiatedBehaviorPlan["kind"];
  triggerEvent?: string;
  weight?: number;
  priority?: number;
  promptProfile?: {
    layers: Array<{
      id: string;
      title: string;
      role: "user" | "assistant" | "tool_request";
      enabled: boolean;
      content: string;
      order: number;
      toolCalls?: Array<{
        toolName: string;
        toolCallId?: string;
        toolArguments: string;
      }>;
      thinking?: string;
    }>;
  };
};

export function createAdminRequestHandlerRuntime(input: {
  config: AppConfig;
  logs: unknown[];
  messageLogs: unknown[];
  llmRequestLogs: unknown[];
  llmResponseLogs: unknown[];
  getActiveLLMSession(): unknown;
  getActiveTalkLLMSession(): unknown;
  getClearedLLMSessions(): unknown[];
  getTalkLLMSessions(): unknown[];
  getMemoryLLMSessions(): unknown[];
  getLLMSession(id: string): unknown;
  store: any;
  getLLMRequestPreview(): unknown | Promise<unknown>;
  getLLMRequestProfilePreview(apiPreset?: LLMApiPreset): unknown | Promise<unknown>;
  getTalkLLMRequestProfilePreview(apiPreset?: LLMApiPreset): unknown | Promise<unknown>;
  getTokenUsageReport(query: any): unknown;
  clearLLMChainCache(): void;
  cancelActiveLLMRun(): { ok: true; hadActiveRequest: boolean };
  clearMemoryInductionSession(): void;
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
  photoTools: any;
  shellTools: any;
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
    promptProfileStore: input.promptProfileStore,
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
    getActiveLLMSession: input.getActiveLLMSession,
    getActiveTalkLLMSession: input.getActiveTalkLLMSession,
    getClearedLLMSessions: input.getClearedLLMSessions,
    getTalkLLMSessions: input.getTalkLLMSessions,
    getMemoryLLMSessions: input.getMemoryLLMSessions,
    getLLMSession: input.getLLMSession,
    store: input.store,
    getLLMRequestPreview: input.getLLMRequestPreview,
    getLLMRequestProfilePreview: input.getLLMRequestProfilePreview,
    getTalkLLMRequestProfilePreview: input.getTalkLLMRequestProfilePreview,
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
    memoryAdminRuntime,
    getDailyShell: input.getDailyShell,
    dailyShellStore: input.dailyShellStore,
    agentState: input.agentState,
    messagingTools: input.messagingTools,
    finishAndWaitTools: input.finishAndWaitTools,
    photoTools: input.photoTools,
    shellTools: input.shellTools,
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
