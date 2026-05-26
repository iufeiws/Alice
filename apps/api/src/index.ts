import { loadConfig } from "../../../packages/config/src/index.js";
import { createAgentCore } from "../../../core/agent/src/index.js";
import { createAgentStateController, createJsonAgentStateStore } from "../../../core/agent/src/state.js";
import { buildPromptMessagesWithToolResults, createPromptProfileStore, promptVariables } from "../../../core/agent/src/prompts.js";
import { createMutableLLMClient, createOpenAICompatibleClient, createStubLLMClient, type LLMChatInput, type LLMChatResult } from "../../../core/llm/src/index.js";
import { createOutputRouter } from "../../../core/output-router/src/index.js";
import { createAllowAllPolicy } from "../../../core/policy/src/index.js";
import { createIntentRouter } from "../../../core/router/src/index.js";
import { createSessionResolver } from "../../../core/session/src/index.js";
import { createFeishuPlugin } from "../../../plugins/feishu/src/index.js";
import { createFeishuPairingStore } from "../../../plugins/feishu/src/pairing.js";
import { createMessagingTools } from "../../../plugins/messaging/src/index.js";
import { createAliceStore, type StoredConversationMessage } from "../../../packages/storage/src/sqlite-store.js";
import { createFileLogStore } from "../../../packages/storage/src/file-log-store.js";
import { createDailyScheduler } from "../../../core/scheduler/src/index.js";
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
  time: string;
  model?: string;
  temperature?: number;
  messages: LLMChatInput["messages"];
  tools?: LLMChatInput["tools"];
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
  time: string;
  message: LLMChatResult["message"];
  finishReason?: string;
  usage?: LLMChatResult["usage"];
  raw?: unknown;
};

type ActiveLLMSession = {
  startedAt: string;
  updatedAt: string;
  requestIds: number[];
  latestRequest?: unknown;
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
let store: ReturnType<typeof createAliceStore> | undefined;
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
store = createAliceStore("data/alice.sqlite", { time: currentTime });
systemLogStore = createFileLogStore("logs/system", { getTimeZone: () => currentTime.timeZone });
for (const entry of systemLogStore.listRecent(500)) {
  logs.push(entry);
  nextLogId = Math.max(nextLogId, entry.id + 1);
}
for (const entry of store.listMessageLogs(500)) {
  messageLogs.push(entry);
  nextMessageLogId = Math.max(nextMessageLogId, entry.id + 1);
}

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
const promptProfileStore = createPromptProfileStore(path.join(config.memoryFiles.root, "config", "prompt-profile.json"));
const messagingTools = createMessagingTools({
  store,
  outputRouter,
  time: currentTime,
  getUserName: () => promptProfileStore.get().userName,
  getDefaultTarget() {
    const contact = feishuPairingStore.list()[0];
    if (!contact) return undefined;
    return {
      plugin: "feishu",
      accountId: "main",
      channelId: contact.channelId,
      userId: contact.channelId ? undefined : contact.userId,
      sessionId: contact.sessionId ?? contact.channelId ?? contact.userId ?? "admin-test"
    };
  },
  appendMessageLog
});
const core = createAgentCore({
  config,
  llm: activeLLM,
  outputRouter,
  intentRouter: createIntentRouter(),
  sessionResolver: createSessionResolver(),
  policy: createAllowAllPolicy(),
  memory: {
    async recall(event) {
      const memories = store?.recallForEvent(event, 5).map((item) => item.content) ?? [];
      if (memories.length > 0) {
        appendLog("info", `memory recall: ${memories.length} item(s)`);
      }
      return memories;
    },
    async capture(event, outputs) {
      store?.captureTurn(event, outputs);
    }
  },
  tools: [messagingTools],
  getPromptProfile: () => promptProfileStore.get(),
  state: agentState,
  time: currentTime,
  onLLMRequestPrepared: appendLLMRequestLog,
  onLLMResponseReceived: appendLLMResponseLog,
  onLLMLog(event) {
    const mode = event.stream ? "stream" : "non-stream";
    if (event.kind === "call_start") appendLog("info", `llm call start: round=${event.round} mode=${mode} model=${event.model ?? config.llm.model}`);
    if (event.kind === "stream_start") appendLog("info", `llm stream start: round=${event.round} model=${event.model ?? config.llm.model}`);
    if (event.kind === "stream_end") appendLog("info", `llm stream end: round=${event.round} model=${event.model ?? config.llm.model}`);
    if (event.kind === "response_received") appendLog("info", `llm response received: round=${event.round} mode=${mode} model=${event.model ?? config.llm.model}`);
  },
  onLLMSessionCompleted(result) {
    clearActiveLLMSession(result.sentMessage ? "send_feishu" : "llm_turn_completed");
  }
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

const messageRuntime = createMessageRuntime({
  getDelayMs: () => config.core.inboundDebounceMs,
  time: currentTime,
  getProcessNowTarget() {
    const contact = feishuPairingStore.list()[0];
    if (!contact) return undefined;
    return {
      plugin: "feishu",
      accountId: "main",
      channelId: contact.channelId,
      userId: contact.channelId ? undefined : contact.userId,
      sessionId: contact.sessionId ?? contact.channelId ?? contact.userId ?? "admin-test"
    };
  },
  store,
  core,
  agentState,
  outputRouter,
  appendLog,
  appendMessageLog
});

core.registerChannel(feishu);
const scheduler = createDailyScheduler([
  {
    id: "system-log-retention",
    hour: 4,
    minute: 0,
    run() {
      const removed = systemLogStore?.cleanupOlderThan(7) ?? 0;
      appendLog("info", `daily cleanup: removed ${removed} system log file(s) older than 7 days`);
    }
  }
]);

const runtimeState = { feishuStarted: false };
const server = http.createServer(createApiRequestHandler({
  config,
  logs,
  messageLogs,
  llmRequestLogs,
  llmResponseLogs,
  getActiveLLMSession: () => activeLLMSession,
  store,
  getLLMRequestPreview,
  getLLMRequestProfilePreview,
  clearLLMChainCache,
  outputRouter,
  feishuPairingStore,
  promptProfileStore,
  agentState,
  messagingTools,
  feishu,
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
appendLog("info", `agent core started: llm=${config.llm.provider} feishu=${runtimeState.feishuStarted ? "started" : "stopped"}`);

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
  const entry = {
    id: nextLLMRequestLogId,
    time: currentTime.now().iso,
    model: input.model,
    temperature: input.temperature,
    messages: input.messages.map((message) => ({ ...message })),
    tools: input.tools?.map((tool) => ({ ...tool, function: { ...tool.function } })),
    rawRequest,
    diffFromPrevious
  };
  llmRequestLogs.push(entry);
  noteActiveLLMRequest(entry);
  if (diffFromPrevious) {
    appendLog("info", diffFromPrevious.sameAsPrevious
      ? `llm request diff: same as previous, common_prefix_chars=${diffFromPrevious.commonPrefixChars}`
      : [
          "llm request diff:",
          `first_diff=${diffFromPrevious.firstDiffPath}`,
          `common_prefix_chars=${diffFromPrevious.commonPrefixChars}`,
          `rough_common_prefix_tokens=${formatTokenCount(diffFromPrevious.roughCommonPrefixTokens)}`,
          `value_diff_index=${formatTokenCount(diffFromPrevious.valueDiffIndex)}`,
          `rough_value_prefix_tokens=${formatTokenCount(diffFromPrevious.roughValuePrefixTokens)}`,
          `previous=${formatDiffValue(diffFromPrevious.previousValue)}`,
          `current=${formatDiffValue(diffFromPrevious.currentValue)}`,
          `previous_excerpt=${JSON.stringify(diffFromPrevious.previousExcerpt ?? "")}`,
          `current_excerpt=${JSON.stringify(diffFromPrevious.currentExcerpt ?? "")}`
        ].join(" "));
  }
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
  llmResponseLogs.push({
    id: nextLLMResponseLogId,
    time: currentTime.now().iso,
    message: { ...result.message },
    finishReason: result.finishReason,
    usage: result.usage,
    raw: result.raw
  });
  nextLLMResponseLogId += 1;
  if (llmResponseLogs.length > 50) {
    llmResponseLogs.splice(0, llmResponseLogs.length - 50);
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

function formatTokenCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

function clearLLMChainCache(): void {
  clearActiveLLMSession("admin_clear");
}

function noteActiveLLMRequest(entry: LLMRequestLogEntry): void {
  if (!activeLLMSession) {
    activeLLMSession = {
      startedAt: entry.time,
      updatedAt: entry.time,
      requestIds: [],
      latestRequest: entry.rawRequest
    };
  }
  activeLLMSession.updatedAt = entry.time;
  activeLLMSession.requestIds.push(entry.id);
  activeLLMSession.latestRequest = entry.rawRequest;
}

function clearActiveLLMSession(reason: string): void {
  if (!activeLLMSession) return;
  const requestCount = activeLLMSession.requestIds.length;
  activeLLMSession = undefined;
  appendLog("info", `llm active session cleared: reason=${reason} requests=${requestCount}`);
}

async function getLLMRequestPreview(): Promise<LLMRequestPreview | undefined> {
  const preview = await buildLLMRequestPreviewFromMessages();
  if (preview) return { ...preview, rawRequest: buildRawLLMRequest(preview) };

  const latest = llmRequestLogs[llmRequestLogs.length - 1];
  if (latest) return { ...latest, source: "actual" };
  return undefined;
}

async function getLLMRequestProfilePreview(): Promise<LLMRequestPreview | undefined> {
  const profilePreview = await buildLLMRequestPreviewFromProfile();
  return profilePreview ? { ...profilePreview, rawRequest: buildRawLLMRequest(profilePreview) } : undefined;
}

async function buildLLMRequestPreviewFromProfile(): Promise<LLMRequestPreview | undefined> {
  const profile = promptProfileStore.get();
  const previewEvent = {
    id: "preview",
    source: {
      plugin: "feishu",
      channelId: "preview"
    },
    session: {
      scope: "dm",
      sessionId: "preview"
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
    conversationId: "preview",
    time: currentTime.now().iso,
    model: config.llm.model,
    temperature: config.llm.temperature,
    messages: await buildPromptPreviewMessages(profile, previewEvent),
    tools: profile.visibleTools.feishu === false ? [] : messagingTools.listTools().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }))
  };
}

async function buildLLMRequestPreviewFromMessages(): Promise<LLMRequestPreview | undefined> {
  const recent = store?.listMessages(500) ?? [];
  const latestInbound = [...recent].reverse().find((message) => message.direction === "inbound" && !message.isRecalled);
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
    messages: await buildPromptPreviewMessages(profile, previewEvent),
    tools: profile.visibleTools.feishu === false ? [] : messagingTools.listTools().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }))
  };
}

async function buildPromptPreviewMessages(
  profile: ReturnType<typeof promptProfileStore.get>,
  event: Parameters<typeof buildPromptMessagesWithToolResults>[1]["event"]
): Promise<LLMChatInput["messages"]> {
  return buildPromptMessagesWithToolResults(profile, { event, time: currentTime }, async (layer, call) => {
    if (call.toolName === "send_feishu") {
      return {
        callId: call.id,
        ok: false,
        error: "send_feishu cannot run from request preview"
      };
    }
    try {
      return await messagingTools.execute(call);
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
}

function buildRawLLMRequest(input: Pick<LLMChatInput, "model" | "temperature" | "messages" | "tools" | "maxTokens">): unknown {
  return {
    ...config.llm.extraParams,
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
