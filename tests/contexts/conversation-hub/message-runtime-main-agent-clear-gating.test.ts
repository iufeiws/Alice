import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageRuntime } from "../../../src/contexts/conversation-hub/src/application/ingest-channel-message.js";
import { createAgentLoopRuntime, type AgentLoopRuntime } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import type { AgentEvent } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { createAliceStore } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { asMainAgentActivityContract, requireMainAgentClearAcquisition } from "../agent-loop/agent-loop-runtime-helpers.js";
import { makeTempDir, textEvent, waitFor } from "./message-runtime-helpers.js";

const path = await import("node:path");

/**
 * message-runtime 层 Main Agent clearing 占用门控契约测试(架构缺口修复轮·第二版, §7.1/§10/§11.2):
 * - canRunHeartbeat 链路必须检查 agentLoopRuntime 的统一占用(clearing 与 running 同权),
 *   即使 AgentBehaviorState 是 waiting/idle(可运行)也不得放行 heartbeat 任务;
 * - force(processNow)同样不得绕过 Main Agent 互斥: clearing 占用期间 force run 返回 0、
 *   不进入 pending/manual 分支、不产生失败通知, 释放后恢复正常处理(问题 2);
 * - clear 期间 ingestEvent 到达的消息只入库并标记 pending, 不进入 loop;
 * - force_wake 先进入 clearing 占用再清除, 不存在"setState(waiting) 后 heartbeat 被放行"的窗口;
 * - 门控来自 activity 占用, 不依赖状态监听器 await(问题 3 观察方式: 构造时同步捕获
 *   监听器引用 + 单独调度, 不依赖 flushAll 的退订行为);
 * - flushAll 必须退订状态监听器(恢复 HEAD 行为): flush 后状态变化不再调度心跳,
 *   已 flush 的 runtime 不得复活(问题 3)。
 *
 * 观察点:
 * - onHeartbeatTick 只在 canRunHeartbeat() 为 true 时被调用(agent-heartbeat-runtime);
 * - pending 消息处理(handleDirtySession → requestRun → deps.chatAgent.prepareEventRun)
 *   在 canRunHeartbeat() 为 false 时整个 run 提前返回, 不会触达;
 * - 测试注入真实 createAgentLoopRuntime() 实例并通过契约访问器获取/释放 clearing 占用;
 *   agentState 侧恒为可运行(canRunHeartbeat 恒 true), 因此门控必须来自 activity 占用。
 *
 * 心跳间隔 600s: 除显式 schedule(0) 外不会有其他 run; scheduleTimer 在已有 timer 时
 * 吞掉新 schedule, 因此测试先 flushAll() 排空计时器, 再通过构造时同步捕获的监听器
 * 引用(syncTriggerStateListener)制造可观察的 run——监听器引用是原始闭包, 不受
 * flushAll 退订影响。
 *
 * 第四版 P3 契约(in-flight 监听器 guard 直接测试; 当前实现已满足, 应绿):
 * - 监听器调用在"已注册"期间启动(waiting→idle/inactive 触发 mode_transition 清除,
 *   await 清除中)后遇 flushAll: 清除 settle 后该 in-flight 调用不得 schedule
 *   heartbeat(不得复活已 flush 的 runtime)——registeredStateListener 检查钉住。
 * - in-flight 监听器 await 的清除失败时: 只记录错误, 同样不得 schedule heartbeat。
 */

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRuntime(input: {
  agentLoopRuntime: AgentLoopRuntime;
  logLines: string[];
  onHeartbeatTick?(): void;
  state?: "waiting" | "idle";
  setStateRecords?: string[];
  clearLLMSession?(reason: string): void | Promise<void>;
  onForceWake?(): void;
  onIdleTimerTransition?(input: { delayMs: number }): AgentEvent | Promise<AgentEvent | undefined> | undefined;
  onChatLoopStarted?(): void;
  onOutputSend?(): void;
  getProcessNowTarget?(): { plugin: string; accountId?: string; channelId?: string; userId?: string; sessionId: string } | undefined;
}) {
  const store = createAliceStore(path.join(makeTempDir("runtime-main-agent-clear"), "alice.sqlite"));
  const state = input.state ?? "waiting";
  let capturedListener: ((snapshot: any) => unknown) | undefined;
  const snapshot = () => ({
    state,
    intimacy: 50,
    updatedAt: "2026-05-26T00:00:00.000Z",
    nextTransitionAt: "2026-05-26T00:00:00.000Z",
    responseDelayMs: 0
  });
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 600_000,
    onHeartbeatTick: input.onHeartbeatTick ?? (() => {}),
    now: () => new Date("2026-05-26T00:00:00.000Z"),
    clearLLMSession: input.clearLLMSession ?? (() => {}),
    onForceWake: input.onForceWake,
    onIdleTimerTransition: input.onIdleTimerTransition,
    agentLoopRuntime: input.agentLoopRuntime,
    agentState: {
      canReplyToInbound: () => true,
      canRunHeartbeat: () => true, // 关键: 状态侧恒可运行; 门控必须来自 Main Agent activity 占用
      getInboundDelayMs: () => 0,
      getSnapshot: snapshot,
      tick: snapshot,
      setState(next, options) {
        input.setStateRecords?.push(`${next}:${options?.reason ?? ""}`);
        return { state: next, intimacy: 50, updatedAt: "2026-05-26T00:00:00.000Z", responseDelayMs: 0 };
      },
      onChange(listener) {
        capturedListener = listener;
        return () => {
          capturedListener = undefined;
        };
      },
      noteInboundMessage: snapshot,
      noteInboundProcessed: snapshot
    },
    store,
    chatAgent: {
      async prepareEventRun() {
        input.onChatLoopStarted?.();
        return [];
      }
    },
    outputRouter: {
      async sendAll() {
        input.onOutputSend?.();
      }
    },
    getProcessNowTarget: input.getProcessNowTarget,
    appendLog(level, message) {
      input.logLines.push(`${level}:${message}`);
    },
    appendMessageLog(entry) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...entry });
    }
  });
  // 构造时同步捕获监听器引用: flushAll 退订后仍可直接触发(问题 3 观察方式)。
  const syncListener = capturedListener;
  const fireSnapshot = () => ({ ...snapshot(), state: "idle", reason: "inactive" });
  return {
    runtime,
    store,
    triggerStateListener: () => capturedListener?.(fireSnapshot()) as Promise<void> | undefined,
    syncTriggerStateListener: () => syncListener?.(fireSnapshot()) as Promise<void> | undefined
  };
}

test("clearing 占用期间 canRunHeartbeat 链路不放行 heartbeat(agentState 可运行也不行)", async () => {
  const agentLoopRuntime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(agentLoopRuntime);
  const logLines: string[] = [];
  let ticks = 0;
  let loopStarts = 0;
  let sends = 0;
  const { runtime, store } = makeRuntime({
    agentLoopRuntime,
    logLines,
    onHeartbeatTick() {
      ticks += 1;
    },
    onChatLoopStarted() {
      loopStarts += 1;
    },
    onOutputSend() {
      sends += 1;
    }
  });

  await waitFor(() => ticks > 0);
  const baselineTicks = ticks;
  await runtime.flushAll();

  const acquisition = requireMainAgentClearAcquisition(contract.beginClearSession({ kind: "chat", sessionId: "session-1" }));
  assert.equal(contract.isMainAgentBusy(), true);

  runtime.ingestEvent(textEvent("session-1", "om_during_clear", "hello"));
  await sleep(80);

  assert.equal(loopStarts, 0, "清除占用期间消息不得进入 loop(不调用 requestRun)");
  assert.equal(sends, 0, "清除占用期间不得产生任何 AgentOutput 投递");
  assert.equal(ticks, baselineTicks, "清除占用期间 heartbeat 不得执行任务(onHeartbeatTick 不得触发)");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 1, "清除期间消息必须已入库且保持未处理(pending)");
  assert.ok(runtime.getStatus().pendingSessions.includes("session-1"), "清除期间会话必须保持 pending 标记");

  acquisition.release();
  assert.equal(contract.isMainAgentBusy(), false);
  await runtime.processNow();
  assert.equal(loopStarts, 1, "释放后 pending 消息可被处理(进入 loop)");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0, "释放后消息标记为已处理");
  await runtime.flushAll();
});

test("clearing 占用期间 idle 过渡类 heartbeat 任务不执行; 释放后 force 仍不执行 idle 过渡(原语义), 非 force 心跳恢复执行", async () => {
  const agentLoopRuntime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(agentLoopRuntime);
  const logLines: string[] = [];
  let idleHooks = 0;
  let ticks = 0;
  const { runtime, store } = makeRuntime({
    agentLoopRuntime,
    logLines,
    state: "idle",
    onHeartbeatTick() {
      ticks += 1;
    },
    onIdleTimerTransition() {
      idleHooks += 1;
      return undefined;
    }
  });

  await waitFor(() => idleHooks > 0, 3000);
  const baselineIdleHooks = idleHooks;
  await runtime.flushAll();

  const acquisition = requireMainAgentClearAcquisition(contract.beginClearSession({ kind: "memorize", sessionId: "console" }));
  runtime.ingestEvent(textEvent("session-1", "om_idle_during_clear", "hello"));
  await sleep(80);
  assert.equal(idleHooks, baselineIdleHooks, "清除占用期间 idle 过渡 hook 不得执行");

  acquisition.release();
  // 原语义(HEAD): idle 过渡 hook 仅在非 force 心跳执行, force(processNow)不得执行;
  // 但 pending 消息仍由 force run 处理。
  await runtime.processNow();
  assert.equal(idleHooks, baselineIdleHooks, "force 心跳不得执行 idle 过渡 hook(恢复原语义)");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0, "释放后 pending 消息被处理");

  // 非 force 心跳(idle 到期)恢复执行 idle 过渡 hook。
  // 先排空清除占用期间 gated run 遗留的周期计时器(600s): 不依赖 run() 入口排空
  // (agent-heartbeat-runtime 恢复 HEAD 行为后 processNow 不再清陈旧计时器),
  // 使新 schedule(0) 可被直接观察。
  await runtime.flushAll();
  runtime.ingestEvent(textEvent("session-2", "om_idle_after_release", "hello"));
  await waitFor(() => idleHooks > baselineIdleHooks, 3000);
  await runtime.flushAll();
});

test("clear 期间 ingestEvent 只入库标记 pending, 不进入 loop 也不产生输出; 释放后当轮可处理全部 pending 会话", async () => {
  const agentLoopRuntime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(agentLoopRuntime);
  const logLines: string[] = [];
  let ticks = 0;
  let loopStarts = 0;
  let sends = 0;
  const { runtime, store } = makeRuntime({
    agentLoopRuntime,
    logLines,
    onHeartbeatTick() {
      ticks += 1;
    },
    onChatLoopStarted() {
      loopStarts += 1;
    },
    onOutputSend() {
      sends += 1;
    }
  });

  await waitFor(() => ticks > 0);
  await runtime.flushAll();

  const acquisition = requireMainAgentClearAcquisition(contract.beginClearSession({ kind: "talk", sessionId: "talk-1" }));
  const stored = store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "pre_existing",
    conversationId: "session-2",
    senderId: "user",
    senderRole: "user",
    contentType: "text",
    contentText: "pre-existing pending",
    contentJson: "{}",
    createdAt: "2026-05-26T00:00:00.000Z",
    lastEventAt: "2026-05-26T00:00:00.000Z",
    coreProcessedAt: undefined
  });
  assert.ok(stored.id > 0, "预置 pending 消息入库成功");

  runtime.ingestEvent(textEvent("session-1", "om_pending_only", "hello"));
  await sleep(80);

  assert.equal(loopStarts, 0, "清除期间新消息不得进入 loop");
  assert.equal(sends, 0, "清除期间不得投递任何 AgentOutput");
  const pending = store.listUnprocessedCoreMessagesForConversation("session-1", 10);
  assert.equal(pending.length, 1, "清除期间消息必须已入库(未处理)" );
  assert.equal(pending[0]?.contentText, "hello", "入库消息内容正确");
  assert.equal(runtime.getStatus().pendingSessions.length, 2, "新会话与预置 pending 会话均保持 pending 标记(store 既有 pending 恢复)");

  acquisition.release();
  // 原语义(HEAD): 一次 run 逐个处理全部 pending 会话(无 break), 释放后当轮开启两个 loop。
  await runtime.processNow();
  assert.equal(loopStarts, 2, "释放后当轮可处理全部 pending 会话(每会话一个 loop)");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0, "释放后新会话消息标记为已处理");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-2", 10).length, 0, "释放后预置 pending 会话消息也标记为已处理");
  await runtime.flushAll();
});

test("force_wake 先进入 clearing 占用: clear 成功前不切 waiting 且 heartbeat 不运行", async () => {
  const agentLoopRuntime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(agentLoopRuntime);
  const logLines: string[] = [];
  const setStateRecords: string[] = [];
  let ticks = 0;
  let loopStarts = 0;
  let onForceWakeCalls = 0;
  let busyAtClearEntry: boolean | undefined;
  let releaseClear: (() => void) | undefined;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  const { runtime, store } = makeRuntime({
    agentLoopRuntime,
    logLines,
    setStateRecords,
    onHeartbeatTick() {
      ticks += 1;
    },
    onChatLoopStarted() {
      loopStarts += 1;
    },
    onForceWake() {
      onForceWakeCalls += 1;
    },
    clearLLMSession() {
      busyAtClearEntry = contract.isMainAgentBusy(); // 先占用、后清除
      return clearGate;
    }
  });

  await waitFor(() => ticks > 0);
  const baselineTicks = ticks;
  await runtime.flushAll();

  const wake = runtime.ingestEvent(textEvent("session-1", "om_force_wake", "/force_wake"));
  await tick();

  assert.deepEqual(setStateRecords, [], "force_wake 清除成功前不得切换到 waiting");
  assert.equal(busyAtClearEntry, true, "force_wake 清除启动前必须已进入 clearing 占用(先占用、后清除)");
  assert.equal(contract.isMainAgentBusy(), true, "清除 pending 期间 Main Agent 必须占用");

  // 清除 pending 期间: 新消息只入库 pending; clearing 占用不得放行 heartbeat。
  runtime.ingestEvent(textEvent("session-1", "om_hello_during_clear", "hello"));
  await sleep(80);
  assert.equal(loopStarts, 0, "清除期间消息不得进入 loop");
  assert.equal(ticks, baselineTicks, "清除期间 heartbeat 不得执行任务");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 1, "清除期间消息保持 pending");

  releaseClear?.();
  await wake;
  await waitFor(() => onForceWakeCalls === 1);
  assert.deepEqual(setStateRecords, ["waiting:force_wake"], "force_wake 清除成功后才切换 waiting 并清除 sleep cocoon");
  assert.equal(onForceWakeCalls, 1, "清除成功后才继续唤醒流程");
  assert.equal(contract.isMainAgentBusy(), false, "唤醒流程结束后必须释放占用");

  await runtime.processNow();
  assert.equal(loopStarts, 1, "释放后 pending 消息可被处理");
  await runtime.flushAll();
});

test("force_wake 清除失败: 不继续唤醒、占用释放、错误记录", async () => {
  const agentLoopRuntime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(agentLoopRuntime);
  const logLines: string[] = [];
  const setStateRecords: string[] = [];
  let onForceWakeCalls = 0;
  const { runtime } = makeRuntime({
    agentLoopRuntime,
    logLines,
    setStateRecords,
    onForceWake() {
      onForceWakeCalls += 1;
    },
    clearLLMSession() {
      return Promise.reject(new Error("short memory worker boom"));
    }
  });

  runtime.ingestEvent(textEvent("session-1", "om_force_wake_fail", "/force_wake"));
  await waitFor(() => logLines.some((line) => line.includes("force wake llm session clear failed")), 3000);
  await tick();

  assert.equal(onForceWakeCalls, 0, "清除失败不得继续唤醒流程(§10: 失败阻止后续 loop)");
  assert.deepEqual(setStateRecords, [], "清除失败不得切换 waiting 或清除 sleep cocoon");
  assert.equal(contract.isMainAgentBusy(), false, "清除失败后占用必须释放");
  assert.equal(
    logLines.some((line) => line.includes("force wake llm session clear failed") && line.includes("short memory worker boom")),
    true,
    "清除失败必须记录错误日志"
  );
  await runtime.flushAll();
});

test("force_wake 获取 clearing 占用失败时不改变 Agent 状态", async () => {
  const agentLoopRuntime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(agentLoopRuntime);
  const occupied = requireMainAgentClearAcquisition(contract.beginClearSession({ kind: "talk", sessionId: "talk-1" }));
  const logLines: string[] = [];
  const setStateRecords: string[] = [];
  let clearCalls = 0;
  const { runtime } = makeRuntime({
    agentLoopRuntime,
    logLines,
    setStateRecords,
    clearLLMSession() {
      clearCalls += 1;
    }
  });

  await runtime.ingestEvent(textEvent("session-1", "om_force_wake_busy", "/force_wake"));

  assert.deepEqual(setStateRecords, [], "占用失败不得切换 waiting 或清除 sleep cocoon");
  assert.equal(clearCalls, 0, "占用失败不得进入会话清除");
  assert.equal(logLines.some((line) => line.includes("force wake skipped: main agent busy")), true);
  occupied.release();
  await runtime.flushAll();
});

test("clearing 占用期间 processNow(force) 返回 0: 不进入 pending/manual 分支、不产生失败通知", async () => {
  const agentLoopRuntime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(agentLoopRuntime);
  const logLines: string[] = [];
  let loopStarts = 0;
  let sends = 0;
  const { runtime, store } = makeRuntime({
    agentLoopRuntime,
    logLines,
    onChatLoopStarted() {
      loopStarts += 1;
    },
    onOutputSend() {
      sends += 1;
    },
    getProcessNowTarget: () => ({
      plugin: "feishu",
      accountId: "main",
      channelId: "chat",
      userId: "user",
      sessionId: "session-1"
    })
  });

  const acquisition = requireMainAgentClearAcquisition(contract.beginClearSession({ kind: "chat", sessionId: "session-1" }));
  runtime.ingestEvent(textEvent("session-1", "om_force_gate", "hello"));
  await sleep(80);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 1, "清除期间消息已入库 pending");

  // force(processNow)不得绕过 Main Agent 互斥: 不进入 pending 分支(runChatEvent)与
  // manual 分支(runManualSession), 消息保持 pending, 不产生虚假失败通知(问题 2)。
  await runtime.processNow();
  await sleep(80);

  assert.equal(loopStarts, 0, "clearing 占用期间 force processNow 不得进入 pending 分支(runChatEvent 不得执行)");
  assert.equal(sends, 0, "clearing 占用期间 force processNow 不得进入 manual 分支(不得产生失败通知)");
  assert.equal(
    logLines.some((line) => line.includes("chat session processing from message log")),
    false,
    "clearing 占用期间 pending 会话不得进入处理流程"
  );
  assert.equal(
    logLines.some((line) => line.includes("manual process now")),
    false,
    "clearing 占用期间 manual 分支不得执行"
  );
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 1, "clearing 占用期间消息保持 pending 不进入 loop");

  acquisition.release();
  assert.equal(contract.isMainAgentBusy(), false);
  await runtime.processNow();
  assert.equal(loopStarts, 1, "释放后 force processNow 恢复正常处理 pending 会话");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0, "释放后消息标记为已处理");
  await runtime.flushAll();
});

test("门控来自 activity 占用而非状态监听器 await(fire-and-forget 监听器场景)", async () => {
  const agentLoopRuntime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(agentLoopRuntime);
  const logLines: string[] = [];
  let ticks = 0;
  let loopStarts = 0;
  const { runtime, syncTriggerStateListener } = makeRuntime({
    agentLoopRuntime,
    logLines,
    onHeartbeatTick() {
      ticks += 1;
    },
    onChatLoopStarted() {
      loopStarts += 1;
    },
    // 测试边界显式注入同步成功 fake：监听器不因 clear Promise 阻塞，schedule 立即发生。
    clearLLMSession() {}
  });

  await waitFor(() => ticks > 0);
  const baselineTicks = ticks;
  // 仅排空计时器; 监听器引用在构造时已同步捕获, flushAll 的退订不影响直接触发。
  await runtime.flushAll();

  const acquisition = requireMainAgentClearAcquisition(contract.beginClearSession({ kind: "chat", sessionId: "session-1" }));
  assert.equal(contract.isMainAgentBusy(), true);

  // 监听器 await 的 clear 同步完成并直接 schedule(0)。若门控依赖监听器等待窗口则此处必然放行;
  // 契约: 门控必须来自 activity 占用, heartbeat 不得执行任何任务。
  const listenerResult = syncTriggerStateListener();
  assert.ok(listenerResult instanceof Promise, "状态监听器是异步回调(但不等待清除)");
  await tick();
  await sleep(80);

  assert.equal(ticks, baselineTicks, "fire-and-forget 监听器调度的心跳不得执行任务(门控来自占用而非监听器)");
  assert.equal(loopStarts, 0);

  acquisition.release();
  assert.equal(contract.isMainAgentBusy(), false);
  // 排空占用期间 gated run 重新调度出的计时器(600s), 使监听器后续 schedule(0) 可观察。
  await runtime.flushAll();
  syncTriggerStateListener();
  await waitFor(() => ticks > baselineTicks);
  await runtime.flushAll();
});

test("正常运行时状态监听器已注册且能驱动心跳(既有行为不变)", async () => {
  const agentLoopRuntime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(agentLoopRuntime);
  const logLines: string[] = [];
  let ticks = 0;
  const { runtime, triggerStateListener, syncTriggerStateListener } = makeRuntime({
    agentLoopRuntime,
    logLines,
    onHeartbeatTick() {
      ticks += 1;
    }
  });

  await waitFor(() => ticks > 0);
  const baselineTicks = ticks;
  assert.equal(contract.isMainAgentBusy(), false);

  // 正常运行时监听器存在: 状态变化返回异步回调(既有行为不变)。
  assert.ok(triggerStateListener() instanceof Promise, "flushAll 前状态监听器必须已注册");
  // 排空计时器后, 监听器调度的心跳必须实际执行(runtime 可被状态变化驱动)。
  await runtime.flushAll();
  syncTriggerStateListener();
  await waitFor(() => ticks > baselineTicks, 3000);
  await runtime.flushAll();
});

test("flushAll 后状态监听器必须退订: 状态变化不再调度心跳, 已 flush 的 runtime 不复活", async () => {
  const agentLoopRuntime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(agentLoopRuntime);
  const logLines: string[] = [];
  let ticks = 0;
  const { runtime, triggerStateListener } = makeRuntime({
    agentLoopRuntime,
    logLines,
    onHeartbeatTick() {
      ticks += 1;
    }
  });

  await waitFor(() => ticks > 0, 3000);
  const baselineTicks = ticks;
  assert.ok(triggerStateListener() instanceof Promise, "flushAll 前状态监听器必须已注册(既有行为)");

  await runtime.flushAll();
  const afterFlushTicks = ticks;

  // flushAll 后监听器已退订: 状态变化不再触达 runtime(无调度)。
  const postFlushResult = triggerStateListener();
  assert.equal(postFlushResult, undefined, "flushAll 后状态监听器必须已退订(onChange 清理函数已调用)");
  await sleep(80);
  assert.equal(ticks, afterFlushTicks, "flushAll 后状态变化不得再调度心跳(已 flush 的 runtime 不得复活)");
  assert.equal(contract.isMainAgentBusy(), false);
  await runtime.flushAll();
});

test("in-flight 状态监听器(await 清除中)遇 flushAll: 清除 settle 后不得 schedule heartbeat(第四版 P3)", async () => {
  const agentLoopRuntime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(agentLoopRuntime);
  const logLines: string[] = [];
  let ticks = 0;
  const clearReasons: string[] = [];
  let releaseClear: (() => void) | undefined;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  const { runtime, syncTriggerStateListener } = makeRuntime({
    agentLoopRuntime,
    logLines,
    state: "waiting",
    onHeartbeatTick() {
      ticks += 1;
    },
    clearLLMSession(reason) {
      clearReasons.push(reason);
      return clearGate;
    }
  });

  await waitFor(() => ticks > 0);
  const baselineTicks = ticks;

  // 监听器调用在"已注册"期间启动: waiting→idle(inactive) 触发 mode_transition 清除并 await。
  const listenerRun = syncTriggerStateListener();
  assert.ok(listenerRun instanceof Promise, "waiting→idle(inactive) 必须触发异步状态监听器");
  await tick();
  assert.deepEqual(clearReasons, ["mode_transition"], "idle 过渡必须触发 mode_transition 统一清除");
  assert.equal(ticks, baselineTicks, "清除 await 中不得提前调度心跳");

  // 监听器调用已启动并 await 清除中; 此刻 flushAll 退订监听器并排空计时器。
  await runtime.flushAll();

  // 清除 settle 后监听器续行: in-flight 调用(startedWhileRegistered 为 true)在
  // 退订后不得复活已 flush 的 runtime(不得 schedule heartbeat)。
  releaseClear?.();
  await listenerRun;
  await tick();
  await sleep(80);

  assert.equal(ticks, baselineTicks, "in-flight 监听器调用在 flushAll 后 settle, 不得 schedule heartbeat(已 flush 的 runtime 不得复活)");
  assert.equal(contract.isMainAgentBusy(), false);
  await runtime.flushAll();
});

test("in-flight 状态监听器 await 的清除失败 + flushAll: 记录错误且不 schedule heartbeat(第四版 P3)", async () => {
  const agentLoopRuntime = createAgentLoopRuntime();
  const contract = asMainAgentActivityContract(agentLoopRuntime);
  const logLines: string[] = [];
  let ticks = 0;
  const { runtime, syncTriggerStateListener } = makeRuntime({
    agentLoopRuntime,
    logLines,
    state: "waiting",
    onHeartbeatTick() {
      ticks += 1;
    },
    clearLLMSession() {
      return Promise.reject(new Error("mode_transition clear failed"));
    }
  });

  await waitFor(() => ticks > 0);
  const baselineTicks = ticks;

  // 监听器调用在"已注册"期间启动并 await 清除; 清除失败立即 settle。
  const listenerRun = syncTriggerStateListener();
  assert.ok(listenerRun instanceof Promise, "waiting→idle(inactive) 必须触发异步状态监听器");
  await runtime.flushAll();
  await listenerRun;
  await tick();
  await sleep(80);

  assert.equal(
    logLines.some((line) => line.includes("idle transition llm session clear failed") && line.includes("mode_transition clear failed")),
    true,
    "清除失败必须记录错误日志(§10: 失败不得调度后续 heartbeat, 只记录错误)"
  );
  assert.equal(ticks, baselineTicks, "清除失败后不得 schedule heartbeat(已 flush 的 runtime 不得复活)");
  assert.equal(contract.isMainAgentBusy(), false);
  await runtime.flushAll();
});
