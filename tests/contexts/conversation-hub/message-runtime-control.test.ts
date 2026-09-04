import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageRuntime } from "../../../src/contexts/conversation-hub/src/application/ingest-channel-message.js";
import { createAliceStore } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { AgentEvent, AgentOutput } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { makeTempDir, textEvent, textOutput, waitFor } from "./message-runtime-helpers.js";
import { createAgentLoopRuntime } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import { createControlCommandRuntime } from "../../../src/contexts/control-command/src/index.js";

const path = await import("node:path");

test("messageRuntime_chatAgentFailure_marksBatchFailedAndDoesNotRetry", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-fail"), "alice.sqlite"));
  let coreCalls = 0;
  const logs: string[] = [];
  const sent: AgentOutput[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    getHeartbeatIntervalMs: () => 10,
    clearLLMSession() {},
    store,
    chatAgent: {
      async prepareEventRun() {
        coreCalls += 1;
        throw new Error("llm failed", {
          cause: Object.assign(new Error("provider stream terminated"), { code: "UND_ERR_SOCKET" })
        });
      }
    },
    outputRouter: {
      async sendAll(outputs) {
        sent.push(...outputs);
      }
    },
    appendLog(_level, message) {
      logs.push(message);
    },
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  await waitFor(() => coreCalls === 1 && sent.length === 1);

  assert.equal(coreCalls, 1);
  assert.equal(sent[0].content.kind, "text");
  if (sent[0].content.kind !== "text") throw new Error("expected text failure notice");
  assert.equal(sent[0].content.text, "<-Error: llm failed | provider stream terminated->");
  assert.doesNotMatch(sent[0].content.text, /星界信号丢失/);
  assert.equal(store.listMessagesForConversation("session-1", 10).at(-1)?.senderRole, "system");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
  const failedLog = store.listMessageLogs(20).find((entry) => entry.status === "core_failed");
  assert.ok(failedLog?.error);
  assert.equal(logs.length > 0, true);
});

test("messageRuntime_manualProcessFailure_sendsConcreteError", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-manual-fail"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    clearLLMSession() {},
    getProcessNowTarget: () => ({
      plugin: "feishu",
      accountId: "main",
      channelId: "chat",
      userId: "user",
      sessionId: "session-1"
    }),
    store,
    chatAgent: {
      async prepareEventRun() {
        throw new Error("LLM request failed: 503 Service Unavailable {\"error\":{\"type\":\"server_error\",\"message\":\"Error from provider (Console Go): Upstream request failed: Endpoint is unavailable.\"}}");
      }
    },
    outputRouter: {
      async sendAll(outputs) {
        sent.push(...outputs);
      }
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.pauseHeartbeat();
  await runtime.processNow();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].content.kind, "text");
  if (sent[0].content.kind !== "text") throw new Error("expected text failure notice");
  assert.equal(sent[0].content.text, "<-Error: LLM request failed: 503 Service Unavailable | Error from provider (Console Go): Upstream request failed: Endpoint is unavailable.->");
  assert.doesNotMatch(sent[0].content.text, /星界信号丢失/);
});

test("messageRuntime_heartbeatPaused_processesPendingOnDemand", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-pause"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    clearLLMSession() {},
    store,
    chatAgent: {
      async prepareEventRun(event) {
        coreInputs.push(event);
        return [];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.pauseHeartbeat();
  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));

  assert.equal(coreInputs.length, 0);
  assert.equal(runtime.getStatus().heartbeatPaused, true);
  assert.deepEqual(runtime.getStatus().pendingSessions, ["session-1"]);

  await runtime.processNow();
  assert.equal(coreInputs.length, 1);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
});

test("messageRuntime_startHeartbeatPaused_keepsPendingUntilResume", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-start-paused"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    startHeartbeatPaused: true,
    clearLLMSession() {},
    store,
    chatAgent: {
      async prepareEventRun(event) {
        coreInputs.push(event);
        return [];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  assert.equal(runtime.getStatus().heartbeatPaused, true);
  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  assert.equal(coreInputs.length, 0);
  assert.deepEqual(runtime.getStatus().pendingSessions, ["session-1"]);

  runtime.resumeHeartbeat();
  await waitFor(() => coreInputs.length === 1);
  assert.equal(coreInputs.length, 1);
});

test("messageRuntime_heartbeatPausedChange_reportsForEnvPersistence", async () => {
  let persisted = true;
  const makeRuntime = (startHeartbeatPaused: boolean) => {
    const store = createAliceStore(path.join(makeTempDir("runtime-persist-heartbeat"), "alice.sqlite"));
    return createMessageRuntime({
      getDelayMs: () => 0,
      getHeartbeatIntervalMs: () => 10,
      clearLLMSession() {},
      startHeartbeatPaused,
      onHeartbeatPausedChange(paused) {
        persisted = paused;
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
      appendLog() {},
      appendMessageLog(input) {
        return store.insertMessageLog({ time: new Date().toISOString(), ...input });
      }
    });
  };

  const first = makeRuntime(true);
  assert.equal(first.getStatus().heartbeatPaused, true);
  first.resumeHeartbeat();
  assert.equal(persisted, false);

  const restarted = makeRuntime(persisted);
  assert.equal(restarted.getStatus().heartbeatPaused, false);

  restarted.pauseHeartbeat();
  assert.equal(persisted, true);

  const restartedAgain = makeRuntime(persisted);
  assert.equal(restartedAgain.getStatus().heartbeatPaused, true);
});

test("messageRuntime_processNowWithoutPending_startsManualLlmSession", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-process-now-empty"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    clearLLMSession() {},
    getProcessNowTarget: () => ({
      plugin: "feishu",
      accountId: "main",
      channelId: "chat",
      userId: "user",
      sessionId: "session-1"
    }),
    store,
    chatAgent: {
      async prepareEventRun(event) {
        coreInputs.push(event);
        return [];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.pauseHeartbeat();
  await runtime.processNow();

  assert.equal(coreInputs.length, 1);
  assert.equal(coreInputs[0].externalSession.sessionId, "session-1");
  assert.equal(coreInputs[0].source.plugin, "feishu");
  assert.deepEqual(runtime.getStatus().pendingSessions, []);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
});

test("messageRuntime_periodicHeartbeat_processesStoredInbound", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-recover"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user",
    contentType: "text",
    contentText: "recover me",
    createdAt: "2026-05-24T00:00:00.000Z"
  });
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    clearLLMSession() {},
    store,
    chatAgent: {
      async prepareEventRun(event) {
        coreInputs.push(event);
        return [textOutput("session-1", "ok")];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  await waitFor(() => coreInputs.length === 1);

  assert.equal(coreInputs[0].meta.replyTo, "om_1");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
});

test("messageRuntime_persistedWechatConversation_recoversUserId", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-recover-wechat"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "wechat",
    externalMessageId: "wx_1",
    conversationId: "wechat:dm:wx-user",
    senderId: "wx-user",
    contentType: "text",
    contentText: "recover wechat",
    createdAt: "2026-05-24T00:00:00.000Z"
  });
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    clearLLMSession() {},
    store,
    chatAgent: {
      async prepareEventRun(event) {
        coreInputs.push(event);
        return [];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  await waitFor(() => coreInputs.length === 1);

  assert.equal(coreInputs[0].source.plugin, "wechat");
  assert.equal(coreInputs[0].source.channelId, "wx-user");
  assert.equal(coreInputs[0].source.userId, "wx-user");
  assert.equal(coreInputs[0].externalSession.sessionId, "wechat:dm:wx-user");
});

test("messageRuntime_lifecycleEvents_recordsStateUpdatesWithoutChatAgent", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-lifecycle"), "alice.sqlite"));
  let handled = 0;
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    clearLLMSession() {},
    store,
    chatAgent: {
      async prepareEventRun() {
        handled += 1;
        return [];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  await waitFor(() => handled === 1);
  runtime.ingestLifecycle({
    kind: "reaction.created",
    plugin: "feishu",
    externalMessageId: "om_1",
    actorId: "ou_other",
    emoji: "thumbsup",
    occurredAt: "2026-05-24T00:01:00.000Z"
  });
  runtime.ingestLifecycle({
    kind: "message.read",
    plugin: "feishu",
    externalMessageId: "om_1",
    occurredAt: "2026-05-24T00:02:00.000Z"
  });
  await waitFor(() => Boolean(store.listMessagesForConversation("session-1", 10).find((entry) => entry.externalMessageId === "om_1")?.isRead));

  assert.equal(handled, 1);
  const message = store.listMessagesForConversation("session-1", 10).find((entry) => entry.externalMessageId === "om_1");
  assert.ok(message);
  assert.equal(Boolean(message.isRead), true);
  assert.deepEqual(JSON.parse(message.reactionsJson), { thumbsup: { count: 1, users: ["ou_other"] } });
});

test("messageRuntime_forceWakeCommand_setsWaitingAndSkipsChatAgent", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-force-wake"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const states: string[] = [];
  const clearedReasons: string[] = [];
  const agentLoopRuntime = createAgentLoopRuntime();
  const agentState = {
    canReplyToInbound: () => true,
    canRunHeartbeat: () => true,
    tick() {
      return { state: "waiting" as const, intimacy: 50, updatedAt: "2026-05-24T00:00:00.000Z", responseDelayMs: 0 };
    },
    getSnapshot() {
      return { state: "waiting" as const, intimacy: 50, updatedAt: "2026-05-24T00:00:00.000Z", responseDelayMs: 0 };
    },
    getInboundDelayMs: () => 0,
    onChange: () => () => {},
    noteInboundMessage() {
      return { state: "waiting" as const, intimacy: 50, updatedAt: "2026-05-24T00:00:00.000Z", responseDelayMs: 0 };
    },
    setState(state: "waiting", options?: { reason?: string; clearSleepCocoon?: boolean }) {
      states.push(`${state}:${options?.reason ?? ""}:${options?.clearSleepCocoon === true ? "clear" : "keep"}`);
      return { state, intimacy: 50, updatedAt: "2026-05-24T00:00:00.000Z", responseDelayMs: 0 };
    }
  };
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    agentState,
    agentLoopRuntime,
    controlCommandRuntime: createControlCommandRuntime({
      agentLoopRuntime,
      agentState,
      clearLLMSession(reason) {
        clearedReasons.push(reason);
      },
      appendLog() {}
    }),
    store,
    chatAgent: {
      async prepareEventRun(event) {
        coreInputs.push(event);
        return [];
      }
    },
    outputRouter: { async sendAll() {} },
    clearLLMSession(reason) {
      clearedReasons.push(reason);
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEvent("session-1", "om_force", "/force_wake"));
  await waitFor(() => states.length === 1);

  assert.deepEqual(states, ["waiting:force_wake:clear"]);
  assert.deepEqual(clearedReasons, ["force_wake"]);
  assert.equal(coreInputs.length, 0);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
});

test("messageRuntime_forceClearCommand_skipsConversationHistoryAndChatAgent", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-force-clear"), "alice.sqlite"));
  const agentLoopRuntime = createAgentLoopRuntime();
  const coreInputs: AgentEvent[] = [];
  const clearedReasons: string[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    agentLoopRuntime,
    controlCommandRuntime: createControlCommandRuntime({
      agentLoopRuntime,
      clearLLMSession(reason) {
        clearedReasons.push(reason);
      },
      appendLog() {}
    }),
    clearLLMSession() {},
    store,
    chatAgent: {
      async prepareEventRun(event) {
        coreInputs.push(event);
        return [];
      }
    },
    outputRouter: { async sendAll() {} },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  await runtime.ingestEvent(textEvent("session-1", "om_force_clear", "/force_clear"));

  assert.deepEqual(clearedReasons, ["force_clear"]);
  assert.equal(coreInputs.length, 0);
  assert.equal(store.listMessagesForConversation("session-1", 10).length, 0);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
  await runtime.flushAll();
});
