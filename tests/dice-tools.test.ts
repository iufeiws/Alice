import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiceTools } from "../src/capabilities/tools/dice/src/index.js";

test("dice defaults to 1d6 and returns xml", async () => {
  const tools = createDiceTools({ random: () => 0.5 });
  const tool = tools.listTools()[0];

  assert.equal(tool.name, "dice");
  assert.equal(tool.description, "投掷骰子。sides > 1, 默认 6；count > 0 默认 1；");
  assert.deepEqual(tool.inputSchema, {
    type: "object",
    properties: {
      sides: { type: "integer", minimum: 2 },
      count: { type: "integer", minimum: 1 }
    },
    additionalProperties: false
  });

  const result = await tools.execute({ id: "call_default", toolName: "dice", input: {} });

  assert.equal(result.ok, true);
  assert.equal(result.output, '<dice point="4"/>');
});

test("dice returns roll expression for multiple dice", async () => {
  const rolls = [0, 0.5, 0.999];
  const tools = createDiceTools({ random: () => rolls.shift() ?? 0 });
  const result = await tools.execute({ id: "call_multi", toolName: "dice", input: { sides: 10, count: 3 } });

  assert.equal(result.ok, true);
  assert.equal(result.output, '<dice point="1+6+10 = 17"/>');
});

test("dice rejects invalid sides and count", async () => {
  const tools = createDiceTools();

  assert.equal((await tools.execute({ id: "bad_sides", toolName: "dice", input: { sides: 1 } })).ok, false);
  assert.equal((await tools.execute({ id: "bad_count", toolName: "dice", input: { count: 0 } })).ok, false);
});
