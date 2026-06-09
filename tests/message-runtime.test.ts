import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageRuntime } from "../src/contexts/conversation-hub/src/application/ingest-channel-message.js";
import { createAgentStateController, type AgentStateStore } from "../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { createAliceStore, type StoredMessageLog } from "../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { AgentEvent, AgentOutput } from "../src/contexts/agent-loop/src/contracts/agent-contracts.js";

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

test("message runtime processes inbound audio transcript while storing it as voice-marked audio", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-audio-inbound"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    startHeartbeatPaused: true,
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

  runtime.ingestEvent(audioEvent("session-1", "om_audio_1", "voice-1.opus", "[语音][0:0.020,0:5.000]  晚点见"));

  const stored = store.listMessagesForConversation("session-1", 10)[0];
  assert.equal(stored.contentType, "audio");
  assert.equal(stored.contentText, "[语音]晚点见");
  assert.equal(stored.coreProcessedAt ?? undefined, undefined);
  assert.equal(JSON.parse(stored.contentJson ?? "{}").transcript, "晚点见");

  await runtime.processNow();

  assert.equal(coreInputs.length, 1);
  assert.equal(coreInputs[0].type, "message.audio");
  assert.equal(coreInputs[0].payload.kind, "text");
  assert.doesNotMatch(coreInputs[0].payload.kind === "text" ? coreInputs[0].payload.text : "", /0:0\.020|0:5\.000/);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
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

test("message runtime can start with heartbeat paused", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-start-paused"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    startHeartbeatPaused: true,
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

  assert.equal(runtime.getStatus().heartbeatPaused, true);
  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(coreInputs.length, 0);

  runtime.resumeHeartbeat();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(coreInputs.length, 1);
});

test("message runtime reports heartbeat paused changes for env persistence", async () => {
  let persisted = true;
  const makeRuntime = (startHeartbeatPaused: boolean) => {
    const store = createAliceStore(path.join(makeTempDir("runtime-persist-heartbeat"), "alice.sqlite"));
    return createMessageRuntime({
      getDelayMs: () => 0,
      getHeartbeatIntervalMs: () => 10,
      startHeartbeatPaused,
      onHeartbeatPausedChange(paused) {
        persisted = paused;
      },
      store,
      core: {
        async handleEvent() {
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

test("message runtime queues sleep cocoon force wake event on force wake", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-force-wake-morning"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let morningEvent: AgentEvent | undefined;
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    startHeartbeatPaused: true,
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
      setState(state) {
        return { state, intimacy: 50, updatedAt: "2026-05-24T00:00:00.000Z", responseDelayMs: 0 };
      }
    },
    onForceWake() {
      morningEvent = {
        ...textEvent("session-1", "sleep_cocoon_force_wake", "force wake"),
        type: "system.heartbeat",
        meta: {
          receivedAt: "2026-05-24T08:00:00.000Z",
          raw: { sleepCocoonForceWake: true }
        }
      };
    },
    getSleepCocoonMorningEvent() {
      const event = morningEvent;
      morningEvent = undefined;
      return event;
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

  runtime.ingestEvent(textEvent("session-1", "om_force", "/force_wake"));
  runtime.resumeHeartbeat();
  await waitFor(() => coreInputs.length === 1);
  runtime.pauseHeartbeat();

  assert.equal(coreInputs[0].type, "system.heartbeat");
  assert.deepEqual(coreInputs[0].meta.raw, { sleepCocoonForceWake: true });
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

test("message runtime runs sleep cocoon morning event after wake tick", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-sleep-cocoon-wake-morning"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let current = new Date("2026-06-01T10:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    timeZone: "Asia/Shanghai",
    random: () => 0
  });
  controller.setState("sleeping", { durationMs: 1 });
  let morningEvent: AgentEvent | undefined;
  let previousState = controller.getSnapshot().state;
  controller.onChange((snapshot) => {
    if (previousState === "sleeping" && snapshot.state !== "sleeping" && snapshot.reason === "woke") {
      morningEvent = {
        ...textEvent("session-1", "sleep_cocoon_morning_after_wake", "morning"),
        type: "system.heartbeat",
        meta: {
          receivedAt: "2026-06-01T18:00:00.000",
          raw: { sleepCocoonMorning: true }
        }
      };
    }
    previousState = snapshot.state;
  });
  current = new Date("2026-06-01T10:00:00.001Z");
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    startHeartbeatPaused: true,
    now: () => current,
    agentState: controller,
    getSleepCocoonMorningEvent: () => {
      const event = morningEvent;
      morningEvent = undefined;
      return event;
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

  runtime.resumeHeartbeat();
  await waitFor(() => coreInputs.length === 1);
  runtime.pauseHeartbeat();

  assert.equal(controller.getSnapshot().state, "waiting");
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

test("message runtime applies documented state landing after processing inbound messages", async () => {
  for (const scenario of [
    { initial: "idle" as const, expected: "waiting" as const },
    { initial: "curious" as const, expected: "waiting" as const },
    { initial: "serious" as const, expected: "serious" as const },
    { initial: "test" as const, expected: "test" as const }
  ]) {
    const store = createAliceStore(path.join(makeTempDir(`runtime-state-landing-${scenario.initial}`), "alice.sqlite"));
    const controller = createAgentStateController({
      store: memoryStore(),
      random: () => 0
    });
    controller.setState(scenario.initial, { durationMs: 60_000 });
    const coreInputs: AgentEvent[] = [];
    const runtime = createMessageRuntime({
      getDelayMs: () => 0,
      startHeartbeatPaused: true,
      agentState: controller,
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

    runtime.ingestEvent(textEvent("session-1", `om_${scenario.initial}`, "hello"));
    await runtime.processNow();

    assert.equal(coreInputs.length, 1, scenario.initial);
    assert.equal(controller.getSnapshot().state, scenario.expected, scenario.initial);
  }
});

test("message runtime does not run idle no-message transition before processing inbound messages", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-idle-inbound-before-tick"), "alice.sqlite"));
  let current = new Date("2026-05-25T00:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: () => 1
  });
  controller.setState("idle", { durationMs: 1 });
  current = new Date("2026-05-25T00:00:00.001Z");
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    startHeartbeatPaused: true,
    now: () => current,
    agentState: controller,
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

  runtime.ingestEvent(textEventAt("session-1", "om_idle_due", "hello", "2026-05-25T00:00:00.001Z"));
  await runtime.processNow();

  assert.equal(coreInputs.length, 1);
  assert.equal(controller.getSnapshot().state, "waiting");
  assert.equal(controller.getSnapshot().reason, "inbound_processed");
});

test("message runtime clears LLM session when waiting degrades to idle", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-waiting-idle-clear-llm"), "alice.sqlite"));
  let current = new Date("2026-05-25T00:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: () => 0
  });
  const clearReasons: string[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    startHeartbeatPaused: true,
    now: () => current,
    agentState: controller,
    clearLLMSession(reason) {
      clearReasons.push(reason);
    },
    store,
    core: {
      async handleEvent() {
        return [];
      }
    },
    outputRouter: { async sendAll() {} },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  current = new Date("2026-05-25T00:14:59.999Z");
  await runtime.processNow();
  assert.deepEqual(clearReasons, []);
  assert.equal(controller.getSnapshot().state, "waiting");

  current = new Date("2026-05-25T00:15:00.000Z");
  await runtime.processNow();
  assert.deepEqual(clearReasons, ["mode_transition"]);
  assert.equal(controller.getSnapshot().state, "idle");
});

test("message runtime keeps going_to_sleep after processing and only postpones sleep", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-going-to-sleep-postpone"), "alice.sqlite"));
  let current = new Date("2026-05-24T16:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    timeZone: "Asia/Shanghai",
    random: () => 0
  });
  controller.setState("going_to_sleep", {
    sleepCocoonEnteredAt: "2026-05-25T00:00:00.000",
    sleepDurationMs: 8 * 60 * 60 * 1000
  });
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    startHeartbeatPaused: true,
    now: () => current,
    agentState: controller,
    store,
    core: {
      async handleEvent() {
        return [];
      }
    },
    outputRouter: { async sendAll() {} },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  current = new Date("2026-05-24T16:03:00.000Z");
  runtime.ingestEvent(textEventAt("session-1", "om_sleep", "still here", "2026-05-25T00:03:00.000"));
  await runtime.processNow();

  assert.equal(controller.getSnapshot().state, "going_to_sleep");
  assert.equal(controller.getSnapshot().lastInboundAt, "2026-05-25T00:03:00.000");
  assert.equal(controller.getSnapshot().nextTransitionAt, "2026-05-25T00:08:00.000");
  assert.equal(controller.getSnapshot().sleepCocoonEnteredAt, "2026-05-25T00:00:00.000");
  assert.equal(controller.getSnapshot().sleepDurationMs, 8 * 60 * 60 * 1000);
});

test("message runtime triggers randomized initiated behavior on eligible idle timer transition", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-randomized-idle-hit"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const sent: AgentOutput[] = [];
  let current = new Date("2026-06-06T04:00:00.000Z");
  let state = "idle" as "idle" | "waiting";
  let tickCalls = 0;
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session-1",
    senderRole: "assistant",
    contentType: "text",
    contentText: "last chat",
    createdAt: "2026-06-06T00:00:00.000Z",
    createdAtUtc: "2026-06-06T00:00:00.000Z"
  });
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    startHeartbeatPaused: true,
    now: () => current,
    random: randomQueue([0.49, 0]),
    getProcessNowTarget: () => ({
      plugin: "feishu",
      accountId: "main",
      channelId: "chat",
      userId: "user",
      sessionId: "session-1"
    }),
    agentState: {
      canReplyToInbound: () => true,
      canRunHeartbeat: () => true,
      getInboundDelayMs: () => 0,
      getSnapshot() {
        return {
          state,
          intimacy: 50,
          updatedAt: current.toISOString(),
          nextTransitionAt: current.toISOString(),
          responseDelayMs: 0
        };
      },
      tick() {
        tickCalls += 1;
        return { state, intimacy: 50, updatedAt: current.toISOString(), responseDelayMs: 0 };
      },
      setState(nextState: any) {
        state = nextState as "idle" | "waiting";
        return { state, intimacy: 50, updatedAt: current.toISOString(), responseDelayMs: 0, reason: "randomized_initiated_behavior" };
      },
      onChange: () => () => {},
      noteInboundMessage() {
        return { state, intimacy: 50, updatedAt: current.toISOString(), responseDelayMs: 0 };
      }
    },
    store,
    core: {
      async handleEvent(event) {
        coreInputs.push(event);
        return [textOutput("session-1", "checking in")];
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

  runtime.resumeHeartbeat();
  await waitFor(() => coreInputs.length === 1);
  runtime.pauseHeartbeat();

  assert.equal(coreInputs[0].type, "system.heartbeat");
  assert.equal(coreInputs[0].payload.kind, "text");
  assert.equal(coreInputs[0].payload.kind === "text" ? coreInputs[0].payload.text : "", "A randomized proactive event was triggered. Use messaging tools to inspect context before sending a short, low-interruption message.");
  assert.deepEqual(coreInputs[0].meta.raw, {
    agentInitiatedBehaviorId: "care",
    randomizedInitiatedBehavior: true
  });
  assert.equal(tickCalls, 0);
  assert.equal(state, "waiting");
  assert.equal(sent.length, 1);
  assert.equal(store.listMessagesForConversation("session-1", 10).filter((entry) => entry.direction === "outbound").length, 2);
});

test("message runtime does not trigger randomized initiated behavior when probability misses", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-randomized-idle-miss"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let current = new Date("2026-06-06T02:00:00.000Z");
  let state = "idle" as "idle" | "waiting";
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session-1",
    senderRole: "assistant",
    contentType: "text",
    contentText: "last chat",
    createdAt: "2026-06-06T00:00:00.000Z",
    createdAtUtc: "2026-06-06T00:00:00.000Z"
  });
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    startHeartbeatPaused: true,
    now: () => current,
    random: randomQueue([0.25]),
    getProcessNowTarget: () => ({ plugin: "feishu", channelId: "chat", userId: "user", sessionId: "session-1" }),
    agentState: idleTransitionState(() => state, (next) => { state = next; }, () => current, 60_000),
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

  runtime.resumeHeartbeat();
  await new Promise((resolve) => setTimeout(resolve, 40));
  runtime.pauseHeartbeat();

  assert.equal(coreInputs.length, 0);
});

test("message runtime skips randomized initiated behavior while pending inbound exists", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-randomized-pending"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let current = new Date("2026-06-06T04:00:00.000Z");
  let state = "idle" as "idle" | "waiting";
  const runtime = createMessageRuntime({
    getDelayMs: () => 60_000,
    getHeartbeatIntervalMs: () => 10,
    startHeartbeatPaused: true,
    now: () => current,
    random: randomQueue([0]),
    getProcessNowTarget: () => ({ plugin: "feishu", channelId: "chat", userId: "user", sessionId: "session-1" }),
    agentState: idleTransitionState(() => state, (next) => { state = next; }, () => current, 60_000),
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

  runtime.ingestEvent(textEventAt("session-1", "om_pending_random", "pending", "2026-06-06T04:00:00.000Z"));
  runtime.resumeHeartbeat();
  await new Promise((resolve) => setTimeout(resolve, 40));
  runtime.pauseHeartbeat();

  assert.equal(coreInputs.length, 0);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 1);
});

test("message runtime skips randomized initiated behavior without target or message history", async () => {
  for (const scenario of [
    { name: "no-target", insertHistory: true, getTarget: undefined },
    { name: "no-history", insertHistory: false, getTarget: () => ({ plugin: "feishu", channelId: "chat", userId: "user", sessionId: "session-1" }) }
  ]) {
    const store = createAliceStore(path.join(makeTempDir(`runtime-randomized-${scenario.name}`), "alice.sqlite"));
    const coreInputs: AgentEvent[] = [];
    let current = new Date("2026-06-06T04:00:00.000Z");
    let state = "idle" as "idle" | "waiting";
    if (scenario.insertHistory) {
      store.insertOutboundMessage({
        plugin: "feishu",
        conversationId: "session-1",
        senderRole: "assistant",
        contentType: "text",
        contentText: "last chat",
        createdAt: "2026-06-06T00:00:00.000Z",
        createdAtUtc: "2026-06-06T00:00:00.000Z"
      });
    }
    const runtime = createMessageRuntime({
      getDelayMs: () => 0,
      getHeartbeatIntervalMs: () => 10,
      startHeartbeatPaused: true,
      now: () => current,
      random: randomQueue([0, 0]),
      getProcessNowTarget: scenario.getTarget,
      agentState: idleTransitionState(() => state, (next) => { state = next; }, () => current),
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

    runtime.resumeHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 40));
    runtime.pauseHeartbeat();

    assert.equal(coreInputs.length, 0, scenario.name);
  }
});

test("message runtime evaluates randomized initiated behavior only once per idle timer transition", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-randomized-once"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let current = new Date("2026-06-06T04:00:00.000Z");
  let state = "idle" as "idle" | "waiting";
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session-1",
    senderRole: "assistant",
    contentType: "text",
    contentText: "last chat",
    createdAt: "2026-06-06T00:00:00.000Z",
    createdAtUtc: "2026-06-06T00:00:00.000Z"
  });
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    startHeartbeatPaused: true,
    now: () => current,
    random: randomQueue([0, 0, 0, 0]),
    getProcessNowTarget: () => ({ plugin: "feishu", channelId: "chat", userId: "user", sessionId: "session-1" }),
    agentState: idleTransitionState(() => state, (next) => { state = next; }, () => current),
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

  runtime.resumeHeartbeat();
  await waitFor(() => coreInputs.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  runtime.pauseHeartbeat();

  assert.equal(coreInputs.length, 1);
});

test("message runtime processes all currently unprocessed messages for a session in one turn", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-process-all"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    startHeartbeatPaused: true,
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

  for (let i = 0; i < 75; i += 1) {
    runtime.ingestEvent(textEvent("session-1", `om_many_${i}`, `message ${i}`));
  }
  await runtime.processNow();

  assert.equal(coreInputs.length, 1);
  assert.equal(coreInputs[0].meta.replyTo, "om_many_74");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 100).length, 0);
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

function audioEvent(sessionId: string, rawMessageId: string, assetId: string, transcript: string): AgentEvent {
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
    type: "message.audio",
    payload: { kind: "audio", assetId, transcript },
    meta: {
      receivedAt: "2026-05-24T00:00:00.000Z",
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
  const dir = path.join(process.cwd(), ".tmp-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function memoryStore(initial?: string): AgentStateStore & { content?: string } {
  return {
    content: initial,
    read() {
      return this.content;
    },
    write(content) {
      this.content = content;
    }
  };
}

function randomQueue(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

function idleTransitionState(
  getState: () => "idle" | "waiting",
  setState: (state: "idle" | "waiting") => void,
  getNow: () => Date,
  inboundDelayMs = 0
) {
  return {
    canReplyToInbound: () => true,
    canRunHeartbeat: () => true,
    getInboundDelayMs: () => inboundDelayMs,
    getSnapshot() {
      return {
        state: getState(),
        intimacy: 50,
        updatedAt: getNow().toISOString(),
        nextTransitionAt: getNow().toISOString(),
        responseDelayMs: 0
      };
    },
    tick() {
      if (getState() === "idle") {
        setState("waiting");
        return { state: "waiting" as const, intimacy: 50, updatedAt: getNow().toISOString(), responseDelayMs: 0, reason: "idle_timer" };
      }
      return { state: getState(), intimacy: 50, updatedAt: getNow().toISOString(), responseDelayMs: 0 };
    },
    setState(state: any) {
      setState(state as "idle" | "waiting");
      return { state: getState(), intimacy: 50, updatedAt: getNow().toISOString(), responseDelayMs: 0, reason: "randomized_initiated_behavior" };
    },
    onChange: () => () => {},
    noteInboundMessage() {
      return { state: getState(), intimacy: 50, updatedAt: getNow().toISOString(), responseDelayMs: 0 };
    }
  };
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
