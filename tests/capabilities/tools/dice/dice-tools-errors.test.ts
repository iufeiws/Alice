import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiceTools } from "../../../../src/capabilities/tools/dice/src/index.js";

test("dice rejects invalid sides", async () => {
  const tools = createDiceTools();
  const result = await tools.execute({ id: "bad_sides", toolName: "Dice", input: { sides: 1 } });

  assert.equal(result.ok, false);
});

test("dice rejects invalid count", async () => {
  const tools = createDiceTools();
  const result = await tools.execute({ id: "bad_count", toolName: "Dice", input: { count: 0 } });

  assert.equal(result.ok, false);
});

test("dice rejects unknown tool", async () => {
  const tools = createDiceTools();
  const result = await tools.execute({ id: "bad_tool", toolName: "NotDice", input: {} });

  assert.equal(result.ok, false);
});
