import type { AppConfig } from "./app-config-runtime.js";
import type { LLMClient } from "../../../contexts/llm-gateway/src/index.js";
import type { LLMRequestSender } from "../../../contexts/llm-gateway/src/llm-tool-loop.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import type { ToolPlugin } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { TokenUsageQuery } from "../../../platform/storage/src/token-usage-store.js";
import type { DiaryStore } from "../../../platform/storage/src/diary-store.js";
import type { CalendarStore } from "../../../platform/storage/src/calendar-store.js";
import type { StoredConversationMessage } from "../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { AgentBehaviorState, AgentStateController } from "../../../contexts/agent-loop/src/domain/agent-loop-state.js";
import type { CoreProfileStore } from "../../../contexts/agent-profile/src/adapters/json-core-profile-store.js";
import { type MemoryInductionPromptStore, type MemoryRunSummary, type MemoryStore, type MemoryTarget } from "../../../contexts/memory/src/memory.js";
import type { createAdminMemoryRuntime } from "../../../contexts/memory/src/application/admin-memory-runtime.js";
import type { PromptProfileStore } from "../../../contexts/agent-profile/src/application/build-system-prompt.js";
import type { PromptContextRuntime, PromptContextValue } from "../../../contexts/prompt-context/src/index.js";
import {
  type AgentInitiatedBehaviorPlan,
  type AgentInitiatedBehaviorRunStore
} from "../../../contexts/initiative/src/domain/initiated-behavior.js";
import type { DailyShellStore } from "../../../contexts/agent-profile/src/domain/shell.js";
import type { LLMApiPreset } from "../../../contexts/llm-gateway/src/admin-presets.js";
import type { VoiceSynthesizer } from "../../../channels/tts/src/index.js";
import type { AsrPluginConfig, AsrTranscribeError, AsrTranscribeInput, AsrTranscribeResult } from "../../../channels/asr/src/index.js";
import type { ImageRecognitionConfig, ImageRecognitionError, ImageRecognitionInput, ImageRecognitionResult } from "../../../channels/image-recognition/src/index.js";

export type AdminRouteServices = {
  handleApiRoute(request: any, response: any): Promise<void>;
  appendLog(level: "error", message: string): void;
};

export type AdminRoutesContext = {
  services: AdminRouteServices;
};

export type PromptVariableTree = Record<string, PromptContextValue>;

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

export type AdminRuntimeContext = {
  config: AppConfig;
  logs: unknown[];
  messageLogs: unknown[];
  llmRequestLogs: unknown[];
  llmResponseLogs: unknown[];
  getCurrentLLMSession(): unknown;
  getCurrentTalkLLMSession?(): unknown;
  getClearedLLMSessions(): unknown[];
  getTalkLLMSessions?(): unknown[];
  getMemoryLLMSessions(): unknown[];
  getLLMSession(id: string): unknown;
  store: {
    listMessages?(limit: number): unknown[];
    listMessageLogs?(limit: number): unknown[];
    listMessagesByCreatedAtRange?(startAt: string | undefined, endAt: string, limit?: number): any[];
    listMessagesChronological?(limit?: number): StoredConversationMessage[];
  } | undefined;
  getLLMRequestPreview(): unknown | Promise<unknown>;
  getLLMRequestProfilePreview(apiPreset?: LLMApiPreset): unknown | Promise<unknown>;
  getTalkLLMRequestProfilePreview?(apiPreset?: LLMApiPreset): unknown | Promise<unknown>;
  getPromptRenderer(): PromptContextRuntime;
  getPromptVariableTree(): PromptVariableTree;
  getTokenUsageReport(query: TokenUsageQuery): unknown;
  clearLLMChainCache(): void;
  cancelActiveLLMRun(): { ok: true; hadActiveRequest: boolean };
  clearMemoryInductionSession(): void;
  outputRouter: { listChannels(): string[] };
  feishuPairingStore: { list(): Array<{ channelId?: string; userId?: string; sessionId?: string }> };
  coreProfileStore: CoreProfileStore;
  promptProfileStore: PromptProfileStore;
  talkPromptProfileStore: PromptProfileStore;
  getAgentInitiatedBehaviorPlans?: () => AgentInitiatedBehaviorPlan[];
  setAgentInitiatedBehaviorEnabled?: (id: string, enabled: boolean) => AgentInitiatedBehaviorPlan | undefined;
  createAgentInitiatedBehaviorConfig?: (id: string, patch: AgentInitiatedBehaviorConfigPatch) => AgentInitiatedBehaviorPlan | undefined;
  deleteAgentInitiatedBehaviorConfig?: (id: string) => AgentInitiatedBehaviorPlan | undefined;
  setAgentInitiatedBehaviorConfig?: (id: string, patch: AgentInitiatedBehaviorConfigPatch) => AgentInitiatedBehaviorPlan | undefined;
  initiatedBehaviorRunStore?: AgentInitiatedBehaviorRunStore;
  memoryStore: MemoryStore;
  diaryStore: DiaryStore;
  calendarStore: CalendarStore;
  memoryInductionPromptStore: MemoryInductionPromptStore;
  memoryAdminRuntime?: ReturnType<typeof createAdminMemoryRuntime>;
  runMemoryInductionForMessages?(messages: any[], windowStartAt: string | undefined, windowEndAt: string, apiPreset?: LLMApiPreset, target?: MemoryTarget, onRound?: (target: MemoryTarget, rounds: number, status?: string) => void): Promise<MemoryRunSummary>;
  llmSessionRoot?(): string;
  ensureMemoryConsoleSession?(windowEndAt: string, windowStartAt?: string): any;
  getDailyShell(): string;
  dailyShellStore: DailyShellStore;
  agentState: AgentStateController;
  messagingTools: ToolPlugin;
  finishAndWaitTools: ToolPlugin;
  photoTools: ToolPlugin;
  shellTools: ToolPlugin;
  bookcaseTools: ToolPlugin;
  sleepCocoonTools: ToolPlugin;
  calendarTools?: ToolPlugin;
  feishu: {
    start(): Promise<void>;
    stop(): Promise<void>;
    send(output: any): Promise<unknown>;
  };
  wechat: {
    start(): Promise<void>;
    stop(): Promise<void>;
    send(output: any): Promise<unknown>;
  };
  wechatStateStore: {
    listContacts(): Array<{ userId: string; sessionId: string; lastSeenAt: string }>;
    getCredentials(): { botToken: string; baseURL: string; loggedInAt: string } | undefined;
    saveCredentials(credentials: { botToken: string; baseURL: string; loggedInAt: string }): void;
    clearCredentials(): void;
  };
  runtime: { feishuStarted: boolean; wechatStarted: boolean };
  pluginConfigs?: {
    messaging?: {
      configPath?: string;
    };
    photo?: {
      configPath?: string;
    };
    tts?: {
      configPath?: string;
      assetRoot?: string;
      testVoiceSynthesizer?: VoiceSynthesizer;
    };
    asr?: {
      configPath?: string;
      assetRoot?: string;
      testTranscriber?(input: AsrTranscribeInput, config: AsrPluginConfig): Promise<AsrTranscribeResult | AsrTranscribeError> | AsrTranscribeResult | AsrTranscribeError;
    };
    imageRecognition?: {
      configPath?: string;
      assetRoot?: string;
      testRecognizer?(input: ImageRecognitionInput, config: ImageRecognitionConfig): Promise<ImageRecognitionResult | ImageRecognitionError> | ImageRecognitionResult | ImageRecognitionError;
    };
    googleStreetView?: {
      configPath?: string;
    };
    worldWanderer?: {
      configPath?: string;
    };
    bashSandbox?: {
      envPath?: string;
    };
  };
  messageRuntime: {
    pauseHeartbeat(): void;
    resumeHeartbeat(): void;
    processNow(): Promise<void>;
    getStatus(): unknown;
  };
  getLLM(): LLMClient;
  llmRequestSender?: LLMRequestSender;
  time: CurrentTimeProvider;
  setTimeZone(timeZone: string): void;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog(input: {
    direction: "inbound" | "outbound";
    plugin: string;
    kind: string;
    target?: string;
    sessionId?: string;
    status?: string;
    summary: string;
  }): unknown;
};
