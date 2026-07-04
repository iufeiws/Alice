import { test } from "node:test";
import assert from "node:assert/strict";
import { makeShellStore, makeShellTools } from "./shell-tools-helpers.js";

test("wardrobe list returns groups or searchable outfits", async () => {
  const store = makeShellStore("wardrobe-list", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two", group: "formal" },
    { id: "o3", name: "O Three", content: "outfit three", group: "formal" },
    { id: "o4", name: "O Four", content: "outfit four", group: "casual" }
  ]);
  store.switchOutfit(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai", "o2");
  const tools = makeShellTools("wardrobe-list", store);

  const result = await tools.execute({ id: "call_list", toolName: "Wardrobe", input: { action: "list" } });

  assert.equal(result.ok, true);
  assert.equal(result.output, "<groups>\nroot\ncasual\nformal\n</groups>");

  const nameFiltered = await tools.execute({ id: "call_filter", toolName: "Wardrobe", input: { action: "list", name: "Two" } });
  assert.equal(nameFiltered.output, "<O Two group=\"formal\">\noutfit two\n</O Two>");

  const groupFiltered = await tools.execute({ id: "call_filter_group", toolName: "Wardrobe", input: { action: "list", name: "formal" } });
  assert.equal(groupFiltered.output, "<O Three group=\"formal\">\noutfit three\n</O Three>\n<O Two group=\"formal\">\noutfit two\n</O Two>");

  const compact = await tools.execute({ id: "call_filter_compact", toolName: "Wardrobe", input: { action: "list", name: "O" } });
  assert.equal(compact.output, "<O One group=\"root\" />\n<O Four group=\"casual\" />\n<O Three group=\"formal\" />\n<O Two group=\"formal\" />");
});

test("wardrobe mirror returns the current outfit without sending a message", async () => {
  const store = makeShellStore("wardrobe-mirror", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);
  store.switchOutfit(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai", "o2");
  const sent: unknown[] = [];
  const tools = makeShellTools("wardrobe-mirror", store, {
    outputRouter: {
      async send(output) {
        sent.push(output);
      }
    }
  });

  const result = await tools.execute({ id: "call_mirror", toolName: "Wardrobe", input: { action: "mirror" } });

  assert.equal(result.ok, true);
  assert.equal(result.output, "<O Two group=\"root\">\noutfit two\n</O Two>");
  assert.deepEqual(sent, []);
});

test("wardrobe switch returns changed outfit message", async () => {
  const store = makeShellStore("wardrobe-switch-action", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);
  const tools = makeShellTools("wardrobe-switch-action", store, {
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const result = await tools.execute({ id: "call_switch", toolName: "Wardrobe", input: { action: "switch", name: "O Two" } });

  assert.equal(result.ok, true);
  assert.equal(result.output, "success");
  assert.equal(store.get(new Date("2026-05-26T12:31:00.000Z"), "Asia/Shanghai").outfit.id, "o2");
});

test("wardrobe switch requires a current target and known outfit name", async () => {
  const store = makeShellStore("wardrobe-errors", [{ id: "o1", name: "O One", content: "outfit one" }]);
  const tools = makeShellTools("wardrobe-errors", store);

  const noTarget = await tools.execute({ id: "call_no_target", toolName: "Wardrobe", input: { action: "switch", name: "O One" } });
  assert.equal(noTarget.ok, false);
  assert.equal(noTarget.error, "<error>No current messaging session is available</error>");

  const withTarget = makeShellTools("wardrobe-errors-target", store, {
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });
  const unknown = await withTarget.execute({ id: "call_unknown", toolName: "Wardrobe", input: { action: "switch", name: "missing" } });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "<error>unknown outfit name</error>");
});

test("wardrobe switch returns candidates for ambiguous names", async () => {
  const store = makeShellStore("wardrobe-ambiguous", [
    { id: "maid_black", name: "黑色女仆装", content: "black maid outfit" },
    { id: "maid_white", name: "白色女仆装", content: "white maid outfit" }
  ]);
  const tools = makeShellTools("wardrobe-ambiguous", store, {
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const result = await tools.execute({ id: "call_ambiguous", toolName: "Wardrobe", input: { action: "switch", name: "女仆" } });
  assert.equal(result.ok, false);
  assert.equal(result.error, "<error>ambiguous outfit name: 女仆</error>");
  assert.equal(result.output, [
    "<error>ambiguous outfit name: 女仆</error>",
    "<candidates>",
    "<白色女仆装 group=\"root\">",
    "white maid outfit",
    "</白色女仆装>",
    "<黑色女仆装 group=\"root\">",
    "black maid outfit",
    "</黑色女仆装>",
    "</candidates>"
  ].join("\n"));
});

test("wardrobe random switches a matching outfit", async () => {
  const store = makeShellStore("wardrobe-random", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);
  const tools = makeShellTools("wardrobe-random", store, {
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const result = await tools.execute({ id: "call_random", toolName: "Wardrobe", input: { action: "random", name: "Two" } });

  assert.equal(result.ok, true);
  assert.equal(result.output, "success");
  assert.equal(store.get(new Date("2026-05-26T12:31:00.000Z"), "Asia/Shanghai").outfit.id, "o2");
});
