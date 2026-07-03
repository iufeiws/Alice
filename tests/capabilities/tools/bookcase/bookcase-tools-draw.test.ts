import { test } from "node:test";
import assert from "node:assert/strict";
import { createBookcaseTools } from "../../../../src/capabilities/tools/bookcase/src/index.js";
import { createFixtureDb, fixedTime, fixtureCounts, fixtureSummary } from "./bookcase-tools-helpers.js";

test("bookcase draw returns a fixed-prefix book without changing the database", async () => {
  const dbPath = createFixtureDb();
  const before = fixtureCounts(dbPath);
  const tools = createBookcaseTools({ dbPath, getUserName: () => "YY", time: fixedTime() });

  const result = await tools.execute({
    id: "call_bookcase",
    toolName: "Bookcase",
    input: { action: "draw", genre: "Fantasy", seed: 7, minSummaryChars: 10 }
  });

  assert.equal(result.callId, "call_bookcase");
  assert.equal(result.ok, true);
  assert.equal(result.resetLLMSession, true);
  assert.equal(result.fixedPrefixKind, "bookcase");
  assert.equal(result.fixedPrefixTtlMs, 2 * 60 * 60 * 1000);

  const output = String(result.output);
  assert.match(output, /^<book>/);
  assert.match(output, /<title>Moon Gate<\/title>/);
  assert.match(output, /<author>A\. Writer<\/author>/);
  assert.match(output, /<publication_date>2001<\/publication_date>/);
  assert.match(output, /- Fantasy/);
  assert.match(output, /- Fiction/);
  assert.match(output, new RegExp(fixtureSummary));
  assert.match(output, /YY/);
  assert.match(output, /<time>2026-05-25 08:00:00<\\time>/);
  assert.deepEqual(fixtureCounts(dbPath), before);
});

test("bookcase draw reports no matching summaries and leaves the database untouched", async () => {
  const dbPath = createFixtureDb();
  const before = fixtureCounts(dbPath);
  const tools = createBookcaseTools({ dbPath });

  const result = await tools.execute({
    id: "call_bookcase_none",
    toolName: "Bookcase",
    input: { action: "draw", title: "missing" }
  });

  assert.equal(result.callId, "call_bookcase_none");
  assert.equal(result.ok, false);
  assert.equal(result.error, "no matching book summaries found");
  assert.deepEqual(fixtureCounts(dbPath), before);
});
