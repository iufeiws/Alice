import { test } from "node:test";
import assert from "node:assert/strict";
import { makeShellStore, makeShellTools } from "./shell-tools-helpers.js";

test("wardrobe list returns outfit groups", async () => {
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
});

test("wardrobe list finds an outfit by name", async () => {
  const store = makeShellStore("wardrobe-list-name", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two", group: "formal" }
  ]);
  const tools = makeShellTools("wardrobe-list-name", store);

  const nameFiltered = await tools.execute({ id: "call_filter", toolName: "Wardrobe", input: { action: "list", name: "Two" } });

  assert.equal(nameFiltered.ok, true);
});

test("wardrobe list finds outfits by group", async () => {
  const store = makeShellStore("wardrobe-list-group", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two", group: "formal" },
    { id: "o3", name: "O Three", content: "outfit three", group: "formal" }
  ]);
  const tools = makeShellTools("wardrobe-list-group", store);

  const groupFiltered = await tools.execute({ id: "call_filter_group", toolName: "Wardrobe", input: { action: "list", name: "formal" } });

  assert.equal(groupFiltered.ok, true);
});

test("wardrobe list renders compact tags for broad matches", async () => {
  const store = makeShellStore("wardrobe-list-compact", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two", group: "formal" },
    { id: "o3", name: "O Three", content: "outfit three", group: "formal" },
    { id: "o4", name: "O Four", content: "outfit four", group: "casual" }
  ]);
  const tools = makeShellTools("wardrobe-list-compact", store);

  const compact = await tools.execute({ id: "call_filter_compact", toolName: "Wardrobe", input: { action: "list", name: "O" } });

  assert.equal(compact.ok, true);
});

test("wardrobe mirror returns the current outfit", async () => {
  const store = makeShellStore("wardrobe-mirror", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);
  store.switchOutfit(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai", "o2");
  const tools = makeShellTools("wardrobe-mirror", store);

  const result = await tools.execute({ id: "call_mirror", toolName: "Wardrobe", input: { action: "mirror" } });

  assert.equal(result.ok, true);
});

test("wardrobe mirror does not send a message", async () => {
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
  assert.equal(store.get(new Date("2026-05-26T12:31:00.000Z"), "Asia/Shanghai").outfit.id, "o2");
});

test("wardrobe switch requires a current target", async () => {
  const store = makeShellStore("wardrobe-no-target", [{ id: "o1", name: "O One", content: "outfit one" }]);
  const tools = makeShellTools("wardrobe-no-target", store);

  const noTarget = await tools.execute({ id: "call_no_target", toolName: "Wardrobe", input: { action: "switch", name: "O One" } });

  assert.equal(noTarget.ok, false);
});

test("wardrobe switch rejects unknown outfit names", async () => {
  const store = makeShellStore("wardrobe-unknown", [{ id: "o1", name: "O One", content: "outfit one" }]);

  const withTarget = makeShellTools("wardrobe-unknown", store, {
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });
  const unknown = await withTarget.execute({ id: "call_unknown", toolName: "Wardrobe", input: { action: "switch", name: "missing" } });

  assert.equal(unknown.ok, false);
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
  assert.equal(result.output, '<O Two group="root">\noutfit two\n</O Two>');
  assert.equal(store.get(new Date("2026-05-26T12:31:00.000Z"), "Asia/Shanghai").outfit.id, "o2");
});
