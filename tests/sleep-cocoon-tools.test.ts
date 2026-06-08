import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentStateController, type AgentStateStore } from "../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";
import { createSleepCocoonTools, resolveSleepDurationMs } from "../src/tools/sleep-cocoon/src/index.js";
import type { AgentOutput } from "../src/contexts/agent-loop/src/contracts/agent-contracts.js";

test("sleep_cocoon schema exposes in and out actions with Chinese descriptions", () => {
  const tools = createSleepCocoonTools({
    agentState: createAgentStateController({ store: memoryStore() }),
    time: createCurrentTimeProvider("UTC")
  });
  const tool = tools.listTools()[0];

  assert.equal(tool.name, "sleep_cocoon");
  assert.match(tool.description, /睡眠茧/);
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

  assert.equal(result.ok, true);
  assert.equal(result.resetLLMSession, true);
  assert.equal(result.fixedPrefixKind, "sleep_cocoon");
  assert.equal(result.fixedPrefixTtlMs, 2 * 60 * 60 * 1000);
  assert.equal(controller.getSnapshot().state, "going_to_sleep");
  assert.equal(controller.getSnapshot().reason, "sleep_cocoon_in");
  assert.equal(controller.getSnapshot().sleepCocoonEnteredAt, "2026-05-25T00:00:00.000");
  assert.equal(controller.getSnapshot().sleepDurationMs, 8 * 60 * 60 * 1000);
});

test("sleep_cocoon in caches the preparation boundary in state until sleep starts", async () => {
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => new Date("2026-05-25T01:00:00.000Z"),
    random: () => 0
  });
  const tools = createSleepCocoonTools({
    agentState: controller,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-25T01:00:00.000Z")),
    random: () => 0
  });

  await tools.execute({ id: "call_in_boundary", toolName: "sleep_cocoon", input: { action: "in" } });

  assert.equal(controller.getSnapshot().sleepCocoonEnteredAt, "2026-05-25T01:00:00.000");
  assert.equal(controller.getSnapshot().sleepCocoonEnteredAtUtc, "2026-05-25T01:00:00.000Z");
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

test("sleep_cocoon in sends non-persisted sleep notice to current chat", async () => {
  const sent: AgentOutput[] = [];
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => new Date("2026-05-25T00:00:00.000Z"),
    random: () => 0
  });
  const tools = createSleepCocoonTools({
    agentState: controller,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-25T00:00:00.000Z")),
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
    session: { scope: "dm", sessionId: "session-1" }
  });

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target.plugin, "feishu");
  assert.equal(sent[0].target.accountId, "account-1");
  assert.equal(sent[0].target.channelId, "chat-1");
  assert.equal(sent[0].target.userId, "user-1");
  assert.equal(sent[0].target.sessionId, "session-1");
  assert.deepEqual(sent[0].content, { kind: "text", text: "-少女就寝中-" });
});

test("sleep_cocoon duration uses requested integer hours plus fifteen minute jitter", () => {
  assert.equal(resolveSleepDurationMs(8, () => 0), 7.75 * 60 * 60 * 1000);
  assert.equal(resolveSleepDurationMs(8, () => 1), 8.25 * 60 * 60 * 1000);
});

test("sleep_cocoon default duration is between six and eight hours", () => {
  assert.equal(resolveSleepDurationMs(undefined, () => 0), 6 * 60 * 60 * 1000);
  assert.equal(resolveSleepDurationMs(undefined, () => 1), 8 * 60 * 60 * 1000);
  assert.equal(resolveSleepDurationMs(undefined, () => 0.123), Math.round((6 + 0.246) * 60 * 60 * 1000));
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

  assert.equal(result.ok, true);
  assert.equal(result.resetLLMSession, true);
  assert.equal(result.clearFixedPrefix, true);
  assert.equal(result.invalidateLLMSession, true);
  assert.equal(controller.getSnapshot().state, "waiting");
  assert.equal(controller.getSnapshot().reason, "sleep_cocoon_out");
  assert.equal(controller.getSnapshot().sleepCocoonEnteredAt, undefined);
  assert.equal(controller.getSnapshot().sleepDurationMs, undefined);
});

test("sleep_cocoon out sends non-persisted wake notice to current chat", async () => {
  const sent: AgentOutput[] = [];
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
    session: { scope: "group", sessionId: "session-2" }
  });

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target.plugin, "wechat");
  assert.equal(sent[0].target.channelId, "room-1");
  assert.equal(sent[0].target.userId, "user-1");
  assert.equal(sent[0].target.sessionId, "session-2");
  assert.deepEqual(sent[0].content, { kind: "text", text: "-少女起床-" });
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
  assert.equal(result.error, "already sleeping");
  assert.equal(controller.getSnapshot().state, "sleeping");
});

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
