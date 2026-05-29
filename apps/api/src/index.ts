import { loadConfig } from "../../../packages/config/src/index.js";
import { createAgentCore, type LLMSessionClearReason, type LLMSessionSnapshot } from "../../../core/agent/src/index.js";
import { createAgentStateController, createJsonAgentStateStore } from "../../../core/agent/src/state.js";
import { createCoreProfileStore } from "../../../core/agent/src/core-profile.js";
import { buildAppendPromptMessagesWithToolResults, buildPromptMessagesWithToolResults, createPromptProfileStore, promptVariables } from "../../../core/agent/src/prompts.js";
import { createDailyShellStore } from "../../../core/agent/src/shells.js";
import { buildLLMTextVariables, renderLLMValue } from "../../../core/text-renderer/src/index.js";
import { createMutableLLMClient, createOpenAICompatibleClient, createStubLLMClient, type LLMChatInput, type LLMChatResult } from "../../../core/llm/src/index.js";
import { createOutputRouter } from "../../../core/output-router/src/index.js";
import { createAllowAllPolicy } from "../../../core/policy/src/index.js";
import { createIntentRouter } from "../../../core/router/src/index.js";
import { createSessionResolver } from "../../../core/session/src/index.js";
import { createFeishuPlugin } from "../../../plugins/feishu/src/index.js";
import { createFeishuPairingStore } from "../../../plugins/feishu/src/pairing.js";
import { createWeChatPlugin, createWeChatStateStore } from "../../../plugins/wechat/src/index.js";
import { createMediaTools } from "../../../plugins/media/src/index.js";
import { createMessagingTools } from "../../../plugins/messaging/src/index.js";
import { createShellTools } from "../../../plugins/shell/src/index.js";
import { createBookcaseTools } from "../../../plugins/bookcase/src/index.js";
import { createAliceStore, type StoredConversationMessage } from "../../../packages/storage/src/sqlite-store.js";
import { createTokenUsageStore, type TokenUsageQuery } from "../../../packages/storage/src/token-usage-store.js";
import { createFileLogStore } from "../../../packages/storage/src/file-log-store.js";
import { createDailyMaintenanceTasks, createDailyScheduler } from "../../../core/scheduler/src/index.js";
import { createMutableCurrentTimeProvider } from "../../../core/time/src/index.js";
import { createMessageRuntime, summarizePayload } from "./message-runtime.js";
import { createApiRequestHandler } from "./admin-routes.js";

const http = await import("node:http");
const fs = await import("node:fs");
const path = await import("node:path");

type LogLevel = "info" | "warn" | "error";

type LogEntry = {
  id: number;
  time: string;
  level: LogLevel;
  message: string;
};

type MessageLogEntry = {
  id: number;
  time: string;
  direction: "inbound" | "outbound";
  plugin: string;
  kind: string;
  target?: string;
  sessionId?: string;
  rawMessageId?: string;
  processedAt?: string;
  processedBatchId?: string;
  externalEventId?: string;
  parentRawMessageId?: string;
  actorId?: string;
  status?: string;
  rawJson?: string;
  error?: string;
  summary: string;
};

type LLMRequestLogEntry = {
  id: number;
  sessionId?: number;
  time: string;
  model?: string;
  temperature?: number;
  messages: LLMChatInput["messages"];
  tools?: LLMChatInput["tools"];
  extraParams?: Record<string, unknown>;
  rawRequest?: unknown;
  diffFromPrevious?: LLMRequestDiff;
};

type LLMRequestDiff = {
  sameAsPrevious: boolean;
  firstDiffPath?: string;
  previousValue?: unknown;
  currentValue?: unknown;
  commonPrefixChars?: number;
  roughCommonPrefixTokens?: number;
  valueDiffIndex?: number;
  roughValuePrefixTokens?: number;
  previousExcerpt?: string;
  currentExcerpt?: string;
};

type LLMRequestPreview = LLMRequestLogEntry & {
  source: "preview" | "actual";
  conversationId?: string;
};

type LLMResponseLogEntry = {
  id: number;
  sessionId?: number;
  requestId?: number;
  time: string;
  message: LLMChatResult["message"];
  finishReason?: string;
  usage?: LLMChatResult["usage"];
  raw?: unknown;
};

type ActiveLLMSession = {
  id: number;
  startedAt: string;
  updatedAt: string;
  archiveFilePath?: string;
  requestIds: number[];
  responseIds: number[];
  messages: LLMChatInput["messages"];
  latestRequest?: unknown;
  staticPromptFingerprint?: string;
  requestTimestamps: string[];
  lastTotalTokens?: number;
  mode?: string;
  modeStaticMessages?: LLMChatInput["messages"];
  modeStaticTokenEstimate?: number;
  modeStartedAt?: string;
  clearedAt?: string;
  reason?: string;
  requests?: LLMRequestLogEntry[];
  responses?: LLMResponseLogEntry[];
};

type LLMSessionArchiveEvent =
  | { recordType: "llm_session_event"; event: "session_started"; sessionId: number; time: string; startedAt: string }
  | { recordType: "llm_session_event"; event: "messages_appended"; sessionId: number; time: string; messages: LLMChatInput["messages"]; staticPromptFingerprint?: string; requestTimestamps?: string[]; lastTotalTokens?: number; mode?: string; modeStaticMessages?: LLMChatInput["messages"]; modeStaticTokenEstimate?: number; modeStartedAt?: string }
  | { recordType: "llm_session_event"; event: "messages_replaced"; sessionId: number; time: string; messages: LLMChatInput["messages"]; staticPromptFingerprint?: string; requestTimestamps?: string[]; lastTotalTokens?: number; mode?: string; modeStaticMessages?: LLMChatInput["messages"]; modeStaticTokenEstimate?: number; modeStartedAt?: string }
  | { recordType: "llm_session_event"; event: "request_logged"; sessionId: number; time: string; requestId: number; request: LLMRequestLogEntry }
  | { recordType: "llm_session_event"; event: "response_logged"; sessionId: number; time: string; responseId: number; response: LLMResponseLogEntry }
  | { recordType: "llm_session_event"; event: "session_cleared"; sessionId: number; time: string; reason: LLMSessionClearReason };

const logs: LogEntry[] = [];
const messageLogs: MessageLogEntry[] = [];
const llmRequestLogs: LLMRequestLogEntry[] = [];
const llmResponseLogs: LLMResponseLogEntry[] = [];
let activeLLMSession: ActiveLLMSession | undefined;
let nextLogId = 1;
let nextMessageLogId = 1;
let nextLLMRequestLogId = 1;
let nextLLMResponseLogId = 1;
let nextLLMSessionId = 1;
let llmSessionBusy = false;
let store: ReturnType<typeof createAliceStore> | undefined;
let tokenUsageStore: ReturnType<typeof createTokenUsageStore> | undefined;
let systemLogStore: ReturnType<typeof createFileLogStore> | undefined;
const currentTime = createMutableCurrentTimeProvider("UTC");

const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

console.log = (...args: unknown[]) => {
  appendLog("info", args.map(formatLogArg).join(" "));
  originalConsoleLog(...args);
};

console.error = (...args: unknown[]) => {
  appendLog("error", args.map(formatLogArg).join(" "));
  originalConsoleError(...args);
};

loadDotEnv(".env");
const config = loadConfig();
currentTime.setTimeZone(config.core.timezone);
let llm = createLLMClientFromConfig();
const activeLLM = createMutableLLMClient(llm);
store = createAliceStore("data/alice.sqlite", {
  time: currentTime,
  messageDbPath: path.join(config.memoryFiles.root, "message", "messages.sqlite"),
  messageLogDbPath: path.join("logs", "message", "message-logs.sqlite")
});
tokenUsageStore = createTokenUsageStore(path.join("logs", "token_usage", "token-usage.sqlite"));
systemLogStore = createFileLogStore("logs/system", { getTimeZone: () => currentTime.timeZone });
for (const entry of systemLogStore.listRecent(500)) {
  logs.push(entry);
  nextLogId = Math.max(nextLogId, entry.id + 1);
}
for (const entry of store.listMessageLogs(500)) {
  messageLogs.push(entry);
  nextMessageLogId = Math.max(nextMessageLogId, entry.id + 1);
}
activeLLMSession = restorePersistedActiveLLMSession();
if (activeLLMSession) appendLog("info", `llm active session restored: session=${activeLLMSession.id} file=${activeLLMSession.archiveFilePath ?? ""} requests=${activeLLMSession.requestIds.length}`);

const outputRouter = createOutputRouter();
const agentState = createAgentStateController({
  store: createJsonAgentStateStore(path.join(config.memoryFiles.root, "state", "agent-state.json")),
  time: currentTime,
  onPersistError(error) {
    appendLog("warn", `agent state persist failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});
const feishuPairingStore = createFeishuPairingStore("memory-files/indexes/feishu-paired-contacts.json", {
  read(filePath) {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
  },
  write(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}, { time: currentTime });
const wechatStateStore = createWeChatStateStore(path.join(config.memoryFiles.root, "indexes", "wechat-ilink-state.json"));
const wechatCredentials = wechatStateStore.getCredentials();
if (wechatCredentials) {
  config.plugins.wechat.botToken = wechatCredentials.botToken;
  config.plugins.wechat.baseURL = wechatCredentials.baseURL;
} else if (config.plugins.wechat.botToken) {
  wechatStateStore.saveCredentials({
    botToken: config.plugins.wechat.botToken,
    baseURL: config.plugins.wechat.baseURL,
    loggedInAt: currentTime.now().iso
  });
}
const promptProfileStore = createPromptProfileStore(path.join(config.memoryFiles.root, "config", "prompt-profile.json"));
const coreProfileStore = createCoreProfileStore(path.join(config.memoryFiles.root, "config", "core-profile.json"));
const dailyShellStore = createDailyShellStore(config.memoryFiles.root, {
  onSwitch(entry) {
    appendLog("info", `daily shell switched: ${entry.message} outfit=${entry.outfitName} date=${entry.date}`);
  }
});
const messagingTools = createMessagingTools({
  store,
  outputRouter,
  time: currentTime,
  tts: config.tts,
  getUserName: () => promptProfileStore.get().userName,
  getShellSwitchLogs: () => dailyShellStore.listSwitchLogs(500),
  getDefaultTarget() {
    return getDefaultMessagingTarget();
  },
  appendMessageLog,
  appendLog
});
const mediaTools = createMediaTools({
  store,
  outputRouter,
  time: currentTime,
  selfieReferenceDir: config.media.selfieReferenceDir,
  selfieOutputDir: config.media.selfieOutputDir,
  selfieCodexCommand: config.media.selfieCodexCommand,
  selfieCodexTimeoutMs: config.media.selfieCodexTimeoutMs,
  selfieImageApiKey: config.media.selfieImageApiKey,
  selfieImageApiBaseURL: config.media.selfieImageApiBaseURL,
  selfieImageApiModel: config.media.selfieImageApiModel,
  selfieImageApiSize: config.media.selfieImageApiSize,
  selfieImageApiQuality: config.media.selfieImageApiQuality,
  selfieImageApiOutputFormat: config.media.selfieImageApiOutputFormat,
  selfieImageApiOutputCompression: config.media.selfieImageApiOutputCompression,
  selfieImageApiTimeoutMs: config.media.selfieImageApiTimeoutMs,
  selfieMaxBytes: config.media.selfieMaxBytes,
  getSelfieContext() {
    const daily = dailyShellStore.get(currentTime.now().date, currentTime.timeZone);
    const profile = promptProfileStore.get();
    return {
      mainPrompt: profile.layers.map((layer) => layer.content).join("\n\n"),
      personalityName: daily.personality.name,
      personalityContent: daily.personality.content,
      outfitId: daily.outfit.id,
      outfitName: daily.outfit.name,
      outfitContent: daily.outfit.content,
      outfitImageUrl: daily.outfit.imageUrl
    };
  },
  getUserName: () => promptProfileStore.get().userName,
  getAppearanceDescription: () => coreProfileStore.get().appearanceDescription,
  getDefaultTarget() {
    return getDefaultMessagingTarget();
  },
  appendLog,
  appendMessageLog
});
const shellTools = createShellTools({
  dailyShellStore,
  store,
  outputRouter,
  time: currentTime,
  getDefaultTarget() {
    return getDefaultMessagingTarget();
  },
  appendMessageLog
});
const bookcaseTools = createBookcaseTools({
  getUserName: () => promptProfileStore.get().userName,
  time: currentTime,
  store,
  outputRouter,
  appendMessageLog
});
const toolPlugins = [messagingTools, mediaTools, shellTools, bookcaseTools];
const core = createAgentCore({
  config,
  llm: activeLLM,
  outputRouter,
  intentRouter: createIntentRouter(),
  sessionResolver: createSessionResolver(),
  policy: createAllowAllPolicy(),
  tools: toolPlugins,
  getPromptProfile: () => promptProfileStore.get(),
  getDailyShell: () => dailyShellStore.render(currentTime.now().date, currentTime.timeZone),
  getDailyShellRaw: () => dailyShellStore.get(currentTime.now().date, currentTime.timeZone),
  getAppearanceDescription: () => coreProfileStore.get().appearanceDescription,
  state: agentState,
  time: currentTime,
  loadLLMSession: loadActiveLLMSessionTranscript,
  onLLMRequestPrepared: appendLLMRequestLog,
  onLLMResponseReceived: appendLLMResponseLog,
  onLLMHeartbeatStarted() {
    llmSessionBusy = true;
    messagingTools.noteLLMRequestStarted();
  },
  onLLMSessionUpdated(session) {
    updateActiveLLMSessionTranscript(session);
  },
  onLLMSessionCleared(reason) {
    llmSessionBusy = false;
    messagingTools.noteLLMSessionCompleted();
    clearActiveLLMSession(reason);
  },
  onLLMSessionRebuilt() {
    clearActiveLLMSession("mode_transition");
    messagingTools.noteLLMSessionCompleted();
    messagingTools.noteLLMRequestStarted();
  },
  onLLMLog(event) {
    const mode = event.stream ? "stream" : "non-stream";
    if (event.kind === "call_start") {
      appendLog("info", `llm call start: round=${event.round} mode=${mode} model=${event.model ?? config.llm.model}`);
    }
    if (event.kind === "rate_limited") appendLog("warn", `llm call skipped: active session reached 10 requests in 60s model=${event.model ?? config.llm.model}`);
    if (event.kind === "stream_start") appendLog("info", `llm stream start: round=${event.round} model=${event.model ?? config.llm.model}`);
    if (event.kind === "stream_end") appendLog("info", `llm stream end: round=${event.round} model=${event.model ?? config.llm.model}`);
    if (event.kind === "response_received") appendLog("info", `llm response received: round=${event.round} mode=${mode} model=${event.model ?? config.llm.model}`);
  },
  onLLMSessionCompleted(_result) {
    llmSessionBusy = false;
  },
  initialLLMSession: activeLLMSession
});

const feishu = createFeishuPlugin(config.plugins.feishu, {
  log: appendLog,
  pairingStore: feishuPairingStore,
  time: currentTime,
  async onEvent(event) {
    messageRuntime.ingestEvent(event);
  },
  async onLifecycleEvent(event) {
    messageRuntime.ingestLifecycle({ plugin: "feishu", ...event });
  }
});

const wechat = createWeChatPlugin(config.plugins.wechat, {
  log: appendLog,
  stateStore: wechatStateStore,
  time: currentTime,
  async onEvent(event) {
    messageRuntime.ingestEvent(event);
  }
});

const messageRuntime = createMessageRuntime({
  getDelayMs: () => config.core.inboundDebounceMs,
  time: currentTime,
  getProcessNowTarget() {
    return getDefaultMessagingTarget();
  },
  store,
  core,
  agentState,
  outputRouter,
  isLLMSessionActive: () => llmSessionBusy,
  async setTypingIndicator(input) {
    if (input.plugin !== "wechat") return;
    await wechat.setTyping({
      userId: input.userId ?? input.channelId,
      sessionId: input.sessionId,
      typing: input.typing
    });
  },
  onHeartbeatTick() {
    dailyShellStore.get(currentTime.now().date, currentTime.timeZone);
  },
  appendLog,
  appendMessageLog
});

core.registerChannel(feishu);
core.registerChannel(wechat);
const scheduler = createDailyScheduler(createDailyMaintenanceTasks({
  systemLogStore,
  ttsOutputDirs: [config.tts.genieOutputDir, config.tts.mossOutputDir],
  nowIso: () => currentTime.now().iso,
  log: appendLog
}));

const runtimeState = { feishuStarted: false, wechatStarted: false };
const server = http.createServer(createApiRequestHandler({
  config,
  logs,
  messageLogs,
  llmRequestLogs,
  llmResponseLogs,
  getActiveLLMSession: () => getActiveLLMSessionSnapshot(),
  getClearedLLMSessions,
  getLLMSession,
  store,
  getLLMRequestPreview,
  getLLMRequestProfilePreview,
  getTokenUsageReport,
  clearLLMChainCache,
  outputRouter,
  feishuPairingStore,
  coreProfileStore,
  promptProfileStore,
  getDailyShell: () => dailyShellStore.render(currentTime.now().date, currentTime.timeZone),
  dailyShellStore,
  agentState,
  messagingTools,
  mediaTools,
  shellTools,
  bookcaseTools,
  feishu,
  wechat,
  wechatStateStore,
  runtime: runtimeState,
  messageRuntime,
  getLLM: () => llm,
  reloadLLM() {
    llm = createLLMClientFromConfig();
    activeLLM.setClient(llm);
  },
  time: currentTime,
  setTimeZone(timeZone) {
    currentTime.setTimeZone(timeZone);
  },
  appendLog,
  appendMessageLog
}));

await core.start();
scheduler.start();
messageRuntime.recoverPendingSessions();
runtimeState.feishuStarted = config.plugins.feishu.enabled && Object.keys(config.plugins.feishu.accounts).length > 0;
runtimeState.wechatStarted = config.plugins.wechat.enabled && Boolean(config.plugins.wechat.botToken);
appendLog("info", `agent core started: llm=${config.llm.provider} feishu=${runtimeState.feishuStarted ? "started" : "stopped"} wechat=${runtimeState.wechatStarted ? "started" : "stopped"}`);

server.listen(config.api.port, config.api.host, () => {
  console.log(`[api] listening on http://${config.api.host}:${config.api.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    appendLog("info", `shutdown requested: ${signal}`);
    scheduler.stop();
    await messageRuntime.flushAll();
    await core.stop();
    server.close(() => process.exit(0));
  });
}

function appendLog(level: LogLevel, message: string): void {
  const entry = {
    id: nextLogId,
    time: currentTime.now().iso,
    level,
    message
  };
  logs.push(entry);
  nextLogId += 1;
  systemLogStore?.append({
    time: entry.time,
    level: entry.level,
    message: entry.message
  });

  if (logs.length > 500) {
    logs.splice(0, logs.length - 500);
  }
}

function appendMessageLog(input: Omit<MessageLogEntry, "id" | "time">): MessageLogEntry {
  const entry = {
    id: nextMessageLogId,
    time: currentTime.now().iso,
    ...input,
    summary: input.summary.length > 500 ? `${input.summary.slice(0, 500)}...` : input.summary
  };
  messageLogs.push(entry);
  nextMessageLogId += 1;
  store?.insertMessageLog({
    time: entry.time,
    direction: entry.direction,
    plugin: entry.plugin,
      kind: entry.kind,
      target: entry.target,
      sessionId: entry.sessionId,
      rawMessageId: entry.rawMessageId,
      processedAt: entry.processedAt,
      processedBatchId: entry.processedBatchId,
      externalEventId: entry.externalEventId,
      parentRawMessageId: entry.parentRawMessageId,
      actorId: entry.actorId,
      status: entry.status,
      rawJson: entry.rawJson,
      error: entry.error,
      summary: entry.summary
    });

  if (messageLogs.length > 500) {
    messageLogs.splice(0, messageLogs.length - 500);
  }
  return entry;
}

function formatLogArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createLLMClientFromConfig() {
  return config.llm.provider === "openai-compatible" && config.llm.baseURL && config.llm.apiKey
    ? createOpenAICompatibleClient({
        baseURL: config.llm.baseURL,
        apiKey: config.llm.apiKey,
        model: config.llm.model,
        temperature: config.llm.temperature,
        timeoutMs: config.llm.timeoutMs,
        extraParams: config.llm.extraParams
      })
    : createStubLLMClient();
}

function appendLLMRequestLog(input: LLMChatInput): void {
  const rawRequest = buildRawLLMRequest(input);
  const previous = llmRequestLogs[llmRequestLogs.length - 1]?.rawRequest;
  const diffFromPrevious = previous === undefined ? undefined : diffRequests(previous, rawRequest);
  const now = currentTime.now().iso;
  const sessionId = ensureActiveLLMSession(now).id;
  const entry = {
    id: nextLLMRequestLogId,
    sessionId,
    time: now,
    model: input.model,
    temperature: input.temperature,
    messages: input.messages.map((message) => ({ ...message })),
    tools: input.tools?.map((tool) => ({ ...tool, function: { ...tool.function } })),
    extraParams: input.extraParams,
    rawRequest,
    diffFromPrevious
  };
  llmRequestLogs.push(entry);
  noteActiveLLMRequest(entry);
  nextLLMRequestLogId += 1;
  if (llmRequestLogs.length > 50) {
    llmRequestLogs.splice(0, llmRequestLogs.length - 50);
  }
}

function diffRequests(previous: unknown, current: unknown): LLMRequestDiff {
  const first = firstDiff(previous, current, "$");
  const previousText = stableStringify(previous);
  const currentText = stableStringify(current);
  const valueDiff = first ? diffValueExcerpt(first.previousValue, first.currentValue) : undefined;
  return {
    sameAsPrevious: !first,
    firstDiffPath: first?.path,
    previousValue: first?.previousValue,
    currentValue: first?.currentValue,
    commonPrefixChars: commonPrefixLength(previousText, currentText),
    roughCommonPrefixTokens: estimateDeepSeekTokens(previousText.slice(0, commonPrefixLength(previousText, currentText))),
    valueDiffIndex: valueDiff?.index,
    roughValuePrefixTokens: valueDiff ? estimateDeepSeekTokens(valueTextPrefix(first?.previousValue, valueDiff.index)) : undefined,
    previousExcerpt: valueDiff?.previousExcerpt,
    currentExcerpt: valueDiff?.currentExcerpt
  };
}

function firstDiff(previous: unknown, current: unknown, path: string): { path: string; previousValue: unknown; currentValue: unknown } | undefined {
  if (Object.is(previous, current)) return undefined;
  if (!previous || !current || typeof previous !== "object" || typeof current !== "object") {
    return { path, previousValue: previous, currentValue: current };
  }
  if (Array.isArray(previous) || Array.isArray(current)) {
    if (!Array.isArray(previous) || !Array.isArray(current)) return { path, previousValue: previous, currentValue: current };
    const length = Math.max(previous.length, current.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= previous.length || index >= current.length) return { path: `${path}[${index}]`, previousValue: previous[index], currentValue: current[index] };
      const nested = firstDiff(previous[index], current[index], `${path}[${index}]`);
      if (nested) return nested;
    }
    return undefined;
  }
  const previousRecord = previous as Record<string, unknown>;
  const currentRecord = current as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(previousRecord), ...Object.keys(currentRecord)])].sort();
  for (const key of keys) {
    if (!(key in previousRecord) || !(key in currentRecord)) return { path: `${path}.${key}`, previousValue: previousRecord[key], currentValue: currentRecord[key] };
    const nested = firstDiff(previousRecord[key], currentRecord[key], `${path}.${key}`);
    if (nested) return nested;
  }
  return undefined;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
  }) ?? "";
}

function commonPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) index += 1;
  return index;
}

function formatDiffValue(value: unknown): string {
  const text = typeof value === "string" ? value : stableStringify(value);
  return JSON.stringify(text.length > 160 ? `${text.slice(0, 160)}...` : text);
}

function diffValueExcerpt(previous: unknown, current: unknown): { index: number; previousExcerpt: string; currentExcerpt: string } {
  const previousText = typeof previous === "string" ? previous : stableStringify(previous);
  const currentText = typeof current === "string" ? current : stableStringify(current);
  const index = commonPrefixLength(previousText, currentText);
  return {
    index,
    previousExcerpt: excerptAround(previousText, index),
    currentExcerpt: excerptAround(currentText, index)
  };
}

function excerptAround(text: string, index: number): string {
  const radius = 80;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function valueTextPrefix(value: unknown, length: number): string {
  const text = typeof value === "string" ? value : stableStringify(value);
  return text.slice(0, length);
}

function estimateDeepSeekTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    tokens += /[\u4e00-\u9fff]/.test(char) ? 0.6 : 0.3;
  }
  return Math.round(tokens);
}

function appendLLMResponseLog(result: LLMChatResult): void {
  appendLLMUsageLog(result);
  const now = currentTime.now().iso;
  const entry = {
    id: nextLLMResponseLogId,
    sessionId: activeLLMSession?.id,
    requestId: activeLLMSession?.requestIds.at(-1),
    time: now,
    message: { ...result.message },
    finishReason: result.finishReason,
    usage: result.usage,
    raw: result.raw
  };
  llmResponseLogs.push(entry);
  noteActiveLLMResponse(entry);
  recordTokenUsage(entry, result);
  nextLLMResponseLogId += 1;
  if (llmResponseLogs.length > 50) {
    llmResponseLogs.splice(0, llmResponseLogs.length - 50);
  }
}

function recordTokenUsage(entry: LLMResponseLogEntry, result: LLMChatResult): void {
  const usage = result.usage;
  try {
    tokenUsageStore?.insert({
      createdAt: entry.time,
      agentId: "core",
      model: result.model ?? config.llm.model,
      sessionId: entry.sessionId,
      requestId: entry.requestId,
      responseId: entry.id,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage?.totalTokens,
      cacheHitTokens: usage?.cacheHitTokens,
      cacheMissTokens: usage?.cacheMissTokens,
      finishReason: result.finishReason,
      rawUsageJson: extractRawUsageJson(result.raw)
    });
  } catch (error) {
    appendLog("warn", `token usage persist failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function appendLLMUsageLog(result: LLMChatResult): void {
  const rawUsage = extractRawUsage(result.raw);
  const usage = result.usage;
  if (!usage) {
    appendLog("info", `llm token usage: input=? output=? total=? cache_hit=? cache_miss=? model=${result.model ?? config.llm.model} raw_usage=${rawUsage}`);
    return;
  }
  appendLog("info", [
    "llm token usage:",
    `input=${formatTokenCount(usage.inputTokens)}`,
    `output=${formatTokenCount(usage.outputTokens)}`,
    `total=${formatTokenCount(usage.totalTokens)}`,
    `cache_hit=${formatTokenCount(usage.cacheHitTokens)}`,
    `cache_miss=${formatTokenCount(usage.cacheMissTokens)}`,
    `model=${result.model ?? config.llm.model}`,
    `raw_usage=${rawUsage}`
  ].join(" "));
}

function extractRawUsage(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "undefined";
  const usage = (raw as { usage?: unknown }).usage;
  if (usage === undefined) return "undefined";
  try {
    return JSON.stringify(usage);
  } catch {
    return String(usage);
  }
}

function extractRawUsageJson(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = (raw as { usage?: unknown }).usage;
  if (usage === undefined) return undefined;
  try {
    return JSON.stringify(usage);
  } catch {
    return String(usage);
  }
}

function formatTokenCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

function getTokenUsageReport(query: TokenUsageQuery) {
  return tokenUsageStore?.report(query) ?? {
    summary: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0
    },
    buckets: [],
    byModel: [],
    byModelBucket: [],
    latest: []
  };
}

function clearLLMChainCache(): void {
  core.clearLLMSession("admin_clear");
}

function ensureActiveLLMSession(time: string): ActiveLLMSession {
  if (!activeLLMSession) {
    activeLLMSession = {
      id: nextLLMSessionId,
      startedAt: time,
      updatedAt: time,
      archiveFilePath: llmSessionFilePath(time),
      requestIds: [],
      responseIds: [],
      messages: [],
      latestRequest: undefined,
      requestTimestamps: []
    };
    nextLLMSessionId += 1;
    appendLLMSessionArchiveEvent(activeLLMSession, {
      recordType: "llm_session_event",
      event: "session_started",
      sessionId: activeLLMSession.id,
      time,
      startedAt: time
    });
  }
  return activeLLMSession;
}

function noteActiveLLMRequest(entry: LLMRequestLogEntry): void {
  const session = ensureActiveLLMSession(entry.time);
  entry.sessionId = session.id;
  session.updatedAt = entry.time;
  session.requestIds.push(entry.id);
  session.latestRequest = entry.rawRequest;
  session.requests = [...(session.requests ?? []), archiveRequestEntry(entry)];
  appendLLMSessionArchiveEvent(session, {
    recordType: "llm_session_event",
    event: "request_logged",
    sessionId: session.id,
    time: entry.time,
    requestId: entry.id,
    request: archiveRequestEntry(entry)
  });
}

function noteActiveLLMResponse(entry: LLMResponseLogEntry): void {
  if (!activeLLMSession) return;
  activeLLMSession.updatedAt = entry.time;
  activeLLMSession.responseIds.push(entry.id);
  activeLLMSession.responses = [...(activeLLMSession.responses ?? []), entry];
  appendLLMSessionArchiveEvent(activeLLMSession, {
    recordType: "llm_session_event",
    event: "response_logged",
    sessionId: activeLLMSession.id,
    time: entry.time,
    responseId: entry.id,
    response: entry
  });
}

function updateActiveLLMSessionTranscript(input: LLMSessionSnapshot & { staticPromptFingerprint: string; requestTimestamps: string[] }): void {
  const now = currentTime.now().iso;
  const session = ensureActiveLLMSession(now);
  session.updatedAt = now;
  const commonPrefix = commonMessagePrefixLength(session.messages, input.messages);
  const isAppend = commonPrefix === session.messages.length;
  const delta = input.messages.slice(commonPrefix);
  const nextMode = input.mode ?? "normal";
  const nextModeStaticMessages = input.modeStaticMessages ?? [];
  const nextModeStaticTokenEstimate = input.modeStaticTokenEstimate ?? 0;
  const nextModeStartedAt = nextMode === "normal" ? undefined : input.modeStartedAt;
  const tokenUsageChanged = session.lastTotalTokens !== input.lastTotalTokens;
  const modeChanged = session.mode !== nextMode
    || session.modeStaticTokenEstimate !== nextModeStaticTokenEstimate
    || session.modeStartedAt !== nextModeStartedAt
    || stableStringify(session.modeStaticMessages ?? []) !== stableStringify(nextModeStaticMessages);
  session.messages = input.messages;
  session.staticPromptFingerprint = input.staticPromptFingerprint;
  session.requestTimestamps = input.requestTimestamps;
  session.lastTotalTokens = input.lastTotalTokens;
  session.mode = nextMode;
  session.modeStaticMessages = nextModeStaticMessages;
  session.modeStaticTokenEstimate = nextModeStaticTokenEstimate;
  session.modeStartedAt = nextModeStartedAt;
  if (isAppend && delta.length === 0 && !tokenUsageChanged && !modeChanged) return;
  appendLLMSessionArchiveEvent(session, {
    recordType: "llm_session_event",
    event: isAppend ? "messages_appended" : "messages_replaced",
    sessionId: session.id,
    time: now,
    messages: isAppend ? delta : input.messages,
    staticPromptFingerprint: input.staticPromptFingerprint,
    requestTimestamps: input.requestTimestamps,
    lastTotalTokens: input.lastTotalTokens,
    mode: session.mode,
    modeStaticMessages: session.modeStaticMessages,
    modeStaticTokenEstimate: session.modeStaticTokenEstimate,
    modeStartedAt: session.modeStartedAt
  });
}

function clearActiveLLMSession(reason: LLMSessionClearReason): void {
  if (!activeLLMSession) return;
  const sessionId = activeLLMSession.id;
  const requestCount = activeLLMSession.requestIds.length;
  activeLLMSession.clearedAt = currentTime.now().iso;
  activeLLMSession.reason = reason;
  appendLLMSessionArchiveEvent(activeLLMSession, {
    recordType: "llm_session_event",
    event: "session_cleared",
    sessionId: activeLLMSession.id,
    time: activeLLMSession.clearedAt,
    reason
  });
  activeLLMSession = undefined;
  appendLog("info", `llm active session cleared: session=${sessionId} reason=${reason} requests=${requestCount}`);
}

function appendLLMSessionArchiveEvent(session: ActiveLLMSession, event: LLMSessionArchiveEvent): void {
  const filePath = session.archiveFilePath ?? llmSessionFilePath(session.startedAt);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`);
  session.archiveFilePath = filePath;
}

function getActiveLLMSessionSnapshot(): unknown {
  if (!activeLLMSession) return undefined;
  return summarizeLLMSession(readLatestLLMSessionSnapshot(activeLLMSession.id) ?? activeLLMSession);
}

function loadActiveLLMSessionTranscript(): LLMSessionSnapshot | undefined {
  if (!activeLLMSession) return undefined;
  const latest = readLatestLLMSessionSnapshot(activeLLMSession.id);
  if (!latest || latest.clearedAt) return undefined;
  return {
    messages: latest.messages ?? [],
    staticPromptFingerprint: latest.staticPromptFingerprint,
    requestTimestamps: latest.requestTimestamps,
    lastTotalTokens: latest.lastTotalTokens,
    mode: latest.mode ?? "normal",
    modeStaticMessages: latest.modeStaticMessages ?? [],
    modeStaticTokenEstimate: latest.modeStaticTokenEstimate ?? 0,
    modeStartedAt: latest.modeStartedAt
  };
}

function archiveRequestEntry(entry: LLMRequestLogEntry): LLMRequestLogEntry {
  return {
    ...entry,
    messages: cloneLLMMessages(entry.messages),
    tools: cloneLLMTools(entry.tools),
    rawRequest: entry.rawRequest ?? buildRawLLMRequest(entry)
  };
}

function commonMessagePrefixLength(left: LLMChatInput["messages"], right: LLMChatInput["messages"]): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && stableStringify(left[index]) === stableStringify(right[index])) index += 1;
  return index;
}

function llmSessionFilePath(time: string): string {
  const date = String(time || currentTime.now().iso).slice(0, 10);
  return path.join(config.memoryFiles.root, "llm-sessions", `${date}.sessions.jsonl`);
}

function readLatestLLMSessionSnapshot(id: number): ActiveLLMSession | undefined {
  const latest = readAllLLMSessions().filter((session) => session.id === id).at(-1);
  return latest?.clearedAt ? latest : latest;
}

function restorePersistedActiveLLMSession(): ActiveLLMSession | undefined {
  const sessions = readAllLLMSessions();
  const latestById = new Map<number, ActiveLLMSession>();
  for (const session of sessions) {
    latestById.set(session.id, session);
    nextLLMSessionId = Math.max(nextLLMSessionId, session.id + 1);
    for (const request of session.requests ?? []) {
      if (!llmRequestLogs.some((entry) => entry.id === request.id)) {
        llmRequestLogs.push(request);
        nextLLMRequestLogId = Math.max(nextLLMRequestLogId, request.id + 1);
      }
    }
    for (const response of session.responses ?? []) {
      if (!llmResponseLogs.some((entry) => entry.id === response.id)) {
        llmResponseLogs.push(response);
        nextLLMResponseLogId = Math.max(nextLLMResponseLogId, response.id + 1);
      }
    }
  }
  llmRequestLogs.sort((left, right) => left.id - right.id);
  llmResponseLogs.sort((left, right) => left.id - right.id);
  const active = [...latestById.values()]
    .filter((session) => !session.clearedAt && session.staticPromptFingerprint)
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))[0];
  if (!active) return undefined;
  return {
    ...active,
    archiveFilePath: active.archiveFilePath ?? llmSessionFilePath(active.startedAt)
  };
}

function readAllLLMSessions(): ActiveLLMSession[] {
  const dir = path.join(config.memoryFiles.root, "llm-sessions");
  if (!fs.existsSync(dir)) return [];
  const sessions = new Map<number, ActiveLLMSession>();
  for (const name of fs.readdirSync(dir).filter((item) => item.endsWith(".sessions.jsonl")).sort()) {
    const filePath = path.join(dir, name);
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        applyLLMSessionArchiveRecord(sessions, JSON.parse(line), filePath);
      } catch {
        appendLog("warn", `llm session archive parse failed: ${filePath}`);
      }
    }
  }
  return [...sessions.values()];
}

function applyLLMSessionArchiveRecord(sessions: Map<number, ActiveLLMSession>, record: unknown, filePath: string): void {
  if (!record || typeof record !== "object") return;
  const raw = record as Record<string, unknown>;
  if (raw.recordType === "llm_session_event") {
    applyLLMSessionArchiveEvent(sessions, raw as LLMSessionArchiveEvent, filePath);
    return;
  }
  applyLegacyLLMSessionSnapshot(sessions, raw, filePath);
}

function applyLegacyLLMSessionSnapshot(sessions: Map<number, ActiveLLMSession>, raw: Record<string, unknown>, filePath: string): void {
  if (typeof raw.id !== "number") return;
  sessions.set(raw.id, {
    id: raw.id,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    archiveFilePath: typeof raw.archiveFilePath === "string" ? raw.archiveFilePath : filePath,
    requestIds: numberArray(raw.requestIds),
    responseIds: numberArray(raw.responseIds),
    messages: Array.isArray(raw.messages) ? raw.messages as LLMChatInput["messages"] : [],
    latestRequest: raw.latestRequest,
    staticPromptFingerprint: typeof raw.staticPromptFingerprint === "string" ? raw.staticPromptFingerprint : undefined,
    requestTimestamps: stringArray(raw.requestTimestamps),
    lastTotalTokens: typeof raw.lastTotalTokens === "number" && Number.isFinite(raw.lastTotalTokens) ? raw.lastTotalTokens : undefined,
    mode: typeof raw.mode === "string" ? raw.mode : "normal",
    modeStaticMessages: Array.isArray(raw.modeStaticMessages) ? raw.modeStaticMessages as LLMChatInput["messages"] : [],
    modeStaticTokenEstimate: typeof raw.modeStaticTokenEstimate === "number" && Number.isFinite(raw.modeStaticTokenEstimate) ? raw.modeStaticTokenEstimate : 0,
    modeStartedAt: typeof raw.modeStartedAt === "string" ? raw.modeStartedAt : undefined,
    clearedAt: typeof raw.clearedAt === "string" ? raw.clearedAt : undefined,
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
    requests: Array.isArray(raw.requests) ? raw.requests as LLMRequestLogEntry[] : [],
    responses: Array.isArray(raw.responses) ? raw.responses as LLMResponseLogEntry[] : []
  });
}

function applyLLMSessionArchiveEvent(sessions: Map<number, ActiveLLMSession>, event: LLMSessionArchiveEvent, filePath: string): void {
  if (typeof event.sessionId !== "number") return;
  const session = getOrCreateArchivedLLMSession(sessions, event.sessionId, event.time, filePath);
  session.archiveFilePath = filePath;
  session.updatedAt = event.time || session.updatedAt;
  if (event.event === "session_started") {
    session.startedAt = event.startedAt;
    session.updatedAt = event.time;
    return;
  }
  if (event.event === "messages_appended") {
    session.messages = [...session.messages, ...cloneLLMMessages(event.messages)];
    session.staticPromptFingerprint = event.staticPromptFingerprint ?? session.staticPromptFingerprint;
    session.requestTimestamps = event.requestTimestamps ?? session.requestTimestamps;
    session.lastTotalTokens = event.lastTotalTokens ?? session.lastTotalTokens;
    session.mode = event.mode ?? session.mode ?? "normal";
    session.modeStaticMessages = event.modeStaticMessages ? cloneLLMMessages(event.modeStaticMessages) : session.modeStaticMessages ?? [];
    session.modeStaticTokenEstimate = event.modeStaticTokenEstimate ?? session.modeStaticTokenEstimate ?? 0;
    session.modeStartedAt = event.mode === "normal" ? undefined : event.modeStartedAt ?? session.modeStartedAt;
    hydrateLatestEmptyRequestFromTranscript(session);
    return;
  }
  if (event.event === "messages_replaced") {
    session.messages = cloneLLMMessages(event.messages);
    session.staticPromptFingerprint = event.staticPromptFingerprint ?? session.staticPromptFingerprint;
    session.requestTimestamps = event.requestTimestamps ?? session.requestTimestamps;
    session.lastTotalTokens = event.lastTotalTokens ?? session.lastTotalTokens;
    session.mode = event.mode ?? session.mode ?? "normal";
    session.modeStaticMessages = event.modeStaticMessages ? cloneLLMMessages(event.modeStaticMessages) : session.modeStaticMessages ?? [];
    session.modeStaticTokenEstimate = event.modeStaticTokenEstimate ?? session.modeStaticTokenEstimate ?? 0;
    session.modeStartedAt = event.mode === "normal" ? undefined : event.modeStartedAt ?? session.modeStartedAt;
    hydrateLatestEmptyRequestFromTranscript(session);
    return;
  }
  if (event.event === "request_logged") {
    if (!session.requestIds.includes(event.requestId)) session.requestIds.push(event.requestId);
    const messages = event.request.messages?.length ? cloneLLMMessages(event.request.messages) : cloneLLMMessages(session.messages);
    const request = {
      ...event.request,
      sessionId: event.sessionId,
      messages,
      tools: cloneLLMTools(event.request.tools),
      rawRequest: event.request.rawRequest ?? (messages.length ? buildRawLLMRequest({ ...event.request, messages }) : undefined)
    };
    session.requests = [...(session.requests ?? []).filter((entry) => entry.id !== request.id), request];
    session.latestRequest = request.rawRequest;
    return;
  }
  if (event.event === "response_logged") {
    if (!session.responseIds.includes(event.responseId)) session.responseIds.push(event.responseId);
    const response = { ...event.response, sessionId: event.sessionId };
    session.responses = [...(session.responses ?? []).filter((entry) => entry.id !== response.id), response];
    return;
  }
  if (event.event === "session_cleared") {
    session.clearedAt = event.time;
    session.reason = event.reason;
  }
}

function getOrCreateArchivedLLMSession(sessions: Map<number, ActiveLLMSession>, id: number, time: string, filePath: string): ActiveLLMSession {
  const existing = sessions.get(id);
  if (existing) return existing;
  const session: ActiveLLMSession = {
    id,
    startedAt: time,
    updatedAt: time,
    archiveFilePath: filePath,
    requestIds: [],
    responseIds: [],
    messages: [],
    requestTimestamps: [],
    mode: "normal",
    modeStaticMessages: [],
    modeStaticTokenEstimate: 0,
    requests: [],
    responses: []
  };
  sessions.set(id, session);
  return session;
}

function cloneLLMMessages(messages: LLMChatInput["messages"]): LLMChatInput["messages"] {
  return messages.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map((call) => ({ ...call, function: { ...call.function } }))
  }));
}

function cloneLLMTools(tools: LLMChatInput["tools"] | undefined): LLMChatInput["tools"] | undefined {
  return tools?.map((tool) => ({
    ...tool,
    function: {
      ...tool.function,
      parameters: cloneJsonObject(tool.function.parameters)
    }
  }));
}

function cloneJsonObject<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const text = JSON.stringify(value);
  return text === undefined ? value : JSON.parse(text) as T;
}

function hydrateLatestEmptyRequestFromTranscript(session: ActiveLLMSession): void {
  if (session.responseIds.length > 0 || session.messages.length === 0) return;
  const latestRequestId = session.requestIds.at(-1);
  if (latestRequestId === undefined || !session.requests) return;
  session.requests = session.requests.map((request) => {
    if (request.id !== latestRequestId || request.messages.length > 0) return request;
    const messages = cloneLLMMessages(session.messages);
    return {
      ...request,
      messages,
      rawRequest: request.rawRequest ?? buildRawLLMRequest({ ...request, messages })
    };
  });
  const latestRequest = session.requests.find((request) => request.id === latestRequestId);
  if (latestRequest) session.latestRequest = latestRequest.rawRequest;
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function getClearedLLMSessions(): unknown[] {
  const latestById = new Map<number, ActiveLLMSession>();
  for (const session of readAllLLMSessions()) {
    latestById.set(session.id, session);
  }
  return [...latestById.values()]
    .filter((session) => Boolean(session.clearedAt))
    .sort((left, right) => String(left.startedAt || "").localeCompare(String(right.startedAt || "")))
    .slice(-50)
    .map(summarizeLLMSession);
}

function getLLMSession(id: number): unknown {
  const session = readLatestLLMSessionSnapshot(id) ?? (activeLLMSession?.id === id ? activeLLMSession : undefined);
  return session ? {
    ...session,
    requests: (session.requests ?? []).sort(compareLLMLogEntries),
    responses: (session.responses ?? []).sort(compareLLMLogEntries)
  } : undefined;
}

function summarizeLLMSession(session: ActiveLLMSession): unknown {
  return {
    id: session.id,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    requestIds: session.requestIds,
    responseIds: session.responseIds,
    requestCount: session.requests?.length ?? session.requestIds.length,
    responseCount: session.responses?.length ?? session.responseIds.length,
    staticPromptFingerprint: session.staticPromptFingerprint,
    mode: session.mode ?? "normal",
    modeStaticTokenEstimate: session.modeStaticTokenEstimate ?? 0,
    modeStartedAt: session.modeStartedAt,
    clearedAt: session.clearedAt,
    reason: session.reason,
    archiveFilePath: session.archiveFilePath
  };
}

function compareLLMLogEntries(left: { time?: string; id?: number }, right: { time?: string; id?: number }): number {
  const byTime = String(left.time || "").localeCompare(String(right.time || ""));
  if (byTime) return byTime;
  return Number(left.id || 0) - Number(right.id || 0);
}

async function getLLMRequestPreview(): Promise<LLMRequestPreview | undefined> {
  const latest = llmRequestLogs[llmRequestLogs.length - 1];
  if (activeLLMSession && latest) return { ...latest, source: "actual" };

  const preview = await buildLLMRequestPreviewFromMessages();
  if (preview) return { ...preview, rawRequest: buildRawLLMRequest(preview) };

  if (latest) return { ...latest, source: "actual" };
  return undefined;
}

async function getLLMRequestProfilePreview(): Promise<LLMRequestPreview | undefined> {
  const profilePreview = await buildLLMRequestPreviewFromProfile();
  return profilePreview ? { ...profilePreview, rawRequest: buildRawLLMRequest(profilePreview) } : undefined;
}

async function buildLLMRequestPreviewFromProfile(): Promise<LLMRequestPreview | undefined> {
  const profile = promptProfileStore.get();
  const target = getDefaultMessagingTarget();
  const previewEvent = {
    id: "preview",
    source: {
      plugin: target?.plugin ?? "wechat",
      accountId: target?.accountId,
      channelId: target?.channelId ?? target?.userId ?? "preview",
      userId: target?.userId
    },
    session: {
      scope: "dm",
      sessionId: target?.sessionId ?? "preview"
    },
    type: "message.text",
    payload: { kind: "text", text: "" },
    meta: {
      receivedAt: currentTime.now().iso
    }
  } as const;
  return {
    id: 0,
    source: "preview",
    conversationId: target?.sessionId ?? "preview",
    time: currentTime.now().iso,
    model: config.llm.model,
    temperature: config.llm.temperature,
    extraParams: config.llm.extraParams,
    messages: await buildPromptPreviewMessages(profile, previewEvent, true),
    tools: visibleToolSpecs(profile)
  };
}

function getDefaultMessagingTarget() {
  const mode = config.core.defaultTargetPlugin ?? "auto";
  const wechatTarget = config.plugins.wechat.enabled ? wechatStateStore.getDefaultTarget() : undefined;
  const feishuTarget = getDefaultFeishuTarget();
  if (mode === "wechat") return wechatTarget;
  if (mode === "feishu") return feishuTarget;
  return wechatTarget ?? feishuTarget;
}

function getDefaultFeishuTarget() {
  const contact = feishuPairingStore.list()[0];
  if (!contact) return undefined;
  return {
    plugin: "feishu",
    accountId: "main",
    channelId: contact.channelId,
    userId: contact.channelId ? undefined : contact.userId,
    sessionId: contact.sessionId ?? contact.channelId ?? contact.userId ?? "admin-test"
  };
}

async function buildLLMRequestPreviewFromMessages(): Promise<LLMRequestPreview | undefined> {
  const recent = store?.listMessages(500) ?? [];
  const latestInbound = [...recent].reverse().find((message) => (
    message.direction === "inbound" &&
    !message.isRecalled &&
    !message.isRead &&
    !message.coreProcessedAt
  ));
  if (!latestInbound) return undefined;

  const previewEvent = {
    id: `preview_${latestInbound.id}`,
    source: {
      plugin: latestInbound.plugin,
      channelId: latestInbound.conversationId,
      userId: latestInbound.senderId,
      rawMessageId: latestInbound.externalMessageId
    },
    session: {
      scope: "dm",
      sessionId: latestInbound.conversationId
    },
    type: "message.text",
    payload: { kind: "text", text: "" },
    meta: {
      receivedAt: latestInbound.createdAt,
      replyTo: latestInbound.externalMessageId
    }
  } as const;
  const profile = promptProfileStore.get();

  return {
    id: 0,
    source: "preview",
    conversationId: latestInbound.conversationId,
    time: latestInbound.lastEventAt || latestInbound.createdAt,
    model: config.llm.model,
    temperature: config.llm.temperature,
    extraParams: config.llm.extraParams,
    messages: await buildPromptPreviewMessages(profile, previewEvent, true),
    tools: visibleToolSpecs(profile)
  };
}

function visibleToolSpecs(profile: ReturnType<typeof promptProfileStore.get>): LLMChatInput["tools"] {
  const variables = buildLLMTextVariables({
    userName: profile.userName,
    time: currentTime,
    dailyShell: dailyShellStore.render(currentTime.now().date, currentTime.timeZone),
    dailyShellRaw: dailyShellStore.get(currentTime.now().date, currentTime.timeZone),
    appearanceDescription: coreProfileStore.get().appearanceDescription
  });
  return toolPlugins
    .filter((plugin) => {
      if (plugin.id === "messaging") return profile.visibleTools.feishu !== false;
      if (plugin.id === "media") return profile.visibleTools.media !== false;
      if (plugin.id === "shell") return profile.visibleTools.shell !== false;
      return true;
    })
    .flatMap((plugin) => plugin.listTools().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: String(renderLLMValue(tool.description, variables)),
        parameters: renderLLMValue(tool.inputSchema, variables) as Record<string, unknown>
      }
    })));
}

async function buildPromptPreviewMessages(
  profile: ReturnType<typeof promptProfileStore.get>,
  event: Parameters<typeof buildPromptMessagesWithToolResults>[1]["event"],
  includeFakeCheckChat = false
): Promise<LLMChatInput["messages"]> {
  const context = {
    event,
    time: currentTime,
    dailyShell: dailyShellStore.render(currentTime.now().date, currentTime.timeZone),
    dailyShellRaw: dailyShellStore.get(currentTime.now().date, currentTime.timeZone),
    appearanceDescription: coreProfileStore.get().appearanceDescription
  };
  const runPreviewTool = async (layer: Parameters<typeof buildPromptMessagesWithToolResults>[2] extends (layer: infer T, call: any) => any ? T : never, call: Parameters<Parameters<typeof buildPromptMessagesWithToolResults>[2]>[1]) => {
    if (call.toolName === "send_chat" || call.toolName === "send_feishu" || call.toolName === "send_wechat") {
      return {
        callId: call.id,
        ok: false,
        error: "send_chat cannot run from request preview"
      };
    }
    try {
      return await messagingTools.execute({
        ...call,
        input: { ...call.input, __preview: true }
      });
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  };
  const messages = await buildPromptMessagesWithToolResults(profile, context, runPreviewTool);
  if (!includeFakeCheckChat) return messages;
  const appendMessages = await buildAppendPromptMessagesWithToolResults(profile, context, runPreviewTool);
  return [
    ...messages,
    ...appendMessages
  ];
}

function buildRawLLMRequest(input: Pick<LLMChatInput, "model" | "temperature" | "messages" | "tools" | "maxTokens" | "extraParams">): unknown {
  return {
    ...(input.extraParams ?? config.llm.extraParams),
    model: input.model,
    stream: config.llm.stream !== false,
    temperature: input.temperature,
    messages: input.messages.map((message) => {
      const result: Record<string, unknown> = {
        role: message.role,
        content: message.content
      };
      if (message.name) result.name = message.name;
      if (message.toolCallId) result.tool_call_id = message.toolCallId;
      if (message.reasoningContent) result.reasoning_content = message.reasoningContent;
      if (message.toolCalls) {
        result.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: call.type,
          function: {
            name: call.function.name,
            arguments: call.function.arguments
          }
        }));
      }
      return result;
    }),
    tools: input.tools,
    max_tokens: input.maxTokens
  };
}

function formatPreviewContextLine(entry: StoredConversationMessage): string {
  const speaker = entry.direction === "inbound" ? "User" : "Assistant";
  const recalled = entry.isRecalled ? " [recalled]" : "";
  const read = entry.isRead ? " [read]" : "";
  const reactions = summarizePreviewReactions(entry.reactionsJson);
  return `${speaker}${recalled}${read}${reactions ? ` [reactions: ${reactions}]` : ""}: ${entry.isRecalled ? "(message recalled)" : entry.contentText}`;
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

function summarizePreviewReactions(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, { count?: unknown }>;
    return Object.entries(parsed)
      .map(([emoji, value]) => `${emoji}:${typeof value.count === "number" ? value.count : 0}`)
      .filter((part) => !part.endsWith(":0"))
      .join(", ");
  } catch {
    return "";
  }
}

function loadDotEnv(path: string): void {
  if (!fs.existsSync(path)) return;

  const content = fs.readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    process.env[key] = unquoteEnvValue(rawValue);
  }
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
