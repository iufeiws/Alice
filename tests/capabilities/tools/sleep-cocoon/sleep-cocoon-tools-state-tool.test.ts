import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentStateController } from "../../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";
import { createSleepCocoonTools } from "../../../../src/capabilities/tools/sleep-cocoon/src/index.js";
import type { AgentOutput } from "../../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { memoryStore } from "./sleep-cocoon-tools-helpers.js";

function noticeStore(stored: unknown[] = []) {
  return {
    insertOutboundMessage(input: unknown) {
      stored.push(input);
      return { id: stored.length };
    },
    markOutboundMessageSent() {},
    markOutboundMessageFailed() {}
  };
}

test("sleep_cocoon schema exposes in and out actions", () => {
  const tools = createSleepCocoonTools({
    agentState: createAgentStateController({ store: memoryStore() }),
    time: createCurrentTimeProvider("UTC")
  });
  const tool = tools.listTools()[0];

  assert.equal(tool.name, "sleep_cocoon");
  assert.deepEqual((tool.inputSchema.properties as Record<string, { enum?: string[] }>).action.enum, ["in", "out"]);
  assert.equal((tool.inputSchema.properties as Record<string, { type?: string }>).hours.type, "integer");
  assert.deepEqual(tool.inputSchema.required, ["action"]);
});

test("sleep_cocoon in enters going_to_sleep and stores sleep pointers", async () => {
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => new Date("2026-05-25T00:00:00.000Z"),
    random: () => 0
  });
  const tools = createSleepCocoonTools({
    agentState: controller,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-25T00:00:00.000Z")),
    random: () => 0.5
  });

  const result = await tools.execute({ id: "call_in", toolName: "sleep_cocoon", input: { action: "in", hours: 8 } });
  const snapshot = controller.getSnapshot();

  assert.equal(result.ok, true);
  assert.equal(snapshot.state, "going_to_sleep");
  assert.equal(snapshot.reason, "sleep_cocoon_in");
  assert.equal(snapshot.sleepCocoonEnteredAt, "2026-05-25T00:00:00.000");
  assert.equal(snapshot.sleepCocoonEnteredAtUtc, "2026-05-25T00:00:00.000Z");
  assert.equal(snapshot.sleepDurationMs, 8 * 60 * 60 * 1000);
});

test("sleep_cocoon in clears previous auto trigger pointers", async () => {
  const controller = createAgentStateController({
    store: memoryStore(JSON.stringify({
      state: "waiting",
      intimacy: 50,
      updatedAt: "2026-05-24T00:00:00.000",
      responseDelayMs: 1000,
      sleepCocoonAutoCheckedAt: "2026-05-24T22:00:00.000"
    })),
    now: () => new Date("2026-05-25T00:00:00.000Z"),
    random: () => 0
  });
  const tools = createSleepCocoonTools({
    agentState: controller,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-25T00:00:00.000Z")),
    random: () => 0
  });

  await tools.execute({ id: "call_in_reset", toolName: "sleep_cocoon", input: { action: "in" } });

  assert.equal(controller.getSnapshot().sleepCocoonAutoCheckedAt, undefined);
});

test("sleep_cocoon in does not send a system sleep notice", async () => {
  const sent: AgentOutput[] = [];
  const stored: unknown[] = [];
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => new Date("2026-05-25T00:00:00.000Z"),
    random: () => 0
  });
  const tools = createSleepCocoonTools({
    agentState: controller,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-25T00:00:00.000Z")),
    store: noticeStore(stored),
    outputRouter: {
      async send(output) {
        sent.push(output);
      }
    },
    random: () => 0
  });

  const result = await tools.execute({
    id: "call_in_notice",
    toolName: "sleep_cocoon",
    input: { action: "in" },
    requester: { plugin: "feishu", accountId: "account-1", channelId: "chat-1", userId: "user-1" },
    externalSession: { scope: "dm", sessionId: "session-1" }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(sent, []);
  assert.deepEqual(stored, []);
});

test("sleep_cocoon in rejects repeated entry while going_to_sleep", async () => {
  const sent: AgentOutput[] = [];
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => new Date("2026-05-25T00:00:00.000Z"),
    random: () => 0
  });
  controller.setState("going_to_sleep", {
    sleepCocoonEnteredAt: "2026-05-25T00:00:00.000",
    sleepDurationMs: 8 * 60 * 60 * 1000
  });
  const tools = createSleepCocoonTools({
    agentState: controller,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-25T01:00:00.000Z")),
    outputRouter: {
      async send(output) {
        sent.push(output);
      }
    }
  });

  const result = await tools.execute({ id: "call_in_again", toolName: "sleep_cocoon", input: { action: "in" } });

  assert.equal(result.ok, false);
  assert.equal(controller.getSnapshot().state, "going_to_sleep");
  assert.equal(controller.getSnapshot().sleepCocoonEnteredAt, "2026-05-25T00:00:00.000");
  assert.equal(sent.length, 0);
});

test("sleep_cocoon out returns going_to_sleep to waiting", async () => {
  const controller = createAgentStateController({
    store: memoryStore(),
    random: () => 0
  });
  controller.setState("going_to_sleep", {
    sleepCocoonEnteredAt: "2026-05-25T00:00:00.000",
    sleepDurationMs: 8 * 60 * 60 * 1000
  });
  const tools = createSleepCocoonTools({
    agentState: controller,
    time: createCurrentTimeProvider("UTC")
  });

  const result = await tools.execute({ id: "call_out", toolName: "sleep_cocoon", input: { action: "out" } });
  const snapshot = controller.getSnapshot();

  assert.equal(result.ok, true);
  assert.equal(snapshot.state, "waiting");
  assert.equal(snapshot.reason, "sleep_cocoon_out");
  assert.equal(snapshot.sleepCocoonEnteredAt, undefined);
  assert.equal(snapshot.sleepDurationMs, undefined);
});

test("sleep_cocoon out does not send a system wake notice", async () => {
  const sent: AgentOutput[] = [];
  const stored: unknown[] = [];
  const controller = createAgentStateController({
    store: memoryStore(),
    random: () => 0
  });
  controller.setState("going_to_sleep", {
    sleepCocoonEnteredAt: "2026-05-25T00:00:00.000",
    sleepDurationMs: 8 * 60 * 60 * 1000
  });
  const tools = createSleepCocoonTools({
    agentState: controller,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-25T08:00:00.000Z")),
    store: noticeStore(stored),
    outputRouter: {
      async send(output) {
        sent.push(output);
      }
    }
  });

  const result = await tools.execute({
    id: "call_out_notice",
    toolName: "sleep_cocoon",
    input: { action: "out" },
    requester: { plugin: "wechat", channelId: "room-1", userId: "user-1" },
    externalSession: { scope: "group", sessionId: "session-2" }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(sent, []);
  assert.deepEqual(stored, []);
});

test("sleep_cocoon out does not wake sleeping state", async () => {
  const controller = createAgentStateController({
    store: memoryStore(),
    random: () => 0
  });
  controller.setState("sleeping");
  const tools = createSleepCocoonTools({
    agentState: controller,
    time: createCurrentTimeProvider("UTC")
  });

  const result = await tools.execute({ id: "call_out_sleeping", toolName: "sleep_cocoon", input: { action: "out" } });

  assert.equal(result.ok, false);
  assert.equal(controller.getSnapshot().state, "sleeping");
});
