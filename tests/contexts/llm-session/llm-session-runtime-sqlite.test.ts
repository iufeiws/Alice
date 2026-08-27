import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLLMSessionArchive,
  createLLMSessionRuntime,
  createApiSessionRuntime
} from "../../../src/contexts/llm-session/src/index.js";
import { createLLMSessionStore } from "../../../src/contexts/llm-session/src/adapters/sqlite-llm-session-store.js";
import type { LLMSessionStore, StoredLLMSession } from "../../../src/contexts/llm-session/src/adapters/sqlite-llm-session-store.js";
import type { SessionClearRequest } from "../../../src/contexts/llm-session/src/application/session-clear-coordinator.js";
import { fs, path, fixedTime, makeTempDir } from "../llm-gateway/llm-and-storage-helpers.js";

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

function dbPathFor(memoryRoot: string): string {
  return path.join(memoryRoot, "llm-sessions.sqlite");
}

function pointerPath(memoryRoot: string): string {
  return path.join(memoryRoot, "llm-sessions", "current.json");
}

function readPointer(memoryRoot: string): { sessionId: number; agentType: string } {
  return JSON.parse(fs.readFileSync(pointerPath(memoryRoot), "utf8"));
}

function writePointer(memoryRoot: string, pointer: { sessionId: number; agentType: string }): void {
  fs.mkdirSync(path.dirname(pointerPath(memoryRoot)), { recursive: true });
  fs.writeFileSync(pointerPath(memoryRoot), JSON.stringify(pointer));
}

function makeEnv(memoryRoot: string, store?: LLMSessionStore) {
  const time = fixedTime("2026-06-14T01:00:00.000Z");
  const warnings: string[] = [];
  const archive = createLLMSessionArchive({
    memoryRoot,
    time,
    appendLog(level: string, message: string) {
      if (level === "warn") warnings.push(message);
    },
    store
  });
  const runtime = createLLMSessionRuntime({
    time,
    archive,
    getConversationStartIndex: () => undefined,
    buildTalkRuntimeMessages: () => [],
    appendLog() {},
    // §7.1: clear 必须经过统一 coordinator, 不存在绕过采集的兼容 fallback。
    sessionClearCoordinator: fakeSessionClearCoordinator()
  });
  return { archive, runtime, warnings, time };
}

function failingStore(real: LLMSessionStore) {
  const failed = new Set<string>();
  const calls: Record<string, number> = {};
  const bump = (method: string) => {
    calls[method] = (calls[method] ?? 0) + 1;
  };
  const fail = (...methods: string[]) => {
    for (const method of methods) failed.add(method);
  };
  const heal = () => {
    failed.clear();
  };
  const wrapped: LLMSessionStore = {
    create(session) {
      bump("create");
      if (failed.has("create")) throw new Error("injected store failure: create");
      real.create(session);
    },
    read(sessionId) {
      bump("read");
      return real.read(sessionId);
    },
    readMeta(sessionId) {
      bump("readMeta");
      return real.readMeta(sessionId);
    },
    append(input) {
      bump("append");
      if (failed.has("append")) throw new Error("injected store failure: append");
      real.append(input);
    },
    updateMeta(input) {
      bump("updateMeta");
      if (failed.has("updateMeta")) throw new Error("injected store failure: updateMeta");
      real.updateMeta(input);
    },
    replace(input) {
      bump("replace");
      if (failed.has("replace")) throw new Error("injected store failure: replace");
      real.replace(input);
    },
    list(input) {
      bump("list");
      return real.list(input);
    },
    close() {
      real.close();
    }
  };
  return { wrapped, fail, heal, calls };
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

function chatRequest(id: number, messages: any[], overrides: Record<string, unknown> = {}) {
  return {
    id,
    agentId: "chat",
    time: "2026-06-14T01:00:00.000",
    timeUtc: "2026-06-14T01:00:00.000Z",
    model: "chat-model",
    messages,
    ...overrides
  };
}

function noteRequest(runtime: any, id: number, messages: any[], agentId: "chat" | "talk" = "chat", overrides: Record<string, unknown> = {}): void {
  runtime.noteLLMRequest(chatRequest(id, messages, overrides), agentId, messages);
}

function currentSessionId(runtime: any): number {
  return (runtime.getCurrentLLMSessionSnapshot() as { id: number }).id;
}

test("loads current only from the external pointer", () => {
  const memoryRoot = makeTempDir("runtime-pointer-load");
  const store = createLLMSessionStore(dbPathFor(memoryRoot));
  store.create(storedSession({
    sessionId: "42",
    agentType: "chat",
    meta: {
      type: "llm_session",
      agent: "chat",
      sessionId: 42,
      staticPromptFingerprint: "sha256:abc",
      requestIds: [1],
      responseIds: [2]
    },
    messages: [{ role: "user", content: "persisted" }]
  }));
  store.close();
  // without a pointer the seeded session must not surface as current
  const { runtime } = makeEnv(memoryRoot);
  assert.equal(runtime.restorePersistedCurrentLLMSession(), undefined);
  // once the external pointer names it, it becomes the current session
  writePointer(memoryRoot, { sessionId: 42, agentType: "chat" });
  const restored = runtime.restorePersistedCurrentLLMSession();
  assert.ok(restored, "pointer target must restore as the current session");
  assert.equal(typeof restored.id, "number");
  assert.equal(restored.id, 42);
  assert.deepEqual(restored.messages.map((message: any) => message.content), ["persisted"]);
});

test("restores final session metadata without request audit payloads", () => {
  const memoryRoot = makeTempDir("runtime-final-meta");
  const store = createLLMSessionStore(dbPathFor(memoryRoot));
  store.create(storedSession({
    sessionId: "100",
    agentType: "chat",
    meta: {
      type: "llm_session",
      agent: "chat",
      sessionId: 100,
      staticPromptFingerprint: "sha256:current",
      requestIds: [1],
      responseIds: [2],
      latestRequestInfo: { round: 0, time: "2026-06-14T01:00:00.000", messageCount: 2 },
      latestResponseInfo: { round: 0, time: "2026-06-14T01:00:05.000", finishReason: "stop" },
      reason: "admin_clear",
      mode: "fixed_prefix",
      modeStaticMessages: [
        { role: "system", content: "prefix" },
        { role: "user", content: "current" }
      ]
    },
    messages: [
      { role: "system", content: "prefix" },
      { role: "user", content: "current" },
      { role: "assistant", content: "old answer" }
    ]
  }));
  store.close();
  writePointer(memoryRoot, { sessionId: 100, agentType: "chat" });
  const { runtime } = makeEnv(memoryRoot);
  const restored = runtime.restorePersistedCurrentLLMSession();
  assert.ok(restored, "current session must restore");
  assert.equal((restored.latestRequestInfo as any)?.round, 0);
  assert.equal((restored.latestResponseInfo as any)?.finishReason, "stop");
  assert.equal(restored.reason, "admin_clear");
  assert.deepEqual((restored.modeStaticMessages ?? []).map((message: any) => message.content), ["prefix", "current"]);
});

test("does not infer current when the pointer is absent", () => {
  const memoryRoot = makeTempDir("runtime-no-pointer");
  const store = createLLMSessionStore(dbPathFor(memoryRoot));
  store.create(storedSession({
    sessionId: "7",
    meta: { type: "llm_session", agent: "chat" },
    messages: [{ role: "user", content: "orphan" }]
  }));
  store.close();
  const { runtime } = makeEnv(memoryRoot);
  assert.equal(runtime.restorePersistedCurrentLLMSession(), undefined);
  assert.equal(runtime.getCurrentLLMSessionSnapshot(), undefined, "database content must never imply a current session");
  // a request creates a brand-new session instead of adopting the orphan
  noteRequest(runtime, 1, [{ role: "user", content: "new" }]);
  const snapshot = runtime.getCurrentLLMSessionSnapshot() as any;
  assert.ok(snapshot);
  assert.notEqual(String(snapshot.id), "7");
  const pointer = readPointer(memoryRoot);
  assert.equal(pointer.agentType, "chat");
  assert.equal(String(pointer.sessionId), String(snapshot.id));
});

test("rejects a pointer with a mismatched agent type", () => {
  const memoryRoot = makeTempDir("runtime-pointer-mismatch");
  const store = createLLMSessionStore(dbPathFor(memoryRoot));
  store.create(storedSession({ sessionId: "9", agentType: "talk", meta: { type: "llm_session", agent: "talk" } }));
  store.close();
  writePointer(memoryRoot, { sessionId: 9, agentType: "chat" });
  const { runtime } = makeEnv(memoryRoot);
  assert.equal(runtime.restorePersistedCurrentLLMSession(), undefined, "agent mismatch must yield no current");
  // a pointer to a missing session is also rejected
  writePointer(memoryRoot, { sessionId: 999, agentType: "chat" });
  assert.equal(runtime.restorePersistedCurrentLLMSession(), undefined);
  assert.equal(runtime.getCurrentLLMSessionSnapshot(), undefined);
});

test("keeps in-memory session unchanged when sqlite commit fails", () => {
  const memoryRoot = makeTempDir("runtime-commit-fail");
  const realStore = createLLMSessionStore(dbPathFor(memoryRoot));
  const { wrapped, fail } = failingStore(realStore);
  const { runtime } = makeEnv(memoryRoot, wrapped);
  noteRequest(runtime, 1, [{ role: "user", content: "hello" }]);
  fail("append");
  assert.throws(() => runtime.noteLLMResponse({
    id: 2,
    agentId: "chat",
    sessionId: currentSessionId(runtime),
    requestId: 1,
    time: "2026-06-14T01:00:01.000",
    timeUtc: "2026-06-14T01:00:01.000Z",
    message: { role: "assistant", content: "done" },
    finishReason: "stop"
  } as any), /injected store failure/);
  const snapshot = runtime.getCurrentLLMSessionSnapshot() as any;
  assert.equal(snapshot.messageCount, 1, "failed commit must not replace the authoritative in-memory session");
  assert.equal(snapshot.latestMessage?.content, "hello");
  const reader = createLLMSessionStore(dbPathFor(memoryRoot));
  const persisted = reader.read(String(currentSessionId(runtime)));
  assert.deepEqual(persisted?.messages.map((message: any) => message.content), ["hello"], "database must keep the last successful commit");
  reader.close();
});

test("uses one transcript writer for request response and tool updates", () => {
  const memoryRoot = makeTempDir("runtime-one-writer");
  const realStore = createLLMSessionStore(dbPathFor(memoryRoot));
  const { wrapped, calls } = failingStore(realStore);
  const { runtime } = makeEnv(memoryRoot, wrapped);
  noteRequest(runtime, 1, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" }
  ]);
  const requestPhase = { ...calls };
  const id = currentSessionId(runtime);
  runtime.noteLLMResponse({
    id: 2,
    agentId: "chat",
    sessionId: id,
    requestId: 1,
    time: "2026-06-14T01:00:01.000",
    timeUtc: "2026-06-14T01:00:01.000Z",
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }]
    },
    finishReason: "tool_calls"
  } as any);
  const responsePhase = { ...calls };
  const transcript = runtime.loadCurrentLLMSessionTranscript() as any;
  runtime.updateCurrentLLMSessionTranscript({
    ...transcript,
    messages: [...transcript.messages, { role: "tool", toolCallId: "call_1", content: "42" }]
  } as any);
  // all three phases wrote through the same injected store instance
  assert.ok((requestPhase.create ?? 0) + (requestPhase.replace ?? 0) > 0, "request phase committed through the injected store");
  assert.ok((responsePhase.append ?? 0) > (requestPhase.append ?? 0), "response commit went through the same writer");
  assert.ok((calls.append ?? 0) > (responsePhase.append ?? 0), "tool result commit went through the same writer");
  const reader = createLLMSessionStore(dbPathFor(memoryRoot));
  const persisted = reader.read(String(id));
  assert.deepEqual(persisted?.messages.map((message: any) => message.role), ["system", "user", "assistant", "tool"]);
  reader.close();
});

test("commits request messages before dispatch", () => {
  const memoryRoot = makeTempDir("runtime-request-commit");
  const { runtime } = makeEnv(memoryRoot);
  noteRequest(runtime, 1, [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" }
  ]);
  const id = currentSessionId(runtime);
  const reader = createLLMSessionStore(dbPathFor(memoryRoot));
  const persisted = reader.read(String(id));
  assert.deepEqual(persisted?.messages.map((message: any) => message.content), ["sys", "hello"]);
  assert.deepEqual(persisted?.meta.requestIds, [1]);
  assert.equal(persisted?.agentType, "chat");
  reader.close();
  assert.ok(fs.existsSync(pointerPath(memoryRoot)), "pointer must exist right after the request commit");
});

test("commits assistant response before tool execution", () => {
  const memoryRoot = makeTempDir("runtime-response-commit");
  const { runtime } = makeEnv(memoryRoot);
  noteRequest(runtime, 1, [{ role: "user", content: "hello" }]);
  const id = currentSessionId(runtime);
  runtime.noteLLMResponse({
    id: 2,
    agentId: "chat",
    sessionId: id,
    requestId: 1,
    time: "2026-06-14T01:00:01.000",
    timeUtc: "2026-06-14T01:00:01.000Z",
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }]
    },
    finishReason: "tool_calls"
  } as any);
  const reader = createLLMSessionStore(dbPathFor(memoryRoot));
  const persisted = reader.read(String(id));
  assert.deepEqual(persisted?.messages.map((message: any) => message.role), ["user", "assistant"]);
  assert.deepEqual(persisted?.meta.responseIds, [2]);
  reader.close();
});

test("commits each tool result before the next request", () => {
  const memoryRoot = makeTempDir("runtime-tool-result-commit");
  const { runtime } = makeEnv(memoryRoot);
  const mSystem = { role: "system", content: "sys" };
  const mUser1 = { role: "user", content: "hello" };
  const mAssistant = {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }]
  };
  const mTool = { role: "tool", toolCallId: "call_1", content: "42" };
  const mUser2 = { role: "user", content: "thanks" };
  noteRequest(runtime, 1, [mSystem, mUser1]);
  const id = currentSessionId(runtime);
  runtime.noteLLMResponse({
    id: 2,
    agentId: "chat",
    sessionId: id,
    requestId: 1,
    time: "2026-06-14T01:00:01.000",
    timeUtc: "2026-06-14T01:00:01.000Z",
    message: mAssistant,
    finishReason: "tool_calls"
  } as any);
  const transcript = runtime.loadCurrentLLMSessionTranscript() as any;
  runtime.updateCurrentLLMSessionTranscript({
    ...transcript,
    messages: [...transcript.messages, mTool]
  } as any);
  let reader = createLLMSessionStore(dbPathFor(memoryRoot));
  let persisted = reader.read(String(id));
  assert.deepEqual(persisted?.messages.map((message: any) => message.role), ["system", "user", "assistant", "tool"]);
  reader.close();
  // the next request carries the full transcript including the committed tool result
  noteRequest(runtime, 2, [mSystem, mUser1, mAssistant, mTool, mUser2]);
  reader = createLLMSessionStore(dbPathFor(memoryRoot));
  persisted = reader.read(String(id));
  assert.equal(persisted?.messages.length, 5);
  assert.deepEqual(persisted?.messages.map((message: any) => message.content), ["sys", "hello", "", "42", "thanks"]);
  assert.deepEqual(persisted?.meta.requestIds, [1, 2]);
  reader.close();
});

test("does not persist transport request audit while appending the authoritative transcript delta", () => {
  const memoryRoot = makeTempDir("runtime-request-transport-transcript-separation");
  const { runtime } = makeEnv(memoryRoot);
  const user = { role: "user" as const, content: "start" };
  const assistant = {
    role: "assistant" as const,
    content: "",
    reasoningContent: "private reasoning",
    toolCalls: []
  };
  const nextUser = { role: "user" as const, content: "again" };
  runtime.noteLLMRequest(chatRequest(1, [user]), "chat", [user]);
  const id = currentSessionId(runtime);
  runtime.noteLLMResponse({
    id: 2,
    agentId: "chat",
    sessionId: id,
    requestId: 1,
    time: "2026-06-14T01:00:01.000",
    timeUtc: "2026-06-14T01:00:01.000Z",
    message: assistant,
    finishReason: "stop"
  } as any);

  runtime.noteLLMRequest(chatRequest(3, [
    user,
    { role: "assistant", content: "" },
    nextUser
  ]), "chat", [user, assistant, nextUser]);

  const reader = createLLMSessionStore(dbPathFor(memoryRoot));
  const persisted = reader.read(String(id));
  assert.deepEqual(persisted?.messages, [user, assistant, nextUser], "session transcript must retain the unsanitized assistant message");
  assert.equal(Object.prototype.hasOwnProperty.call(persisted?.meta ?? {}, "requests"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(persisted?.meta ?? {}, "latestRequest"), false);
  reader.close();
});

test("keeps consecutive assistant messages separate without persisting the merged transport request", () => {
  const memoryRoot = makeTempDir("runtime-request-assistant-merge-separation");
  const { runtime } = makeEnv(memoryRoot);
  const transcriptMessages = [
    { role: "assistant" as const, content: "first" },
    { role: "assistant" as const, content: "second" }
  ];
  const transportMessages = [{ role: "assistant" as const, content: "first\nsecond" }];

  runtime.noteLLMRequest(chatRequest(1, transportMessages), "chat", transcriptMessages);

  const id = currentSessionId(runtime);
  const reader = createLLMSessionStore(dbPathFor(memoryRoot));
  const persisted = reader.read(String(id));
  assert.deepEqual(persisted?.messages, transcriptMessages);
  assert.equal(Object.prototype.hasOwnProperty.call(persisted?.meta ?? {}, "requests"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(persisted?.meta ?? {}, "latestRequest"), false);
  reader.close();
});

test("rejects divergence in the authoritative request transcript", () => {
  const memoryRoot = makeTempDir("runtime-request-authoritative-divergence");
  const { runtime } = makeEnv(memoryRoot);
  noteRequest(runtime, 1, [{ role: "user", content: "original" }]);

  assert.throws(() => runtime.noteLLMRequest(
    chatRequest(2, [{ role: "user", content: "transport" }]),
    "chat",
    [{ role: "user", content: "replaced" }]
  ), /llm current session transcript divergence/);
});

test("rejects a non-append chat transcript without overwriting storage", () => {
  const memoryRoot = makeTempDir("runtime-non-append-reject");
  const { runtime } = makeEnv(memoryRoot);
  noteRequest(runtime, 1, [{ role: "user", content: "hello" }]);
  const id = currentSessionId(runtime);
  assert.throws(() => runtime.updateCurrentLLMSessionTranscript({
    messages: [{ role: "user", content: "completely different history" }],
    staticPromptFingerprint: "sha256:other",
    requestTimestamps: []
  } as any), "a non-append chat transcript must throw instead of overwriting storage");
  const reader = createLLMSessionStore(dbPathFor(memoryRoot));
  const persisted = reader.read(String(id));
  assert.deepEqual(persisted?.messages.map((message: any) => message.content), ["hello"], "storage must be untouched");
  reader.close();
  const snapshot = runtime.getCurrentLLMSessionSnapshot() as any;
  assert.equal(snapshot.messageCount, 1);
});

test("allows talk transcript replacement only through explicit replace", () => {
  const memoryRoot = makeTempDir("runtime-talk-replace");
  const time = fixedTime("2026-06-14T01:00:00.000Z");
  const archive = createLLMSessionArchive({
    memoryRoot,
    time,
    appendLog() {}
  });
  const runtime = createLLMSessionRuntime({
    time,
    archive,
    getConversationStartIndex: () => 0,
    buildTalkRuntimeMessages: () => [{ role: "user", content: "runtime rebuilt" }],
    appendLog() {},
    sessionClearCoordinator: fakeSessionClearCoordinator()
  });
  noteRequest(runtime, 1, [{ role: "user", content: "start" }], "talk", { agentId: "talk", id: 1 });
  const talkId = currentSessionId(runtime);
  // explicit talk transcript update replaces the whole transcript
  runtime.updateActiveTalkLLMSessionTranscript({
    id: talkId,
    messages: [{ role: "user", content: "rebuilt from runtime" }, { role: "assistant", content: "rebuilt answer" }],
    staticPromptFingerprint: "sha256:talk",
    requestTimestamps: []
  } as any);
  let reader = createLLMSessionStore(dbPathFor(memoryRoot));
  let persisted = reader.read(String(talkId));
  assert.deepEqual(persisted?.messages.map((message: any) => message.content), ["rebuilt from runtime", "rebuilt answer"]);
  reader.close();
  // non-append chat-style updates are still rejected
  assert.throws(() => runtime.updateCurrentLLMSessionTranscript({
    messages: [{ role: "user", content: "sneaky replacement" }]
  } as any));
  // rewriteActiveTalkLLMSessionFromRuntime is an explicit replace with a reason
  runtime.rewriteActiveTalkLLMSessionFromRuntime(talkId);
  reader = createLLMSessionStore(dbPathFor(memoryRoot));
  persisted = reader.read(String(talkId));
  assert.deepEqual(persisted?.messages.map((message: any) => message.content), ["runtime rebuilt"]);
  reader.close();
});

test("restores the last successful recovery point after restart", () => {
  const memoryRoot = makeTempDir("runtime-restart-recovery");
  const realStore = createLLMSessionStore(dbPathFor(memoryRoot));
  const { wrapped, fail } = failingStore(realStore);
  const { runtime } = makeEnv(memoryRoot, wrapped);
  noteRequest(runtime, 1, [{ role: "user", content: "hello" }]);
  runtime.noteLLMResponse({
    id: 2,
    agentId: "chat",
    sessionId: currentSessionId(runtime),
    requestId: 1,
    time: "2026-06-14T01:00:01.000",
    timeUtc: "2026-06-14T01:00:01.000Z",
    message: { role: "assistant", content: "done" },
    finishReason: "stop"
  } as any);
  const id = currentSessionId(runtime);
  // 模拟真实运行: agent-loop 在请求前提交带 staticPromptFingerprint 的完整 transcript,
  // restorePersistedActive 的恢复条件要求 fingerprint(与旧 JSONL 行为一致)。
  runtime.updateCurrentLLMSessionTranscript({
    id,
    messages: runtime.loadCurrentLLMSessionTranscript()?.messages ?? [],
    staticPromptFingerprint: "sha256:test",
    requestTimestamps: ["2026-06-14T01:00:00.000"]
  } as any);
  // the next write fails mid-run; the database stays at the last commit
  fail("append");
  const transcript = runtime.loadCurrentLLMSessionTranscript() as any;
  assert.throws(() => runtime.updateCurrentLLMSessionTranscript({
    ...transcript,
    messages: [...transcript.messages, { role: "user", content: "lost update" }]
  } as any));
  realStore.close();
  // simulate a process restart: fresh archive + runtime over the same memory root
  const restarted = makeEnv(memoryRoot);
  const restored = restarted.runtime.restorePersistedCurrentLLMSession();
  assert.ok(restored, "restart must restore the current session");
  assert.equal(restored.id, id);
  assert.deepEqual(restored.messages.map((message: any) => message.content), ["hello", "done"], "restart resumes at the last successful commit");
  const snapshot = restarted.runtime.getCurrentLLMSessionSnapshot() as any;
  assert.equal(snapshot.messageCount, 2);
});

test("deletes pointer only after clear metadata is committed", async () => {
  const memoryRoot = makeTempDir("runtime-clear-pointer");
  const realStore = createLLMSessionStore(dbPathFor(memoryRoot));
  const { wrapped, fail, heal } = failingStore(realStore);
  const { runtime } = makeEnv(memoryRoot, wrapped);
  noteRequest(runtime, 1, [{ role: "user", content: "hello" }]);
  const id = currentSessionId(runtime);
  fail("updateMeta", "replace");
  await assert.rejects(() => runtime.clearCurrentLLMSession("admin_clear"), /injected store failure/);
  assert.ok(fs.existsSync(pointerPath(memoryRoot)), "pointer must survive a failed clear commit");
  let reader = createLLMSessionStore(dbPathFor(memoryRoot));
  assert.equal((reader.read(String(id))?.meta as any).clearedAt, undefined, "clear meta must not be committed when the write fails");
  reader.close();
  heal();
  await runtime.clearCurrentLLMSession("admin_clear");
  assert.equal(fs.existsSync(pointerPath(memoryRoot)), false, "pointer is removed only after the clear metadata commit");
  reader = createLLMSessionStore(dbPathFor(memoryRoot));
  assert.equal((reader.read(String(id))?.meta as any).clearedAt, "2026-06-14T01:00:00.000");
  reader.close();
  assert.equal(runtime.getCurrentLLMSessionSnapshot(), undefined);
});

test("rewrites pointer after chat talk switch", () => {
  const memoryRoot = makeTempDir("runtime-pointer-switch");
  const { runtime } = makeEnv(memoryRoot);
  noteRequest(runtime, 1, [{ role: "user", content: "chat msg" }]);
  const chatPointer = readPointer(memoryRoot);
  assert.equal(chatPointer.agentType, "chat");
  assert.equal(typeof chatPointer.sessionId, "number");
  noteRequest(runtime, 2, [{ role: "user", content: "talk msg" }], "talk", { agentId: "talk", id: 2, time: "2026-06-14T01:00:01.000", timeUtc: "2026-06-14T01:00:01.000Z" });
  const talkPointer = readPointer(memoryRoot);
  assert.equal(talkPointer.agentType, "talk");
  assert.notEqual(talkPointer.sessionId, chatPointer.sessionId, "switching agents must create a new session");
  const reader = createLLMSessionStore(dbPathFor(memoryRoot));
  const chatSession = reader.read(String(chatPointer.sessionId));
  assert.deepEqual(chatSession?.messages.map((message: any) => message.content), ["chat msg"]);
  const talkSession = reader.read(String(talkPointer.sessionId));
  assert.deepEqual(talkSession?.messages.map((message: any) => message.content), ["talk msg"]);
  reader.close();
});
