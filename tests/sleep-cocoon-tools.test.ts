import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentStateController, type AgentStateStore } from "../core/agent/src/state.js";
import { createCurrentTimeProvider } from "../core/time/src/index.js";
import { createSleepCocoonTools, resolveSleepDurationMs } from "../plugins/sleep-cocoon/src/index.js";

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
