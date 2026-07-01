import { test } from "node:test";
import assert from "node:assert/strict";
import { createBashTools } from "../src/capabilities/tools/bash/src/index.js";
import { createSkillsTools } from "../src/capabilities/tools/skills/src/index.js";
import { createBashSandboxRuntime, classifyBashCommand, createDockerBashExecutor, createFeishuBashRunReporter, type BashSandboxConfig, type DockerExecutor } from "../src/contexts/bash-sandbox/src/index.js";
import { createSkillLoader, createSkillRegistry } from "../src/contexts/skills/src/index.js";
import { loadConfig } from "../src/apps/api/bootstrap/app-config-runtime.js";
import { buildBashRunCard } from "../src/channels/feishu/src/client.js";
import type { FeishuDynamicCardClient } from "../src/channels/feishu/src/types.js";

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const childProcess = await import("node:child_process");

test("bash tool denies execution when sandbox is disabled", async () => {
  let executed = false;
  const tools = createBashTools({
    runtime: createBashSandboxRuntime({
      config: testConfig({ enabled: false }),
      executor: fakeExecutor(async () => {
        executed = true;
        return { stdout: "host", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false };
      })
    })
  });

  const result = await tools.execute({ id: "bash_1", toolName: "bash", input: { command: "echo hello" } });
  const output = JSON.parse(String(result.output));

  assert.equal(result.ok, true);
  assert.equal(output.denied, true);
  assert.equal(output.denyReason, "bash sandbox is disabled");
  assert.equal(executed, false);
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

test("bash runtime writes audit events for deny and timeout/truncation", async () => {
  const config = testConfig({ outputLimitBytes: 5, mounts: [{ id: "data", hostPath: tmpDir("data"), containerPath: "/mnt/data", readOnly: true }] });
  const runtime = createBashSandboxRuntime({
    config,
    executor: fakeExecutor(async () => ({ stdout: "abcdef", stderr: "", exitCode: 124, timedOut: true, durationMs: 9, truncated: true }))
  });

  await runtime.run({ id: "deny", toolName: "bash", input: { command: "curl https://example.com" } });
  await runtime.run({ id: "timeout", toolName: "bash", input: { command: "ls /mnt/data" } });
  const events = fs.readFileSync(config.auditLogPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));

  assert.equal(events[0].permission.state, "deny");
  assert.equal(events[1].permission.state, "allow");
  assert.equal(events[1].timedOut, true);
  assert.equal(events[1].truncated, true);
  assert.deepEqual(events[1].optionalMounts, [{ id: "data", containerPath: "/mnt/data", readOnly: true }]);
});

test("permission gate denies unsafe, uncertain, and read-only skill writes", () => {
  const config = testConfig();
  const cwd = config.workspaceDir;

  assert.equal(classifyBashCommand({ config, cwd, command: "echo hello" }).state, "allow");
  assert.match(denyReason(classifyBashCommand({ config, cwd, command: "curl https://example.com" })), /network/);
  assert.match(denyReason(classifyBashCommand({ config, cwd, command: "bash -lc npm test" })), /nested shell/);
  assert.match(denyReason(classifyBashCommand({ config, cwd, command: "docker ps", skillId: "demo" })), /daemon/);
  assert.match(denyReason(classifyBashCommand({ config, cwd, command: "touch /skills/demo/file.txt" })), /read-only/);
  assert.match(denyReason(classifyBashCommand({ config, cwd: "/skills/demo", command: "npm install" })), /read-only cwd/);
  assert.match(denyReason(classifyBashCommand({ config, cwd: "/etc", command: "echo hello" })), /cwd/);
  assert.match(denyReason(classifyBashCommand({ config, cwd, command: "mystery hello" })), /not explicitly allowed/);
});

test("config rejects writable mounts under skills and sensitive host paths", () => {
  assert.equal(path.isAbsolute(loadConfig({}).bashSandbox.skillsMount.hostPath), true);
  assert.throws(() => loadConfig({ BASH_SANDBOX_MOUNTS: JSON.stringify([{ hostPath: "/etc", containerPath: "/mnt/etc" }]) }), /sensitive host path/);
  assert.throws(() => loadConfig({ BASH_SANDBOX_MOUNTS: JSON.stringify([{ hostPath: tmpDir("mount"), containerPath: "/skills/generated", readOnly: false }]) }), /skills mount/);
});

test("skills registry loads metadata and loader resolves container resource paths", () => {
  const root = tmpDir("skills");
  const skillRoot = path.join(root, "external", "demo");
  fs.mkdirSync(path.join(skillRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "SKILL.md"), "---\nname: demo\ndescription: >\n  Run demo script.\n---\n\nUse scripts/run.sh\n");
  fs.writeFileSync(path.join(skillRoot, "scripts", "run.sh"), "echo demo\n");

  const registry = createSkillRegistry({ root, containerRoot: "/skills" });
  const loader = createSkillLoader(registry);
  const loaded = loader.load("demo");

  assert.deepEqual(registry.list().map((skill) => skill.name), ["demo"]);
  assert.equal(loaded.instructions.includes("Use scripts/run.sh"), true);
  assert.equal(loaded.resolveResource("scripts/run.sh"), "/skills/external/demo/scripts/run.sh");
  assert.throws(() => loaded.resolveResource("../escape"), /escapes/);
});

test("skills tools list metadata and load instructions without host paths", async () => {
  const root = tmpDir("skills-tools");
  const skillRoot = path.join(root, "demo");
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "SKILL.md"), "---\nname: demo\ndescription: demo skill\n---\n\nRun /skills/demo/scripts/run.sh\n");
  const registry = createSkillRegistry({ root, containerRoot: "/skills" });
  const loader = createSkillLoader(registry);
  const tools = createSkillsTools({ registry, loader });

  const listed = await tools.execute({ id: "list", toolName: "list_skills", input: {} });
  const loaded = await tools.execute({ id: "load", toolName: "load_skill", input: { skill: "demo" } });

  assert.equal(listed.ok, true);
  assert.equal(JSON.parse(String(listed.output))[0].containerRoot, "/skills/demo");
  assert.equal(String(listed.output).includes(root), false);
  assert.equal(loaded.ok, true);
  assert.equal(JSON.parse(String(loaded.output)).instructions.includes("Run /skills/demo/scripts/run.sh"), true);
  assert.equal(String(loaded.output).includes(root), false);
});

test("Feishu bash run card uses command title, divider, collapsible panel, and scroll container", () => {
  const card = buildBashRunCard("npm test", "running") as any;
  const body = card.body.elements;
  const panel = body[1];
  const scroll = panel.elements[0];

  assert.equal(card.header.title.content, "npm test");
  assert.equal(body[0].tag, "hr");
  assert.equal(panel.tag, "collapsible_panel");
  assert.equal(scroll.tag, "div");
  assert.equal(scroll.style.max_height, "360px");
  assert.equal(scroll.style.overflow, "auto");
  assert.equal(scroll.elements[0].element_id, "bash_run_content");
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
    "stream:card_bash:false:3"
  ]);
  assert.match(client.contents.at(-1) ?? "", /cwd: \/workspace/);
  assert.match(client.contents.at(-1) ?? "", /status: exited 0/);
  assert.match(client.contents.at(-1) ?? "", /ok/);
  assert.match(client.contents.at(-1) ?? "", /\[stderr\] warn/);
});

test("docker executor runs in a fixed container when explicitly enabled", async (t) => {
  if (process.env.BASH_SANDBOX_DOCKER_TEST !== "1") {
    t.skip("set BASH_SANDBOX_DOCKER_TEST=1 to run Docker integration");
    return;
  }
  const config = testConfig({ containerName: `alice-bash-sandbox-test-${process.pid}` });
  fs.mkdirSync(config.skillsMount.hostPath, { recursive: true });
  const image = childProcess.spawnSync("docker", ["image", "inspect", config.image], { stdio: "ignore" });
  if (image.status !== 0) {
    t.skip(`Docker image is not available locally: ${config.image}`);
    return;
  }
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
    enabled: true,
    containerName: "test-bash-sandbox",
    image: "node:22-bookworm-slim",
    defaultCwd: "/workspace",
    workspaceDir: "/workspace",
    tmpDir: "/tmp",
    skillsMount: { hostPath: path.join(root, "skills"), containerPath: "/skills", readOnly: true },
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

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}
