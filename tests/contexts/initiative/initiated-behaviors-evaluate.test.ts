import test from "node:test";
import assert from "node:assert/strict";
import {
  agentInitiatedBehaviorPlanFromEvent,
  defaultAgentInitiatedBehaviorPlans,
  resolveAgentInitiatedBehaviorAvailability,
  selectRandomizedAgentInitiatedBehaviorPlan
} from "../../../src/contexts/initiative/src/domain/initiated-behavior.js";
import { textEvent, visiblePromptProfile } from "./initiated-behaviors-helpers.js";

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

test("randomized initiated event selects a plan inside resolver", () => {
  const base = defaultAgentInitiatedBehaviorPlans.find((entry) => entry.id === "care")!;
  const first = { ...base, id: "first", enabled: true, dryRun: false, weight: 1 };
  const second = { ...base, id: "second", enabled: true, dryRun: false, weight: 3 };

  assert.equal(agentInitiatedBehaviorPlanFromEvent(
    textEvent({ agentInitiatedTriggerEvent: "randomized" }),
    [first, second],
    () => 0.99
  )?.id, "second");
});

test("initiated behavior availability reports hidden required tools", () => {
  const plan = defaultAgentInitiatedBehaviorPlans.find((entry) => entry.id === "sleep_goodnight")!;
  const availability = resolveAgentInitiatedBehaviorAvailability(plan, visiblePromptProfile({
    feishu: true,
    sleep_cocoon: false
  }), [{
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
