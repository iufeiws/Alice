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
      startGeneratedSession: () => {
        generated += 1;
        return true;
      },
      getPendingSessionIds: () => [],
      isProcessingSession: () => false,
      getPendingMessageCount: () => 0,
      shouldProcessPendingSession: () => false,
      startPendingSession: () => false,
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
      startGeneratedSession: () => false,
      startManualSession: () => {
        manualProcessed += 1;
        return true;
      },
      getPendingSessionIds: () => pendingSessionIds,
      isProcessingSession: () => false,
      getPendingMessageCount: (sessionId) => sessionId === "session-pending" ? 1 : 0,
      shouldProcessPendingSession: () => true,
      startPendingSession: () => {
        pendingProcessed += 1;
        return true;
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
      startGeneratedSession: (_event, _label, options) => {
        calls.push("generated");
        if (options?.setWaitingReasonAfter) calls.push(`waiting:${options.setWaitingReasonAfter}`);
        return true;
      },
      getPendingSessionIds: () => [],
      isProcessingSession: () => false,
      getPendingMessageCount: () => 0,
      shouldProcessPendingSession: () => false,
      startPendingSession: () => false,
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
      startGeneratedSession: (_event, _label, options) => {
        calls.push("generated");
        if (options?.setWaitingReasonAfter) calls.push(`waiting:${options.setWaitingReasonAfter}`);
        return true;
      },
      getPendingSessionIds: () => [],
      isProcessingSession: () => false,
      getPendingMessageCount: () => 0,
      shouldProcessPendingSession: () => false,
      startPendingSession: () => false,
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
      startGeneratedSession: () => {
        calls.push("calendar");
        return true;
      },
      getPendingSessionIds: () => [],
      isProcessingSession: () => false,
      getPendingMessageCount: () => 0,
      shouldProcessPendingSession: () => false,
      startPendingSession: () => false,
      appendLog: () => {}
    }
  });

  assert.equal(await heartbeat.run(), 1);
  assert.deepEqual(calls, ["calendar"]);
});

test("agent heartbeat dispatches a ready talk session without awaiting its loop", async () => {
  let dispatched = 0;
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    appendLog: () => {},
    tasks: {
      canRunHeartbeat: () => true,
      hasPendingUserMessages: () => false,
      claimReadyTalkSession: () => 1780830000201,
      startTalkSession: () => {
        dispatched += 1;
        return true;
      },
      startGeneratedSession: () => false,
      getPendingSessionIds: () => [],
      isProcessingSession: () => false,
      getPendingMessageCount: () => 0,
      shouldProcessPendingSession: () => false,
      startPendingSession: () => false,
      appendLog: () => {}
    }
  });

  assert.equal(await heartbeat.run(), 1);
  assert.equal(dispatched, 1);
});

test("agent heartbeat leaves an unaccepted talk session undispatched", async () => {
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    appendLog: () => {},
    tasks: {
      canRunHeartbeat: () => true,
      hasPendingUserMessages: () => false,
      claimReadyTalkSession: () => 1780830000202,
      startTalkSession: () => false,
      startGeneratedSession: () => false,
      getPendingSessionIds: () => [],
      isProcessingSession: () => false,
            getPendingMessageCount: () => 0,
      shouldProcessPendingSession: () => false,
      startPendingSession: () => false,
      appendLog: () => {}
    }
  });

  assert.equal(await heartbeat.run(), 0);
});

test("sleeping 状态在 tick 后立即退出，不读取消息或调度 Main Agent", async () => {
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
      canRunHeartbeat: () => false,
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
      startGeneratedSession: () => {
        calls.push("runGeneratedSession");
        return true;
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
      getPendingMessageCount: () => 1,
      shouldProcessPendingSession: () => true,
      startPendingSession: () => {
        calls.push("processPendingSession");
        return true;
      },
      startManualSession: () => {
        calls.push("runManualSession");
        return true;
      },
      appendLog: () => {}
    }
  });

  assert.equal(await heartbeat.run({ force: true, runManualSessionWhenIdle: true }), 0);
  assert.deepEqual(calls, ["tickAgentState"]);
  heartbeat.flush();
});

test("失败会话重试发生在 waiting 状态 tick 之前", async () => {
  const calls: string[] = [];
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    appendLog: () => {},
    tasks: {
      canRunHeartbeat: () => true,
      notePendingInboundMessage: () => calls.push("notePendingInboundMessage"),
      insertPendingBatchIntoActiveChat: () => false,
      isMainAgentBusy: () => false,
      startFailedSessionRetryBeforeStateSwitch: () => {
        calls.push("startFailedSessionRetryBeforeStateSwitch");
        return true;
      },
      tickAgentState: () => calls.push("tickAgentState"),
      hasPendingUserMessages: () => false,
      startGeneratedSession: () => false,
      getPendingSessionIds: () => [],
      isProcessingSession: () => false,
      getPendingMessageCount: () => 0,
      shouldProcessPendingSession: () => false,
      startPendingSession: () => false,
      appendLog: () => {}
    }
  });

  assert.equal(await heartbeat.run(), 1);
  assert.deepEqual(calls, ["notePendingInboundMessage", "startFailedSessionRetryBeforeStateSwitch"]);
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
      startGeneratedSession: () => false,
      getPendingSessionIds: () => [],
      isProcessingSession: () => false,
      getPendingMessageCount: () => 0,
      shouldProcessPendingSession: () => false,
      startPendingSession: () => false,
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

test("一次 heartbeat tick 只调度一个 pending 会话并立即返回", async () => {
  const processed: string[] = [];
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    appendLog: () => {},
    tasks: {
      canRunHeartbeat: () => true,
      hasPendingUserMessages: () => processed.length < 2,
      startGeneratedSession: () => false,
      getPendingSessionIds: () => ["session-1", "session-2"],
      isProcessingSession: () => false,
      getPendingMessageCount: () => 1,
      shouldProcessPendingSession: () => true,
      startPendingSession: (sessionId) => {
        processed.push(sessionId);
        return true;
      },
      appendLog: () => {}
    }
  });

  assert.equal(await heartbeat.run(), 1);
  assert.deepEqual(processed, ["session-1"]);
  heartbeat.flush();
});
