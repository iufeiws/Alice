import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backfillTokenUsageFromLogs } from "../../scripts/backfill-token-usage-from-logs.js";
import { createTokenUsageStore } from "../../src/platform/storage/src/token-usage-store.js";
import { makeTempDir } from "../contexts/llm-gateway/llm-and-storage-helpers.js";

test("token usage backfill writes only matched raw usage and is repeatable", () => {
  const root = makeTempDir("token-usage-backfill");
  const rawLogDir = join(root, "raw");
  const systemLogDir = join(root, "system");
  const databasePath = join(root, "token-usage.sqlite");
  mkdirSync(rawLogDir, { recursive: true });
  mkdirSync(systemLogDir, { recursive: true });
  createTokenUsageStore(databasePath).report();
  writeFileSync(join(rawLogDir, "stream.jsonl"), `${JSON.stringify({
    captureId: "capture-1",
    data: JSON.stringify({
      id: "completion-1",
      created: Date.parse("2026-08-23T04:57:21.000Z") / 1000,
      model: "chat-model",
      choices: [{ finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 4 } }
    })
  })}\n`);
  writeFileSync(join(systemLogDir, "2026-08-23.log.jsonl"), `${JSON.stringify({
    time: "2026-08-23T12:57:33.602",
    utcTime: "2026-08-23T04:57:33.602Z",
    message: "llm stream end: agent=chat round=0 model=chat-model"
  })}\n${JSON.stringify({
    time: "2026-08-23T12:58:33.602",
    utcTime: "2026-08-23T04:58:33.602Z",
    message: "llm stream end: agent=chat round=1 model=other-model"
  })}\n`);

  const dryRun = backfillTokenUsageFromLogs({ rawLogDir, systemLogDir, databasePath });
  assert.deepEqual({ discovered: dryRun.discoveredUsage, matched: dryRun.matched, inserted: dryRun.inserted }, { discovered: 1, matched: 1, inserted: 0 });
  assert.equal(createTokenUsageStore(databasePath).report().summary.requests, 0);

  const applied = backfillTokenUsageFromLogs({ rawLogDir, systemLogDir, databasePath, apply: true });
  assert.equal(applied.inserted, 1);
  const event = createTokenUsageStore(databasePath).report().latest[0];
  assert.deepEqual({ agentId: event.agentId, model: event.model, input: event.inputTokens, output: event.outputTokens, total: event.totalTokens, hit: event.cacheHitTokens, miss: event.cacheMissTokens }, {
    agentId: "chat", model: "chat-model", input: 10, output: 2, total: 12, hit: 4, miss: 6
  });

  const rerun = backfillTokenUsageFromLogs({ rawLogDir, systemLogDir, databasePath, apply: true });
  assert.deepEqual({ inserted: rerun.inserted, alreadyRecorded: rerun.alreadyRecorded }, { inserted: 0, alreadyRecorded: 1 });
});
