import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createInitiatedBehaviorRuntime } from "../../../src/contexts/initiative/src/application/evaluate-triggers.js";
import { tempPath } from "./initiated-behaviors-helpers.js";

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
