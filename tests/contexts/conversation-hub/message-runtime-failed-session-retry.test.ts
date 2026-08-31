import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageRuntime } from "../../../src/contexts/conversation-hub/src/application/ingest-channel-message.js";
import { createAgentStateController } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { createAliceStore } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { makeTempDir, memoryStore, textEvent, textOutput, waitFor } from "./message-runtime-helpers.js";

const path = await import("node:path");

test("failed agent session retries at waiting state switch before clearing the session", async () => {
  let current = new Date("2026-08-24T00:00:00.000Z");
  const agentState = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: () => 0
  });
  const store = createAliceStore(path.join(makeTempDir("failed-session-state-retry"), "alice.sqlite"));
  const clearReasons: string[] = [];
  const sentTexts: string[] = [];
  let attempts = 0;
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    startHeartbeatPaused: true,
    now: () => current,
    agentState,
    clearLLMSession(reason) {
      clearReasons.push(reason);
    },
    store,
    chatAgent: {
      async prepareEventRun(event) {
        attempts += 1;
        agentState.restartInactivityTimer();
        if (attempts === 1) throw new Error("upstream stream aborted");
        return [textOutput(event.externalSession.sessionId, "retry succeeded")];
      }
    },
    outputRouter: {
      async sendAll(outputs) {
        for (const output of outputs) {
          if (output.content.kind === "text") sentTexts.push(output.content.text);
        }
      }
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: current.toISOString(), ...input });
    }
  });

  await runtime.ingestEvent(textEvent("session-1", "om_retry", "hello"));
  await runtime.processNow();
  assert.equal(attempts, 1);
  assert.equal(agentState.getSnapshot().state, "waiting");

  current = new Date(`${agentState.getSnapshot().nextTransitionAt}Z`);
  await runtime.processNow();

  assert.equal(attempts, 2, "到达 waiting 状态切换点时必须重试现有 session");
  assert.equal(agentState.getSnapshot().state, "waiting", "本次 state switch 必须退出");
  assert.deepEqual(clearReasons, [], "重试时不得清除 LLM session");
  assert.equal(sentTexts.includes("retry succeeded"), true);

  current = new Date(`${agentState.getSnapshot().nextTransitionAt}Z`);
  await runtime.processNow();
  await waitFor(() => clearReasons.length === 1);

  assert.equal(agentState.getSnapshot().state, "idle");
  assert.deepEqual(clearReasons, ["mode_transition"]);
  await runtime.flushAll();
});

test("failed retry keeps the flag and postpones the next waiting state switch", async () => {
  let current = new Date("2026-08-24T00:00:00.000Z");
  const agentState = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: () => 0
  });
  const store = createAliceStore(path.join(makeTempDir("failed-session-repeat-retry"), "alice.sqlite"));
  const clearReasons: string[] = [];
  let attempts = 0;
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    startHeartbeatPaused: true,
    now: () => current,
    agentState,
    clearLLMSession(reason) {
      clearReasons.push(reason);
    },
    store,
    chatAgent: {
      async prepareEventRun(event) {
        attempts += 1;
        agentState.restartInactivityTimer();
        if (attempts <= 2) throw new Error("upstream stream aborted");
        return [textOutput(event.externalSession.sessionId, "retry succeeded")];
      }
    },
    outputRouter: { async sendAll() {} },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: current.toISOString(), ...input });
    }
  });

  await runtime.ingestEvent(textEvent("session-1", "om_repeat_retry", "hello"));
  await runtime.processNow();

  current = new Date(`${agentState.getSnapshot().nextTransitionAt}Z`);
  await runtime.processNow();
  const retryDeadline = agentState.getSnapshot().nextTransitionAt;

  assert.equal(attempts, 2);
  assert.equal(agentState.getSnapshot().state, "waiting");
  assert.deepEqual(clearReasons, []);
  assert.ok(retryDeadline);
  assert.ok(Date.parse(`${retryDeadline}Z`) > current.getTime(), "失败 settlement 必须重置切换倒计时");

  current = new Date(`${retryDeadline}Z`);
  await runtime.processNow();

  assert.equal(attempts, 3, "失败 flag 必须保留到下一次状态切换点");
  assert.equal(agentState.getSnapshot().state, "waiting");
  assert.deepEqual(clearReasons, []);
  await runtime.flushAll();
});

test("failed retry appends newly pending messages once and marks them processed after recovery", async () => {
  let current = new Date("2026-08-24T00:00:00.000Z");
  const agentState = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: () => 0
  });
  const store = createAliceStore(path.join(makeTempDir("failed-session-new-pending"), "alice.sqlite"));
  const retryPendingIds: number[][] = [];
  const appendAfterFailureFlags: Array<boolean | undefined> = [];
  let attempts = 0;
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    startHeartbeatPaused: true,
    now: () => current,
    agentState,
    clearLLMSession() {},
    store,
    chatAgent: {
      async prepareEventRun(event, options) {
        attempts += 1;
        appendAfterFailureFlags.push(options?.appendSessionContextAfterFailedRequest);
        const raw = event.meta.raw as { pendingIds?: number[] } | undefined;
        retryPendingIds.push(raw?.pendingIds ?? []);
        agentState.restartInactivityTimer();
        if (attempts <= 2) throw new Error("upstream stream aborted");
        return [textOutput(event.externalSession.sessionId, "retry succeeded")];
      }
    },
    outputRouter: { async sendAll() {} },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: current.toISOString(), ...input });
    }
  });

  await runtime.ingestEvent(textEvent("session-1", "om_r", "R"));
  await runtime.processNow();
  await runtime.ingestEvent(textEvent("session-1", "om_i1", "I1"));
  await runtime.ingestEvent(textEvent("session-1", "om_i2", "I2"));
  const pendingBeforeRetry = store.listUnprocessedCoreMessagesForConversation("session-1", 10);
  assert.deepEqual(pendingBeforeRetry.map((message) => message.contentText), ["I1", "I2"]);

  await runtime.processNow();

  assert.deepEqual(retryPendingIds[1], pendingBeforeRetry.map((message) => message.id));
  assert.equal(appendAfterFailureFlags[1], true, "首次重试必须追加失败后到达的 I1/I2");
  assert.deepEqual(
    store.listUnprocessedCoreMessagesForConversation("session-1", 10).map((message) => message.contentText),
    ["I1", "I2"],
    "重试再次失败时 I1/I2 必须保持 pending"
  );

  await runtime.processNow();

  assert.deepEqual(retryPendingIds[2], pendingBeforeRetry.map((message) => message.id));
  assert.equal(appendAfterFailureFlags[2], false, "相同失败 request 再次重试时不得重复追加 I1/I2");
  assert.deepEqual(store.listUnprocessedCoreMessagesForConversation("session-1", 10), []);
  await runtime.flushAll();
});
