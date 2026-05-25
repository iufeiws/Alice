import { loadConfig } from "../../../packages/config/src/index.js";
import { createAgentCore } from "../../../core/agent/src/index.js";
import { createAgentStateController, createJsonAgentStateStore } from "../../../core/agent/src/state.js";
import { getPromptContent } from "../../../core/agent/src/prompts.js";
import { createMutableLLMClient, createOpenAICompatibleClient, createStubLLMClient, type LLMChatInput } from "../../../core/llm/src/index.js";
import { createOutputRouter } from "../../../core/output-router/src/index.js";
import { createAllowAllPolicy } from "../../../core/policy/src/index.js";
import { createIntentRouter } from "../../../core/router/src/index.js";
import { createSessionResolver } from "../../../core/session/src/index.js";
import { createFeishuPlugin } from "../../../plugins/feishu/src/index.js";
import { createFeishuPairingStore } from "../../../plugins/feishu/src/pairing.js";
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
};

type LLMRequestPreview = LLMRequestLogEntry & {
  source: "preview" | "actual";
  conversationId?: string;
};

const logs: LogEntry[] = [];
const messageLogs: MessageLogEntry[] = [];
const llmRequestLogs: LLMRequestLogEntry[] = [];
let nextLogId = 1;
let nextMessageLogId = 1;
let nextLLMRequestLogId = 1;
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
  state: agentState,
  time: currentTime,
  onLLMRequestPrepared: appendLLMRequestLog
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
  store,
  getLLMRequestPreview,
  outputRouter,
  feishuPairingStore,
  feishu,
  runtime: runtimeState,
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
        timeoutMs: config.llm.timeoutMs
      })
    : createStubLLMClient();
}

function appendLLMRequestLog(input: LLMChatInput): void {
  llmRequestLogs.push({
    id: nextLLMRequestLogId,
    time: currentTime.now().iso,
    model: input.model,
    temperature: input.temperature,
    messages: input.messages.map((message) => ({ ...message }))
  });
  nextLLMRequestLogId += 1;
  if (llmRequestLogs.length > 50) {
    llmRequestLogs.splice(0, llmRequestLogs.length - 50);
  }
}

function getLLMRequestPreview(): LLMRequestPreview | undefined {
  const preview = buildLLMRequestPreviewFromMessages();
  if (preview) return preview;

  const latest = llmRequestLogs[llmRequestLogs.length - 1];
  return latest ? { ...latest, source: "actual" } : undefined;
}

function buildLLMRequestPreviewFromMessages(): LLMRequestPreview | undefined {
  const recent = store?.listMessages(500) ?? [];
  const latestInbound = [...recent].reverse().find((message) => message.direction === "inbound" && !message.isRecalled);
  if (!latestInbound) return undefined;

  const conversation = store?.listMessagesForConversation(latestInbound.conversationId, 30) ?? [];
  const beforeLatest = conversation
    .filter((message) => message.id < latestInbound.id)
    .slice(-12);
  const context = beforeLatest.map(formatPreviewContextLine).join("\n");
  const latestText = latestInbound.contentText;
  const userContent = context
    ? `Conversation context:\n${context}\n\nLatest user messages:\n${latestText}`
    : latestText;
  const recalled = store?.recallForEvent({
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
    payload: { kind: "text", text: userContent },
    meta: {
      receivedAt: latestInbound.createdAt,
      replyTo: latestInbound.externalMessageId
    }
  }, 5).map((item) => item.content) ?? [];

  return {
    id: 0,
    source: "preview",
    conversationId: latestInbound.conversationId,
    time: latestInbound.lastEventAt || latestInbound.createdAt,
    model: config.llm.model,
    temperature: config.llm.temperature,
    messages: [
      {
        role: "system",
        content: getPromptContent("agent.placeholder.system")
      },
      ...(recalled.length > 0
        ? [{
            role: "system" as const,
            content: `Relevant persistent memory:\n${recalled.map((item) => `- ${item}`).join("\n")}`
          }]
        : []),
      { role: "user", content: userContent }
    ]
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
