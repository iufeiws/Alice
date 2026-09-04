import { test } from "node:test";
import assert from "node:assert/strict";
import { createLLMSessionArchive, createLLMSessionRuntime } from "../../../src/contexts/llm-session/src/index.js";
import { createLLMSessionStore } from "../../../src/contexts/llm-session/src/adapters/sqlite-llm-session-store.js";
import type { LLMSessionStore } from "../../../src/contexts/llm-session/src/adapters/sqlite-llm-session-store.js";
import {
  createSessionClearCoordinator
} from "../../../src/contexts/llm-session/src/application/session-clear-coordinator.js";
import type {
  SessionClearRequest,
  SessionClearResult
} from "../../../src/contexts/llm-session/src/application/session-clear-coordinator.js";
import type { LLMSessionClearReason } from "../../../src/contexts/llm-session/src/domain/llm-session.js";
import { fs, path, fixedTime, makeTempDir } from "../llm-gateway/llm-and-storage-helpers.js";

/**
 * Chat 链路集成测试（§12.4）:
 * - 每个 LLMSessionClearReason 都进入统一 clear 入口（当前共 9 个；
 *   `shutdown` 无生产调用点, 已从 clear reason 中移除）。
 * - active session 与无 current session 两种情形。
 * - Short Memory 未完成时会话不得提前清除（§10: 归档/pointer/内存 current 均保持）。
 * - clearedAt/metadata、pointer、内存 current 的提交顺序（§12.4）。
 * - 并发重复 clear 同一会话只执行一次真实清除（§11.2）。
 *
 * 契约（§7.1）:
 * - createLLMSessionRuntime 新增依赖 `sessionClearCoordinator`。
 * - clearCurrentLLMSession(reason: LLMSessionClearReason): Promise<SessionClearResult>。
 * - SessionClearResult = { cleared: boolean; shortMemoryCaptured: boolean }。
 */

const ALL_CLEAR_REASONS: LLMSessionClearReason[] = [
  "prompt_static_changed",
  "admin_clear",
  "admin_cancel",
  "mode_transition",
  "mode_timeout",
  "yield_end",
  "process_restart_recovery_failed",
  "force_wake",
  "force_clear"
];

const CAPTURED_ENTRY = {
  id: 1,
  createdAt: "2026-06-14T01:00:00.000",
  createdAtUtc: "2026-06-14T01:00:00.000Z",
  content: "记得明天买牛奶"
};

function dbPathFor(memoryRoot: string): string {
  return path.join(memoryRoot, "llm-sessions.sqlite");
}

function pointerPath(memoryRoot: string): string {
  return path.join(memoryRoot, "llm-sessions", "current.json");
}

/** 结构上等价于 §5.1 的 ShortMemoryWorker（块 1 提供真实类型）。 */
type FakeShortMemoryWorker = {
  captureBeforeSessionClear(): Promise<
    | { captured: false; reason: "missing" | "empty" | "symbols_only" }
    | { captured: true; entry: typeof CAPTURED_ENTRY }
  >;
};

function fakeWorker(): { worker: FakeShortMemoryWorker; callCount(): number } {
  let calls = 0;
  return {
    worker: {
      async captureBeforeSessionClear() {
        calls += 1;
        if (calls === 1) return { captured: true, entry: CAPTURED_ENTRY };
        // 文件已在首次采集后重置为仅换行, 重试只会看到空文件（§10）。
        return { captured: false, reason: "empty" };
      }
    },
    callCount: () => calls
  };
}

function gatedWorker(): { worker: FakeShortMemoryWorker; release(): void; callCount(): number } {
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    worker: {
      async captureBeforeSessionClear() {
        calls += 1;
        await gate;
        return { captured: true, entry: CAPTURED_ENTRY };
      }
    },
    release: () => release?.(),
    callCount: () => calls
  };
}

function makeEnv(
  memoryRoot: string,
  worker: FakeShortMemoryWorker,
  logLines: string[] = [],
  store?: LLMSessionStore
) {
  const time = fixedTime("2026-06-14T01:00:00.000Z");
  const archive = createLLMSessionArchive({
    memoryRoot,
    time,
    appendLog(level: string, message: string) {
      if (level === "warn") logLines.push(message);
    },
    store
  });
  const coordinator = createSessionClearCoordinator({
    shortMemoryWorker: worker,
    appendLog(level, message) {
      logLines.push(`${level}:${message}`);
    }
  });
  const runtime = createLLMSessionRuntime({
    time,
    archive,
    getConversationStartIndex: () => undefined,
    buildTalkRuntimeMessages: () => [],
    appendLog() {},
    // §7.1: llm-session runtime 的 clear 通过统一 SessionClearCoordinator 执行。
    sessionClearCoordinator: coordinator
  });
  return { archive, runtime, time };
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

function noteRequest(runtime: any, id: number, messages: any[]): void {
  runtime.noteLLMRequest(chatRequest(id, messages), "chat", messages);
}

function failingStore(real: LLMSessionStore) {
  const failed = new Set<string>();
  const fail = (...methods: string[]) => {
    for (const method of methods) failed.add(method);
  };
  const heal = () => {
    failed.clear();
  };
  const wrapped: LLMSessionStore = {
    create(session) {
      real.create(session);
    },
    read(sessionId) {
      return real.read(sessionId);
    },
    readMeta(sessionId) {
      return real.readMeta(sessionId);
    },
    append(input) {
      real.append(input);
    },
    updateMeta(input) {
      if (failed.has("updateMeta")) throw new Error("injected store failure: updateMeta");
      real.updateMeta(input);
    },
    replace(input) {
      if (failed.has("replace")) throw new Error("injected store failure: replace");
      real.replace(input);
    },
    list(input) {
      return real.list(input);
    },
    close() {
      real.close();
    }
  };
  return { wrapped, fail, heal };
}

/** 等一个宏任务边界, 让已入队的 promise 微任务先跑完。 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function withTimeout<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    })
  ]);
}

test("每个 LLMSessionClearReason 都进入统一 clear 入口并返回 SessionClearResult", async () => {
  for (const reason of ALL_CLEAR_REASONS) {
    const memoryRoot = makeTempDir(`runtime-clear-reason-${reason}`);
    const store = createLLMSessionStore(dbPathFor(memoryRoot));
    const logLines: string[] = [];
    const { worker, callCount } = fakeWorker();
    const { runtime } = makeEnv(memoryRoot, worker, logLines, store);
    noteRequest(runtime, 1, [{ role: "user", content: "hello" }]);
    const sessionId = (runtime.getCurrentLLMSessionSnapshot() as { id: number }).id;

    const result = await runtime.clearCurrentLLMSession(reason);

    assert.deepEqual(result, { cleared: true, shortMemoryCaptured: true }, `reason=${reason}`);
    assert.equal(callCount(), 1, `reason=${reason} 必须经过 worker 采集`);
    assert.ok(
      logLines.some((line) => line.includes(reason)),
      `reason=${reason} 必须出现在 coordinator 日志中`
    );
    assert.equal(
      logLines.some((line) => line.includes("记得明天买牛奶")),
      false,
      "日志不得记录 Short Memory 正文（§6.2）"
    );
    const reader = createLLMSessionStore(dbPathFor(memoryRoot));
    const meta = reader.read(String(sessionId))?.meta as any;
    assert.equal(meta.clearedAt, "2026-06-14T01:00:00.000", `reason=${reason} 必须提交 clearedAt`);
    assert.equal(meta.clearedAtUtc, "2026-06-14T01:00:00.000Z", `reason=${reason} 必须提交 clearedAtUtc`);
    assert.equal(meta.reason, reason, `reason=${reason} 必须写入持久化 reason`);
    reader.close();
    assert.equal(fs.existsSync(pointerPath(memoryRoot)), false, `reason=${reason} 后 pointer 必须删除`);
    assert.equal(runtime.getCurrentLLMSessionSnapshot(), undefined, `reason=${reason} 后内存 current 必须清空`);
    store.close();
  }
});

test("无 current session 时 clear 返回 cleared:false 且不采集", async () => {
  const memoryRoot = makeTempDir("runtime-clear-no-session");
  const { worker, callCount } = fakeWorker();
  const { runtime } = makeEnv(memoryRoot, worker);

  const result = await runtime.clearCurrentLLMSession("admin_clear");

  assert.deepEqual(result, { cleared: false, shortMemoryCaptured: false });
  assert.equal(callCount(), 0, "不存在会话时不得读取或修改宿主 Short Memory 文件（§3.2）");
  assert.equal(runtime.getCurrentLLMSessionSnapshot(), undefined);
});

test("Short Memory 采集未完成时会话不得提前清除", async () => {
  const memoryRoot = makeTempDir("runtime-clear-blocked");
  const store = createLLMSessionStore(dbPathFor(memoryRoot));
  const { worker, release, callCount } = gatedWorker();
  const { runtime } = makeEnv(memoryRoot, worker, [], store);
  noteRequest(runtime, 1, [{ role: "user", content: "hello" }]);
  const sessionId = (runtime.getCurrentLLMSessionSnapshot() as { id: number }).id;

  const pending = runtime.clearCurrentLLMSession("admin_clear");
  await flushMicrotasks();
  assert.equal(callCount(), 1, "worker 必须已开始采集");

  // 采集未完成: 归档未标记清除、pointer 未删、内存 current 未清（§10）。
  const reader = createLLMSessionStore(dbPathFor(memoryRoot));
  assert.equal((reader.read(String(sessionId))?.meta as any).clearedAt, undefined, "采集完成前不得提交 clearedAt");
  reader.close();
  assert.equal(fs.existsSync(pointerPath(memoryRoot)), true, "采集完成前不得删除 pointer");
  assert.ok(runtime.getCurrentLLMSessionSnapshot(), "采集完成前内存 current 必须保留");

  release();
  const result = await withTimeout(pending);
  assert.deepEqual(result, { cleared: true, shortMemoryCaptured: true });
  assert.equal(fs.existsSync(pointerPath(memoryRoot)), false, "采集完成后才允许清除 pointer");
  assert.equal(runtime.getCurrentLLMSessionSnapshot(), undefined);
});

test("clear 回调失败时错误传播, pointer/meta/内存 current 保持, 文件不恢复", async () => {
  const memoryRoot = makeTempDir("runtime-clear-callback-fail");
  const realStore = createLLMSessionStore(dbPathFor(memoryRoot));
  const { wrapped, fail, heal } = failingStore(realStore);
  const { worker, callCount } = fakeWorker();
  const { runtime } = makeEnv(memoryRoot, worker, [], wrapped);
  noteRequest(runtime, 1, [{ role: "user", content: "hello" }]);
  const sessionId = (runtime.getCurrentLLMSessionSnapshot() as { id: number }).id;

  // 采集成功(文件已被重置为 "\n"), 但会话自身 clear 回调(SQLite 写 meta)失败:
  // 错误必须向调用方传播, 会话保留, 文件不得恢复（§10）。
  fail("updateMeta", "replace");
  await assert.rejects(() => runtime.clearCurrentLLMSession("admin_clear"), /injected store failure/);
  assert.equal(callCount(), 1, "采集已执行一次");
  assert.equal(fs.existsSync(pointerPath(memoryRoot)), true, "clear 回调失败时 pointer 必须保留");
  let reader = createLLMSessionStore(dbPathFor(memoryRoot));
  assert.equal((reader.read(String(sessionId))?.meta as any).clearedAt, undefined, "clear 回调失败时不得提交 clearedAt");
  reader.close();
  assert.ok(runtime.getCurrentLLMSessionSnapshot(), "clear 回调失败时内存 current 必须保留");

  // 重试: 文件已被重置, 只看到空文件, 但会话可再次 clear。
  heal();
  const retry = await runtime.clearCurrentLLMSession("admin_clear");
  assert.deepEqual(retry, { cleared: true, shortMemoryCaptured: false }, "重试时同一份已重置内容不得再次保存（§10）");
  assert.equal(fs.existsSync(pointerPath(memoryRoot)), false);
  reader = createLLMSessionStore(dbPathFor(memoryRoot));
  assert.equal((reader.read(String(sessionId))?.meta as any).clearedAt, "2026-06-14T01:00:00.000");
  reader.close();
});

test("clear 提交顺序: metadata 先提交, pointer 后删除, 内存 current 最后清空", async () => {
  const memoryRoot = makeTempDir("runtime-clear-order");
  const store = createLLMSessionStore(dbPathFor(memoryRoot));
  const { worker } = fakeWorker();
  const { runtime } = makeEnv(memoryRoot, worker, [], store);
  noteRequest(runtime, 1, [{ role: "user", content: "hello" }]);
  const sessionId = (runtime.getCurrentLLMSessionSnapshot() as { id: number }).id;

  const realUpdateMeta = store.updateMeta.bind(store);
  store.updateMeta = ((input: any) => {
    // meta(clearedAt/reason)提交时 pointer 必须仍然存在: 先提交完整 meta, 再删除 pointer（§7.1）。
    assert.equal(fs.existsSync(pointerPath(memoryRoot)), true, "metadata 提交前不得删除 pointer");
    realUpdateMeta(input);
  }) as any;

  await runtime.clearCurrentLLMSession("admin_clear");

  assert.equal(fs.existsSync(pointerPath(memoryRoot)), false, "pointer 最终必须删除");
  const reader = createLLMSessionStore(dbPathFor(memoryRoot));
  assert.equal((reader.read(String(sessionId))?.meta as any).clearedAt, "2026-06-14T01:00:00.000");
  reader.close();
  assert.equal(runtime.getCurrentLLMSessionSnapshot(), undefined, "内存 current 最终必须清空");
});

test("runtime 以 kind=chat 的 SessionClearRequest 调用 coordinator", async () => {
  const memoryRoot = makeTempDir("runtime-clear-request-shape");
  const store = createLLMSessionStore(dbPathFor(memoryRoot));
  const time = fixedTime("2026-06-14T01:00:00.000Z");
  const archive = createLLMSessionArchive({ memoryRoot, time, appendLog() {}, store });
  const requests: SessionClearRequest[] = [];
  const fakeCoordinator = {
    async clearSession(request: SessionClearRequest): Promise<SessionClearResult> {
      requests.push(request);
      assert.equal(request.kind, "chat");
      assert.equal(request.reason, "mode_transition");
      assert.equal(request.exists(), true, "执行时 exists() 必须为 true");
      await request.clear();
      return { cleared: true, shortMemoryCaptured: false };
    }
  };
  const runtime = createLLMSessionRuntime({
    time,
    archive,
    getConversationStartIndex: () => undefined,
    buildTalkRuntimeMessages: () => [],
    appendLog() {},
    sessionClearCoordinator: fakeCoordinator as any
  });
  noteRequest(runtime, 1, [{ role: "user", content: "hello" }]);
  const sessionId = (runtime.getCurrentLLMSessionSnapshot() as { id: number }).id;

  const result = await runtime.clearCurrentLLMSession("mode_transition");

  assert.equal(requests.length, 1);
  assert.equal(String(requests[0].sessionId), String(sessionId));
  assert.deepEqual(result, { cleared: true, shortMemoryCaptured: false });
  // clear() 回调执行了原有清除逻辑: meta 提交 + pointer 删除 + 内存 current 清空。
  assert.equal(fs.existsSync(pointerPath(memoryRoot)), false);
  assert.equal(runtime.getCurrentLLMSessionSnapshot(), undefined);
  const reader = createLLMSessionStore(dbPathFor(memoryRoot));
  assert.equal((reader.read(String(sessionId))?.meta as any).reason, "mode_transition");
  reader.close();
});

test("并发重复 clear 同一会话只执行一次真实清除", async () => {
  const memoryRoot = makeTempDir("runtime-clear-concurrent");
  const store = createLLMSessionStore(dbPathFor(memoryRoot));
  const { worker, callCount } = fakeWorker();
  const { runtime } = makeEnv(memoryRoot, worker, [], store);
  noteRequest(runtime, 1, [{ role: "user", content: "hello" }]);

  const [first, second] = await Promise.all([
    runtime.clearCurrentLLMSession("admin_clear"),
    runtime.clearCurrentLLMSession("admin_cancel")
  ]);

  assert.deepEqual(first, { cleared: true, shortMemoryCaptured: true });
  assert.deepEqual(second, { cleared: false, shortMemoryCaptured: false }, "第二个请求观察到会话已不存在（§6.2）");
  assert.equal(callCount(), 1, "worker 必须最多被调用一次");
});
