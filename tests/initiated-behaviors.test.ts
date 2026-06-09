import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildAgentInitiatedBehaviorMessages,
  createAgentInitiatedBehaviorRun,
  createAgentInitiatedBehaviorRunStore,
  defaultAgentInitiatedBehaviorPlans,
  resolveAgentInitiatedBehaviorAvailability,
  selectRandomizedAgentInitiatedBehaviorPlan,
  type AgentInitiatedBehaviorPlan
} from "../src/contexts/initiative/src/domain/initiated-behavior.js";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";
import type { AgentEvent, ToolCall } from "../src/contexts/agent-loop/src/contracts/agent-contracts.js";

test("initiated behavior prompt layers are rendered by enabled order", async () => {
  const filePath = path.join(process.cwd(), ".tmp-tests", `initiated-behavior-test-${process.pid}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    layers: [
      { id: "second", title: "Second", role: "user", enabled: true, content: "second {{user}}", order: 20 },
      { id: "disabled", title: "Disabled", role: "user", enabled: false, content: "disabled", order: 5 },
      { id: "first", title: "First", role: "system", enabled: true, content: "first", order: 10 }
    ]
  }));
  const plan: AgentInitiatedBehaviorPlan = {
    id: "custom",
    kind: "event",
    enabled: true,
    triggerEvent: "custom.event",
    steps: [{
      kind: "llm_instruction",
      promptProfilePath: filePath
    }]
  };
  const event = textEvent();
  const messages = await buildAgentInitiatedBehaviorMessages(plan, {
    userName: "YY",
    visibleTools: { feishu: true },
    layers: [],
    appendLayers: []
  }, {
    event,
    time: createCurrentTimeProvider("UTC")
  }, async (_layer, call) => {
    throw new Error(`unexpected tool request: ${call.toolName}`);
  });

  assert.deepEqual(messages.map((message) => `${message.role}:${message.content}`), [
    "system:first",
    "user:second YY"
  ]);
});

test("initiated behavior prompt layers execute assistant tool request layers", async () => {
  const filePath = path.join(process.cwd(), ".tmp-tests", `initiated-behavior-tool-test-${process.pid}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    layers: [
      {
        id: "fake_tool",
        title: "Fake Tool",
        role: "tool_request",
        enabled: true,
        content: "",
        thinking: "checking chat for {{user}}",
        toolName: "check_chat",
        toolCallId: "call_check_chat",
        toolArguments: "{\"target\":\"{{user}}\"}",
        order: 10
      }
    ]
  }));
  const plan: AgentInitiatedBehaviorPlan = {
    id: "custom",
    kind: "event",
    enabled: true,
    triggerEvent: "custom.event",
    steps: [{ kind: "llm_instruction", promptProfilePath: filePath }]
  };
  const toolCalls: ToolCall[] = [];
  const messages = await buildAgentInitiatedBehaviorMessages(plan, {
    userName: "YY",
    visibleTools: { feishu: true },
    layers: [],
    appendLayers: []
  }, {
    event: textEvent(),
    time: createCurrentTimeProvider("UTC")
  }, async (_layer, call) => {
    toolCalls.push(call);
    return { callId: call.id, ok: true, output: "history for YY" };
  });

  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].id, "call_check_chat");
  assert.equal(toolCalls[0].toolName, "check_chat");
  assert.deepEqual(toolCalls[0].input, { target: "YY" });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].reasoningContent, "checking chat for YY");
  assert.deepEqual(messages[0].toolCalls, [{
    id: "call_check_chat",
    type: "function",
    function: {
      name: "check_chat",
      arguments: "{\"target\":\"YY\"}"
    }
  }]);
  assert.equal(messages[1].role, "tool");
  assert.equal(messages[1].toolCallId, "call_check_chat");
  assert.equal(messages[1].content, "history for YY");
});

test("default randomized behavior plans use proactive initiation types", () => {
  const randomizedPlans = defaultAgentInitiatedBehaviorPlans.filter((plan) => plan.kind === "randomized");

  assert.deepEqual(randomizedPlans.map((plan) => ({
    id: plan.id,
    enabled: plan.enabled,
    weight: plan.weight,
    priority: plan.priority
  })), [
    { id: "ritual", enabled: false, weight: 8, priority: 0 },
    { id: "review", enabled: false, weight: 2, priority: 0 },
    { id: "story", enabled: false, weight: 1, priority: 0 },
    { id: "care", enabled: true, weight: 4, priority: 0 },
    { id: "share", enabled: false, weight: 2, priority: 0 },
    { id: "invite", enabled: false, weight: 2, priority: 0 },
    { id: "real_world_suggestion", enabled: false, weight: 2, priority: 0 }
  ]);
});

test("randomized behavior selection uses only enabled positive weight plans", () => {
  const base = defaultAgentInitiatedBehaviorPlans.find((entry) => entry.id === "care")!;
  const disabled = { ...base, id: "disabled", enabled: false, weight: 100 };
  const dryRun = { ...base, id: "dry_run", enabled: true, dryRun: true, weight: 100 };
  const zero = { ...base, id: "zero", enabled: true, weight: 0 };
  const first = { ...base, id: "first", enabled: true, dryRun: false, weight: 1 };
  const second = { ...base, id: "second", enabled: true, dryRun: false, weight: 3 };

  assert.equal(selectRandomizedAgentInitiatedBehaviorPlan([disabled, dryRun, zero], () => 0), undefined);
  assert.equal(selectRandomizedAgentInitiatedBehaviorPlan([disabled, first, second], () => 0)?.id, "first");
  assert.equal(selectRandomizedAgentInitiatedBehaviorPlan([disabled, first, second], () => 0.99)?.id, "second");
});

test("initiated behavior run store aggregates randomized thirty minute buckets", () => {
  const store = createAgentInitiatedBehaviorRunStore();
  const plan = defaultAgentInitiatedBehaviorPlans.find((entry) => entry.id === "care")!;
  const run = createAgentInitiatedBehaviorRun({
    plan,
    triggeredAt: "2026-06-06T00:10:00.000Z",
    trigger: "randomized",
    result: "completed"
  });
  run.respondedWithin15m = true;
  store.record(run);

  const buckets = store.randomThirtyMinuteBuckets(new Date("2026-06-06T00:30:00.000Z"));
  assert.equal(buckets.at(-2)?.total, 1);
  assert.equal(buckets.at(-2)?.respondedWithin15m, 1);
});

test("initiated behavior run store persists and marks 15 minute responses", () => {
  const dir = path.join(process.cwd(), ".tmp-tests", `initiated-behavior-runs-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "runs.sqlite");
  const plan = defaultAgentInitiatedBehaviorPlans.find((entry) => entry.id === "care")!;
  const store = createAgentInitiatedBehaviorRunStore({ dbPath });
  store.record(createAgentInitiatedBehaviorRun({
    plan,
    triggeredAt: "2026-06-06T08:00:00.000",
    triggeredAtUtc: "2026-06-06T00:00:00.000Z",
    trigger: "randomized",
    result: "completed",
    sessionId: "session"
  }));

  assert.equal(store.markRespondedWithin15m({
    sessionId: "session",
    respondedAt: "2026-06-06T00:10:00.000Z"
  }), 1);

  const reopened = createAgentInitiatedBehaviorRunStore({ dbPath });
  assert.equal(reopened.list(1)[0].respondedWithin15m, true);
  assert.equal(reopened.list(1)[0].triggeredAtUtc, "2026-06-06T00:00:00.000Z");
});

test("initiated behavior run store does not count pending responses as missed in buckets", () => {
  const dir = path.join(process.cwd(), ".tmp-tests", `initiated-behavior-runs-pending-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "runs.sqlite");
  const store = createAgentInitiatedBehaviorRunStore({ dbPath });
  const plan = defaultAgentInitiatedBehaviorPlans.find((entry) => entry.id === "care")!;
  store.record(createAgentInitiatedBehaviorRun({
    plan,
    triggeredAt: "2026-06-06T08:10:00.000",
    triggeredAtUtc: "2026-06-06T00:10:00.000Z",
    trigger: "randomized",
    result: "completed",
    sessionId: "session"
  }));

  const buckets = store.randomThirtyMinuteBuckets(new Date("2026-06-06T00:20:00.000Z"));
  const currentBucket = buckets.at(-1);
  assert.equal(currentBucket?.total, 1);
  assert.equal(currentBucket?.respondedWithin15m, 0);
  assert.equal(currentBucket?.notRespondedWithin15m, 0);
});

test("initiated behavior run store marks expired responses as missed", () => {
  const store = createAgentInitiatedBehaviorRunStore();
  const plan = defaultAgentInitiatedBehaviorPlans.find((entry) => entry.id === "care")!;
  store.record(createAgentInitiatedBehaviorRun({
    plan,
    triggeredAt: "2026-06-06T00:00:00.000Z",
    trigger: "randomized",
    result: "completed",
    sessionId: "session"
  }));

  assert.equal(store.finalizeExpiredResponses(new Date("2026-06-06T00:16:00.000Z")), 1);
  assert.equal(store.list(1)[0].respondedWithin15m, false);
});

test("initiated behavior availability is unavailable when sleep_cocoon is hidden", () => {
  const plan = defaultAgentInitiatedBehaviorPlans.find((entry) => entry.id === "sleep_goodnight")!;
  const availability = resolveAgentInitiatedBehaviorAvailability(plan, {
    userName: "YY",
    visibleTools: { feishu: true, sleep_cocoon: false },
    layers: [],
    appendLayers: []
  }, [{
    id: "sleep_cocoon",
    listTools() {
      return [{ name: "sleep_cocoon", description: "sleep", inputSchema: { type: "object" } }];
    },
    async execute() {
      throw new Error("should not execute");
    }
  }]);

  assert.equal(availability.status, "unavailable");
  assert.equal(availability.reason, "tool_hidden:sleep_cocoon");
});

function textEvent(): AgentEvent {
  return {
    id: "evt",
    type: "message.text",
    source: { plugin: "test", userId: "user" },
    session: { scope: "dm", sessionId: "session" },
    payload: { kind: "text", text: "hi" },
    meta: { receivedAt: "2026-06-06T00:00:00.000Z" }
  };
}
