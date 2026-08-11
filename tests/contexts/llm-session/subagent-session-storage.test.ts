import { test } from "node:test";
import assert from "node:assert/strict";
import { createLLMRequestsRuntime } from "../../../src/contexts/llm-gateway/src/llm-requests-runtime.js";
import { createLLMSessionStore } from "../../../src/contexts/llm-session/src/adapters/sqlite-llm-session-store.js";
import type { LLMSessionStore, StoredLLMSession } from "../../../src/contexts/llm-session/src/adapters/sqlite-llm-session-store.js";
import { fs, path, fixedTime, makeTempDir } from "../llm-gateway/llm-and-storage-helpers.js";

type LogEntry = { level: "info" | "warn" | "error"; message: string };

function failingStore(real: LLMSessionStore) {
  const failed = new Set<string>();
  const fail = (...methods: string[]) => {
    for (const method of methods) failed.add(method);
  };
  const wrapped: LLMSessionStore = {
    create(session) {
      if (failed.has("create")) throw new Error("injected subagent store failure: create");
      real.create(session);
    },
    read(sessionId) {
      return real.read(sessionId);
    },
    readMeta(sessionId) {
      return real.readMeta(sessionId);
    },
    append(input) {
      if (failed.has("append")) throw new Error("injected subagent store failure: append");
      real.append(input);
    },
    updateMeta(input) {
      if (failed.has("updateMeta")) throw new Error("injected subagent store failure: updateMeta");
      real.updateMeta(input);
    },
    replace(input) {
      if (failed.has("replace")) throw new Error("injected subagent store failure: replace");
      real.replace(input);
    },
    list(input) {
      return real.list(input);
    },
    close() {
      real.close();
    }
  };
  return { wrapped, fail };
}

async function runSubagentRequest(options: {
  subagentSessionRoot?: string;
  subagentSessionStore?: LLMSessionStore;
  client?: any;
  logs?: LogEntry[];
}) {
  const logs = options.logs ?? [];
  const client = options.client ?? {
    async chat() {
      return { model: "mimo-v2.5", message: { role: "assistant", content: "subagent-done" }, finishReason: "stop" };
    }
  };
  const runtime = createLLMRequestsRuntime({
    getTool: () => undefined,
    appendLLMRequestLog: () => {
      throw new Error("subagent must not use the main request log");
    },
    appendLLMResponseLog: () => {
      throw new Error("subagent must not use the main response log");
    },
    appendLLMUsageLog() {},
    recordTokenUsageEvent() {},
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    resolvePromptApiPreset: () => ({ model: "fallback" }),
    appendLog(level: "info" | "warn" | "error", message: string) {
      logs.push({ level, message });
    },
    subagentSessionRoot: options.subagentSessionRoot,
    subagentSessionStore: options.subagentSessionStore
  });
  return await runtime.send({
    agentId: "asr",
    client,
    messages: [{ role: "user", content: "audio" }],
    model: "mimo-v2.5",
    toolNames: [],
    round: 0,
    stream: false,
    metadata: { pluginId: "asr" }
  } as any);
}

function storedSession(overrides: Partial<StoredLLMSession> = {}): StoredLLMSession {
  return {
    sessionId: "s1",
    agentType: "chat",
    startedAt: "2026-06-14T01:00:00.000",
    startedAtUtc: "2026-06-14T01:00:00.000Z",
    meta: { type: "llm_session", agent: "chat" },
    messages: [],
    ...overrides
  };
}

test("uses a database distinct from the main session database", async () => {
  const memoryRoot = makeTempDir("subagent-distinct-db");
  const mainDbPath = path.join(memoryRoot, "llm-sessions.sqlite");
  const subagentDbPath = path.join(memoryRoot, "llm-subagent-sessions.sqlite");
  const mainStore = createLLMSessionStore(mainDbPath);
  mainStore.create(storedSession({
    sessionId: "main-1",
    messages: [{ role: "user", content: "main" }]
  }));
  await runSubagentRequest({ subagentSessionRoot: subagentDbPath });
  const subagentStore = createLLMSessionStore(subagentDbPath);
  const sessions = subagentStore.list({ agentType: "asr", limit: 10 });
  assert.equal(sessions.length, 1, "subagent transcript must land in the subagent database");
  const loaded = subagentStore.read(sessions[0].sessionId);
  assert.deepEqual(loaded?.messages.map((message: any) => message.role), ["user", "assistant"]);
  assert.deepEqual(loaded?.meta.metadata, { pluginId: "asr" });
  subagentStore.close();
  assert.deepEqual(mainStore.list({ agentType: "asr", limit: 10 }), [], "main database must not contain subagent sessions");
  assert.deepEqual(mainStore.list({ agentType: "chat", limit: 10 }).map((item) => item.sessionId), ["main-1"]);
  mainStore.close();
  assert.notEqual(subagentDbPath, mainDbPath);
});

test("continues subagent llm call when its database open fails", async () => {
  const memoryRoot = makeTempDir("subagent-open-fail");
  // a regular file in the way makes the database path unusable
  const blocker = path.join(memoryRoot, "blocker");
  fs.writeFileSync(blocker, "not a directory");
  const logs: LogEntry[] = [];
  const result = await runSubagentRequest({ subagentSessionRoot: path.join(blocker, "sub.sqlite"), logs });
  assert.equal((result.message as any).content, "subagent-done", "LLM call must continue when the subagent database cannot be opened");
  assert.ok(logs.some((entry) => entry.level === "error" || entry.level === "warn"), "storage failure must be recorded");
});

test("continues subagent llm call when its write fails", async () => {
  const memoryRoot = makeTempDir("subagent-write-fail");
  const realStore = createLLMSessionStore(path.join(memoryRoot, "llm-subagent-sessions.sqlite"));
  const { wrapped, fail } = failingStore(realStore);
  fail("create", "append");
  const logs: LogEntry[] = [];
  const result = await runSubagentRequest({ subagentSessionStore: wrapped, logs });
  assert.equal((result.message as any).content, "subagent-done", "LLM call must continue when the subagent write fails");
  assert.ok(logs.some((entry) => entry.level === "error" || entry.level === "warn"), "write failure must be recorded");
  realStore.close();
});

test("keeps the main database writable after subagent corruption", async () => {
  const memoryRoot = makeTempDir("subagent-corruption");
  const mainStore = createLLMSessionStore(path.join(memoryRoot, "llm-sessions.sqlite"));
  mainStore.create(storedSession({ sessionId: "main-1" }));
  const subagentDbPath = path.join(memoryRoot, "llm-subagent-sessions.sqlite");
  fs.writeFileSync(subagentDbPath, "this is not a sqlite database at all");
  await runSubagentRequest({ subagentSessionRoot: subagentDbPath });
  // the main database stays fully writable and readable
  mainStore.create(storedSession({ sessionId: "main-2", messages: [{ role: "user", content: "after" }] }));
  assert.ok(mainStore.read("main-2"));
  assert.deepEqual(mainStore.list({ agentType: "chat", limit: 10 }).map((item) => item.sessionId), ["main-1", "main-2"]);
  mainStore.close();
});

test("reports degraded storage without changing llm input", async () => {
  const captured: Array<{ messages: unknown; model: string; temperature: unknown }> = [];
  const captureClient = () => ({
    async chat(request: any) {
      captured.push({
        messages: request.messages,
        model: request.model,
        temperature: request.temperature
      });
      return { model: request.model, message: { role: "assistant", content: "subagent-done" }, finishReason: "stop" };
    }
  });
  // healthy storage first
  const healthyRoot = makeTempDir("subagent-input-healthy");
  await runSubagentRequest({ subagentSessionRoot: path.join(healthyRoot, "llm-subagent-sessions.sqlite"), client: captureClient() });
  // failing storage second
  const failingRoot = makeTempDir("subagent-input-failing");
  const realStore = createLLMSessionStore(path.join(failingRoot, "llm-subagent-sessions.sqlite"));
  const { wrapped, fail } = failingStore(realStore);
  fail("create", "append");
  const logs: LogEntry[] = [];
  await runSubagentRequest({ subagentSessionStore: wrapped, client: captureClient(), logs });
  realStore.close();
  assert.equal(captured.length, 2);
  assert.deepEqual(captured[1], captured[0], "storage failure must not change the actual LLM request");
  assert.ok(logs.some((entry) => entry.level === "error" || entry.level === "warn"), "degraded storage must be reported");
});

test("does not create jsonl fallback files", async () => {
  const memoryRoot = makeTempDir("subagent-no-jsonl-fallback");
  const realStore = createLLMSessionStore(path.join(memoryRoot, "llm-subagent-sessions.sqlite"));
  const { wrapped, fail } = failingStore(realStore);
  fail("create");
  await runSubagentRequest({ subagentSessionStore: wrapped });
  realStore.close();
  const jsonlFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) jsonlFiles.push(full);
    }
  };
  walk(memoryRoot);
  assert.deepEqual(jsonlFiles, [], "no JSONL fallback files may be created");
});
