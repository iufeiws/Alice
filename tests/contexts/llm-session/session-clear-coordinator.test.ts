import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionClearCoordinator } from "../../../src/contexts/llm-session/src/application/session-clear-coordinator.js";
import type { ClearableSessionKind, SessionClearRequest } from "../../../src/contexts/llm-session/src/application/session-clear-coordinator.js";
import type { ShortMemoryCaptureResult, ShortMemoryWorker } from "../../../src/contexts/memory/src/short-memory-worker.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function logRecorder(): {
  appendLog: (level: "info" | "warn" | "error", message: string) => void;
  entries: Array<{ level: "info" | "warn" | "error"; message: string }>;
} {
  const entries: Array<{ level: "info" | "warn" | "error"; message: string }> = [];
  return {
    appendLog(level, message) {
      entries.push({ level, message });
    },
    entries
  };
}

// §12.3-1 exists() === false 不调用 Worker 和 clear 回调
test("clearSession returns cleared:false without touching the worker when the session does not exist", async () => {
  let workerCalls = 0;
  const worker: ShortMemoryWorker = {
    async captureBeforeSessionClear() {
      workerCalls += 1;
      return { captured: false, reason: "empty" };
    }
  };
  let clearCalls = 0;
  let existsCalls = 0;
  const coordinator = createSessionClearCoordinator({ shortMemoryWorker: worker, appendLog: () => {} });
  const result = await coordinator.clearSession({
    kind: "chat",
    sessionId: "s-none",
    reason: "admin_clear",
    exists() {
      existsCalls += 1;
      return false;
    },
    async clear() {
      clearCalls += 1;
    }
  });
  assert.deepEqual(result, { cleared: false, shortMemoryCaptured: false });
  assert.equal(workerCalls, 0, "exists() === false 时不得调用 Worker");
  assert.equal(clearCalls, 0, "exists() === false 时不得调用 clear 回调");
  assert.equal(existsCalls, 1);
});

// §12.3-2 Worker 成功后才调用 clear
test("clearSession calls the clear callback only after the worker succeeds", async () => {
  const gate = deferred<ShortMemoryCaptureResult>();
  const events: string[] = [];
  const worker: ShortMemoryWorker = {
    async captureBeforeSessionClear() {
      events.push("worker");
      return gate.promise;
    }
  };
  const clears: string[] = [];
  const logs = logRecorder();
  const coordinator = createSessionClearCoordinator({ shortMemoryWorker: worker, appendLog: logs.appendLog });
  const content = "秘密记忆正文";
  const entry = { id: 1, createdAt: "2026-08-13T14:30:00.000", createdAtUtc: "2026-08-13T06:30:00.000Z", content };
  const pending = coordinator.clearSession({
    kind: "chat",
    sessionId: "s1",
    reason: "admin_clear",
    exists: () => true,
    async clear() {
      events.push("clear");
      clears.push("s1");
    }
  });
  await waitFor(() => events.includes("worker"));
  assert.deepEqual(events, ["worker"], "worker 未完成前不得调用 clear");
  assert.deepEqual(clears, []);
  gate.resolve({ captured: true, entry });
  const result = await pending;
  assert.deepEqual(result, { cleared: true, shortMemoryCaptured: true });
  assert.deepEqual(events, ["worker", "clear"]);
  assert.deepEqual(clears, ["s1"]);
  // 日志不得记录 Short Memory 正文，只记录 kind/sessionId/reason/是否捕获
  assert.ok(logs.entries.length > 0, "必须记录日志");
  for (const log of logs.entries) {
    assert.ok(!log.message.includes(content), "日志不得记录 Short Memory 正文");
  }
  assert.ok(
    logs.entries.some((log) => log.message.includes("chat") && log.message.includes("s1")),
    "日志必须记录 kind 与 sessionId"
  );
});

// §12.3-3 Worker 失败时不调用 clear
test("clearSession propagates worker failures and never calls the clear callback", async () => {
  let workerCalls = 0;
  let clearCalls = 0;
  const worker: ShortMemoryWorker = {
    async captureBeforeSessionClear() {
      workerCalls += 1;
      throw new Error("worker-boom");
    }
  };
  const coordinator = createSessionClearCoordinator({ shortMemoryWorker: worker, appendLog: () => {} });
  await assert.rejects(
    coordinator.clearSession({
      kind: "talk",
      sessionId: "s1",
      reason: "close",
      exists: () => true,
      clear: () => {
        clearCalls += 1;
      }
    }),
    /worker-boom/
  );
  assert.equal(clearCalls, 0, "worker 失败时不得调用 clear");
  assert.equal(workerCalls, 1);
});

// §12.3-4 clear 回调失败时错误传播
test("clearSession propagates clear callback failures", async () => {
  const worker: ShortMemoryWorker = {
    async captureBeforeSessionClear() {
      return { captured: false, reason: "empty" };
    }
  };
  const coordinator = createSessionClearCoordinator({ shortMemoryWorker: worker, appendLog: () => {} });
  await assert.rejects(
    coordinator.clearSession({
      kind: "chat",
      sessionId: "s1",
      reason: "admin_clear",
      exists: () => true,
      async clear() {
        throw new Error("clear-boom");
      }
    }),
    /clear-boom/
  );
});

// §12.3-5 Chat、Talk、Memorize 三种 kind
test("clearSession handles chat, talk and memorize kinds", async () => {
  const clearedKinds: ClearableSessionKind[] = [];
  const worker: ShortMemoryWorker = {
    async captureBeforeSessionClear() {
      return {
        captured: true,
        entry: { id: 1, createdAt: "2026-08-13T14:30:00.000", createdAtUtc: "2026-08-13T06:30:00.000Z", content: "x" }
      };
    }
  };
  const coordinator = createSessionClearCoordinator({ shortMemoryWorker: worker, appendLog: () => {} });
  for (const kind of ["chat", "talk", "memorize"] as ClearableSessionKind[]) {
    const result = await coordinator.clearSession({
      kind,
      sessionId: `session-${kind}`,
      reason: "test",
      exists: () => true,
      clear: () => {
        clearedKinds.push(kind);
      }
    });
    assert.deepEqual(result, { cleared: true, shortMemoryCaptured: true }, `kind=${kind}`);
  }
  assert.deepEqual(clearedKinds, ["chat", "talk", "memorize"]);
});

// §12.3-6 并发请求串行
test("clearSession serializes concurrent requests", async () => {
  const gate = deferred<ShortMemoryCaptureResult>();
  const events: string[] = [];
  let workerCalls = 0;
  const worker: ShortMemoryWorker = {
    async captureBeforeSessionClear() {
      workerCalls += 1;
      events.push("worker");
      if (workerCalls === 1) return gate.promise;
      return { captured: false, reason: "empty" };
    }
  };
  const coordinator = createSessionClearCoordinator({ shortMemoryWorker: worker, appendLog: () => {} });
  const first = coordinator.clearSession({
    kind: "chat",
    sessionId: "s1",
    reason: "r",
    exists: () => {
      events.push("exists1");
      return true;
    },
    async clear() {
      events.push("clear1");
    }
  });
  await waitFor(() => events.includes("worker"));
  const second = coordinator.clearSession({
    kind: "chat",
    sessionId: "s2",
    reason: "r",
    exists: () => {
      events.push("exists2");
      return true;
    },
    async clear() {
      events.push("clear2");
    }
  });
  await tick();
  assert.deepEqual(events, ["exists1", "worker"], "第二个请求必须排队等待第一个完整结束");
  assert.equal(workerCalls, 1);
  gate.resolve({ captured: false, reason: "empty" });
  const firstResult = await first;
  const secondResult = await second;
  assert.deepEqual(firstResult, { cleared: true, shortMemoryCaptured: false });
  assert.deepEqual(secondResult, { cleared: true, shortMemoryCaptured: false });
  assert.equal(workerCalls, 2);
  assert.deepEqual(events, ["exists1", "worker", "clear1", "exists2", "worker", "clear2"]);
});

// §12.3-7 同 session 重复 clear 只执行一次（由执行时的 exists() 去重）
test("clearSession deduplicates repeated clears of the same session via exists()", async () => {
  let workerCalls = 0;
  let clearCalls = 0;
  let existsCalls = 0;
  const worker: ShortMemoryWorker = {
    async captureBeforeSessionClear() {
      workerCalls += 1;
      return { captured: false, reason: "empty" };
    }
  };
  const coordinator = createSessionClearCoordinator({ shortMemoryWorker: worker, appendLog: () => {} });
  const request: SessionClearRequest = {
    kind: "memorize",
    sessionId: "same-session",
    reason: "admin_clear",
    exists() {
      existsCalls += 1;
      return existsCalls === 1; // 第一次存在，之后会话已清除
    },
    async clear() {
      clearCalls += 1;
    }
  };
  const first = await coordinator.clearSession(request);
  const second = await coordinator.clearSession(request);
  assert.deepEqual(first, { cleared: true, shortMemoryCaptured: false });
  assert.deepEqual(second, { cleared: false, shortMemoryCaptured: false }, "重复 clear 必须返回 cleared:false");
  assert.equal(workerCalls, 1, "真实采集只能发生一次");
  assert.equal(clearCalls, 1, "真实清除只能发生一次");
});

// §12.3-8 队列中的一个请求失败后，后续请求仍能执行
test("clearSession keeps processing the queue after one request fails", async () => {
  let workerCalls = 0;
  const worker: ShortMemoryWorker = {
    async captureBeforeSessionClear() {
      workerCalls += 1;
      if (workerCalls === 1) throw new Error("worker-boom");
      return { captured: false, reason: "empty" };
    }
  };
  const clears: string[] = [];
  const coordinator = createSessionClearCoordinator({ shortMemoryWorker: worker, appendLog: () => {} });
  const failing = coordinator.clearSession({
    kind: "chat",
    sessionId: "bad",
    reason: "r",
    exists: () => true,
    async clear() {
      clears.push("bad");
    }
  });
  const following = coordinator.clearSession({
    kind: "talk",
    sessionId: "good",
    reason: "r",
    exists: () => true,
    async clear() {
      clears.push("good");
    }
  });
  await assert.rejects(failing, /worker-boom/);
  const result = await following;
  assert.deepEqual(result, { cleared: true, shortMemoryCaptured: false });
  assert.deepEqual(clears, ["good"], "失败请求不得影响后续请求执行");
  assert.equal(workerCalls, 2);
});

// §6.2-2 exists() 必须在轮到该请求执行时求值，而不是入队时读取陈旧状态
test("clearSession evaluates exists() at execution time, not at enqueue time", async () => {
  const gate = deferred<ShortMemoryCaptureResult>();
  let workerCalls = 0;
  const worker: ShortMemoryWorker = {
    async captureBeforeSessionClear() {
      workerCalls += 1;
      if (workerCalls === 1) return gate.promise;
      return { captured: false, reason: "empty" };
    }
  };
  const coordinator = createSessionClearCoordinator({ shortMemoryWorker: worker, appendLog: () => {} });
  const first = coordinator.clearSession({
    kind: "chat",
    sessionId: "a",
    reason: "r",
    exists: () => true,
    async clear() {}
  });
  await waitFor(() => workerCalls === 1);
  let secondExists = true;
  const second = coordinator.clearSession({
    kind: "chat",
    sessionId: "b",
    reason: "r",
    exists: () => secondExists,
    async clear() {}
  });
  secondExists = false; // 入队后、执行前会话已消失
  gate.resolve({ captured: false, reason: "empty" });
  await first;
  const result = await second;
  assert.deepEqual(result, { cleared: false, shortMemoryCaptured: false }, "exists() 必须在执行时求值");
  assert.equal(workerCalls, 1, "执行时 exists() 为 false 不得调用 Worker");
});
