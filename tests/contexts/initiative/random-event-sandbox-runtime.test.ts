import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createJsonRandomEventStore, randomEventDefinitionJson } from "../../../src/contexts/initiative/src/adapters/json-random-event-store.js";
import { createRandomEventSandboxRuntime, initiatedBehaviorManagingSubmissionMarker } from "../../../src/contexts/initiative/src/application/random-event-sandbox-runtime.js";
import { createBashSandboxRuntime } from "../../../src/contexts/bash-sandbox/src/index.js";
import { fakeExecutor, testConfig, tmpDir } from "../bash-sandbox/bash-sandbox-helpers.js";

function definition(id: string, weight = 1) {
  return { meta: { id, enabled: true, weight, priority: 0 }, messages: [] };
}

function bashResult() {
  return { command: "submit", cwd: "/skills/initiated-behavior-managing", stdout: `${initiatedBehaviorManagingSubmissionMarker}\n`, stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false, denied: false };
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

  const skill = { name: "initiated-behavior-managing", hostRoot: tmpDir("initiated-behavior-managing-skill"), sandboxRoot: "/skills/initiated-behavior-managing" };
  runtime.prepareSkill(skill);
  const workspace = path.join(config.hostWorkspaceDir, ".skills", "initiated-behavior-managing", "events");
  fs.writeFileSync(path.join(workspace, "draft.json"), JSON.stringify(definition("draft")));
  runtime.prepareSkill(skill);

  assert.deepEqual(fs.readdirSync(workspace), ["care.json"]);
  assert.deepEqual(config.skillMounts.map((mount) => ({ containerPath: mount.containerPath, readOnly: mount.readOnly })), [
    { containerPath: "/skills/initiated-behavior-managing", readOnly: true },
    { containerPath: "/skills/initiated-behavior-managing/events", readOnly: false }
  ]);
});

test("random event submission approves files independently and applies only approvals", async () => {
  const config = testConfig({ skillMounts: [] });
  const store = createJsonRandomEventStore(tmpDir("random-event-submit"));
  store.save(definition("change"));
  store.save(definition("remove"));
  const decisions = [
    { status: "approved" as const, comment: "已核对" },
    { status: "rejected" as const, comment: "请缩短" },
    { status: "rejected" as const, comment: "不要删除" }
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
  runtime.prepareSkill({ name: "initiated-behavior-managing", hostRoot: tmpDir("initiated-behavior-managing-skill"), sandboxRoot: "/skills/initiated-behavior-managing" });
  const workspace = path.join(config.hostWorkspaceDir, ".skills", "initiated-behavior-managing", "events");
  fs.writeFileSync(path.join(workspace, "change.json"), randomEventDefinitionJson(definition("change", 5)));
  fs.writeFileSync(path.join(workspace, "create.json"), randomEventDefinitionJson(definition("create")));
  fs.unlinkSync(path.join(workspace, "remove.json"));

  const result = await runtime.handleBashResult(bashResult());

  assert.equal(calls.length, 3);
  assert.equal(store.get("change")?.meta.weight, 5);
  assert.equal(store.get("create"), undefined);
  assert.equal(store.get("remove")?.meta.id, "remove");
  assert.deepEqual(result?.results.map((entry) => ({ status: entry.status, comment: entry.comment })), [
    { status: "approved", comment: "已核对" },
    { status: "rejected", comment: "请缩短" },
    { status: "rejected", comment: "不要删除" }
  ]);
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
      return { async request() { store.save(definition("care", 9)); return { status: "approved" as const, comment: "" }; } };
    }
  });
  runtime.prepareSkill({ name: "initiated-behavior-managing", hostRoot: tmpDir("initiated-behavior-managing-skill"), sandboxRoot: "/skills/initiated-behavior-managing" });
  const workspace = path.join(config.hostWorkspaceDir, ".skills", "initiated-behavior-managing", "events");
  fs.writeFileSync(path.join(workspace, "care.json"), randomEventDefinitionJson(definition("care", 2)));

  const result = await runtime.handleBashResult(bashResult());

  assert.equal(result?.results[0].status, "stale");
  assert.equal(store.get("care")?.meta.weight, 9);
});
