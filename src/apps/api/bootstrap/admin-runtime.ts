import type { AgentBehaviorState } from "../../../contexts/agent-loop/src/domain/agent-loop-state.js";
import { createWeChatILinkClient } from "../../../channels/wechat/src/client.js";
import { readJsonBody } from "../middleware/http-utils.js";
import { updateEnvFile } from "../server/env-file.js";
import { writeJson } from "../routes/admin-http.js";
import { resolveLibrarySetting } from "../../../contexts/world-wanderer/src/admin-library-setting.js";
import { publicLLMApiPresets, readLLMApiPresets, readPromptApiProfile } from "../../../contexts/llm-gateway/src/admin-presets.js";
import { booleanFromUnknown, maskValue, numberFromUnknown, optionalString, requiredString } from "../../../shared/admin-input/src/index.js";
import { resolveTtsAssetPath } from "../../../channels/tts/src/admin-assets.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "./admin-route-context.js";
import QRCode from "qrcode";

const fs = await import("node:fs");
export const AGENT_STATES: AgentBehaviorState[] = [
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

export async function handleAdminRuntimeApi(context: AdminRoutesContext, request: any, response: any): Promise<boolean> {
  if (request.method === "GET" && request.url === "/admin/api/runtime/status") {
    writeJson(response, 200, {
      feishu: getFeishuRuntimeStatus(context),
      wechat: getWeChatRuntimeStatus(context),
      messages: context.messageRuntime.getStatus()
    });
    return true;
  }
  if (request.method === "GET" && request.url === "/admin/api/plugins/feishu/pairings") {
    writeJson(response, 200, { contacts: context.feishuPairingStore.list() });
    return true;
  }
  if (request.method === "GET" && request.url === "/admin/api/plugins/wechat/contacts") {
    writeJson(response, 200, { contacts: context.wechatStateStore.listContacts() });
    return true;
  }
  if (request.method === "PUT" && request.url === "/admin/api/config/feishu") {
    await saveFeishuConfig(context, request, response);
    return true;
  }
  if (request.method === "PUT" && request.url === "/admin/api/config/wechat") {
    await saveWeChatConfig(context, request, response);
    return true;
  }
  if (request.method === "POST" && request.url === "/admin/api/plugins/feishu/start") {
    await startFeishu(context, response);
    return true;
  }
  if (request.method === "POST" && request.url === "/admin/api/plugins/feishu/stop") {
    await stopFeishu(context, response);
    return true;
  }
  if (request.method === "GET" && request.url === "/admin/api/plugins/feishu/status") {
    writeJson(response, 200, getFeishuRuntimeStatus(context));
    return true;
  }
  if (request.method === "POST" && request.url === "/admin/api/plugins/wechat/start") {
    await startWeChat(context, response);
    return true;
  }
  if (request.method === "POST" && request.url === "/admin/api/plugins/wechat/login/qrcode") {
    await getWeChatLoginQRCode(context, response);
    return true;
  }
  if (request.method === "GET" && request.url?.startsWith("/admin/api/plugins/wechat/login/status")) {
    await getWeChatLoginStatus(context, request, response);
    return true;
  }
  if (request.method === "POST" && request.url === "/admin/api/plugins/wechat/stop") {
    await stopWeChat(context, response);
    return true;
  }
  if (request.method === "GET" && request.url === "/admin/api/plugins/wechat/status") {
    writeJson(response, 200, getWeChatRuntimeStatus(context));
    return true;
  }
  return false;
}

export async function saveFeishuConfig(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const appId = requiredString(body.appId);
  const appSecret = optionalString(body.appSecret);
  const effectiveAppSecret = appSecret ?? context.config.plugins.feishu.accounts.main?.appSecret;
  const enabled = booleanFromUnknown(body.enabled);
  const requireMention = booleanFromUnknown(body.requireMention);
  const requestedConnectionMode = requiredString(body.connectionMode);
  if (!requestedConnectionMode) {
    writeJson(response, 400, { ok: false, error: "missing_connection_mode" });
    return;
  }
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

export async function saveWeChatConfig(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const enabled = booleanFromUnknown(body.enabled);
  const baseURL = requiredString(body.baseURL);
  if (!baseURL) {
    writeJson(response, 400, { ok: false, error: "missing_base_url" });
    return;
  }
  const pollTimeoutMs = numberFromUnknown(body.pollTimeoutMs, context.config.plugins.wechat.pollTimeoutMs);
  if (!Number.isFinite(pollTimeoutMs) || pollTimeoutMs < 5000 || pollTimeoutMs > 120_000) {
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

export async function saveAgentConfig(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const inboundDebounceMs = numberFromUnknown(body.inboundDebounceMs, context.config.core.inboundDebounceMs);
  const timezone = requiredString(body.timezone);
  if (!timezone) {
    writeJson(response, 400, { ok: false, error: "missing_timezone" });
    return;
  }
  const defaultTargetPlugin = normalizeDefaultTargetPlugin(body.defaultTargetPlugin, context.config.core.defaultTargetPlugin);
  if (!Number.isFinite(inboundDebounceMs) || inboundDebounceMs < 0 || inboundDebounceMs > 10_000) {
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

export async function saveCoreProfile(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const appearanceDescription = typeof body.appearanceDescription === "string" ? body.appearanceDescription : "";
  const librarySetting = typeof body.librarySetting === "string" ? body.librarySetting : "";
  const profile = context.coreProfileStore.save({ appearanceDescription, librarySetting });
  context.appendLog("info", `core profile saved: appearanceChars=${profile.appearanceDescription.length} libraryChars=${profile.librarySetting.length}`);
  writeJson(response, 200, { ok: true, restartRequired: false, config: getAdminConfig(context) });
}

function normalizeDefaultTargetPlugin(value: unknown, fallback: "auto" | "wechat" | "feishu"): "auto" | "wechat" | "feishu" {
  return value === "auto" || value === "wechat" || value === "feishu" ? value : fallback;
}

export async function saveAgentState(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const state = requiredString(body.state) as AgentBehaviorState;
  const intimacy = body.intimacy === undefined ? undefined : numberFromUnknown(body.intimacy, context.agentState.getSnapshot().intimacy);
  if (!AGENT_STATES.includes(state)) {
    writeJson(response, 400, { ok: false, error: "invalid_agent_state" });
    return;
  }
  let snapshot = context.agentState.setState(state, { reason: "admin" });
  if (intimacy !== undefined) {
    if (!Number.isFinite(intimacy)) {
      writeJson(response, 400, { ok: false, error: "invalid_intimacy" });
      return;
    }
    snapshot = context.agentState.setIntimacy(intimacy);
  }
  context.appendLog("info", `agent state saved: state=${snapshot.state} intimacy=${snapshot.intimacy} delay=${snapshot.responseDelayMs}`);
  writeJson(response, 200, { ok: true, state: snapshot, states: AGENT_STATES });
}

export async function startFeishu(context: AdminRoutesContext, response: any): Promise<void> {
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

export async function stopFeishu(context: AdminRoutesContext, response: any): Promise<void> {
  await context.feishu.stop();
  context.runtime.feishuStarted = false;
  context.config.plugins.feishu.enabled = false;
  updateEnvFile(".env", { FEISHU_ENABLED: "false" });
  context.appendLog("info", "feishu runtime stopped");
  writeJson(response, 200, { ok: true, status: getFeishuRuntimeStatus(context) });
}

export async function startWeChat(context: AdminRoutesContext, response: any): Promise<void> {
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

export async function getWeChatLoginQRCode(context: AdminRoutesContext, response: any): Promise<void> {
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

export async function getWeChatLoginStatus(context: AdminRoutesContext, request: any, response: any): Promise<void> {
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

export async function stopWeChat(context: AdminRoutesContext, response: any): Promise<void> {
  await context.wechat.stop();
  context.runtime.wechatStarted = false;
  context.config.plugins.wechat.enabled = false;
  context.config.plugins.wechat.botToken = context.wechatStateStore.getCredentials()?.botToken;
  updateEnvFile(".env", { WECHAT_ENABLED: "false" });
  context.appendLog("info", "wechat runtime stopped");
  writeJson(response, 200, { ok: true, status: getWeChatRuntimeStatus(context) });
}

export function getAdminConfig(context: AdminRoutesContext): unknown {
  const apiProfile = readPromptApiProfile(context);
  return {
    core: context.config.core,
    coreProfile: context.coreProfileStore.get(),
    coreVariables: {
      appearance: context.coreProfileStore.get().appearanceDescription,
      library: {
        content: resolveLibrarySetting(context)
      }
    },
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

export function getFeishuRuntimeStatus(context: AdminRoutesContext): unknown {
  return {
    enabled: context.config.plugins.feishu.enabled,
    configured: Object.keys(context.config.plugins.feishu.accounts).length > 0,
    runtimeStarted: context.runtime.feishuStarted,
    connectionMode: context.config.plugins.feishu.connectionMode,
    accountIds: Object.keys(context.config.plugins.feishu.accounts),
    requireMention: context.config.plugins.feishu.requireMention
  };
}

export function getWeChatRuntimeStatus(context: AdminRoutesContext): unknown {
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

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}
