import type { AppConfig } from "../../../packages/config/src/index.js";
import type { LLMClient } from "../../../core/llm/src/index.js";
import type { CurrentTimeProvider } from "../../../core/time/src/index.js";
import type { ToolPlugin } from "../../../packages/types/src/index.js";
import { defaultPromptRegistry } from "../../../core/agent/src/prompts.js";
import { HttpJsonError, assertLoopbackAdminRequest, readJsonBody } from "./http-utils.js";
import { AssetValidationError, resolveAdminAssetPath } from "./asset-utils.js";
import { updateEnvFile } from "./env-file.js";
import { renderAdminHtmlV2 } from "./admin-html.js";

export type AdminRoutesContext = {
  config: AppConfig;
  logs: unknown[];
  messageLogs: unknown[];
  llmRequestLogs: unknown[];
  store: { listMemories(limit: number): unknown[]; listMessages?(limit: number): unknown[]; listMessageLogs?(limit: number): unknown[] } | undefined;
  getLLMRequestPreview(): unknown;
  outputRouter: { listChannels(): string[] };
  feishuPairingStore: { list(): Array<{ channelId?: string; userId?: string; sessionId?: string }> };
  messagingTools: ToolPlugin;
  feishu: {
    start(): Promise<void>;
    stop(): Promise<void>;
    send(output: any): Promise<unknown>;
  };
  runtime: { feishuStarted: boolean };
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

export function createApiRequestHandler(context: AdminRoutesContext) {
  return async (request: any, response: any) => {
    try {
      assertLoopbackAdminRequest(request);

      if (request.method === "GET" && request.url === "/admin") {
        writeHtml(response, 200, renderAdminHtmlV2());
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
        writeJson(response, 200, { prompts: defaultPromptRegistry });
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/llm-requests") {
        writeJson(response, 200, { requests: context.llmRequestLogs, preview: context.getLLMRequestPreview() });
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

      if (request.method === "GET" && request.url === "/admin/api/memories") {
        writeJson(response, 200, { memories: context.store?.listMemories(200) ?? [] });
        return;
      }

      if (request.method === "GET" && request.url === "/admin/api/plugins/feishu/pairings") {
        writeJson(response, 200, { contacts: context.feishuPairingStore.list() });
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/tools/messaging/view") {
        await executeMessagingTool(context, request, response, "view_messages");
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/tools/messaging/search") {
        await executeMessagingTool(context, request, response, "search_messages");
        return;
      }

      if (request.method === "POST" && request.url === "/admin/api/tools/messaging/send") {
        await executeMessagingTool(context, request, response, "send_message");
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

      if (request.method === "PUT" && request.url === "/admin/api/config/agent") {
        await saveAgentConfig(context, request, response);
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

async function executeMessagingTool(
  context: AdminRoutesContext,
  request: any,
  response: any,
  toolName: "view_messages" | "search_messages" | "send_message"
): Promise<void> {
  const body = await readJsonBody(request);
  const result = await context.messagingTools.execute({
    id: `admin_${toolName}_${Date.now()}`,
    toolName,
    input: body
  });
  context.appendLog(result.ok ? "info" : "warn", `messaging tool ${toolName}: ${result.ok ? "ok" : result.error ?? "failed"}`);
  writeJson(response, result.ok ? 200 : 400, {
    ok: result.ok,
    content: formatToolResultForLLM(result),
    error: result.error
  });
}

function formatToolResultForLLM(result: { ok: boolean; output?: unknown; error?: string }): string {
  if (!result.ok) return result.error ? `error: ${result.error}` : "error";
  if (typeof result.output === "string") return result.output;
  if (result.output === undefined || result.output === null) return "ok";
  if (typeof result.output === "number" || typeof result.output === "boolean") return String(result.output);
  try {
    return JSON.stringify(result.output);
  } catch {
    return String(result.output);
  }
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
  if (baseURL && !isValidHttpUrl(baseURL)) return writeJson(response, 400, { ok: false, error: "invalid_base_url" });
  if (!model) return writeJson(response, 400, { ok: false, error: "missing_model" });
  if (temperature < 0 || temperature > 2) return writeJson(response, 400, { ok: false, error: "invalid_temperature" });
  if (timeoutMs < 1_000 || timeoutMs > 300_000) return writeJson(response, 400, { ok: false, error: "invalid_timeout_ms" });

  updateEnvFile(".env", {
    LLM_PROVIDER: "openai-compatible",
    LLM_BASE_URL: baseURL,
    LLM_API_KEY: optionalString(body.apiKey),
    LLM_MODEL: model,
    LLM_TEMPERATURE: String(temperature),
    LLM_TIMEOUT_MS: String(timeoutMs)
  });
  context.config.llm.provider = baseURL && apiKey ? "openai-compatible" : "stub";
  context.config.llm.baseURL = baseURL;
  context.config.llm.apiKey = apiKey;
  context.config.llm.model = model;
  context.config.llm.temperature = temperature;
  context.config.llm.timeoutMs = timeoutMs;
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

async function saveAgentConfig(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const inboundDebounceMs = numberFromUnknown(body.inboundDebounceMs, context.config.core.inboundDebounceMs);
  const timezone = requiredString(body.timezone) || context.config.core.timezone;
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
    AGENT_TIMEZONE: timezone
  });
  context.config.core.inboundDebounceMs = inboundDebounceMs;
  context.config.core.timezone = timezone;
  context.setTimeZone(timezone);
  context.appendLog("info", `agent config saved: inboundDebounceMs=${inboundDebounceMs} timezone=${timezone}`);
  writeJson(response, 200, { ok: true, restartRequired: false, config: getAdminConfig(context) });
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

function getAdminConfig(context: AdminRoutesContext): unknown {
  return {
    core: context.config.core,
    api: context.config.api,
    llm: {
      provider: context.config.llm.provider,
      baseURL: context.config.llm.baseURL,
      model: context.config.llm.model,
      temperature: context.config.llm.temperature,
      timeoutMs: context.config.llm.timeoutMs,
      apiKeyConfigured: Boolean(context.config.llm.apiKey)
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
