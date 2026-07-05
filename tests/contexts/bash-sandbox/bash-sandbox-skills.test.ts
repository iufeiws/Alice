import { test } from "node:test";
import assert from "node:assert/strict";
import { createSkillsTools } from "../../../src/capabilities/tools/skills/src/index.js";
import { createBashSandboxRuntime } from "../../../src/contexts/bash-sandbox/src/index.js";
import { createSkillLoader, createSkillRegistry, formatAvailableSkillsXml } from "../../../src/contexts/skills/src/index.js";
import { fakeExecutor, testConfig, tmpDir, writeSkill } from "./bash-sandbox-helpers.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("skills registry formats first-party and third-party available skills only", () => {
  const firstParty = tmpDir("first-party-skills");
  const thirdParty = tmpDir("third-party-skills");
  writeSkill(firstParty, "demo", "name: demo\ndescription: Run demo script.", "Use scripts/run.sh\n");
  writeSkill(thirdParty, "third", "name: third\ndescription: Installed skill.", "Use it\n");
  writeSkill(firstParty, "external/hidden", "name: external-hidden\ndescription: External first-party skill.", "Nope\n");
  writeSkill(firstParty, "disabled", "name: disabled\ndescription: Disabled skill.\ndisabled: true", "Nope\n");
  writeSkill(firstParty, "invalid", "name: invalid", "No description\n");

  const registry = createSkillRegistry({
    roots: [
      { root: firstParty, source: "first-party" },
      { root: thirdParty, source: "third-party" }
    ]
  });
  const xml = formatAvailableSkillsXml(registry);

  assert.deepEqual(registry.available().map((skill) => skill.name), ["demo", "third"]);
  assert.match(xml, /<name>demo<\/name>/);
  assert.match(xml, /<name>third<\/name>/);
  assert.doesNotMatch(xml, /external-hidden/);
  assert.doesNotMatch(xml, /disabled/);
  assert.doesNotMatch(xml, /invalid/);
});

test("Skill tool loads by exact name and renders args without host paths", async () => {
  const root = tmpDir("skills-tools");
  const skillRoot = writeSkill(root, "demo", "name: demo\ndescription: demo skill", "Run $0 then $ARGUMENTS[1]\n");
  fs.mkdirSync(path.join(skillRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "scripts", "run.sh"), "echo demo\n");
  const config = testConfig({ skillMounts: [] });
  const runtime = createBashSandboxRuntime({
    config,
    executor: fakeExecutor(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false }))
  });
  const registry = createSkillRegistry({ roots: [{ root, source: "first-party" }] });
  const loader = createSkillLoader(registry, runtime);
  const tools = createSkillsTools({ loader });

  const loaded = await tools.execute({ id: "load", toolName: "Skill", input: { skill: "demo", args: "'one arg' $HOME" } });

  assert.equal(loaded.ok, true);
  assert.match(String(loaded.output), /<demo>\n<path>\/skills\/demo<\/path>/);
  assert.match(String(loaded.output), /Run one arg then \$HOME/);
  assert.equal(String(loaded.output).includes(root), false);
});

test("Skill tool mounts loaded skill resources read-write", async () => {
  const root = tmpDir("skills-tools-mount");
  const skillRoot = writeSkill(root, "demo", "name: demo\ndescription: demo skill", "Use script.\n");
  fs.mkdirSync(path.join(skillRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "scripts", "run.sh"), "echo demo\n");
  const config = testConfig({ skillMounts: [] });
  const runtime = createBashSandboxRuntime({
    config,
    executor: fakeExecutor(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false }))
  });
  const registry = createSkillRegistry({ roots: [{ root, source: "first-party" }] });
  const loader = createSkillLoader(registry, runtime);
  const tools = createSkillsTools({ loader });

  await tools.execute({ id: "load", toolName: "Skill", input: { skill: "demo" } });

  assert.deepEqual(config.skillMounts.map((mount) => ({ containerPath: mount.containerPath, readOnly: mount.readOnly })), [{ containerPath: "/skills/demo", readOnly: false }]);
  assert.equal(loader.load("demo").resolveResource("scripts/run.sh"), "/skills/demo/scripts/run.sh");
  assert.throws(() => loader.load("demo").resolveResource("../escape"), /escapes/);
});

test("Skill tool returns spec error codes", async () => {
  const root = tmpDir("skill-errors");
  writeSkill(root, "disabled", "name: disabled\ndescription: Disabled.\ndisabled: true", "Nope\n");
  writeSkill(root, "hidden", "name: hidden\ndescription: Hidden.\ndisable-model-invocation: true", "Nope\n");
  writeSkill(root, "forked", "name: forked\ndescription: Forked.\ncontext: fork", "Nope\n");
  writeSkill(root, "dynamic", "name: dynamic\ndescription: Dynamic.\ndynamic-context: true", "Nope\n");
  const registry = createSkillRegistry({ roots: [{ root, source: "first-party" }] });
  const runtime = createBashSandboxRuntime({
    config: testConfig({ skillMounts: [] }),
    executor: fakeExecutor(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false }))
  });
  const tools = createSkillsTools({ loader: createSkillLoader(registry, runtime) });

  const unknown = await tools.execute({ id: "unknown", toolName: "Skill", input: { skill: "missing" } });
  const disabled = await tools.execute({ id: "disabled", toolName: "Skill", input: { skill: "disabled" } });
  const hidden = await tools.execute({ id: "hidden", toolName: "Skill", input: { skill: "hidden" } });
  const forked = await tools.execute({ id: "forked", toolName: "Skill", input: { skill: "forked" } });
  const dynamic = await tools.execute({ id: "dynamic", toolName: "Skill", input: { skill: "dynamic" } });

  assert.equal(unknown.error, "SKILL_NOT_FOUND");
  assert.equal(disabled.error, "SKILL_DISABLED");
  assert.equal(hidden.error, "SKILL_NOT_MODEL_INVOCABLE");
  assert.equal(forked.error, "FORK_NOT_SUPPORTED");
  assert.equal(dynamic.error, "DYNAMIC_CONTEXT_NOT_SUPPORTED");
});
