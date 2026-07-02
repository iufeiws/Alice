import { test } from "node:test";
import assert from "node:assert/strict";
import { createBashTools } from "../src/capabilities/tools/bash/src/index.js";
import { createSkillsTools } from "../src/capabilities/tools/skills/src/index.js";
import { createBashSandboxRuntime, classifyBashCommand, createDockerBashExecutor, createFeishuBashRunReporter, type BashSandboxConfig, type DockerExecutor } from "../src/contexts/bash-sandbox/src/index.js";
import { createSkillLoader, createSkillRegistry, formatAvailableSkillsXml } from "../src/contexts/skills/src/index.js";
import { loadConfig } from "../src/apps/api/bootstrap/app-config-runtime.js";
import { buildBashRunCard } from "../src/channels/feishu/src/client.js";
import type { FeishuDynamicCardClient } from "../src/channels/feishu/src/types.js";

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const childProcess = await import("node:child_process");

test("bash tool executes through sandbox runtime by default", async () => {
  const tools = createBashTools({
    runtime: createBashSandboxRuntime({
      config: testConfig(),
      executor: fakeExecutor(async () => ({ stdout: "sandbox\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false }))
    })
  });

  const result = await tools.execute({ id: "bash_1", toolName: "bash", input: { command: "echo hello" } });
  const output = JSON.parse(String(result.output));

  assert.equal(result.ok, true);
  assert.equal(output.denied, false);
  assert.equal(output.stdout, "sandbox\n");
});

test("bash tool returns docker result without throwing on non-zero exit", async () => {
  const tools = createBashTools({
    runtime: createBashSandboxRuntime({
      config: testConfig(),
      executor: fakeExecutor(async () => ({ stdout: "", stderr: "nope", exitCode: 2, timedOut: false, durationMs: 3, truncated: false }))
    })
  });

  const result = await tools.execute({ id: "bash_2", toolName: "bash", input: { command: "echo hello" } });
  const output = JSON.parse(String(result.output));

  assert.equal(result.ok, true);
  assert.equal(output.denied, false);
  assert.equal(output.exitCode, 2);
  assert.equal(output.stderr, "nope");
});

test("bash runtime writes audit events for sandbox execution", async () => {
  const config = testConfig({ outputLimitBytes: 5, mounts: [{ id: "data", hostPath: tmpDir("data"), containerPath: "/mnt/data", readOnly: true }] });
  const runtime = createBashSandboxRuntime({
    config,
    executor: fakeExecutor(async () => ({ stdout: "abcdef", stderr: "", exitCode: 124, timedOut: true, durationMs: 9, truncated: true }))
  });

  await runtime.run({ id: "deny", toolName: "bash", input: { command: "curl https://example.com" } });
  await runtime.run({ id: "timeout", toolName: "bash", input: { command: "ls /mnt/data" } });
  const events = fs.readFileSync(config.auditLogPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));

  assert.equal(events[0].permission.state, "allow");
  assert.equal(events[1].permission.state, "allow");
  assert.equal(events[1].timedOut, true);
  assert.equal(events[1].truncated, true);
  assert.equal("optionalMounts" in events[1], false);
});

test("permission gate only enforces sandbox entry boundary", () => {
  const config = testConfig();
  const cwd = config.workspaceDir;

  assert.equal(classifyBashCommand({ config, cwd, command: "echo hello" }).state, "allow");
  assert.match(denyReason(classifyBashCommand({ config, cwd, command: "" })), /required/);
  assert.match(denyReason(classifyBashCommand({ config, cwd: "/etc", command: "echo hello" })), /cwd/);
});

test("config rejects writable mounts under skills and sensitive host paths", () => {
  const config = loadConfig({});
  assert.equal(config.bashSandbox.image, "cimg/python:3.13-browsers");
  assert.equal(config.bashSandbox.hostWorkspaceDir.endsWith(path.join(".sandbox", "bash", "workspace")), true);
  assert.equal(config.bashSandbox.hostCacheDir.endsWith(path.join(".sandbox", "bash", "cache")), true);
  assert.equal(config.bashSandbox.auditLogPath, ".sandbox/bash/audit.jsonl");
  assert.equal("enabled" in config.bashSandbox, false);
  assert.deepEqual(config.bashSandbox.skillMounts, []);
  assert.throws(() => loadConfig({ BASH_SANDBOX_MOUNTS: JSON.stringify([{ hostPath: "/etc", containerPath: "/mnt/etc" }]) }), /sensitive host path/);
  assert.throws(() => loadConfig({ BASH_SANDBOX_MOUNTS: JSON.stringify([{ hostPath: tmpDir("mount"), containerPath: "/skills/generated", readOnly: false }]) }), /skills mount/);
});

test("skills registry formats first-party and third-party available skills only", () => {
  const firstParty = tmpDir("first-party-skills");
  const thirdParty = tmpDir("third-party-skills");
  writeSkill(firstParty, "demo", "name: demo\ndescription: Run demo script.", "Use scripts/run.sh\n");
  writeSkill(thirdParty, "third", "name: third\ndescription: Installed skill.", "Use it\n");
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
  assert.doesNotMatch(xml, /disabled/);
  assert.doesNotMatch(xml, /invalid/);
});

test("Skill tool loads by exact name, renders args, and mounts read-write without host paths", async () => {
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

  const listedNames = tools.listTools().map((tool) => tool.name);
  const oldList = await tools.execute({ id: "list", toolName: "list_skills", input: {} });
  const loaded = await tools.execute({ id: "load", toolName: "Skill", input: { skill: "demo", args: "'one arg' $HOME" } });

  assert.deepEqual(listedNames, ["Skill"]);
  assert.equal(oldList.ok, false);
  assert.equal(loaded.ok, true);
  assert.match(String(loaded.output), /<loaded_skill name="demo" dir="\/skills\/demo">/);
  assert.match(String(loaded.output), /Run one arg then \$HOME/);
  assert.equal(String(loaded.output).includes(root), false);
  assert.deepEqual(config.skillMounts.map((mount) => ({ containerPath: mount.containerPath, readOnly: mount.readOnly })), [{ containerPath: "/skills/demo", readOnly: false }]);
  assert.equal(loader.load("demo").resolveResource("scripts/run.sh"), "/skills/demo/scripts/run.sh");
  assert.throws(() => loader.load("demo").resolveResource("../escape"), /escapes/);
});

test("Skill tool returns spec error codes and appends unused args", async () => {
  const root = tmpDir("skill-errors");
  writeSkill(root, "plain", "name: plain\ndescription: Plain skill.", "No placeholders\n");
  writeSkill(root, "disabled", "name: disabled\ndescription: Disabled.\ndisabled: true", "Nope\n");
  writeSkill(root, "hidden", "name: hidden\ndescription: Hidden.\ndisable-model-invocation: true", "Nope\n");
  writeSkill(root, "forked", "name: forked\ndescription: Forked.\ncontext: fork", "Nope\n");
  writeSkill(root, "dynamic", "name: dynamic\ndescription: Dynamic.\ndynamic-context: true", "Nope\n");
  const registry = createSkillRegistry({ roots: [{ root, source: "first-party" }] });
  const before = formatAvailableSkillsXml(registry);
  const tools = createSkillsTools({ loader: createSkillLoader(registry, createBashSandboxRuntime({ config: testConfig({ skillMounts: [] }), executor: fakeExecutor(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false })) })) });

  const loaded = await tools.execute({ id: "plain", toolName: "Skill", input: { skill: "plain", args: "alpha beta" } });
  const unknown = await tools.execute({ id: "unknown", toolName: "Skill", input: { skill: "missing" } });
  const disabled = await tools.execute({ id: "disabled", toolName: "Skill", input: { skill: "disabled" } });
  const hidden = await tools.execute({ id: "hidden", toolName: "Skill", input: { skill: "hidden" } });
  const forked = await tools.execute({ id: "forked", toolName: "Skill", input: { skill: "forked" } });
  const dynamic = await tools.execute({ id: "dynamic", toolName: "Skill", input: { skill: "dynamic" } });

  assert.match(String(loaded.output), /ARGUMENTS: alpha beta/);
  assert.equal(unknown.error, "SKILL_NOT_FOUND");
  assert.equal(disabled.error, "SKILL_DISABLED");
  assert.equal(hidden.error, "SKILL_NOT_MODEL_INVOCABLE");
  assert.equal(forked.error, "FORK_NOT_SUPPORTED");
  assert.equal(dynamic.error, "DYNAMIC_CONTEXT_NOT_SUPPORTED");
  assert.equal(formatAvailableSkillsXml(registry), before);
});

test("docker executor pulls the configured image before creating the container", async () => {
  const root = tmpDir("fake-docker");
  const bin = path.join(root, "bin");
  const log = path.join(root, "docker.log");
  fs.mkdirSync(bin, { recursive: true });
  const docker = path.join(bin, "docker");
  fs.writeFileSync(docker, `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1 $2" = "image inspect" ]; then exit 1; fi
if [ "$1" = "pull" ]; then exit 0; fi
if [ "$1" = "inspect" ]; then exit 1; fi
if [ "$1" = "run" ]; then exit 0; fi
if [ "$1" = "exec" ]; then echo docker-ok; exit 0; fi
exit 64
`);
  fs.chmodSync(docker, 0o755);
  const previousPath = process.env.PATH;
  const previousHttpsProxy = process.env.HTTPS_PROXY;
  const previousNoProxy = process.env.NO_PROXY;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  process.env.HTTPS_PROXY = "http://host.docker.internal:7890";
  process.env.NO_PROXY = "localhost,127.0.0.1";
  try {
    const config = testConfig({ network: "configured", hostWorkspaceDir: path.join(root, "workspace"), hostCacheDir: path.join(root, "cache") });
    const result = await createDockerBashExecutor(config).execute({ command: "echo ok", cwd: config.workspaceDir, timeoutMs: 1000, outputLimitBytes: 1024 });
    const calls = fs.readFileSync(log, "utf8");
    assert.equal(calls.includes("image inspect cimg/python:3.13-browsers"), true);
    assert.equal(calls.includes("pull cimg/python:3.13-browsers"), true);
    assert.match(calls, /run -d .*--network bridge/);
    assert.match(calls, /-e HTTPS_PROXY/);
    assert.match(calls, /-e NO_PROXY/);
    assert.equal(result.stdout.trim(), "docker-ok");
  } finally {
    process.env.PATH = previousPath;
    if (previousHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previousHttpsProxy;
    if (previousNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previousNoProxy;
  }
});

test("Feishu bash run card uses one collapsed panel titled with running command", () => {
  const card = buildBashRunCard("npm test", "actual output") as any;
  const body = card.body.elements;
  const panel = body[0];
  const output = panel.elements[0];

  assert.equal(card.header, undefined);
  assert.equal(body.length, 1);
  assert.equal(panel.tag, "collapsible_panel");
  assert.equal(panel.element_id, "bash_run_title");
  assert.equal(panel.expanded, false);
  assert.equal(panel.header.title.content, "running: npm test");
  assert.equal(output.tag, "markdown");
  assert.equal(output.element_id, "bash_run_content");
  assert.equal(output.content, "actual output");
});

test("Feishu bash reporter streams stdout and stderr to a dedicated bash card", async () => {
  const client = fakeFeishuCardClient();
  const reporter = createFeishuBashRunReporter({
    client,
    pairingStore: { list: () => [{ userId: "ou_user" }] } as any,
    throttleMs: 1000
  });
  const session = await reporter.begin({ call: { id: "bash", toolName: "bash", input: {} }, command: "npm test", cwd: "/workspace" });

  assert.ok(session);
  await session.appendStdout("ok\n");
  await session.appendStderr("warn\n");
  await session.finish({ command: "npm test", cwd: "/workspace", stdout: "ok\n", stderr: "warn\n", exitCode: 0, timedOut: false, durationMs: 10, truncated: false, denied: false });

  assert.deepEqual(client.calls, [
    "create:ou_user:npm test",
    "stream:card_bash:true:1",
    "update:card_bash:content:2",
    "update:card_bash:title:3",
    "stream:card_bash:false:4"
  ]);
  const outputContent = client.contents.find((content) => content.includes("[exit 0]")) ?? "";
  assert.doesNotMatch(outputContent, /cwd:/);
  assert.doesNotMatch(outputContent, /status:/);
  assert.match(outputContent, /ok/);
  assert.match(outputContent, /\[stderr\] warn/);
  assert.match(client.contents.at(-1) ?? "", /finish: npm test/);
});

test("docker executor runs in a fixed container when explicitly enabled", async (t) => {
  if (process.env.BASH_SANDBOX_DOCKER_TEST !== "1") {
    t.skip("set BASH_SANDBOX_DOCKER_TEST=1 to run Docker integration");
    return;
  }
  const config = testConfig({ containerName: `alice-bash-sandbox-test-${process.pid}` });
  for (const mount of config.skillMounts) fs.mkdirSync(mount.hostPath, { recursive: true });
  try {
    const result = await createDockerBashExecutor(config).execute({ command: "echo docker-ok", cwd: config.workspaceDir, timeoutMs: 5000, outputLimitBytes: 1024 });
    assert.equal(result.stdout.trim(), "docker-ok");
    assert.equal(result.exitCode, 0);
  } finally {
    childProcess.spawnSync("docker", ["rm", "-f", config.containerName], { stdio: "ignore" });
  }
});

function testConfig(overrides: Partial<BashSandboxConfig> = {}): BashSandboxConfig {
  const root = tmpDir("bash-sandbox");
  return {
    containerName: "test-bash-sandbox",
    image: "cimg/python:3.13-browsers",
    defaultCwd: "/workspace",
    hostWorkspaceDir: path.join(root, "workspace"),
    workspaceDir: "/workspace",
    hostCacheDir: path.join(root, "cache"),
    cacheDir: "/cache",
    tmpDir: "/tmp",
    skillMounts: [{ id: "demo", hostPath: path.join(root, "skills", "demo"), containerPath: "/skills/demo", readOnly: true }],
    mounts: [],
    network: "none",
    timeoutMs: 1000,
    outputLimitBytes: 4096,
    auditLogPath: path.join(root, "audit.jsonl"),
    ...overrides
  };
}

function fakeExecutor(run: DockerExecutor["execute"]): DockerExecutor {
  return { execute: run };
}

function fakeFeishuCardClient(): FeishuDynamicCardClient & { calls: string[]; contents: string[] } {
  const calls: string[] = [];
  const contents: string[] = [];
  return {
    calls,
    contents,
    isStarted: () => true,
    async createAgentRunCard() {
      throw new Error("unused");
    },
    async updateAgentRunCard() {
      throw new Error("unused");
    },
    async setAgentRunCardStreaming() {
      throw new Error("unused");
    },
    async resolveAgentRunCardId() {
      return {};
    },
    async createBashRunCard(input) {
      calls.push(`create:${input.receiveId}:${input.command}`);
      contents.push(input.content);
      return { messageId: "om_bash", cardId: "card_bash" };
    },
    async updateBashRunCard(input) {
      calls.push(`update:${input.cardId}:${input.block}:${input.sequence}`);
      contents.push(input.content);
    },
    async setBashRunCardStreaming(input) {
      calls.push(`stream:${input.cardId}:${input.enabled}:${input.sequence}`);
    }
  };
}

function denyReason(value: ReturnType<typeof classifyBashCommand>): string {
  return value.state === "deny" ? value.reason : "";
}

function writeSkill(root: string, relative: string, frontmatter: string, body: string): string {
  const skillRoot = path.join(root, relative);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`);
  return skillRoot;
}

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}
