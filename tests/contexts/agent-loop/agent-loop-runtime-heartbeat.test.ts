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
