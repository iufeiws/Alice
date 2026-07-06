import { test } from "node:test";
import assert from "node:assert/strict";
import { createFeishuBashRunReporter } from "../../../src/contexts/bash-sandbox/src/index.js";
import { buildBashRunCard } from "../../../src/channels/feishu/src/client.js";
import { fakeFeishuCardClient } from "./bash-sandbox-helpers.js";

test("Feishu bash run card exposes command title and output block", () => {
  const card = buildBashRunCard("npm test", "actual output") as any;
  const [panel] = card.body.elements;
  const [output] = panel.elements;

  assert.equal(panel.tag, "collapsible_panel");
  assert.equal(panel.expanded, false);
  assert.equal(output.tag, "markdown");
});

test("Feishu bash reporter streams stdout and stderr to a dedicated bash card", async () => {
  const client = fakeFeishuCardClient();
  const reporter = createFeishuBashRunReporter({
    client,
    pairingStore: { list: () => [{ userId: "ou_user" }] } as any,
    throttleMs: 1000
  });
  const session = await reporter.begin({ call: { id: "bash", toolName: "Bash", input: {} }, command: "npm test", cwd: "/workspace" });

  assert.ok(session);
  await session.appendStdout("ok\n");
  await session.appendStderr("warn\n");
  await session.finish({ command: "npm test", cwd: "/workspace", stdout: "ok\n", stderr: "warn\n", exitCode: 0, timedOut: false, durationMs: 10, truncated: false, denied: false });

  assert.equal(client.calls.some((call) => call.kind === "create" && call.receiveId === "ou_user"), true);
  assert.equal(client.calls.some((call) => call.kind === "stream" && call.enabled), true);
  assert.equal(client.calls.some((call) => call.kind === "update" && call.block === "title"), true);
});

test("Feishu bash reporter keeps markdown fences inside command output", async () => {
  const client = fakeFeishuCardClient();
  const reporter = createFeishuBashRunReporter({
    client,
    pairingStore: { list: () => [{ userId: "ou_user" }] } as any,
    throttleMs: 1000
  });
  const session = await reporter.begin({ call: { id: "bash_ticks", toolName: "bash", input: {} }, command: "printf ticks", cwd: "/workspace" });

  assert.ok(session);
  await session.appendStdout("before\n```text\ninside\n```\nafter\n");
  await session.finish({ command: "printf ticks", cwd: "/workspace", stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false, denied: false });

  assert.equal(client.contents.length > 0, true);
});

test("Feishu bash reporter appends consecutive bash runs to one card", async () => {
  const client = fakeFeishuCardClient();
  const reporter = createFeishuBashRunReporter({
    client,
    pairingStore: { list: () => [{ userId: "ou_user" }] } as any,
    throttleMs: 1000
  });

  const first = await reporter.begin({ call: { id: "bash_1", toolName: "bash", input: {} }, command: "echo one", cwd: "/workspace" });
  assert.ok(first);
  await first.finish({ command: "echo one", cwd: "/workspace", stdout: "one\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false, denied: false });

  const second = await reporter.begin({ call: { id: "bash_2", toolName: "bash", input: {} }, command: "echo two", cwd: "/workspace" });
  assert.ok(second);
  await second.finish({ command: "echo two", cwd: "/workspace", stdout: "two\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false, denied: false });

  assert.equal(client.calls.some((call) => call.kind === "create" && call.command === "echo one"), true);
  assert.equal(client.calls.some((call) => call.kind === "append" && call.command === "echo two"), true);
  assert.equal(client.contents.length > 0, true);
});
