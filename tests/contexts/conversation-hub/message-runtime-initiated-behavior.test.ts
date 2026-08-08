import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageRuntime } from "../../../src/contexts/conversation-hub/src/application/ingest-channel-message.js";
import { createAliceStore } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { AgentEvent, AgentOutput } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { idleTransitionState, makeTempDir, randomQueue, textEvent, textEventAt, textOutput, waitFor } from "./message-runtime-helpers.js";

const path = await import("node:path");

const randomizedPlans = [
  {
    id: "test_randomized",
    kind: "randomized" as const,
    enabled: true,
    weight: 1,
    priority: 0,
    promptProfilePath: "src/contexts/initiative/random-events/care.json",
    steps: [{ kind: "llm_instruction" as const, promptProfilePath: "src/contexts/initiative/random-events/care.json" }]
  }
];

test("messageRuntime_eligibleIdleTimerTransition_triggersRandomizedInitiatedBehavior", async () => {
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
    getAgentInitiatedBehaviorPlans: () => randomizedPlans,
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
    chatAgent: {
      async prepareEventRun(event) {
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
    agentInitiatedTriggerEvent: "randomized"
  });
  assert.equal(tickCalls, 0);
  assert.equal(state, "waiting");
  assert.equal(sent.length, 1);
  assert.equal(store.listMessagesForConversation("session-1", 10).filter((entry) => entry.direction === "outbound").length, 2);
});

test("messageRuntime_randomizedProbabilityMiss_skipsInitiatedBehavior", async () => {
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

  runtime.resumeHeartbeat();
  await waitFor(() => state === "waiting");
  runtime.pauseHeartbeat();

  assert.equal(coreInputs.length, 0);
});

test("messageRuntime_pendingInbound_skipsRandomizedInitiatedBehavior", async () => {
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

  runtime.ingestEvent(textEventAt("session-1", "om_pending_random", "pending", "2026-06-06T04:00:00.000Z"));
  runtime.resumeHeartbeat();
  await waitFor(() => state === "waiting");
  runtime.pauseHeartbeat();

  assert.equal(coreInputs.length, 0);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 1);
});

test("messageRuntime_missingTargetOrHistory_skipsRandomizedInitiatedBehavior", async () => {
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

    runtime.resumeHeartbeat();
    await waitFor(() => state === "waiting");
    runtime.pauseHeartbeat();

    assert.equal(coreInputs.length, 0, scenario.name);
  }
});

test("messageRuntime_sameIdleTimerTransition_evaluatesRandomizedInitiatedBehaviorOnce", async () => {
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
    getAgentInitiatedBehaviorPlans: () => randomizedPlans,
    getProcessNowTarget: () => ({ plugin: "feishu", channelId: "chat", userId: "user", sessionId: "session-1" }),
    agentState: idleTransitionState(() => state, (next) => { state = next; }, () => current),
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

  runtime.resumeHeartbeat();
  await waitFor(() => coreInputs.length === 1);
  runtime.pauseHeartbeat();

  assert.equal(coreInputs.length, 1);
});

test("messageRuntime_manyUnprocessedMessages_processesAllForSessionInOneTurn", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-process-all"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    startHeartbeatPaused: true,
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

  for (let i = 0; i < 75; i += 1) {
    runtime.ingestEvent(textEvent("session-1", `om_many_${i}`, `message ${i}`));
  }
  await runtime.processNow();

  assert.equal(coreInputs.length, 1);
  assert.equal(coreInputs[0].meta.replyTo, "om_many_74");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 100).length, 0);
});
