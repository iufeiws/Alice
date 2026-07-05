import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiceTools } from "../../../../src/capabilities/tools/dice/src/index.js";

test("dice exposes Dice tool", () => {
  const tools = createDiceTools({ random: () => 0.5 });

  assert.equal(tools.listTools().map((tool) => tool.name).includes("Dice"), true);
});

test("dice defaults to 1d6 xml output", async () => {
  const tools = createDiceTools({ random: () => 0.5 });

  const result = await tools.execute({ id: "call_default", toolName: "Dice", input: {} });

  assert.equal(result.ok, true);
  assert.equal(result.output, '<dice point="4"/>');
});

test("dice uses sides/count inputs and returns multi-roll expression", async () => {
  const rolls = [0, 0.5, 0.999];
  const tools = createDiceTools({ random: () => rolls.shift() ?? 0 });
  const result = await tools.execute({ id: "call_multi", toolName: "Dice", input: { sides: 10, count: 3 } });

  assert.equal(result.ok, true);
  assert.equal(result.output, '<dice point="1+6+10 = 17"/>');
});
