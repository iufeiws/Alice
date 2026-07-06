import { test } from "node:test";
import { testPromptRuntime } from "../../../helpers/prompt-runtime.js";
import assert from "node:assert/strict";
import { createBookcaseTools } from "../../../../src/capabilities/tools/bookcase/src/index.js";
import { createFixtureDb, fixedTime, fixtureCounts } from "./bookcase-tools-helpers.js";

async function drawFantasyBook(dbPath = createFixtureDb()) {
  const tools = createBookcaseTools({ promptContextRuntime: testPromptRuntime({ user: "YY" }), dbPath, getUserName: () => "YY", time: fixedTime() });

  return tools.execute({
    id: "call_bookcase",
    toolName: "Bookcase",
    input: { action: "draw", genre: "Fantasy", seed: 7, minSummaryChars: 10 }
  });
}

test("bookcase draw returns a fixed-prefix book", async () => {
  const result = await drawFantasyBook();

  assert.equal(result.callId, "call_bookcase");
  assert.equal(result.ok, true);
  assert.equal(result.resetLLMSession, true);
  assert.equal(result.fixedPrefixKind, "bookcase");
  assert.equal(result.fixedPrefixTtlMs, 2 * 60 * 60 * 1000);
});

test("bookcase draw does not change the database", async () => {
  const dbPath = createFixtureDb();
  const before = fixtureCounts(dbPath);

  await drawFantasyBook(dbPath);

  assert.deepEqual(fixtureCounts(dbPath), before);
});

async function drawMissingBook(dbPath = createFixtureDb()) {
  const tools = createBookcaseTools({ promptContextRuntime: testPromptRuntime(), dbPath });

  return tools.execute({
    id: "call_bookcase_none",
    toolName: "Bookcase",
    input: { action: "draw", title: "missing" }
  });
}

test("bookcase draw reports no matching summaries", async () => {
  const result = await drawMissingBook();

  assert.equal(result.callId, "call_bookcase_none");
  assert.equal(result.ok, false);
});

test("bookcase draw missing summary does not change the database", async () => {
  const dbPath = createFixtureDb();
  const before = fixtureCounts(dbPath);

  await drawMissingBook(dbPath);

  assert.deepEqual(fixtureCounts(dbPath), before);
});
