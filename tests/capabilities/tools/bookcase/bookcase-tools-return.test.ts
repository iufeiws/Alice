import { test } from "node:test";
import assert from "node:assert/strict";
import { createBookcaseTools } from "../../../../src/capabilities/tools/bookcase/src/index.js";
import { createFixtureDb, fixtureCounts } from "./bookcase-tools-helpers.js";

test("bookcase return clears fixed prefix without changing the database", async () => {
  const dbPath = createFixtureDb();
  const before = fixtureCounts(dbPath);
  const tools = createBookcaseTools({ dbPath });

  const result = await tools.execute({
    id: "call_bookcase_return",
    toolName: "Bookcase",
    input: { action: "return" }
  });

  assert.equal(result.callId, "call_bookcase_return");
  assert.equal(result.ok, true);
  assert.equal(result.resetLLMSession, true);
  assert.equal(result.clearFixedPrefix, true);
  assert.equal(result.invalidateLLMSession, undefined);
  assert.equal(String(result.output), [
    '<bookcase action="return" clear_fixed_prefix="true">',
    "  <message>书已归还书橱；当前固定前缀已解除。</message>",
    "</bookcase>"
  ].join("\n"));
  assert.deepEqual(fixtureCounts(dbPath), before);
});
