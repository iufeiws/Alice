import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createMemoryConsoleRuntime } from "../../../src/contexts/memory/src/memory-console-runtime.js";
import type { MemoryInductionSession } from "../../../src/contexts/memory/src/model.js";
import {
  createSessionClearCoordinator
} from "../../../src/contexts/llm-session/src/application/session-clear-coordinator.js";
import type { MainAgentClearAcquisition } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { makeTempDir } from "./sleep-memory-helpers.js";

/**
 * Memorize 集成测试（§7.3 / §12.6）:
 * - Memory console 手工 clear。
 * - 无 session clear 不采集。
 * - Worker 失败时 clearedAt、activeTarget、内存引用不变。
 * - 成功后写 final messages 并释放引用。
 *
 * 契约（§7.3）:
 * - createMemoryConsoleRuntime 新增依赖 `sessionClearCoordinator`。
 * - clearSession(reason?: string): Promise<SessionClearResult>。
 * - 现有 clearMemoryInductionSession 中设置 clearedAt、clearReason、清理 activeTarget、
 *   写 final_messages 以及释放内存 session 引用的逻辑进入 coordinator 的 clear() 回调。
 *
 * 第四版 P2 契约(占用时机, 仿 talk-session-close-session-clear.test.ts 的
 * createAcquireSpy; 当前实现已满足, 应绿):
 * - clearSession 先获取 Main Agent clearing 占用(kind memorize)再进入清除,
 *   coordinator clearSession settle(成功或失败)后才 release, release 恰好一次;
 * - acquire 被拒时同步抛错且不调用 release、不进入清除;
 * - release 后占用可再次获取(生命周期闭合)。
 */

const CAPTURED_ENTRY = {
  id: 1,
  createdAt: "2026-06-07T00:00:00.000",
  createdAtUtc: "2026-06-06T15:00:00.000Z",
  content: "归纳中的备忘"
};

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
        return { captured: true, entry: CAPTURED_ENTRY };
      }
    },
    callCount: () => calls
  };
}

/** Worker 挂起直到 release(): 用于断言 settle 前的占用持有。 */
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

/**
 * 真实语义的 fake acquireMainAgentClear(第四版 P2 占用时机契约, 仿
 * talk-session-close-session-clear.test.ts):
 * - acquire 返回带唯一 token 的句柄并记录事件; release 记录事件(时机可断言)。
 * - rejectAcquire 模式下 acquire 返回 { acquired: false }(模拟 Main Agent 已被占用)。
 */
function createAcquireSpy(options: { rejectAcquire?: boolean } = {}): {
  spy: {
    events: Array<"acquire" | "release">;
    acquiredCount(): number;
    releasedCount(): number;
    acquire(input: { kind: "chat" | "talk" | "memorize"; sessionId: string }): MainAgentClearAcquisition;
  };
  acquireMainAgentClear(input: { kind: "chat" | "talk" | "memorize"; sessionId: string }): MainAgentClearAcquisition;
} {
  const events: Array<"acquire" | "release"> = [];
  let seq = 0;
  const spy = {
    events,
    acquiredCount: () => events.filter((event) => event === "acquire").length,
    releasedCount: () => events.filter((event) => event === "release").length,
    acquire(input: { kind: "chat" | "talk" | "memorize"; sessionId: string }): MainAgentClearAcquisition {
      events.push("acquire");
      seq += 1;
      const token = `memory-acquire-${seq}`;
      return { acquired: true, token, release: () => events.push("release") };
    }
  };
  return {
    spy,
    acquireMainAgentClear(input) {
      if (options.rejectAcquire) return { acquired: false };
      return spy.acquire(input);
    }
  };
}

function createConsole(
  worker: FakeShortMemoryWorker,
  options: {
    acquireMainAgentClear?(input: { kind: "chat" | "talk" | "memorize"; sessionId: string }): MainAgentClearAcquisition;
  } = {}
) {
  const root = makeTempDir("memory-console-clear");
  const time = createCurrentTimeProvider("Asia/Tokyo", () => new Date("2026-06-06T15:00:00.000Z"));
  const coordinator = createSessionClearCoordinator({
    shortMemoryWorker: worker,
    appendLog() {}
  });
  const consoleRuntime = createMemoryConsoleRuntime({
    sessionRoot: () => path.join(root, "llm-sessions"),
    time,
    sessionClearCoordinator: coordinator,
    acquireMainAgentClear: options.acquireMainAgentClear ?? (() => ({ acquired: true, token: "test-clear", release() {} }))
  });
  return { consoleRuntime, time, root };
}

/** 包一层 append 记录写入的条目。 */
function spyAppend(session: MemoryInductionSession): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  const originalAppend = session.append;
  if (originalAppend) {
    session.append = (entry) => {
      entries.push(entry as Record<string, unknown>);
      originalAppend(entry);
    };
  }
  return entries;
}

test("Memory console 手工 clear 成功并返回 SessionClearResult", async () => {
  const { worker, callCount } = fakeWorker();
  const { consoleRuntime } = createConsole(worker);
  const session = consoleRuntime.ensureSession("2026-06-07T06:00:00.000", "2026-06-06T22:00:00.000");
  session.activeTarget = "persistent";

  const result = await consoleRuntime.clearSession("admin_clear");

  assert.deepEqual(result, { cleared: true, shortMemoryCaptured: true });
  assert.equal(callCount(), 1, "真实会话清除必须经过 Short Memory 采集");
  assert.equal(session.clearedAt, "2026-06-07T00:00:00.000", "clearedAt 必须写入");
  assert.equal(session.clearReason, "admin_clear");
  assert.equal(session.activeTarget, undefined, "clear 后 activeTarget 必须清理");
});

test("无 session 时 clearSession 不采集并返回 cleared:false", async () => {
  const { worker, callCount } = fakeWorker();
  const { consoleRuntime } = createConsole(worker);

  const result = await consoleRuntime.clearSession("admin_clear");

  assert.deepEqual(result, { cleared: false, shortMemoryCaptured: false });
  assert.equal(callCount(), 0, "无 session 时不得读取或修改宿主 Short Memory 文件（§3.2）");
});

test("Worker 失败时 clearedAt、activeTarget、内存引用不变", async () => {
  let calls = 0;
  const worker: FakeShortMemoryWorker = {
    async captureBeforeSessionClear() {
      calls += 1;
      throw new Error("capture failed");
    }
  };
  const { consoleRuntime } = createConsole(worker);
  const session = consoleRuntime.ensureSession("2026-06-07T06:00:00.000", "2026-06-06T22:00:00.000");
  session.activeTarget = "userPreferences";

  await assert.rejects(() => consoleRuntime.clearSession("admin_clear"), /capture failed/);

  assert.equal(calls, 1);
  assert.equal(session.clearedAt, undefined, "失败时不得设置 clearedAt");
  assert.equal(session.clearReason, undefined, "失败时不得设置 clearReason");
  assert.equal(session.activeTarget, "userPreferences", "失败时 activeTarget 必须保留");
  assert.equal(
    consoleRuntime.ensureSession("2026-06-07T06:00:00.000", "2026-06-06T22:00:00.000"),
    session,
    "失败时内存 session 引用必须保留"
  );
});

test("成功后写 final messages 并释放引用", async () => {
  const { worker } = fakeWorker();
  const { consoleRuntime } = createConsole(worker);
  const session = consoleRuntime.ensureSession("2026-06-07T06:00:00.000", "2026-06-06T22:00:00.000");
  session.messages = [{ role: "assistant", content: "归纳结论" }];
  session.activeTarget = "persistent";
  const entries = spyAppend(session);

  await consoleRuntime.clearSession();

  const finalEntry = entries.find((entry) => entry.type === "final_messages");
  assert.ok(finalEntry, "clear 后必须写 final_messages");
  assert.deepEqual(finalEntry?.messages, session.messages, "final_messages 内容必须与 session 消息一致");
  assert.equal(session.clearedAt, "2026-06-07T00:00:00.000");

  const next = consoleRuntime.ensureSession("2026-06-08T06:00:00.000", "2026-06-07T22:00:00.000");
  assert.notEqual(next, session, "clear 后必须释放内存 session 引用");
  assert.equal(next.clearedAt, undefined, "新 session 必须是全新对象");
  assert.equal(next.completedTargets.length, 0);
});

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

test("clearSession 占用生命周期(第四版 P2): acquire 先于 clear, coordinator settle 前占用保持持有, 成功后 release 恰好一次", async () => {
  const { worker, release, callCount } = gatedWorker();
  const { spy, acquireMainAgentClear } = createAcquireSpy();
  const { consoleRuntime } = createConsole(worker, { acquireMainAgentClear });
  const session = consoleRuntime.ensureSession("2026-06-07T06:00:00.000", "2026-06-06T22:00:00.000");

  const pending = consoleRuntime.clearSession("admin_clear");
  // 先占用、后清除: clearSession 返回瞬间 acquire 已发生且未 release, clear 本体尚未启动。
  assert.deepEqual(spy.events, ["acquire"], "clearSession 返回瞬间必须已获取占用且未释放(先占用、后清除)");
  assert.equal(spy.releasedCount(), 0, "coordinator settle 前不得释放占用");
  assert.equal(callCount(), 0, "acquire 必须先于 clear 本体(coordinator 未启动采集)");

  await flushMicrotasks();
  assert.equal(callCount(), 1, "coordinator 采集必须已启动");
  assert.equal(spy.releasedCount(), 0, "采集进行中占用仍必须保持持有");
  assert.equal(session.clearedAt, undefined, "settle 前会话不得标记清除");

  release();
  const result = await withTimeout(pending);
  assert.deepEqual(result, { cleared: true, shortMemoryCaptured: true });
  assert.deepEqual(spy.events, ["acquire", "release"], "settle 成功后才释放占用, 且恰好一次");
  assert.equal(spy.releasedCount(), 1, "release 必须恰好一次");

  // 生命周期闭合: 释放后占用可再次获取。
  const again = spy.acquire({ kind: "memorize", sessionId: "console" });
  assert.ok(again.acquired, "释放后占用可再次获取");
  again.release();
});

test("clearSession 占用生命周期(第四版 P2): clearSession 失败时同样释放占用", async () => {
  let calls = 0;
  const worker: FakeShortMemoryWorker = {
    async captureBeforeSessionClear() {
      calls += 1;
      throw new Error("capture failed");
    }
  };
  const { spy, acquireMainAgentClear } = createAcquireSpy();
  const { consoleRuntime } = createConsole(worker, { acquireMainAgentClear });
  consoleRuntime.ensureSession("2026-06-07T06:00:00.000", "2026-06-06T22:00:00.000");

  await assert.rejects(() => consoleRuntime.clearSession("admin_clear"), /capture failed/);
  assert.deepEqual(spy.events, ["acquire", "release"], "clearSession 失败后必须释放占用(§10: 失败阻止后续 loop)");
  assert.equal(spy.releasedCount(), 1, "release 必须恰好一次");

  // 生命周期闭合: 释放后占用可再次获取。
  const again = spy.acquire({ kind: "memorize", sessionId: "console" });
  assert.ok(again.acquired, "释放后占用可再次获取");
  again.release();
});

test("Main Agent 已占用时 clearSession 拒绝(第四版 P2): 抛错且不调用 release、不进入清除", async () => {
  const { worker, callCount } = fakeWorker();
  const { spy, acquireMainAgentClear } = createAcquireSpy({ rejectAcquire: true });
  const { consoleRuntime } = createConsole(worker, { acquireMainAgentClear });
  consoleRuntime.ensureSession("2026-06-07T06:00:00.000", "2026-06-06T22:00:00.000");

  await assert.rejects(
    () => consoleRuntime.clearSession("admin_clear"),
    /main agent busy/,
    "已占用时拒绝清除并抛错, 不得静默降级为无占用清除(§10)"
  );
  assert.equal(spy.releasedCount(), 0, "获取被拒时不得调用 release");
  assert.equal(callCount(), 0, "获取被拒时不得进入清除(coordinator 不启动)");
});
