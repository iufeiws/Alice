import { test } from "node:test";
import assert from "node:assert/strict";
import { createFeishuToolExecutionReporter } from "../../../src/contexts/agent-run-indicator/src/index.js";
import { buildToolExecutionCard, buildToolExecutionGroup } from "../../../src/channels/feishu/src/client.js";
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

test("Feishu tool execution group nests collapsed panels and shows its count", () => {
  const group = buildToolExecutionGroup([{
    toolName: "Bash",
    state: "finished",
    call: "call",
    result: "result",
    titleElementId: "tool_1_title",
    callElementId: "tool_1_call",
    resultElementId: "tool_1_result"
  }, {
    toolName: "Read",
    state: "running",
    call: "call",
    result: "result",
    titleElementId: "tool_2_title",
    callElementId: "tool_2_call",
    resultElementId: "tool_2_result"
  }], "tool_calls_root") as any;

  assert.equal(group.expanded, false);
  assert.equal(group.header.title.content, "Tool Calls [2]");
  assert.equal(group.elements.length, 2);
  assert.equal(group.elements[0].expanded, false);
  assert.equal(group.elements[0].header.title.content, "Bash: finished");
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
  await session.finish({ callId: "bash", ok: true, output: JSON.stringify({ done: true }), error: "ignored error" });

  const created = client.calls.find((call) => call.kind === "create");
  assert.ok(created?.kind === "create");
  assert.equal(created.call.includes("[command]\nnpm test"), true);
  assert.equal(created.call.includes('"toolName"'), false);
  assert.equal(created.call.includes('"id"'), false);
  assert.equal(client.calls.some((call) => call.kind === "stream" && call.enabled), true);
  assert.equal(client.calls.some((call) => call.kind === "update" && call.block === "result" && call.content.includes("ok")), true);
  assert.equal(client.calls.some((call) => call.kind === "update" && call.block === "result" && call.content.includes("[done]\ntrue")), true);
  assert.equal(client.calls.some((call) => call.kind === "update" && call.block === "result" && call.content.includes("ignored error")), false);
  assert.equal(client.calls.some((call) => call.kind === "update" && call.block === "result" && call.content.includes('"callId"')), false);
  assert.equal(client.calls.some((call) => call.kind === "update" && call.block === "title" && call.content === "Bash: finished"), true);
});

test("Feishu tool execution reporter recursively formats nested objects with indentation", async () => {
  const client = fakeFeishuCardClient();
  const reporter = createFeishuToolExecutionReporter({
    client,
    pairingStore: { list: () => [{ userId: "ou_user" }] } as any
  });
  const session = await reporter.begin({
    id: "nested",
    toolName: "Bash",
    input: {
      request: {
        reason: "删除 tease.json",
        options: { force: true }
      },
      files: ["tease.json", "care.json"]
    }
  });

  assert.ok(session);
  const created = client.calls.find((call) => call.kind === "create");
  assert.ok(created?.kind === "create");
  assert.equal(created.call.includes("[request]\n  [reason]\n  删除 tease.json\n\n  [options]\n    [force]\n    true"), true);
  assert.equal(created.call.includes("[files]\n  [\n    \"tease.json\",\n    \"care.json\"\n  ]"), true);
});

test("Feishu tool execution reporter selects output or error from ok state", async () => {
  const client = fakeFeishuCardClient();
  const reporter = createFeishuToolExecutionReporter({
    client,
    pairingStore: { list: () => [{ userId: "ou_user" }] } as any
  });
  const session = await reporter.begin({ id: "failed", toolName: "Read", input: {} });

  assert.ok(session);
  await session.finish({ callId: "failed", ok: false, output: "ignored output", error: "formatted error" });

  assert.equal(client.calls.some((call) => call.kind === "update" && call.block === "result" && call.content.includes("formatted error")), true);
  assert.equal(client.calls.some((call) => call.kind === "update" && call.block === "result" && call.content.includes("ignored output")), false);

  const crashed = await reporter.begin({ id: "crashed", toolName: "Read", input: {} });
  assert.ok(crashed);
  await crashed.fail(new Error("crashed tool"));
  const crashResult = client.calls.filter((call) => call.kind === "update" && call.block === "result").at(-1);
  assert.ok(crashResult?.kind === "update");
  assert.equal(crashResult.content.includes("crashed tool"), true);
  assert.equal(crashResult.content.includes('"error"'), false);
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

test("Feishu tool execution reporter groups only multiple consecutive tools and counts them", async () => {
  const client = fakeFeishuCardClient();
  const reporter = createFeishuToolExecutionReporter({
    client,
    pairingStore: { list: () => [{ userId: "ou_user" }] } as any,
    throttleMs: 1000
  });

  const first = await reporter.begin({ id: "one", toolName: "Bash", input: {} });
  assert.ok(first);
  await first.finish({ callId: "one", ok: true });
  assert.equal(client.calls.some((call) => call.kind === "group"), false);

  const second = await reporter.begin({ id: "two", toolName: "Dice", input: {} });
  assert.ok(second);
  await second.finish({ callId: "two", ok: true });
  const third = await reporter.begin({ id: "three", toolName: "Read", input: {} });
  assert.ok(third);
  await third.finish({ callId: "three", ok: true });

  assert.equal(client.calls.some((call) => call.kind === "create" && call.toolName === "Bash"), true);
  assert.equal(client.calls.some((call) => call.kind === "group" && call.count === 2 && call.toolNames.join(",") === "Bash,Dice"), true);
  assert.equal(client.calls.some((call) => call.kind === "group" && call.count === 3 && call.toolNames.join(",") === "Bash,Dice,Read"), true);
});

test("Feishu tool execution reporter starts a new card after the sequence ends", async () => {
  const client = fakeFeishuCardClient();
  const reporter = createFeishuToolExecutionReporter({
    client,
    pairingStore: { list: () => [{ userId: "ou_user" }] } as any
  });

  const first = await reporter.begin({ id: "one", toolName: "Bash", input: {} });
  assert.ok(first);
  await first.finish({ callId: "one", ok: true });
  await reporter.endSequence();
  const second = await reporter.begin({ id: "two", toolName: "Read", input: {} });
  assert.ok(second);

  assert.equal(client.calls.filter((call) => call.kind === "create").length, 2);
  assert.equal(client.calls.some((call) => call.kind === "group"), false);
});
