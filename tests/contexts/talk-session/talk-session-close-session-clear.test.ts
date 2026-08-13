import { test } from "node:test";
import assert from "node:assert/strict";
import { createTalkRuntime } from "../../../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { createTalkStore } from "../../../src/contexts/talk-session/src/adapters/sqlite-talk-session-store.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import {
  createSessionClearCoordinator
} from "../../../src/contexts/llm-session/src/application/session-clear-coordinator.js";
import type { SessionClearResult } from "../../../src/contexts/llm-session/src/application/session-clear-coordinator.js";
import type { MainAgentClearAcquisition } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import { makeTempDir, path, sessionInput } from "./talk-runtime-helpers.js";

/**
 * Talk 集成测试（§7.2 / §12.5）:
 * - 正常关闭采集成功: closeSession 返回 SessionClearResult, talk store 关闭, onSessionClosed 触发。
 * - Worker 阻塞期间 Talk 尚未关闭（§10）。
 * - Worker 失败时 talk store 未关闭、无 conversation projection(onSessionClosed 未触发)、状态不变。
 * - 成功后的采集 → Talk close → 投影/状态切换顺序。
 * - 重复 close 不重复采集。
 * - 占用生命周期(第三版阻塞契约): closeSession 调用后、coordinator clearSession 的
 *   Promise settle(成功或失败)之前, Main Agent clearing 占用必须保持持有; settle 后才
 *   release。release 后占用可再次获取(生命周期闭合)。
 *
 * 契约（§7.2）:
 * - createTalkRuntime 新增依赖 `sessionClearCoordinator`。
 * - closeSession(input: { sessionId: number; occurredAt?: string; occurredAtUtc?: string }):
 *   Promise<SessionClearResult>。
 * - 通话渠道收到关闭失败, 不得伪装为成功关闭（§7.2）。
 */

const CAPTURED_ENTRY = {
  id: 1,
  createdAt: "2026-06-07T00:00:00.000",
  createdAtUtc: "2026-06-06T15:00:00.000Z",
  content: "通话里说过的话"
};

type FakeShortMemoryWorker = {
  captureBeforeSessionClear(): Promise<
    | { captured: false; reason: "missing" | "empty" | "symbols_only" }
    | { captured: true; entry: typeof CAPTURED_ENTRY }
  >;
};

function fakeWorker(overrides: { failOnce?: boolean } = {}): {
  worker: FakeShortMemoryWorker;
  callCount(): number;
} {
  let calls = 0;
  return {
    worker: {
      async captureBeforeSessionClear() {
        calls += 1;
        if (overrides.failOnce && calls === 1) throw new Error("capture failed");
        return { captured: true, entry: CAPTURED_ENTRY };
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

/**
 * 真实语义的 fake acquireMainAgentClear(第三版占用生命周期契约):
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
      const token = `talk-acquire-${seq}`;
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

function createTestEnv(
  worker: FakeShortMemoryWorker,
  options: {
    onSessionClosed?: (sessionId: number) => void;
    onSessionOpened?: (sessionId: number) => void;
    order?: string[];
    acquireMainAgentClear?: (input: { kind: "chat" | "talk" | "memorize"; sessionId: string }) => MainAgentClearAcquisition;
  } = {}
) {
  const store = createTalkStore(path.join(makeTempDir("talk-close-clear"), "talk.sqlite"));
  const time = createCurrentTimeProvider("Asia/Tokyo", () => new Date("2026-06-06T15:00:00.000Z"));
  const coordinator = createSessionClearCoordinator({
    shortMemoryWorker: worker,
    appendLog() {}
  });
  const closed: number[] = [];
  const opened: number[] = [];
  const runtime = createTalkRuntime({
    store,
    time,
    sessionClearCoordinator: coordinator,
    acquireMainAgentClear: options.acquireMainAgentClear ?? (() => ({ acquired: true, token: "test-clear", release() {} })),
    rewriteActiveTalkLLMSessionFromRuntime() {},
    clearActiveTalkLLMSession() {},
    onSessionClosed(sessionId) {
      options.order?.push("project_and_waiting");
      closed.push(sessionId);
      options.onSessionClosed?.(sessionId);
    },
    onSessionOpened(sessionId) {
      opened.push(sessionId);
      options.onSessionOpened?.(sessionId);
    }
  });
  return { runtime, store, closed, opened };
}

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

test("Talk 正常关闭采集成功并返回 SessionClearResult", async () => {
  const { worker, callCount } = fakeWorker();
  const { runtime, store, closed, opened } = createTestEnv(worker);
  runtime.openSession(sessionInput(1780830000201));
  assert.deepEqual(opened, [1780830000201]);

  const result = await runtime.closeSession({
    sessionId: 1780830000201,
    occurredAt: "2026-06-07T00:00:05.000",
    occurredAtUtc: "2026-06-06T15:00:05.000Z"
  });

  assert.deepEqual(result, { cleared: true, shortMemoryCaptured: true });
  assert.equal(callCount(), 1, "正常关闭必须经过 Short Memory 采集");
  assert.equal(store.getSession(1780830000201)?.status, "closed", "采集成功后 talk session 才关闭");
  assert.equal(store.getSession(1780830000201)?.endedAt, "2026-06-07T00:00:05.000", "occurredAt 必须透传");
  assert.deepEqual(closed, [1780830000201], "关闭后必须触发投影/状态切换回调");
});

test("Worker 阻塞期间 Talk session 尚未关闭", async () => {
  const { worker, release, callCount } = gatedWorker();
  const { runtime, store, closed } = createTestEnv(worker);
  runtime.openSession(sessionInput(1780830000202));

  const pending = runtime.closeSession({ sessionId: 1780830000202 });
  await flushMicrotasks();
  assert.equal(callCount(), 1, "worker 必须已开始采集");
  assert.equal(store.getSession(1780830000202)?.status, "open", "采集完成前 talk session 必须保持打开（§10）");
  assert.deepEqual(closed, [], "采集完成前不得投影、不得切换到 waiting");

  release();
  const result = await withTimeout(pending);
  assert.deepEqual(result, { cleared: true, shortMemoryCaptured: true });
  assert.equal(store.getSession(1780830000202)?.status, "closed");
  assert.deepEqual(closed, [1780830000202]);
});

test("Worker 失败时 talk store 未关闭、无投影、状态不变", async () => {
  const { worker, callCount } = fakeWorker({ failOnce: true });
  const { runtime, store, closed } = createTestEnv(worker);
  runtime.openSession(sessionInput(1780830000203));

  await assert.rejects(
    () => runtime.closeSession({ sessionId: 1780830000203 }),
    /capture failed/,
    "Short Memory 失败必须向通话渠道传播, 不得伪装为成功关闭（§7.2）"
  );
  assert.equal(callCount(), 1);
  assert.equal(store.getSession(1780830000203)?.status, "open", "失败时 talk session 必须保持打开");
  assert.deepEqual(closed, [], "失败时不得有 conversation projection / 状态切换");
});

test("成功后顺序: 采集 → Talk close → 投影与状态切换", async () => {
  const order: string[] = [];
  const store = createTalkStore(path.join(makeTempDir("talk-close-order"), "talk.sqlite"));
  const time = createCurrentTimeProvider("Asia/Tokyo", () => new Date("2026-06-06T15:00:00.000Z"));
  const { worker } = fakeWorker();
  const realCloseSession = store.closeSession.bind(store);
  store.closeSession = ((input: any) => {
    order.push("talk_close");
    realCloseSession(input);
  }) as any;
  const coordinator = createSessionClearCoordinator({
    shortMemoryWorker: {
      async captureBeforeSessionClear() {
        order.push("capture");
        return worker.captureBeforeSessionClear();
      }
    },
    appendLog() {}
  });
  const runtime = createTalkRuntime({
    store,
    time,
    sessionClearCoordinator: coordinator,
    acquireMainAgentClear: () => ({ acquired: true, token: "test-clear", release() {} }),
    rewriteActiveTalkLLMSessionFromRuntime() {},
    clearActiveTalkLLMSession() {},
    onSessionClosed() {
      order.push("project_and_waiting");
    }
  });
  runtime.openSession(sessionInput(1780830000204));

  await runtime.closeSession({ sessionId: 1780830000204 });

  assert.deepEqual(order, ["capture", "talk_close", "project_and_waiting"], "采集必须先完成, 再关闭 talk, 最后投影/切换状态");
});

test("重复 close 同一会话不重复采集", async () => {
  const { worker, callCount } = fakeWorker();
  const { runtime, store } = createTestEnv(worker);
  runtime.openSession(sessionInput(1780830000205));

  const first = await runtime.closeSession({ sessionId: 1780830000205 });
  assert.deepEqual(first, { cleared: true, shortMemoryCaptured: true });

  const second = await runtime.closeSession({ sessionId: 1780830000205 });
  assert.deepEqual(second, { cleared: false, shortMemoryCaptured: false }, "已关闭会话不视为真实会话清除（§3.2）");
  assert.equal(callCount(), 1, "重复 close 不得再次采集");
  assert.equal(store.getSession(1780830000205)?.status, "closed");
});

test("不存在的 Talk session 返回 cleared:false 且不采集", async () => {
  const { worker, callCount } = fakeWorker();
  const { runtime } = createTestEnv(worker);

  const result = await runtime.closeSession({ sessionId: 1780830000999 });

  assert.deepEqual(result, { cleared: false, shortMemoryCaptured: false });
  assert.equal(callCount(), 0, "不存在的会话不得读取或修改 Short Memory");
});

test("closeSession 返回类型为 Promise<SessionClearResult>", async () => {
  const { worker } = fakeWorker();
  const { runtime } = createTestEnv(worker);
  runtime.openSession(sessionInput(1780830000206));

  const returned = runtime.closeSession({ sessionId: 1780830000206 });
  assert.equal(typeof (returned as unknown as Promise<unknown>)?.then, "function", "closeSession 必须返回 Promise");
  const result: SessionClearResult = await returned;
  assert.deepEqual(result, { cleared: true, shortMemoryCaptured: true });
});

test("closeSession 占用生命周期: clearSession settle 前占用保持持有, 成功后释放(第三版阻塞契约)", async () => {
  const { worker, release, callCount } = gatedWorker();
  const { spy, acquireMainAgentClear } = createAcquireSpy();
  const { runtime, store } = createTestEnv(worker, { acquireMainAgentClear });
  runtime.openSession(sessionInput(1780830000207));

  const pending = runtime.closeSession({ sessionId: 1780830000207 });
  // 断言 a(阻塞项): closeSession 返回瞬间(Promise pending)release 不得调用——
  // 占用必须保持持有到 clearSession settle。当前实现为 `return promise` + finally,
  // finally 在 return 时同步执行(acquire 后立即 release) → 此处红。
  assert.deepEqual(spy.events, ["acquire"], "closeSession 返回瞬间必须已获取占用且未释放(先占用、后清除)");
  assert.equal(spy.releasedCount(), 0, "clearSession settle 前不得释放占用(当前实现同步 release → 红)");
  assert.equal(store.getSession(1780830000207)?.status, "open", "采集期间 talk session 必须保持打开(§10)");

  await flushMicrotasks();
  assert.equal(callCount(), 1, "coordinator 采集必须已启动");
  assert.equal(spy.releasedCount(), 0, "采集进行中占用仍必须保持持有");

  release();
  const result = await withTimeout(pending);
  assert.deepEqual(result, { cleared: true, shortMemoryCaptured: true });
  // 断言 b: settle 成功后才 release, 且恰好一次。
  assert.deepEqual(spy.events, ["acquire", "release"], "settle 成功后才释放占用");
  assert.equal(spy.releasedCount(), 1, "release 必须恰好一次");

  // 断言 d: 释放后 acquire 可再次成功(生命周期闭合)。
  const again = spy.acquire({ kind: "talk", sessionId: "1780830000207" });
  assert.ok(again.acquired, "释放后占用可再次获取");
  again.release();
});

test("closeSession 占用生命周期: clearSession 失败(reject)时同样释放占用", async () => {
  const { worker } = fakeWorker({ failOnce: true });
  const { spy, acquireMainAgentClear } = createAcquireSpy();
  const { runtime, store } = createTestEnv(worker, { acquireMainAgentClear });
  runtime.openSession(sessionInput(1780830000208));

  await assert.rejects(() => runtime.closeSession({ sessionId: 1780830000208 }), /capture failed/);
  // 断言 c: settle 失败后也必须 release(§10: 失败阻止后续 loop)。
  assert.deepEqual(spy.events, ["acquire", "release"], "clearSession 失败后必须释放占用");
  assert.equal(spy.releasedCount(), 1, "release 必须恰好一次");
  assert.equal(store.getSession(1780830000208)?.status, "open", "失败时 talk session 保持打开(§10)");

  // 断言 d: 释放后 acquire 可再次成功(生命周期闭合)。
  const again = spy.acquire({ kind: "talk", sessionId: "1780830000208" });
  assert.ok(again.acquired, "释放后占用可再次获取");
  again.release();
});

test("Main Agent 已占用时 closeSession 拒绝: 同步抛错且不调用 release(§10)", async () => {
  const { worker, callCount } = fakeWorker();
  const { spy, acquireMainAgentClear } = createAcquireSpy({ rejectAcquire: true });
  const { runtime, store } = createTestEnv(worker, { acquireMainAgentClear });
  runtime.openSession(sessionInput(1780830000209));

  assert.throws(
    () => runtime.closeSession({ sessionId: 1780830000209 }),
    /main agent busy/,
    "已占用时拒绝关闭并抛错, 不得静默降级为无占用清除(通话渠道必须收到关闭失败)"
  );
  assert.equal(spy.releasedCount(), 0, "获取被拒时不得调用 release");
  assert.equal(callCount(), 0, "获取被拒时不得进入清除");
  assert.equal(store.getSession(1780830000209)?.status, "open", "拒绝时 talk session 保持打开");
});
