import type { AppConfig } from "../../../packages/config/src/index.js";
import { createOpenAICompatibleClient, type LLMClient } from "../../../core/llm/src/index.js";
import type { LLMRequestSender } from "../../../core/agent/src/llm-tool-loop.js";
import { formatZonedIso, parseZonedIso, type CurrentTimeProvider } from "../../../core/time/src/index.js";
import type { ToolPlugin } from "../../../packages/types/src/index.js";
import type { TokenUsageQuery } from "../../../packages/storage/src/token-usage-store.js";
import type { DiaryStore, SleepBoundary } from "../../../packages/storage/src/diary-store.js";
import type { StoredConversationMessage } from "../../../packages/storage/src/sqlite-store.js";
import type { AgentBehaviorState, AgentStateController } from "../../../core/agent/src/state.js";
import type { CoreProfileStore } from "../../../core/agent/src/core-profile.js";
import { buildMemoryPromptPreview, type MemoryInductionPromptStore, type MemoryRunSummary, type MemoryStore, type MemoryTarget } from "../../../core/agent/src/memory.js";
import { defaultPromptRegistry, promptVariables, type PromptProfile, type PromptProfileStore } from "../../../core/agent/src/prompts.js";
import { buildLLMTextVariables, formatToolResultForLLM as renderToolResultForLLM, renderLLMValue, type LLMTextVariables } from "../../../core/text-renderer/src/index.js";
import type { DailyShellStore, ShellCategory, ShellOption } from "../../../core/agent/src/shells.js";
import { HttpJsonError, assertLoopbackAdminRequest, readJsonBody, readRawBody } from "./http-utils.js";
import { AssetValidationError, resolveAdminAssetPath } from "./asset-utils.js";
import { updateEnvFile } from "./env-file.js";
import { renderAdminHtmlV2 } from "./admin-html.js";
import { createWeChatILinkClient } from "../../../plugins/wechat/src/client.js";
import { createConfiguredVoiceSynthesizer, formatCheckChatMessages, type VoiceSynthesizer } from "../../../plugins/messaging/src/index.js";
import { japaneseVoiceGenieOverrides, readJapaneseVoicePluginConfig, translateJapaneseVoiceText, type JapaneseVoicePluginConfig } from "../../../plugins/japanese-voice/src/index.js";
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
};

type PromptApiProfile = {
  corePresetName?: string;
  memorizePresetName?: string;
};

type LLMApiPresetView = Omit<LLMApiPreset, "apiKey"> & { apiKeySet: boolean };

type MemoryRunProgress = {
  id: string;
  date: string;
  target?: MemoryTarget;
  status: "running" | "complete" | "failed" | "rejected";
  rounds: Partial<Record<MemoryTarget, number>>;
  tools: Partial<Record<MemoryTarget, string>>;
  roundStartedAt: Partial<Record<MemoryTarget, string>>;
  updatedAt: string;
};

const memoryRunProgress = new Map<string, MemoryRunProgress>();
let memoryAdminRunActive = false;

type AdminPluginKind = "channel" | "tool" | "voice" | "presentation";
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

type JapaneseVoiceAdminConfig = {
  enabled: boolean;
  apiPresetName?: string;
  prompt: string;
  voice: {
    modelDir?: string;
    referenceAudio?: string;
    referenceText?: string;
    speed?: number;
    partSilenceSeconds?: number;
  };
};

type AdminPluginFieldType = "switch" | "text" | "number" | "textarea" | "apiPresetSelect" | "fileUpload" | "folderUpload" | "readonly";

type AdminPluginConfigField = {
  key: string;
  label: string;
  type: AdminPluginFieldType;
  description?: string;
  assetKey?: string;
  accept?: string;
  min?: number;
  max?: number;
  step?: number;
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
    fields: AdminPluginConfigField[];
  };
  routePreview?: string[];
  runtimeAccess?: string[];
};

export type AdminRoutesContext = {
  config: AppConfig;
  logs: unknown[];
  messageLogs: unknown[];
  llmRequestLogs: unknown[];
  llmResponseLogs: unknown[];
  getActiveLLMSession(): unknown;
  getClearedLLMSessions(): unknown[];
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
  getTokenUsageReport(query: TokenUsageQuery): unknown;
  clearLLMChainCache(): void;
  clearMemoryInductionSession(): void;
  outputRouter: { listChannels(): string[] };
  feishuPairingStore: { list(): Array<{ channelId?: string; userId?: string; sessionId?: string }> };
  coreProfileStore: CoreProfileStore;
  promptProfileStore: PromptProfileStore;
  memoryStore: MemoryStore;
  diaryStore: DiaryStore;
  memoryInductionPromptStore: MemoryInductionPromptStore;
  runMemoryInductionForMessages(messages: any[], windowStartAt: string, windowEndAt: string, apiPreset?: LLMApiPreset, target?: MemoryTarget, onRound?: (target: MemoryTarget, rounds: number, status?: string) => void): Promise<MemoryRunSummary>;
  getDailyShell(): string;
  dailyShellStore: DailyShellStore;
  agentState: AgentStateController;
  messagingTools: ToolPlugin;
  mediaTools: ToolPlugin;
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
    japaneseVoice?: {
      configPath?: string;
      testVoiceSynthesizer?: VoiceSynthesizer;
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
  "away",
  "curious",
  "working",
  "going_to_sleep",
  "sleeping",
  "serious",
  "test"
];

export function createApiRequestHandler(context: AdminRoutesContext) {
  return async (request: any, response: any) => {
    try {
      assertLoopbackAdminRequest(request);

      if (request.method === "GET" && request.url === "/admin") {
        writeHtml(response, 200, renderAdminHtmlV2());
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
        await previewMemoryPrompts(context, request, response);
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
        const sleepDays = ensureMemorySleepBoundaries(context);
        writeJson(response, 200, {
          files: context.memoryStore.stats(),
          prompts: context.memoryInductionPromptStore.get(),
          sleepDays
        });
        return;
      }

      if (request.method === "GET" && request.url.startsWith("/admin/api/memory/messages")) {
        await listMemoryDayMessages(context, request, response);
        return;
      }

      if (request.method === "PUT" && request.url === "/admin/api/memory/file") {
        await saveMemoryFile(context, request, response);
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/memory/run-day") {
        await runMemoryDay(context, request, response);
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/memory/run-target") {
        await runMemoryTarget(context, request, response);
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/memory/clear-session") {
        context.clearMemoryInductionSession();
        context.appendLog("info", "memorize console session clear requested");
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/memory/delete-latest-sql") {
        deleteLatestMemorySqlRecord(context, response);
        return;
      }

      if (request.method === "GET" && request.url.startsWith("/admin/api/memory/run-progress")) {
        getMemoryRunProgress(request, response);
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/memory/undo-last") {
        undoLastMemoryGitCommit(context, response);
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/memory/redo-last") {
        redoLastMemoryGitCommit(context, response);
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
          clearedSessions: context.getClearedLLMSessions(),
          memorySessions: context.getMemoryLLMSessions(),
          profilePreview: await context.getLLMRequestProfilePreview(resolvePromptApiPreset(context, "core")),
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
        const active = resolvePromptApiPreset(context, "core");
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

  const pluginId = parts[3];
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
  return findAdminPluginEntry(context, pluginId)?.summary(context);
}

function findAdminPluginEntry(context: AdminRoutesContext, pluginId: string): AdminPluginRegistryEntry | undefined {
  return adminPluginRegistry(context).find((entry) => entry.summary(context).id === pluginId);
}

function adminPluginRegistry(_context: AdminRoutesContext): AdminPluginRegistryEntry[] {
  return [
    japaneseVoicePluginEntry(),
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
  return {
    plugin: {
      ...plugin,
      version: "local"
    },
    configSchema: entry.configSchema ?? { fields: [] },
    configValue: entry.config?.(context) ?? {},
    apiPresets: publicLLMApiPresets(readLLMApiPresets(context)),
    routePreview: entry.routePreview ?? [],
    runtimeAccess: entry.runtimeAccess ?? []
  };
}

function japaneseVoicePluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return japaneseVoicePluginSummary(context);
    },
    config(context) {
      return publicJapaneseVoiceConfig(readJapaneseVoiceConfigForAdmin(context));
    },
    patch(context, patch) {
      const result = updateJapaneseVoiceConfig(context, patch);
      return "error" in result ? result : { config: publicJapaneseVoiceConfig(result.config) };
    },
    setEnabled(context, enabled) {
      const result = updateJapaneseVoiceConfig(context, { enabled });
      return "error" in result ? result : { config: publicJapaneseVoiceConfig(result.config) };
    },
    reload(context) {
      return { config: publicJapaneseVoiceConfig(readJapaneseVoiceConfigForAdmin(context)) };
    },
    test(context, input) {
      return testJapaneseVoicePlugin(context, input);
    },
    uploadAsset(context, assetKey, request) {
      return uploadGenericPluginAsset(context, "japanese-voice", assetKey, request);
    },
    configSchema: {
      fields: [
        { key: "enabled", label: "Enabled", type: "switch", description: "Enable or disable this plugin route." },
        { key: "voice.referenceAudio", label: "Reference Audio", type: "fileUpload", assetKey: "reference-audio", accept: "audio/*", description: "Plugin-owned reference audio under assets/plugin/{plugin_id}/." },
        { key: "prompt", label: "Prompt", type: "textarea", description: "Prompt used by this plugin before it calls the selected API preset." },
        { key: "voice.modelDir", label: "Voice Model Folder", type: "folderUpload", assetKey: "model", description: "Plugin-owned model folder under assets/plugin/{plugin_id}/." },
        { key: "apiPresetName", label: "API Preset", type: "apiPresetSelect", description: "Select a saved API preset. The plugin does not store API keys." },
        { key: "voice.referenceText", label: "Reference Text", type: "textarea", description: "Stored directly in this plugin config file." },
        { key: "voice.speed", label: "Voice Speed", type: "number", min: 0.5, max: 2, step: 0.05, description: "Optional Genie playback speed multiplier from 0.5 to 2.0." },
        { key: "voice.partSilenceSeconds", label: "Part Silence", type: "number", min: 0, max: 3, step: 0.05, description: "Optional silence in seconds inserted between split Genie audio parts. Default is 0.67." },
        { key: "targetRoute", label: "Target Route", type: "readonly", description: "send_chat.voice.before_tts" },
        { key: "persistTranslation", label: "Persist Translation", type: "readonly", description: "Translations are transient and never written to message log." }
      ]
    },
    routePreview: [
      "send_chat.voice",
      "plugin.translate",
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

function japaneseVoicePluginSummary(context: AdminRoutesContext, config = readJapaneseVoiceConfigForAdmin(context)): AdminPluginSummary {
  const presetExists = !config.apiPresetName || readLLMApiPresets(context).some((entry) => entry.name === config.apiPresetName);
  const missingConfig = config.enabled && (!config.apiPresetName || !presetExists);
  return {
    id: "japanese-voice",
    name: "Japanese Voice",
    kind: "voice",
    status: missingConfig ? "missing_config" : config.enabled ? "enabled" : "disabled",
    health: missingConfig ? "degraded" : config.enabled ? "healthy" : "unknown",
    description: "Translate send_chat voice text through a selected API preset before the normal TTS route.",
    configurable: true,
    switchable: true,
    configSource: japaneseVoiceConfigPath(context),
    lastLoadedAt: japaneseVoiceConfigMtime(context)
  };
}

async function testJapaneseVoicePlugin(context: AdminRoutesContext, input: Record<string, unknown>): Promise<{ ok: true; result?: unknown } | { error: string }> {
  const config = readJapaneseVoiceConfigForAdmin(context);
  const text = requiredString(input.text) || "晚点见。";
  if (Array.from(text).length > 240) return { error: "text_too_long" };
  if (!config.apiPresetName) return { error: "missing_api_preset" };
  const preset = readLLMApiPresets(context).find((entry) => entry.name === config.apiPresetName);
  if (!preset) return { error: "invalid_api_preset" };
  if (!preset.baseURL || !preset.apiKey) return { error: "incomplete_api_preset" };

  const totalStartedAt = Date.now();
  const translationStartedAt = Date.now();
  const translatedText = await translateJapaneseVoiceText(text, config, {
    baseSynthesizer: async () => {
      throw new Error("not used");
    },
    llmRequestSender: context.llmRequestSender,
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
    appendLog: context.appendLog
  });
  const translationMs = Date.now() - translationStartedAt;
  if (!translatedText) return { error: "translation_failed" };

  const ttsStartedAt = Date.now();
  const configuredSynthesizer = context.pluginConfigs?.japaneseVoice?.testVoiceSynthesizer;
  const synthesizer = configuredSynthesizer ?? createConfiguredVoiceSynthesizer(context.config.tts, {
    appendLog: context.appendLog
  });
  let voice: Awaited<ReturnType<VoiceSynthesizer>>;
  let ttsMs = 0;
  try {
    voice = await synthesizer({ text: translatedText, time: context.time, genie: japaneseVoiceGenieOverrides(config) });
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

function updateJapaneseVoiceConfig(
  context: AdminRoutesContext,
  patch: Record<string, unknown>
): { config: JapaneseVoicePluginConfig } | { error: string } {
  const current = readJapaneseVoiceConfigForAdmin(context);
  const currentVoice = current.voice ?? {};
  if ("api_preset" in patch) return { error: "invalid_plugin_config" };
  const voicePatch = patch.voice && typeof patch.voice === "object" && !Array.isArray(patch.voice)
    ? patch.voice as Record<string, unknown>
    : {};
  const next: JapaneseVoicePluginConfig = {
    enabled: patch.enabled === undefined ? current.enabled : booleanFromUnknown(patch.enabled),
    apiPresetName: patch.apiPresetName === undefined ? current.apiPresetName : optionalString(patch.apiPresetName),
    api_preset: current.api_preset,
    prompt: patch.prompt === undefined ? current.prompt : requiredString(patch.prompt),
    voice: {
      modelDir: voicePatch.modelDir === undefined ? currentVoice.modelDir : optionalString(voicePatch.modelDir),
      referenceAudio: voicePatch.referenceAudio === undefined ? currentVoice.referenceAudio : optionalString(voicePatch.referenceAudio),
      referenceText: voicePatch.referenceText === undefined ? currentVoice.referenceText : optionalString(voicePatch.referenceText),
      speed: voicePatch.speed === undefined ? currentVoice.speed : optionalSpeedValue(voicePatch.speed),
      partSilenceSeconds: voicePatch.partSilenceSeconds === undefined ? currentVoice.partSilenceSeconds : optionalPartSilenceSecondsValue(voicePatch.partSilenceSeconds)
    }
  };

  const validationError = validateJapaneseVoiceConfig(next);
  if (validationError) return { error: validationError };
  if (next.apiPresetName && !readLLMApiPresets(context).some((entry) => entry.name === next.apiPresetName)) {
    return { error: "invalid_api_preset" };
  }
  writeJapaneseVoiceConfig(context, next);
  return { config: next };
}

function validateJapaneseVoiceConfig(config: JapaneseVoicePluginConfig): string | undefined {
  const voice = config.voice ?? {};
  for (const value of [voice.modelDir, voice.referenceAudio]) {
    if (value && !isPluginAssetPath("japanese-voice", value)) return "invalid_asset_path";
  }
  if (voice.speed !== undefined && (voice.speed < 0.5 || voice.speed > 2)) return "invalid_voice_speed";
  if (voice.partSilenceSeconds !== undefined && (voice.partSilenceSeconds < 0 || voice.partSilenceSeconds > 3)) return "invalid_part_silence";
  return undefined;
}

function readJapaneseVoiceConfigForAdmin(context: AdminRoutesContext): JapaneseVoicePluginConfig {
  return readJapaneseVoicePluginConfig(japaneseVoiceConfigPath(context));
}

function writeJapaneseVoiceConfig(context: AdminRoutesContext, config: JapaneseVoicePluginConfig): void {
  const filePath = japaneseVoiceConfigPath(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(publicJapaneseVoiceConfig(config), null, 2)}\n`);
}

async function uploadGenericPluginAsset(
  context: AdminRoutesContext,
  pluginId: string,
  assetKey: string,
  request: any
): Promise<{ config: JapaneseVoiceAdminConfig; assetPath: string } | { error: string; statusCode?: number }> {
  const config = readJapaneseVoiceConfigForAdmin(context);
  const fileName = safePluginAssetFileName(decodeHeaderFileName(optionalString(request.headers?.["x-file-name"]) ?? ""));
  const relativeDir = decodeHeaderFileName(optionalString(request.headers?.["x-relative-dir"]) ?? "");
  const maxBytes = assetKey === "model" ? maxPluginModelAssetUploadBytes : maxPluginAssetUploadBytes;
  const body = await readRawBody(request, { maxBytes });
  if (body.length === 0) return { error: "empty_upload" };

  const assetPath = resolvePluginAssetPathForUpload(pluginId, assetKey, fileName, relativeDir);
  fs.mkdirSync(path.dirname(assetPath.fullPath), { recursive: true });
  fs.writeFileSync(assetPath.fullPath, body);

  const next: JapaneseVoicePluginConfig = {
    ...config,
    voice: {
      ...config.voice,
      ...voiceAssetPatch(assetKey, assetPath.assetPath)
    }
  };
  writeJapaneseVoiceConfig(context, next);
  return { config: publicJapaneseVoiceConfig(next), assetPath: assetPath.assetPath };
}

function voiceAssetPatch(assetKey: string, assetPath: string): Partial<JapaneseVoicePluginConfig["voice"]> {
  if (assetKey === "model") return { modelDir: path.join("assets", "plugin", "japanese-voice", "model").split(path.sep).join("/") };
  if (assetKey === "reference-audio") return { referenceAudio: assetPath };
  if (assetKey === "reference-text") return { referenceText: assetPath };
  return {};
}

function resolvePluginAssetPathForUpload(pluginId: string, assetKey: string, fileName: string, relativeDir: string): { fullPath: string; assetPath: string } {
  const root = path.resolve("assets", "plugin", pluginId);
  const normalizedRelativeDir = sanitizePluginAssetRelativePath(relativeDir);
  const effectiveFileName = fileName || defaultPluginAssetFileName(assetKey);
  const baseRelativeDir = assetKey === "model" ? "model" : normalizedRelativeDir;
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

function isPluginAssetPath(pluginId: string, value: string): boolean {
  const root = path.resolve("assets", "plugin", pluginId);
  const fullPath = path.resolve(value);
  const relative = path.relative(root, fullPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function japaneseVoiceConfigPath(context: AdminRoutesContext): string {
  return context.pluginConfigs?.japaneseVoice?.configPath ?? "plugins/japanese-voice/config.json";
}

function japaneseVoiceConfigMtime(context: AdminRoutesContext): string | undefined {
  try {
    const stats = fs.statSync(japaneseVoiceConfigPath(context)) as { mtime?: Date; mtimeMs?: number };
    if (stats.mtime instanceof Date) return stats.mtime.toISOString();
    if (typeof stats.mtimeMs === "number") return new Date(stats.mtimeMs).toISOString();
    return undefined;
  } catch {
    return undefined;
  }
}

function publicJapaneseVoiceConfig(config: JapaneseVoicePluginConfig): JapaneseVoiceAdminConfig {
  return {
    enabled: config.enabled,
    apiPresetName: config.apiPresetName,
    prompt: config.prompt,
    voice: { ...config.voice }
  };
}

function japaneseVoiceConfigSchema(): unknown {
  return {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
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

async function savePromptApiProfile(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const profile = normalizePromptApiProfile(body);
  const presetNames = new Set(readLLMApiPresets(context).map((entry) => entry.name));
  if (profile.corePresetName && !presetNames.has(profile.corePresetName)) return writeJson(response, 400, { ok: false, error: "core_preset_not_found" });
  if (profile.memorizePresetName && !presetNames.has(profile.memorizePresetName)) return writeJson(response, 400, { ok: false, error: "memorize_preset_not_found" });
  writePromptApiProfile(context, profile);
  context.appendLog("info", `prompt api profile saved: core=${profile.corePresetName ?? "(current)"} memorize=${profile.memorizePresetName ?? "(current)"}`);
  writeJson(response, 200, { ok: true, profile });
}

async function saveMemoryFile(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const target = requiredString(body.target);
  if (!isMemoryTarget(target)) {
    writeJson(response, 400, { ok: false, error: "invalid_memory_target" });
    return;
  }
  const content = typeof body.content === "string" ? body.content : "";
  context.memoryStore.writeTarget(target, content);
  context.appendLog("info", `memory file saved: ${target}`);
  writeJson(response, 200, { ok: true, files: context.memoryStore.stats() });
}

async function listMemoryDayMessages(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const url = new URL(request.url, "http://admin.local");
  const date = url.searchParams.get("date") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    writeJson(response, 400, { ok: false, error: "invalid_date" });
    return;
  }
  if (!context.store?.listMessagesByCreatedAtRange) {
    writeJson(response, 500, { ok: false, error: "message_store_unavailable" });
    return;
  }
  const window = resolveMemorySleepWindow(context, date);
  if (!window) {
    writeJson(response, 404, { ok: false, error: "sleep_window_not_found" });
    return;
  }
  const { startAt, endAt } = window;
  const messages = context.store.listMessagesByCreatedAtRange(startAt, endAt, 10_000);
  const content = formatCheckChatMessages(messages, {
    timeZone: context.time.timeZone,
    userName: context.promptProfileStore.get().userName || "user"
  });
  writeJson(response, 200, {
    ok: true,
    date,
    startAt,
    endAt,
    startAtUtc: window.startAtUtc,
    endAtUtc: window.endAtUtc,
    source: window.source,
    content,
    messages
  });
}

async function runMemoryDay(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const date = requiredString(body.date);
  await runMemoryForDate(context, response, date, undefined, optionalString(body.runId));
}

async function runMemoryTarget(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const date = requiredString(body.date);
  const target = requiredString(body.target);
  if (!isMemoryTarget(target)) {
    writeJson(response, 400, { ok: false, error: "invalid_memory_target" });
    return;
  }
  await runMemoryForDate(context, response, date, target, optionalString(body.runId));
}

async function runMemoryForDate(
  context: AdminRoutesContext,
  response: any,
  date: string,
  target?: MemoryTarget,
  runId?: string
): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    writeJson(response, 400, { ok: false, error: "invalid_date" });
    return;
  }
  if (!context.store?.listMessagesByCreatedAtRange) {
    writeJson(response, 500, { ok: false, error: "message_store_unavailable" });
    return;
  }
  const window = resolveMemorySleepWindow(context, date);
  if (!window) {
    writeJson(response, 404, { ok: false, error: "sleep_window_not_found" });
    return;
  }
  const { startAt, endAt } = window;
  const messages = context.store.listMessagesByCreatedAtRange(startAt, endAt, 10_000);
  const apiPreset = resolveMemorizeApiPreset(context);
  if (!apiPreset) {
    writeJson(response, 400, { ok: false, error: "memorize_preset_required" });
    return;
  }
  if (context.config.memorySummary.manualRunRequiresSleeping !== false && context.agentState.getSnapshot().state !== "sleeping") {
    updateMemoryRunProgress(runId, date, target, "rejected");
    writeJson(response, 409, { ok: false, error: "memory_manual_run_requires_sleeping" });
    return;
  }
  if (memoryAdminRunActive) {
    updateMemoryRunProgress(runId, date, target, "rejected");
    writeJson(response, 409, { ok: false, error: "memory_run_already_running" });
    return;
  }
  memoryAdminRunActive = true;
  updateMemoryRunProgress(runId, date, target, "running");
  try {
    const result = await context.runMemoryInductionForMessages(messages, startAt, endAt, apiPreset, target, (roundTarget, rounds, toolStatus) => {
      updateMemoryRunProgress(runId, date, target, "running", roundTarget, rounds, toolStatus);
    });
    updateMemoryRunProgress(runId, date, target, result.ok ? "complete" : "failed");
    context.appendLog(result.ok ? "info" : "warn", `memorize ${target ?? "day"} ${date}: ${result.ok ? "ok" : "failed"} messages=${messages.length}`);
    writeJson(response, result.ok ? 200 : 400, {
      ok: result.ok,
      result,
      files: context.memoryStore.stats()
    });
  } finally {
    memoryAdminRunActive = false;
  }
}

function updateMemoryRunProgress(
  runId: string | undefined,
  date: string,
  target: MemoryTarget | undefined,
  status: MemoryRunProgress["status"],
  roundTarget?: MemoryTarget,
  rounds?: number,
  toolStatus?: string
): void {
  if (!runId) return;
  const previous = memoryRunProgress.get(runId);
  const next: MemoryRunProgress = previous ?? {
    id: runId,
    date,
    target,
    status,
    rounds: {},
    tools: {},
    roundStartedAt: {},
    updatedAt: new Date().toISOString()
  };
  next.status = status;
  next.updatedAt = new Date().toISOString();
  if (roundTarget && rounds !== undefined) {
    if (next.rounds[roundTarget] !== rounds) {
      next.roundStartedAt[roundTarget] = next.updatedAt;
      delete next.tools[roundTarget];
    }
    next.rounds[roundTarget] = rounds;
  }
  if (roundTarget && toolStatus) next.tools[roundTarget] = toolStatus;
  if (status === "complete" && target) next.tools[target] = "ok";
  memoryRunProgress.set(runId, next);
}

function getMemoryRunProgress(request: any, response: any): void {
  const url = new URL(request.url, "http://admin.local");
  const id = url.searchParams.get("id") || "";
  const progress = memoryRunProgress.get(id);
  if (!progress) {
    writeJson(response, 404, { ok: false, error: "memory_run_progress_not_found" });
    return;
  }
  writeJson(response, 200, { ok: true, progress });
}

function undoLastMemoryGitCommit(context: AdminRoutesContext, response: any): void {
  const dir = path.join(context.config.memoryFiles.root, "long-term-memory");
  try {
    const unavailable = validateMemoryGitRepo(dir);
    if (unavailable) {
      writeJson(response, 400, { ok: false, error: unavailable });
      return;
    }
    const target = findLatestActiveMemoryCommit(dir);
    if (!target) {
      writeJson(response, 400, { ok: false, error: "no_memorize_commit_to_undo" });
      return;
    }
    removeEmptyUntrackedMemoryFiles(dir);
    ensureMemoryGitClean(dir);
    revertMemoryGitCommit(dir, target.commit);
    context.appendLog("info", `memory git undo: reverted ${target.shortCommit} ${target.subject}`);
    writeJson(response, 200, { ok: true, commit: target.shortCommit, message: target.subject, files: context.memoryStore.stats() });
  } catch (error) {
    writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : "memory_git_undo_failed" });
  }
}

function redoLastMemoryGitCommit(context: AdminRoutesContext, response: any): void {
  const dir = path.join(context.config.memoryFiles.root, "long-term-memory");
  try {
    const unavailable = validateMemoryGitRepo(dir);
    if (unavailable) {
      writeJson(response, 400, { ok: false, error: unavailable });
      return;
    }
    const target = findLatestActiveMemoryRevertCommit(dir);
    if (!target) {
      writeJson(response, 400, { ok: false, error: "no_memorize_revert_to_redo" });
      return;
    }
    removeEmptyUntrackedMemoryFiles(dir);
    ensureMemoryGitClean(dir);
    revertMemoryGitCommit(dir, target.commit);
    context.appendLog("info", `memory git redo: reverted ${target.shortCommit} ${target.subject}`);
    writeJson(response, 200, { ok: true, commit: target.shortCommit, message: target.subject, files: context.memoryStore.stats() });
  } catch (error) {
    writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : "memory_git_redo_failed" });
  }
}

function deleteLatestMemorySqlRecord(context: AdminRoutesContext, response: any): void {
  const entry = context.diaryStore.deleteLatestEntry();
  if (!entry) {
    writeJson(response, 400, { ok: false, error: "no_memory_sql_record_to_delete" });
    return;
  }
  context.appendLog("info", `memory sql delete latest diary entry: ${entry.localDate}`);
  writeJson(response, 200, { ok: true, entry, files: context.memoryStore.stats() });
}

type MemoryGitLogEntry = {
  commit: string;
  shortCommit: string;
  subject: string;
  body: string;
  originalMemoryCommit?: string;
};

function validateMemoryGitRepo(dir: string): string | undefined {
  if (!fs.existsSync(path.join(dir, ".git"))) return "memory_git_unavailable";
  try {
    gitExecFileSync(["rev-parse", "--verify", "HEAD"], { cwd: dir });
    return undefined;
  } catch {
    return "memory_git_empty";
  }
}

function findLatestActiveMemoryCommit(dir: string): MemoryGitLogEntry | undefined {
  const log = readMemoryGitLog(dir);
  const activeOriginals = activeOriginalMemoryCommits(log);
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const entry = log[index];
    if (isMemorizeSubject(entry.subject) && activeOriginals.has(entry.commit)) return entry;
  }
  return undefined;
}

function findLatestActiveMemoryRevertCommit(dir: string): MemoryGitLogEntry | undefined {
  const log = readMemoryGitLog(dir);
  const activeOriginals = activeOriginalMemoryCommits(log);
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const entry = log[index];
    if (!isMemorizeRevertSubject(entry.subject) || !entry.originalMemoryCommit) continue;
    if (!activeOriginals.has(entry.originalMemoryCommit)) return entry;
  }
  return undefined;
}

function activeOriginalMemoryCommits(log: MemoryGitLogEntry[]): Set<string> {
  const active = new Set<string>();
  const originalsByCommit = new Map<string, string>();
  for (const entry of log) {
    if (isMemorizeSubject(entry.subject)) {
      active.add(entry.commit);
      originalsByCommit.set(entry.commit, entry.commit);
      entry.originalMemoryCommit = entry.commit;
      continue;
    }
    const reverted = revertedCommitFromBody(entry.body);
    const original = reverted ? originalsByCommit.get(reverted) : undefined;
    if (!original) continue;
    entry.originalMemoryCommit = original;
    originalsByCommit.set(entry.commit, original);
    if (active.has(original)) active.delete(original);
    else active.add(original);
  }
  return active;
}

function readMemoryGitLog(dir: string): MemoryGitLogEntry[] {
  const output = gitExecFileSync(["log", "--reverse", "--format=%H%x00%h%x00%s%x00%b%x1e"], { cwd: dir, encoding: "utf8" });
  return output
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [commit = "", shortCommit = "", subject = "", ...bodyParts] = chunk.split("\x00");
      return { commit, shortCommit, subject, body: bodyParts.join("\x00") };
    })
    .filter((entry) => entry.commit);
}

function isMemorizeSubject(subject: string): boolean {
  return subject.startsWith("memorize ");
}

function isMemorizeRevertSubject(subject: string): boolean {
  return subject.startsWith('Revert "memorize ');
}

function revertedCommitFromBody(body: string): string | undefined {
  return body.match(/This reverts commit ([0-9a-f]{40})\./)?.[1];
}

function removeEmptyUntrackedMemoryFiles(dir: string): void {
  for (const fileName of ["persistent-memory.md", "user-preferences.md"]) {
    const filePath = path.join(dir, fileName);
    if (!fs.existsSync(filePath) || fs.readFileSync(filePath, "utf8") !== "") continue;
    try {
      gitExecFileSync(["ls-files", "--error-unmatch", fileName], { cwd: dir });
    } catch {
      fs.rmSync(filePath);
    }
  }
}

function ensureMemoryGitClean(dir: string): void {
  const status = gitExecFileSync(["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim();
  if (!status) return;
  throw new Error("memory_git_worktree_dirty");
}

function revertMemoryGitCommit(dir: string, commit: string): void {
  try {
    gitExecFileSync(["revert", "--no-edit", commit], { cwd: dir });
  } catch (error) {
    abortMemoryGitRevert(dir);
    throw error;
  }
}

function abortMemoryGitRevert(dir: string): void {
  if (!fs.existsSync(path.join(dir, ".git", "REVERT_HEAD"))) return;
  try {
    gitExecFileSync(["revert", "--abort"], { cwd: dir });
  } catch {
    // Preserve the original revert error for the API response.
  }
}

function gitExecFileSync(args: string[], options: { cwd: string; encoding?: BufferEncoding }): string {
  const result = childProcess.spawnSync("git", args, {
    cwd: options.cwd,
    encoding: options.encoding ?? "utf8"
  });
  if (result.status !== 0) {
    const error = new Error(result.stderr?.toString() || result.error?.message || `git ${args.join(" ")} failed`);
    (error as Error & { status?: number }).status = result.status ?? undefined;
    throw error;
  }
  return result.stdout?.toString() ?? "";
}

function memoryDayWindow(date: string, timeZone: string): { startAt: string; endAt: string; startAtUtc: string; endAtUtc: string; source: "calendar" } {
  const startAt = `${date}T00:00:00.000`;
  const startDate = parseZonedIso(startAt, timeZone);
  const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
  const endAt = formatZonedIso(endDate, timeZone);
  return { startAt, endAt, startAtUtc: startDate.toISOString(), endAtUtc: endDate.toISOString(), source: "calendar" };
}

function resolveMemorySleepWindow(
  context: AdminRoutesContext,
  date: string
): { startAt: string; endAt: string; startAtUtc?: string; endAtUtc?: string; source: SleepBoundary["source"] | "calendar" } | undefined {
  const sleepDays = ensureMemorySleepBoundaries(context);
  const option = sleepDays.find((day) => day.date === date);
  if (option) return { startAt: option.startAt, endAt: option.endAt, startAtUtc: option.startAtUtc, endAtUtc: option.endAtUtc, source: option.source };
  return sleepDays.length === 0 ? memoryDayWindow(date, context.time.timeZone) : undefined;
}

function ensureMemorySleepBoundaries(context: AdminRoutesContext): Array<{
  date: string;
  startAt: string;
  endAt: string;
  startAtUtc?: string;
  endAtUtc?: string;
  source: SleepBoundary["source"];
  messageCount?: number;
}> {
  recordPersistedSleepMessageBoundaries(context);
  if (!context.diaryStore.listSleepBoundaries().some((boundary) => boundary.source !== "sleep")) inferSleepBoundaries(context);
  const boundaries = context.diaryStore.listSleepBoundaries();
  return boundaries.slice(1).map((boundary, index) => {
    const previous = boundaries[index];
    const start = boundaryInstant(previous, context.time.timeZone);
    const end = boundaryInstant(boundary, context.time.timeZone);
    return {
      date: sleepBoundaryLocalDate(boundary, context.time.timeZone),
      startAt: formatZonedIso(start, context.time.timeZone),
      endAt: formatZonedIso(end, context.time.timeZone),
      startAtUtc: start.toISOString(),
      endAtUtc: end.toISOString(),
      source: boundary.source
    };
  }).reverse();
}

function recordPersistedSleepMessageBoundaries(context: AdminRoutesContext): void {
  const messages = context.store?.listMessagesChronological?.(10_000) ?? [];
  if (messages.length === 0) return;
  const boundaries = new Set(context.diaryStore.listSleepBoundaries().map((boundary) => boundary.occurredAt));
  for (const message of messages) {
    if (message.contentText !== "-少女已入眠-") continue;
    if (boundaries.has(message.createdAt)) continue;
    const occurredAtUtc = message.createdAtUtc ?? new Date(parseMessageCreatedAt(message.createdAt, context.time.timeZone)).toISOString();
    const now = context.time.now();
    context.diaryStore.recordSleepBoundary({
      occurredAt: message.createdAt,
      occurredAtUtc,
      source: "sleep",
      now: now.iso,
      nowUtc: now.date.toISOString()
    });
    boundaries.add(message.createdAt);
  }
}

function inferSleepBoundaries(context: AdminRoutesContext): void {
  const messages = context.store?.listMessagesChronological?.(10_000) ?? [];
  if (messages.length === 0) return;
  const segments = mergeSmallSleepSegments(splitMessagesByLongGap(messages, context.time.timeZone), context.time.timeZone);
  for (const segment of segments) {
    const occurredAt = segment[0].createdAt;
    const occurredAtUtc = segment[0].createdAtUtc ?? new Date(parseMessageCreatedAt(occurredAt, context.time.timeZone)).toISOString();
    const now = context.time.now();
    context.diaryStore.recordSleepBoundary({
      occurredAt,
      occurredAtUtc,
      source: segment === segments[0] ? "inferred_start" : "inferred_gap",
      now: now.iso,
      nowUtc: now.date.toISOString()
    });
  }
}

function splitMessagesByLongGap(messages: StoredConversationMessage[], timeZone: string): StoredConversationMessage[][] {
  const segments: StoredConversationMessage[][] = [];
  let current: StoredConversationMessage[] = [];
  let previousTime: number | undefined;
  for (const message of messages) {
    const messageTime = parseMessageCreatedAt(message.createdAt, timeZone);
    if (previousTime !== undefined && messageTime - previousTime > 6 * 60 * 60 * 1000 && current.length > 0) {
      segments.push(current);
      current = [];
    }
    current.push(message);
    previousTime = messageTime;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function mergeSmallSleepSegments(segments: StoredConversationMessage[][], timeZone: string): StoredConversationMessage[][] {
  const merged = segments.slice();
  while (merged.length > 1) {
    const index = merged.findIndex((segment) => segment.length <= 10);
    if (index < 0) break;
    const target = nearestSegmentIndex(merged, index, timeZone);
    merged[target] = index < target ? merged[index].concat(merged[target]) : merged[target].concat(merged[index]);
    merged.splice(index, 1);
  }
  return merged;
}

function nearestSegmentIndex(segments: StoredConversationMessage[][], index: number, timeZone: string): number {
  if (index === 0) return 1;
  if (index === segments.length - 1) return index - 1;
  const previousGap = parseMessageCreatedAt(segments[index][0].createdAt, timeZone) - parseMessageCreatedAt(segments[index - 1][segments[index - 1].length - 1].createdAt, timeZone);
  const nextGap = parseMessageCreatedAt(segments[index + 1][0].createdAt, timeZone) - parseMessageCreatedAt(segments[index][segments[index].length - 1].createdAt, timeZone);
  return previousGap <= nextGap ? index - 1 : index + 1;
}

function sleepBoundaryLocalDate(boundary: SleepBoundary, timeZone: string): string {
  return formatZonedIso(boundaryInstant(boundary, timeZone), timeZone).slice(0, 10);
}

function boundaryInstant(boundary: SleepBoundary, timeZone: string): Date {
  return boundary.occurredAtUtc ? new Date(boundary.occurredAtUtc) : new Date(parseMessageCreatedAt(boundary.occurredAt, timeZone));
}

function parseMessageCreatedAt(value: string, timeZone: string): number {
  return /Z$|[+-]\d{2}:\d{2}$/.test(value) ? new Date(value).getTime() : parseZonedIso(value, timeZone).getTime();
}


async function previewMemoryPrompts(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const target = requiredString(body.target);
  if (!isMemoryTarget(target)) {
    writeJson(response, 400, { ok: false, error: "invalid_memory_target" });
    return;
  }
  if (!context.store?.listMessagesByCreatedAtRange) {
    writeJson(response, 500, { ok: false, error: "message_store_unavailable" });
    return;
  }
  const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
    ? body.date
    : formatZonedIso(context.time.now().date, context.time.timeZone).slice(0, 10);
  const startAt = `${date}T00:00:00.000`;
  const endAt = formatZonedIso(new Date(parseZonedIso(startAt, context.time.timeZone).getTime() + 24 * 60 * 60 * 1000), context.time.timeZone);
  const messages = context.store.listMessagesByCreatedAtRange(startAt, endAt, 10_000);
  const prompts = body.prompts && typeof body.prompts === "object"
    ? body.prompts as ReturnType<MemoryInductionPromptStore["get"]>
    : context.memoryInductionPromptStore.get();
  const preview = buildMemoryPromptPreview({
    memoryStore: context.memoryStore,
    prompts,
    messages,
    windowStartAt: startAt,
    windowEndAt: endAt,
    timezone: context.time.timeZone,
    userName: context.promptProfileStore.get().userName,
    config: memorySummaryConfigForPreset(context, resolveMemorizeApiPreset(context))
  }, target as MemoryTarget);
  writeJson(response, 200, { ok: true, date, preview });
}

function isMemoryTarget(value: string): value is "persistent" | "userPreferences" | "yesterdaySummary" {
  return value === "persistent" || value === "userPreferences" || value === "yesterdaySummary";
}

function getPromptVariablePreview(context: AdminRoutesContext): LLMTextVariables {
  const target = resolvePromptPreviewTarget(context);
  const receivedTime = context.time.now();
  return promptVariables(context.promptProfileStore.get(), {
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

function getVisiblePromptTools(context: AdminRoutesContext): Array<{ name: string; description?: string }> {
  const profile = context.promptProfileStore.get();
  const plugins = [
    profile.visibleTools.feishu === false ? undefined : context.messagingTools,
    profile.visibleTools.media === false ? undefined : context.mediaTools,
    profile.visibleTools.shell === false ? undefined : context.shellTools,
    context.sleepCocoonTools
  ].filter((plugin): plugin is ToolPlugin => Boolean(plugin));
  return plugins.flatMap((plugin) => plugin.listTools().map((tool) => ({
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
  return [context.messagingTools, context.mediaTools, context.shellTools, context.bookcaseTools, context.sleepCocoonTools];
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
  const referencePath = resolveTtsAssetPath(context.config.tts.genieReferenceAudio);
  const mossReferencePath = resolveTtsAssetPath(context.config.tts.mossReferenceAudio);
  const referenceTextPath = resolveTtsAssetPath(context.config.tts.genieReferenceText);
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
  return resolveTtsAssetPath(context.config.tts.mossOutputDir);
}

function resolveTtsAssetPath(assetPath: string): string {
  const assetRoot = path.resolve("assets");
  const fullPath = path.isAbsolute(assetPath)
    ? assetPath
    : path.normalize(assetPath) === "assets" || path.normalize(assetPath).startsWith(`assets${path.sep}`)
      ? path.resolve(assetPath)
      : path.resolve("assets", assetPath);
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
  const metaPath = path.join(resolveTtsAssetPath(context.config.tts.mossModelDir), "MOSS-Audio-Tokenizer-Nano-ONNX", "codec_browser_onnx_meta.json");
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
  const referencePath = resolveTtsAssetPath(context.config.tts.genieReferenceAudio);
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
    const mossReferencePath = resolveTtsAssetPath(context.config.tts.mossReferenceAudio);
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
  const extraParamsResult = parseJsonObject(optionalString(body.extraParams) ?? "{}");
  const followupExtraParamsResult = parseJsonObject(optionalString(body.followupExtraParams) ?? "{}");
  if (baseURL && !isValidHttpUrl(baseURL)) return { error: "invalid_base_url" };
  if (!model) return { error: "missing_model" };
  if (temperature < 0 || temperature > 2) return { error: "invalid_temperature" };
  if (timeoutMs < 1_000) return { error: "invalid_timeout_ms" };
  if (!extraParamsResult.ok) return { error: "invalid_extra_params" };
  if (!followupExtraParamsResult.ok) return { error: "invalid_followup_extra_params" };
  return { name, baseURL, apiKey, model, temperature, timeoutMs, stream, extraParams: extraParamsResult.value, followupExtraParams: followupExtraParamsResult.value };
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
    followupExtraParams: value.followupExtraParams && typeof value.followupExtraParams === "object" && !Array.isArray(value.followupExtraParams) ? value.followupExtraParams : {}
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
  return {
    corePresetName: optionalString(value.corePresetName),
    memorizePresetName: optionalString(value.memorizePresetName)
  };
}

function resolvePromptApiPreset(context: AdminRoutesContext, kind: "core" | "memorize"): LLMApiPreset | undefined {
  const profile = readPromptApiProfile(context);
  const name = kind === "core" ? profile.corePresetName : profile.memorizePresetName;
  if (!name) return undefined;
  return readLLMApiPresets(context).find((entry) => entry.name === name);
}

function resolveMemorizeApiPreset(context: AdminRoutesContext): LLMApiPreset | undefined {
  return resolvePromptApiPreset(context, "memorize") ?? defaultMemorizeApiPreset(context);
}

function memorySummaryConfigForPreset(context: AdminRoutesContext, preset: LLMApiPreset | undefined) {
  if (!preset) return { ...context.config.memorySummary, enabled: false, apiKey: undefined };
  return {
    ...context.config.memorySummary,
    baseURL: preset.baseURL,
    apiKey: preset.apiKey,
    model: preset.model,
    temperature: preset.temperature,
    timeoutMs: preset.timeoutMs,
    stream: preset.stream,
    extraParams: preset.extraParams,
    followupExtraParams: preset.followupExtraParams
  };
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
  return path.join(context.config.memoryFiles.root, "config", "prompt-api-profile.json");
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
      corePresetName: apiProfile.corePresetName,
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
      genieModelAvailable: fs.existsSync(resolveTtsAssetPath(context.config.tts.genieModelDir)),
      genieReferenceAudioAvailable: fs.existsSync(resolveTtsAssetPath(context.config.tts.genieReferenceAudio)),
      genieReferenceTextAvailable: fs.existsSync(resolveTtsAssetPath(context.config.tts.genieReferenceText)),
      mossBaseURL: context.config.tts.mossBaseURL,
      mossReferenceAudio: context.config.tts.mossReferenceAudio,
      mossOutputDir: context.config.tts.mossOutputDir,
      mossTimeoutMs: context.config.tts.mossTimeoutMs,
      mossVoiceCloneMaxTextTokens: context.config.tts.mossVoiceCloneMaxTextTokens
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
