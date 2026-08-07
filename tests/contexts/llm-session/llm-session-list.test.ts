import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectLLMSessionFiles,
  readLLMSessionJsonlMetadata,
  writeLLMSessionJsonl
} from "../../../src/contexts/llm-session/src/adapters/jsonl-llm-session-log.js";
import {
  createLLMSessionArchive,
  createLLMSessionListRuntime,
  createApiSessionRuntime
} from "../../../src/contexts/llm-session/src/index.js";
import { createLLMRequestsRuntime } from "../../../src/contexts/llm-gateway/src/llm-requests-runtime.js";
import { fs, path, fixedTime, makeTempDir } from "../llm-gateway/llm-and-storage-helpers.js";

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

test("archive readAll and listSessionFiles skip sub_agent", () => {
  const memoryRoot = makeTempDir("llm-session-archive");
  const archive = createLLMSessionArchive({
    memoryRoot,
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    appendLog() {}
  });
  const sessionRoot = path.join(memoryRoot, "llm-sessions");
  const chatDir = path.join(sessionRoot, "chat", "2026-06-14");
  fs.mkdirSync(chatDir, { recursive: true });
  writeLLMSessionJsonl(path.join(chatDir, "06-19-01-271.jsonl"), {
    type: "llm_session",
    sessionId: 100,
    agent: "chat",
    startedAt: "2026-06-14T14:19:01.271",
    updatedAt: "2026-06-14T14:19:05.000",
    requestIds: [1],
    responseIds: [2]
  }, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" }
  ]);
  const subAgentDir = path.join(sessionRoot, "sub_agent", "memorize", "2026-06-14");
  fs.mkdirSync(subAgentDir, { recursive: true });
  writeLLMSessionJsonl(path.join(subAgentDir, "b.jsonl"), {
    type: "llm_subagent_session",
    agent: "memorize",
    sessionId: 999
  }, [{ role: "user", content: "x" }]);

  assert.equal(archive.readAll().length, 1);
  assert.equal(archive.readAll()[0].id, 100);

  const files = archive.listSessionFiles();
  assert.deepEqual(files, [{
    agentType: "chat",
    date: "2026-06-14",
    clock: "06-19-01-271",
    filePath: path.join(sessionRoot, "chat", "2026-06-14", "06-19-01-271.jsonl")
  }]);
});

test("llm session list is filename-driven with time and agent type", () => {
  const memoryRoot = makeTempDir("llm-session-list");
  const archive = createLLMSessionArchive({
    memoryRoot,
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    appendLog() {}
  });
  const sessionRoot = path.join(memoryRoot, "llm-sessions");
  fs.mkdirSync(path.join(sessionRoot, "chat", "2026-06-14"), { recursive: true });
  fs.mkdirSync(path.join(sessionRoot, "talk", "2026-06-13"), { recursive: true });
  fs.mkdirSync(path.join(sessionRoot, "memorize", "2026-06-12"), { recursive: true });
  writeLLMSessionJsonl(path.join(sessionRoot, "chat", "2026-06-14", "06-19-01-271.jsonl"), { type: "llm_session", sessionId: 1, agent: "chat" }, []);
  writeLLMSessionJsonl(path.join(sessionRoot, "chat", "2026-06-14", "07-00-00-000.jsonl"), { type: "llm_session", sessionId: 2, agent: "chat" }, []);
  writeLLMSessionJsonl(path.join(sessionRoot, "talk", "2026-06-13", "05-10-00-000.jsonl"), { type: "llm_session", sessionId: 3, agent: "talk" }, []);
  writeLLMSessionJsonl(path.join(sessionRoot, "memorize", "2026-06-12", "04-00-00-000.jsonl"), { type: "llm_session", sessionId: 4, agent: "memorize" }, []);

  const runtime = createLLMSessionListRuntime({ archive });
  const cleared = runtime.getClearedLLMSessions() as Array<{ id: string; agentId: string; startedAt: string }>;
  assert.deepEqual(cleared.map((entry) => entry.agentId), ["chat", "chat"]);
  assert.deepEqual(cleared.map((entry) => entry.startedAt), ["2026-06-14T06-19-01-271", "2026-06-14T07-00-00-000"]);
  assert.ok(cleared[0].id.endsWith(".jsonl"));

  const talk = runtime.getTalkLLMSessions() as Array<{ agentId: string }>;
  assert.deepEqual(talk.map((entry) => entry.agentId), ["talk"]);
  const memory = runtime.getMemoryLLMSessions() as Array<{ agentId: string }>;
  assert.deepEqual(memory.map((entry) => entry.agentId), ["memorize"]);
});

test("LLM session runtime current session snapshot reflects request/response/clear", () => {
  const root = makeTempDir("llm-session-snapshot-cache");
  const runtime = createApiSessionRuntime({
    config: { memoryFiles: { root } },
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    getConversationStartIndex: () => undefined,
    buildTalkRuntimeMessages: () => [],
    appendLog() {}
  }).llmSessionRuntime;

  runtime.noteLLMRequest({
    id: 1,
    agentId: "chat",
    time: "2026-06-14T01:00:00.000",
    timeUtc: "2026-06-14T01:00:00.000Z",
    model: "chat-model",
    messages: [{ role: "user", content: "hello" }]
  } as any, "chat");
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

  runtime.clearCurrentLLMSession("admin_clear");
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
    }
  }).llmSessionRuntime;

  runtime.noteLLMRequest({
    id: 1,
    agentId: "chat",
    time: "2026-06-14T01:00:00.000",
    timeUtc: "2026-06-14T01:00:00.000Z",
    model: "chat-model",
    messages: [{ role: "user", content: "hello" }]
  } as any, "chat");

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
  const subagentRoot = makeTempDir("llm-subagent-memorize-skip");
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
    recordTokenUsageEvent() {},
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    resolvePromptApiPreset: () => ({ model: "fallback" }),
    appendLog() {},
    subagentSessionRoot: subagentRoot
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

  assert.equal(fs.existsSync(path.join(subagentRoot, "memorize")), false, "memorize should not create sub_agent transcript");
});
