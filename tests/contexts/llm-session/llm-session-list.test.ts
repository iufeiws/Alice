import { test } from "node:test";
import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import {
  collectLLMSessionFiles,
  readLLMSessionJsonlMetadata
} from "../../../src/contexts/llm-session/src/adapters/jsonl-llm-session-log.js";
import {
  createLLMSessionArchive,
  createLLMSessionListRuntime,
  createApiSessionRuntime
} from "../../../src/contexts/llm-session/src/index.js";
import { createLLMSessionBrowserRuntime } from "../../../src/contexts/llm-session/src/application/browse-llm-sessions.js";
import { createLLMSessionStore } from "../../../src/contexts/llm-session/src/adapters/sqlite-llm-session-store.js";
import type { StoredLLMSession } from "../../../src/contexts/llm-session/src/adapters/sqlite-llm-session-store.js";
import type { SessionClearRequest } from "../../../src/contexts/llm-session/src/application/session-clear-coordinator.js";
import { createLLMRequestsRuntime } from "../../../src/contexts/llm-gateway/src/llm-requests-runtime.js";
import { fs, path, fixedTime, makeTempDir } from "../llm-gateway/llm-and-storage-helpers.js";

function storedSession(overrides: Partial<StoredLLMSession> = {}): StoredLLMSession {
  const startedAt = overrides.startedAt ?? "2026-06-14T01:00:00.000";
  return {
    sessionId: "s1",
    agentType: "chat",
    startedAt,
    startedAtUtc: "2026-06-14T01:00:00.000Z",
    meta: {
      type: "llm_session",
      agent: overrides.agentType ?? "chat",
      schemaVersion: 1,
      sessionId: overrides.sessionId ?? "s1",
      startedAt,
      startedAtUtc: "2026-06-14T01:00:00.000Z",
      updatedAt: startedAt,
      updatedAtUtc: "2026-06-14T01:00:00.000Z",
      requestIds: [1],
      responseIds: [2],
      messageCount: (overrides.messages ?? []).length
    },
    messages: [],
    ...overrides
  };
}

/**
 * 结构等价 createSessionClearCoordinator 产物的 fake（§7.1: coordinator 为统一入口,
 * 任何 clear 路径都必须经过它, 不存在绕过采集的兼容 fallback）。
 */
function fakeSessionClearCoordinator() {
  return {
    async clearSession(request: SessionClearRequest) {
      if (!request.exists()) return { cleared: false, shortMemoryCaptured: false };
      await request.clear();
      return { cleared: true, shortMemoryCaptured: false };
    }
  };
}

test("readLLMSessionJsonlMetadata reads only the metadata line", () => {
  const root = makeTempDir("llm-session-metadata-only");
  const filePath = path.join(root, "session.jsonl");
  fs.writeFileSync(filePath, [
    JSON.stringify({ type: "llm_session", sessionId: 123, messageCount: 3 }),
    JSON.stringify({ role: "user", content: "a" }),
    JSON.stringify({ role: "assistant", content: "b" })
  ].join("\n") + "\n");
  const parsed = readLLMSessionJsonlMetadata(filePath);
  assert.equal(parsed?.metadata.sessionId, 123);
  assert.equal(parsed?.metadata.messageCount, 3);
  assert.deepEqual(parsed?.messages, []);
});

test("collectLLMSessionFiles skips configured directories", () => {
  const root = makeTempDir("llm-session-skip-dirs");
  fs.mkdirSync(path.join(root, "chat"), { recursive: true });
  fs.mkdirSync(path.join(root, "sub_agent", "memorize"), { recursive: true });
  fs.writeFileSync(path.join(root, "chat", "a.jsonl"), "{}");
  fs.writeFileSync(path.join(root, "sub_agent", "memorize", "b.jsonl"), "{}");
  const files: string[] = [];
  collectLLMSessionFiles(root, files, { skipDirs: ["sub_agent"] });
  assert.deepEqual(files.map((file) => path.basename(file)), ["a.jsonl"]);
});

test("archive readAll and listSessionFiles cover main sessions only", () => {
  const memoryRoot = makeTempDir("llm-session-archive");
  const archive = createLLMSessionArchive({
    memoryRoot,
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    appendLog() {}
  });
  const store = createLLMSessionStore(path.join(memoryRoot, "llm-sessions.sqlite"));
  store.create(storedSession({
    sessionId: "100",
    agentType: "chat",
    startedAt: "2026-06-14T06:19:01.271",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" }
    ]
  }));
  store.create(storedSession({
    sessionId: "101",
    agentType: "talk",
    startedAt: "2026-06-13T05:10:00.000"
  }));
  store.close();

  const all = archive.readAll();
  assert.deepEqual(all.map((session) => String(session.id)).sort(), ["100", "101"]);
  const chat = all.find((session) => String(session.id) === "100");
  assert.deepEqual(chat?.messages.map((message: any) => message.content), ["sys", "hi"]);

  const files = archive.listSessionFiles();
  assert.deepEqual(files.map((entry) => entry.agentType).sort(), ["chat", "talk"]);
  assert.deepEqual(files.map((entry) => entry.date).sort(), ["2026-06-13", "2026-06-14"]);
  const chatEntry = files.find((entry) => entry.agentType === "chat");
  assert.equal(chatEntry?.clock, "06-19-01-271");
});

test("llm session list is database-driven with time and agent type", () => {
  const memoryRoot = makeTempDir("llm-session-list");
  const archive = createLLMSessionArchive({
    memoryRoot,
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    appendLog() {}
  });
  const store = createLLMSessionStore(path.join(memoryRoot, "llm-sessions.sqlite"));
  store.create(storedSession({ sessionId: "1", agentType: "chat", startedAt: "2026-06-14T06:19:01.271" }));
  store.create(storedSession({ sessionId: "2", agentType: "chat", startedAt: "2026-06-14T07:00:00.000" }));
  store.create(storedSession({ sessionId: "3", agentType: "talk", startedAt: "2026-06-13T05:10:00.000" }));
  store.create(storedSession({ sessionId: "4", agentType: "memorize", startedAt: "2026-06-12T04:00:00.000" }));
  store.close();

  const runtime = createLLMSessionListRuntime({ archive });
  const cleared = runtime.getClearedLLMSessions() as Array<{ id: string; agentId: string; startedAt: string }>;
  assert.deepEqual(cleared.map((entry) => entry.agentId), ["chat", "chat"]);
  assert.deepEqual(cleared.map((entry) => entry.startedAt), ["2026-06-14T06-19-01-271", "2026-06-14T07-00-00-000"]);
  const talk = runtime.getTalkLLMSessions() as Array<{ agentId: string }>;
  assert.deepEqual(talk.map((entry) => entry.agentId), ["talk"]);
  const memory = runtime.getMemoryLLMSessions() as Array<{ agentId: string }>;
  assert.deepEqual(memory.map((entry) => entry.agentId), ["memorize"]);
});

test("LLM session runtime current session snapshot reflects request/response/clear", async () => {
  const root = makeTempDir("llm-session-snapshot-cache");
  const runtime = createApiSessionRuntime({
    config: { memoryFiles: { root } },
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    getConversationStartIndex: () => undefined,
    buildTalkRuntimeMessages: () => [],
    appendLog() {},
    sessionClearCoordinator: fakeSessionClearCoordinator()
  }).llmSessionRuntime;

  runtime.noteLLMRequest({
    id: 1,
    agentId: "chat",
    time: "2026-06-14T01:00:00.000",
    timeUtc: "2026-06-14T01:00:00.000Z",
    model: "chat-model",
    messages: [{ role: "user", content: "hello" }]
  } as any, "chat", [{ role: "user", content: "hello" }]);
  runtime.noteLLMResponse({
    id: 2,
    agentId: "chat",
    sessionId: (runtime.getCurrentLLMSessionSnapshot() as { id: number }).id,
    requestId: 1,
    time: "2026-06-14T01:00:01.000",
    timeUtc: "2026-06-14T01:00:01.000Z",
    message: { role: "assistant", content: "done" },
    finishReason: "stop"
  } as any);

  const snapshot = runtime.getCurrentLLMSessionSnapshot() as { messageCount: number; latestMessage?: { content: string } };
  assert.equal(snapshot.messageCount, 2);
  assert.equal(snapshot.latestMessage?.content, "done");

  await runtime.clearCurrentLLMSession("admin_clear");
  assert.equal(runtime.getCurrentLLMSessionSnapshot(), undefined);
});

test("LLM session runtime skips response for a non-current session", () => {
  const root = makeTempDir("llm-session-response-mismatch");
  const warnings: string[] = [];
  const runtime = createApiSessionRuntime({
    config: { memoryFiles: { root } },
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    getConversationStartIndex: () => undefined,
    buildTalkRuntimeMessages: () => [],
    appendLog(level: string, message: string) {
      if (level === "warn") warnings.push(message);
    },
    sessionClearCoordinator: fakeSessionClearCoordinator()
  }).llmSessionRuntime;

  runtime.noteLLMRequest({
    id: 1,
    agentId: "chat",
    time: "2026-06-14T01:00:00.000",
    timeUtc: "2026-06-14T01:00:00.000Z",
    model: "chat-model",
    messages: [{ role: "user", content: "hello" }]
  } as any, "chat", [{ role: "user", content: "hello" }]);

  runtime.noteLLMResponse({
    id: 2,
    agentId: "chat",
    sessionId: 999,
    requestId: 1,
    time: "2026-06-14T01:00:01.000",
    timeUtc: "2026-06-14T01:00:01.000Z",
    message: { role: "assistant", content: "stale response" },
    finishReason: "stop"
  } as any);

  const snapshot = runtime.getCurrentLLMSessionSnapshot() as { messageCount: number };
  assert.equal(snapshot.messageCount, 1, "response for a non-current session must be skipped");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /session mismatch/);
});

test("memorize LLM calls do not write duplicate sub_agent transcripts", async () => {
  const memoryRoot = makeTempDir("llm-subagent-memorize-skip");
  const subagentDbPath = path.join(memoryRoot, "llm-subagent-sessions.sqlite");
  const client = {
    async chat() {
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    }
  };
  const runtime = createLLMRequestsRuntime({
    getTool: () => undefined,
    appendLLMRequestLog: () => undefined,
    appendLLMResponseLog() {},
    appendLLMUsageLog() {},
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    resolvePromptApiPreset: () => ({ model: "fallback" }),
    appendLog() {},
    subagentSessionRoot: subagentDbPath
  });

  await runtime.send({
    agentId: "memorize",
    client,
    messages: [{ role: "user", content: "summarize" }],
    model: "mimo-v2.5",
    toolNames: [],
    round: 0,
    stream: false,
    metadata: { target: "summary" }
  } as any);

  assert.equal(fs.existsSync(subagentDbPath), false, "memorize should not create a subagent transcript");
});

test("browse session list reads only the meta table", () => {
  const memoryRoot = makeTempDir("browse-list-meta-only");
  const archive = createLLMSessionArchive({
    memoryRoot,
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    appendLog() {}
  });
  const store = createLLMSessionStore(path.join(memoryRoot, "llm-sessions.sqlite"));
  store.create(storedSession({
    sessionId: "b1",
    agentType: "chat",
    startedAt: "2026-06-14T01:00:00.000",
    meta: { type: "llm_session", agent: "chat", latestRequestInfo: { round: 0 }, mode: "normal" },
    messages: [{ role: "user", content: "x" }]
  }));
  store.create(storedSession({
    sessionId: "b2",
    agentType: "talk",
    startedAt: "2026-06-14T02:00:00.000",
    meta: { type: "llm_session", agent: "talk" },
    messages: [{ role: "user", content: "y" }]
  }));
  store.close();

  // 删掉全部 messages 分表: 列表仍必须可用, messageCount 来自总表列而非分表。
  const raw = new (BetterSqlite3 as any)(path.join(memoryRoot, "llm-sessions.sqlite"));
  raw.prepare("DROP TABLE llm_messages_chat").run();
  raw.prepare("DROP TABLE llm_messages_talk").run();
  raw.close();

  const browser = createLLMSessionBrowserRuntime({
    listSessions: (agentType, limit) => archive.listSessions(agentType, limit),
    readSession: (sessionId) => archive.readSession(sessionId),
    readSessionMeta: (sessionId) => archive.readSessionMeta(sessionId),
    sources: [{
      name: "runtime",
      agentTypes: ["chat", "talk"]
    }]
  });
  const items = browser.listSessions("runtime") as Array<{ id: string; messageCount: number; agentId: string }>;
  assert.deepEqual(items.map((item) => item.id).sort(), ["b1", "b2"]);
  assert.deepEqual(items.map((item) => item.messageCount).sort(), [1, 1], "messageCount must come from the meta table column");
  assert.deepEqual(items.map((item) => item.agentId).sort(), ["chat", "talk"]);
  assert.equal((items.find((item) => item.id === "b1") as any).latestRequest?.round, 0);
  archive.close();
});
