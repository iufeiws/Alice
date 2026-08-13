import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentHeartbeatRuntime } from "../../../src/contexts/agent-loop/src/runtime/agent-heartbeat-runtime.js";
import { buildTimedYieldEvent } from "../../../src/contexts/conversation-hub/src/application/message-event-builders.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";

test("agent heartbeat runs a due timed Yield only when normal gates allow it", async () => {
  let allowed = false;
  let pending = false;
  let generated = 0;
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    appendLog: () => {},
    tasks: {
      canRunHeartbeat: () => allowed,
      hasPendingUserMessages: () => pending,
      getTimedYieldEvent: () => ({ type: "system.heartbeat" }),
      runGeneratedSession: async () => {
        generated += 1;
        return true;
      },
      getPendingSessionIds: () => [],
      isProcessingSession: () => false,
      beginProcessingSession: () => {},
      finishProcessingSession: () => {},
      getPendingMessageCount: () => 0,
      shouldProcessPendingSession: () => false,
      markSessionNotPending: () => {},
      processPendingSession: async () => {},
      appendLog: () => {}
    }
  });

  assert.equal(await heartbeat.run(), 0);
  allowed = true;
  pending = true;
  assert.equal(await heartbeat.run(), 0);
  pending = false;
  assert.equal(await heartbeat.run(), 1);
  assert.equal(generated, 1);
  heartbeat.flush();
});

test("timed Yield event restores its persisted target only after the deadline", () => {
  const time = createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:10.000Z"));
  const target = {
    source: { plugin: "feishu", channelId: "chat-1", userId: "user-1" },
    externalSession: { scope: "dm" as const, sessionId: "session-1" }
  };
  assert.equal(buildTimedYieldEvent({ waitChatUntil: "2026-05-26T00:00:11.000Z", waitChatTarget: target }, time), undefined);
  const event = buildTimedYieldEvent({ waitChatUntil: "2026-05-26T00:00:10.000Z", waitChatTarget: target }, time);
  assert.equal(event?.source.channelId, "chat-1");
  assert.equal(event?.externalSession.sessionId, "session-1");
  assert.equal(buildTimedYieldEvent({ waitChatTarget: target }, time), undefined);
});

test("agent heartbeat forced run owns manual session fallback", async () => {
  let pendingSessionIds = ["session-pending"];
  let pendingProcessed = 0;
  let manualProcessed = 0;
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    appendLog: () => {},
    tasks: {
      canRunHeartbeat: () => true,
      hasPendingUserMessages: () => pendingSessionIds.length > 0,
      runGeneratedSession: async () => false,
      runManualSession: async () => {
        manualProcessed += 1;
        return true;
      },
      getPendingSessionIds: () => pendingSessionIds,
      isProcessingSession: () => false,
      beginProcessingSession: () => {},
      finishProcessingSession: () => {},
      getPendingMessageCount: (sessionId) => sessionId === "session-pending" ? 1 : 0,
      shouldProcessPendingSession: () => true,
      markSessionNotPending: (sessionId) => {
        pendingSessionIds = pendingSessionIds.filter((id) => id !== sessionId);
      },
      processPendingSession: async () => {
        pendingProcessed += 1;
      },
      appendLog: () => {}
    }
  });

  assert.equal(await heartbeat.run({ force: true, runManualSessionWhenIdle: true }), 1);
  assert.equal(pendingProcessed, 1);
  assert.equal(manualProcessed, 0);

  pendingSessionIds = [];
  assert.equal(await heartbeat.run({ force: true, runManualSessionWhenIdle: true }), 1);
  assert.equal(manualProcessed, 1);
});

test("agent heartbeat runs idle timer transition hook before randomized initiated behavior", async () => {
  const calls: string[] = [];
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    appendLog: () => {},
    tasks: {
      isIdleTransitionDue: () => true,
      getIdleTransitionDelayMs: () => 123_000,
      onIdleTimerTransition: async ({ delayMs }) => {
        calls.push(`idle:${delayMs}`);
      },
      canRunHeartbeat: () => true,
      hasPendingUserMessages: () => false,
      buildRandomizedInitiatedBehaviorEvent: () => ({ type: "system.heartbeat" }),
      runGeneratedSession: async () => {
        calls.push("generated");
        return true;
      },
      setAgentWaiting: (reason) => {
        calls.push(`waiting:${reason}`);
      },
      getPendingSessionIds: () => [],
      isProcessingSession: () => false,
      beginProcessingSession: () => {},
      finishProcessingSession: () => {},
      getPendingMessageCount: () => 0,
      shouldProcessPendingSession: () => false,
      markSessionNotPending: () => {},
      processPendingSession: async () => {},
      appendLog: () => {}
    }
  });

  assert.equal(await heartbeat.run(), 1);
  assert.deepEqual(calls, ["idle:123000", "generated", "waiting:randomized_initiated_behavior"]);
});

test("agent heartbeat runs generated idle transition event without randomized behavior", async () => {
  const calls: string[] = [];
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    appendLog: () => {},
    tasks: {
      isIdleTransitionDue: () => true,
      onIdleTimerTransition: () => {
        calls.push("idle");
        return { type: "system.heartbeat" };
      },
      canRunHeartbeat: () => true,
      hasPendingUserMessages: () => false,
      buildRandomizedInitiatedBehaviorEvent: () => {
        calls.push("randomized");
        return { type: "system.heartbeat" };
      },
      runGeneratedSession: async () => {
        calls.push("generated");
        return true;
      },
      setAgentWaiting: (reason) => {
        calls.push(`waiting:${reason}`);
      },
      getPendingSessionIds: () => [],
      isProcessingSession: () => false,
      beginProcessingSession: () => {},
      finishProcessingSession: () => {},
      getPendingMessageCount: () => 0,
      shouldProcessPendingSession: () => false,
      markSessionNotPending: () => {},
      processPendingSession: async () => {},
      appendLog: () => {}
    }
  });

  assert.equal(await heartbeat.run(), 1);
  assert.deepEqual(calls, ["idle", "generated", "waiting:idle_timer_transition"]);
});

test("agent heartbeat runs calendar reminder generated event", async () => {
  const calls: string[] = [];
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    appendLog: () => {},
    tasks: {
      canRunHeartbeat: () => true,
      hasPendingUserMessages: () => false,
      getCalendarReminderEvent: () => ({ type: "system.heartbeat" }),
      runGeneratedSession: async () => {
        calls.push("calendar");
        return true;
      },
      getPendingSessionIds: () => [],
      isProcessingSession: () => false,
      beginProcessingSession: () => {},
      finishProcessingSession: () => {},
      getPendingMessageCount: () => 0,
      shouldProcessPendingSession: () => false,
      markSessionNotPending: () => {},
      processPendingSession: async () => {},
      appendLog: () => {}
    }
  });

  assert.equal(await heartbeat.run(), 1);
  assert.deepEqual(calls, ["calendar"]);
});

test("agent heartbeat treats cancelled talk runs as handled without crashing", async () => {
  const logs: Array<{ level: string; message: string }> = [];
  let markedReady = 0;
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    appendLog: (level, message) => logs.push({ level, message }),
    tasks: {
      canRunHeartbeat: () => true,
      hasPendingUserMessages: () => false,
      claimReadyTalkSession: () => 1780830000201,
      runTalkSession: async () => {
        throw new Error("llm_request_cancelled");
      },
      markTalkSessionReady: () => {
        markedReady += 1;
      },
      runGeneratedSession: async () => false,
      getPendingSessionIds: () => [],
      isProcessingSession: () => false,
      beginProcessingSession: () => {},
      finishProcessingSession: () => {},
      getPendingMessageCount: () => 0,
      shouldProcessPendingSession: () => false,
      markSessionNotPending: () => {},
      processPendingSession: async () => {},
      appendLog: (level, message) => logs.push({ level, message })
    }
  });

  assert.equal(await heartbeat.run(), 0);
  assert.equal(markedReady, 0);
  assert.equal(logs.some((entry) => entry.level === "info"), true);
});

test("agent heartbeat logs failed talk runs and requeues readiness", async () => {
  const logs: Array<{ level: string; message: string }> = [];
  let markedReady = 0;
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    appendLog: (level, message) => logs.push({ level, message }),
    tasks: {
      canRunHeartbeat: () => true,
      hasPendingUserMessages: () => false,
      claimReadyTalkSession: () => 1780830000202,
      runTalkSession: async () => {
        throw new Error("provider_failed");
      },
      markTalkSessionReady: () => {
        markedReady += 1;
      },
      runGeneratedSession: async () => false,
      getPendingSessionIds: () => [],
      isProcessingSession: () => false,
      beginProcessingSession: () => {},
      finishProcessingSession: () => {},
      getPendingMessageCount: () => 0,
      shouldProcessPendingSession: () => false,
      markSessionNotPending: () => {},
      processPendingSession: async () => {},
      appendLog: (level, message) => logs.push({ level, message })
    }
  });

  assert.equal(await heartbeat.run(), 0);
  assert.equal(markedReady, 1);
  assert.equal(logs.some((entry) => entry.level === "error"), true);
});

test("force run 不得绕过 Main Agent 互斥门控: canRunHeartbeat=false 时返回 0 且不进入任何任务分支", async () => {
  const calls: string[] = [];
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    appendLog: () => {},
    tasks: {
      isIdleTransitionDue: () => {
        calls.push("isIdleTransitionDue");
        return true;
      },
      onIdleTimerTransition: async () => {
        calls.push("onIdleTimerTransition");
        return undefined;
      },
      canRunHeartbeat: () => false, // clearing 占用: Main Agent 互斥门控关闭
      hasPendingUserMessages: () => false,
      tickAgentState: () => {
        calls.push("tickAgentState");
      },
      onHeartbeatTick: () => {
        calls.push("onHeartbeatTick");
      },
      buildRandomizedInitiatedBehaviorEvent: () => {
        calls.push("buildRandomizedInitiatedBehaviorEvent");
        return undefined;
      },
      runGeneratedSession: async () => {
        calls.push("runGeneratedSession");
        return true;
      },
      setAgentWaiting: () => {
        calls.push("setAgentWaiting");
      },
      getTimedYieldEvent: () => {
        calls.push("getTimedYieldEvent");
        return undefined;
      },
      claimReadyTalkSession: () => {
        calls.push("claimReadyTalkSession");
        return undefined;
      },
      getSleepCocoonWakeEvent: () => undefined,
      getSleepCocoonGoodnightEvent: () => undefined,
      getCalendarReminderEvent: () => undefined,
      getPendingSessionIds: () => {
        calls.push("getPendingSessionIds");
        return ["session-1"];
      },
      isProcessingSession: () => false,
      beginProcessingSession: () => {
        calls.push("beginProcessingSession");
      },
      finishProcessingSession: () => {},
      getPendingMessageCount: () => 1,
      shouldProcessPendingSession: () => true,
      markSessionNotPending: () => {
        calls.push("markSessionNotPending");
      },
      processPendingSession: async () => {
        calls.push("processPendingSession");
      },
      runManualSession: async () => {
        calls.push("runManualSession");
        return true;
      },
      appendLog: () => {}
    }
  });

  // force 只应绕过延迟、随机行为等策略, 不应绕过 Main Agent 互斥(问题 2):
  // clearing 占用期间 force(processNow 路径)必须返回 0, 不进入 pending/manual 分支。
  assert.equal(await heartbeat.run({ force: true, runManualSessionWhenIdle: true }), 0, "clearing 占用期间 force run 必须返回 0");
  assert.deepEqual(calls, [], "force run 不得进入 idle 过渡/pending/manual/随机行为等任何任务分支");
  heartbeat.flush();
});

test("force run 不执行 idle 过渡 hook(原语义); 非 force 心跳才执行", async () => {
  let idleHooks = 0;
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    appendLog: () => {},
    tasks: {
      isIdleTransitionDue: () => true,
      onIdleTimerTransition: async () => {
        idleHooks += 1;
        return undefined;
      },
      canRunHeartbeat: () => true,
      hasPendingUserMessages: () => false,
      runGeneratedSession: async () => false,
      getPendingSessionIds: () => [],
      isProcessingSession: () => false,
      beginProcessingSession: () => {},
      finishProcessingSession: () => {},
      getPendingMessageCount: () => 0,
      shouldProcessPendingSession: () => false,
      markSessionNotPending: () => {},
      processPendingSession: async () => {},
      appendLog: () => {}
    }
  });

  // 恢复原语义(HEAD): idle 过渡 hook 仅在非 force 时执行, force 不执行。
  assert.equal(await heartbeat.run({ force: true }), 0);
  assert.equal(idleHooks, 0, "force run 不得执行 idle 过渡 hook");
  assert.equal(await heartbeat.run(), 0);
  assert.equal(idleHooks, 1, "非 force 心跳执行 idle 过渡 hook");
  heartbeat.flush();
});

test("一次 heartbeat run 逐个处理全部 pending 会话(恢复原语义, 无 break)", async () => {
  const processed: string[] = [];
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    appendLog: () => {},
    tasks: {
      canRunHeartbeat: () => true,
      hasPendingUserMessages: () => processed.length < 2,
      runGeneratedSession: async () => false,
      getPendingSessionIds: () => ["session-1", "session-2"],
      isProcessingSession: () => false,
      beginProcessingSession: () => {},
      finishProcessingSession: () => {},
      getPendingMessageCount: () => 1,
      shouldProcessPendingSession: () => true,
      markSessionNotPending: () => {},
      processPendingSession: async (sessionId) => {
        processed.push(sessionId);
      },
      appendLog: () => {}
    }
  });

  // 恢复原语义(HEAD): 一次 run 逐个处理全部 pending 会话, 而不是只处理一个。
  assert.equal(await heartbeat.run(), 2, "一次 run 处理全部 pending 会话");
  assert.deepEqual(processed, ["session-1", "session-2"], "按 pending 顺序逐个处理");
  heartbeat.flush();
});
