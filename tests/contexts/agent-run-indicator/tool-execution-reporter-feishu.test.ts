import { test } from "node:test";
import assert from "node:assert/strict";
import { createFeishuToolExecutionReporter } from "../../../src/contexts/agent-run-indicator/src/index.js";
import { buildToolExecutionCard } from "../../../src/channels/feishu/src/client.js";
import { fakeFeishuCardClient } from "./tool-execution-reporter-helpers.js";

test("Feishu tool execution card contains collapsed call and result blocks", () => {
  const card = buildToolExecutionCard("Bash", "call", "result") as any;
  const [panel] = card.body.elements;

  assert.equal(panel.tag, "collapsible_panel");
  assert.equal(panel.expanded, false);
  assert.equal(panel.header.title.content, "Bash: running");
  assert.equal(panel.elements.length, 2);
  assert.equal(panel.elements[0].tag, "markdown");
  assert.equal(panel.elements[1].tag, "markdown");
});

test("Feishu tool execution reporter streams progress then writes the result", async () => {
  const client = fakeFeishuCardClient();
  const reporter = createFeishuToolExecutionReporter({
    client,
    pairingStore: { list: () => [{ userId: "ou_user" }] } as any,
    throttleMs: 1000
  });
  const session = await reporter.begin({ id: "bash", toolName: "Bash", input: { command: "npm test" } });

  assert.ok(session);
  await session.appendProgress("ok\n");
  await session.finish({ callId: "bash", ok: true, output: "done" });

  assert.equal(client.calls.some((call) => call.kind === "create" && call.receiveId === "ou_user"), true);
  assert.equal(client.calls.some((call) => call.kind === "stream" && call.enabled), true);
  assert.equal(client.calls.some((call) => call.kind === "update" && call.block === "result" && call.content.includes("ok")), true);
  assert.equal(client.calls.some((call) => call.kind === "update" && call.block === "result" && call.content.includes("done")), true);
  assert.equal(client.calls.some((call) => call.kind === "update" && call.block === "title" && call.content === "Bash: finished"), true);
});

test("Feishu tool execution reporter keeps markdown fences inside progress", async () => {
  const client = fakeFeishuCardClient();
  const reporter = createFeishuToolExecutionReporter({
    client,
    pairingStore: { list: () => [{ userId: "ou_user" }] } as any,
    throttleMs: 1000
  });
  const session = await reporter.begin({ id: "ticks", toolName: "Bash", input: {} });

  assert.ok(session);
  await session.appendProgress("before\n```text\ninside\n```\nafter\n");
  await session.finish({ callId: "ticks", ok: true });

  assert.equal(client.contents.length > 0, true);
});

test("Feishu tool execution reporter appends consecutive tools to one card", async () => {
  const client = fakeFeishuCardClient();
  const reporter = createFeishuToolExecutionReporter({
    client,
    pairingStore: { list: () => [{ userId: "ou_user" }] } as any,
    throttleMs: 1000
  });

  const first = await reporter.begin({ id: "one", toolName: "Bash", input: {} });
  assert.ok(first);
  await first.finish({ callId: "one", ok: true });
  const second = await reporter.begin({ id: "two", toolName: "Dice", input: {} });
  assert.ok(second);
  await second.finish({ callId: "two", ok: true });

  assert.equal(client.calls.some((call) => call.kind === "create" && call.toolName === "Bash"), true);
  assert.equal(client.calls.some((call) => call.kind === "append" && call.toolName === "Dice"), true);
});
