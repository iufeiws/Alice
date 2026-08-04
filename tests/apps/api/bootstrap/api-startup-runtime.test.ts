import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiStartupRuntime } from "../../../../src/apps/api/bootstrap/api-startup-runtime.js";

test("API startup resumes an interrupted restart tool round before recovering ordinary pending messages", async () => {
  const events: string[] = [];
  const config = {
    core: { heartbeatPaused: false },
    plugins: { feishu: { enabled: false, accounts: {} }, wechat: { enabled: false } }
  } as any;
  const runtime = createApiStartupRuntime({
    config,
    runtimeState: { feishuStarted: false, wechatStarted: false },
    chatAgent: {
      async start() {
        events.push("agent-started");
      }
    },
    scheduler: {
      start() {
        events.push("scheduler-started");
      }
    },
    messageRuntime: {
      pauseHeartbeat() {
        events.push("heartbeat-paused");
        config.core.heartbeatPaused = true;
      },
      async recoverProcessRestartContinuation() {
        events.push("restart-resumed");
      },
      recoverPendingSessions() {
        events.push("pending-recovered");
      },
      resumeHeartbeat() {
        events.push("heartbeat-resumed");
      }
    },
    appendLog() {}
  });

  await runtime.start();

  assert.deepEqual(events, [
    "heartbeat-paused",
    "agent-started",
    "restart-resumed",
    "scheduler-started",
    "pending-recovered",
    "heartbeat-resumed"
  ]);
});

test("API startup always resumes heartbeat after startup even when a stale pause is persisted", async () => {
  const events: string[] = [];
  const logs: string[] = [];
  const config = {
    core: { heartbeatPaused: true },
    plugins: { feishu: { enabled: false, accounts: {} }, wechat: { enabled: false } }
  } as any;
  const runtime = createApiStartupRuntime({
    config,
    runtimeState: { feishuStarted: false, wechatStarted: false },
    chatAgent: {
      async start() {
        events.push("agent-started");
      }
    },
    scheduler: {
      start() {
        events.push("scheduler-started");
      }
    },
    messageRuntime: {
      pauseHeartbeat() {
        events.push("heartbeat-paused");
      },
      async recoverProcessRestartContinuation() {
        events.push("restart-resumed");
      },
      recoverPendingSessions() {
        events.push("pending-recovered");
      },
      resumeHeartbeat() {
        events.push("heartbeat-resumed");
      }
    },
    appendLog(level, message) {
      logs.push(`${level}:${message}`);
    }
  });

  await runtime.start();

  assert.deepEqual(events, [
    "heartbeat-paused",
    "agent-started",
    "restart-resumed",
    "scheduler-started",
    "pending-recovered",
    "heartbeat-resumed"
  ]);
  assert.ok(logs.some((entry) => entry.includes("discarded stale heartbeat pause")));
});
