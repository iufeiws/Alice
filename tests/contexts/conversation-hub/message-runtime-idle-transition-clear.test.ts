import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageRuntime } from "../../../src/contexts/conversation-hub/src/application/ingest-channel-message.js";
import { createAliceStore } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { makeTempDir, waitFor } from "./message-runtime-helpers.js";

const path = await import("node:path");

/**
 * message-runtime waiting→idle(inactive) 状态监听器契约测试（§7.1 / §10 / §11.2）:
 * - 清除成功完成后才允许 schedule 后续 heartbeat; 清除期间(Promise pending)不得调度。
 * - 清除失败时不 schedule 后续 heartbeat(loop 停止, 会话保持未清除), 错误必须被记录。
 *
 * 观察点:
 * - heartbeat 每次实际 run 都会触发 deps.onHeartbeatTick; 间隔被设为 600s,
 *   除显式 schedule(0) 外不会有其他 run。
 * - 心跳计时器处于 pending 时 schedule(0) 会被吞掉(agent-heartbeat-runtime 的
 *   scheduleTimer 在已有 timer 时直接返回), 因此测试先 flushAll() 排空计时器,
 *   使监听器后续的 schedule(0) 可被直接观察; state 监听器引用在构造时被测试
 *   同步捕获, flushAll 的退订不影响直接触发。
 * - runtime.getStatus().heartbeatScheduled 直接反映监听器是否调用了 schedule。
 */

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function idleSnapshot() {
  return {
    state: "idle",
    reason: "inactive",
    intimacy: 50,
    updatedAt: "2026-05-26T00:00:00.000Z",
    responseDelayMs: 0
  };
}

function makeRuntime(input: {
  clearLLMSession(reason: string): void | Promise<void>;
  logLines: string[];
  onHeartbeatTick(): void;
}) {
  const store = createAliceStore(path.join(makeTempDir("runtime-idle-transition-clear"), "alice.sqlite"));
  let capturedListener: ((snapshot: any) => unknown) | undefined;
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 600_000,
    onHeartbeatTick: input.onHeartbeatTick,
    now: () => new Date("2026-05-26T00:00:00.000Z"),
    clearLLMSession: input.clearLLMSession,
    agentState: {
      getSnapshot: () => ({ state: "waiting", intimacy: 50, updatedAt: "2026-05-26T00:00:00.000Z", responseDelayMs: 0 }),
      canReplyToInbound: () => true,
      canRunHeartbeat: () => true,
      getInboundDelayMs: () => 0,
      noteInboundMessage() {
        return { state: "waiting", intimacy: 50, updatedAt: "2026-05-26T00:00:00.000Z", responseDelayMs: 0 };
      },
      tick() {
        return { state: "waiting", intimacy: 50, updatedAt: "2026-05-26T00:00:00.000Z", responseDelayMs: 0 };
      },
      onChange(listener) {
        capturedListener = listener;
        return () => {
          capturedListener = undefined;
        };
      }
    },
    store,
    chatAgent: {
      async prepareEventRun() {
        return [];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog(level, message) {
      input.logLines.push(`${level}:${message}`);
    },
    appendMessageLog(entry) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...entry });
    }
  });
  // 构造时同步捕获监听器引用: flushAll 退订后测试仍可直接触发状态过渡。
  const listener = capturedListener;
  return { runtime, triggerIdle: () => listener?.(idleSnapshot()) as Promise<void> | undefined };
}

test("waiting→idle(inactive) 清除成功完成后才调度后续 heartbeat", async () => {
  const logLines: string[] = [];
  let heartbeatTicks = 0;
  const clearReasons: string[] = [];
  let releaseClear: (() => void) | undefined;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  const { runtime, triggerIdle } = makeRuntime({
    clearLLMSession(reason) {
      clearReasons.push(reason);
      return clearGate;
    },
    logLines,
    onHeartbeatTick() {
      heartbeatTicks += 1;
    }
  });
  // 初始 heartbeat.schedule(0) 已跑过一次并进入 600s 静默期。
  await waitFor(() => heartbeatTicks > 0);
  const baseline = heartbeatTicks;
  // 排空心跳计时器, 使监听器后续的 schedule(0) 可被直接观察(§11.2)。
  await runtime.flushAll();
  assert.equal(runtime.getStatus().heartbeatScheduled, false, "排空后不得有 pending 心跳");

  const transition = triggerIdle();
  assert.ok(transition instanceof Promise, "状态监听器必须返回 promise(await 清除)");
  await tick();
  assert.deepEqual(clearReasons, ["mode_transition"], "idle(inactive) 过渡必须发起 mode_transition 清除");

  await sleep(60);
  assert.equal(heartbeatTicks, baseline, "清除 Promise 完成前不得调度后续 heartbeat(§11.2)");
  assert.equal(runtime.getStatus().heartbeatScheduled, false, "清除期间不得有任何 schedule 调用");

  releaseClear?.();
  await transition;
  assert.equal(runtime.getStatus().heartbeatScheduled, true, "清除成功完成后才允许 schedule 后续 heartbeat");
  await waitFor(() => heartbeatTicks > baseline);
  assert.equal(heartbeatTicks, baseline + 1, "清除成功后仅调度一次后续 heartbeat");
  await runtime.flushAll();
});

test("waiting→idle(inactive) 清除失败时不调度 heartbeat 并记录错误", async () => {
  const logLines: string[] = [];
  let heartbeatTicks = 0;
  const clearReasons: string[] = [];
  const { runtime, triggerIdle } = makeRuntime({
    clearLLMSession(reason) {
      clearReasons.push(reason);
      return Promise.reject(new Error("short memory worker boom"));
    },
    logLines,
    onHeartbeatTick() {
      heartbeatTicks += 1;
    }
  });
  await waitFor(() => heartbeatTicks > 0);
  const baseline = heartbeatTicks;
  await runtime.flushAll();

  await triggerIdle();
  assert.deepEqual(clearReasons, ["mode_transition"], "清除失败也必须以 mode_transition 原因发起清除");
  assert.equal(
    runtime.getStatus().heartbeatScheduled,
    false,
    "清除失败时不得 schedule 后续 heartbeat(loop 停止, §10/§11.2)"
  );
  // 给旧实现(无条件 schedule(0))留出触发窗口: 新契约下这段时间不得有任何 heartbeat run。
  await sleep(80);
  assert.equal(heartbeatTicks, baseline, "清除失败时不得出现任何后续 heartbeat run");
  assert.equal(
    logLines.some((line) => line.includes("idle transition llm session clear failed") && line.includes("short memory worker boom")),
    true,
    "清除失败必须记录错误日志"
  );
  await runtime.flushAll();
});

test("waiting→idle(inactive) 清除期间(Pending)不调度 heartbeat", async () => {
  const logLines: string[] = [];
  let heartbeatTicks = 0;
  let releaseClear: (() => void) | undefined;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  const { runtime, triggerIdle } = makeRuntime({
    clearLLMSession() {
      return clearGate;
    },
    logLines,
    onHeartbeatTick() {
      heartbeatTicks += 1;
    }
  });
  await waitFor(() => heartbeatTicks > 0);
  const baseline = heartbeatTicks;
  await runtime.flushAll();

  const transition = triggerIdle();
  await tick();
  // 清除保持 pending: 反复等数个宏任务, 期间不得出现任何 heartbeat run 或 schedule。
  for (let i = 0; i < 5; i += 1) {
    await sleep(20);
    assert.equal(heartbeatTicks, baseline, `清除期间(pending)不得调度 heartbeat(第 ${i + 1} 次检查)`);
    assert.equal(runtime.getStatus().heartbeatScheduled, false, `清除期间(pending)不得有 schedule(第 ${i + 1} 次检查)`);
  }

  releaseClear?.();
  await transition;
  await waitFor(() => heartbeatTicks > baseline);
  await runtime.flushAll();
});
