import type { AppConfig } from "../../../packages/config/src/index.js";
import type { LLMClient } from "../../../core/llm/src/index.js";
import { formatZonedIso, type CurrentTimeProvider } from "../../../core/time/src/index.js";
import type { ToolPlugin } from "../../../packages/types/src/index.js";
import type { TokenUsageQuery } from "../../../packages/storage/src/token-usage-store.js";
import type { AgentBehaviorState, AgentStateController } from "../../../core/agent/src/state.js";
import type { CoreProfileStore } from "../../../core/agent/src/core-profile.js";
import { defaultPromptRegistry, promptVariables, type PromptProfile, type PromptProfileStore } from "../../../core/agent/src/prompts.js";
import { buildLLMTextVariables, formatToolResultForLLM as renderToolResultForLLM, renderLLMValue, type LLMTextVariables } from "../../../core/text-renderer/src/index.js";
import type { DailyShellStore, ShellCategory, ShellOption } from "../../../core/agent/src/shells.js";
import { HttpJsonError, assertLoopbackAdminRequest, readJsonBody, readRawBody } from "./http-utils.js";
import { AssetValidationError, resolveAdminAssetPath } from "./asset-utils.js";
import { updateEnvFile } from "./env-file.js";
import { renderAdminHtmlV2 } from "./admin-html.js";
import { createWeChatILinkClient } from "../../../plugins/wechat/src/client.js";
import { createConfiguredVoiceSynthesizer } from "../../../plugins/messaging/src/index.js";
import QRCode from "qrcode";

const fs = await import("node:fs");
const path = await import("node:path");
const childProcess = await import("node:child_process");
const moduleApi = await import("node:module");
const require = moduleApi.createRequire(import.meta.url);
const maxTtsReferenceDurationSeconds = 20;
const maxTtsReferenceUploadBytes = 15 * 1024 * 1024;
const ttsReferenceConvertTimeoutMs = 60_000;

export type AdminRoutesContext = {
  config: AppConfig;
  logs: unknown[];
  messageLogs: unknown[];
  llmRequestLogs: unknown[];
  llmResponseLogs: unknown[];
  getActiveLLMSession(): unknown;
  getClearedLLMSessions(): unknown[];
  getLLMSession(id: number): unknown;
  store: { listMessages?(limit: number): unknown[]; listMessageLogs?(limit: number): unknown[] } | undefined;
  getLLMRequestPreview(): unknown | Promise<unknown>;
  getLLMRequestProfilePreview(): unknown | Promise<unknown>;
  getTokenUsageReport(query: TokenUsageQuery): unknown;
  clearLLMChainCache(): void;
  outputRouter: { listChannels(): string[] };
  feishuPairingStore: { list(): Array<{ channelId?: string; userId?: string; sessionId?: string }> };
  coreProfileStore: CoreProfileStore;
  promptProfileStore: PromptProfileStore;
  getDailyShell(): string;
  dailyShellStore: DailyShellStore;
  agentState: AgentStateController;
  messagingTools: ToolPlugin;
  mediaTools: ToolPlugin;
  shellTools: ToolPlugin;
  bookcaseTools: ToolPlugin;
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
  messageRuntime: {
    pauseHeartbeat(): void;
    resumeHeartbeat(): void;
    processNow(): Promise<void>;
    getStatus(): unknown;
  };
  getLLM(): LLMClient;
  reloadLLM(): void;
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
          llmProvider: context.config.llm.provider,
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
          profilePreview: await context.getLLMRequestProfilePreview(),
          messagePreview: await context.getLLMRequestPreview(),
          actual: context.llmRequestLogs[context.llmRequestLogs.length - 1]
        });
        return;
      }

      if (request.method === "GET" && request.url?.startsWith("/admin/api/llm-chain/session")) {
        const url = new URL(request.url, "http://localhost");
        const id = Number(url.searchParams.get("id"));
        if (!Number.isFinite(id)) {
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

      if (request.method === "PUT" && request.url === "/admin/api/config/llm") {
        await saveLLMConfig(context, request, response);
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
        const models = llm.listModels ? await llm.listModels() : [{ id: context.config.llm.model }];
        writeJson(response, 200, { object: "list", data: models });
        return;
      }

      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      handleHttpError(context, response, error);
    }
  };
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

function getPromptVariablePreview(context: AdminRoutesContext): LLMTextVariables {
  const target = resolvePromptPreviewTarget(context);
  return promptVariables(context.promptProfileStore.get(), {
    time: context.time,
    dailyShell: context.getDailyShell(),
    dailyShellRaw: context.dailyShellStore.get(context.time.now().date, context.time.timeZone),
    appearanceDescription: context.coreProfileStore.get().appearanceDescription,
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
        receivedAt: context.time.now().iso
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
    profile.visibleTools.shell === false ? undefined : context.shellTools
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
  return [context.messagingTools, context.mediaTools, context.shellTools, context.bookcaseTools];
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
      meta: { receivedAt: context.time.now().iso }
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

  await context.feishu.send({
    id: `test_${kind}_${Date.now()}`,
    target,
    content,
    meta: {
      createdAt: context.time.now().iso,
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

async function saveLLMConfig(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const apiKey = optionalString(body.apiKey) ?? context.config.llm.apiKey;
  const baseURL = requiredString(body.baseURL);
  const model = requiredString(body.model);
  const temperature = numberFromUnknown(body.temperature, context.config.llm.temperature);
  const timeoutMs = numberFromUnknown(body.timeoutMs, context.config.llm.timeoutMs);
  const stream = body.stream === undefined ? context.config.llm.stream : booleanFromUnknown(body.stream);
  const extraParamsResult = parseJsonObject(optionalString(body.extraParams) ?? "{}");
  const followupExtraParamsResult = parseJsonObject(optionalString(body.followupExtraParams) ?? "{}");
  if (baseURL && !isValidHttpUrl(baseURL)) return writeJson(response, 400, { ok: false, error: "invalid_base_url" });
  if (!model) return writeJson(response, 400, { ok: false, error: "missing_model" });
  if (temperature < 0 || temperature > 2) return writeJson(response, 400, { ok: false, error: "invalid_temperature" });
  if (timeoutMs < 1_000 || timeoutMs > 300_000) return writeJson(response, 400, { ok: false, error: "invalid_timeout_ms" });
  if (!extraParamsResult.ok) return writeJson(response, 400, { ok: false, error: "invalid_extra_params" });
  if (!followupExtraParamsResult.ok) return writeJson(response, 400, { ok: false, error: "invalid_followup_extra_params" });

  updateEnvFile(".env", {
    LLM_PROVIDER: "openai-compatible",
    LLM_BASE_URL: baseURL,
    LLM_API_KEY: optionalString(body.apiKey),
    LLM_MODEL: model,
    LLM_TEMPERATURE: String(temperature),
    LLM_TIMEOUT_MS: String(timeoutMs),
    LLM_STREAM_ENABLED: String(stream),
    LLM_EXTRA_PARAMS: JSON.stringify(extraParamsResult.value),
    LLM_FOLLOWUP_EXTRA_PARAMS: JSON.stringify(followupExtraParamsResult.value)
  });
  context.config.llm.provider = baseURL && apiKey ? "openai-compatible" : "stub";
  context.config.llm.baseURL = baseURL;
  context.config.llm.apiKey = apiKey;
  context.config.llm.model = model;
  context.config.llm.temperature = temperature;
  context.config.llm.timeoutMs = timeoutMs;
  context.config.llm.stream = stream;
  context.config.llm.extraParams = extraParamsResult.value;
  context.config.llm.followupExtraParams = followupExtraParamsResult.value;
  context.reloadLLM();
  context.appendLog("info", `llm config saved: ${baseURL || "(empty)"} ${model || "(empty)"}`);
  writeJson(response, 200, { ok: true, restartRequired: false, config: getAdminConfig(context) });
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
  return {
    core: context.config.core,
    coreProfile: context.coreProfileStore.get(),
    api: context.config.api,
    llm: {
      provider: context.config.llm.provider,
      baseURL: context.config.llm.baseURL,
      model: context.config.llm.model,
      temperature: context.config.llm.temperature,
      timeoutMs: context.config.llm.timeoutMs,
      stream: context.config.llm.stream,
      extraParams: context.config.llm.extraParams,
      followupExtraParams: context.config.llm.followupExtraParams,
      apiKeyConfigured: Boolean(context.config.llm.apiKey)
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
