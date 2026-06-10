import type { AppConfig } from "../../../apps/api/bootstrap/app-config-runtime.js";
import { createOpenAICompatibleClient, type LLMClient } from "../../../contexts/llm-gateway/src/index.js";
import type { LLMRequestSender } from "../../../contexts/llm-gateway/src/llm-tool-loop.js";
import { formatZonedIso } from "../../../platform/time/src/index.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import type { ToolPlugin } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { TokenUsageQuery } from "../../../platform/storage/src/token-usage-store.js";
import type { DiaryStore } from "../../../platform/storage/src/diary-store.js";
import type { StoredConversationMessage } from "../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { AgentBehaviorState, AgentStateController } from "../../../contexts/agent-loop/src/domain/agent-loop-state.js";
import type { CoreProfileStore } from "../../../contexts/agent-profile/src/adapters/json-core-profile-store.js";
import { type MemoryInductionPromptStore, type MemoryRunSummary, type MemoryStore, type MemoryTarget } from "../../../contexts/memory/src/memory.js";
import { createAdminMemoryRuntime } from "../../../contexts/memory/src/application/admin-memory-runtime.js";
import { defaultPromptRegistry, promptVariables, type PromptProfile, type PromptProfileStore } from "../../../contexts/agent-profile/src/application/build-system-prompt.js";
import {
  defaultAgentInitiatedBehaviorPlans,
  defaultAgentInitiatedBehaviorPromptProfile,
  isToolVisibleInPromptProfile,
  readAgentInitiatedBehaviorPromptProfile,
  resolveAgentInitiatedBehaviorAvailability,
  type AgentInitiatedBehaviorPlan,
  type AgentInitiatedBehaviorRunStore
} from "../../../contexts/initiative/src/domain/initiated-behavior.js";
import { promptStoragePath } from "../../../contexts/agent-profile/src/adapters/json-prompt-profile-store.js";
import { buildLLMTextVariables, formatToolResultForLLM as renderToolResultForLLM, renderLLMValue, type LLMTextVariables } from "../../../contexts/agent-profile/src/application/llm-text-renderer.js";
import type { DailyShellStore, ShellCategory, ShellOption } from "../../../contexts/agent-profile/src/domain/shell.js";
import { HttpJsonError, assertLoopbackAdminRequest, readJsonBody, readRawBody } from "../middleware/http-utils.js";
import { AssetValidationError, resolveAdminAssetPath } from "./asset-utils.js";
import { updateEnvFile } from "../server/env-file.js";
import { renderAdminHtmlV2 } from "./admin-html.js";
import { handleVoiceCallRoute } from "./voice-call-routes.js";
import { createWeChatILinkClient } from "../../../channels/wechat/src/client.js";
import { formatCheckChatMessages } from "../../../capabilities/tools/messaging/src/index.js";
import { createBailianTtsVoiceSynthesizer, createConfiguredVoiceSynthesizer, createOpenAiApiTtsVoiceSynthesizer, createTtsRemoteAwareVoiceSynthesizer, ttsGenieOverrides, readTtsPluginConfig, translateTtsText, type TtsPluginConfig, type TtsTranslationPreset, type TtsVoiceModelConfig, type VoiceSynthesizer } from "../../../channels/tts/src/index.js";
import { readAsrPluginConfig, transcribeWithAsrPlugin, type AsrPluginConfig, type AsrTranscribeInput, type AsrTranscribeResult, type AsrTranscribeError } from "../../../channels/asr/src/index.js";
import { defaultPhotoPluginConfigPath, publicPhotoPluginConfig, readPhotoPluginConfig, type PhotoPluginConfig, type SelfieGenerationMode } from "../../../capabilities/tools/photo/src/index.js";
import { renderWebRtcVoiceCallPage } from "../../../channels/webrtc-voice/src/index.js";
import QRCode from "qrcode";

const fs = await import("node:fs");
const path = await import("node:path");
const childProcess = await import("node:child_process");
const moduleApi = await import("node:module");
const require = moduleApi.createRequire(import.meta.url);
const maxTtsReferenceDurationSeconds = 20;
const maxTtsReferenceUploadBytes = 15 * 1024 * 1024;
const maxPluginAssetUploadBytes = 100 * 1024 * 1024;
const maxPluginModelAssetUploadBytes = 512 * 1024 * 1024;
const ttsReferenceConvertTimeoutMs = 60_000;

type LLMApiPreset = {
  name: string;
  baseURL: string;
  apiKey?: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  stream: boolean;
  extraParams: Record<string, unknown>;
  followupExtraParams: Record<string, unknown>;
  maxContinuousRounds?: number;
};

type PromptApiProfile = {
  chatPresetName?: string;
  /** @deprecated accepted only for old prompt-api-profile.json/request bodies. */
  corePresetName?: string;
  talkPresetName?: string;
  memorizePresetName?: string;
};

type LLMApiPresetView = Omit<LLMApiPreset, "apiKey"> & { apiKeySet: boolean };

type AdminPluginKind = "channel" | "tool" | "voice" | "asr" | "presentation";
type AdminPluginStatus = "enabled" | "disabled" | "planned" | "external_config" | "missing_config" | "error";
type AdminPluginHealth = "healthy" | "degraded" | "failing" | "unknown";

type AdminPluginSummary = {
  id: string;
  name: string;
  kind: AdminPluginKind;
  status: AdminPluginStatus;
  health: AdminPluginHealth;
  description: string;
  configurable: boolean;
  switchable: boolean;
  configSource?: string;
  lastLoadedAt?: string;
  lastUsedAt?: string;
};

type TtsAdminConfig = {
  enabled: boolean;
  remote?: {
    enabled?: boolean;
    baseURL?: string;
  };
  conversion?: {
    provider?: "genie" | "openai-api" | "bailian";
    genie?: {
      enabled?: boolean;
      baseURL?: string;
    };
    openaiApi?: {
      apiPresetName?: string;
      model?: string;
      voice?: string;
      timeoutMs?: number;
      sampleRate?: number;
      channels?: number;
      extraParamsJson?: string;
    };
    bailian?: {
      endpoint?: string;
      apiKey?: string;
      apiKeyEnv?: string;
      workspaceId?: string;
      userAgent?: string;
      model?: string;
      voice?: string;
      languageType?: string;
      mode?: "server_commit" | "commit";
      responseFormat?: string;
      timeoutMs?: number;
      sampleRate?: number;
      channels?: number;
      extraParamsJson?: string;
    };
  };
  translationPresetName?: string;
  translationEditPresetName?: string;
  newTranslationPresetName?: string;
  translationPresets?: Record<string, {
    translationEnabled?: boolean;
    apiPresetName?: string;
    prompt?: string;
  }>;
  currentTranslation?: {
    translationEnabled?: boolean;
    apiPresetName?: string;
    prompt?: string;
  };
  voice: {
    modelConfigName?: string;
    modelEditPresetName?: string;
    newModelConfigName?: string;
    modelConfigs?: Record<string, {
      language?: "jp" | "zh" | "en";
      speed?: number;
      partSilenceSeconds?: number;
      splitText?: boolean;
    }>;
    currentModel?: {
      language?: "jp" | "zh" | "en";
      speed?: number;
      partSilenceSeconds?: number;
      splitText?: boolean;
      modelDir?: string;
      referenceAudio?: string;
      referenceText?: string;
    };
  };
};

type AdminPluginFieldType = "switch" | "text" | "password" | "number" | "textarea" | "select" | "apiPresetSelect" | "fileUpload" | "folderUpload" | "readonly";

type AdminPluginConfigField = {
  key: string;
  label: string;
  type: AdminPluginFieldType;
  group?: string;
  description?: string;
  assetKey?: string;
  accept?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
};

type AdminPluginRegistryEntry = {
  summary(context: AdminRoutesContext): AdminPluginSummary;
  config?(context: AdminRoutesContext): unknown;
  patch?(context: AdminRoutesContext, patch: Record<string, unknown>): { config: unknown } | { error: string };
  setEnabled?(context: AdminRoutesContext, enabled: boolean): { config: unknown } | { error: string };
  reload?(context: AdminRoutesContext): { config: unknown } | { error: string };
  test?(context: AdminRoutesContext, input: Record<string, unknown>): Promise<{ ok: true; result?: unknown } | { error: string }> | { ok: true; result?: unknown } | { error: string };
  uploadAsset?(context: AdminRoutesContext, assetKey: string, request: any): Promise<{ config: unknown; assetPath: string } | { error: string; statusCode?: number }>;
  configSchema?: {
    groups?: Array<{ key: string; label: string }>;
    fields: AdminPluginConfigField[];
  };
  routePreview?: string[];
  runtimeAccess?: string[];
  testSchema?: {
    input: "text" | "audio";
    label: string;
    buttonLabel: string;
    defaultValue?: string;
  };
};

export type AdminRoutesContext = {
  config: AppConfig;
  logs: unknown[];
  messageLogs: unknown[];
  llmRequestLogs: unknown[];
  llmResponseLogs: unknown[];
  getActiveLLMSession(): unknown;
  getActiveTalkLLMSession?(): unknown;
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
  setAgentInitiatedBehaviorConfig?: (id: string, patch: {
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
  }) => AgentInitiatedBehaviorPlan | undefined;
  initiatedBehaviorRunStore?: AgentInitiatedBehaviorRunStore;
  memoryStore: MemoryStore;
  diaryStore: DiaryStore;
  memoryInductionPromptStore: MemoryInductionPromptStore;
  memoryAdminRuntime?: ReturnType<typeof createAdminMemoryRuntime>;
  runMemoryInductionForMessages?(messages: any[], windowStartAt: string | undefined, windowEndAt: string, apiPreset?: LLMApiPreset, target?: MemoryTarget, onRound?: (target: MemoryTarget, rounds: number, status?: string) => void): Promise<MemoryRunSummary>;
  llmSessionRoot?(): string;
  ensureMemoryConsoleSession?(windowEndAt: string, windowStartAt?: string): any;
  getDailyShell(): string;
  dailyShellStore: DailyShellStore;
  agentState: AgentStateController;
  messagingTools: ToolPlugin;
  photoTools: ToolPlugin;
  shellTools: ToolPlugin;
  bookcaseTools: ToolPlugin;
  sleepCocoonTools: ToolPlugin;
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

const AGENT_STATES: AgentBehaviorState[] = [
  "idle",
  "waiting",
  "calling",
  "away",
  "curious",
  "working",
  "going_to_sleep",
  "sleeping",
  "serious",
  "test"
];

function parseInitiatedBehaviorConfigPatch(body: Record<string, unknown>) {
  const patch: {
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
  } = {};
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") throw new HttpJsonError(400, "enabled_boolean_required");
    patch.enabled = body.enabled;
  }
  if ("kind" in body) {
    if (body.kind !== "event" && body.kind !== "randomized") throw new HttpJsonError(400, "invalid_behavior_kind");
    patch.kind = body.kind;
  }
  if ("triggerEvent" in body) {
    if (typeof body.triggerEvent !== "string") throw new HttpJsonError(400, "trigger_event_string_required");
    patch.triggerEvent = body.triggerEvent;
  }
  if ("weight" in body) {
    if (typeof body.weight !== "number" || !Number.isFinite(body.weight)) throw new HttpJsonError(400, "weight_number_required");
    patch.weight = body.weight;
  }
  if ("priority" in body) {
    if (typeof body.priority !== "number" || !Number.isFinite(body.priority)) throw new HttpJsonError(400, "priority_number_required");
    patch.priority = body.priority;
  }
  if ("promptProfile" in body) {
    const profile = body.promptProfile;
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new HttpJsonError(400, "invalid_prompt_profile");
    const rawLayers = (profile as { layers?: unknown }).layers;
    if (!Array.isArray(rawLayers)) throw new HttpJsonError(400, "prompt_layers_array_required");
    patch.promptProfile = {
      layers: rawLayers.map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpJsonError(400, "invalid_prompt_layer");
        const layer = raw as Record<string, unknown>;
        if (layer.role !== "user" && layer.role !== "assistant" && layer.role !== "tool_request") {
          throw new HttpJsonError(400, "invalid_initiated_behavior_prompt_layer_role");
        }
        const role: "user" | "assistant" | "tool_request" = layer.role;
        const normalized = {
          id: typeof layer.id === "string" && layer.id ? layer.id : `layer_${index + 1}`,
          title: typeof layer.title === "string" ? layer.title : "",
          role,
          enabled: layer.enabled !== false,
          content: typeof layer.content === "string" ? layer.content : "",
          order: typeof layer.order === "number" && Number.isFinite(layer.order) ? layer.order : (index + 1) * 10
        };
        if ((role === "assistant" || role === "tool_request") && typeof layer.thinking === "string") {
          return {
            ...normalized,
            thinking: layer.thinking,
            ...(role === "tool_request" ? {
              toolName: typeof layer.toolName === "string" ? layer.toolName : undefined,
              toolCallId: typeof layer.toolCallId === "string" ? layer.toolCallId : undefined,
              toolArguments: typeof layer.toolArguments === "string" ? layer.toolArguments : "{}"
            } : {})
          };
        }
        if (role === "tool_request") {
          return {
            ...normalized,
            toolName: typeof layer.toolName === "string" ? layer.toolName : undefined,
            toolCallId: typeof layer.toolCallId === "string" ? layer.toolCallId : undefined,
            toolArguments: typeof layer.toolArguments === "string" ? layer.toolArguments : "{}"
          };
        }
        return normalized;
      })
    };
  }
  if (Object.keys(patch).length === 0) throw new HttpJsonError(400, "empty_behavior_patch");
  return patch;
}

function initiatedBehaviorPlanView(context: AdminRoutesContext, plan: AgentInitiatedBehaviorPlan) {
  return {
    ...plan,
    availability: resolveAgentInitiatedBehaviorAvailability(plan, context.promptProfileStore.get(), getAdminToolPlugins(context)),
    promptProfile: plan.promptProfilePath
      ? readAgentInitiatedBehaviorPromptProfile(plan.promptProfilePath) ?? defaultAgentInitiatedBehaviorPromptProfile(plan.id)
      : defaultAgentInitiatedBehaviorPromptProfile(plan.id)
  };
}

export function createApiRequestHandler(context: AdminRoutesContext) {
  return async (request: any, response: any) => {
    try {
      assertLoopbackAdminRequest(request);

      if (request.method === "GET" && request.url === "/admin") {
        writeHtml(response, 200, renderAdminHtmlV2());
        return;
      }

      if (handleVoiceCallRoute(request, response)) {
        return;
      }

      if (request.method === "GET" && request.url === "/plugins/webrtc-voice/call") {
        writeHtml(response, 200, renderWebRtcVoiceCallPage());
        return;
      }

      if (request.method === "GET" && request.url?.startsWith("/admin/assets/shell/")) {
        const assetPath = request.url.slice("/admin/assets/shell/".length).split(/[?#]/, 1)[0];
        serveShellAsset(context, assetPath, response);
        return;
      }

      if (request.method === "GET" && request.url?.startsWith("/admin/assets/tts/")) {
        const assetPath = request.url.slice("/admin/assets/tts/".length).split(/[?#]/, 1)[0];
        serveTtsAsset(context, assetPath, response);
        return;
      }

      if (request.method === "GET" && request.url === "/healthz") {
        writeJson(response, 200, {
          ok: true,
          service: "alice-agent-api",
          llmProvider: "api-preset",
          channels: context.outputRouter.listChannels()
        });
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/config") {
        writeJson(response, 200, getAdminConfig(context));
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/prompts") {
        writeJson(response, 200, {
          prompts: defaultPromptRegistry,
          profile: context.promptProfileStore.get(),
          variables: getPromptVariablePreview(context)
        });
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/prompt-profile") {
        writeJson(response, 200, {
          profile: context.promptProfileStore.get(),
          variables: getPromptVariablePreview(context),
          tools: getVisiblePromptTools(context)
        });
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/talk-prompt-profile") {
        writeJson(response, 200, {
          profile: context.talkPromptProfileStore.get(),
          variables: getPromptVariablePreview(context, context.talkPromptProfileStore),
          tools: getVisiblePromptTools(context, context.talkPromptProfileStore)
        });
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/initiated-behaviors") {
        context.initiatedBehaviorRunStore?.finalizeExpiredResponses(context.time.now().date);
        const plans = context.getAgentInitiatedBehaviorPlans?.() ?? defaultAgentInitiatedBehaviorPlans;
        writeJson(response, 200, {
          plans: plans.map((plan) => initiatedBehaviorPlanView(context, plan)),
          runs: context.initiatedBehaviorRunStore?.list(100) ?? [],
          buckets: context.initiatedBehaviorRunStore?.randomThirtyMinuteBuckets(context.time.now().date) ?? []
        });
        return;
      }

      if (request.method === "PATCH" && request.url.startsWith("/admin/api/initiated-behaviors/")) {
        const id = decodeURIComponent(request.url.slice("/admin/api/initiated-behaviors/".length).split("?")[0] ?? "");
        const body = await readJsonBody(request);
        if (!id) throw new HttpJsonError(400, "behavior_id_required");
        const patch = parseInitiatedBehaviorConfigPatch(body);
        const plan = context.setAgentInitiatedBehaviorConfig?.(id, patch)
          ?? (typeof patch.enabled === "boolean" && Object.keys(patch).length === 1
            ? context.setAgentInitiatedBehaviorEnabled?.(id, patch.enabled)
            : undefined);
        if (!plan) throw new HttpJsonError(404, "behavior_not_found");
        writeJson(response, 200, {
          ok: true,
          plan: initiatedBehaviorPlanView(context, plan)
        });
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/memory/prompts") {
        writeJson(response, 200, {
          prompts: context.memoryInductionPromptStore.get(),
          apiProfile: readPromptApiProfile(context),
          apiPresets: publicLLMApiPresets(readLLMApiPresets(context))
        });
        return;
      }

      if (request.method === "PUT" && request.url === "/admin/api/memory/prompts") {
        const body = await readJsonBody(request);
        const prompts = context.memoryInductionPromptStore.save(body.prompts && typeof body.prompts === "object" ? body.prompts : body);
        context.appendLog("info", "memorize prompts saved");
        writeJson(response, 200, { ok: true, prompts });
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/memory/prompts/preview") {
        const body = await readJsonBody(request);
        const target = requiredString(body.target);
        if (!isMemoryTarget(target)) return writeJson(response, 400, { ok: false, error: "invalid_memory_target" });
        const prompts = body.prompts && typeof body.prompts === "object"
          ? body.prompts as ReturnType<MemoryInductionPromptStore["get"]>
          : undefined;
        writeServiceResult(response, getMemoryAdminRuntime(context).previewPrompts(target, prompts, resolveMemorizeApiPreset(context)));
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/prompt-api-profile") {
        writeJson(response, 200, {
          profile: readPromptApiProfile(context),
          presets: publicLLMApiPresets(readLLMApiPresets(context))
        });
        return;
      }

      if (request.method === "PUT" && request.url === "/admin/api/prompt-api-profile") {
        await savePromptApiProfile(context, request, response);
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/memory") {
        const sleepDays = getMemoryAdminRuntime(context).listSleepDays();
        writeJson(response, 200, {
          files: context.memoryStore.stats(),
          prompts: context.memoryInductionPromptStore.get(),
          sleepDays
        });
        return;
      }

      if (request.method === "GET" && request.url.startsWith("/admin/api/memory/messages")) {
        const url = new URL(request.url, "http://admin.local");
        writeServiceResult(response, getMemoryAdminRuntime(context).listDayMessages(url.searchParams.get("date") || ""));
        return;
      }

      if (request.method === "PUT" && request.url === "/admin/api/memory/file") {
        const body = await readJsonBody(request);
        const target = requiredString(body.target);
        if (!isMemoryTarget(target)) return writeJson(response, 400, { ok: false, error: "invalid_memory_target" });
        writeJson(response, 200, getMemoryAdminRuntime(context).saveFile(target, typeof body.content === "string" ? body.content : ""));
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/memory/run-day") {
        const body = await readJsonBody(request);
        writeServiceResult(response, await getMemoryAdminRuntime(context).runDay(requiredString(body.date), optionalString(body.runId), resolveMemorizeApiPreset(context)));
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/memory/run-target") {
        const body = await readJsonBody(request);
        const target = requiredString(body.target);
        if (!isMemoryTarget(target)) return writeJson(response, 400, { ok: false, error: "invalid_memory_target" });
        writeServiceResult(response, await getMemoryAdminRuntime(context).runTarget(requiredString(body.date), target, optionalString(body.runId), resolveMemorizeApiPreset(context)));
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/memory/clear-session") {
        context.clearMemoryInductionSession();
        context.appendLog("info", "memorize console session clear requested");
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/memory/delete-latest-sql") {
        const body = await readJsonBody(request);
        const target = body.target === undefined ? "yesterdaySummary" : requiredString(body.target);
        if (!isMemoryTarget(target)) return writeJson(response, 400, { ok: false, error: "invalid_memory_target" });
        writeServiceResult(response, getMemoryAdminRuntime(context).deleteLatestSqlRecord(target));
        return;
      }

      if (request.method === "GET" && request.url.startsWith("/admin/api/memory/run-progress")) {
        const url = new URL(request.url, "http://admin.local");
        writeServiceResult(response, getMemoryAdminRuntime(context).getRunProgress(url.searchParams.get("id") || ""));
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/memory/undo-last") {
        writeServiceResult(response, getMemoryAdminRuntime(context).undoLastGitCommit());
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/memory/redo-last") {
        writeServiceResult(response, getMemoryAdminRuntime(context).redoLastGitCommit());
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/tools") {
        writeJson(response, 200, { tools: getAdminTools(context) });
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/tools/preview") {
        await previewToolResult(context, request, response);
        return;
      }

      if (request.method === "PUT" && request.url === "/admin/api/prompt-profile") {
        await savePromptProfile(context, request, response);
        return;
      }

      if (request.method === "PUT" && request.url === "/admin/api/talk-prompt-profile") {
        await saveTalkPromptProfile(context, request, response);
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/shell") {
        writeJson(response, 200, getShellConfig(context));
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/shell-ui/order") {
        writeJson(response, 200, { ok: true, order: readShellUiOrder() });
        return;
      }

      if (request.method === "PUT" && request.url === "/admin/api/shell-ui/order") {
        await saveShellUiOrder(request, response);
        return;
      }

      if (request.method === "PUT" && request.url === "/admin/api/shell-settings") {
        await saveShellSettings(context, request, response);
        return;
      }

      if (request.method === "PUT" && request.url === "/admin/api/shell-option") {
        await saveShellOption(context, request, response);
        return;
      }

      if (request.method === "DELETE" && request.url === "/admin/api/shell-option") {
        await deleteShellOption(context, request, response);
        return;
      }

      if (request.method === "POST" && request.url?.startsWith("/admin/api/shell/outfit-image")) {
        await uploadShellOutfitImage(context, request, response);
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/shell/reroll") {
        context.dailyShellStore.reroll(context.time.now().date, context.time.timeZone);
        context.appendLog("info", "daily shell rerolled");
        writeJson(response, 200, getShellConfig(context));
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/llm-requests") {
        writeJson(response, 200, {
          activeSession: context.getActiveLLMSession(),
          talkActiveSession: context.getActiveTalkLLMSession?.(),
          clearedSessions: context.getClearedLLMSessions(),
          talkSessions: context.getTalkLLMSessions?.() ?? [],
          memorySessions: context.getMemoryLLMSessions(),
          profilePreview: await context.getLLMRequestProfilePreview(resolvePromptApiPreset(context, "chat")),
          talkProfilePreview: await context.getTalkLLMRequestProfilePreview?.(resolvePromptApiPreset(context, "talk")),
          messagePreview: await context.getLLMRequestPreview(),
          actual: context.llmRequestLogs[context.llmRequestLogs.length - 1]
        });
        return;
      }

      if (request.method === "GET" && request.url?.startsWith("/admin/api/llm-chain/session")) {
        const url = new URL(request.url, "http://localhost");
        const id = url.searchParams.get("id") ?? "";
        if (!id) {
          writeJson(response, 400, { ok: false, error: "invalid_session_id" });
          return;
        }
        writeJson(response, 200, { session: context.getLLMSession(id) });
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/llm-responses") {
        writeJson(response, 200, { responses: context.llmResponseLogs });
        return;
      }

      if (request.method === "GET" && request.url?.startsWith("/admin/api/token-usage")) {
        writeJson(response, 200, getTokenUsagePayload(context, request.url));
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/llm-chain/clear") {
        context.clearLLMChainCache();
        context.appendLog("info", "llm active session clear requested");
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/llm-run/cancel") {
        const result = context.cancelActiveLLMRun();
        context.appendLog("warn", `llm run cancel requested: active_request=${result.hadActiveRequest}`);
        writeJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/logs") {
        writeJson(response, 200, { logs: context.logs });
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/message-logs") {
        writeJson(response, 200, { logs: context.store?.listMessages?.(500) ?? context.messageLogs });
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/message-event-logs") {
        writeJson(response, 200, { logs: context.store?.listMessageLogs?.(500) ?? context.messageLogs });
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/agent-state") {
        writeJson(response, 200, { state: context.agentState.getSnapshot(), states: AGENT_STATES });
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/tts/reference-audio") {
        await uploadTtsReferenceAudio(context, request, response);
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/tts/generate") {
        await generateTtsPreview(context, request, response);
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/runtime/status") {
        writeJson(response, 200, {
          feishu: getFeishuRuntimeStatus(context),
          wechat: getWeChatRuntimeStatus(context),
          messages: context.messageRuntime.getStatus()
        });
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/plugins/feishu/pairings") {
        writeJson(response, 200, { contacts: context.feishuPairingStore.list() });
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/plugins/wechat/contacts") {
        writeJson(response, 200, { contacts: context.wechatStateStore.listContacts() });
        return;
      }

      if (await handleAdminPluginApi(context, request, response)) {
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/tools/messaging/view") {
        await executeMessagingTool(context, request, response, "check_chat", "feishu");
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/tools/messaging/search") {
        await executeMessagingTool(context, request, response, "search_messages", "feishu");
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/tools/messaging/send") {
        await executeMessagingTool(context, request, response, "send_chat", "feishu");
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/tools/messaging/wechat-view") {
        await executeMessagingTool(context, request, response, "check_chat", "wechat");
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/tools/messaging/wechat-search") {
        await executeMessagingTool(context, request, response, "search_messages", "wechat");
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/tools/messaging/wechat-send") {
        await executeMessagingTool(context, request, response, "send_chat", "wechat");
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/plugins/feishu/test-markdown") {
        await sendFeishuTest(context, request, response, "markdown");
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/plugins/feishu/test-image") {
        await sendFeishuTest(context, request, response, "image");
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/plugins/feishu/test-audio") {
        await sendFeishuTest(context, request, response, "audio");
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/config/llm-presets") {
        const active = resolvePromptApiPreset(context, "chat");
        writeJson(response, 200, {
          presets: publicLLMApiPresets(readLLMApiPresets(context)),
          active: active ? publicLLMApiPreset(active) : undefined,
          activeName: active?.name
        });
        return;
      }

      if (request.method === "PUT" && request.url === "/admin/api/config/llm-presets") {
        await saveLLMApiPreset(context, request, response);
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/config/llm-presets/rename") {
        await renameLLMApiPreset(context, request, response);
        return;
      }

      if (request.method === "DELETE" && request.url === "/admin/api/config/llm-presets") {
        await deleteLLMApiPreset(context, request, response);
        return;
      }

      if (request.method === "PUT" && request.url === "/admin/api/config/feishu") {
        await saveFeishuConfig(context, request, response);
        return;
      }

      if (request.method === "PUT" && request.url === "/admin/api/config/wechat") {
        await saveWeChatConfig(context, request, response);
        return;
      }

      if (request.method === "PUT" && request.url === "/admin/api/config/agent") {
        await saveAgentConfig(context, request, response);
        return;
      }

      if (request.method === "PUT" && request.url === "/admin/api/core-profile") {
        await saveCoreProfile(context, request, response);
        return;
      }

      if (request.method === "PUT" && request.url === "/admin/api/agent-state") {
        await saveAgentState(context, request, response);
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/runtime/heartbeat/pause") {
        context.messageRuntime.pauseHeartbeat();
        writeJson(response, 200, { ok: true, status: context.messageRuntime.getStatus() });
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/runtime/heartbeat/resume") {
        context.messageRuntime.resumeHeartbeat();
        writeJson(response, 200, { ok: true, status: context.messageRuntime.getStatus() });
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/runtime/process-now") {
        await context.messageRuntime.processNow();
        writeJson(response, 200, { ok: true, status: context.messageRuntime.getStatus() });
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/plugins/feishu/start") {
        await startFeishu(context, response);
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/plugins/feishu/stop") {
        await stopFeishu(context, response);
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/plugins/feishu/status") {
        writeJson(response, 200, getFeishuRuntimeStatus(context));
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/plugins/wechat/start") {
        await startWeChat(context, response);
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/plugins/wechat/login/qrcode") {
        await getWeChatLoginQRCode(context, response);
        return;
      }

      if (request.method === "GET" && request.url?.startsWith("/admin/api/plugins/wechat/login/status")) {
        await getWeChatLoginStatus(context, request, response);
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/plugins/wechat/stop") {
        await stopWeChat(context, response);
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/plugins/wechat/status") {
        writeJson(response, 200, getWeChatRuntimeStatus(context));
        return;
      }

      if (request.method === "GET" && request.url === "/v1/models") {
        const llm = context.getLLM();
        const models = llm.listModels ? await llm.listModels() : [];
        writeJson(response, 200, { object: "list", data: models });
        return;
      }

      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      handleHttpError(context, response, error);
    }
  };
}

async function handleAdminPluginApi(context: AdminRoutesContext, request: any, response: any): Promise<boolean> {
  if (!request.url?.startsWith("/admin/api/plugins")) return false;
  const url = new URL(request.url, "http://admin.local");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "admin" || parts[1] !== "api" || parts[2] !== "plugins") return false;

  if (request.method === "GET" && parts.length === 3) {
    writeJson(response, 200, { plugins: listAdminPlugins(context) });
    return true;
  }

  const pluginId = normalizeAdminPluginId(parts[3]);
  const action = parts[4];
  if (!pluginId || !action) return false;

  if (request.method === "POST" && action === "assets" && parts.length === 6) {
    await uploadAdminPluginAsset(context, request, response, pluginId, parts[5]);
    return true;
  }

  if (parts.length !== 5) return false;

  if (request.method === "GET" && action === "config") {
    writeAdminPluginConfig(context, response, pluginId);
    return true;
  }
  if (request.method === "PATCH" && action === "config") {
    await patchAdminPluginConfig(context, request, response, pluginId);
    return true;
  }
  if (request.method === "POST" && action === "enable") {
    await setAdminPluginEnabled(context, response, pluginId, true);
    return true;
  }
  if (request.method === "POST" && action === "disable") {
    await setAdminPluginEnabled(context, response, pluginId, false);
    return true;
  }
  if (request.method === "POST" && action === "reload") {
    reloadAdminPlugin(context, response, pluginId);
    return true;
  }
  if (request.method === "POST" && action === "test") {
    await testAdminPlugin(context, request, response, pluginId);
    return true;
  }
  if (request.method === "GET" && action === "events") {
    writeAdminPluginEvents(context, response, pluginId);
    return true;
  }

  return false;
}

function listAdminPlugins(context: AdminRoutesContext): AdminPluginSummary[] {
  return adminPluginRegistry(context).map((entry) => entry.summary(context));
}

function findAdminPlugin(context: AdminRoutesContext, pluginId: string): AdminPluginSummary | undefined {
  return findAdminPluginEntry(context, normalizeAdminPluginId(pluginId))?.summary(context);
}

function findAdminPluginEntry(context: AdminRoutesContext, pluginId: string): AdminPluginRegistryEntry | undefined {
  const normalizedPluginId = normalizeAdminPluginId(pluginId);
  return adminPluginRegistry(context).find((entry) => entry.summary(context).id === normalizedPluginId);
}

function normalizeAdminPluginId(pluginId: string): string {
  return pluginId;
}

function adminPluginRegistry(_context: AdminRoutesContext): AdminPluginRegistryEntry[] {
  return [
    asrPluginEntry(),
    ttsPluginEntry(),
    photoPluginEntry(),
    feishuPluginEntry(),
    wechatPluginEntry()
  ];
}

function writeAdminPluginConfig(context: AdminRoutesContext, response: any, pluginId: string): void {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!plugin.configurable || !entry?.config) {
    writeJson(response, 400, { ok: false, error: "plugin_not_configurable" });
    return;
  }
  writeJson(response, 200, adminPluginConfigPayload(context, entry));
}

async function patchAdminPluginConfig(context: AdminRoutesContext, request: any, response: any, pluginId: string): Promise<void> {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!plugin.configurable || !entry?.patch) {
    writeJson(response, 400, { ok: false, error: "plugin_not_configurable" });
    return;
  }
  const body = await readJsonBody(request);
  const result = entry.patch(context, body);
  if ("error" in result) {
    writeJson(response, 400, { ok: false, error: result.error });
    return;
  }
  context.appendLog("info", `plugin ${plugin.id} config saved`);
  writeJson(response, 200, {
    ok: true,
    plugin: entry.summary(context),
    configValue: result.config
  });
}

async function setAdminPluginEnabled(context: AdminRoutesContext, response: any, pluginId: string, enabled: boolean): Promise<void> {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!plugin.switchable || !entry?.setEnabled) {
    writeJson(response, 400, { ok: false, error: "plugin_not_switchable" });
    return;
  }
  const result = entry.setEnabled(context, enabled);
  if ("error" in result) {
    writeJson(response, 400, { ok: false, error: result.error });
    return;
  }
  context.appendLog("info", `plugin ${plugin.id} ${enabled ? "enabled" : "disabled"}`);
  writeJson(response, 200, {
    ok: true,
    plugin: entry.summary(context),
    configValue: result.config
  });
}

function reloadAdminPlugin(context: AdminRoutesContext, response: any, pluginId: string): void {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!plugin.configurable || !entry?.reload) {
    writeJson(response, 400, { ok: false, error: "plugin_not_configurable" });
    return;
  }
  const result = entry.reload(context);
  if ("error" in result) {
    writeJson(response, 400, { ok: false, error: result.error });
    return;
  }
  context.appendLog("info", `plugin ${plugin.id} config reloaded`);
  writeJson(response, 200, {
    ok: true,
    plugin: entry.summary(context),
    configValue: result.config
  });
}

async function testAdminPlugin(context: AdminRoutesContext, request: any, response: any, pluginId: string): Promise<void> {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!entry?.test) {
    writeJson(response, 400, { ok: false, error: "plugin_test_unavailable" });
    return;
  }
  const body = await readJsonBody(request);
  const result = await entry.test(context, body);
  writeJson(response, "error" in result ? 400 : 200, "error" in result ? { ok: false, error: result.error } : result);
}

function writeAdminPluginEvents(context: AdminRoutesContext, response: any, pluginId: string): void {
  const plugin = findAdminPlugin(context, pluginId);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  writeJson(response, 200, { events: listAdminPluginEvents(context, pluginId) });
}

async function uploadAdminPluginAsset(context: AdminRoutesContext, request: any, response: any, pluginId: string, assetKey: string): Promise<void> {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!entry?.uploadAsset) {
    writeJson(response, 400, { ok: false, error: "plugin_not_configurable" });
    return;
  }
  const result = await entry.uploadAsset(context, assetKey, request);
  if ("error" in result) {
    writeJson(response, result.statusCode ?? 400, { ok: false, error: result.error });
    return;
  }
  context.appendLog("info", `plugin ${plugin.id} asset uploaded: ${assetKey} -> ${result.assetPath}`);
  writeJson(response, 200, {
    ok: true,
    plugin: entry.summary(context),
    assetPath: result.assetPath,
    configValue: result.config
  });
}

function adminPluginConfigPayload(context: AdminRoutesContext, entry: AdminPluginRegistryEntry): unknown {
  const plugin = entry.summary(context);
  const configValue = entry.config?.(context) ?? {};
  const configSchema = withDynamicPluginConfigSchema(plugin.id, entry.configSchema ?? { fields: [] }, configValue);
  return {
    plugin: {
      ...plugin,
      version: "local"
    },
    configSchema,
    configValue,
    apiPresets: publicLLMApiPresets(readLLMApiPresets(context)),
    routePreview: entry.routePreview ?? [],
    runtimeAccess: entry.runtimeAccess ?? [],
    testSchema: entry.testSchema
  };
}

function withDynamicPluginConfigSchema(pluginId: string, schema: NonNullable<AdminPluginRegistryEntry["configSchema"]>, configValue: unknown): NonNullable<AdminPluginRegistryEntry["configSchema"]> {
  if (pluginId !== "tts") return schema;
  const config = configValue as TtsAdminConfig;
  const translationNames = Object.keys(config.translationPresets ?? {});
  const modelNames = Object.keys(config.voice.modelConfigs ?? {});
  return {
    ...schema,
    fields: schema.fields.map((field) => field.key === "translationPresetName" || field.key === "translationEditPresetName"
      ? {
        ...field,
        options: translationNames.map((name) => ({ value: name, label: name }))
      }
      : field.key === "voice.modelConfigName" || field.key === "voice.modelEditPresetName"
      ? {
        ...field,
        options: modelNames.map((name) => ({ value: name, label: name }))
      }
      : field)
  };
}

function photoPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return photoPluginSummary(context);
    },
    config(context) {
      return publicPhotoPluginConfig(readPhotoConfigForAdmin(context));
    },
    patch(context, patch) {
      const result = updatePhotoConfig(context, patch);
      return "error" in result ? result : { config: publicPhotoPluginConfig(result.config) };
    },
    setEnabled(context, enabled) {
      const result = updatePhotoConfig(context, { enabled });
      return "error" in result ? result : { config: publicPhotoPluginConfig(result.config) };
    },
    reload(context) {
      return { config: publicPhotoPluginConfig(readPhotoConfigForAdmin(context)) };
    },
    configSchema: {
      groups: [
        { key: "general", label: "General" },
        { key: "api", label: "Image API" },
        { key: "codex", label: "Codex" },
        { key: "storage", label: "Storage" }
      ],
      fields: [
        { key: "enabled", label: "Enabled", type: "switch", group: "general", description: "Enable or disable the selfie tool route." },
        { key: "selfieMode", label: "Selfie Mode", type: "select", group: "general", options: [
          { value: "api", label: "API" },
          { value: "codex", label: "Codex" }
        ], description: "API uses the fast Image API runner. Codex uses the Codex CLI image path." },
        { key: "selfieImageApiKeySet", label: "API Key", type: "readonly", group: "api", description: "Read from SELFIE_IMAGE_API_KEY or OPENAI_API_KEY; not stored in plugin config." },
        { key: "selfieImageApiBaseURL", label: "API Base URL", type: "text", group: "api" },
        { key: "selfieImageApiModel", label: "API Model", type: "text", group: "api" },
        { key: "selfieImageApiSize", label: "API Size", type: "text", group: "api" },
        { key: "selfieImageApiQuality", label: "API Quality", type: "text", group: "api" },
        { key: "selfieImageApiOutputFormat", label: "Output Format", type: "select", group: "api", options: [
          { value: "jpeg", label: "jpeg" },
          { value: "png", label: "png" },
          { value: "webp", label: "webp" }
        ] },
        { key: "selfieImageApiOutputCompression", label: "Output Compression", type: "number", group: "api", min: 0, max: 100, step: 1 },
        { key: "selfieImageApiTimeoutMs", label: "API Timeout Ms", type: "number", group: "api", min: 1000, max: 600000, step: 1000 },
        { key: "selfieCodexCommand", label: "Codex Command", type: "text", group: "codex" },
        { key: "selfieCodexTimeoutMs", label: "Codex Timeout Ms", type: "number", group: "codex", min: 1000, max: 600000, step: 1000 },
        { key: "selfieReferenceDir", label: "Reference Folder", type: "text", group: "storage" },
        { key: "selfieOutputDir", label: "Output Folder", type: "text", group: "storage", description: "Must stay under assets/ so generated images can be routed as assets." },
        { key: "selfieMaxBytes", label: "Max Image Bytes", type: "number", group: "storage", min: 1024, max: 52428800, step: 1024 }
      ]
    },
    routePreview: [
      "selfie tool call",
      "photo plugin config",
      "Image API fast runner or Codex CLI",
      "channel.image.send"
    ],
    runtimeAccess: [
      "read selfie prompt template and reference images",
      "call selected Image API or local Codex CLI",
      "write generated image under assets/generated/selfies",
      "send generated image to the current messaging session"
    ]
  };
}

function asrPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return asrPluginSummary(context);
    },
    config(context) {
      return publicAsrConfig(readAsrConfigForAdmin(context));
    },
    patch(context, patch) {
      const result = updateAsrConfig(context, patch);
      return "error" in result ? result : { config: publicAsrConfig(result.config) };
    },
    setEnabled(context, enabled) {
      const result = updateAsrConfig(context, { enabled });
      return "error" in result ? result : { config: publicAsrConfig(result.config) };
    },
    reload(context) {
      return { config: publicAsrConfig(readAsrConfigForAdmin(context)) };
    },
    test(context, input) {
      return testAsrPlugin(context, input);
    },
    uploadAsset(context, assetKey, request) {
      return uploadAsrPluginAsset(context, assetKey, request);
    },
    configSchema: {
      groups: [
        { key: "general", label: "General" },
        { key: "openai_compatible", label: "OpenAI Compatible" },
        { key: "tencent", label: "Tencent Cloud" }
      ],
      fields: [
        { key: "enabled", label: "Enabled", type: "switch", group: "general", description: "Enable or disable ASR requests." },
        { key: "defaultProvider", label: "Default Provider", type: "select", group: "general", options: [
          { value: "openai_compatible", label: "OpenAI Compatible" },
          { value: "tencent", label: "Tencent Cloud" }
        ], description: "Provider used when callers do not explicitly choose one." },
        { key: "testAudioPath", label: "Test Audio", type: "fileUpload", group: "general", assetKey: "test-audio", accept: "audio/*", description: "Plugin-owned test audio under assets/plugin/asr/test-audio/." },
        { key: "pseudoStreamMinPauseMs", label: "Pseudo Stream Pause Ms", type: "number", group: "general", min: 500, max: 10000, step: 100, description: "Conservative pause threshold for pseudo streaming. Default is 1500 ms." },
        { key: "providers.openaiCompatible.apiPresetName", label: "OpenAI-Compatible Preset", type: "apiPresetSelect", group: "openai_compatible", description: "Preset for OpenAI or SiliconFlow compatible ASR. The plugin stores only the preset name." },
        { key: "providers.openaiCompatible.responseFormat", label: "Response Format", type: "select", group: "openai_compatible", options: [
          { value: "json", label: "json" },
          { value: "text", label: "text" },
          { value: "verbose_json", label: "verbose_json" }
        ] },
        { key: "providers.openaiCompatible.retryCount", label: "OpenAI Retry Count", type: "number", group: "openai_compatible", min: 0, max: 5, step: 1, description: "Retries for timeout or transient provider failures. Default is 1." },
        { key: "providers.openaiCompatible.retryBackoffMs", label: "OpenAI Retry Backoff Ms", type: "number", group: "openai_compatible", min: 0, max: 30000, step: 100, description: "Base retry backoff in milliseconds. Default is 500." },
        { key: "providers.tencent.appId", label: "Tencent AppID", type: "text", group: "tencent", description: "Tencent Cloud AppID used by native real-time WebSocket ASR. Omit to use pseudo streaming." },
        { key: "providers.tencent.secretId", label: "Tencent SecretId", type: "text", group: "tencent", description: "Tencent Cloud SecretId from the CAM API key pair." },
        { key: "providers.tencent.secretKey", label: "Tencent SecretKey", type: "text", group: "tencent", description: "Tencent Cloud SecretKey used to sign ASR requests." },
        { key: "providers.tencent.endpoint", label: "Tencent Endpoint", type: "text", group: "tencent", description: "Defaults to https://asr.tencentcloudapi.com when omitted." },
        { key: "providers.tencent.region", label: "Tencent Region", type: "text", group: "tencent", description: "Defaults to ap-guangzhou when omitted." },
        { key: "providers.tencent.engineModelType", label: "Tencent Engine", type: "text", group: "tencent", description: "EngineModelType, for example 16k_zh." },
        { key: "providers.tencent.realtimeVoiceFormat", label: "Tencent Realtime Format", type: "number", group: "tencent", min: 1, max: 16, step: 1, description: "Tencent real-time voice_format. Defaults from MIME/filename; wav is 12, pcm is 1, opus is 10." },
        { key: "providers.tencent.realtimeNeedVad", label: "Tencent Realtime VAD", type: "number", group: "tencent", min: 0, max: 1, step: 1, description: "Tencent real-time needvad. 1 enables VAD, 0 disables it. Default is 1." },
        { key: "providers.tencent.pollIntervalMs", label: "Tencent Poll Ms", type: "number", group: "tencent", min: 100, max: 10000, step: 100 },
        { key: "providers.tencent.timeoutMs", label: "Tencent Timeout Ms", type: "number", group: "tencent", min: 1000, max: 600000, step: 1000 },
        { key: "providers.tencent.retryCount", label: "Tencent Retry Count", type: "number", group: "tencent", min: 0, max: 5, step: 1, description: "Retries CreateRecTask and DescribeTaskStatus timeout or transient failures. Default is 1." },
        { key: "providers.tencent.retryBackoffMs", label: "Tencent Retry Backoff Ms", type: "number", group: "tencent", min: 0, max: 30000, step: 100, description: "Base retry backoff in milliseconds. Default is 500." },
        { key: "providers.tencent.maxChunkBytes", label: "Tencent Max Chunk Bytes", type: "number", group: "tencent", min: 100000, max: 5242880, step: 100000, description: "Tencent local upload chunk limit. Default and maximum are 5242880 bytes." },
        { key: "providers.tencent.splitSilenceThresholdDb", label: "Split Silence dB", type: "number", group: "tencent", min: -80, max: -10, step: 1, description: "Silence threshold for ffmpeg silencedetect. Default is -35 dB." },
        { key: "providers.tencent.splitMinSilenceMs", label: "Split Min Silence Ms", type: "number", group: "tencent", min: 100, max: 5000, step: 100, description: "Minimum silence duration used as preferred split point. Default is 700 ms." }
      ]
    },
    routePreview: [
      "audio file",
      "plugin.asr.transcribe",
      "selected provider",
      "normalized text result"
    ],
    runtimeAccess: [
      "read uploaded or caller-provided audio file",
      "call selected API preset",
      "return normalized transcription text",
      "do not persist transcription text by default"
    ],
    testSchema: {
      input: "audio",
      label: "Audio",
      buttonLabel: "Test transcription"
    }
  };
}

function ttsPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return ttsPluginSummary(context);
    },
    config(context) {
      return publicTtsConfig(readTtsConfigForAdmin(context));
    },
    patch(context, patch) {
      const result = updateTtsConfig(context, patch);
      return "error" in result ? result : { config: publicTtsConfig(result.config) };
    },
    setEnabled(context, enabled) {
      const result = updateTtsConfig(context, { enabled });
      return "error" in result ? result : { config: publicTtsConfig(result.config) };
    },
    reload(context) {
      return { config: publicTtsConfig(readTtsConfigForAdmin(context)) };
    },
    test(context, input) {
      return testTtsPlugin(context, input);
    },
    uploadAsset(context, assetKey, request) {
      return uploadGenericPluginAsset(context, "tts", assetKey, request);
    },
    configSchema: {
      groups: [
        { key: "translation", label: "Translation Presets" },
        { key: "model_genie", label: "Model / Conversion / Genie" },
        { key: "conversion_openai_api", label: "Conversion / OpenAI-API" },
        { key: "conversion_bailian", label: "Conversion / Bailian" },
        { key: "general", label: "Common Settings" }
      ],
      fields: [
        { key: "translationEditPresetName", label: "Translation Preset", type: "select", group: "translation", options: [], description: "Select the translation preset to edit." },
        { key: "newTranslationPresetName", label: "Create or Rename", type: "text", group: "translation", description: "Enter a translation preset name and save to create/switch to it." },
        { key: "currentTranslation.translationEnabled", label: "Translate Text", type: "switch", group: "general", description: "Translate text before TTS. Disable to send the original text directly to the selected voice model." },
        { key: "currentTranslation.apiPresetName", label: "API Preset", type: "apiPresetSelect", group: "translation", description: "Select a saved API preset. The plugin does not store API keys." },
        { key: "currentTranslation.prompt", label: "Prompt", type: "textarea", group: "translation", description: "Prompt used by this plugin before it calls the selected API preset." },
        { key: "voice.modelEditPresetName", label: "Model Preset", type: "select", group: "model_genie", options: [], description: "Select the model preset to edit." },
        { key: "voice.newModelConfigName", label: "Create or Rename", type: "text", group: "model_genie", description: "Enter a model preset name and save to create/switch to it." },
        { key: "voice.currentModel.language", label: "Voice Language", type: "select", group: "model_genie", options: [
          { value: "jp", label: "Japanese" },
          { value: "zh", label: "Chinese" },
          { value: "en", label: "English" }
        ], description: "Genie language used for this TTS voice route." },
        { key: "voice.currentModel.modelDir", label: "Model Folder", type: "folderUpload", group: "model_genie", assetKey: "model", description: "Genie model folder for the selected model config." },
        { key: "voice.currentModel.referenceAudio", label: "Reference Audio", type: "fileUpload", group: "model_genie", assetKey: "reference-audio", accept: "audio/*", description: "Reference audio for the selected model config." },
        { key: "voice.currentModel.referenceText", label: "Reference Text", type: "textarea", group: "model_genie", description: "Reference text for the selected model preset. It is stored at assets/tts/preset/{preset}/reference.txt on save." },
        { key: "voice.currentModel.speed", label: "Voice Speed", type: "number", group: "model_genie", min: 0.5, max: 2, step: 0.05, description: "Optional Genie playback speed multiplier from 0.5 to 2.0." },
        { key: "voice.currentModel.splitText", label: "Split Text", type: "switch", group: "model_genie", description: "Whether this preset lets Genie split one TTS text into multiple synthesized parts. Default is off." },
        { key: "voice.currentModel.partSilenceSeconds", label: "Part Silence", type: "number", group: "model_genie", min: 0, max: 3, step: 0.05, description: "Optional silence in seconds inserted between split Genie audio parts. Default is 0.67." },
        { key: "translationPresetName", label: "Active Translation Preset", type: "select", group: "general", options: [], description: "Translation preset used at runtime." },
        { key: "voice.modelConfigName", label: "Active Model Preset", type: "select", group: "general", options: [], description: "Model preset used at runtime." },
        { key: "conversion.provider", label: "Conversion Backend", type: "select", group: "general", options: [
          { value: "genie", label: "Genie" },
          { value: "openai-api", label: "OpenAI-API" },
          { value: "bailian", label: "Bailian" }
        ], description: "Backend used after optional translation." },
        { key: "enabled", label: "Enabled", type: "switch", group: "general", description: "Enable or disable this plugin route." },
        { key: "conversion.genie.enabled", label: "Remote Genie", type: "switch", group: "model_genie", description: "Use the LAN Genie TTS service before falling back to local Genie." },
        { key: "conversion.genie.baseURL", label: "Remote Genie IP/URL", type: "text", group: "model_genie", description: "Remote Genie TTS IP or base URL. Bare IP/host values default to http://{host}:8767." },
        { key: "conversion.openaiApi.apiPresetName", label: "API Preset", type: "apiPresetSelect", group: "conversion_openai_api", description: "OpenAI-compatible speech API preset. The plugin does not expose API keys in public config." },
        { key: "conversion.openaiApi.model", label: "Model", type: "text", group: "conversion_openai_api", description: "Speech model sent as model in POST /audio/speech." },
        { key: "conversion.openaiApi.voice", label: "Voice", type: "text", group: "conversion_openai_api", description: "Voice name or custom voice ID sent as voice." },
        { key: "conversion.openaiApi.timeoutMs", label: "Timeout Ms", type: "number", group: "conversion_openai_api", min: 1000, max: 300000, step: 1000, description: "Request timeout for OpenAI-API speech calls." },
        { key: "conversion.openaiApi.sampleRate", label: "PCM Sample Rate", type: "number", group: "conversion_openai_api", min: 8000, max: 48000, step: 1000, description: "PCM sample rate used to estimate chunk text timing. Default is 32000." },
        { key: "conversion.openaiApi.channels", label: "PCM Channels", type: "number", group: "conversion_openai_api", min: 1, max: 2, step: 1, description: "PCM channel count used to estimate chunk text timing. Default is 1." },
        { key: "conversion.openaiApi.extraParamsJson", label: "Extra Params JSON", type: "textarea", group: "conversion_openai_api", description: "Optional JSON object merged into the speech request before input/model/voice/response_format." },
        { key: "conversion.bailian.endpoint", label: "HTTP SSE Endpoint", type: "text", group: "conversion_bailian", description: "Bailian Qwen-TTS non-realtime HTTP endpoint used with X-DashScope-SSE: enable." },
        { key: "conversion.bailian.apiKey", label: "API Key", type: "password", group: "conversion_bailian", description: "Bailian DashScope API key stored in the local ignored plugin config. Leave blank to keep unchanged." },
        { key: "conversion.bailian.apiKeyEnv", label: "API Key Env", type: "text", group: "conversion_bailian", description: "Environment variable containing the Bailian DashScope API key. Default is DASHSCOPE_API_KEY." },
        { key: "conversion.bailian.workspaceId", label: "Workspace ID", type: "text", group: "conversion_bailian", description: "Optional Bailian workspace id sent as X-DashScope-WorkSpace." },
        { key: "conversion.bailian.userAgent", label: "User Agent", type: "text", group: "conversion_bailian", description: "Optional user-agent sent with the HTTP request." },
        { key: "conversion.bailian.model", label: "Model", type: "text", group: "conversion_bailian", description: "Bailian Qwen-TTS non-realtime model name." },
        { key: "conversion.bailian.voice", label: "Voice", type: "text", group: "conversion_bailian", description: "Bailian voice name or custom voice ID." },
        { key: "conversion.bailian.languageType", label: "Language Type", type: "text", group: "conversion_bailian", description: "Qwen-TTS language_type, for example Chinese, Japanese, English, or Auto." },
        { key: "conversion.bailian.mode", label: "Mode", type: "select", group: "conversion_bailian", options: [
          { value: "server_commit", label: "Server Commit" },
          { value: "commit", label: "Commit" }
        ], description: "Retained for older configs; non-realtime streaming uses HTTP SSE." },
        { key: "conversion.bailian.responseFormat", label: "Response Format", type: "text", group: "conversion_bailian", description: "Local PCM format label for playback; Bailian non-realtime SSE returns PCM audio data." },
        { key: "conversion.bailian.timeoutMs", label: "Timeout Ms", type: "number", group: "conversion_bailian", min: 1000, max: 300000, step: 1000, description: "Request timeout for Bailian non-realtime TTS." },
        { key: "conversion.bailian.sampleRate", label: "PCM Sample Rate", type: "number", group: "conversion_bailian", min: 8000, max: 48000, step: 1000, description: "PCM sample rate returned by Bailian. Default is 24000." },
        { key: "conversion.bailian.channels", label: "PCM Channels", type: "number", group: "conversion_bailian", min: 1, max: 2, step: 1, description: "PCM channel count returned by Bailian. Default is 1." },
        { key: "conversion.bailian.extraParamsJson", label: "Extra Params JSON", type: "textarea", group: "conversion_bailian", description: "Optional JSON object merged into Bailian Qwen-TTS input fields." },
        { key: "targetRoute", label: "Target Route", type: "readonly", group: "general", description: "send_chat.voice.before_tts" },
        { key: "persistTranslation", label: "Persist Translation", type: "readonly", group: "general", description: "Translations are transient and never written to message log." }
      ]
    },
    routePreview: [
      "send_chat.voice",
      "plugin.translate_optional",
      "default_tts.synthesize",
      "channel.audio.send"
    ],
    runtimeAccess: [
      "call selected API preset",
      "read outgoing voice text before TTS",
      "pass translated text to TTS",
      "do not persist translated text to message log"
    ]
  };
}

function feishuPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return {
        id: "feishu",
        name: "Feishu",
        kind: "channel",
        status: "external_config",
        health: context.runtime.feishuStarted ? "healthy" : "unknown",
        description: "Feishu channel plugin for inbound and outbound messages.",
        configurable: false,
        switchable: false,
        configSource: ".env"
      };
    }
  };
}

function wechatPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary() {
      return {
        id: "wechat",
        name: "WeChat",
        kind: "channel",
        status: "planned",
        health: "unknown",
        description: "WeChat channel plugin placeholder for the unified plugin page.",
        configurable: false,
        switchable: false
      };
    }
  };
}

function asrPluginSummary(context: AdminRoutesContext, config = readAsrConfigForAdmin(context)): AdminPluginSummary {
  const presetNames = new Set(readLLMApiPresets(context).map((entry) => entry.name));
  const missingConfig = config.enabled && asrConfigMissingPreset(config, presetNames);
  return {
    id: "asr",
    name: "ASR",
    kind: "asr",
    status: missingConfig ? "missing_config" : config.enabled ? "enabled" : "disabled",
    health: missingConfig ? "degraded" : config.enabled ? "healthy" : "unknown",
    description: "Transcribe caller-provided audio files through Tencent Cloud or OpenAI-compatible ASR APIs.",
    configurable: true,
    switchable: true,
    configSource: asrConfigPath(context),
    lastLoadedAt: asrConfigMtime(context)
  };
}

function photoPluginSummary(context: AdminRoutesContext, config = readPhotoConfigForAdmin(context)): AdminPluginSummary {
  const missingConfig = config.enabled && config.selfieMode === "api" && !config.selfieImageApiKey;
  return {
    id: "photo",
    name: "Photo",
    kind: "tool",
    status: missingConfig ? "missing_config" : config.enabled ? "enabled" : "disabled",
    health: missingConfig ? "degraded" : config.enabled ? "healthy" : "unknown",
    description: "Generate and send selfie images through the Image API runner or Codex CLI.",
    configurable: true,
    switchable: true,
    configSource: photoConfigPath(context),
    lastLoadedAt: photoConfigMtime(context)
  };
}

function updatePhotoConfig(context: AdminRoutesContext, patch: Record<string, unknown>): { config: PhotoPluginConfig } | { error: string } {
  if ("selfieImageApiKey" in patch) return { error: "invalid_plugin_config" };
  const current = readPhotoConfigForAdmin(context);
  const next: PhotoPluginConfig = {
    ...current,
    enabled: patch.enabled === undefined ? current.enabled : booleanFromUnknown(patch.enabled),
    selfieMode: patch.selfieMode === undefined ? current.selfieMode : photoSelfieModeFromUnknown(patch.selfieMode),
    selfieReferenceDir: patch.selfieReferenceDir === undefined ? current.selfieReferenceDir : requiredString(patch.selfieReferenceDir).trim(),
    selfieOutputDir: patch.selfieOutputDir === undefined ? current.selfieOutputDir : requiredString(patch.selfieOutputDir).trim(),
    selfieCodexCommand: patch.selfieCodexCommand === undefined ? current.selfieCodexCommand : requiredString(patch.selfieCodexCommand).trim(),
    selfieCodexTimeoutMs: patch.selfieCodexTimeoutMs === undefined ? current.selfieCodexTimeoutMs : numberFromUnknown(patch.selfieCodexTimeoutMs, current.selfieCodexTimeoutMs),
    selfieImageApiBaseURL: patch.selfieImageApiBaseURL === undefined ? current.selfieImageApiBaseURL : requiredString(patch.selfieImageApiBaseURL).trim().replace(/\/+$/, ""),
    selfieImageApiModel: patch.selfieImageApiModel === undefined ? current.selfieImageApiModel : requiredString(patch.selfieImageApiModel).trim(),
    selfieImageApiSize: patch.selfieImageApiSize === undefined ? current.selfieImageApiSize : requiredString(patch.selfieImageApiSize).trim(),
    selfieImageApiQuality: patch.selfieImageApiQuality === undefined ? current.selfieImageApiQuality : requiredString(patch.selfieImageApiQuality).trim(),
    selfieImageApiOutputFormat: patch.selfieImageApiOutputFormat === undefined ? current.selfieImageApiOutputFormat : photoOutputFormatFromUnknown(patch.selfieImageApiOutputFormat, current.selfieImageApiOutputFormat),
    selfieImageApiOutputCompression: patch.selfieImageApiOutputCompression === undefined ? current.selfieImageApiOutputCompression : numberFromUnknown(patch.selfieImageApiOutputCompression, current.selfieImageApiOutputCompression),
    selfieImageApiTimeoutMs: patch.selfieImageApiTimeoutMs === undefined ? current.selfieImageApiTimeoutMs : numberFromUnknown(patch.selfieImageApiTimeoutMs, current.selfieImageApiTimeoutMs),
    selfieMaxBytes: patch.selfieMaxBytes === undefined ? current.selfieMaxBytes : numberFromUnknown(patch.selfieMaxBytes, current.selfieMaxBytes)
  };

  const validationError = validatePhotoConfig(next);
  if (validationError) return { error: validationError };
  writePhotoConfig(context, next);
  return { config: next };
}

function validatePhotoConfig(config: PhotoPluginConfig): string | undefined {
  if (config.selfieMode !== "api" && config.selfieMode !== "codex") return "invalid_selfie_mode";
  if (!config.selfieReferenceDir) return "missing_selfie_reference_dir";
  if (!config.selfieOutputDir || !isPathUnderAssets(config.selfieOutputDir)) return "invalid_selfie_output_dir";
  if (!config.selfieCodexCommand) return "missing_selfie_codex_command";
  if (config.selfieCodexTimeoutMs < 1000 || config.selfieCodexTimeoutMs > 600_000) return "invalid_selfie_codex_timeout";
  if (!isValidHttpUrl(config.selfieImageApiBaseURL)) return "invalid_selfie_api_base_url";
  if (!config.selfieImageApiModel) return "missing_selfie_api_model";
  if (!config.selfieImageApiSize) return "missing_selfie_api_size";
  if (!config.selfieImageApiQuality) return "missing_selfie_api_quality";
  if (!["jpeg", "png", "webp"].includes(config.selfieImageApiOutputFormat)) return "invalid_selfie_output_format";
  if (config.selfieImageApiOutputCompression < 0 || config.selfieImageApiOutputCompression > 100) return "invalid_selfie_output_compression";
  if (config.selfieImageApiTimeoutMs < 1000 || config.selfieImageApiTimeoutMs > 600_000) return "invalid_selfie_api_timeout";
  if (config.selfieMaxBytes < 1024 || config.selfieMaxBytes > 50 * 1024 * 1024) return "invalid_selfie_max_bytes";
  return undefined;
}

function readPhotoConfigForAdmin(context: AdminRoutesContext): PhotoPluginConfig {
  return readPhotoPluginConfig(photoConfigPath(context), photoConfigDefaultsForAdmin(context));
}

function writePhotoConfig(context: AdminRoutesContext, config: PhotoPluginConfig): void {
  const filePath = photoConfigPath(context);
  const persisted: Partial<PhotoPluginConfig> = { ...config };
  delete persisted.selfieImageApiKey;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(persisted, null, 2)}\n`);
}

function photoConfigDefaultsForAdmin(context: AdminRoutesContext): Partial<PhotoPluginConfig> {
  const photo = ((context.config as Partial<AppConfig>).photo ?? {}) as Partial<PhotoPluginConfig>;
  return {
    enabled: true,
    selfieMode: "api",
    selfieReferenceDir: photo.selfieReferenceDir,
    selfieOutputDir: photo.selfieOutputDir,
    selfieCodexCommand: photo.selfieCodexCommand,
    selfieCodexTimeoutMs: photo.selfieCodexTimeoutMs,
    selfieImageApiKey: photo.selfieImageApiKey,
    selfieImageApiBaseURL: photo.selfieImageApiBaseURL,
    selfieImageApiModel: photo.selfieImageApiModel,
    selfieImageApiSize: photo.selfieImageApiSize,
    selfieImageApiQuality: photo.selfieImageApiQuality,
    selfieImageApiOutputFormat: photo.selfieImageApiOutputFormat,
    selfieImageApiOutputCompression: photo.selfieImageApiOutputCompression,
    selfieImageApiTimeoutMs: photo.selfieImageApiTimeoutMs,
    selfieMaxBytes: photo.selfieMaxBytes
  };
}

function photoConfigPath(context: AdminRoutesContext): string {
  return context.pluginConfigs?.photo?.configPath ?? defaultPhotoPluginConfigPath;
}

function photoConfigMtime(context: AdminRoutesContext): string | undefined {
  try {
    const stats = fs.statSync(photoConfigPath(context)) as { mtime?: Date; mtimeMs?: number };
    if (stats.mtime instanceof Date) return stats.mtime.toISOString();
    if (typeof stats.mtimeMs === "number") return new Date(stats.mtimeMs).toISOString();
    return undefined;
  } catch {
    return undefined;
  }
}

function photoSelfieModeFromUnknown(value: unknown): SelfieGenerationMode {
  return value === "codex" ? "codex" : "api";
}

function photoOutputFormatFromUnknown(value: unknown, fallback: string): string {
  const normalized = requiredString(value).trim().toLowerCase();
  if (normalized === "jpg") return "jpeg";
  if (normalized === "jpeg" || normalized === "png" || normalized === "webp") return normalized;
  return fallback;
}

function isPathUnderAssets(value: string): boolean {
  const relative = path.relative(path.resolve("assets"), path.resolve(value));
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function asrConfigMissingPreset(config: AsrPluginConfig, presetNames: Set<string>): boolean {
  const provider = config.defaultProvider;
  if (provider === "openai_compatible") {
    const name = config.providers.openaiCompatible?.apiPresetName;
    return !name || !presetNames.has(name);
  }
  return !config.providers.tencent?.secretId || !config.providers.tencent?.secretKey;
}

async function testAsrPlugin(context: AdminRoutesContext, input: Record<string, unknown>): Promise<{ ok: true; result?: unknown } | { error: string }> {
  const config = readAsrConfigForAdmin(context);
  const audioFile = optionalString(input.audioFile) ?? config.testAudioPath;
  if (!audioFile) return { error: "missing_audio_file" };
  if (!isPluginAssetPath("asr", audioFile, context.pluginConfigs?.asr?.assetRoot)) return { error: "invalid_asset_path" };
  const resolvedAudioFile = resolvePluginAssetPath("asr", audioFile, context.pluginConfigs?.asr?.assetRoot);
  if (!fs.existsSync(resolvedAudioFile)) return { error: "missing_audio_file" };

  const totalStartedAt = Date.now();
  const transcriber = context.pluginConfigs?.asr?.testTranscriber;
  const result = await (transcriber
    ? transcriber({ audioFile: resolvedAudioFile }, config)
    : transcribeWithAsrPlugin({ audioFile: resolvedAudioFile }, config, {
      resolveApiPreset(name) {
        return readLLMApiPresets(context).find((entry) => entry.name === name);
      },
      appendLog: context.appendLog
    }));
  if (isAsrTranscribeError(result)) return { error: result.error };
  return {
    ok: true,
    result: {
      input: audioFile,
      output: result.text,
      provider: result.provider,
      model: result.model,
      requestId: result.requestId,
      timing: {
        transcriptionMs: result.durationMs,
        totalMs: Date.now() - totalStartedAt
      }
    }
  };
}

function isAsrTranscribeError(result: AsrTranscribeResult | AsrTranscribeError): result is AsrTranscribeError {
  return "ok" in result && result.ok === false;
}

function updateAsrConfig(context: AdminRoutesContext, patch: Record<string, unknown>): { config: AsrPluginConfig } | { error: string } {
  const current = readAsrConfigForAdmin(context);
  const providersPatch = patch.providers && typeof patch.providers === "object" && !Array.isArray(patch.providers)
    ? patch.providers as Record<string, unknown>
    : {};
  const openAiPatch = providersPatch.openaiCompatible && typeof providersPatch.openaiCompatible === "object" && !Array.isArray(providersPatch.openaiCompatible)
    ? providersPatch.openaiCompatible as Record<string, unknown>
    : {};
  const tencentPatch = providersPatch.tencent && typeof providersPatch.tencent === "object" && !Array.isArray(providersPatch.tencent)
    ? providersPatch.tencent as Record<string, unknown>
    : {};

  const next: AsrPluginConfig = {
    enabled: patch.enabled === undefined ? current.enabled : booleanFromUnknown(patch.enabled),
    defaultProvider: patch.defaultProvider === undefined ? current.defaultProvider : asrProviderFromUnknown(patch.defaultProvider),
    testAudioPath: patch.testAudioPath === undefined ? current.testAudioPath : optionalString(patch.testAudioPath),
    pseudoStreamMinPauseMs: patch.pseudoStreamMinPauseMs === undefined ? current.pseudoStreamMinPauseMs : optionalNumberFromUnknown(patch.pseudoStreamMinPauseMs),
    providers: {
      openaiCompatible: {
        apiPresetName: openAiPatch.apiPresetName === undefined ? current.providers.openaiCompatible?.apiPresetName : optionalString(openAiPatch.apiPresetName),
        responseFormat: openAiPatch.responseFormat === undefined ? current.providers.openaiCompatible?.responseFormat : asrResponseFormatFromUnknown(openAiPatch.responseFormat),
        retryCount: openAiPatch.retryCount === undefined ? current.providers.openaiCompatible?.retryCount : optionalNumberFromUnknown(openAiPatch.retryCount),
        retryBackoffMs: openAiPatch.retryBackoffMs === undefined ? current.providers.openaiCompatible?.retryBackoffMs : optionalNumberFromUnknown(openAiPatch.retryBackoffMs)
      },
      tencent: {
        appId: tencentPatch.appId === undefined ? current.providers.tencent?.appId : optionalString(tencentPatch.appId),
        secretId: tencentPatch.secretId === undefined ? current.providers.tencent?.secretId : optionalString(tencentPatch.secretId),
        secretKey: tencentPatch.secretKey === undefined ? current.providers.tencent?.secretKey : optionalString(tencentPatch.secretKey),
        endpoint: tencentPatch.endpoint === undefined ? current.providers.tencent?.endpoint : optionalString(tencentPatch.endpoint),
        region: tencentPatch.region === undefined ? current.providers.tencent?.region : optionalString(tencentPatch.region),
        engineModelType: tencentPatch.engineModelType === undefined ? current.providers.tencent?.engineModelType : optionalString(tencentPatch.engineModelType),
        realtimeVoiceFormat: tencentPatch.realtimeVoiceFormat === undefined ? current.providers.tencent?.realtimeVoiceFormat : optionalNumberFromUnknown(tencentPatch.realtimeVoiceFormat),
        realtimeNeedVad: tencentPatch.realtimeNeedVad === undefined ? current.providers.tencent?.realtimeNeedVad : optionalNumberFromUnknown(tencentPatch.realtimeNeedVad),
        pollIntervalMs: tencentPatch.pollIntervalMs === undefined ? current.providers.tencent?.pollIntervalMs : optionalNumberFromUnknown(tencentPatch.pollIntervalMs),
        timeoutMs: tencentPatch.timeoutMs === undefined ? current.providers.tencent?.timeoutMs : optionalNumberFromUnknown(tencentPatch.timeoutMs),
        retryCount: tencentPatch.retryCount === undefined ? current.providers.tencent?.retryCount : optionalNumberFromUnknown(tencentPatch.retryCount),
        retryBackoffMs: tencentPatch.retryBackoffMs === undefined ? current.providers.tencent?.retryBackoffMs : optionalNumberFromUnknown(tencentPatch.retryBackoffMs),
        maxChunkBytes: tencentPatch.maxChunkBytes === undefined ? current.providers.tencent?.maxChunkBytes : optionalNumberFromUnknown(tencentPatch.maxChunkBytes),
        splitSilenceThresholdDb: tencentPatch.splitSilenceThresholdDb === undefined ? current.providers.tencent?.splitSilenceThresholdDb : optionalNumberFromUnknown(tencentPatch.splitSilenceThresholdDb),
        splitMinSilenceMs: tencentPatch.splitMinSilenceMs === undefined ? current.providers.tencent?.splitMinSilenceMs : optionalNumberFromUnknown(tencentPatch.splitMinSilenceMs)
      }
    }
  };

  const validationError = validateAsrConfig(context, next);
  if (validationError) return { error: validationError };
  writeAsrConfig(context, next);
  return { config: next };
}

function validateAsrConfig(context: AdminRoutesContext, config: AsrPluginConfig): string | undefined {
  if (config.testAudioPath && !isPluginAssetPath("asr", config.testAudioPath)) return "invalid_asset_path";
  const pseudoPause = config.pseudoStreamMinPauseMs;
  if (pseudoPause !== undefined && (pseudoPause < 500 || pseudoPause > 10_000)) return "invalid_pseudo_stream_pause";
  const presets = new Set(readLLMApiPresets(context).map((entry) => entry.name));
  for (const name of [config.providers.openaiCompatible?.apiPresetName]) {
    if (name && !presets.has(name)) return "invalid_api_preset";
  }
  if (config.providers.tencent?.endpoint && !isValidHttpUrl(config.providers.tencent.endpoint)) return "invalid_tencent_endpoint";
  const realtimeVoiceFormat = config.providers.tencent?.realtimeVoiceFormat;
  if (realtimeVoiceFormat !== undefined && (realtimeVoiceFormat < 1 || realtimeVoiceFormat > 16)) return "invalid_realtime_voice_format";
  const realtimeNeedVad = config.providers.tencent?.realtimeNeedVad;
  if (realtimeNeedVad !== undefined && realtimeNeedVad !== 0 && realtimeNeedVad !== 1) return "invalid_realtime_need_vad";
  const poll = config.providers.tencent?.pollIntervalMs;
  if (poll !== undefined && (poll < 100 || poll > 10_000)) return "invalid_poll_interval";
  const timeout = config.providers.tencent?.timeoutMs;
  if (timeout !== undefined && (timeout < 1000 || timeout > 600_000)) return "invalid_timeout";
  const retryCount = [config.providers.openaiCompatible?.retryCount, config.providers.tencent?.retryCount];
  if (retryCount.some((value) => value !== undefined && (value < 0 || value > 5))) return "invalid_retry_count";
  const retryBackoff = [config.providers.openaiCompatible?.retryBackoffMs, config.providers.tencent?.retryBackoffMs];
  if (retryBackoff.some((value) => value !== undefined && (value < 0 || value > 30_000))) return "invalid_retry_backoff";
  const maxChunkBytes = config.providers.tencent?.maxChunkBytes;
  if (maxChunkBytes !== undefined && (maxChunkBytes < 100_000 || maxChunkBytes > 5 * 1024 * 1024)) return "invalid_max_chunk_bytes";
  const splitDb = config.providers.tencent?.splitSilenceThresholdDb;
  if (splitDb !== undefined && (splitDb < -80 || splitDb > -10)) return "invalid_split_silence_threshold";
  const splitMs = config.providers.tencent?.splitMinSilenceMs;
  if (splitMs !== undefined && (splitMs < 100 || splitMs > 5000)) return "invalid_split_min_silence";
  return undefined;
}

async function uploadAsrPluginAsset(
  context: AdminRoutesContext,
  assetKey: string,
  request: any
): Promise<{ config: AsrPluginConfig; assetPath: string } | { error: string; statusCode?: number }> {
  if (assetKey !== "test-audio") return { error: "unknown_asset_key" };
  const config = readAsrConfigForAdmin(context);
  const fileName = safePluginAssetFileName(decodeHeaderFileName(optionalString(request.headers?.["x-file-name"]) ?? ""));
  const relativeDir = decodeHeaderFileName(optionalString(request.headers?.["x-relative-dir"]) ?? "");
  const body = await readRawBody(request, { maxBytes: maxPluginAssetUploadBytes });
  if (body.length === 0) return { error: "empty_upload" };
  const assetPath = resolvePluginAssetPathForUpload("asr", assetKey, fileName, relativeDir, context.pluginConfigs?.asr?.assetRoot);
  fs.mkdirSync(path.dirname(assetPath.fullPath), { recursive: true });
  fs.writeFileSync(assetPath.fullPath, body);
  const next: AsrPluginConfig = {
    ...config,
    testAudioPath: assetPath.assetPath
  };
  writeAsrConfig(context, next);
  return { config: publicAsrConfig(next), assetPath: assetPath.assetPath };
}

function readAsrConfigForAdmin(context: AdminRoutesContext): AsrPluginConfig {
  return readAsrPluginConfig(asrConfigPath(context));
}

function writeAsrConfig(context: AdminRoutesContext, config: AsrPluginConfig): void {
  const filePath = asrConfigPath(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(publicAsrConfig(config), null, 2)}\n`);
}

function publicAsrConfig(config: AsrPluginConfig): AsrPluginConfig {
  return {
    enabled: config.enabled,
    defaultProvider: config.defaultProvider,
    testAudioPath: config.testAudioPath,
    pseudoStreamMinPauseMs: config.pseudoStreamMinPauseMs,
    providers: {
      openaiCompatible: config.providers.openaiCompatible ? { ...config.providers.openaiCompatible } : undefined,
      tencent: config.providers.tencent ? { ...config.providers.tencent } : undefined
    }
  };
}

function asrConfigPath(context: AdminRoutesContext): string {
  return context.pluginConfigs?.asr?.configPath ?? "config/plugin/asr/config.json";
}

function asrConfigMtime(context: AdminRoutesContext): string | undefined {
  try {
    const stats = fs.statSync(asrConfigPath(context)) as { mtime?: Date; mtimeMs?: number };
    if (stats.mtime instanceof Date) return stats.mtime.toISOString();
    if (typeof stats.mtimeMs === "number") return new Date(stats.mtimeMs).toISOString();
    return undefined;
  } catch {
    return undefined;
  }
}

function asrProviderFromUnknown(value: unknown): AsrPluginConfig["defaultProvider"] {
  return value === "tencent" ? "tencent" : "openai_compatible";
}

function asrResponseFormatFromUnknown(value: unknown): "json" | "text" | "verbose_json" | undefined {
  if (value === "json" || value === "text" || value === "verbose_json") return value;
  return undefined;
}

function optionalNumberFromUnknown(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

function ttsPluginSummary(context: AdminRoutesContext, config = readTtsConfigForAdmin(context)): AdminPluginSummary {
  const presetExists = !config.apiPresetName || readLLMApiPresets(context).some((entry) => entry.name === config.apiPresetName);
  const conversionPresetName = config.conversion?.provider === "openai-api" ? config.conversion.openaiApi?.apiPresetName : undefined;
  const conversionPresetExists = !conversionPresetName || readLLMApiPresets(context).some((entry) => entry.name === conversionPresetName);
  const missingConfig = config.enabled && ((!config.apiPresetName || !presetExists) || !conversionPresetExists);
  return {
    id: "tts",
    name: "TTS",
    kind: "voice",
    status: missingConfig ? "missing_config" : config.enabled ? "enabled" : "disabled",
    health: missingConfig ? "degraded" : config.enabled ? "healthy" : "unknown",
    description: "Translate send_chat voice text through a selected API preset before the normal TTS route.",
    configurable: true,
    switchable: true,
    configSource: ttsConfigPath(context),
    lastLoadedAt: ttsConfigMtime(context)
  };
}

async function testTtsPlugin(context: AdminRoutesContext, input: Record<string, unknown>): Promise<{ ok: true; result?: unknown } | { error: string }> {
  const config = readTtsConfigForAdmin(context);
  const text = requiredString(input.text) || "晚点见。";
  if (Array.from(text).length > 240) return { error: "text_too_long" };

  const totalStartedAt = Date.now();
  let translatedText = text;
  let translationMs = 0;
  if (config.translationEnabled) {
    if (!config.apiPresetName) return { error: "missing_api_preset" };
    const preset = readLLMApiPresets(context).find((entry) => entry.name === config.apiPresetName);
    if (!preset) return { error: "invalid_api_preset" };
    if (!preset.baseURL || !preset.apiKey) return { error: "incomplete_api_preset" };
    const translationStartedAt = Date.now();
    const translated = await translateTtsText(text, config, {
      baseSynthesizer: async () => {
        throw new Error("not used");
      },
      llmRequestSender: context.llmRequestSender ? (request) => context.llmRequestSender!({ ...request, client: request.client as any } as any) as any : undefined,
      llm: createOpenAICompatibleClient({
        baseURL: preset.baseURL,
        apiKey: preset.apiKey,
        model: preset.model,
        temperature: preset.temperature,
        timeoutMs: preset.timeoutMs,
        extraParams: preset.extraParams
      }),
      resolveApiPreset(name) {
        return readLLMApiPresets(context).find((entry) => entry.name === name);
      },
      promptVariables: () => buildLLMTextVariables({
        userName: context.promptProfileStore.get().userName,
        time: context.time
      }),
      appendLog: context.appendLog
    });
    translationMs = Date.now() - translationStartedAt;
    if (!translated) return { error: "translation_failed" };
    translatedText = translated;
  } else {
    context.appendLog?.("info", `tts admin test translation skipped: disabled chars=${Array.from(text).length}`);
  }

  const ttsStartedAt = Date.now();
  const configuredSynthesizer = context.pluginConfigs?.tts?.testVoiceSynthesizer;
  const synthesizer = configuredSynthesizer ?? (
    config.conversion?.provider === "openai-api"
      ? createOpenAiApiTtsVoiceSynthesizer(config, {
        resolveApiPreset(name) {
          return readLLMApiPresets(context).find((entry) => entry.name === name);
        },
        appendLog: context.appendLog
      })
      : config.conversion?.provider === "bailian"
        ? createBailianTtsVoiceSynthesizer(config, {
          appendLog: context.appendLog
        })
      : createTtsFallbackTtsSynthesizer(context)
  );
  let voice: Awaited<ReturnType<VoiceSynthesizer>>;
  let ttsMs = 0;
  try {
    voice = await synthesizer({
      text: translatedText,
      time: context.time,
      ...(config.conversion?.provider === "genie" || !config.conversion?.provider ? { genie: ttsGenieOverrides(config) } : {})
    });
    ttsMs = Date.now() - ttsStartedAt;
  } finally {
    if (!configuredSynthesizer) await synthesizer.shutdown?.();
  }

  return {
    ok: true,
    result: {
      input: text,
      output: translatedText,
      voice: {
        assetId: voice.assetId,
        filePath: voice.filePath,
        audioUrl: ttsAudioUrl(context, voice.filePath)
      },
      timing: {
        translationMs,
        ttsMs,
        totalMs: Date.now() - totalStartedAt
      }
    }
  };
}

function createTtsFallbackTtsSynthesizer(context: AdminRoutesContext): VoiceSynthesizer {
  return createTtsRemoteAwareVoiceSynthesizer({
    ...context.config.tts,
    ttsConfigPath: ttsConfigPath(context)
  }, {
    appendLog: context.appendLog
  });
}

function updateTtsConfig(
  context: AdminRoutesContext,
  patch: Record<string, unknown>
): { config: TtsPluginConfig } | { error: string } {
  const current = readTtsConfigForAdmin(context);
  const currentVoice = current.voice ?? {};
  if ("api_preset" in patch) return { error: "invalid_plugin_config" };
  const conversionPatch = patch.conversion && typeof patch.conversion === "object" && !Array.isArray(patch.conversion)
    ? patch.conversion as Record<string, unknown>
    : {};
  const remotePatch = patch.remote && typeof patch.remote === "object" && !Array.isArray(patch.remote)
    ? patch.remote as Record<string, unknown>
    : {};
  const geniePatch = conversionPatch.genie && typeof conversionPatch.genie === "object" && !Array.isArray(conversionPatch.genie)
    ? conversionPatch.genie as Record<string, unknown>
    : remotePatch;
  const currentRemote = current.conversion?.genie ?? current.remote ?? {};
  const nextRemote = {
    enabled: geniePatch.enabled === undefined ? currentRemote.enabled ?? true : booleanFromUnknown(geniePatch.enabled),
    baseURL: geniePatch.baseURL === undefined ? currentRemote.baseURL ?? "http://192.168.0.103:8767" : normalizeRemoteTtsBaseURL(optionalString(geniePatch.baseURL) ?? "")
  };
  const openAiApiPatch = conversionPatch.openaiApi && typeof conversionPatch.openaiApi === "object" && !Array.isArray(conversionPatch.openaiApi)
    ? conversionPatch.openaiApi as Record<string, unknown>
    : {};
  const currentOpenAiApi = current.conversion?.openaiApi ?? {};
  const extraParamsResult = parseOptionalJsonObject(openAiApiPatch.extraParamsJson, currentOpenAiApi.extraParams ?? {});
  if ("error" in extraParamsResult) return { error: extraParamsResult.error };
  const nextOpenAiApi = {
    apiPresetName: openAiApiPatch.apiPresetName === undefined ? currentOpenAiApi.apiPresetName : optionalString(openAiApiPatch.apiPresetName),
    model: openAiApiPatch.model === undefined ? currentOpenAiApi.model ?? "higgs-audio-v3-tts" : requiredString(openAiApiPatch.model),
    voice: openAiApiPatch.voice === undefined ? currentOpenAiApi.voice ?? "default" : requiredString(openAiApiPatch.voice),
    timeoutMs: openAiApiPatch.timeoutMs === undefined ? currentOpenAiApi.timeoutMs ?? 60_000 : optionalNumberFromUnknown(openAiApiPatch.timeoutMs),
    sampleRate: openAiApiPatch.sampleRate === undefined ? currentOpenAiApi.sampleRate ?? 32_000 : optionalNumberFromUnknown(openAiApiPatch.sampleRate),
    channels: openAiApiPatch.channels === undefined ? currentOpenAiApi.channels ?? 1 : optionalNumberFromUnknown(openAiApiPatch.channels),
    extraParams: extraParamsResult.value
  };
  const bailianPatch = conversionPatch.bailian && typeof conversionPatch.bailian === "object" && !Array.isArray(conversionPatch.bailian)
    ? conversionPatch.bailian as Record<string, unknown>
    : {};
  const currentBailian = current.conversion?.bailian ?? {};
  const bailianExtraParamsResult = parseOptionalJsonObject(bailianPatch.extraParamsJson, currentBailian.extraParams ?? {});
  if ("error" in bailianExtraParamsResult) return { error: "invalid_bailian_extra_params" };
  const nextBailian = {
    endpoint: bailianPatch.endpoint === undefined ? currentBailian.endpoint ?? "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation" : requiredString(bailianPatch.endpoint),
    apiKey: bailianPatch.apiKey === undefined ? currentBailian.apiKey : optionalString(bailianPatch.apiKey) ?? currentBailian.apiKey,
    apiKeyEnv: bailianPatch.apiKeyEnv === undefined ? currentBailian.apiKeyEnv ?? "DASHSCOPE_API_KEY" : optionalString(bailianPatch.apiKeyEnv),
    workspaceId: bailianPatch.workspaceId === undefined ? currentBailian.workspaceId : optionalString(bailianPatch.workspaceId),
    userAgent: bailianPatch.userAgent === undefined ? currentBailian.userAgent : optionalString(bailianPatch.userAgent),
    model: bailianPatch.model === undefined ? currentBailian.model ?? "qwen3-tts-vc-2026-01-22" : requiredString(bailianPatch.model),
    voice: bailianPatch.voice === undefined ? currentBailian.voice ?? "Cherry" : requiredString(bailianPatch.voice),
    languageType: bailianPatch.languageType === undefined ? currentBailian.languageType ?? "Chinese" : optionalString(bailianPatch.languageType),
    mode: bailianPatch.mode === undefined ? currentBailian.mode ?? "server_commit" : bailianPatch.mode === "commit" ? "commit" as const : "server_commit" as const,
    responseFormat: bailianPatch.responseFormat === undefined ? currentBailian.responseFormat ?? "pcm" : requiredString(bailianPatch.responseFormat),
    timeoutMs: bailianPatch.timeoutMs === undefined ? currentBailian.timeoutMs ?? 60_000 : optionalNumberFromUnknown(bailianPatch.timeoutMs),
    sampleRate: bailianPatch.sampleRate === undefined ? currentBailian.sampleRate ?? 24_000 : optionalNumberFromUnknown(bailianPatch.sampleRate),
    channels: bailianPatch.channels === undefined ? currentBailian.channels ?? 1 : optionalNumberFromUnknown(bailianPatch.channels),
    extraParams: bailianExtraParamsResult.value
  };
  const nextConversionProvider = conversionPatch.provider === undefined
    ? current.conversion?.provider ?? "genie"
    : conversionPatch.provider === "openai-api" ? "openai-api" : conversionPatch.provider === "bailian" ? "bailian" : "genie";
  const currentTranslationPresets = current.translationPresets ?? {};
  const activeTranslationPresetName = safeTtsPresetName(optionalString(patch.translationPresetName) || current.translationPresetName || Object.keys(currentTranslationPresets)[0] || "default", "default");
  const editTranslationPresetName = safeTtsPresetName(optionalString(patch.newTranslationPresetName) || optionalString(patch.translationEditPresetName) || activeTranslationPresetName, "default");
  const currentTranslation = currentTranslationPresets[editTranslationPresetName] ?? currentTranslationPresets[activeTranslationPresetName] ?? {};
  const translationPatch = patch.currentTranslation && typeof patch.currentTranslation === "object" && !Array.isArray(patch.currentTranslation)
    ? patch.currentTranslation as Record<string, unknown>
    : {};
  const shouldUpdateTranslationPreset = Object.keys(translationPatch).length > 0 || optionalString(patch.newTranslationPresetName) !== undefined;
  const nextTranslation: TtsTranslationPreset = {
    translationEnabled: translationPatch.translationEnabled === undefined ? currentTranslation.translationEnabled ?? current.translationEnabled : booleanFromUnknown(translationPatch.translationEnabled),
    apiPresetName: translationPatch.apiPresetName === undefined ? currentTranslation.apiPresetName ?? current.apiPresetName : optionalString(translationPatch.apiPresetName),
    prompt: translationPatch.prompt === undefined ? currentTranslation.prompt ?? current.prompt : requiredString(translationPatch.prompt)
  };
  const voicePatch = patch.voice && typeof patch.voice === "object" && !Array.isArray(patch.voice)
    ? patch.voice as Record<string, unknown>
    : {};
  const currentModelConfigs = currentVoice.modelConfigs ?? {};
  const activeModelConfigName = safeTtsPresetName(optionalString(voicePatch.modelConfigName) || currentVoice.modelConfigName || Object.keys(currentModelConfigs)[0] || "jp", "jp");
  const editModelConfigName = safeTtsPresetName(optionalString(voicePatch.newModelConfigName) || optionalString(voicePatch.modelEditPresetName) || activeModelConfigName, "jp");
  const currentModel = currentModelConfigs[editModelConfigName] ?? currentModelConfigs[activeModelConfigName] ?? {};
  const modelPatch = voicePatch.currentModel && typeof voicePatch.currentModel === "object" && !Array.isArray(voicePatch.currentModel)
    ? voicePatch.currentModel as Record<string, unknown>
    : {};
  const shouldUpdateModelPreset = Object.keys(modelPatch).length > 0 || optionalString(voicePatch.newModelConfigName) !== undefined;
  const nextModel = {
    language: modelPatch.language === undefined ? currentModel.language ?? "jp" : ttsLanguageFromUnknown(modelPatch.language),
    speed: modelPatch.speed === undefined ? currentModel.speed : optionalSpeedValue(modelPatch.speed),
    partSilenceSeconds: modelPatch.partSilenceSeconds === undefined ? currentModel.partSilenceSeconds : optionalPartSilenceSecondsValue(modelPatch.partSilenceSeconds),
    splitText: modelPatch.splitText === undefined ? currentModel.splitText ?? false : booleanFromUnknown(modelPatch.splitText)
  };
  const referenceText = modelPatch.referenceText === undefined ? undefined : optionalString(modelPatch.referenceText);
  if (referenceText !== undefined) writeTtsPresetReferenceText(editModelConfigName, referenceText, context.pluginConfigs?.tts?.assetRoot);
  const nextTranslationPresets = shouldUpdateTranslationPreset
    ? { ...currentTranslationPresets, [editTranslationPresetName]: nextTranslation }
    : currentTranslationPresets;
  const activeTranslation = nextTranslationPresets[activeTranslationPresetName] ?? nextTranslation;
  const nextModelConfigs = shouldUpdateModelPreset
    ? { ...currentModelConfigs, [editModelConfigName]: nextModel }
    : currentModelConfigs;
  const next: TtsPluginConfig = {
    enabled: patch.enabled === undefined ? current.enabled : booleanFromUnknown(patch.enabled),
    remote: nextRemote,
    conversion: {
      provider: nextConversionProvider,
      genie: nextRemote,
      openaiApi: nextOpenAiApi,
      bailian: nextBailian
    },
    translationPresetName: activeTranslationPresetName,
    translationPresets: nextTranslationPresets,
    translationEnabled: activeTranslation.translationEnabled ?? true,
    apiPresetName: activeTranslation.apiPresetName,
    api_preset: current.api_preset,
    prompt: activeTranslation.prompt ?? current.prompt,
    voice: {
      modelConfigName: activeModelConfigName,
      modelConfigs: nextModelConfigs
    }
  };

  const validationError = validateTtsConfig(next);
  if (validationError) return { error: validationError };
  const presetToValidate = shouldUpdateTranslationPreset ? nextTranslation : activeTranslation;
  if ((shouldUpdateTranslationPreset || "translationPresetName" in patch || "enabled" in patch) && (presetToValidate.translationEnabled ?? true) && presetToValidate.apiPresetName && !readLLMApiPresets(context).some((entry) => entry.name === presetToValidate.apiPresetName)) {
    return { error: "invalid_api_preset" };
  }
  if (next.conversion?.provider === "openai-api" && next.conversion.openaiApi?.apiPresetName && !readLLMApiPresets(context).some((entry) => entry.name === next.conversion?.openaiApi?.apiPresetName)) {
    return { error: "invalid_openai_api_preset" };
  }
  writeTtsConfig(context, next);
  return { config: next };
}

function validateTtsConfig(config: TtsPluginConfig): string | undefined {
  const genie = config.conversion?.genie ?? config.remote;
  if (genie?.enabled && !genie.baseURL) return "invalid_remote_tts_url";
  const openaiApi = config.conversion?.openaiApi;
  if (config.conversion?.provider === "openai-api") {
    if (!openaiApi?.apiPresetName && !openaiApi?.baseURL) return "missing_openai_api_tts_preset";
    if (!openaiApi?.model) return "missing_openai_api_tts_model";
    if (!openaiApi?.voice) return "missing_openai_api_tts_voice";
  }
  if (openaiApi?.timeoutMs !== undefined && (openaiApi.timeoutMs < 1000 || openaiApi.timeoutMs > 300000)) return "invalid_openai_api_timeout";
  if (openaiApi?.sampleRate !== undefined && (openaiApi.sampleRate < 8000 || openaiApi.sampleRate > 48000)) return "invalid_openai_api_sample_rate";
  if (openaiApi?.channels !== undefined && (openaiApi.channels < 1 || openaiApi.channels > 2)) return "invalid_openai_api_channels";
  const bailian = config.conversion?.bailian;
  if (config.conversion?.provider === "bailian") {
    if (!bailian?.endpoint) return "missing_bailian_tts_endpoint";
    if (!bailian?.model) return "missing_bailian_tts_model";
    if (!bailian?.voice) return "missing_bailian_tts_voice";
  }
  if (bailian?.timeoutMs !== undefined && (bailian.timeoutMs < 1000 || bailian.timeoutMs > 300000)) return "invalid_bailian_timeout";
  if (bailian?.sampleRate !== undefined && (bailian.sampleRate < 8000 || bailian.sampleRate > 48000)) return "invalid_bailian_sample_rate";
  if (bailian?.channels !== undefined && (bailian.channels < 1 || bailian.channels > 2)) return "invalid_bailian_channels";
  const voice = config.voice ?? {};
  for (const model of Object.values(voice.modelConfigs ?? {})) {
    if (model.speed !== undefined && (model.speed < 0.5 || model.speed > 2)) return "invalid_voice_speed";
    if (model.partSilenceSeconds !== undefined && (model.partSilenceSeconds < 0 || model.partSilenceSeconds > 3)) return "invalid_part_silence";
  }
  return undefined;
}

function parseOptionalJsonObject(value: unknown, fallback: Record<string, unknown>): { value: Record<string, unknown> } | { error: string } {
  if (value === undefined) return { value: fallback };
  const text = optionalString(value);
  if (!text) return { value: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "invalid_openai_api_extra_params" };
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { error: "invalid_openai_api_extra_params" };
  }
}

function normalizeRemoteTtsBaseURL(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const hasScheme = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed);
  const candidate = hasScheme ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (!hasScheme && !parsed.port) parsed.port = "8767";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function isTtsVoiceAssetPath(value: string): boolean {
  return isTtsModelAssetPath(value) || isPluginAssetPath("tts", value);
}

function ttsLanguageFromUnknown(value: unknown): "jp" | "zh" | "en" {
  return value === "zh" || value === "en" ? value : "jp";
}

function safeTtsModelConfigName(value: string): string {
  return value.trim().replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "jp";
}

function safeTtsPresetName(value: string, fallback: string): string {
  return value.trim().replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || fallback;
}

function isLikelyAssetPath(value: string): boolean {
  return value.startsWith("assets/") || value.startsWith("tts/") || value.startsWith("plugin/") || path.isAbsolute(value);
}

function isTtsModelAssetPath(value: string): boolean {
  const root = path.resolve("assets", "tts", "model");
  const fullPath = path.resolve(value);
  const relative = path.relative(root, fullPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function migrateTtsVoiceModelConfigAssets(modelConfigName: string, model: TtsVoiceModelConfig): TtsVoiceModelConfig {
  const safeName = safeTtsModelConfigName(modelConfigName);
  const baseDir = path.join("assets", "tts", "model", safeName);
  const next: TtsVoiceModelConfig = { ...model };

  if (model.modelDir) {
    const target = path.join(baseDir, "model");
    copyAssetPathIfPresent(model.modelDir, target);
    next.modelDir = normalizeAssetPath(target);
  }
  if (model.referenceAudio) {
    const extension = isLikelyAssetPath(model.referenceAudio) ? path.extname(model.referenceAudio) || ".wav" : ".wav";
    const target = path.join(baseDir, `reference${extension}`);
    copyAssetPathIfPresent(model.referenceAudio, target);
    next.referenceAudio = normalizeAssetPath(target);
  }
  if (model.referenceText) {
    const target = path.join(baseDir, "reference.txt");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (isLikelyAssetPath(model.referenceText)) {
      copyAssetPathIfPresent(model.referenceText, target);
    } else {
      fs.writeFileSync(target, model.referenceText);
    }
    next.referenceText = normalizeAssetPath(target);
  }

  return next;
}

function copyAssetPathIfPresent(sourcePath: string, targetPath: string): void {
  if (!isLikelyAssetPath(sourcePath)) return;
  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);
  if (source === target) return;
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stat = fs.statSync(source) as { isFile(): boolean; isDirectory?: () => boolean };
  if (typeof stat.isDirectory === "function" ? stat.isDirectory() : !stat.isFile()) {
    (fs as any).cpSync(source, target, { recursive: true });
  } else {
    fs.writeFileSync(target, fs.readFileSync(source));
  }
}

function normalizeAssetPath(value: string): string {
  return value.split(path.sep).join("/");
}

function ttsPresetRoot(modelConfigName: string, assetRoot = "assets"): string {
  return path.join(assetRoot, "tts", "preset", safeTtsPresetName(modelConfigName, "jp"));
}

function ttsPresetModelDir(modelConfigName: string): string {
  return normalizeAssetPath(path.join(ttsPresetRoot(modelConfigName), "model"));
}

function ttsPresetReferenceTextPath(modelConfigName: string, assetRoot = "assets"): string {
  return normalizeAssetPath(path.join(ttsPresetRoot(modelConfigName, assetRoot), "reference.txt"));
}

function ttsPresetReferenceAudioPath(modelConfigName: string): string | undefined {
  const root = ttsPresetRoot(modelConfigName);
  for (const candidate of ["reference.wav", "reference.mp3", "reference.ogg", "reference.opus", "reference.m4a"]) {
    const filePath = path.join(root, candidate);
    if (fs.existsSync(filePath)) return normalizeAssetPath(filePath);
  }
  try {
    const match = fs.readdirSync(root).find((entry) => /^reference\.[\w-]+$/i.test(entry));
    return match ? normalizeAssetPath(path.join(root, match)) : undefined;
  } catch {
    return undefined;
  }
}

function readTtsPresetReferenceText(modelConfigName: string): string | undefined {
  const filePath = ttsPresetReferenceTextPath(modelConfigName);
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  return undefined;
}

function writeTtsPresetReferenceText(modelConfigName: string, value: string, assetRoot = "assets"): void {
  const filePath = ttsPresetReferenceTextPath(modelConfigName, assetRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function readTtsConfigForAdmin(context: AdminRoutesContext): TtsPluginConfig {
  return readTtsPluginConfig(ttsConfigPath(context));
}

function writeTtsConfig(context: AdminRoutesContext, config: TtsPluginConfig): void {
  const filePath = ttsConfigPath(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(canonicalTtsConfig(config), null, 2)}\n`);
}

async function uploadGenericPluginAsset(
  context: AdminRoutesContext,
  pluginId: string,
  assetKey: string,
  request: any
): Promise<{ config: TtsAdminConfig; assetPath: string } | { error: string; statusCode?: number }> {
  const config = readTtsConfigForAdmin(context);
  const fileName = safePluginAssetFileName(decodeHeaderFileName(optionalString(request.headers?.["x-file-name"]) ?? ""));
  const relativeDir = decodeHeaderFileName(optionalString(request.headers?.["x-relative-dir"]) ?? "");
  const maxBytes = assetKey === "model" ? maxPluginModelAssetUploadBytes : maxPluginAssetUploadBytes;
  const body = await readRawBody(request, { maxBytes });
  if (body.length === 0) return { error: "empty_upload" };

  const presetName = decodeHeaderFileName(optionalString(request.headers?.["x-preset-name"]) ?? "");
  const assetPath = pluginId === "tts"
    ? resolveTtsModelAssetPathForUpload(config, assetKey, fileName, relativeDir, presetName, context.pluginConfigs?.tts?.assetRoot)
    : resolvePluginAssetPathForUpload(pluginId, assetKey, fileName, relativeDir);
  fs.mkdirSync(path.dirname(assetPath.fullPath), { recursive: true });
  fs.writeFileSync(assetPath.fullPath, body);

  const modelConfigName = safeTtsPresetName(presetName || config.voice?.modelConfigName || "jp", "jp");
  const modelConfigs = config.voice?.modelConfigs ?? {};
  const currentModel = modelConfigs[modelConfigName] ?? {};
  const next: TtsPluginConfig = {
    ...config,
    voice: {
      ...config.voice,
      modelConfigName,
      modelConfigs: {
        ...modelConfigs,
        [modelConfigName]: {
          ...currentModel
        }
      }
    }
  };
  writeTtsConfig(context, next);
  return { config: publicTtsConfig(next), assetPath: assetPath.assetPath };
}

function resolveTtsModelAssetPathForUpload(config: TtsPluginConfig, assetKey: string, fileName: string, relativeDir: string, presetName?: string, assetRoot = "assets"): { fullPath: string; assetPath: string } {
  const modelConfigName = safeTtsPresetName(presetName || config.voice?.modelConfigName || "jp", "jp");
  const root = path.resolve(assetRoot, "tts", "preset", modelConfigName);
  const effectiveFileName = fileName || defaultPluginAssetFileName(assetKey);
  const baseRelativeDir = assetKey === "model" ? "model" : "";
  const outputName = assetKey === "reference-text"
    ? "reference.txt"
    : assetKey === "reference-audio"
      ? `reference${path.extname(effectiveFileName) || ".wav"}`
      : effectiveFileName;
  const fullPath = path.resolve(root, baseRelativeDir, outputName);
  const relative = path.relative(root, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpJsonError(400, "invalid_asset_path");
  }
  return {
    fullPath,
    assetPath: path.join("assets", "tts", "preset", modelConfigName, relative).split(path.sep).join("/")
  };
}

function resolvePluginAssetPathForUpload(pluginId: string, assetKey: string, fileName: string, relativeDir: string, assetRoot = "assets"): { fullPath: string; assetPath: string } {
  const root = path.resolve(assetRoot, "plugin", pluginId);
  const normalizedRelativeDir = sanitizePluginAssetRelativePath(relativeDir);
  const effectiveFileName = fileName || defaultPluginAssetFileName(assetKey);
  const baseRelativeDir = assetKey === "model" || assetKey === "test-audio" ? assetKey : normalizedRelativeDir;
  const fullPath = path.resolve(root, baseRelativeDir, effectiveFileName);
  const relative = path.relative(root, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpJsonError(400, "invalid_asset_path");
  }
  return {
    fullPath,
    assetPath: path.join("assets", "plugin", pluginId, relative).split(path.sep).join("/")
  };
}

function defaultPluginAssetFileName(assetKey: string): string {
  if (assetKey === "reference-text") return "reference.txt";
  if (assetKey === "reference-audio") return "reference";
  return "asset";
}

function safePluginAssetFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^\w.\- ]+/g, "_").trim();
  return base || "";
}

function sanitizePluginAssetRelativePath(value: string): string {
  if (!value) return "";
  const normalized = path.normalize(value).replace(/^(\.\.(\/|\\|$))+/, "");
  return normalized === "." ? "" : normalized;
}

function isPluginAssetPath(pluginId: string, value: string, assetRoot = "assets"): boolean {
  const root = path.resolve(assetRoot, "plugin", pluginId);
  const fullPath = resolvePluginAssetPath(pluginId, value, assetRoot);
  const relative = path.relative(root, fullPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolvePluginAssetPath(pluginId: string, value: string, assetRoot = "assets"): string {
  const normalized = path.normalize(value);
  const prefix = path.join("assets", "plugin", pluginId);
  if (normalized === prefix || normalized.startsWith(`${prefix}${path.sep}`)) {
    return path.resolve(assetRoot, path.relative("assets", normalized));
  }
  return path.resolve(value);
}

function ttsConfigPath(context: AdminRoutesContext): string {
  return context.pluginConfigs?.tts?.configPath ?? "config/plugin/tts/config.json";
}

function ttsConfigMtime(context: AdminRoutesContext): string | undefined {
  try {
    const stats = fs.statSync(ttsConfigPath(context)) as { mtime?: Date; mtimeMs?: number };
    if (stats.mtime instanceof Date) return stats.mtime.toISOString();
    if (typeof stats.mtimeMs === "number") return new Date(stats.mtimeMs).toISOString();
    return undefined;
  } catch {
    return undefined;
  }
}

function publicTtsConfig(config: TtsPluginConfig): TtsAdminConfig {
  const translationPresets = config.translationPresets ?? {};
  const translationPresetName = config.translationPresetName ?? Object.keys(translationPresets)[0] ?? "default";
  const currentTranslation = translationPresets[translationPresetName] ?? {};
  const voice = config.voice ?? {};
  const modelConfigs = voice.modelConfigs ?? {};
  const modelConfigName = voice.modelConfigName ?? Object.keys(modelConfigs)[0] ?? "jp";
  const currentModel = modelConfigs[modelConfigName] ?? {};
  const conversion = config.conversion ?? { provider: "genie" as const, genie: config.remote };
  const openaiApi = conversion.openaiApi ?? {};
  const bailian = conversion.bailian ?? {};
  return {
    enabled: config.enabled,
    remote: {
      enabled: conversion.genie?.enabled ?? config.remote?.enabled ?? true,
      baseURL: conversion.genie?.baseURL ?? config.remote?.baseURL ?? "http://192.168.0.103:8767"
    },
    conversion: {
      provider: conversion.provider ?? "genie",
      genie: {
        enabled: conversion.genie?.enabled ?? config.remote?.enabled ?? true,
        baseURL: conversion.genie?.baseURL ?? config.remote?.baseURL ?? "http://192.168.0.103:8767"
      },
      openaiApi: {
        apiPresetName: openaiApi.apiPresetName,
        model: openaiApi.model ?? "higgs-audio-v3-tts",
        voice: openaiApi.voice ?? "default",
        timeoutMs: openaiApi.timeoutMs ?? 60_000,
        sampleRate: openaiApi.sampleRate ?? 32_000,
        channels: openaiApi.channels ?? 1,
        extraParamsJson: JSON.stringify(openaiApi.extraParams ?? {}, null, 2)
      },
      bailian: {
        endpoint: bailian.endpoint ?? "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        apiKey: "",
        apiKeyEnv: bailian.apiKeyEnv ?? "DASHSCOPE_API_KEY",
        workspaceId: bailian.workspaceId,
        userAgent: bailian.userAgent,
        model: bailian.model ?? "qwen3-tts-vc-2026-01-22",
        voice: bailian.voice ?? "Cherry",
        languageType: bailian.languageType ?? "Chinese",
        mode: bailian.mode ?? "server_commit",
        responseFormat: bailian.responseFormat ?? "pcm",
        timeoutMs: bailian.timeoutMs ?? 60_000,
        sampleRate: bailian.sampleRate ?? 24_000,
        channels: bailian.channels ?? 1,
        extraParamsJson: JSON.stringify(bailian.extraParams ?? {}, null, 2)
      }
    },
    translationPresetName,
    translationEditPresetName: translationPresetName,
    newTranslationPresetName: "",
    translationPresets,
    currentTranslation: {
      translationEnabled: currentTranslation.translationEnabled ?? config.translationEnabled,
      apiPresetName: currentTranslation.apiPresetName ?? config.apiPresetName,
      prompt: currentTranslation.prompt ?? config.prompt
    },
    voice: {
      modelConfigName,
      modelEditPresetName: modelConfigName,
      newModelConfigName: "",
      modelConfigs,
      currentModel: {
        ...currentModel,
        modelDir: ttsPresetModelDir(modelConfigName),
        referenceAudio: ttsPresetReferenceAudioPath(modelConfigName),
        referenceText: readTtsPresetReferenceText(modelConfigName)
      }
    }
  };
}

function canonicalTtsConfig(config: TtsPluginConfig): TtsPluginConfig {
  const translationPresets = config.translationPresets ?? {};
  const translationPresetName = config.translationPresetName ?? Object.keys(translationPresets)[0] ?? "default";
  const voice = config.voice ?? {};
  const modelConfigs = voice.modelConfigs ?? {};
  const modelConfigName = voice.modelConfigName ?? Object.keys(modelConfigs)[0] ?? "jp";
  const genie = config.conversion?.genie ?? config.remote;
  const openaiApi = config.conversion?.openaiApi;
  const bailian = config.conversion?.bailian;
  return {
    enabled: config.enabled,
    remote: {
      enabled: genie?.enabled ?? true,
      baseURL: genie?.baseURL ?? "http://192.168.0.103:8767"
    },
    conversion: {
      provider: config.conversion?.provider ?? "genie",
      genie: {
        enabled: genie?.enabled ?? true,
        baseURL: genie?.baseURL ?? "http://192.168.0.103:8767"
      },
      openaiApi: {
        apiPresetName: openaiApi?.apiPresetName,
        baseURL: openaiApi?.baseURL,
        apiKeyEnv: openaiApi?.apiKeyEnv,
        model: openaiApi?.model ?? "higgs-audio-v3-tts",
        voice: openaiApi?.voice ?? "default",
        timeoutMs: openaiApi?.timeoutMs ?? 60_000,
        sampleRate: openaiApi?.sampleRate ?? 32_000,
        channels: openaiApi?.channels ?? 1,
        extraParams: openaiApi?.extraParams ?? {}
      },
      bailian: {
        endpoint: bailian?.endpoint ?? "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        apiKey: bailian?.apiKey,
        apiKeyEnv: bailian?.apiKeyEnv ?? "DASHSCOPE_API_KEY",
        workspaceId: bailian?.workspaceId,
        userAgent: bailian?.userAgent,
        model: bailian?.model ?? "qwen3-tts-vc-2026-01-22",
        voice: bailian?.voice ?? "Cherry",
        languageType: bailian?.languageType ?? "Chinese",
        mode: bailian?.mode ?? "server_commit",
        responseFormat: bailian?.responseFormat ?? "pcm",
        timeoutMs: bailian?.timeoutMs ?? 60_000,
        sampleRate: bailian?.sampleRate ?? 24_000,
        channels: bailian?.channels ?? 1,
        extraParams: bailian?.extraParams ?? {}
      }
    },
    translationPresetName,
    translationPresets,
    translationEnabled: config.translationEnabled,
    apiPresetName: config.apiPresetName,
    api_preset: undefined,
    prompt: config.prompt,
    voice: {
      modelConfigName,
      modelConfigs
    }
  };
}

function ttsConfigSchema(): unknown {
  return {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      remote: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          baseURL: { type: "string" }
        }
      },
      conversion: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["genie", "openai-api", "bailian"] },
          genie: { type: "object" },
          openaiApi: { type: "object" },
          bailian: { type: "object" }
        }
      },
      translationEnabled: { type: "boolean" },
      apiPresetName: { type: "string" },
      prompt: { type: "string" },
      voice: { type: "object" }
    },
    required: ["enabled", "prompt"]
  };
}

function listAdminPluginEvents(context: AdminRoutesContext, pluginId: string): unknown[] {
  const aliases = [pluginId, pluginId.replace(/-/g, " "), pluginId.replace(/-/g, "_")];
  return context.logs
    .filter((entry): entry is { id?: number; time?: string; level?: "info" | "warn" | "error"; message: string } => {
      if (!entry || typeof entry !== "object") return false;
      const message = (entry as { message?: unknown }).message;
      return typeof message === "string" && aliases.some((alias) => message.toLowerCase().includes(alias));
    })
    .slice(-50)
    .reverse()
    .map((entry) => ({
      id: entry.id,
      time: entry.time,
      level: entry.level,
      message: entry.message
    }));
}

function getTokenUsagePayload(context: AdminRoutesContext, requestUrl: string): unknown {
  const url = new URL(requestUrl, "http://localhost");
  const range = url.searchParams.get("range") ?? "24h";
  const bucketParam = url.searchParams.get("bucket");
  const bucket = bucketParam === "day" ? "day" : "hour";
  const since = tokenUsageSince(context, range);
  const agentId = url.searchParams.get("agent") || "all";
  const model = url.searchParams.get("model") || "all";
  const report = context.getTokenUsageReport({ since, bucket, agentId, model }) as Record<string, unknown>;
  return {
    range,
    bucket,
    agentId,
    model,
    timeZone: context.time.timeZone,
    ...report
  };
}

function tokenUsageSince(context: AdminRoutesContext, range: string): string {
  const hours = range === "30d" ? 24 * 30 : range === "7d" ? 24 * 7 : 24;
  return formatZonedIso(new Date(context.time.now().date.getTime() - hours * 60 * 60 * 1000), context.time.timeZone);
}

async function savePromptProfile(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const profile = context.promptProfileStore.save(body as PromptProfile);
  context.appendLog("info", `prompt profile saved: layers=${profile.layers.length} user=${profile.userName}`);
  writeJson(response, 200, {
    ok: true,
    profile,
    variables: getPromptVariablePreview(context)
  });
}

async function saveTalkPromptProfile(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const profile = context.talkPromptProfileStore.save(body as PromptProfile);
  context.appendLog("info", `talk prompt profile saved: layers=${profile.layers.length} user=${profile.userName}`);
  writeJson(response, 200, {
    ok: true,
    profile,
    variables: getPromptVariablePreview(context, context.talkPromptProfileStore)
  });
}

async function savePromptApiProfile(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const profile = normalizePromptApiProfile(body);
  const presetNames = new Set(readLLMApiPresets(context).map((entry) => entry.name));
  if (profile.chatPresetName && !presetNames.has(profile.chatPresetName)) return writeJson(response, 400, { ok: false, error: "chat_preset_not_found" });
  if (profile.talkPresetName && !presetNames.has(profile.talkPresetName)) return writeJson(response, 400, { ok: false, error: "talk_preset_not_found" });
  if (profile.memorizePresetName && !presetNames.has(profile.memorizePresetName)) return writeJson(response, 400, { ok: false, error: "memorize_preset_not_found" });
  writePromptApiProfile(context, profile);
  context.appendLog("info", `prompt api profile saved: chat=${profile.chatPresetName ?? "(current)"} talk=${profile.talkPresetName ?? "(current)"} memorize=${profile.memorizePresetName ?? "(current)"}`);
  writeJson(response, 200, { ok: true, profile });
}

function isMemoryTarget(value: string): value is "persistent" | "userPreferences" | "yesterdaySummary" {
  return value === "persistent" || value === "userPreferences" || value === "yesterdaySummary";
}

function getMemoryAdminRuntime(context: AdminRoutesContext): ReturnType<typeof createAdminMemoryRuntime> {
  context.memoryAdminRuntime ??= createAdminMemoryRuntime({
    config: context.config,
    store: context.store,
    memoryStore: context.memoryStore,
    diaryStore: context.diaryStore,
    memoryInductionPromptStore: context.memoryInductionPromptStore,
    promptProfileStore: context.promptProfileStore,
    agentState: context.agentState,
    time: context.time,
    llmRequests: { send: async (input) => context.llmRequestSender ? context.llmRequestSender(input) : context.getLLM().chat(input) },
    llmSessionRoot: () => context.llmSessionRoot?.() ?? path.join(context.config.memoryFiles.root, "llm-sessions"),
    ensureMemoryConsoleSession: (windowEndAt, windowStartAt) => context.ensureMemoryConsoleSession?.(windowEndAt, windowStartAt),
    resolveMemorizeApiPreset: () => resolveMemorizeApiPreset(context),
    runMemoryInductionForMessages: context.runMemoryInductionForMessages,
    appendLog: context.appendLog
  });
  return context.memoryAdminRuntime;
}

function writeServiceResult(response: any, result: { status: number; body: unknown }): void {
  writeJson(response, result.status, result.body);
}

function getPromptVariablePreview(context: AdminRoutesContext, store: PromptProfileStore = context.promptProfileStore): LLMTextVariables {
  const target = resolvePromptPreviewTarget(context);
  const receivedTime = context.time.now();
  return promptVariables(store.get(), {
    time: context.time,
    dailyShell: context.getDailyShell(),
    dailyShellRaw: context.dailyShellStore.get(context.time.now().date, context.time.timeZone),
    appearanceDescription: context.coreProfileStore.get().appearanceDescription,
    memory: context.memoryStore.read(),
    event: {
      id: "preview",
      source: {
        plugin: target.plugin,
        accountId: target.accountId,
        channelId: target.channelId,
        userId: target.userId
      },
      session: {
        scope: "dm",
        sessionId: target.sessionId
      },
      type: "message.text",
      payload: { kind: "text", text: "" },
      meta: {
        receivedAt: receivedTime.iso,
        receivedAtUtc: receivedTime.date.toISOString()
      }
    }
  });
}

function resolvePromptPreviewTarget(context: AdminRoutesContext): { plugin: string; accountId?: string; channelId?: string; userId?: string; sessionId: string } {
  if (context.config.plugins.wechat.enabled) {
    const contact = context.wechatStateStore.listContacts()[0];
    if (contact) {
      return {
        plugin: "wechat",
        accountId: "main",
        channelId: contact.userId,
        userId: contact.userId,
        sessionId: contact.sessionId
      };
    }
  }
  const contact = context.feishuPairingStore.list()[0];
  if (contact) {
    return {
      plugin: "feishu",
      accountId: "main",
      channelId: contact.channelId,
      userId: contact.channelId ? undefined : contact.userId,
      sessionId: contact.sessionId ?? contact.channelId ?? contact.userId ?? "preview"
    };
  }
  return { plugin: "wechat", accountId: "main", channelId: "preview", userId: "preview", sessionId: "preview" };
}

function getVisiblePromptTools(context: AdminRoutesContext, store: PromptProfileStore = context.promptProfileStore): Array<{ name: string; description?: string }> {
  const profile = store.get();
  const plugins = [context.messagingTools, context.photoTools, context.shellTools, context.sleepCocoonTools];
  return plugins.flatMap((plugin) => plugin.listTools().filter((tool) => isToolVisibleInPromptProfile(profile, tool.name)).map((tool) => ({
    name: tool.name,
    description: tool.description
  })));
}

function getAdminTools(context: AdminRoutesContext): Array<{
  pluginId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const variables = getAdminTextVariables(context, resolvePromptPreviewTarget(context));
  return getAdminToolPlugins(context).flatMap((plugin) => plugin.listTools().map((tool) => ({
    pluginId: plugin.id,
    name: tool.name,
    description: String(renderLLMValue(tool.description, variables)),
    inputSchema: renderLLMValue(tool.inputSchema, variables) as Record<string, unknown>
  })));
}

async function previewToolResult(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const toolName = requiredString(body.toolName);
  const pluginId = optionalString(body.pluginId);
  const input = body.input && typeof body.input === "object" && !Array.isArray(body.input)
    ? body.input as Record<string, unknown>
    : {};
  const plugin = getAdminToolPlugins(context)
    .find((candidate) => (!pluginId || candidate.id === pluginId) && candidate.listTools().some((tool) => tool.name === toolName));
  if (!toolName || !plugin) {
    writeJson(response, 400, { ok: false, error: "unknown_tool" });
    return;
  }

  const unsafeReason = unsafePreviewReason(toolName, input);
  if (unsafeReason) {
    writeJson(response, 400, {
      ok: false,
      toolName,
      pluginId: plugin.id,
      error: unsafeReason,
      content: `error: ${unsafeReason}`
    });
    return;
  }

  const targetPlugin = body.targetPlugin === "wechat" ? "wechat" : "feishu";
  const target = resolveAdminMessagingTarget(context, targetPlugin) ?? resolvePromptPreviewTarget(context);
  try {
    const result = await plugin.execute({
      id: `admin_preview_${toolName}_${Date.now()}`,
      toolName,
      input: { ...input, __preview: true },
      requester: {
        plugin: target.plugin,
        accountId: target.accountId,
        channelId: target.channelId,
        userId: target.userId
      },
      session: {
        scope: "dm",
        sessionId: target.sessionId
      }
    });
    context.appendLog(result.ok ? "info" : "warn", `tool preview ${plugin.id}/${toolName}: ${result.ok ? "ok" : result.error ?? "failed"}`);
    writeJson(response, result.ok ? 200 : 400, {
      ok: result.ok,
      pluginId: plugin.id,
      toolName,
      targetPlugin: target.plugin,
      content: formatToolResultForLLM(result, getAdminTextVariables(context, target)),
      result
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    context.appendLog("warn", `tool preview ${plugin.id}/${toolName} failed: ${reason}`);
    writeJson(response, 500, {
      ok: false,
      pluginId: plugin.id,
      toolName,
      error: reason,
      content: `error: ${reason}`
    });
  }
}

function getAdminToolPlugins(context: AdminRoutesContext): ToolPlugin[] {
  return [context.messagingTools, context.photoTools, context.shellTools, context.bookcaseTools, context.sleepCocoonTools];
}

function unsafePreviewReason(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === "send_chat" || toolName === "send_feishu" || toolName === "send_wechat" || toolName === "send_message") {
    return "send_chat cannot run from tool preview";
  }
  if (toolName === "selfie") return "selfie cannot run from tool preview";
  if (toolName === "wardrobe" && input.action === "switch") return "wardrobe switch cannot run from tool preview";
  return undefined;
}

function getShellConfig(context: AdminRoutesContext): unknown {
  const config = context.dailyShellStore.getConfig(context.time.now().date, context.time.timeZone);
  const variables = buildLLMTextVariables({
    userName: context.promptProfileStore.get().userName,
    time: context.time,
    dailyShellRaw: config.daily,
    appearanceDescription: context.coreProfileStore.get().appearanceDescription
  });
  return {
    ...config,
    todayVariables: {
      dailyShell: variables.dailyShell,
      outfit: variables.outfit
    }
  };
}

type ShellUiOrder = Record<ShellCategory, string[]>;

function shellUiOrderPath(): string {
  return path.join("apps", "api", "admin-ui", "shell-order.json");
}

function readShellUiOrder(): ShellUiOrder {
  const empty: ShellUiOrder = { personalities: [], relationships: [], outfits: [] };
  const filePath = shellUiOrderPath();
  if (!fs.existsSync(filePath)) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ShellUiOrder>;
    return {
      personalities: normalizeIdList(parsed.personalities),
      relationships: normalizeIdList(parsed.relationships),
      outfits: normalizeIdList(parsed.outfits)
    };
  } catch {
    return empty;
  }
}

async function saveShellUiOrder(request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const category = requiredString(body.category);
  if (!isShellCategory(category)) {
    writeJson(response, 400, { ok: false, error: "unknown_shell_category" });
    return;
  }
  const order = normalizeIdList(body.order);
  const current = readShellUiOrder();
  current[category] = order;
  const filePath = shellUiOrderPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(current, null, 2)}\n`);
  writeJson(response, 200, { ok: true, order: current });
}

function normalizeIdList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && id.length > 0).filter((id, index, ids) => ids.indexOf(id) === index)
    : [];
}

async function saveShellSettings(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const rolloverHour = numberFromUnknown(body.rolloverHour, context.dailyShellStore.getSettings().rolloverHour);
  if (!Number.isInteger(rolloverHour) || rolloverHour < 0 || rolloverHour > 23) {
    writeJson(response, 400, { ok: false, error: "invalid_rollover_hour" });
    return;
  }
  const settings = context.dailyShellStore.saveSettings({ rolloverHour });
  context.appendLog("info", `shell settings saved: rolloverHour=${settings.rolloverHour}`);
  writeJson(response, 200, { ok: true, ...context.dailyShellStore.getConfig(context.time.now().date, context.time.timeZone) });
}

async function saveShellOption(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const category = requiredString(body.category);
  if (!isShellCategory(category)) {
    writeJson(response, 400, { ok: false, error: "unknown_shell_category" });
    return;
  }
  const option = body.option;
  if (!option || typeof option !== "object" || Array.isArray(option)) {
    writeJson(response, 400, { ok: false, error: "invalid_shell_option" });
    return;
  }
  try {
    const saved = context.dailyShellStore.saveOption(category, option as ShellOption, optionalString(body.previousId));
    context.appendLog("info", `shell option saved: ${category}/${saved.id}`);
    writeJson(response, 200, { ok: true, option: saved });
  } catch (error) {
    writeJson(response, 400, { ok: false, error: error instanceof Error ? error.message : "invalid_shell_option" });
  }
}

async function deleteShellOption(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const category = requiredString(body.category);
  const id = requiredString(body.id);
  if (!isShellCategory(category)) {
    writeJson(response, 400, { ok: false, error: "unknown_shell_category" });
    return;
  }
  if (!id) {
    writeJson(response, 400, { ok: false, error: "missing_shell_id" });
    return;
  }
  context.dailyShellStore.deleteOption(category, id);
  const order = readShellUiOrder();
  order[category] = order[category].filter((item) => item !== id);
  const filePath = shellUiOrderPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(order, null, 2)}\n`);
  context.appendLog("info", `shell option deleted: ${category}/${id}`);
  writeJson(response, 200, { ok: true, order });
}

function isShellCategory(value: string): value is ShellCategory {
  return value === "personalities" || value === "relationships" || value === "outfits";
}

function decodeHeaderFileName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function serveShellAsset(context: AdminRoutesContext, rawName: string, response: any): void {
  const normalized = path.normalize(decodeHeaderFileName(rawName));
  const fullPath = path.resolve(context.config.memoryFiles.root, "shell", normalized);
  const root = path.resolve(context.config.memoryFiles.root, "shell");
  const relative = path.relative(root, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("invalid asset path");
    return;
  }
  if (!fs.existsSync(fullPath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  const extension = path.extname(fullPath).toLowerCase();
  const contentType = extension === ".png"
    ? "image/png"
    : extension === ".jpg" || extension === ".jpeg"
      ? "image/jpeg"
      : extension === ".webp"
        ? "image/webp"
        : extension === ".gif"
          ? "image/gif"
          : "application/octet-stream";
  response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  fs.createReadStream(fullPath).pipe(response);
}

function serveTtsAsset(context: AdminRoutesContext, rawName: string, response: any): void {
  const normalized = path.normalize(decodeHeaderFileName(rawName));
  const outputDir = resolveTtsOutputDir(context);
  const fullPath = path.resolve(outputDir, normalized);
  const relative = path.relative(outputDir, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("invalid asset path");
    return;
  }
  if (!fs.existsSync(fullPath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  const extension = path.extname(fullPath).toLowerCase();
  const contentType = extension === ".opus"
    ? "audio/ogg"
    : extension === ".wav"
      ? "audio/wav"
      : extension === ".mp3"
        ? "audio/mpeg"
        : "application/octet-stream";
  response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  fs.createReadStream(fullPath).pipe(response);
}

async function uploadTtsReferenceAudio(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readRawBody(request, { maxBytes: maxTtsReferenceUploadBytes });
  if (body.length === 0) {
    writeJson(response, 400, { ok: false, error: "empty_upload" });
    return;
  }
  const referenceText = decodeHeaderFileName(optionalString(request.headers?.["x-reference-text"]) ?? "").trim();
  if (!referenceText) {
    writeJson(response, 400, { ok: false, error: "reference_text_required" });
    return;
  }
  const fileName = decodeHeaderFileName(optionalString(request.headers?.["x-file-name"]) ?? "");
  const extension = path.extname(fileName).toLowerCase();
  if (![".wav", ".mp3", ".m4a"].includes(extension)) {
    writeJson(response, 400, { ok: false, error: "unsupported_reference_audio_type" });
    return;
  }
  const referencePath = resolveTtsAssetPath(context, context.config.tts.genieReferenceAudio);
  const mossReferencePath = resolveTtsAssetPath(context, context.config.tts.mossReferenceAudio);
  const referenceTextPath = resolveTtsAssetPath(context, context.config.tts.genieReferenceText);
  fs.mkdirSync(path.dirname(referencePath), { recursive: true });
  fs.mkdirSync(path.dirname(mossReferencePath), { recursive: true });
  fs.mkdirSync(path.dirname(referenceTextPath), { recursive: true });
  const tempDir = path.join(path.dirname(referencePath), `.alice-tts-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const inputPath = path.join(tempDir, `source${extension}`);
  const convertedPath = path.join(tempDir, "reference.wav");
  try {
    fs.writeFileSync(inputPath, body);
    const codecConfig = readMossCodecConfig(context);
    await convertReferenceAudio(inputPath, convertedPath, context.config.tts.mossFfmpegCommand, codecConfig);
    fs.renameSync(convertedPath, referencePath);
    if (path.resolve(mossReferencePath) !== path.resolve(referencePath)) {
      fs.writeFileSync(mossReferencePath, fs.readFileSync(referencePath));
    }
    fs.writeFileSync(referenceTextPath, Buffer.from(`${referenceText}\n`, "utf8"));
    const stat = fs.statSync(referencePath);
    context.appendLog("info", `tts reference audio converted: ${fileName || "upload"} -> ${referencePath} ${codecConfig.sampleRate}Hz/${codecConfig.channels}ch max=${maxTtsReferenceDurationSeconds}s`);
    writeJson(response, 200, {
      ok: true,
      referenceAudio: context.config.tts.genieReferenceAudio,
      mossReferenceAudio: context.config.tts.mossReferenceAudio,
      referenceText: context.config.tts.genieReferenceText,
      sourceFileName: fileName,
      sourceSize: body.length,
      size: stat.size,
      sampleRate: codecConfig.sampleRate,
      channels: codecConfig.channels,
      format: "pcm_s16le_wav",
      maxDurationSeconds: maxTtsReferenceDurationSeconds
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.appendLog("warn", `tts reference audio convert failed: ${message}`);
    writeJson(response, 400, { ok: false, error: message });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function generateTtsPreview(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const text = requiredString(body.text) || "你好，我是 Alice。";
  if (Array.from(text).length > 240) {
    writeJson(response, 400, { ok: false, error: "text_too_long" });
    return;
  }
  try {
    await ensureTtsReferenceWithinLimit(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.appendLog("warn", `tts reference audio guard failed: ${message}`);
    writeJson(response, 400, { ok: false, error: message });
    return;
  }
  const synthesizer = createConfiguredVoiceSynthesizer(context.config.tts, {
    appendLog: context.appendLog
  });
  try {
    const result = await synthesizer({ text, time: context.time });
    const audioUrl = ttsAudioUrl(context, result.filePath);
    context.appendLog("info", `tts preview generated: ${result.assetId}`);
    writeJson(response, 200, {
      ok: true,
      text,
      assetId: result.assetId,
      filePath: result.filePath,
      audioUrl
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.appendLog("warn", `tts preview failed: ${message}`);
    writeJson(response, 500, { ok: false, error: message });
  } finally {
    await synthesizer.shutdown?.();
  }
}

function resolveTtsOutputDir(context: AdminRoutesContext): string {
  return resolveTtsAssetPath(context, context.config.tts.mossOutputDir);
}

function resolveTtsAssetPath(context: AdminRoutesContext, assetPath: string): string {
  const assetRoot = path.resolve(context.pluginConfigs?.tts?.assetRoot ?? "assets");
  const fullPath = path.isAbsolute(assetPath)
    ? assetPath
    : path.normalize(assetPath) === "assets" || path.normalize(assetPath).startsWith(`assets${path.sep}`)
      ? path.resolve(assetPath)
      : path.resolve(assetRoot, assetPath);
  const relative = path.relative(assetRoot, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpJsonError(400, "tts_asset_path_outside_assets");
  }
  return fullPath;
}

function ttsAudioUrl(context: AdminRoutesContext, filePath: string): string {
  const outputDir = resolveTtsOutputDir(context);
  const relative = path.relative(outputDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("generated tts file is outside output directory");
  return `/admin/assets/tts/${relative.split(path.sep).map(encodeURIComponent).join("/")}`;
}

function readMossCodecConfig(context: AdminRoutesContext): { sampleRate: number; channels: number } {
  const fallback = { sampleRate: 48_000, channels: 2 };
  const metaPath = path.join(resolveTtsAssetPath(context, context.config.tts.mossModelDir), "MOSS-Audio-Tokenizer-Nano-ONNX", "codec_browser_onnx_meta.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { codec_config?: { sample_rate?: unknown; channels?: unknown } };
    const sampleRate = Number(parsed.codec_config?.sample_rate);
    const channels = Number(parsed.codec_config?.channels);
    if (Number.isInteger(sampleRate) && sampleRate > 0 && Number.isInteger(channels) && channels > 0) {
      return { sampleRate, channels };
    }
  } catch {
    // Use the current MOSS Nano defaults when metadata is not available.
  }
  return fallback;
}

async function ensureTtsReferenceWithinLimit(context: AdminRoutesContext): Promise<void> {
  const referencePath = resolveTtsAssetPath(context, context.config.tts.genieReferenceAudio);
  if (!fs.existsSync(referencePath)) throw new Error("TTS reference audio was not found");
  const codecConfig = readMossCodecConfig(context);
  const maxBytes = maxTtsReferencePcmBytes(codecConfig);
  const stat = fs.statSync(referencePath);
  if (stat.size <= maxBytes) return;
  const tempDir = path.join(path.dirname(referencePath), `.alice-tts-reference-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const trimmedPath = path.join(tempDir, "reference.wav");
  try {
    await convertReferenceAudio(referencePath, trimmedPath, context.config.tts.mossFfmpegCommand, codecConfig);
    fs.renameSync(trimmedPath, referencePath);
    const mossReferencePath = resolveTtsAssetPath(context, context.config.tts.mossReferenceAudio);
    if (path.resolve(mossReferencePath) !== path.resolve(referencePath)) {
      fs.mkdirSync(path.dirname(mossReferencePath), { recursive: true });
      fs.writeFileSync(mossReferencePath, fs.readFileSync(referencePath));
    }
    context.appendLog("warn", `tts reference audio was too large and has been trimmed to ${maxTtsReferenceDurationSeconds}s`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function maxTtsReferencePcmBytes(codecConfig: { sampleRate: number; channels: number }): number {
  const wavHeaderAndSlack = 128 * 1024;
  return (codecConfig.sampleRate * codecConfig.channels * 2 * maxTtsReferenceDurationSeconds) + wavHeaderAndSlack;
}

async function convertReferenceAudio(
  inputPath: string,
  outputPath: string,
  ffmpegCommand: string,
  codecConfig: { sampleRate: number; channels: number }
): Promise<void> {
  const resolvedFfmpegCommand = resolveFfmpegCommand(ffmpegCommand);
  await new Promise<void>((resolve, reject) => {
    const child = childProcess.spawn(resolvedFfmpegCommand, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", inputPath,
      "-vn",
      "-t", String(maxTtsReferenceDurationSeconds),
      "-acodec", "pcm_s16le",
      "-ar", String(codecConfig.sampleRate),
      "-ac", String(codecConfig.channels),
      outputPath
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, ttsReferenceConvertTimeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      const code = typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : undefined;
      reject(new Error(code === "ENOENT"
        ? "ffmpeg was not found; install ffmpeg-static or set MOSS_TTS_FFMPEG_COMMAND"
        : error.message));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`ffmpeg reference audio conversion timed out after ${ttsReferenceConvertTimeoutMs}ms`));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg reference audio conversion failed: ${stderr.slice(0, 500) || `exit ${code ?? "unknown"}`}`));
    });
  });
  const stat = fs.statSync(outputPath);
  if (!stat.isFile() || stat.size <= 0) throw new Error("converted reference audio is empty");
}

function resolveFfmpegCommand(ffmpegCommand: string): string {
  if (ffmpegCommand !== "ffmpeg-static") return ffmpegCommand;
  try {
    const resolved = require("ffmpeg-static") as unknown;
    if (typeof resolved === "string" && resolved) return resolved;
  } catch {
    // Fall through to a clear error below.
  }
  throw new Error("ffmpeg-static is not installed or did not expose an ffmpeg binary path");
}

async function uploadShellOutfitImage(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readRawBody(request, { maxBytes: 10 * 1024 * 1024 });
  if (body.length === 0) {
    writeJson(response, 400, { ok: false, error: "empty_upload" });
    return;
  }
  const shellId = requiredString(decodeHeaderFileName(optionalString(request.headers?.["x-shell-id"]) ?? ""));
  if (!shellId) {
    writeJson(response, 400, { ok: false, error: "missing_shell_id" });
    return;
  }
  const safeId = shellId.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || `outfit_${Date.now()}`;
  const outfitDir = path.join(context.config.memoryFiles.root, "shell", "outfits");
  const storedName = `${safeId}.jpg`;
  const fullPath = path.join(outfitDir, storedName);
  fs.mkdirSync(outfitDir, { recursive: true });
  fs.writeFileSync(fullPath, body);
  const imageUrl = path.join(context.config.memoryFiles.root, "shell", "outfits", storedName);
  context.appendLog("info", `shell outfit image uploaded: ${imageUrl}`);
  writeJson(response, 200, { ok: true, imageUrl });
}

async function executeMessagingTool(
  context: AdminRoutesContext,
  request: any,
  response: any,
  toolName: "check_chat" | "search_messages" | "send_chat",
  plugin?: "feishu" | "wechat"
): Promise<void> {
  const body = await readJsonBody(request);
  const target = plugin ? resolveAdminMessagingTarget(context, plugin) : undefined;
  if (plugin && !target) {
    writeJson(response, 400, { ok: false, error: `missing_${plugin}_target` });
    return;
  }
  const result = await context.messagingTools.execute({
    id: `admin_${toolName}_${Date.now()}`,
    toolName,
    input: body,
    requester: target ? {
      plugin: target.plugin,
      accountId: target.accountId,
      channelId: target.channelId,
      userId: target.userId
    } : undefined,
    session: target ? {
      scope: "dm",
      sessionId: target.sessionId
    } : undefined
  });
  context.appendLog(result.ok ? "info" : "warn", `messaging tool ${toolName}${target ? ` plugin=${target.plugin} session=${target.sessionId}` : ""}: ${result.ok ? "ok" : result.error ?? "failed"}`);
  writeJson(response, result.ok ? 200 : 400, {
    ok: result.ok,
    content: formatToolResultForLLM(result, target ? getAdminTextVariables(context, target) : undefined),
    error: result.error
  });
}

function getAdminTextVariables(
  context: AdminRoutesContext,
  target: { plugin: string; accountId?: string; channelId?: string; userId?: string; sessionId: string }
): LLMTextVariables {
  const receivedTime = context.time.now();
  return buildLLMTextVariables({
    userName: context.promptProfileStore.get().userName,
    time: context.time,
    dailyShell: context.getDailyShell(),
    dailyShellRaw: context.dailyShellStore.get(context.time.now().date, context.time.timeZone),
    appearanceDescription: context.coreProfileStore.get().appearanceDescription,
    event: {
      id: "admin_tool_preview",
      source: {
        plugin: target.plugin,
        accountId: target.accountId,
        channelId: target.channelId,
        userId: target.userId
      },
      session: {
        scope: "dm",
        sessionId: target.sessionId
      },
      type: "message.text",
      payload: { kind: "text", text: "" },
      meta: { receivedAt: receivedTime.iso, receivedAtUtc: receivedTime.date.toISOString() }
    }
  });
}

function resolveAdminMessagingTarget(context: AdminRoutesContext, plugin: "feishu" | "wechat") {
  if (plugin === "wechat") {
    const contact = context.wechatStateStore.listContacts()[0];
    if (!contact) return undefined;
    return {
      plugin: "wechat",
      accountId: "main",
      channelId: contact.userId,
      userId: contact.userId,
      sessionId: contact.sessionId
    };
  }
  return resolveFeishuTestTarget(context, {});
}

function formatToolResultForLLM(result: { ok: boolean; output?: unknown; error?: string }, variables: LLMTextVariables = {}): string {
  return renderToolResultForLLM(result, variables);
}

async function sendFeishuTest(context: AdminRoutesContext, request: any, response: any, kind: "markdown" | "image" | "audio"): Promise<void> {
  const body = await readJsonBody(request);
  const target = resolveFeishuTestTarget(context, body);
  if (!target) {
    writeJson(response, 400, { ok: false, error: kind === "markdown" ? "missing_target" : "missing_target_or_asset" });
    return;
  }

  const content = contentForTest(kind, body);
  if (!content) {
    writeJson(response, 400, { ok: false, error: "missing_target_or_asset" });
    return;
  }

  const createdTime = context.time.now();
  await context.feishu.send({
    id: `test_${kind}_${Date.now()}`,
    target,
    content,
    meta: {
      createdAt: createdTime.iso,
      createdAtUtc: createdTime.date.toISOString(),
      urgency: "normal"
    }
  });
  const summary = "markdown" in content ? content.markdown : content.assetId;
  context.appendMessageLog({
    direction: "outbound",
    plugin: "feishu",
    kind,
    target: target.channelId ?? target.userId,
    sessionId: target.sessionId,
    summary: summary ?? kind
  });
  context.appendLog("info", `feishu ${kind} test sent`);
  writeJson(response, 200, { ok: true });
}

function contentForTest(kind: "markdown" | "image" | "audio", body: Record<string, unknown>) {
  if (kind === "markdown") {
    return {
      kind: "markdown" as const,
      markdown: requiredString(body.markdown) || "**Alice markdown test**\n\n- item one\n- item two\n\n`code`"
    };
  }

  const assetId = requiredString(body.assetId);
  if (!assetId) return undefined;
  const assetPath = resolveAdminAssetPath(assetId, {
    allowedExtensions: kind === "image" ? [".png", ".jpg", ".jpeg", ".gif", ".webp"] : [".opus", ".mp3", ".m4a", ".wav"],
    maxBytes: kind === "image" ? 10 * 1024 * 1024 : 20 * 1024 * 1024
  });
  return { kind, assetId: assetPath };
}

async function saveLLMApiPreset(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const name = requiredString(body.name);
  if (!name) return writeJson(response, 400, { ok: false, error: "missing_name" });
  const preset = parseLLMApiPresetBody(context, body, name);
  if ("error" in preset) return writeJson(response, 400, { ok: false, error: preset.error });
  const presets = readLLMApiPresets(context).filter((entry) => entry.name !== name);
  presets.push(preset);
  writeLLMApiPresets(context, presets);
  context.appendLog("info", `llm api preset saved: ${name}`);
  writeJson(response, 200, { ok: true, presets: publicLLMApiPresets(sortLLMApiPresets(presets)) });
}

async function renameLLMApiPreset(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const from = requiredString(body.from);
  const to = requiredString(body.to);
  if (!from || !to) return writeJson(response, 400, { ok: false, error: "missing_name" });
  const presets = readLLMApiPresets(context);
  if (!presets.some((entry) => entry.name === from)) return writeJson(response, 404, { ok: false, error: "preset_not_found" });
  if (from !== to && presets.some((entry) => entry.name === to)) return writeJson(response, 409, { ok: false, error: "preset_exists" });
  const renamed = presets.map((entry) => entry.name === from ? { ...entry, name: to } : entry);
  writeLLMApiPresets(context, renamed);
  context.appendLog("info", `llm api preset renamed: ${from} -> ${to}`);
  writeJson(response, 200, { ok: true, presets: publicLLMApiPresets(sortLLMApiPresets(renamed)) });
}

async function deleteLLMApiPreset(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const name = requiredString(body.name);
  if (!name) return writeJson(response, 400, { ok: false, error: "missing_name" });
  const presets = readLLMApiPresets(context);
  const next = presets.filter((entry) => entry.name !== name);
  if (next.length === presets.length) return writeJson(response, 404, { ok: false, error: "preset_not_found" });
  writeLLMApiPresets(context, next);
  context.appendLog("info", `llm api preset deleted: ${name}`);
  writeJson(response, 200, { ok: true, presets: publicLLMApiPresets(sortLLMApiPresets(next)) });
}

function parseLLMApiPresetBody(context: AdminRoutesContext, body: Record<string, unknown>, name: string): LLMApiPreset | { error: string } {
  const existing = readLLMApiPresets(context).find((entry) => entry.name === name);
  const baseURL = requiredString(body.baseURL);
  const apiKey = optionalString(body.apiKey) ?? existing?.apiKey;
  const model = requiredString(body.model);
  const temperature = numberFromUnknown(body.temperature, existing?.temperature ?? 0.2);
  const timeoutMs = numberFromUnknown(body.timeoutMs, existing?.timeoutMs ?? 60_000);
  const stream = body.stream === undefined ? existing?.stream ?? true : booleanFromUnknown(body.stream);
  const maxContinuousRounds = optionalPositiveInteger(body.maxContinuousRounds) ?? existing?.maxContinuousRounds;
  const extraParamsResult = parseJsonObject(optionalString(body.extraParams) ?? "{}");
  const followupExtraParamsResult = parseJsonObject(optionalString(body.followupExtraParams) ?? "{}");
  if (baseURL && !isValidHttpUrl(baseURL)) return { error: "invalid_base_url" };
  if (!model) return { error: "missing_model" };
  if (temperature < 0 || temperature > 2) return { error: "invalid_temperature" };
  if (timeoutMs < 1_000) return { error: "invalid_timeout_ms" };
  if (!extraParamsResult.ok) return { error: "invalid_extra_params" };
  if (!followupExtraParamsResult.ok) return { error: "invalid_followup_extra_params" };
  return { name, baseURL, apiKey, model, temperature, timeoutMs, stream, extraParams: extraParamsResult.value, followupExtraParams: followupExtraParamsResult.value, maxContinuousRounds };
}

function readLLMApiPresets(context: AdminRoutesContext): LLMApiPreset[] {
  const filePath = llmApiPresetsPath(context);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { presets?: LLMApiPreset[] } | LLMApiPreset[];
    const presets = Array.isArray(parsed) ? parsed : Array.isArray(parsed.presets) ? parsed.presets : [];
    return sortLLMApiPresets(presets.map(normalizeLLMApiPreset).filter((entry): entry is LLMApiPreset => Boolean(entry)));
  } catch {
    return [];
  }
}

function writeLLMApiPresets(context: AdminRoutesContext, presets: LLMApiPreset[]): void {
  const filePath = llmApiPresetsPath(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ presets: sortLLMApiPresets(presets) }, null, 2)}\n`);
}

function normalizeLLMApiPreset(value: Partial<LLMApiPreset>): LLMApiPreset | undefined {
  if (!value || typeof value !== "object" || !value.name || !value.model) return undefined;
  return {
    name: String(value.name),
    baseURL: typeof value.baseURL === "string" ? value.baseURL : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : undefined,
    model: String(value.model),
    temperature: Number.isFinite(Number(value.temperature)) ? Number(value.temperature) : 0.2,
    timeoutMs: Number.isFinite(Number(value.timeoutMs)) ? Number(value.timeoutMs) : 60_000,
    stream: value.stream !== false,
    extraParams: value.extraParams && typeof value.extraParams === "object" && !Array.isArray(value.extraParams) ? value.extraParams : {},
    followupExtraParams: value.followupExtraParams && typeof value.followupExtraParams === "object" && !Array.isArray(value.followupExtraParams) ? value.followupExtraParams : {},
    maxContinuousRounds: optionalPositiveInteger(value.maxContinuousRounds)
  };
}

function sortLLMApiPresets(presets: LLMApiPreset[]): LLMApiPreset[] {
  return [...presets].sort((left, right) => left.name.localeCompare(right.name));
}

function llmApiPresetsPath(context: AdminRoutesContext): string {
  return path.join(context.config.memoryFiles.root, "config", "llm-api-presets.json");
}

function publicLLMApiPresets(presets: LLMApiPreset[]): LLMApiPresetView[] {
  return presets.map(publicLLMApiPreset);
}

function publicLLMApiPreset(preset: LLMApiPreset): LLMApiPresetView {
  const { apiKey, ...rest } = preset;
  return { ...rest, apiKeySet: Boolean(apiKey) };
}

function readPromptApiProfile(context: AdminRoutesContext): PromptApiProfile {
  const filePath = promptApiProfilePath(context);
  if (!fs.existsSync(filePath)) return {};
  try {
    return normalizePromptApiProfile(JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>);
  } catch {
    return {};
  }
}

function writePromptApiProfile(context: AdminRoutesContext, profile: PromptApiProfile): void {
  const filePath = promptApiProfilePath(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalizePromptApiProfile(profile), null, 2)}\n`);
}

function normalizePromptApiProfile(value: Record<string, unknown>): PromptApiProfile {
  const chatPresetName = optionalString(value.chatPresetName) ?? optionalString(value.corePresetName);
  return {
    chatPresetName,
    talkPresetName: optionalString(value.talkPresetName),
    memorizePresetName: optionalString(value.memorizePresetName)
  };
}

function resolvePromptApiPreset(context: AdminRoutesContext, kind: "chat" | "talk" | "memorize"): LLMApiPreset | undefined {
  const profile = readPromptApiProfile(context);
  const name = kind === "chat"
    ? profile.chatPresetName ?? profile.corePresetName
    : kind === "talk"
      ? profile.talkPresetName
      : profile.memorizePresetName;
  if (!name) return undefined;
  return readLLMApiPresets(context).find((entry) => entry.name === name);
}

function resolveMemorizeApiPreset(context: AdminRoutesContext): LLMApiPreset | undefined {
  return resolvePromptApiPreset(context, "memorize") ?? defaultMemorizeApiPreset(context);
}

function defaultMemorizeApiPreset(context: AdminRoutesContext): LLMApiPreset | undefined {
  const config = context.config.memorySummary;
  if (!config.enabled || !config.model) return undefined;
  return {
    name: "Memory Summary",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    stream: config.stream,
    extraParams: config.extraParams,
    followupExtraParams: config.followupExtraParams
  };
}

function promptApiProfilePath(context: AdminRoutesContext): string {
  return promptStoragePath(context.config.memoryFiles.root, "prompt-api-profile.json", ["config", "prompt-api-profile.json"]);
}

async function saveFeishuConfig(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const appId = requiredString(body.appId);
  const appSecret = optionalString(body.appSecret);
  const effectiveAppSecret = appSecret ?? context.config.plugins.feishu.accounts.main?.appSecret;
  const enabled = booleanFromUnknown(body.enabled);
  const requireMention = booleanFromUnknown(body.requireMention);
  const requestedConnectionMode = requiredString(body.connectionMode) || "websocket";
  if (requestedConnectionMode !== "webhook" && requestedConnectionMode !== "websocket") {
    writeJson(response, 400, { ok: false, error: "invalid_connection_mode" });
    return;
  }

  updateEnvFile(".env", {
    FEISHU_ENABLED: String(enabled),
    FEISHU_CONNECTION_MODE: requestedConnectionMode,
    FEISHU_APP_ID: appId,
    FEISHU_APP_SECRET: appSecret,
    FEISHU_REQUIRE_MENTION: String(requireMention)
  });
  context.config.plugins.feishu.enabled = enabled;
  context.config.plugins.feishu.connectionMode = requestedConnectionMode;
  context.config.plugins.feishu.requireMention = requireMention;
  context.config.plugins.feishu.accounts = appId && effectiveAppSecret
    ? { main: { appId, appSecret: effectiveAppSecret, name: "Agent" } }
    : {};
  context.appendLog("info", `feishu config saved: enabled=${enabled} mode=${requestedConnectionMode} appId=${appId ? maskValue(appId) : "(empty)"}`);
  writeJson(response, 200, { ok: true, restartRequired: false, config: getAdminConfig(context) });
}

async function saveWeChatConfig(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const enabled = booleanFromUnknown(body.enabled);
  const baseURL = requiredString(body.baseURL) || context.config.plugins.wechat.baseURL || "https://ilinkai.weixin.qq.com";
  const pollTimeoutMs = numberFromUnknown(body.pollTimeoutMs, context.config.plugins.wechat.pollTimeoutMs);
  if (pollTimeoutMs < 5000 || pollTimeoutMs > 120_000) {
    writeJson(response, 400, { ok: false, error: "invalid_poll_timeout_ms" });
    return;
  }
  updateEnvFile(".env", {
    WECHAT_ENABLED: String(enabled),
    WECHAT_ILINK_BASE_URL: baseURL,
    WECHAT_ILINK_POLL_TIMEOUT_MS: String(pollTimeoutMs)
  });
  context.config.plugins.wechat.enabled = enabled;
  context.config.plugins.wechat.baseURL = baseURL.replace(/\/+$/, "");
  context.config.plugins.wechat.pollTimeoutMs = pollTimeoutMs;
  context.appendLog("info", `wechat config saved: enabled=${enabled} baseURL=${context.config.plugins.wechat.baseURL}`);
  writeJson(response, 200, { ok: true, restartRequired: false, config: getAdminConfig(context) });
}

async function saveAgentConfig(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const inboundDebounceMs = numberFromUnknown(body.inboundDebounceMs, context.config.core.inboundDebounceMs);
  const timezone = requiredString(body.timezone) || context.config.core.timezone;
  const defaultTargetPlugin = normalizeDefaultTargetPlugin(body.defaultTargetPlugin, context.config.core.defaultTargetPlugin);
  if (inboundDebounceMs < 0 || inboundDebounceMs > 10_000) {
    writeJson(response, 400, { ok: false, error: "invalid_inbound_debounce_ms" });
    return;
  }
  if (!isValidTimeZone(timezone)) {
    writeJson(response, 400, { ok: false, error: "invalid_timezone" });
    return;
  }
  updateEnvFile(".env", {
    AGENT_INBOUND_DEBOUNCE_MS: String(inboundDebounceMs),
    AGENT_TIMEZONE: timezone,
    AGENT_DEFAULT_TARGET_PLUGIN: defaultTargetPlugin
  });
  context.config.core.inboundDebounceMs = inboundDebounceMs;
  context.config.core.timezone = timezone;
  context.config.core.defaultTargetPlugin = defaultTargetPlugin;
  context.setTimeZone(timezone);
  context.appendLog("info", `agent config saved: inboundDebounceMs=${inboundDebounceMs} timezone=${timezone} defaultTargetPlugin=${defaultTargetPlugin}`);
  writeJson(response, 200, { ok: true, restartRequired: false, config: getAdminConfig(context) });
}

async function saveCoreProfile(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const appearanceDescription = typeof body.appearanceDescription === "string" ? body.appearanceDescription : "";
  const profile = context.coreProfileStore.save({ appearanceDescription });
  context.appendLog("info", `core profile saved: appearanceChars=${profile.appearanceDescription.length}`);
  writeJson(response, 200, { ok: true, restartRequired: false, config: getAdminConfig(context) });
}

function normalizeDefaultTargetPlugin(value: unknown, fallback: "auto" | "wechat" | "feishu"): "auto" | "wechat" | "feishu" {
  return value === "auto" || value === "wechat" || value === "feishu" ? value : fallback;
}

async function saveAgentState(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const state = requiredString(body.state) as AgentBehaviorState;
  const intimacy = body.intimacy === undefined ? undefined : numberFromUnknown(body.intimacy, context.agentState.getSnapshot().intimacy);
  if (!AGENT_STATES.includes(state)) {
    writeJson(response, 400, { ok: false, error: "invalid_agent_state" });
    return;
  }
  let snapshot = context.agentState.setState(state, { reason: "admin" });
  if (intimacy !== undefined) snapshot = context.agentState.setIntimacy(intimacy);
  context.appendLog("info", `agent state saved: state=${snapshot.state} intimacy=${snapshot.intimacy} delay=${snapshot.responseDelayMs}`);
  writeJson(response, 200, { ok: true, state: snapshot, states: AGENT_STATES });
}

async function startFeishu(context: AdminRoutesContext, response: any): Promise<void> {
  if (Object.keys(context.config.plugins.feishu.accounts).length === 0) {
    context.appendLog("warn", "feishu start rejected: missing credentials");
    writeJson(response, 400, { ok: false, error: "missing_feishu_credentials" });
    return;
  }
  context.config.plugins.feishu.enabled = true;
  updateEnvFile(".env", { FEISHU_ENABLED: "true" });
  if (!context.runtime.feishuStarted) await context.feishu.start();
  context.runtime.feishuStarted = true;
  context.appendLog("info", "feishu runtime started");
  writeJson(response, 200, { ok: true, status: getFeishuRuntimeStatus(context) });
}

async function stopFeishu(context: AdminRoutesContext, response: any): Promise<void> {
  await context.feishu.stop();
  context.runtime.feishuStarted = false;
  context.config.plugins.feishu.enabled = false;
  updateEnvFile(".env", { FEISHU_ENABLED: "false" });
  context.appendLog("info", "feishu runtime stopped");
  writeJson(response, 200, { ok: true, status: getFeishuRuntimeStatus(context) });
}

async function startWeChat(context: AdminRoutesContext, response: any): Promise<void> {
  const credentials = context.wechatStateStore.getCredentials();
  if (!credentials?.botToken) {
    context.appendLog("warn", "wechat start rejected: not logged in");
    writeJson(response, 400, { ok: false, error: "wechat_not_logged_in" });
    return;
  }
  context.config.plugins.wechat.botToken = credentials.botToken;
  context.config.plugins.wechat.baseURL = credentials.baseURL;
  context.config.plugins.wechat.enabled = true;
  updateEnvFile(".env", { WECHAT_ENABLED: "true" });
  if (!context.runtime.wechatStarted) await context.wechat.start();
  context.runtime.wechatStarted = true;
  context.appendLog("info", "wechat runtime started");
  writeJson(response, 200, { ok: true, status: getWeChatRuntimeStatus(context) });
}

async function getWeChatLoginQRCode(context: AdminRoutesContext, response: any): Promise<void> {
  try {
    const client = createWeChatILinkClient(context.config.plugins.wechat);
    const result = await client.getLoginQRCode();
    context.appendLog("info", "wechat login qrcode requested");
    writeJson(response, 200, {
      ok: true,
      qrcode: result.qrcode,
      qrcodeUrl: result.qrcodeUrl,
      qrcodeContent: result.qrcodeContent,
      qrcodeBase64: result.qrcodeBase64,
      qrcodeSvg: result.qrcodeContent ? await QRCode.toString(result.qrcodeContent, {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 2
      }) : undefined,
      status: result.status ?? "wait"
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    context.appendLog("error", `wechat login qrcode failed: ${reason}`);
    writeJson(response, 502, { ok: false, error: reason });
  }
}

async function getWeChatLoginStatus(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const url = new URL(request.url, "http://localhost");
  const qrcode = url.searchParams.get("qrcode") ?? "";
  if (!qrcode) {
    writeJson(response, 400, { ok: false, error: "missing_qrcode" });
    return;
  }
  let result;
  try {
    const client = createWeChatILinkClient(context.config.plugins.wechat);
    result = await client.getQRCodeStatus(qrcode);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    context.appendLog("error", `wechat login status failed: ${reason}`);
    writeJson(response, 502, { ok: false, error: reason });
    return;
  }
  if (result.status === "confirmed" && result.botToken) {
    const baseURL = (result.baseURL ?? context.config.plugins.wechat.baseURL).replace(/\/+$/, "");
    context.wechatStateStore.saveCredentials({
      botToken: result.botToken,
      baseURL,
      loggedInAt: context.time.now().iso
    });
    context.config.plugins.wechat.botToken = result.botToken;
    context.config.plugins.wechat.baseURL = baseURL;
    context.config.plugins.wechat.enabled = true;
    updateEnvFile(".env", {
      WECHAT_ENABLED: "true",
      WECHAT_ILINK_BASE_URL: baseURL
    });
    if (!context.runtime.wechatStarted) await context.wechat.start();
    context.runtime.wechatStarted = true;
    context.appendLog("info", `wechat login confirmed baseURL=${baseURL}`);
  }
  writeJson(response, 200, {
    ok: true,
    status: result.status,
    configured: Boolean(context.wechatStateStore.getCredentials()),
    runtimeStarted: context.runtime.wechatStarted,
    baseURL: context.config.plugins.wechat.baseURL
  });
}

async function stopWeChat(context: AdminRoutesContext, response: any): Promise<void> {
  await context.wechat.stop();
  context.runtime.wechatStarted = false;
  context.config.plugins.wechat.enabled = false;
  context.config.plugins.wechat.botToken = context.wechatStateStore.getCredentials()?.botToken;
  updateEnvFile(".env", { WECHAT_ENABLED: "false" });
  context.appendLog("info", "wechat runtime stopped");
  writeJson(response, 200, { ok: true, status: getWeChatRuntimeStatus(context) });
}

function getAdminConfig(context: AdminRoutesContext): unknown {
  const apiProfile = readPromptApiProfile(context);
  return {
    core: context.config.core,
    coreProfile: context.coreProfileStore.get(),
    api: context.config.api,
    llm: {
      provider: "api-preset",
      chatPresetName: apiProfile.chatPresetName ?? apiProfile.corePresetName,
      talkPresetName: apiProfile.talkPresetName,
      memorizePresetName: apiProfile.memorizePresetName,
      presets: publicLLMApiPresets(readLLMApiPresets(context))
    },
    memory: {
      manualRunRequiresSleeping: context.config.memorySummary.manualRunRequiresSleeping !== false
    },
    tts: {
      backend: context.config.tts.backend,
      genieBaseURL: context.config.tts.genieBaseURL,
      genieDataDir: context.config.tts.genieDataDir,
      genieModelDir: context.config.tts.genieModelDir,
      genieCharacterName: context.config.tts.genieCharacterName,
      genieLanguage: context.config.tts.genieLanguage,
      genieReferenceAudio: context.config.tts.genieReferenceAudio,
      genieReferenceText: context.config.tts.genieReferenceText,
      genieModelAvailable: fs.existsSync(resolveTtsAssetPath(context, context.config.tts.genieModelDir)),
      genieReferenceAudioAvailable: fs.existsSync(resolveTtsAssetPath(context, context.config.tts.genieReferenceAudio)),
      genieReferenceTextAvailable: fs.existsSync(resolveTtsAssetPath(context, context.config.tts.genieReferenceText)),
      mossBaseURL: context.config.tts.mossBaseURL,
      mossReferenceAudio: context.config.tts.mossReferenceAudio,
      mossOutputDir: context.config.tts.mossOutputDir,
      mossTimeoutMs: context.config.tts.mossTimeoutMs,
      mossVoiceCloneMaxTextTokens: context.config.tts.mossVoiceCloneMaxTextTokens,
      wechatVoiceFallbackToText: context.config.tts.wechatVoiceFallbackToText
    },
    plugins: {
      feishu: {
        enabled: context.config.plugins.feishu.enabled,
        connectionMode: context.config.plugins.feishu.connectionMode,
        accountIds: Object.keys(context.config.plugins.feishu.accounts),
        appId: context.config.plugins.feishu.accounts.main?.appId,
        appSecretConfigured: Boolean(context.config.plugins.feishu.accounts.main?.appSecret),
        runtimeStarted: context.runtime.feishuStarted,
        dmPolicy: context.config.plugins.feishu.dmPolicy,
        groupPolicy: context.config.plugins.feishu.groupPolicy,
        requireMention: context.config.plugins.feishu.requireMention
      },
      wechat: {
        enabled: context.config.plugins.wechat.enabled,
        baseURL: context.config.plugins.wechat.baseURL,
        loggedIn: Boolean(context.wechatStateStore.getCredentials()),
        runtimeStarted: context.runtime.wechatStarted,
        pollTimeoutMs: context.config.plugins.wechat.pollTimeoutMs,
        credentials: maskWeChatCredentials(context.wechatStateStore.getCredentials()),
        contacts: context.wechatStateStore.listContacts()
      }
    }
  };
}

function getFeishuRuntimeStatus(context: AdminRoutesContext): unknown {
  return {
    enabled: context.config.plugins.feishu.enabled,
    configured: Object.keys(context.config.plugins.feishu.accounts).length > 0,
    runtimeStarted: context.runtime.feishuStarted,
    connectionMode: context.config.plugins.feishu.connectionMode,
    accountIds: Object.keys(context.config.plugins.feishu.accounts),
    requireMention: context.config.plugins.feishu.requireMention
  };
}

function getWeChatRuntimeStatus(context: AdminRoutesContext): unknown {
  const credentials = context.wechatStateStore.getCredentials();
  return {
    enabled: context.config.plugins.wechat.enabled,
    configured: Boolean(credentials),
    loggedIn: Boolean(credentials),
    runtimeStarted: context.runtime.wechatStarted,
    baseURL: context.config.plugins.wechat.baseURL,
    pollTimeoutMs: context.config.plugins.wechat.pollTimeoutMs,
    credentials: maskWeChatCredentials(credentials),
    contacts: context.wechatStateStore.listContacts()
  };
}

function maskWeChatCredentials(credentials: { botToken: string; baseURL: string; loggedInAt: string } | undefined): unknown {
  if (!credentials) return undefined;
  return {
    baseURL: credentials.baseURL,
    loggedInAt: credentials.loggedInAt,
    botToken: maskValue(credentials.botToken)
  };
}

function resolveFeishuTestTarget(context: AdminRoutesContext, body: Record<string, unknown>) {
  const channelId = optionalString(body.channelId);
  const userId = optionalString(body.userId);
  const firstContact = context.feishuPairingStore.list()[0];
  const receiveChannelId = channelId ?? firstContact?.channelId;
  const receiveUserId = receiveChannelId ? undefined : userId ?? firstContact?.userId;
  const sessionId = optionalString(body.sessionId) ?? firstContact?.sessionId ?? "admin-test";
  if (!receiveChannelId && !receiveUserId) return undefined;
  return { plugin: "feishu", accountId: "main", channelId: receiveChannelId, userId: receiveUserId, sessionId };
}

function handleHttpError(context: AdminRoutesContext, response: any, error: unknown): void {
  if (error instanceof HttpJsonError) return writeJson(response, error.statusCode, { ok: false, error: error.code });
  if (error instanceof AssetValidationError) return writeJson(response, 400, { ok: false, error: error.code });
  context.appendLog("error", `http request failed: ${error instanceof Error ? error.message : String(error)}`);
  writeJson(response, 500, { ok: false, error: "internal_error" });
}

function writeJson(response: any, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function writeHtml(response: any, statusCode: number, body: string): void {
  response.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text.length > 0 ? text : undefined;
}

function optionalSpeedValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : undefined;
}

function optionalPartSilenceSecondsValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : undefined;
}

function requiredString(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function numberFromUnknown(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.floor(parsed);
}

function parseJsonObject(value: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const text = value.trim();
  if (!text) return { ok: true, value: {} };
  const candidates = [
    text,
    removeTrailingJsonCommas(text),
    text.startsWith("{") ? "" : `{${text}}`,
    text.startsWith("{") ? "" : removeTrailingJsonCommas(`{${text}}`)
  ].filter(Boolean);
  for (const candidate of candidates) {
    const parsed = parseJsonObjectCandidate(candidate);
    if (parsed.ok) return parsed;
  }
  return { ok: false };
}

function parseJsonObjectCandidate(value: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, value: parsed as Record<string, unknown> };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function removeTrailingJsonCommas(value: string): string {
  return value.replace(/,\s*([}\]])/g, "$1").replace(/,\s*$/, "");
}

function booleanFromUnknown(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return false;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function maskValue(value: string): string {
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
