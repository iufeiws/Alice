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
 * MessageRuntime 的 Main Agent clearing 门控契约：状态允许运行时，clearing 仍与
 * running 同样阻止 heartbeat 派发；force processNow 也不得绕过统一占用。
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
  return { runtime, store };
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

test("clear 期间 ingestEvent 只入库；释放后每个 heartbeat tick 调度一个 pending 会话", async () => {
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
  await runtime.processNow();
  assert.equal(loopStarts, 1, "单次 heartbeat 只发起一个 Main Agent loop");
  await runtime.processNow();
  assert.equal(loopStarts, 2, "下一次 heartbeat 再发起下一个 pending 会话");
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
