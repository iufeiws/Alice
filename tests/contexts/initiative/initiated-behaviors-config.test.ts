import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createInitiatedBehaviorRuntime } from "../../../src/contexts/initiative/src/application/evaluate-triggers.js";
import { defaultAgentInitiatedBehaviorPlans } from "../../../src/contexts/initiative/src/domain/initiated-behavior.js";
import { tempPath } from "./initiated-behaviors-helpers.js";

test("default randomized behavior plans expose proactive initiation config", () => {
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

test("initiated behavior runtime creates custom plans", () => {
  const id = `custom_check_in_${process.pid}_${Date.now()}`;
  const configPath = tempPath(id, "initiated-behaviors.config.json");
  const customPromptProfileDir = path.join(path.dirname(configPath), "behaviors");
  const runtime = createInitiatedBehaviorRuntime({
    configPath,
    customPromptProfileDir,
    appendLog() {}
  });

  const created = runtime.createCustom(id, {
    enabled: true,
    kind: "event",
    triggerEvent: "custom.check_in",
    promptProfile: { layers: [] }
  });
  const profilePath = path.resolve(created?.promptProfilePath ?? "");
  const srcProfilePath = path.resolve("src", "contexts", "initiative", "behaviors", `${id}.json`);

  assert.equal(created?.custom, true);
  assert.equal(created?.triggerEvent, "custom.check_in");
  assert.deepEqual(JSON.parse(fs.readFileSync(profilePath, "utf8")), { layers: [] });
  assert.equal(profilePath.startsWith(customPromptProfileDir), true);
  assert.equal(fs.existsSync(srcProfilePath), false);
  assert.ok(runtime.getPlans().some((plan) => plan.id === id && plan.custom === true));
});

test("initiated behavior runtime deletes custom plans", () => {
  const id = `custom_check_in_${process.pid}_${Date.now()}`;
  const configPath = tempPath(id, "initiated-behaviors.config.json");
  const customPromptProfileDir = path.join(path.dirname(configPath), "behaviors");
  const runtime = createInitiatedBehaviorRuntime({
    configPath,
    customPromptProfileDir,
    appendLog() {}
  });

  const created = runtime.createCustom(id, {
    enabled: true,
    kind: "event",
    triggerEvent: "custom.check_in",
    promptProfile: { layers: [] }
  });
  const profilePath = path.resolve(created?.promptProfilePath ?? "");
  const srcProfilePath = path.resolve("src", "contexts", "initiative", "behaviors", `${id}.json`);

  assert.equal(runtime.deleteCustom("sleep_morning"), undefined);
  assert.equal(runtime.deleteCustom(id)?.id, id);
  assert.equal(runtime.getPlans().some((plan) => plan.id === id), false);
  assert.equal(fs.existsSync(profilePath), false);
  assert.equal(fs.existsSync(srcProfilePath), false);
});
