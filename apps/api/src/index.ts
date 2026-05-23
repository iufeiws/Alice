import { loadConfig } from "../../../packages/config/src/index.js";
import { createAgentCore } from "../../../core/agent/src/index.js";
import { createMutableLLMClient, createOpenAICompatibleClient, createStubLLMClient } from "../../../core/llm/src/index.js";
import { createOutputRouter } from "../../../core/output-router/src/index.js";
import { createAllowAllPolicy } from "../../../core/policy/src/index.js";
import { createIntentRouter } from "../../../core/router/src/index.js";
import { createSessionResolver } from "../../../core/session/src/index.js";
import { createFeishuPlugin } from "../../../plugins/feishu/src/index.js";
import { createFeishuPairingStore } from "../../../plugins/feishu/src/pairing.js";
import { createAliceStore } from "../../../packages/storage/src/sqlite-store.js";
import { createFileLogStore } from "../../../packages/storage/src/file-log-store.js";
import { createDailyScheduler } from "../../../core/scheduler/src/index.js";
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
  summary: string;
};

const logs: LogEntry[] = [];
const messageLogs: MessageLogEntry[] = [];
let nextLogId = 1;
let nextMessageLogId = 1;
let store: ReturnType<typeof createAliceStore> | undefined;
let systemLogStore: ReturnType<typeof createFileLogStore> | undefined;

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
let llm = createLLMClientFromConfig();
const activeLLM = createMutableLLMClient(llm);
store = createAliceStore("data/alice.sqlite");
systemLogStore = createFileLogStore("logs/system", { timeZone: config.core.timezone });
for (const entry of systemLogStore.listRecent(500)) {
  logs.push(entry);
  nextLogId = Math.max(nextLogId, entry.id + 1);
}
for (const entry of store.listMessageLogs(500)) {
  messageLogs.push(entry);
  nextMessageLogId = Math.max(nextMessageLogId, entry.id + 1);
}

const outputRouter = createOutputRouter();
const feishuPairingStore = createFeishuPairingStore("memory-files/indexes/feishu-paired-contacts.json", {
  read(filePath) {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
  },
  write(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
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
  }
});

const feishu = createFeishuPlugin(config.plugins.feishu, {
  log: appendLog,
  pairingStore: feishuPairingStore,
  async onEvent(event) {
    messageRuntime.ingestEvent(event);
  }
});

const messageRuntime = createMessageRuntime({
  getDelayMs: () => config.core.inboundDebounceMs,
  store,
  core,
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
  store,
  outputRouter,
  feishuPairingStore,
  feishu,
  runtime: runtimeState,
  getLLM: () => llm,
  reloadLLM() {
    llm = createLLMClientFromConfig();
    activeLLM.setClient(llm);
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
    time: new Date().toISOString(),
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
    time: new Date().toISOString(),
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
