import { test } from "node:test";
import assert from "node:assert/strict";
import { makeShellStore, makeShellTools, parseToolOutput } from "./shell-tools-helpers.js";

test("wardrobe list returns current outfit and searchable outfits", async () => {
  const store = makeShellStore("wardrobe-list", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two", group: "formal" }
  ]);
  store.switchOutfit(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai", "o2");
  const tools = makeShellTools("wardrobe-list", store);

  const result = await tools.execute({ id: "call_list", toolName: "Wardrobe", input: { action: "list" } });
  const output = parseToolOutput(result);

  assert.equal(result.ok, true);
  assert.equal(output.current.id, "o2");
  assert.deepEqual(output.outfits.map((item: any) => [item.id, item.current]), [["o1", false], ["o2", true]]);

  const nameFiltered = await tools.execute({ id: "call_filter", toolName: "Wardrobe", input: { action: "list", name: "Two" } });
  assert.deepEqual(parseToolOutput(nameFiltered).outfits.map((item: any) => item.name), ["O Two"]);

  const groupFiltered = await tools.execute({ id: "call_filter_group", toolName: "Wardrobe", input: { action: "list", name: "formal" } });
  assert.deepEqual(parseToolOutput(groupFiltered).outfits.map((item: any) => item.name), ["O Two"]);
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
  assert.equal(result.output, "你看到镜子中的自己穿着: \n 服装：O Two\noutfit two");
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
  const output = parseToolOutput(result);

  assert.equal(result.ok, true);
  assert.equal(output.message, "服装已切换为O Two");
  assert.equal(output.current.id, "o2");
});

test("wardrobe switch requires a current target and known outfit name", async () => {
  const store = makeShellStore("wardrobe-errors", [{ id: "o1", name: "O One", content: "outfit one" }]);
  const tools = makeShellTools("wardrobe-errors", store);

  const noTarget = await tools.execute({ id: "call_no_target", toolName: "Wardrobe", input: { action: "switch", name: "O One" } });
  assert.equal(noTarget.ok, false);
  assert.match(noTarget.error ?? "", /No current messaging session/);

  const withTarget = makeShellTools("wardrobe-errors-target", store, {
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });
  const unknown = await withTarget.execute({ id: "call_unknown", toolName: "Wardrobe", input: { action: "switch", name: "missing" } });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error ?? "", /unknown outfit name/);
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
  assert.match(result.error ?? "", /ambiguous outfit name/);
  assert.deepEqual(parseToolOutput(result).candidates.map((item: any) => item.name).sort(), ["白色女仆装", "黑色女仆装"].sort());
});
