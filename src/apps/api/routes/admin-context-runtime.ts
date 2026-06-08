import type { AppConfig } from "../../../apps/api/bootstrap/app-config-runtime.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import { runMemoryInductionForMessages } from "../../../contexts/memory/src/memory.js";
import type { AgentInitiatedBehaviorPlan } from "../../../contexts/initiative/src/domain/initiated-behavior.js";
import { createLLMClientFromPreset, type LLMApiPreset } from "../../../contexts/llm-gateway/src/llm-api-profile.js";
import { createApiRequestHandler } from "./admin-routes.js";

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

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
  setAgentInitiatedBehaviorConfig(id: string, patch: {
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
        toolName?: string;
        toolCallId?: string;
        toolArguments?: string;
        thinking?: string;
      }>;
    };
  }): AgentInitiatedBehaviorPlan | undefined;
  initiatedBehaviorRunStore: any;
  memoryStore: any;
  diaryStore: any;
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
  photoTools: any;
  shellTools: any;
  bookcaseTools: any;
  sleepCocoonTools: any;
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
  let memoryInductionActive = false;

  return createApiRequestHandler({
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
    setAgentInitiatedBehaviorConfig: input.setAgentInitiatedBehaviorConfig,
    initiatedBehaviorRunStore: input.initiatedBehaviorRunStore,
    memoryStore: input.memoryStore,
    diaryStore: input.diaryStore,
    memoryInductionPromptStore: input.memoryInductionPromptStore,
    async runMemoryInductionForMessages(messages: any[], windowStartAt: string | undefined, windowEndAt: string, apiPreset?: LLMApiPreset, target?: any, onRound?: any) {
      if (memoryInductionActive || input.sleepMemoryInductionRuntime.isActive()) {
        return {
          ok: false,
          startedAt: input.time.now().iso,
          windowStartAt,
          windowEndAt,
          messageCount: messages.length,
          results: [{
            target: target ?? "persistent",
            ok: false,
            edited: false,
            rounds: 0,
            error: "memory_induction_already_running",
            toolCalls: []
          }]
        };
      }
      memoryInductionActive = true;
      const memoryConfig = apiPreset ? {
        ...input.config.memorySummary,
        baseURL: apiPreset.baseURL,
        apiKey: apiPreset.apiKey,
        model: apiPreset.model,
        temperature: apiPreset.temperature,
        timeoutMs: apiPreset.timeoutMs,
        stream: apiPreset.stream,
        extraParams: apiPreset.extraParams,
        followupExtraParams: apiPreset.followupExtraParams
      } : { ...input.config.memorySummary, enabled: false, apiKey: undefined };
      const memoryLLM = apiPreset ? createLLMClientFromPreset(apiPreset) : undefined;
      const memorySession = target
        ? input.ensureMemoryConsoleSession(windowEndAt, windowStartAt)
        : undefined;
      try {
        return await runMemoryInductionForMessages({
          memoryStore: input.memoryStore,
          promptStore: input.memoryInductionPromptStore,
          messages,
          windowStartAt,
          windowEndAt,
          llm: memoryLLM,
          llmRequestSender: input.llmRequests.send,
          config: memoryConfig,
          nowIso: () => input.time.now().iso,
          timezone: input.time.timeZone,
          userName: input.promptProfileStore.get().userName,
          sessionRoot: input.llmSessionRoot(),
          memorySession,
          onRound,
          log: input.appendLog
        }, target);
      } finally {
        memoryInductionActive = false;
      }
    },
    getDailyShell: input.getDailyShell,
    dailyShellStore: input.dailyShellStore,
    agentState: input.agentState,
    messagingTools: input.messagingTools,
    photoTools: input.photoTools,
    shellTools: input.shellTools,
    bookcaseTools: input.bookcaseTools,
    sleepCocoonTools: input.sleepCocoonTools,
    feishu: input.feishu,
    wechat: input.wechat,
    wechatStateStore: input.wechatStateStore,
    runtime: input.runtimeState,
    pluginConfigs: {
      photo: { configPath: input.photoConfigPath },
      tts: { configPath: input.ttsConfigPath },
      asr: { configPath: "config/plugin/asr/config.json" }
    },
    llmRequestSender: input.llmRequests.send,
    messageRuntime: input.messageRuntime,
    getLLM: input.getLLM,
    time: input.time,
    setTimeZone: input.setTimeZone,
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog
  });
}
