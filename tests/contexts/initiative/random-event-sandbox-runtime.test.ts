import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createJsonRandomEventStore, randomEventDefinitionJson } from "../../../src/contexts/initiative/src/adapters/json-random-event-store.js";
import { createRandomEventSandboxRuntime, randomEventSubmissionMarker } from "../../../src/contexts/initiative/src/application/random-event-sandbox-runtime.js";
import { createBashSandboxRuntime } from "../../../src/contexts/bash-sandbox/src/index.js";
import { fakeExecutor, testConfig, tmpDir } from "../bash-sandbox/bash-sandbox-helpers.js";

function definition(id: string, weight = 1) {
  return { meta: { id, enabled: true, weight, priority: 0 }, messages: [] };
}

function bashResult() {
  return { command: "submit", cwd: "/skills/manage-random-events", stdout: `${randomEventSubmissionMarker}\n`, stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false, denied: false };
}

test("random event skill resets its workspace on every load", () => {
  const config = testConfig({ skillMounts: [] });
  const store = createJsonRandomEventStore(tmpDir("random-event-canonical"));
  store.save(definition("care"));
  const runtime = createRandomEventSandboxRuntime({
    store,
    hostWorkspaceRoot: config.hostWorkspaceDir,
    sandbox: createBashSandboxRuntime({ config, executor: fakeExecutor(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false })) }),
    getApprovalService() { throw new Error("unused"); }
  });

  const skill = { name: "manage-random-events", hostRoot: tmpDir("manage-random-events-skill"), sandboxRoot: "/skills/manage-random-events" };
  runtime.prepareSkill(skill);
  const workspace = path.join(config.hostWorkspaceDir, ".skills", "manage-random-events", "events");
  fs.writeFileSync(path.join(workspace, "draft.json"), JSON.stringify(definition("draft")));
  runtime.prepareSkill(skill);

  assert.deepEqual(fs.readdirSync(workspace), ["care.json"]);
  assert.deepEqual(config.skillMounts.map((mount) => ({ containerPath: mount.containerPath, readOnly: mount.readOnly })), [
    { containerPath: "/skills/manage-random-events", readOnly: true },
    { containerPath: "/skills/manage-random-events/events", readOnly: false }
  ]);
});

test("random event submission approves files independently and applies only approvals", async () => {
  const config = testConfig({ skillMounts: [] });
  const store = createJsonRandomEventStore(tmpDir("random-event-submit"));
  store.save(definition("change"));
  store.save(definition("remove"));
  const decisions = [
    { status: "approved" as const },
    { status: "revision_requested" as const, comment: "请缩短" },
    { status: "rejected" as const }
  ];
  const calls: string[] = [];
  const runtime = createRandomEventSandboxRuntime({
    store,
    hostWorkspaceRoot: config.hostWorkspaceDir,
    sandbox: createBashSandboxRuntime({ config, executor: fakeExecutor(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false })) }),
    getApprovalService() {
      return { async request(input) { calls.push(input.content); return decisions.shift()!; } };
    }
  });
  runtime.prepareSkill({ name: "manage-random-events", hostRoot: tmpDir("manage-random-events-skill"), sandboxRoot: "/skills/manage-random-events" });
  const workspace = path.join(config.hostWorkspaceDir, ".skills", "manage-random-events", "events");
  fs.writeFileSync(path.join(workspace, "change.json"), randomEventDefinitionJson(definition("change", 5)));
  fs.writeFileSync(path.join(workspace, "create.json"), randomEventDefinitionJson(definition("create")));
  fs.unlinkSync(path.join(workspace, "remove.json"));

  const result = await runtime.handleBashResult(bashResult());

  assert.equal(calls.length, 3);
  assert.equal(store.get("change")?.meta.weight, 5);
  assert.equal(store.get("create"), undefined);
  assert.equal(store.get("remove")?.meta.id, "remove");
  assert.deepEqual(result?.results.map((entry) => entry.status), ["approved", "revision_requested", "rejected"]);
});

test("random event submission detects concurrent changes after approval", async () => {
  const config = testConfig({ skillMounts: [] });
  const store = createJsonRandomEventStore(tmpDir("random-event-stale"));
  store.save(definition("care"));
  const runtime = createRandomEventSandboxRuntime({
    store,
    hostWorkspaceRoot: config.hostWorkspaceDir,
    sandbox: createBashSandboxRuntime({ config, executor: fakeExecutor(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false })) }),
    getApprovalService() {
      return { async request() { store.save(definition("care", 9)); return { status: "approved" as const }; } };
    }
  });
  runtime.prepareSkill({ name: "manage-random-events", hostRoot: tmpDir("manage-random-events-skill"), sandboxRoot: "/skills/manage-random-events" });
  const workspace = path.join(config.hostWorkspaceDir, ".skills", "manage-random-events", "events");
  fs.writeFileSync(path.join(workspace, "care.json"), randomEventDefinitionJson(definition("care", 2)));

  const result = await runtime.handleBashResult(bashResult());

  assert.equal(result?.results[0].status, "stale");
  assert.equal(store.get("care")?.meta.weight, 9);
});
