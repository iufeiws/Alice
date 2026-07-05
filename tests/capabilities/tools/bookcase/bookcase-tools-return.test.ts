import { test } from "node:test";
import { testPromptRuntime } from "../../../helpers/prompt-runtime.js";
import assert from "node:assert/strict";
import { createBookcaseTools } from "../../../../src/capabilities/tools/bookcase/src/index.js";
import { createFixtureDb, fixtureCounts } from "./bookcase-tools-helpers.js";

async function returnBook(dbPath = createFixtureDb()) {
  const tools = createBookcaseTools({ promptContextRuntime: testPromptRuntime(), dbPath });

  return tools.execute({
    id: "call_bookcase_return",
    toolName: "Bookcase",
    input: { action: "return" }
  });
}

test("bookcase return clears fixed prefix", async () => {
  const result = await returnBook();

  assert.equal(result.callId, "call_bookcase_return");
  assert.equal(result.ok, true);
  assert.equal(result.resetLLMSession, true);
  assert.equal(result.clearFixedPrefix, true);
  assert.equal(result.invalidateLLMSession, undefined);
});

test("bookcase return renders the return message", async () => {
  const result = await returnBook();

  assert.equal(String(result.output), [
    '<bookcase action="return" clear_fixed_prefix="true">',
    "  <message>书已归还书橱；当前固定前缀已解除。</message>",
    "</bookcase>"
  ].join("\n"));
});

test("bookcase return does not change the database", async () => {
  const dbPath = createFixtureDb();
  const before = fixtureCounts(dbPath);

  await returnBook(dbPath);

  assert.deepEqual(fixtureCounts(dbPath), before);
});
