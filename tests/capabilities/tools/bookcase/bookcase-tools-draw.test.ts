import { test } from "node:test";
import assert from "node:assert/strict";
import { createBookcaseTools } from "../../../../src/capabilities/tools/bookcase/src/index.js";
import { createFixtureDb, fixedTime, fixtureCounts, fixtureSummary } from "./bookcase-tools-helpers.js";

async function drawFantasyBook(dbPath = createFixtureDb()) {
  const tools = createBookcaseTools({ dbPath, getUserName: () => "YY", time: fixedTime() });

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
});

test("bookcase draw does not change the database", async () => {
  const dbPath = createFixtureDb();
  const before = fixtureCounts(dbPath);

  await drawFantasyBook(dbPath);

  assert.deepEqual(fixtureCounts(dbPath), before);
});

async function drawMissingBook(dbPath = createFixtureDb()) {
  const tools = createBookcaseTools({ dbPath });

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
  assert.equal(result.error, "no matching book summaries found");
});

test("bookcase draw missing summary does not change the database", async () => {
  const dbPath = createFixtureDb();
  const before = fixtureCounts(dbPath);

  await drawMissingBook(dbPath);

  assert.deepEqual(fixtureCounts(dbPath), before);
});
