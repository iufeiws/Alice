import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLLMSessionArchive,
  createLLMSessionRuntime,
  createApiSessionRuntime
} from "../../../src/contexts/llm-session/src/index.js";
import { createLLMSessionStore } from "../../../src/contexts/llm-session/src/adapters/sqlite-llm-session-store.js";
import type { LLMSessionStore, StoredLLMSession } from "../../../src/contexts/llm-session/src/adapters/sqlite-llm-session-store.js";
import { fs, path, fixedTime, makeTempDir } from "../llm-gateway/llm-and-storage-helpers.js";

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
    appendLog() {}
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

test("restores legacy jsonl metadata field names", () => {
  const memoryRoot = makeTempDir("runtime-legacy-meta");
  const store = createLLMSessionStore(dbPathFor(memoryRoot));
  // 旧 JSONL meta 使用 latestRequest/latestResponse/clearReason/modeStaticMessageCount,
  // 迁移后原样保留; 恢复时必须映射回新字段名, 不丢展示与模式状态。
  store.create(storedSession({
    sessionId: "100",
    agentType: "chat",
    meta: {
      type: "llm_session",
      agent: "chat",
      sessionId: 100,
      staticPromptFingerprint: "sha256:legacy",
      requestIds: [1],
      responseIds: [2],
      latestRequest: { round: 0, time: "2026-06-14T01:00:00.000", messageCount: 2 },
      latestResponse: { round: 0, time: "2026-06-14T01:00:05.000", finishReason: "stop" },
      clearReason: "admin_clear",
      mode: "fixed_prefix",
      modeStaticMessageCount: 2
    },
    messages: [
      { role: "system", content: "prefix" },
      { role: "user", content: "legacy" },
      { role: "assistant", content: "old answer" }
    ]
  }));
  store.close();
  writePointer(memoryRoot, { sessionId: 100, agentType: "chat" });
  const { runtime } = makeEnv(memoryRoot);
  const restored = runtime.restorePersistedCurrentLLMSession();
  assert.ok(restored, "legacy session must restore");
  assert.equal((restored.latestRequestInfo as any)?.round, 0, "latestRequest must map to latestRequestInfo");
  assert.equal((restored.latestResponseInfo as any)?.finishReason, "stop", "latestResponse must map to latestResponseInfo");
  assert.equal(restored.reason, "admin_clear", "clearReason must map to reason");
  assert.deepEqual((restored.modeStaticMessages ?? []).map((message: any) => message.content), ["prefix", "legacy"], "modeStaticMessageCount must rebuild modeStaticMessages");
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
  runtime.noteLLMRequest(chatRequest(1, [{ role: "user", content: "new" }]), "chat");
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
  runtime.noteLLMRequest(chatRequest(1, [{ role: "user", content: "hello" }]), "chat");
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
  runtime.noteLLMRequest(chatRequest(1, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" }
  ]), "chat");
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
  runtime.noteLLMRequest(chatRequest(1, [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" }
  ]), "chat");
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
  runtime.noteLLMRequest(chatRequest(1, [{ role: "user", content: "hello" }]), "chat");
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
  runtime.noteLLMRequest(chatRequest(1, [mSystem, mUser1]), "chat");
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
  runtime.noteLLMRequest(chatRequest(2, [mSystem, mUser1, mAssistant, mTool, mUser2]), "chat");
  reader = createLLMSessionStore(dbPathFor(memoryRoot));
  persisted = reader.read(String(id));
  assert.equal(persisted?.messages.length, 5);
  assert.deepEqual(persisted?.messages.map((message: any) => message.content), ["sys", "hello", "", "42", "thanks"]);
  assert.deepEqual(persisted?.meta.requestIds, [1, 2]);
  reader.close();
});

test("rejects a non-append chat transcript without overwriting storage", () => {
  const memoryRoot = makeTempDir("runtime-non-append-reject");
  const { runtime } = makeEnv(memoryRoot);
  runtime.noteLLMRequest(chatRequest(1, [{ role: "user", content: "hello" }]), "chat");
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
    appendLog() {}
  });
  runtime.noteLLMRequest(chatRequest(1, [{ role: "user", content: "start" }], { agentId: "talk", id: 1 }), "talk");
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
  runtime.noteLLMRequest(chatRequest(1, [{ role: "user", content: "hello" }]), "chat");
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

test("deletes pointer only after clear metadata is committed", () => {
  const memoryRoot = makeTempDir("runtime-clear-pointer");
  const realStore = createLLMSessionStore(dbPathFor(memoryRoot));
  const { wrapped, fail, heal } = failingStore(realStore);
  const { runtime } = makeEnv(memoryRoot, wrapped);
  runtime.noteLLMRequest(chatRequest(1, [{ role: "user", content: "hello" }]), "chat");
  const id = currentSessionId(runtime);
  fail("updateMeta", "replace");
  assert.throws(() => runtime.clearCurrentLLMSession("admin_clear"), /injected store failure/);
  assert.ok(fs.existsSync(pointerPath(memoryRoot)), "pointer must survive a failed clear commit");
  let reader = createLLMSessionStore(dbPathFor(memoryRoot));
  assert.equal((reader.read(String(id))?.meta as any).clearedAt, undefined, "clear meta must not be committed when the write fails");
  reader.close();
  heal();
  runtime.clearCurrentLLMSession("admin_clear");
  assert.equal(fs.existsSync(pointerPath(memoryRoot)), false, "pointer is removed only after the clear metadata commit");
  reader = createLLMSessionStore(dbPathFor(memoryRoot));
  assert.equal((reader.read(String(id))?.meta as any).clearedAt, "2026-06-14T01:00:00.000");
  reader.close();
  assert.equal(runtime.getCurrentLLMSessionSnapshot(), undefined);
});

test("rewrites pointer after chat talk switch", () => {
  const memoryRoot = makeTempDir("runtime-pointer-switch");
  const { runtime } = makeEnv(memoryRoot);
  runtime.noteLLMRequest(chatRequest(1, [{ role: "user", content: "chat msg" }]), "chat");
  const chatPointer = readPointer(memoryRoot);
  assert.equal(chatPointer.agentType, "chat");
  assert.equal(typeof chatPointer.sessionId, "number");
  runtime.noteLLMRequest(chatRequest(2, [{ role: "user", content: "talk msg" }], { agentId: "talk", id: 2, time: "2026-06-14T01:00:01.000", timeUtc: "2026-06-14T01:00:01.000Z" }), "talk");
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
