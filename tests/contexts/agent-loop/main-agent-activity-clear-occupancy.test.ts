import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentLoopRuntime } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import type { SessionClearResult } from "../../../src/contexts/llm-session/src/application/session-clear-coordinator.js";
import {
  asMainAgentActivityContract,
  requireMainAgentClearAcquisition,
  textEvent
} from "./agent-loop-runtime-helpers.js";

/**
 * Main Agent activity 占用机制契约测试(架构缺口修复轮·第二版, §7.1/§10/§11.2):
 * agentLoopRuntime 的运行占用从"仅包围 requestRun()"扩展为统一的 MainAgentActivity
 * 占用(idle / running / clearing): requestRun 与统一 clear(Chat/Talk/Memorize)
 * 共用同一占用; clear 开始前获取占用(先占用、后清除), 完整结束或失败后释放;
 * 占用期间互斥(requestRun 返回 { started:false } / beginClearSession 返回 { acquired:false })。
 *
 * 第二版新增契约(问题 1: 内部并发 chat clear 的 token 所有权):
 * - 占用句柄携带唯一 token; release() 只释放自己 token 名下的占用, 过期句柄不得
 *   误释放新 owner 的占用; 同一句柄重复 release 幂等。
 * - 两个内部 clearCurrentLLMSession 并发: 第二个必须排队等待第一个完成后再执行,
 *   全程 busy 连续无 idle 空窗(第一个 settle 后不得回落 idle), 第二个 settle 后
 *   才恢复 idle; 期间外部 requestRun 拒绝。
 * - 外部 beginClearSession(force_wake 形态)占用期间, 内部 clearCurrentLLMSession
 *   委托执行(不重复占用、不丢占用, 由外部句柄释放); 内部 clear 占用期间外部
 *   beginClearSession 拒绝。
 *
 * 实现方契约见 agent-loop-runtime-helpers.ts 顶部注释; 实现已落地(契约访问器、
 * token 所有权与占用空窗均已交付), 本文件用例应全绿。
 *
 * 第四版新增契约(P1 阻塞路径, 终审实证):
 * - 外部 beginClearSession 的 chat 占用(force_wake 形态)持有期间入队的**所有**
 *   内部 clear(含后续排队 job)settle 之前, isMainAgentBusy() 恒 true。
 * - 外部占用期间所有排队 job 均走委托路径(不自行获取占用), 因此外部持有者的
 *   await 在第一个 job settle 时解析、finally release 后, 排队 job 本体仍在执行
 *   时 busy 不得回落、activity 不得为 idle; 队列全部 drain 完成后才 idle。
 * 实现通过延迟外部 release，确保排队 job 全部 settle 后才恢复 idle。
 *
 * 第四版 P4 契约(当前实现已满足, 应绿):
 * - 外部 talk/memorize 占用进行中, 内部 clearCurrentLLMSession(chat) 必须抛
 *   main_agent_clear_in_progress(单一占用槽, §10/§11.2), 不得调用清除本体,
 *   不得破坏外部占用。
 */

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

test("idle 未占用; requestRun 进行中 busy=true 且 beginClearSession 拒绝; 结束后释放", async () => {
  const runtime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(runtime);

  assert.equal(contract.isMainAgentBusy(), false, "初始应为 idle 未占用");
  assert.deepEqual(contract.getMainAgentActivity(), { phase: "idle" });

  let releaseRun: (() => void) | undefined;
  runtime.setRunners({
    prepareTalk() {
      return new Promise((resolve) => {
        releaseRun = () => resolve({ prepare: () => [], complete: () => [] });
      });
    }
  });

  const run = runtime.requestRun({ kind: "talk", sessionId: 1780830000101, reason: "first" });
  assert.equal(contract.isMainAgentBusy(), true, "requestRun 进行中必须占用 Main Agent");
  assert.deepEqual(contract.getMainAgentActivity(), { phase: "running", kind: "talk", sessionId: 1780830000101 });

  const acquisition = contract.beginClearSession({ kind: "chat", sessionId: "session-1" });
  assert.equal(acquisition.acquired, false, "requestRun 进行中发起 clear 必须被拒绝(不得并发占用)");

  releaseRun?.();
  assert.deepEqual(await run, { started: true, outputs: [] });
  assert.equal(contract.isMainAgentBusy(), false, "run 结束后必须释放占用");
  assert.deepEqual(contract.getMainAgentActivity(), { phase: "idle" });
});

test("clearing 占用期间 requestRun 拒绝; chat/talk/memorize 三种 kind 互斥", async () => {
  const runtime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(runtime);

  const talkClear = requireMainAgentClearAcquisition(contract.beginClearSession({ kind: "talk", sessionId: "talk-1" }));
  assert.equal(contract.isMainAgentBusy(), true, "talk 清除占用中 busy");
  assert.deepEqual(contract.getMainAgentActivity(), { phase: "clearing", kind: "talk", sessionId: "talk-1" });

  const rejectedRun = await runtime.requestRun({ kind: "chat", sessionId: "session-1", reason: "test", event: textEvent("session-1") });
  assert.deepEqual(rejectedRun, { started: false, outputs: [] }, "清除占用期间 requestRun 必须拒绝");

  assert.equal(contract.beginClearSession({ kind: "chat", sessionId: "session-1" }).acquired, false, "chat clear 与 talk clear 互斥");
  assert.equal(contract.beginClearSession({ kind: "memorize", sessionId: "console" }).acquired, false, "memorize clear 与 talk clear 互斥");

  talkClear.release();
  assert.equal(contract.isMainAgentBusy(), false, "释放后恢复 idle");
  assert.deepEqual(contract.getMainAgentActivity(), { phase: "idle" });

  const memorizeClear = requireMainAgentClearAcquisition(contract.beginClearSession({ kind: "memorize", sessionId: "console" }));
  assert.deepEqual(contract.getMainAgentActivity(), { phase: "clearing", kind: "memorize", sessionId: "console" }, "memorize 清除占用");
  const rejectedTalk = await runtime.requestRun({ kind: "talk", sessionId: 1780830000101, reason: "third" });
  assert.deepEqual(rejectedTalk, { started: false, outputs: [] }, "memorize 清除占用期间 requestRun 拒绝");
  memorizeClear.release();

  const chatClear = requireMainAgentClearAcquisition(contract.beginClearSession({ kind: "chat", sessionId: "session-1" }));
  const chatActivity = contract.getMainAgentActivity();
  assert.equal(chatActivity.phase, "clearing", "chat 清除占用");
  if (chatActivity.phase !== "clearing") throw new Error("unreachable: expected clearing phase");
  assert.equal(chatActivity.kind, "chat");
  chatClear.release();
  assert.equal(contract.isMainAgentBusy(), false);
});

test("clearCurrentLLMSession 先占用后清除; 完整结束后释放", async () => {
  const runtime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(runtime);
  let releaseClear: (() => void) | undefined;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  let busyAtClearEntry: boolean | undefined;
  runtime.setLLMSessionRuntime({
    clearCurrentLLMSession(reason: string) {
      // 先占用、后清除: 统一 clear 的采集/清除本体启动前, 占用必须已获取。
      busyAtClearEntry = contract.isMainAgentBusy();
      return clearGate.then(() => ({ cleared: true, shortMemoryCaptured: false }) as SessionClearResult);
    }
  } as any);

  const clear = runtime.clearCurrentLLMSession("mode_transition");
  await flushMicrotasks();

  assert.equal(busyAtClearEntry, true, "clear 本体启动前占用必须已获取(先占用、后清除)");
  assert.equal(contract.isMainAgentBusy(), true, "clear Promise 完成前 Main Agent 必须保持占用");
  const activity = contract.getMainAgentActivity();
  assert.equal(activity.phase, "clearing", "clear 期间 activity 为 clearing");
  if (activity.phase !== "clearing") throw new Error("unreachable: expected clearing phase");
  assert.equal(activity.kind, "chat", "Chat 统一 clear 入口占用 kind 为 chat");
  const rejected = await runtime.requestRun({ kind: "chat", sessionId: "session-1", reason: "test", event: textEvent("session-1") });
  assert.deepEqual(rejected, { started: false, outputs: [] }, "clear 期间不得开启新 loop");

  releaseClear?.();
  assert.deepEqual(await withTimeout(clear), { cleared: true, shortMemoryCaptured: false });
  assert.equal(contract.isMainAgentBusy(), false, "clear 成功后必须释放占用");
});

test("clearCurrentLLMSession 失败时同样释放占用", async () => {
  const runtime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(runtime);
  runtime.setLLMSessionRuntime({
    clearCurrentLLMSession() {
      return Promise.reject(new Error("short memory worker boom"));
    }
  } as any);

  await assert.rejects(runtime.clearCurrentLLMSession("force_wake"), /short memory worker boom/);
  assert.equal(contract.isMainAgentBusy(), false, "clear 失败后必须释放占用(§10: 失败阻止后续 loop)");

  const acquisition = requireMainAgentClearAcquisition(contract.beginClearSession({ kind: "chat", sessionId: "session-1" }));
  assert.equal(contract.isMainAgentBusy(), true, "失败释放后占用可再次获取");
  acquisition.release();
  assert.equal(contract.isMainAgentBusy(), false);
});

test("loop 结束路径(complete 内 await clear) busy 连续无空窗, 期间外部 requestRun 拒绝", async () => {
  const runtime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(runtime);
  let releaseClear: (() => void) | undefined;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  runtime.setLLMSessionRuntime({
    clearCurrentLLMSession() {
      return clearGate.then(() => ({ cleared: true, shortMemoryCaptured: false }));
    }
  } as any);
  runtime.setRunners({
    prepareChat() {
      return {
        prepare: () => [],
        async complete() {
          // §7.1: 生产 loop 结束路径(yield_end/admin_cancel/prompt_static_changed/mode_*)在 complete 内 await clear。
          await runtime.clearCurrentLLMSession("yield_end");
          return [];
        }
      };
    }
  });

  let settled = false;
  const run = runtime.requestRun({ kind: "chat", sessionId: "session-1", reason: "test", event: textEvent("session-1") }).then((result) => {
    settled = true;
    return result;
  });
  await flushMicrotasks();

  assert.equal(contract.isMainAgentBusy(), true, "running→clearing 交接期间 busy 不得出现 false 空窗(§11.2)");
  assert.notEqual(contract.getMainAgentActivity().phase, "idle", "clear Promise 完成前 Main Agent 不得回到 idle");
  const second = await runtime.requestRun({ kind: "talk", sessionId: 1780830000101, reason: "second" });
  assert.deepEqual(second, { started: false, outputs: [] }, "clear Promise 完成前不得开启新 loop");

  releaseClear?.();
  const first = await withTimeout(run);
  assert.equal(first.started, true);
  assert.equal(settled, true);
  assert.equal(contract.isMainAgentBusy(), false, "clear 与 run 全部结束后释放占用");
});

test("占用句柄带唯一 token; release 只释放自己的占用, 过期句柄不误释放新 owner", async () => {
  const runtime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(runtime);

  const first = requireMainAgentClearAcquisition(contract.beginClearSession({ kind: "chat", sessionId: "session-1" }));
  assert.ok(typeof first.token === "string" && first.token.length > 0, "占用句柄必须携带唯一 token");
  assert.equal(contract.beginClearSession({ kind: "chat", sessionId: "session-1" }).acquired, false, "占用持有期间再次获取(同 kind 同会话)必须拒绝");

  first.release();
  assert.equal(contract.isMainAgentBusy(), false, "释放后恢复 idle");

  const second = requireMainAgentClearAcquisition(contract.beginClearSession({ kind: "chat", sessionId: "session-1" }));
  assert.notEqual(second.token, first.token, "每次获取的 token 必须唯一(不同 owner 可区分)");
  // 过期句柄(first 已释放)再次 release: 不得误释放 second 名下的占用(release 幂等 + owner 校验)。
  first.release();
  assert.equal(contract.isMainAgentBusy(), true, "过期句柄 release 不得误释放新 owner 的占用");
  assert.deepEqual(contract.getMainAgentActivity(), { phase: "clearing", kind: "chat", sessionId: "session-1" }, "占用仍属于 second");

  second.release();
  assert.equal(contract.isMainAgentBusy(), false, "owner 句柄释放后才恢复 idle");
});

test("两个内部 chat clear 并发(clearCurrentLLMSession): 第二个排队, 全程 busy 连续无 idle 空窗", async () => {
  const runtime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(runtime);
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  let clearBodyCalls = 0;
  const gate1 = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const gate2 = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  runtime.setLLMSessionRuntime({
    clearCurrentLLMSession() {
      clearBodyCalls += 1;
      if (clearBodyCalls === 1) return gate1.then(() => ({ cleared: true, shortMemoryCaptured: false }));
      return gate2.then(() => ({ cleared: true, shortMemoryCaptured: false }));
    }
  } as any);
  runtime.setRunners({
    prepareChat() {
      return { prepare: () => [], complete: () => [] };
    }
  });

  const first = runtime.clearCurrentLLMSession("mode_transition");
  await flushMicrotasks();
  assert.equal(contract.isMainAgentBusy(), true, "第一个 clear 执行中必须占用");
  assert.equal(clearBodyCalls, 1, "第一个 clear 本体已启动");

  // 第二个内部 clear 在第一个 pending 期间发起: 必须排队, 不得并发执行清除本体。
  const second = runtime.clearCurrentLLMSession("admin_clear");
  await flushMicrotasks();
  assert.equal(contract.isMainAgentBusy(), true, "第二个 clear 排队期间 busy 连续(不得出现 idle 空窗)");
  assert.equal(clearBodyCalls, 1, "第二个 clear 本体必须等待第一个完成后才开始(串行入 coordinator)");

  releaseFirst?.();
  assert.deepEqual(await withTimeout(first), { cleared: true, shortMemoryCaptured: false });
  // 关键断言: 第一个 settle 后、第二个 settle 前, 不得出现 idle 空窗——
  // 占用必须连续交接给第二个 clear, heartbeat/新 loop 不得被放行。
  assert.equal(contract.isMainAgentBusy(), true, "第一个 clear settle 后 busy 不得回落(第二个 clear 仍在执行)");
  assert.notEqual(contract.getMainAgentActivity().phase, "idle", "第一个 clear settle 后 activity 不得回到 idle");
  await flushMicrotasks();
  assert.equal(clearBodyCalls, 2, "第二个 clear 本体在第一个完成后开始执行");
  assert.equal(contract.isMainAgentBusy(), true, "第二个 clear 执行中 busy 连续");

  const rejected = await runtime.requestRun({ kind: "chat", sessionId: "session-1", reason: "test", event: textEvent("session-1") });
  assert.deepEqual(rejected, { started: false, outputs: [] }, "第二个 clear 执行期间外部 requestRun 必须拒绝");

  releaseSecond?.();
  assert.deepEqual(await withTimeout(second), { cleared: true, shortMemoryCaptured: false });
  assert.equal(contract.isMainAgentBusy(), false, "第二个 clear settle 后才恢复 idle");
});

test("外部 beginClearSession(force_wake 形态)占用期间内部 clear 委托执行, 不重复占用不丢占用", async () => {
  const runtime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(runtime);
  const seenReasons: string[] = [];
  let releaseClear: (() => void) | undefined;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  runtime.setLLMSessionRuntime({
    clearCurrentLLMSession(reason: string) {
      seenReasons.push(reason);
      return clearGate.then(() => ({ cleared: true, shortMemoryCaptured: false }) as SessionClearResult);
    }
  } as any);

  // 外部 force_wake 先获取占用(生产形态: message-runtime 占用后再调 clearLLMSession)。
  const external = requireMainAgentClearAcquisition(contract.beginClearSession({ kind: "chat", sessionId: "session-1" }));
  assert.equal(contract.isMainAgentBusy(), true);

  // 外部 chat 占用期间内部 clear 必须直接委托执行: 不重复占用、不丢占用。
  const inner = runtime.clearCurrentLLMSession("force_wake");
  await flushMicrotasks();
  assert.deepEqual(seenReasons, ["force_wake"], "外部占用期间内部 clear 必须委托执行(不重复占用)");
  assert.equal(contract.isMainAgentBusy(), true, "内部 clear 执行期间外部占用不得丢失");
  assert.equal(contract.beginClearSession({ kind: "chat", sessionId: "session-2" }).acquired, false, "外部占用 + 内部 clear 期间再次获取必须拒绝");

  releaseClear?.();
  assert.deepEqual(await withTimeout(inner), { cleared: true, shortMemoryCaptured: false });
  assert.equal(contract.isMainAgentBusy(), true, "内部 clear 完成后外部占用仍持有(busy 连续)");
  assert.deepEqual(contract.getMainAgentActivity(), { phase: "clearing", kind: "chat", sessionId: "session-1" });

  external.release();
  assert.equal(contract.isMainAgentBusy(), false, "外部句柄释放后才恢复 idle(占用由外部 owner 释放)");
});

test("内部 clear 占用期间外部 beginClearSession 拒绝(内部占用同权)", async () => {
  const runtime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(runtime);
  let releaseClear: (() => void) | undefined;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  runtime.setLLMSessionRuntime({
    clearCurrentLLMSession() {
      return clearGate.then(() => ({ cleared: true, shortMemoryCaptured: false }));
    }
  } as any);

  const inner = runtime.clearCurrentLLMSession("mode_transition");
  await flushMicrotasks();
  assert.equal(contract.isMainAgentBusy(), true, "内部 clear 已占用");

  assert.equal(contract.beginClearSession({ kind: "chat", sessionId: "session-1" }).acquired, false, "内部 clear 占用期间外部 chat 获取必须拒绝");
  assert.equal(contract.beginClearSession({ kind: "talk", sessionId: "talk-1" }).acquired, false, "内部 clear 占用期间外部 talk 获取必须拒绝");
  const rejectedRun = await runtime.requestRun({ kind: "chat", sessionId: "session-1", reason: "test", event: textEvent("session-1") });
  assert.deepEqual(rejectedRun, { started: false, outputs: [] }, "内部 clear 占用期间 requestRun 必须拒绝");

  releaseClear?.();
  assert.deepEqual(await withTimeout(inner), { cleared: true, shortMemoryCaptured: false });
  assert.equal(contract.isMainAgentBusy(), false, "内部 clear settle 后恢复 idle");
});

test("P1(第四版阻塞路径): 外部占用期间入队的多个内部 clear 全部 settle 前 busy 恒 true, 外部 release 不得提前回落 idle", async () => {
  const runtime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(runtime);
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  let clearBodyCalls = 0;
  const gate1 = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const gate2 = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  runtime.setLLMSessionRuntime({
    clearCurrentLLMSession() {
      clearBodyCalls += 1;
      if (clearBodyCalls === 1) return gate1.then(() => ({ cleared: true, shortMemoryCaptured: false }) as SessionClearResult);
      return gate2.then(() => ({ cleared: true, shortMemoryCaptured: false }) as SessionClearResult);
    }
  } as any);
  runtime.setRunners({
    prepareChat() {
      return { prepare: () => [], complete: () => [] };
    }
  });

  // 外部 chat 占用(force_wake 生产形态: message-runtime 先 beginClearSession 再 clearLLMSession)。
  const external = requireMainAgentClearAcquisition(contract.beginClearSession({ kind: "chat", sessionId: "session-1" }));
  assert.equal(contract.isMainAgentBusy(), true, "外部占用已获取");

  // job1: 外部占用持有期间入队, 委托执行(不重复占用、不丢占用)。
  const job1 = runtime.clearCurrentLLMSession("force_wake");
  await flushMicrotasks();
  assert.equal(clearBodyCalls, 1, "job1 本体已启动(委托路径)");
  assert.equal(contract.isMainAgentBusy(), true);

  // job2: job1 pending 期间入队(另一 reason), 必须排队, 不得并发执行清除本体。
  const job2 = runtime.clearCurrentLLMSession("admin_clear");
  await flushMicrotasks();
  assert.equal(clearBodyCalls, 1, "job2 必须排队等待 job1 settle(串行)");
  assert.equal(contract.isMainAgentBusy(), true, "job2 排队期间 busy 连续");

  // 释放 job1: drain 同步续接并以委托路径启动 job2(所有排队 job 均委托, 不自行获取占用)。
  releaseFirst?.();
  assert.deepEqual(await withTimeout(job1), { cleared: true, shortMemoryCaptured: false });
  assert.equal(clearBodyCalls, 2, "job1 settle 后 drain 已续接并启动 job2 本体(委托路径)");
  assert.equal(contract.isMainAgentBusy(), true, "job2 本体执行期间 busy 连续(外部占用仍持有)");

  // 生产形态: 外部持有者 await job1 的调用点在此解析并 finally release。
  external.release();

  // 契约(P1): 外部占用持有期间入队的**所有**内部 clear(job2)settle 之前 busy 恒 true;
  // 外部 release 后、排队 job 仍未 settle 时 busy 不得回落、activity 不得为 idle。
  assert.equal(contract.isMainAgentBusy(), true, "外部 release 后 job2 未 settle, busy 不得回落");
  assert.notEqual(contract.getMainAgentActivity().phase, "idle", "job2 未 settle 时 activity 不得为 idle");
  const rejected = await runtime.requestRun({ kind: "chat", sessionId: "session-2", reason: "test", event: textEvent("session-2") });
  assert.deepEqual(rejected, { started: false, outputs: [] }, "job2 未 settle 期间 requestRun 必须拒绝(不得开启新 loop)");

  // job2 settle 后队列全部 drain, 才恢复 idle。
  releaseSecond?.();
  assert.deepEqual(await withTimeout(job2), { cleared: true, shortMemoryCaptured: false });
  assert.equal(contract.isMainAgentBusy(), false, "队列全部 drain 完成后才 idle");
  assert.deepEqual(contract.getMainAgentActivity(), { phase: "idle" });
});

test("P4: 外部 talk/memorize 占用进行中, 内部 clearCurrentLLMSession(chat) 抛 main_agent_clear_in_progress, 不调用清除本体不破坏外部占用", async () => {
  const runtime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(runtime);
  const clearBodyCalls: string[] = [];
  runtime.setLLMSessionRuntime({
    clearCurrentLLMSession(reason: string) {
      clearBodyCalls.push(reason);
      return Promise.resolve({ cleared: true, shortMemoryCaptured: false } as SessionClearResult);
    }
  } as any);

  // 外部 talk 清除占用进行中: 内部 chat clear 必须拒绝(单一占用槽, §10/§11.2)。
  const talkClear = requireMainAgentClearAcquisition(contract.beginClearSession({ kind: "talk", sessionId: "talk-1" }));
  await assert.rejects(
    runtime.clearCurrentLLMSession("mode_transition"),
    /main_agent_clear_in_progress/,
    "talk 占用进行中内部 chat clear 必须抛 main_agent_clear_in_progress"
  );
  assert.deepEqual(clearBodyCalls, [], "拒绝时不得调用清除本体(不进入 coordinator/Short Memory 采集)");
  assert.equal(contract.isMainAgentBusy(), true, "拒绝不得释放或破坏外部 talk 占用");
  talkClear.release();

  // 外部 memorize 清除占用进行中: 内部 chat clear 同样拒绝。
  const memorizeClear = requireMainAgentClearAcquisition(contract.beginClearSession({ kind: "memorize", sessionId: "console" }));
  await assert.rejects(
    runtime.clearCurrentLLMSession("force_wake"),
    /main_agent_clear_in_progress/,
    "memorize 占用进行中内部 chat clear 必须抛 main_agent_clear_in_progress"
  );
  assert.deepEqual(clearBodyCalls, [], "拒绝时不得调用清除本体");
  assert.equal(contract.isMainAgentBusy(), true, "拒绝不得释放或破坏外部 memorize 占用");
  memorizeClear.release();
  assert.equal(contract.isMainAgentBusy(), false, "外部句柄释放后才恢复 idle");
});
