import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageRuntime } from "../apps/api/src/message-runtime.js";
import { createAliceStore, type StoredMessageLog } from "../packages/storage/src/sqlite-store.js";
import type { AgentEvent, AgentOutput } from "../packages/types/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("message runtime sends one LLM request for pending inbound logs and marks them processed", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const typingEvents: Array<{ plugin: string; sessionId: string; typing: boolean }> = [];
  const outputs: AgentOutput[] = [textOutput("session-1", "ok")];
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    store,
    core: {
      async handleEvent(event) {
        coreInputs.push(event);
        return outputs;
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    async setTypingIndicator(input) {
      typingEvents.push({ plugin: input.plugin, sessionId: input.sessionId, typing: input.typing });
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  runtime.ingestEvent(textEvent("session-1", "om_2", "world"));
  await waitFor(() => coreInputs.length === 1);

  assert.equal(coreInputs[0].payload.kind, "text");
  assert.ok(coreInputs[0].payload.kind === "text");
  if (coreInputs[0].payload.kind === "text") {
    assert.equal(coreInputs[0].payload.text, "A chat message event was received. Use messaging tools to inspect conversation history before replying.");
    assert.doesNotMatch(coreInputs[0].payload.text, /hello|world/);
  }
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
  assert.equal(store.listMessagesForConversation("session-1", 10).filter((entry) => entry.direction === "outbound").length, 1);
  assert.deepEqual(typingEvents, [
    { plugin: "feishu", sessionId: "session-1", typing: true },
    { plugin: "feishu", sessionId: "session-1", typing: false }
  ]);
});

test("message runtime uses agent state delay and records inbound activity", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-state-delay"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let inboundActivity = 0;
  const runtime = createMessageRuntime({
    getDelayMs: () => 10_000,
    agentState: {
      canReplyToInbound: () => true,
      canRunHeartbeat: () => true,
      tick() {
        return {
          state: "waiting",
          intimacy: 50,
          updatedAt: "2026-05-24T00:00:00.000Z",
          responseDelayMs: 10
        };
      },
      getInboundDelayMs: () => 10,
      onChange: () => () => {},
      noteInboundMessage() {
        inboundActivity += 1;
        return {
          state: "waiting",
          intimacy: 50,
          updatedAt: "2026-05-24T00:00:00.000Z",
          responseDelayMs: 10
        };
      }
    },
    store,
    core: {
      async handleEvent(event) {
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

  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  await waitFor(() => coreInputs.length === 1);

  assert.equal(inboundActivity, 1);
});

test("message runtime heartbeat waits until latest pending message exceeds saved state delay", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-heartbeat-delay"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let current = new Date("2026-05-24T00:00:00.000Z");
  const runtime = createMessageRuntime({
    getDelayMs: () => 10_000,
    getHeartbeatIntervalMs: () => 10,
    now: () => current,
    agentState: {
      canReplyToInbound: () => true,
      canRunHeartbeat: () => true,
      tick() {
        return {
          state: "waiting",
          intimacy: 50,
          updatedAt: current.toISOString(),
          responseDelayMs: 10_000
        };
      },
      getInboundDelayMs: () => 10_000,
      onChange: () => () => {},
      noteInboundMessage() {
        return {
          state: "waiting",
          intimacy: 50,
          updatedAt: current.toISOString(),
          responseDelayMs: 10_000
        };
      }
    },
    store,
    core: {
      async handleEvent(event) {
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

  runtime.ingestEvent(textEventAt("session-1", "om_1", "hello", current.toISOString()));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(coreInputs.length, 0);

  current = new Date("2026-05-24T00:00:10.000Z");
  await waitFor(() => coreInputs.length === 1);
});

test("message runtime heartbeat does not count delay while state cannot reply", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-away-gate"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let canReply = false;
  let onStateChange: (() => void) | undefined;
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    getHeartbeatIntervalMs: () => 10,
    now: () => new Date("2026-05-24T01:00:00.000Z"),
    agentState: {
      canReplyToInbound: () => canReply,
      canRunHeartbeat: () => canReply,
      tick() {
        return {
          state: canReply ? "waiting" : "away",
          intimacy: 50,
          updatedAt: "2026-05-24T01:00:00.000Z",
          responseDelayMs: 10
        };
      },
      getInboundDelayMs: () => 10,
      onChange(listener) {
        onStateChange = () => listener({
          state: canReply ? "waiting" : "away",
          intimacy: 50,
          updatedAt: "2026-05-24T01:00:00.000Z",
          responseDelayMs: 10
        });
        return () => {
          onStateChange = undefined;
        };
      },
      noteInboundMessage() {
        return {
          state: canReply ? "waiting" : "away",
          intimacy: 50,
          updatedAt: "2026-05-24T01:00:00.000Z",
          responseDelayMs: 10
        };
      }
    },
    store,
    core: {
      async handleEvent(event) {
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

  runtime.ingestEvent(textEventAt("session-1", "om_1", "hello", "2026-05-24T00:00:00.000Z"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(coreInputs.length, 0);

  canReply = true;
  onStateChange?.();
  await waitFor(() => coreInputs.length === 1);
});

test("message runtime heartbeat waits while another llm session is active", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-active-llm-gate"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let llmActive = true;
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    isLLMSessionActive: () => llmActive,
    store,
    core: {
      async handleEvent(event) {
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

  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(coreInputs.length, 0);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 1);

  llmActive = false;
  await waitFor(() => coreInputs.length === 1);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
});

test("message runtime flushAll stops heartbeat without force-processing pending inbound", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-flush-gated"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    getHeartbeatIntervalMs: () => 10,
    now: () => new Date("2026-05-24T01:00:00.000Z"),
    agentState: {
      canReplyToInbound: () => false,
      canRunHeartbeat: () => false,
      tick() {
        return {
          state: "sleeping",
          intimacy: 50,
          updatedAt: "2026-05-24T01:00:00.000Z",
          responseDelayMs: 10
        };
      },
      getInboundDelayMs: () => 10,
      onChange: () => () => {},
      noteInboundMessage() {
        return {
          state: "sleeping",
          intimacy: 50,
          updatedAt: "2026-05-24T01:00:00.000Z",
          responseDelayMs: 10
        };
      }
    },
    store,
    core: {
      async handleEvent(event) {
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

  runtime.ingestEvent(textEventAt("session-1", "om_1", "hello", "2026-05-24T00:00:00.000Z"));
  await runtime.flushAll();

  assert.equal(coreInputs.length, 0);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 1);
});

test("message runtime marks inbound core failed and does not retry the same batch", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-fail"), "alice.sqlite"));
  let coreCalls = 0;
  const logs: string[] = [];
  const sent: AgentOutput[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    getHeartbeatIntervalMs: () => 10,
    store,
    core: {
      async handleEvent() {
        coreCalls += 1;
        throw new Error("llm failed");
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
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(coreCalls, 1);
  assert.equal(sent[0].content.kind === "text" ? sent[0].content.text : "", "-星界信号丢失-");
  assert.equal(store.listMessagesForConversation("session-1", 10).at(-1)?.senderRole, "system");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
  assert.ok(store.listMessageLogs(20).some((entry) => entry.status === "core_failed" && entry.error === "llm failed"));
  assert.ok(logs.some((message) => message.includes("marked 1 inbound message(s) processed as failed")));
});

test("message runtime can pause heartbeat and process pending messages on demand", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-pause"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    store,
    core: {
      async handleEvent(event) {
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
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(coreInputs.length, 0);
  assert.equal(runtime.getStatus().heartbeatPaused, true);
  assert.deepEqual(runtime.getStatus().pendingSessions, ["session-1"]);

  await runtime.processNow();
  assert.equal(coreInputs.length, 1);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
});

test("message runtime processNow starts a manual LLM session without pending messages", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-process-now-empty"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getProcessNowTarget: () => ({
      plugin: "feishu",
      accountId: "main",
      channelId: "chat",
      userId: "user",
      sessionId: "session-1"
    }),
    store,
    core: {
      async handleEvent(event) {
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
  assert.equal(coreInputs[0].session.sessionId, "session-1");
  assert.equal(coreInputs[0].source.plugin, "feishu");
  assert.deepEqual(runtime.getStatus().pendingSessions, []);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
});

test("message runtime can recover pending sessions from storage", async () => {
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
    store,
    core: {
      async handleEvent(event) {
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

  runtime.recoverPendingSessions();
  await waitFor(() => coreInputs.length === 1);

  assert.equal(coreInputs[0].meta.replyTo, "om_1");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
});

test("message runtime recovers wechat user id from persisted conversation id", async () => {
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
    store,
    core: {
      async handleEvent(event) {
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

  runtime.recoverPendingSessions();
  await waitFor(() => coreInputs.length === 1);

  assert.equal(coreInputs[0].source.plugin, "wechat");
  assert.equal(coreInputs[0].source.channelId, "wx-user");
  assert.equal(coreInputs[0].source.userId, "wx-user");
  assert.equal(coreInputs[0].session.sessionId, "wechat:dm:wx-user");
});

test("message runtime records lifecycle events as message state updates without core handling", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-lifecycle"), "alice.sqlite"));
  let handled = 0;
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    store,
    core: {
      async handleEvent() {
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
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(handled, 1);
  const message = store.listMessagesForConversation("session-1", 10).find((entry) => entry.externalMessageId === "om_1");
  assert.ok(message);
  assert.equal(Boolean(message.isRead), true);
  assert.deepEqual(JSON.parse(message.reactionsJson), { thumbsup: { count: 1, users: ["ou_other"] } });
});

test("message runtime handles force wake without calling core", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-force-wake"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const states: string[] = [];
  const clearedReasons: string[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    agentState: {
      canReplyToInbound: () => true,
      canRunHeartbeat: () => true,
      tick() {
        return { state: "waiting", intimacy: 50, updatedAt: "2026-05-24T00:00:00.000Z", responseDelayMs: 0 };
      },
      getInboundDelayMs: () => 0,
      onChange: () => () => {},
      noteInboundMessage() {
        return { state: "waiting", intimacy: 50, updatedAt: "2026-05-24T00:00:00.000Z", responseDelayMs: 0 };
      },
      setState(state, options) {
        states.push(`${state}:${options?.reason ?? ""}:${options?.clearSleepCocoon === true ? "clear" : "keep"}`);
        return { state, intimacy: 50, updatedAt: "2026-05-24T00:00:00.000Z", responseDelayMs: 0 };
      }
    },
    store,
    core: {
      async handleEvent(event) {
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
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(states, ["waiting:force_wake:clear"]);
  assert.deepEqual(clearedReasons, ["force_wake"]);
  assert.equal(coreInputs.length, 0);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
});

test("message runtime can run sleep cocoon morning event on heartbeat", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-sleep-cocoon-morning"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    getSleepCocoonMorningEvent: () => ({
      ...textEvent("session-1", "sleep_cocoon_morning", "morning"),
      type: "system.heartbeat",
      meta: {
        receivedAt: "2026-05-24T08:00:00.000Z",
        raw: { sleepCocoonMorning: true }
      }
    }),
    store,
    core: {
      async handleEvent(event) {
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

  await waitFor(() => coreInputs.length === 1);
  runtime.pauseHeartbeat();

  assert.equal(coreInputs[0].type, "system.heartbeat");
  assert.deepEqual(coreInputs[0].meta.raw, { sleepCocoonMorning: true });
});

test("message runtime can run sleep cocoon goodnight event on heartbeat", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-sleep-cocoon-goodnight"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    getSleepCocoonGoodnightEvent: () => ({
      ...textEvent("session-1", "sleep_cocoon_goodnight", "goodnight"),
      type: "system.heartbeat",
      meta: {
        receivedAt: "2026-05-24T00:00:00.000Z",
        raw: { sleepCocoonGoodnight: true }
      }
    }),
    store,
    core: {
      async handleEvent(event) {
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

  await waitFor(() => coreInputs.length === 1);
  runtime.pauseHeartbeat();

  assert.equal(coreInputs[0].type, "system.heartbeat");
  assert.deepEqual(coreInputs[0].meta.raw, { sleepCocoonGoodnight: true });
});

test("message runtime does not count sleep cocoon goodnight when generated session fails", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-sleep-cocoon-goodnight-fail"), "alice.sqlite"));
  let attempts = 0;
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    getSleepCocoonGoodnightEvent: () => attempts === 0 ? {
      ...textEvent("session-1", "sleep_cocoon_goodnight", "goodnight"),
      type: "system.heartbeat",
      meta: {
        receivedAt: "2026-05-24T00:00:00.000Z",
        raw: { sleepCocoonGoodnight: true }
      }
    } : undefined,
    store,
    core: {
      async handleEvent() {
        attempts += 1;
        throw new Error("llm down");
      }
    },
    outputRouter: { async sendAll() {} },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  await waitFor(() => attempts === 1);
  runtime.pauseHeartbeat();

  assert.equal(attempts, 1);
});

test("message runtime does not run sleep cocoon goodnight while user messages are pending", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-sleep-cocoon-goodnight-pending"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let goodnightChecks = 0;
  let armed = false;
  const runtime = createMessageRuntime({
    getDelayMs: () => 60_000,
    getHeartbeatIntervalMs: () => 10,
    now: () => new Date("2026-05-24T00:00:00.000Z"),
    getSleepCocoonGoodnightEvent: () => {
      if (!armed) return undefined;
      goodnightChecks += 1;
      return {
        ...textEvent("session-1", "sleep_cocoon_goodnight", "goodnight"),
        type: "system.heartbeat",
        meta: {
          receivedAt: "2026-05-24T00:00:00.000Z",
          raw: { sleepCocoonGoodnight: true }
        }
      };
    },
    store,
    core: {
      async handleEvent(event) {
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
  runtime.pauseHeartbeat();
  armed = true;

  runtime.ingestEvent(textEvent("session-1", "om_pending", "new message"));
  runtime.resumeHeartbeat();
  await new Promise((resolve) => setTimeout(resolve, 30));
  runtime.pauseHeartbeat();

  assert.equal(goodnightChecks, 0);
  assert.equal(coreInputs.length, 0);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 1);
});

function textEvent(sessionId: string, rawMessageId: string, text: string): AgentEvent {
  return textEventAt(sessionId, rawMessageId, text, "2026-05-24T00:00:00.000Z");
}

function textEventAt(sessionId: string, rawMessageId: string, text: string, receivedAt: string): AgentEvent {
  return {
    id: `evt_${rawMessageId}`,
    source: {
      plugin: "feishu",
      accountId: "main",
      channelId: "chat",
      userId: "user",
      rawMessageId
    },
    session: {
      scope: "dm",
      sessionId
    },
    type: "message.text",
    payload: { kind: "text", text },
    meta: {
      receivedAt,
      replyTo: rawMessageId
    }
  };
}

function textOutput(sessionId: string, text: string): AgentOutput {
  return {
    id: "out_1",
    target: {
      plugin: "feishu",
      channelId: "chat",
      sessionId
    },
    content: { kind: "text", text },
    meta: {
      createdAt: "2026-05-24T00:00:00.000Z",
      urgency: "normal"
    }
  };
}

function makeTempDir(name: string): string {
  const dir = path.join("/tmp", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
