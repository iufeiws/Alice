import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentStateController } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { createMessageRuntime } from "../../../src/contexts/conversation-hub/src/application/ingest-channel-message.js";
import { createAliceStore } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { AgentEvent } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { makeTempDir, memoryStore, randomQueue, textEvent, textEventAt, textOutput, waitFor } from "./message-runtime-helpers.js";

const path = await import("node:path");

test("messageRuntime_forceWakeCommand_queuesSleepCocoonForceWakeEvent", async () => {
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
          raw: { agentInitiatedTriggerEvent: "sleep_cocoon.force_wake" }
        }
      };
    },
    clearLLMSession() {},
    getSleepCocoonMorningEvent() {
      const event = morningEvent;
      morningEvent = undefined;
      return event;
    },
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

  runtime.ingestEvent(textEvent("session-1", "om_force", "/force_wake"));
  runtime.resumeHeartbeat();
  await waitFor(() => coreInputs.length === 1);
  runtime.pauseHeartbeat();

  assert.equal(coreInputs[0].type, "system.heartbeat");
  assert.deepEqual(coreInputs[0].meta.raw, { agentInitiatedTriggerEvent: "sleep_cocoon.force_wake" });
});

test("messageRuntime_sleepCocoonMorningHeartbeat_runsMorningEvent", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-sleep-cocoon-morning"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    clearLLMSession() {},
    getSleepCocoonMorningEvent: () => ({
      ...textEvent("session-1", "sleep_cocoon_morning", "morning"),
      type: "system.heartbeat",
      meta: {
        receivedAt: "2026-05-24T08:00:00.000Z",
        raw: { agentInitiatedTriggerEvent: "sleep_cocoon.wake" }
      }
    }),
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

  await waitFor(() => coreInputs.length === 1);
  runtime.pauseHeartbeat();

  assert.equal(coreInputs[0].type, "system.heartbeat");
  assert.deepEqual(coreInputs[0].meta.raw, { agentInitiatedTriggerEvent: "sleep_cocoon.wake" });
});

test("messageRuntime_wakeTick_runsSleepCocoonMorningEvent", async () => {
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
          raw: { agentInitiatedTriggerEvent: "sleep_cocoon.wake" }
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
    clearLLMSession() {},
    now: () => current,
    agentState: controller,
    getSleepCocoonMorningEvent: () => {
      const event = morningEvent;
      morningEvent = undefined;
      return event;
    },
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

  assert.equal(controller.getSnapshot().state, "waiting");
  assert.equal(coreInputs[0].type, "system.heartbeat");
  assert.deepEqual(coreInputs[0].meta.raw, { agentInitiatedTriggerEvent: "sleep_cocoon.wake" });
});

test("messageRuntime_sleepCocoonGoodnightHeartbeat_runsGoodnightEvent", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-sleep-cocoon-goodnight"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    clearLLMSession() {},
    getSleepCocoonGoodnightEvent: () => ({
      ...textEvent("session-1", "sleep_cocoon_goodnight", "goodnight"),
      type: "system.heartbeat",
      meta: {
        receivedAt: "2026-05-24T00:00:00.000Z",
        raw: { agentInitiatedTriggerEvent: "sleep_cocoon.auto_goodnight_check" }
      }
    }),
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

  await waitFor(() => coreInputs.length === 1);
  runtime.pauseHeartbeat();

  assert.equal(coreInputs[0].type, "system.heartbeat");
  assert.deepEqual(coreInputs[0].meta.raw, { agentInitiatedTriggerEvent: "sleep_cocoon.auto_goodnight_check" });
});

test("messageRuntime_generatedGoodnightFailure_doesNotCountGoodnight", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-sleep-cocoon-goodnight-fail"), "alice.sqlite"));
  let attempts = 0;
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    clearLLMSession() {},
    getSleepCocoonGoodnightEvent: () => attempts === 0 ? {
      ...textEvent("session-1", "sleep_cocoon_goodnight", "goodnight"),
      type: "system.heartbeat",
      meta: {
        receivedAt: "2026-05-24T00:00:00.000Z",
        raw: { agentInitiatedTriggerEvent: "sleep_cocoon.auto_goodnight_check" }
      }
    } : undefined,
    store,
    chatAgent: {
      async prepareEventRun() {
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

test("messageRuntime_pendingUserMessages_skipsSleepCocoonGoodnight", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-sleep-cocoon-goodnight-pending"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let goodnightChecks = 0;
  let armed = false;
  const runtime = createMessageRuntime({
    getDelayMs: () => 60_000,
    getHeartbeatIntervalMs: () => 10,
    clearLLMSession() {},
    now: () => new Date("2026-05-24T00:00:00.000Z"),
    getSleepCocoonGoodnightEvent: () => {
      if (!armed) return undefined;
      goodnightChecks += 1;
      return {
        ...textEvent("session-1", "sleep_cocoon_goodnight", "goodnight"),
        type: "system.heartbeat",
        meta: {
          receivedAt: "2026-05-24T00:00:00.000Z",
          raw: { agentInitiatedTriggerEvent: "sleep_cocoon.auto_goodnight_check" }
        }
      };
    },
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
  runtime.pauseHeartbeat();
  armed = true;

  runtime.ingestEvent(textEvent("session-1", "om_pending", "new message"));
  runtime.resumeHeartbeat();
  await waitFor(() => runtime.getStatus().pendingSessions.length > 0);
  runtime.pauseHeartbeat();

  assert.equal(goodnightChecks, 0);
  assert.equal(coreInputs.length, 0);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 1);
});

test("messageRuntime_inboundProcessed_appliesDocumentedStateLanding", async () => {
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
      clearLLMSession() {},
      agentState: controller,
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

    runtime.ingestEvent(textEvent("session-1", `om_${scenario.initial}`, "hello"));
    await runtime.processNow();

    assert.equal(coreInputs.length, 1, scenario.initial);
    assert.equal(controller.getSnapshot().state, scenario.expected, scenario.initial);
  }
});

test("messageRuntime_pendingInboundBeforeIdleTick_skipsIdleNoMessageTransition", async () => {
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
    clearLLMSession() {},
    now: () => current,
    agentState: controller,
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

  runtime.ingestEvent(textEventAt("session-1", "om_idle_due", "hello", "2026-05-25T00:00:00.001Z"));
  await runtime.processNow();

  assert.equal(coreInputs.length, 1);
  assert.equal(controller.getSnapshot().state, "waiting");
  assert.equal(controller.getSnapshot().reason, "inbound_processed");
});

test("messageRuntime_waitingToIdle_clearsLlmSession", async () => {
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
    chatAgent: {
      async prepareEventRun() {
        return [];
      }
    },
    outputRouter: { async sendAll() {} },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });
  const deadline = Date.parse(`${controller.getSnapshot().nextTransitionAt}Z`);

  current = new Date(deadline - 1);
  await runtime.processNow();
  assert.deepEqual(clearReasons, []);
  assert.equal(controller.getSnapshot().state, "waiting");

  current = new Date(deadline);
  await runtime.processNow();
  assert.deepEqual(clearReasons, ["mode_transition"]);
  assert.equal(controller.getSnapshot().state, "idle");
});

test("messageRuntime_goingToSleepInbound_keepsStateAndSuspendsSleep", async () => {
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
    clearLLMSession() {},
    now: () => current,
    agentState: controller,
    store,
    chatAgent: {
      async prepareEventRun() {
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
  assert.equal(controller.getSnapshot().nextTransitionAt, undefined);
  assert.equal(controller.getSnapshot().sleepCocoonEnteredAt, "2026-05-25T00:00:00.000");
  assert.equal(controller.getSnapshot().sleepDurationMs, 8 * 60 * 60 * 1000);
});
