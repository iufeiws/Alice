import { loadConfig } from "../../../packages/config/src/index.js";
import { createAgentCore, type LLMSessionClearReason, type LLMSessionSnapshot, type TokenPressurePreviewBaseline } from "../../../core/agent/src/index.js";
import { createAgentStateController, createJsonAgentStateStore } from "../../../core/agent/src/state.js";
import { createCoreProfileStore } from "../../../core/agent/src/core-profile.js";
import { clearMemoryInductionSession as clearActiveMemoryInductionSession, createMarkdownMemoryStore, createMemoryInductionPromptStore, createMemoryInductionSession, createSleepMemoryStateStore, memoryToolDefinitions, runMemoryInductionForMessages, runSleepMemoryInduction, type MemoryInductionSession } from "../../../core/agent/src/memory.js";
import { buildAppendPromptMessagesWithToolResults, buildPromptMessagesWithToolResults, createPromptProfileStore, promptVariables, staticPromptFingerprintForMessages, staticPromptFingerprintForText } from "../../../core/agent/src/prompts.js";
import {
  absoluteLLMSessionPath as absoluteLLMSessionJsonlPath,
  appendLLMSessionJsonlMessages,
  cloneLLMMessages,
  collectLLMSessionFiles as collectLLMSessionJsonlFiles,
  createLLMSessionFilePath as createLLMSessionJsonlFilePath,
  readLLMSessionJsonl,
  relativeLLMSessionPath as relativeLLMSessionJsonlPath,
  writeLLMSessionJsonl,
  writeLLMSessionJsonlMetadata
} from "../../../core/agent/src/llm-session-log.js";
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
import { createConfiguredVoiceSynthesizer, createMessagingTools } from "../../../plugins/messaging/src/index.js";
import { createJapaneseVoicePlugin } from "../../../plugins/japanese-voice/src/index.js";
import { createShellTools } from "../../../plugins/shell/src/index.js";
import { createBookcaseTools } from "../../../plugins/bookcase/src/index.js";
import { createSleepCocoonTools } from "../../../plugins/sleep-cocoon/src/index.js";
import { createAliceStore, type StoredConversationMessage } from "../../../packages/storage/src/sqlite-store.js";
import { createDiaryStore } from "../../../packages/storage/src/diary-store.js";
import { createTokenUsageStore, type TokenUsageQuery } from "../../../packages/storage/src/token-usage-store.js";
import { createFileLogStore } from "../../../packages/storage/src/file-log-store.js";
import { createDailyMaintenanceTasks, createDailyScheduler } from "../../../core/scheduler/src/index.js";
import { createMutableCurrentTimeProvider } from "../../../core/time/src/index.js";
import { parseZonedIso } from "../../../core/time/src/index.js";
import { createMessageRuntime, summarizePayload } from "./message-runtime.js";
import { createApiRequestHandler } from "./admin-routes.js";
import { createId, type ToolDefinition } from "../../../packages/types/src/index.js";
import { createLLMRequests } from "./llm-requests.js";

const http = await import("node:http");
const fs = await import("node:fs");
const path = await import("node:path");

type LogLevel = "info" | "warn" | "error";

type LogEntry = {
  id: number;
  time: string;
  utcTime?: string;
  level: LogLevel;
  message: string;
};

type MessageLogEntry = {
  id: number;
  time: string;
  timeUtc?: string;
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

type LLMSessionTurn = {
  round: number;
  request?: LLMRequestLogEntry;
  response?: LLMResponseLogEntry;
  latestRequest?: LLMSessionRequestInfo;
  latestResponse?: LLMSessionResponseInfo;
  messages: LLMChatInput["messages"];
};

type ActiveLLMSession = {
  id: number;
  startedAt: string;
  updatedAt: string;
  archiveFilePath?: string;
  archiveMetadata?: Record<string, unknown>;
  requestIds: number[];
  responseIds: number[];
  messages: LLMChatInput["messages"];
  latestRequest?: unknown;
  staticPromptFingerprint?: string;
  staticPromptMessageCount?: number;
  requestTimestamps: string[];
  lastTotalTokens?: number;
  lastInputTokens?: number;
  lastUsageModel?: string;
  tokenPressurePreviewBaselines?: Record<string, TokenPressurePreviewBaseline>;
  mode?: string;
  modeStaticMessages?: LLMChatInput["messages"];
  modeStaticTokenEstimate?: number;
  modeStartedAt?: string;
  modeExpiresAt?: string;
  fixedPrefixKind?: string;
  fixedPrefixCursorMessageId?: number;
  currentRound?: LLMSessionRoundInfo;
  latestRequestInfo?: LLMSessionRequestInfo;
  latestResponseInfo?: LLMSessionResponseInfo;
  clearedAt?: string;
  reason?: string;
  requests?: LLMRequestLogEntry[];
  responses?: LLMResponseLogEntry[];
};

type LLMSessionRoundInfo = {
  status: "running" | "finished" | "interrupted";
  round: number;
  startedAt: string;
  finishedAt?: string;
  model?: string;
  temperature?: number;
  tools?: LLMChatInput["tools"];
  extraParams?: Record<string, unknown>;
};

type LLMSessionRequestInfo = {
  time: string;
  round: number;
  model?: string;
  temperature?: number;
  tools?: LLMChatInput["tools"];
  extraParams?: Record<string, unknown>;
  messageCount: number;
};

type LLMSessionResponseInfo = {
  time: string;
  round: number;
  finishReason?: string;
  usage?: LLMChatResult["usage"];
  toolCallCount: number;
};

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
let memoryConsoleSession: MemoryInductionSession | undefined;
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
const activeLLM = createMutableLLMClient(createStubLLMClient());
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
let previousAgentBehaviorState = agentState.getSnapshot().state;
let pendingSleepCocoonMorningEvent: ReturnType<typeof buildSleepCocoonGeneratedEvent> | undefined;
let sleepMemoryInductionQueue: Promise<void> = Promise.resolve();
agentState.onChange((snapshot) => {
  if (snapshot.state === "sleeping" && previousAgentBehaviorState !== "sleeping") {
    const now = currentTime.now().iso;
    diaryStore.recordSleepBoundary({ occurredAt: now, source: "sleep", now });
    core.clearLLMSession("mode_transition");
    if (snapshot.reason === "sleep_started") void sendSystemNoticeToDefaultTarget("-少女已入眠-");
    void triggerSleepMemoryInduction();
  }
  if (previousAgentBehaviorState === "sleeping" && snapshot.state !== "sleeping" && snapshot.reason === "woke") {
    const daily = dailyShellStore.reroll(currentTime.now().date, currentTime.timeZone);
    appendLog("info", `daily shell switched on wake: ${daily.personality.name}/${daily.relationship.name}/${daily.outfit.name} date=${daily.date}`);
    pendingSleepCocoonMorningEvent = buildSleepCocoonGeneratedEvent("sleep_cocoon_morning", { sleepCocoonMorning: true });
  }
  previousAgentBehaviorState = snapshot.state;
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
const memoryStore = createMarkdownMemoryStore(config.memoryFiles.root);
const diaryStore = createDiaryStore(path.join(config.memoryFiles.root, "diary", "diary.sqlite"));
memoryStore.ensure();
const memoryInductionPromptStore = createMemoryInductionPromptStore(path.join(config.memoryFiles.root, "config", "memorize-prompts.json"));
const sleepMemoryStateStore = createSleepMemoryStateStore(path.join(config.memoryFiles.root, "state", "sleep-memory-state.json"));
const dailyShellStore = createDailyShellStore(config.memoryFiles.root, {
  onSwitch(entry) {
    appendLog("info", `daily shell switched: ${entry.message} outfit=${entry.outfitName} date=${entry.date}`);
  }
});
const baseVoiceSynthesizer = createConfiguredVoiceSynthesizer(config.tts, { appendLog });
const japaneseVoicePlugin = createJapaneseVoicePlugin({
  baseSynthesizer: baseVoiceSynthesizer,
  llmRequestSender: (input) => llmRequests.send(input),
  resolveApiPreset(name) {
    return readLLMApiPresets().find((entry) => entry.name === name);
  },
  appendLog
});
const messagingTools = createMessagingTools({
  store,
  outputRouter,
  time: currentTime,
  voiceSynthesizer: japaneseVoicePlugin.voiceSynthesizer,
  getUserName: () => promptProfileStore.get().userName,
  getShellSwitchLogs: () => dailyShellStore.listSwitchLogs(500),
  getSleepCocoonEnteredAt: () => agentState.getSnapshot().sleepCocoonEnteredAt,
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
const sleepCocoonTools = createSleepCocoonTools({
  agentState,
  time: currentTime,
  outputRouter,
  getDefaultTarget() {
    return getDefaultMessagingTarget();
  },
  appendLog
});
const toolPlugins = [messagingTools, mediaTools, shellTools, bookcaseTools, sleepCocoonTools];
const llmRequests = createLLMRequests({
  getTool: getLLMRequestToolDefinition,
  onRequestPrepared(input, request) {
    if (input.agentId === "core") appendLLMRequestLog(request);
  },
  onResponseReceived(input, request, result) {
    if (input.agentId === "core") {
      appendLLMResponseLog(result);
      return;
    }
    appendLLMUsageLog(result, result.model ?? request.model);
    recordTokenUsageEvent({
      createdAt: currentTime.now().iso,
      agentId: input.agentId,
      model: result.model ?? request.model,
      result
    });
  },
  onLog(event) {
    const mode = event.stream ? "stream" : "non-stream";
    const fallbackModel = event.agentId === "memorize" ? resolvePromptApiPreset("memorize")?.model : resolvePromptApiPreset("core")?.model;
    if (event.kind === "call_start") {
      appendLog("info", `llm call start: agent=${event.agentId} round=${event.round} mode=${mode} model=${event.model ?? fallbackModel}`);
    }
    if (event.kind === "stream_start") appendLog("info", `llm stream start: agent=${event.agentId} round=${event.round} model=${event.model ?? fallbackModel}`);
    if (event.kind === "stream_end") appendLog("info", `llm stream end: agent=${event.agentId} round=${event.round} model=${event.model ?? fallbackModel}`);
    if (event.kind === "response_received") appendLog("info", `llm response received: agent=${event.agentId} round=${event.round} mode=${mode} model=${event.model ?? fallbackModel}`);
    if (event.kind === "retry") appendLog("warn", `llm retry: agent=${event.agentId} round=${event.round} attempt=${event.attempt ?? "?"} delay=${event.delayMs ?? "?"}ms error=${event.error ?? ""}`);
  }
});
const core = createAgentCore({
  config,
  llm: activeLLM,
  llmRequestSender: llmRequests.send,
  getLLMConfig: currentCoreLLMConfig,
  outputRouter,
  intentRouter: createIntentRouter(),
  sessionResolver: createSessionResolver(),
  policy: createAllowAllPolicy(),
  tools: toolPlugins,
  getPromptProfile: () => promptProfileStore.get(),
  getDailyShell: () => dailyShellStore.render(currentTime.now().date, currentTime.timeZone),
  getDailyShellRaw: () => dailyShellStore.get(currentTime.now().date, currentTime.timeZone),
  getAppearanceDescription: () => coreProfileStore.get().appearanceDescription,
  getMemorySnapshot: () => memoryStore.read(),
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
    const fallbackModel = resolvePromptApiPreset("core")?.model;
    if (event.kind === "call_start") {
      appendLog("info", `llm call start: round=${event.round} mode=${mode} model=${event.model ?? fallbackModel ?? "(no preset)"}`);
    }
    if (event.kind === "rate_limited") appendLog("warn", `llm call skipped: active session reached 10 requests in 60s model=${event.model ?? fallbackModel ?? "(no preset)"}`);
    if (event.kind === "stream_start") appendLog("info", `llm stream start: round=${event.round} model=${event.model ?? fallbackModel ?? "(no preset)"}`);
    if (event.kind === "stream_end") appendLog("info", `llm stream end: round=${event.round} model=${event.model ?? fallbackModel ?? "(no preset)"}`);
    if (event.kind === "response_received") appendLog("info", `llm response received: round=${event.round} mode=${mode} model=${event.model ?? fallbackModel ?? "(no preset)"}`);
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
  startHeartbeatPaused: config.core.heartbeatStartPaused,
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
  getSleepCocoonGoodnightEvent() {
    return maybeBuildSleepCocoonGoodnightEvent();
  },
  getSleepCocoonMorningEvent() {
    const event = pendingSleepCocoonMorningEvent;
    pendingSleepCocoonMorningEvent = undefined;
    return event;
  },
  clearLLMSession(reason) {
    core.clearLLMSession("mode_transition");
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
  getMemoryLLMSessions,
  getLLMSession,
  store,
  getLLMRequestPreview,
  getLLMRequestProfilePreview,
  getTokenUsageReport,
  clearLLMChainCache,
  clearMemoryInductionSession,
  outputRouter,
  feishuPairingStore,
  coreProfileStore,
  promptProfileStore,
  memoryStore,
  diaryStore,
  memoryInductionPromptStore,
  async runMemoryInductionForMessages(messages, windowStartAt, windowEndAt, apiPreset, target, onRound) {
    const memoryConfig = apiPreset ? {
      ...config.memorySummary,
      baseURL: apiPreset.baseURL,
      apiKey: apiPreset.apiKey,
      model: apiPreset.model,
      temperature: apiPreset.temperature,
      timeoutMs: apiPreset.timeoutMs,
      stream: apiPreset.stream,
      extraParams: apiPreset.extraParams,
      followupExtraParams: apiPreset.followupExtraParams
    } : { ...config.memorySummary, enabled: false, apiKey: undefined };
    const memoryLLM = apiPreset ? createLLMClientFromPreset(apiPreset) : undefined;
    const memorySession = target
      ? ensureMemoryConsoleSession(windowEndAt, windowStartAt)
      : undefined;
    return runMemoryInductionForMessages({
      memoryStore,
      promptStore: memoryInductionPromptStore,
      messages,
      windowStartAt,
      windowEndAt,
      llm: memoryLLM,
      llmRequestSender: llmRequests.send,
      config: memoryConfig,
      nowIso: () => currentTime.now().iso,
      timezone: currentTime.timeZone,
      userName: promptProfileStore.get().userName,
      sessionRoot: llmSessionsRoot(),
      memorySession,
      onRound,
      log: appendLog
    }, target);
  },
  getDailyShell: () => dailyShellStore.render(currentTime.now().date, currentTime.timeZone),
  dailyShellStore,
  agentState,
  messagingTools,
  mediaTools,
  shellTools,
  bookcaseTools,
  sleepCocoonTools,
  feishu,
  wechat,
  wechatStateStore,
  runtime: runtimeState,
  pluginConfigs: {
    japaneseVoice: {
      configPath: "plugins/japanese-voice/config.json"
    }
  },
  llmRequestSender: llmRequests.send,
  messageRuntime,
  getLLM: () => currentCoreLLMConfig().client ?? activeLLM,
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
appendLog("info", `agent core started: llm=api-preset feishu=${runtimeState.feishuStarted ? "started" : "stopped"} wechat=${runtimeState.wechatStarted ? "started" : "stopped"}`);

server.listen(config.api.port, config.api.host, () => {
  console.log(`[api] listening on http://${config.api.host}:${config.api.port}`);
});

let shutdownStarted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    appendLog("info", `shutdown requested: ${signal}`);
    scheduler.stop();
    try {
      await japaneseVoicePlugin.voiceSynthesizer.shutdown?.();
      await messageRuntime.flushAll();
      await core.stop();
    } finally {
      server.close(() => process.exit(0));
    }
  });
}

function appendLog(level: LogLevel, message: string): void {
  const now = currentTime.now();
  const entry = {
    id: nextLogId,
    time: now.iso,
    utcTime: now.date.toISOString(),
    level,
    message
  };
  logs.push(entry);
  nextLogId += 1;
  systemLogStore?.append({
    time: entry.time,
    utcTime: entry.utcTime,
    level: entry.level,
    message: entry.message
  });

  if (logs.length > 500) {
    logs.splice(0, logs.length - 500);
  }
}

function appendMessageLog(input: Omit<MessageLogEntry, "id" | "time" | "timeUtc">): MessageLogEntry {
  const now = currentTime.now();
  const entry = {
    id: nextMessageLogId,
    time: now.iso,
    timeUtc: now.date.toISOString(),
    ...input,
    summary: input.summary.length > 500 ? `${input.summary.slice(0, 500)}...` : input.summary
  };
  messageLogs.push(entry);
  nextMessageLogId += 1;
  store?.insertMessageLog({
    time: entry.time,
    timeUtc: entry.timeUtc,
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

function currentCoreLLMConfig() {
  const preset = resolvePromptApiPreset("core");
  if (!preset) {
    return {
      client: activeLLM,
      model: undefined,
      temperature: undefined,
      extraParams: {},
      followupExtraParams: {},
      stream: false
    };
  }
  return {
    client: createLLMClientFromPreset(preset) ?? createStubLLMClient(),
    model: preset.model,
    temperature: preset.temperature,
    extraParams: preset.extraParams,
    followupExtraParams: preset.followupExtraParams,
    stream: preset.stream
  };
}

function createLLMClientFromPreset(preset: LLMApiPreset): ReturnType<typeof createOpenAICompatibleClient> | undefined {
  if (!preset.baseURL || !preset.apiKey) return undefined;
  return createOpenAICompatibleClient({
    baseURL: preset.baseURL,
    apiKey: preset.apiKey,
    model: preset.model,
    temperature: preset.temperature,
    timeoutMs: preset.timeoutMs,
    extraParams: preset.extraParams
  });
}

function resolvePromptApiPreset(kind: "core" | "memorize"): LLMApiPreset | undefined {
  const profile = readPromptApiProfile();
  const name = kind === "core" ? profile.corePresetName : profile.memorizePresetName;
  if (!name) return undefined;
  return readLLMApiPresets().find((entry) => entry.name === name);
}

function readPromptApiProfile(): PromptApiProfile {
  const filePath = path.join(config.memoryFiles.root, "config", "prompt-api-profile.json");
  if (!fs.existsSync(filePath)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return {
      corePresetName: typeof value.corePresetName === "string" && value.corePresetName ? value.corePresetName : undefined,
      memorizePresetName: typeof value.memorizePresetName === "string" && value.memorizePresetName ? value.memorizePresetName : undefined
    };
  } catch {
    return {};
  }
}

function readLLMApiPresets(): LLMApiPreset[] {
  const filePath = path.join(config.memoryFiles.root, "config", "llm-api-presets.json");
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { presets?: Partial<LLMApiPreset>[] } | Partial<LLMApiPreset>[];
    const presets = Array.isArray(parsed) ? parsed : Array.isArray(parsed.presets) ? parsed.presets : [];
    return presets.map(normalizeLLMApiPreset).filter((entry): entry is LLMApiPreset => Boolean(entry));
  } catch {
    return [];
  }
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

async function triggerSleepMemoryInduction(): Promise<void> {
  sleepMemoryInductionQueue = sleepMemoryInductionQueue
    .catch((error) => {
      appendLog("warn", `sleep Memorize queue recovered: ${error instanceof Error ? error.message : String(error)}`);
    })
    .then(runQueuedSleepMemoryInduction);
  return sleepMemoryInductionQueue;
}

async function runQueuedSleepMemoryInduction(): Promise<void> {
  try {
    const memoryPreset = resolvePromptApiPreset("memorize");
    const memoryConfig = memoryPreset ? {
      ...config.memorySummary,
      baseURL: memoryPreset.baseURL,
      apiKey: memoryPreset.apiKey,
      model: memoryPreset.model,
      temperature: memoryPreset.temperature,
      timeoutMs: memoryPreset.timeoutMs,
      stream: memoryPreset.stream,
      extraParams: memoryPreset.extraParams,
      followupExtraParams: memoryPreset.followupExtraParams
    } : { ...config.memorySummary, enabled: false, apiKey: undefined };
    const memoryLLM = memoryPreset ? createLLMClientFromPreset(memoryPreset) : undefined;
    const ok = await runSleepMemoryInduction({
      memoryStore,
      promptStore: memoryInductionPromptStore,
      stateStore: sleepMemoryStateStore,
      messageStore: store!,
      llm: memoryLLM,
      llmRequestSender: llmRequests.send,
      config: memoryConfig,
      nowIso: () => currentTime.now().iso,
      timezone: currentTime.timeZone,
      sleepWindowStartAt: agentState.getSnapshot().sleepCocoonEnteredAt,
      sessionRoot: llmSessionsRoot(),
      log: appendLog
    });
    if (!ok) await sendMemoryFailureNoticeToFeishu();
  } catch (error) {
    appendLog("error", `sleep Memorize failed: ${error instanceof Error ? error.message : String(error)}`);
    await sendMemoryFailureNoticeToFeishu();
  }
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
  appendLLMUsageLog(result, result.model ?? resolvePromptApiPreset("core")?.model);
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
  recordTokenUsageEvent({
    createdAt: entry.time,
    agentId: "core",
    model: result.model ?? resolvePromptApiPreset("core")?.model,
    sessionId: entry.sessionId,
    requestId: entry.requestId,
    responseId: entry.id,
    result
  });
}

function recordTokenUsageEvent(input: {
  createdAt: string;
  agentId: string;
  model?: string;
  sessionId?: number;
  requestId?: number;
  responseId?: number;
  result: LLMChatResult;
}): void {
  const usage = input.result.usage;
  try {
    tokenUsageStore?.insert({
      createdAt: input.createdAt,
      agentId: input.agentId,
      model: input.model,
      sessionId: input.sessionId,
      requestId: input.requestId,
      responseId: input.responseId,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage?.totalTokens,
      cacheHitTokens: usage?.cacheHitTokens,
      cacheMissTokens: usage?.cacheMissTokens,
      finishReason: input.result.finishReason,
      rawUsageJson: extractRawUsageJson(input.result.raw)
    });
  } catch (error) {
    appendLog("warn", `token usage persist failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function appendLLMUsageLog(result: LLMChatResult, modelFallback: string | undefined): void {
  const rawUsage = extractRawUsage(result.raw);
  const usage = result.usage;
  if (!usage) {
    appendLog("info", `llm token usage: input=? output=? total=? cache_hit=? cache_miss=? model=${modelFallback} raw_usage=${rawUsage}`);
    return;
  }
  appendLog("info", [
    "llm token usage:",
    `input=${formatTokenCount(usage.inputTokens)}`,
    `output=${formatTokenCount(usage.outputTokens)}`,
    `total=${formatTokenCount(usage.totalTokens)}`,
    `cache_hit=${formatTokenCount(usage.cacheHitTokens)}`,
    `cache_miss=${formatTokenCount(usage.cacheMissTokens)}`,
    `model=${modelFallback}`,
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

function ensureMemoryConsoleSession(windowEndAt: string, windowStartAt?: string): MemoryInductionSession {
  if (!memoryConsoleSession || memoryConsoleSession.clearedAt) {
    memoryConsoleSession = createMemoryInductionSession(llmSessionsRoot(), windowEndAt, {
      name: "console",
      windowStartAt,
      windowEndAt
    });
  }
  return memoryConsoleSession;
}

function clearMemoryInductionSession(): void {
  clearActiveMemoryInductionSession(memoryConsoleSession, currentTime.now().iso, "admin_clear");
  memoryConsoleSession = undefined;
}

function ensureActiveLLMSession(time: string): ActiveLLMSession {
  if (!activeLLMSession) {
    activeLLMSession = {
      id: nextLLMSessionId,
      startedAt: time,
      updatedAt: time,
      archiveFilePath: createLLMSessionFilePath(time),
      requestIds: [],
      responseIds: [],
      messages: [],
      latestRequest: undefined,
      staticPromptMessageCount: 0,
      requestTimestamps: []
    };
    nextLLMSessionId += 1;
    writeLLMSessionFile(activeLLMSession);
    writeCurrentLLMSessionPointer(activeLLMSession);
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
  const round = session.requestIds.length - 1;
  session.currentRound = {
    status: "running",
    round,
    startedAt: entry.time,
    model: entry.model,
    temperature: entry.temperature,
    tools: cloneLLMTools(entry.tools),
    extraParams: cloneJsonObject(entry.extraParams)
  };
  session.latestRequestInfo = {
    time: entry.time,
    round,
    model: entry.model,
    temperature: entry.temperature,
    tools: cloneLLMTools(entry.tools),
    extraParams: cloneJsonObject(entry.extraParams),
    messageCount: entry.messages.length
  };
  writeLLMSessionMetadata(session);
}

function noteActiveLLMResponse(entry: LLMResponseLogEntry): void {
  if (!activeLLMSession) return;
  activeLLMSession.updatedAt = entry.time;
  activeLLMSession.responseIds.push(entry.id);
  activeLLMSession.responses = [...(activeLLMSession.responses ?? []), entry];
  const round = activeLLMSession.currentRound?.round ?? Math.max(0, activeLLMSession.requestIds.length - 1);
  activeLLMSession.currentRound = {
    ...(activeLLMSession.currentRound ?? { round, startedAt: entry.time }),
    status: "finished",
    round,
    finishedAt: entry.time
  };
  activeLLMSession.latestResponseInfo = {
    time: entry.time,
    round,
    finishReason: entry.finishReason,
    usage: entry.usage,
    toolCallCount: entry.message.toolCalls?.length ?? 0
  };
  writeLLMSessionMetadata(activeLLMSession);
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
  const nextModeExpiresAt = nextMode === "fixed_prefix" ? input.modeExpiresAt : undefined;
  const nextFixedPrefixKind = nextMode === "fixed_prefix" ? input.fixedPrefixKind : undefined;
  const nextFixedPrefixCursorMessageId = nextMode === "fixed_prefix" ? input.fixedPrefixCursorMessageId : undefined;
  const nextTokenPressurePreviewBaselines = cloneTokenPressurePreviewBaselines(input.tokenPressurePreviewBaselines);
  const tokenUsageChanged = session.lastTotalTokens !== input.lastTotalTokens
    || session.lastInputTokens !== input.lastInputTokens
    || session.lastUsageModel !== input.lastUsageModel
    || stableStringify(session.tokenPressurePreviewBaselines ?? {}) !== stableStringify(nextTokenPressurePreviewBaselines);
  const modeChanged = session.mode !== nextMode
    || session.modeStaticTokenEstimate !== nextModeStaticTokenEstimate
    || session.modeStartedAt !== nextModeStartedAt
    || session.modeExpiresAt !== nextModeExpiresAt
    || session.fixedPrefixKind !== nextFixedPrefixKind
    || session.fixedPrefixCursorMessageId !== nextFixedPrefixCursorMessageId
    || stableStringify(session.modeStaticMessages ?? []) !== stableStringify(nextModeStaticMessages);
  if (!isAppend) {
    session.clearedAt = now;
    session.reason = "transcript_replaced";
    writeLLMSessionMetadata(session);
    clearCurrentLLMSessionPointer();
    activeLLMSession = undefined;
    appendLog("warn", `llm active session archived without transcript rewrite: session=${session.id} common_prefix=${commonPrefix} next_messages=${input.messages.length}`);
    return;
  }
  session.messages = input.messages;
  session.staticPromptFingerprint = input.staticPromptFingerprint;
  session.staticPromptMessageCount = input.staticPromptMessageCount;
  session.requestTimestamps = input.requestTimestamps;
  session.lastTotalTokens = input.lastTotalTokens;
  session.lastInputTokens = input.lastInputTokens;
  session.lastUsageModel = input.lastUsageModel;
  session.tokenPressurePreviewBaselines = nextTokenPressurePreviewBaselines;
  session.mode = nextMode;
  session.modeStaticMessages = nextModeStaticMessages;
  session.modeStaticTokenEstimate = nextModeStaticTokenEstimate;
  session.modeStartedAt = nextModeStartedAt;
  session.modeExpiresAt = nextModeExpiresAt;
  session.fixedPrefixKind = nextFixedPrefixKind;
  session.fixedPrefixCursorMessageId = nextFixedPrefixCursorMessageId;
  if (delta.length > 0) appendLLMSessionMessages(session, delta);
  if (delta.length > 0 || tokenUsageChanged || modeChanged) writeLLMSessionMetadata(session);
}

function clearActiveLLMSession(reason: LLMSessionClearReason): void {
  if (!activeLLMSession) {
    clearCurrentLLMSessionPointer();
    return;
  }
  const sessionId = activeLLMSession.id;
  const requestCount = activeLLMSession.requestIds.length;
  activeLLMSession.clearedAt = currentTime.now().iso;
  activeLLMSession.reason = reason;
  writeLLMSessionMetadata(activeLLMSession);
  clearCurrentLLMSessionPointer();
  activeLLMSession = undefined;
  appendLog("info", `llm active session cleared: session=${sessionId} reason=${reason} requests=${requestCount}`);
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
    staticPromptMessageCount: latest.staticPromptMessageCount,
    requestTimestamps: latest.requestTimestamps,
    lastTotalTokens: latest.lastTotalTokens,
    lastInputTokens: latest.lastInputTokens,
    lastUsageModel: latest.lastUsageModel,
    tokenPressurePreviewBaselines: cloneTokenPressurePreviewBaselines(latest.tokenPressurePreviewBaselines),
    mode: latest.mode ?? "normal",
    modeStaticMessages: latest.modeStaticMessages ?? [],
    modeStaticTokenEstimate: latest.modeStaticTokenEstimate ?? 0,
    modeStartedAt: latest.modeStartedAt,
    modeExpiresAt: latest.modeExpiresAt,
    fixedPrefixKind: latest.fixedPrefixKind,
    fixedPrefixCursorMessageId: latest.fixedPrefixCursorMessageId
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

function llmSessionsRoot(): string {
  return path.join(config.memoryFiles.root, "llm-sessions");
}

function currentLLMSessionPointerPath(): string {
  return path.join(llmSessionsRoot(), "current.json");
}

function createLLMSessionFilePath(time: string): string {
  return createLLMSessionJsonlFilePath(llmSessionsRoot(), time || currentTime.now().iso);
}

function relativeLLMSessionPath(filePath: string): string {
  return relativeLLMSessionJsonlPath(llmSessionsRoot(), filePath);
}

function absoluteLLMSessionPath(relativePath: string): string {
  return absoluteLLMSessionJsonlPath(llmSessionsRoot(), relativePath);
}

function writeCurrentLLMSessionPointer(session: ActiveLLMSession): void {
  if (!session.archiveFilePath) return;
  fs.mkdirSync(llmSessionsRoot(), { recursive: true });
  fs.writeFileSync(currentLLMSessionPointerPath(), `${JSON.stringify({
    path: relativeLLMSessionPath(session.archiveFilePath),
    sessionId: session.id
  }, null, 2)}\n`);
}

function clearCurrentLLMSessionPointer(): void {
  try {
    fs.rmSync(currentLLMSessionPointerPath(), { force: true });
  } catch {
    // Ignore pointer cleanup errors; the archived session metadata is still written.
  }
}

function sessionMetadata(session: ActiveLLMSession): Record<string, unknown> {
  const last = session.messages.at(-1);
  return {
    type: "llm_session",
    schemaVersion: 1,
    sessionId: session.id,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    staticPromptFingerprint: session.staticPromptFingerprint,
    staticPromptMessageCount: session.staticPromptMessageCount ?? 0,
    requestTimestamps: session.requestTimestamps,
    lastTotalTokens: session.lastTotalTokens,
    lastInputTokens: session.lastInputTokens,
    lastUsageModel: session.lastUsageModel,
    tokenPressurePreviewBaselines: session.tokenPressurePreviewBaselines ?? {},
    mode: session.mode ?? "normal",
    modeStartedAt: session.modeStartedAt,
    modeExpiresAt: session.modeExpiresAt,
    modeStaticMessageCount: session.modeStaticMessages?.length ?? 0,
    modeStaticTokenEstimate: session.modeStaticTokenEstimate ?? 0,
    fixedPrefixKind: session.fixedPrefixKind,
    fixedPrefixCursorMessageId: session.fixedPrefixCursorMessageId,
    currentRound: session.currentRound,
    latestRequest: session.latestRequestInfo,
    latestResponse: session.latestResponseInfo,
    messageCount: session.messages.length,
    lastMessageRole: last?.role,
    lastMessageAt: session.updatedAt,
    clearedAt: session.clearedAt,
    clearReason: session.reason
  };
}

function writeLLMSessionFile(session: ActiveLLMSession): void {
  const filePath = session.archiveFilePath ?? createLLMSessionFilePath(session.startedAt);
  session.archiveFilePath = filePath;
  session.archiveMetadata = sessionMetadata(session);
  writeLLMSessionJsonl(filePath, session.archiveMetadata, session.messages);
}

function writeLLMSessionMetadata(session: ActiveLLMSession): void {
  session.archiveMetadata = sessionMetadata(session);
  if (!session.archiveFilePath || !fs.existsSync(session.archiveFilePath)) {
    writeLLMSessionFile(session);
    return;
  }
  writeLLMSessionJsonlMetadata(session.archiveFilePath, session.archiveMetadata);
}

function appendLLMSessionMessages(session: ActiveLLMSession, messages: LLMChatInput["messages"]): void {
  if (messages.length === 0) return;
  if (!session.archiveFilePath || !fs.existsSync(session.archiveFilePath)) {
    writeLLMSessionFile(session);
    return;
  }
  appendLLMSessionJsonlMessages(session.archiveFilePath, messages);
}

function readLatestLLMSessionSnapshot(id: number): ActiveLLMSession | undefined {
  if (activeLLMSession?.id === id) return activeLLMSession;
  return readAllLLMSessions().find((session) => session.id === id);
}

function restorePersistedActiveLLMSession(): ActiveLLMSession | undefined {
  const pointerPath = currentLLMSessionPointerPath();
  if (!fs.existsSync(pointerPath)) return undefined;
  try {
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8")) as { path?: unknown; sessionId?: unknown };
    if (typeof pointer.path !== "string") return undefined;
    const filePath = absoluteLLMSessionPath(pointer.path);
    const session = readLLMSessionFile(filePath);
    if (!session || session.clearedAt || session.messages.length === 0 || !session.staticPromptFingerprint) return undefined;
    if (session.currentRound?.status === "running") {
      session.currentRound = {
        ...session.currentRound,
        status: "interrupted",
        finishedAt: currentTime.now().iso
      };
      writeLLMSessionMetadata(session);
    }
    nextLLMSessionId = Math.max(nextLLMSessionId, session.id + 1);
    return session;
  } catch (error) {
    appendLog("warn", `llm session pointer restore failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function readAllLLMSessions(): ActiveLLMSession[] {
  const root = llmSessionsRoot();
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  collectLLMSessionFiles(root, files);
  return files
    .map((filePath) => readLLMSessionFile(filePath))
    .filter((session): session is ActiveLLMSession => Boolean(session));
}

function collectLLMSessionFiles(dir: string, files: string[]): void {
  collectLLMSessionJsonlFiles(dir, files);
}

function readLLMSessionFile(filePath: string): ActiveLLMSession | undefined {
  try {
    const parsed = readLLMSessionJsonl(filePath);
    if (!parsed) return undefined;
    const metadata = parsed.metadata;
    if (metadata.type !== "llm_session" || typeof metadata.sessionId !== "number") return undefined;
    const messages = parsed.messages;
    const staticPromptMessageCount = messageCountFromMetadata(metadata.staticPromptMessageCount, messages.length);
    const modeStaticMessages = modeStaticMessagesFromMetadata(metadata, messages);
    return {
      id: metadata.sessionId,
      startedAt: typeof metadata.startedAt === "string" ? metadata.startedAt : "",
      updatedAt: typeof metadata.updatedAt === "string" ? metadata.updatedAt : "",
      archiveFilePath: filePath,
      archiveMetadata: metadata,
      requestIds: [],
      responseIds: [],
      messages: cloneLLMMessages(messages),
      latestRequest: undefined,
      staticPromptFingerprint: staticPromptFingerprintFromMetadata(metadata, messages, staticPromptMessageCount),
      staticPromptMessageCount,
      requestTimestamps: stringArray(metadata.requestTimestamps),
      lastTotalTokens: typeof metadata.lastTotalTokens === "number" && Number.isFinite(metadata.lastTotalTokens) ? metadata.lastTotalTokens : undefined,
      lastInputTokens: typeof metadata.lastInputTokens === "number" && Number.isFinite(metadata.lastInputTokens) ? metadata.lastInputTokens : undefined,
      lastUsageModel: typeof metadata.lastUsageModel === "string" ? metadata.lastUsageModel : undefined,
      tokenPressurePreviewBaselines: parseTokenPressurePreviewBaselines(metadata.tokenPressurePreviewBaselines),
      mode: typeof metadata.mode === "string" ? metadata.mode : "normal",
      modeStaticMessages,
      modeStaticTokenEstimate: typeof metadata.modeStaticTokenEstimate === "number" && Number.isFinite(metadata.modeStaticTokenEstimate) ? metadata.modeStaticTokenEstimate : 0,
      modeStartedAt: typeof metadata.modeStartedAt === "string" ? metadata.modeStartedAt : undefined,
      modeExpiresAt: typeof metadata.modeExpiresAt === "string" ? metadata.modeExpiresAt : undefined,
      fixedPrefixKind: typeof metadata.fixedPrefixKind === "string" ? metadata.fixedPrefixKind : undefined,
      fixedPrefixCursorMessageId: typeof metadata.fixedPrefixCursorMessageId === "number" && Number.isFinite(metadata.fixedPrefixCursorMessageId) ? metadata.fixedPrefixCursorMessageId : undefined,
      currentRound: parseRoundInfo(metadata.currentRound),
      latestRequestInfo: parseRequestInfo(metadata.latestRequest),
      latestResponseInfo: parseResponseInfo(metadata.latestResponse),
      clearedAt: typeof metadata.clearedAt === "string" ? metadata.clearedAt : undefined,
      reason: typeof metadata.clearReason === "string" ? metadata.clearReason : undefined,
      requests: [],
      responses: []
    };
  } catch {
    appendLog("warn", `llm session file parse failed: ${filePath}`);
    return undefined;
  }
}

function messageCountFromMetadata(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, Math.floor(value)));
}

function staticPromptFingerprintFromMetadata(
  metadata: Record<string, unknown>,
  messages: LLMChatInput["messages"],
  staticPromptMessageCount: number
): string {
  if (typeof metadata.staticPromptFingerprint === "string") {
    return metadata.staticPromptFingerprint.startsWith("sha256:")
      ? metadata.staticPromptFingerprint
      : staticPromptFingerprintForText(metadata.staticPromptFingerprint);
  }
  return staticPromptFingerprintForMessages(messages.slice(0, staticPromptMessageCount));
}

function modeStaticMessagesFromMetadata(metadata: Record<string, unknown>, messages: LLMChatInput["messages"]): LLMChatInput["messages"] {
  const count = messageCountFromMetadata(metadata.modeStaticMessageCount, messages.length);
  if (typeof metadata.modeStaticMessageCount === "number" && Number.isFinite(metadata.modeStaticMessageCount)) {
    return cloneLLMMessages(messages.slice(0, count));
  }
  return Array.isArray(metadata.modeStaticMessages)
    ? cloneLLMMessages(metadata.modeStaticMessages as LLMChatInput["messages"])
    : [];
}

function parseRoundInfo(value: unknown): LLMSessionRoundInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const status = raw.status === "running" || raw.status === "finished" || raw.status === "interrupted" ? raw.status : undefined;
  if (!status || typeof raw.round !== "number" || typeof raw.startedAt !== "string") return undefined;
  return {
    status,
    round: raw.round,
    startedAt: raw.startedAt,
    finishedAt: typeof raw.finishedAt === "string" ? raw.finishedAt : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
    temperature: typeof raw.temperature === "number" ? raw.temperature : undefined,
    tools: Array.isArray(raw.tools) ? raw.tools as LLMChatInput["tools"] : undefined,
    extraParams: raw.extraParams && typeof raw.extraParams === "object" ? raw.extraParams as Record<string, unknown> : undefined
  };
}

function parseRequestInfo(value: unknown): LLMSessionRequestInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.time !== "string" || typeof raw.round !== "number" || typeof raw.messageCount !== "number") return undefined;
  return {
    time: raw.time,
    round: raw.round,
    model: typeof raw.model === "string" ? raw.model : undefined,
    temperature: typeof raw.temperature === "number" ? raw.temperature : undefined,
    tools: Array.isArray(raw.tools) ? raw.tools as LLMChatInput["tools"] : undefined,
    extraParams: raw.extraParams && typeof raw.extraParams === "object" ? raw.extraParams as Record<string, unknown> : undefined,
    messageCount: raw.messageCount
  };
}

function parseResponseInfo(value: unknown): LLMSessionResponseInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.time !== "string" || typeof raw.round !== "number" || typeof raw.toolCallCount !== "number") return undefined;
  return {
    time: raw.time,
    round: raw.round,
    finishReason: typeof raw.finishReason === "string" ? raw.finishReason : undefined,
    usage: raw.usage && typeof raw.usage === "object" ? raw.usage as LLMChatResult["usage"] : undefined,
    toolCallCount: raw.toolCallCount
  };
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

function cloneTokenPressurePreviewBaselines(value: Record<string, TokenPressurePreviewBaseline> | undefined): Record<string, TokenPressurePreviewBaseline> {
  return parseTokenPressurePreviewBaselines(value);
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

function parseTokenPressurePreviewBaselines(value: unknown): Record<string, TokenPressurePreviewBaseline> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, TokenPressurePreviewBaseline> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const baseline = entry as Partial<TokenPressurePreviewBaseline>;
    if (typeof baseline.inputTokens === "number"
      && Number.isFinite(baseline.inputTokens)
      && typeof baseline.previewTokens === "number"
      && Number.isFinite(baseline.previewTokens)) {
      result[key] = { inputTokens: baseline.inputTokens, previewTokens: baseline.previewTokens };
    }
  }
  return result;
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

function getMemoryLLMSessions(): unknown[] {
  const root = path.join(llmSessionsRoot(), "memorize");
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  collectLLMSessionFiles(root, files);
  return files
    .map((filePath) => readMemoryLLMSessionFile(filePath, false))
    .filter(Boolean)
    .slice(-100);
}

function getLLMSession(id: string): unknown {
  if (id.startsWith("memorize:")) return getMemoryLLMSession(id);
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return undefined;
  const session = readLatestLLMSessionSnapshot(numericId) ?? (activeLLMSession?.id === numericId ? activeLLMSession : undefined);
  const metadata = session ? session.archiveMetadata ?? sessionMetadata(session) : undefined;
  return session ? {
    ...session,
    requests: (session.requests ?? []).sort(compareLLMLogEntries),
    responses: (session.responses ?? []).sort(compareLLMLogEntries),
    turns: buildLLMSessionTurns(session),
    jsonlEntries: [metadata, ...cloneLLMMessages(session.messages)]
  } : undefined;
}

function getMemoryLLMSession(id: string): unknown {
  const root = path.join(llmSessionsRoot(), "memorize");
  if (!fs.existsSync(root)) return undefined;
  const files: string[] = [];
  collectLLMSessionFiles(root, files);
  for (const filePath of files) {
    const session = readMemoryLLMSessionFile(filePath, true);
    if (session?.id === id) return session;
  }
  return undefined;
}

function readMemoryLLMSessionFile(filePath: string, includeTurns: boolean): any | undefined {
  try {
    const parsed = readLLMSessionJsonl(filePath);
    if (!parsed || parsed.metadata.type !== "llm_session" || parsed.metadata.agent !== "memorize") return undefined;
    const metadata = parsed.metadata;
    const id = typeof metadata.sessionId === "string"
      ? metadata.sessionId
      : `memorize:${relativeLLMSessionPath(filePath)}`;
    const session = {
      id,
      agent: "memorize",
      target: typeof metadata.target === "string" ? metadata.target : undefined,
      startedAt: typeof metadata.startedAt === "string" ? metadata.startedAt : "",
      updatedAt: typeof metadata.updatedAt === "string" ? metadata.updatedAt : "",
      requestCount: typeof metadata.requestCount === "number" ? metadata.requestCount : 0,
      responseCount: typeof metadata.responseCount === "number" ? metadata.responseCount : 0,
      roundCount: Math.max(
        typeof metadata.requestCount === "number" ? metadata.requestCount : 0,
        typeof metadata.responseCount === "number" ? metadata.responseCount : 0,
        typeof (metadata.latestRequest as any)?.round === "number" ? (metadata.latestRequest as any).round + 1 : 0,
        typeof (metadata.latestResponse as any)?.round === "number" ? (metadata.latestResponse as any).round + 1 : 0
      ),
      messageCount: parsed.messages.length,
      currentRound: parseRoundInfo(metadata.currentRound),
      latestRequest: parseRequestInfo(metadata.latestRequest),
      latestResponse: parseResponseInfo(metadata.latestResponse),
      mode: typeof metadata.mode === "string" ? metadata.mode : "memorize",
      archiveFilePath: filePath,
      archiveMetadata: metadata,
      messages: includeTurns ? parsed.messages : undefined
    };
    return includeTurns ? {
      ...session,
      jsonlEntries: [metadata, ...parsed.messages],
      turns: [{
        round: 0,
        latestRequest: session.latestRequest,
        latestResponse: session.latestResponse,
        messages: parsed.messages
      }]
    } : session;
  } catch {
    return undefined;
  }
}

function summarizeLLMSession(session: ActiveLLMSession): unknown {
  const roundCount = llmSessionRoundCount(session);
  return {
    id: session.id,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    requestIds: session.requestIds,
    responseIds: session.responseIds,
    requestCount: session.requests?.length ?? session.requestIds.length,
    responseCount: session.responses?.length ?? session.responseIds.length,
    roundCount,
    messageCount: session.messages.length,
    currentRound: session.currentRound,
    latestRequest: session.latestRequestInfo,
    latestResponse: session.latestResponseInfo,
    staticPromptMessageCount: session.staticPromptMessageCount ?? 0,
    mode: session.mode ?? "normal",
    modeStaticMessageCount: session.modeStaticMessages?.length ?? 0,
    modeStaticTokenEstimate: session.modeStaticTokenEstimate ?? 0,
    modeStartedAt: session.modeStartedAt,
    modeExpiresAt: session.modeExpiresAt,
    fixedPrefixKind: session.fixedPrefixKind,
    fixedPrefixCursorMessageId: session.fixedPrefixCursorMessageId,
    clearedAt: session.clearedAt,
    reason: session.reason,
    archiveFilePath: session.archiveFilePath
  };
}

function llmSessionRoundCount(session: ActiveLLMSession): number {
  const rounds = [
    session.requests?.length ?? 0,
    session.responses?.length ?? 0,
    session.requestIds.length,
    session.responseIds.length,
    typeof session.currentRound?.round === "number" ? session.currentRound.round + 1 : 0,
    typeof session.latestRequestInfo?.round === "number" ? session.latestRequestInfo.round + 1 : 0,
    typeof session.latestResponseInfo?.round === "number" ? session.latestResponseInfo.round + 1 : 0
  ];
  return Math.max(0, ...rounds);
}

function buildLLMSessionTurns(session: ActiveLLMSession): LLMSessionTurn[] {
  const requests = [...(session.requests ?? [])].sort(compareLLMLogEntries);
  const responses = [...(session.responses ?? [])].sort(compareLLMLogEntries);
  if (requests.length === 0 && responses.length === 0) {
    return buildLLMSessionTurnsFromTranscript(session);
  }
  const count = Math.max(llmSessionRoundCount(session), 1);
  const turns: LLMSessionTurn[] = [];
  for (let index = 0; index < count; index += 1) {
    const request = requests[index];
    const response = responses.find((entry) => entry.requestId === request?.id) ?? responses[index];
    const latestRequest = session.latestRequestInfo?.round === index ? session.latestRequestInfo : undefined;
    const latestResponse = session.latestResponseInfo?.round === index ? session.latestResponseInfo : undefined;
    turns.push({
      round: index,
      request,
      response,
      latestRequest,
      latestResponse,
      messages: messagesForLLMSessionTurn(session, index, request, response, latestRequest)
    });
  }
  return turns;
}

function buildLLMSessionTurnsFromTranscript(session: ActiveLLMSession): LLMSessionTurn[] {
  const messages = cloneLLMMessages(session.messages);
  const staticCount = Math.max(0, Math.min(messages.length, session.staticPromptMessageCount ?? 0));
  const responseIndexes: number[] = [];
  for (let index = staticCount; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (isSyntheticPromptToolRequest(message)) continue;
    responseIndexes.push(index);
  }
  if (responseIndexes.length === 0) {
    return [{
      round: 0,
      latestRequest: session.latestRequestInfo,
      latestResponse: session.latestResponseInfo,
      messages
    }];
  }
  return responseIndexes.map((responseIndex, round) => {
    const latestRequest = session.latestRequestInfo?.round === round ? session.latestRequestInfo : undefined;
    const latestResponse = session.latestResponseInfo?.round === round ? session.latestResponseInfo : undefined;
    return {
      round,
      latestRequest,
      latestResponse,
      messages: messages.slice(0, responseIndex),
      response: transcriptResponseEntry(session, round, responseIndex, messages[responseIndex], latestResponse)
    };
  });
}

function isSyntheticPromptToolRequest(message: LLMChatInput["messages"][number]): boolean {
  const calls = message.toolCalls ?? [];
  return calls.length > 0 && calls.every((call) => (
    call.id.startsWith("append_")
    || call.id.startsWith("fixed_prefix_")
    || call.id.startsWith("call_prompt_")
  ));
}

function transcriptResponseEntry(
  session: ActiveLLMSession,
  round: number,
  responseIndex: number,
  message: LLMChatInput["messages"][number],
  latestResponse: LLMSessionResponseInfo | undefined
): LLMResponseLogEntry {
  return {
    id: responseIndex,
    sessionId: session.id,
    time: latestResponse?.time ?? session.updatedAt,
    message,
    finishReason: latestResponse?.finishReason,
    usage: latestResponse?.usage
  };
}

function messagesForLLMSessionTurn(
  session: ActiveLLMSession,
  index: number,
  request: LLMRequestLogEntry | undefined,
  response: LLMResponseLogEntry | undefined,
  latestRequest: LLMSessionRequestInfo | undefined
): LLMChatInput["messages"] {
  if (request?.messages?.length) return cloneLLMMessages(request.messages);
  if (latestRequest?.messageCount) return cloneLLMMessages(session.messages.slice(0, latestRequest.messageCount));
  if (index === llmSessionRoundCount(session) - 1) return cloneLLMMessages(session.messages);
  return response ? [{ ...response.message }] : [];
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

async function getLLMRequestProfilePreview(apiPreset?: { model?: string; temperature?: number; extraParams?: Record<string, unknown> }): Promise<LLMRequestPreview | undefined> {
  const profilePreview = await buildLLMRequestPreviewFromProfile(apiPreset);
  return profilePreview ? { ...profilePreview, rawRequest: buildRawLLMRequest(profilePreview) } : undefined;
}

async function buildLLMRequestPreviewFromProfile(apiPreset?: { model?: string; temperature?: number; extraParams?: Record<string, unknown> }): Promise<LLMRequestPreview | undefined> {
  const profile = promptProfileStore.get();
  const target = getDefaultMessagingTarget();
  const previewTime = currentTime.now();
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
      receivedAt: previewTime.iso,
      receivedAtUtc: previewTime.date.toISOString()
    }
  } as const;
  return {
    id: 0,
    source: "preview",
    conversationId: target?.sessionId ?? "preview",
    time: previewTime.iso,
    model: apiPreset?.model,
    temperature: apiPreset?.temperature,
    extraParams: apiPreset?.extraParams ?? {},
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

function maybeBuildSleepCocoonGoodnightEvent() {
  const snapshot = agentState.getSnapshot();
  if (!snapshot.sleepCocoonEnteredAt) return undefined;
  if (snapshot.state === "going_to_sleep" || snapshot.state === "sleeping") return undefined;
  if (!agentState.canRunHeartbeat()) return undefined;
  const enteredAt = parseZonedIso(snapshot.sleepCocoonEnteredAt, currentTime.timeZone).getTime();
  const nowMs = currentTime.now().epochMs;
  const elapsedHours = (nowMs - enteredAt) / (60 * 60 * 1000);
  if (elapsedHours < 22) return undefined;
  const target = getDefaultMessagingTarget();
  if (!target) return undefined;

  const previousCheckHours = snapshot.sleepCocoonAutoCheckedAt
    ? Math.max(22, (parseZonedIso(snapshot.sleepCocoonAutoCheckedAt, currentTime.timeZone).getTime() - enteredAt) / (60 * 60 * 1000))
    : 22;
  const currentHours = Math.max(previousCheckHours, elapsedHours);
  const probability = sleepCocoonHazardProbability(previousCheckHours, currentHours);
  const triggered = Math.random() < probability;
  agentState.noteSleepCocoonAutoChecked();
  if (!triggered) return undefined;
  return buildSleepCocoonGeneratedEvent("sleep_cocoon_goodnight", { sleepCocoonGoodnight: true });
}

function buildSleepCocoonGeneratedEvent(idPrefix: string, raw: Record<string, unknown>) {
  const target = getDefaultMessagingTarget();
  if (!target) return undefined;
  const receivedTime = currentTime.now();
  const receivedAt = receivedTime.iso;
  const receivedAtUtc = receivedTime.date.toISOString();
  return {
    id: createId(idPrefix),
    source: {
      plugin: target.plugin,
      accountId: target.accountId,
      channelId: target.channelId,
      userId: target.userId
    },
    session: {
      scope: "dm" as const,
      sessionId: target.sessionId
    },
    type: "system.heartbeat" as const,
    payload: {
      kind: "text" as const,
      text: `${idPrefix} mode should run now.`
    },
    meta: {
      receivedAt,
      receivedAtUtc,
      raw
    }
  };
}

function sleepCocoonHazardProbability(previousHours: number, currentHours: number): number {
  if (currentHours <= previousHours) return 0;
  const previousCdf = normalCdf(previousHours, 24, 1);
  const currentCdf = normalCdf(currentHours, 24, 1);
  const remaining = Math.max(1e-9, 1 - previousCdf);
  return Math.max(0, Math.min(1, (currentCdf - previousCdf) / remaining));
}

function normalCdf(value: number, mean: number, standardDeviation: number): number {
  return 0.5 * (1 + erf((value - mean) / (standardDeviation * Math.SQRT2)));
}

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

async function sendSystemNoticeToDefaultTarget(text: string): Promise<void> {
  const target = getDefaultMessagingTarget();
  if (!target || !store) return;
  const now = currentTime.now();
  const output = {
    id: createId("sleep_notice"),
    target,
    content: { kind: "text" as const, text },
    meta: {
      createdAt: now.iso,
      createdAtUtc: now.date.toISOString(),
      urgency: "normal" as const,
      allowStreaming: false
    }
  };
  const stored = store.insertOutboundMessage({
    plugin: output.target.plugin,
    conversationId: output.target.sessionId,
    senderRole: "system",
    contentType: output.content.kind,
    contentText: text,
    contentJson: JSON.stringify(output.content),
    createdAt: output.meta.createdAt,
    createdAtUtc: output.meta.createdAtUtc
  });
  try {
    const sent = await outputRouter.send(output);
    store.markOutboundMessageSent(stored.id, extractSentMessageId(sent), currentTime.now().date.toISOString(), extractSentMessageCreatedAtUtc(sent));
    appendMessageLog({
      direction: "outbound",
      plugin: output.target.plugin,
      kind: output.content.kind,
      target: output.target.channelId ?? output.target.userId,
      sessionId: output.target.sessionId,
      status: "sent",
      summary: text
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failedTime = currentTime.now();
    store.markOutboundMessageFailed(stored.id, failedTime.iso, reason, failedTime.date.toISOString());
    appendMessageLog({
      direction: "outbound",
      plugin: output.target.plugin,
      kind: output.content.kind,
      target: output.target.channelId ?? output.target.userId,
      sessionId: output.target.sessionId,
      status: "send_failed",
      summary: text,
      error: reason
    });
  }
}

async function sendMemoryFailureNoticeToFeishu(): Promise<void> {
  const target = getDefaultFeishuTarget();
  if (!target) return;
  const text = "-记忆整理大失败-";
  const now = currentTime.now();
  const output = {
    id: createId("memory_failure_notice"),
    target,
    content: { kind: "text" as const, text },
    meta: {
      createdAt: now.iso,
      createdAtUtc: now.date.toISOString(),
      urgency: "normal" as const,
      allowStreaming: false
    }
  };
  try {
    await outputRouter.send(output);
    appendMessageLog({
      direction: "outbound",
      plugin: "feishu",
      kind: "text",
      target: target.channelId ?? target.userId,
      sessionId: target.sessionId,
      status: "sent",
      summary: text
    });
  } catch (error) {
    appendMessageLog({
      direction: "outbound",
      plugin: "feishu",
      kind: "text",
      target: target.channelId ?? target.userId,
      sessionId: target.sessionId,
      status: "send_failed",
      summary: text,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function extractSentMessageId(value: unknown): string | undefined {
  if (value && typeof value === "object" && "messageId" in value) {
    const messageId = (value as { messageId?: unknown }).messageId;
    return typeof messageId === "string" ? messageId : undefined;
  }
  return undefined;
}

function extractSentMessageCreatedAtUtc(value: unknown): string | undefined {
  if (value && typeof value === "object" && "createdAtUtc" in value) {
    const createdAtUtc = (value as { createdAtUtc?: unknown }).createdAtUtc;
    return typeof createdAtUtc === "string" ? createdAtUtc : undefined;
  }
  return undefined;
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
    model: resolvePromptApiPreset("core")?.model,
    temperature: resolvePromptApiPreset("core")?.temperature,
    extraParams: resolvePromptApiPreset("core")?.extraParams ?? {},
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
    appearanceDescription: coreProfileStore.get().appearanceDescription,
    memory: memoryStore.read()
  });
  const names = toolPlugins
    .filter((plugin) => {
      if (plugin.id === "messaging") return profile.visibleTools.feishu !== false;
      if (plugin.id === "media") return profile.visibleTools.media !== false;
      if (plugin.id === "shell") return profile.visibleTools.shell !== false;
      return true;
    })
    .flatMap((plugin) => plugin.listTools().map((tool) => tool.name));
  return llmRequests.buildTools(names, variables);
}

function getLLMRequestToolDefinition(name: string): ToolDefinition | undefined {
  for (const plugin of toolPlugins) {
    const tool = plugin.listTools().find((entry) => entry.name === name);
    if (tool) return tool;
  }
  return memoryToolDefinitions().find((tool) => tool.name === name);
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
    appearanceDescription: coreProfileStore.get().appearanceDescription,
    memory: memoryStore.read()
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
  const result: Record<string, unknown> = {
    ...(input.extraParams ?? {}),
    model: input.model,
    stream: true,
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
    })
  };
  if (input.tools !== undefined) result.tools = input.tools;
  if (input.maxTokens !== undefined) result.max_tokens = input.maxTokens;
  return result;
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
