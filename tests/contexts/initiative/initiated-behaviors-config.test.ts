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
    randomEventDir: path.join(path.dirname(configPath), "random-events"),
    appendLog() {}
  });

  const created = runtime.createCustom(id, {
    enabled: true,
    kind: "event",
    triggerEvent: "custom.check_in",
    promptProfile: { meta: {}, messages: [] }
  });
  const profilePath = path.resolve(created?.promptProfilePath ?? "");
  const srcProfilePath = path.resolve("src", "contexts", "initiative", "behaviors", `${id}.json`);

  assert.equal(created?.custom, true);
  assert.equal(created?.triggerEvent, "custom.check_in");
  assert.deepEqual(JSON.parse(fs.readFileSync(profilePath, "utf8")), { meta: {}, messages: [] });
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
    randomEventDir: path.join(path.dirname(configPath), "random-events"),
    appendLog() {}
  });

  const created = runtime.createCustom(id, {
    enabled: true,
    kind: "event",
    triggerEvent: "custom.check_in",
    promptProfile: { meta: {}, messages: [] }
  });
  const profilePath = path.resolve(created?.promptProfilePath ?? "");
  const srcProfilePath = path.resolve("src", "contexts", "initiative", "behaviors", `${id}.json`);

  assert.equal(runtime.deleteCustom("sleep_morning"), undefined);
  assert.equal(runtime.deleteCustom(id)?.id, id);
  assert.equal(runtime.getPlans().some((plan) => plan.id === id), false);
  assert.equal(fs.existsSync(profilePath), false);
  assert.equal(fs.existsSync(srcProfilePath), false);
});

test("initiated behavior runtime manages every random event as a deletable file", () => {
  const root = path.dirname(tempPath("random-events-runtime", "config.json"));
  const runtime = createInitiatedBehaviorRuntime({
    configPath: path.join(root, "initiated-behaviors.config.json"),
    randomEventDir: path.join(root, "random-events"),
    appendLog() {}
  });

  const created = runtime.createCustom("ordinary_random", {
    kind: "randomized",
    enabled: true,
    weight: 2,
    priority: 1,
    promptProfile: { meta: {}, messages: [{ meta: { title: "Instruction", enabled: true }, role: "assistant", content: "hello" }] }
  });
  const updated = runtime.setConfig("ordinary_random", { weight: 5 });

  assert.equal(created?.custom, undefined);
  assert.equal(updated?.weight, 5);
  assert.equal(runtime.deleteCustom("ordinary_random")?.kind, "randomized");
  assert.equal(runtime.getPlans().some((plan) => plan.id === "ordinary_random"), false);
});
