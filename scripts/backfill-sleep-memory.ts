import { createMarkdownMemoryStore, createMemoryInductionPromptStore, createSleepMemoryStateStore, runSleepMemoryBackfill } from "../src/contexts/memory/src/memory.js";
import { createOpenAICompatibleClient } from "../src/contexts/llm-gateway/src/index.js";
import { createMutableCurrentTimeProvider } from "../src/platform/time/src/index.js";
import { loadConfig } from "../src/apps/api/bootstrap/app-config-runtime.js";
import { createAliceStore } from "../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";

const fs = await import("node:fs");
const path = await import("node:path");

loadDotEnv(".env");

const config = loadConfig();
const currentTime = createMutableCurrentTimeProvider(config.core.timezone);
const memoryStore = createMarkdownMemoryStore(config.memoryFiles.root);
const promptStore = createMemoryInductionPromptStore(path.join(config.memoryFiles.root, "config", "memorize-prompts.json"));
const stateStore = createSleepMemoryStateStore(path.join(config.memoryFiles.root, "state", "sleep-memory-state.json"));
const store = createAliceStore("data/alice.sqlite", {
  time: currentTime,
  messageDbPath: path.join(config.memoryFiles.root, "message", "messages.sqlite"),
  messageLogDbPath: path.join("logs", "message", "message-logs.sqlite")
});
const llm = config.memorySummary.enabled && config.memorySummary.apiKey
  ? createOpenAICompatibleClient({
      baseURL: config.memorySummary.baseURL,
      apiKey: config.memorySummary.apiKey,
      model: config.memorySummary.model ?? "deepseek-v4-pro",
      temperature: config.memorySummary.temperature,
      timeoutMs: config.memorySummary.timeoutMs,
      extraParams: config.memorySummary.extraParams
    })
  : undefined;

const result = await runSleepMemoryBackfill({
  memoryStore,
  promptStore,
  stateStore,
  messageStore: store,
  llm,
  config: config.memorySummary,
  nowIso: () => currentTime.now().iso,
  timezone: currentTime.timeZone,
  log(level, message) {
    const line = `[${level}] ${message}`;
    if (level === "error") console.error(line);
    else console.log(line);
  }
});

process.exitCode = result.ok ? 0 : 1;

function loadDotEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
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
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
