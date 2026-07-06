import { test } from "node:test";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createMarkdownMemoryStore,
  createMemoryDiaryStore,
  enforceMemoryLimits,
  splitMessagesByLongGaps
} from "../../../src/contexts/memory/src/memory.js";
import { createDiaryStore } from "../../../src/platform/storage/src/diary-store.js";
import * as sqlite from "../../../src/platform/storage/src/sqlite-compat.js";
import { makeTempDir, message } from "./sleep-memory-helpers.js";

test("memoryStore_bootstrap_createsRequiredFiles", () => {
  const root = makeTempDir("memory-store");
  const store = createMarkdownMemoryStore(root);
  store.ensure();

  assert.equal(fs.existsSync(path.join(root, "alice.sqlite")), true);
  assert.equal(fs.existsSync(path.join(root, "tmp", "memory-workspaces")), false);
});

test("memoryStore_enforcesMemoryLimits", () => {
  const limited = enforceMemoryLimits({
    persistent: Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n"),
    userPreferences: `${"好".repeat(6000)}\n`,
    yesterdaySummary: Array.from({ length: 30 }, (_, index) => `summary ${index}`).join("\n")
  });

  assert.equal(limited.persistent.trim().split("\n").length, 100);
  assert.equal(new TextEncoder().encode(limited.persistent).length <= 10 * 1024, true);
  assert.equal(new TextEncoder().encode(limited.userPreferences).length <= 8 * 1024, true);
  assert.equal(new TextEncoder().encode(limited.yesterdaySummary).length <= 2 * 1024, true);
  assert.equal(limited.yesterdaySummary.trim().split("\n").length, 20);
});

test("memorySqlStore_separateTargets_persistsRows", () => {
  const root = makeTempDir("memory-separate-sql-tables");
  const store = createMarkdownMemoryStore(root);
  store.writeTarget("persistent", "memory\n");
  store.writeTarget("userPreferences", "pref\n");
  store.writeTarget("yesterdaySummary", "diary\n", { localDate: "2026-06-04", now: "2026-06-04T08:00:00.000Z" });
  const db = new sqlite.DatabaseSync(path.join(root, "alice.sqlite"), { readOnly: true });

  assert.equal(db.prepare("SELECT content FROM persistent_memory_entries ORDER BY id DESC LIMIT 1").get().content, "memory\n");
  assert.equal(db.prepare("SELECT content FROM user_preferences_entries ORDER BY id DESC LIMIT 1").get().content, "pref\n");
  assert.equal(db.prepare("SELECT content FROM diary_entries ORDER BY id DESC LIMIT 1").get().content, "diary\n");
});

test("memorySqlStore_stats_listsTargetTables", () => {
  const root = makeTempDir("memory-sql-stats");
  const store = createMarkdownMemoryStore(root);
  store.writeTarget("persistent", "memory\n");
  store.writeTarget("userPreferences", "pref\n");
  store.writeTarget("yesterdaySummary", "diary\n", { localDate: "2026-06-04", now: "2026-06-04T08:00:00.000Z" });

  assert.deepEqual(store.stats().map((entry) => entry.tableName), ["persistent_memory_entries", "user_preferences_entries", "diary_entries"]);
});

test("memorySqlStore_sleepBoundaryTables_persistsRows", () => {
  const root = makeTempDir("memory-sleep-boundary-tables");
  createMarkdownMemoryStore(root).ensure();
  const diaryStore = createMemoryDiaryStore(root);
  diaryStore.recordSleepBoundary({
    occurredAt: "2026-06-04T01:00:00.000",
    occurredAtUtc: "2026-06-03T17:00:00.000Z",
    source: "sleep",
    now: "2026-06-04T01:00:00.000",
    nowUtc: "2026-06-03T17:00:00.000Z"
  });
  diaryStore.recordSleepPreparationBoundary({
    occurredAt: "2026-06-04T00:30:00.000",
    occurredAtUtc: "2026-06-03T16:30:00.000Z",
    now: "2026-06-04T01:00:00.000",
    nowUtc: "2026-06-03T17:00:00.000Z"
  });
  diaryStore.recordWakeBoundary({
    occurredAt: "2026-06-04T07:00:00.000",
    occurredAtUtc: "2026-06-03T23:00:00.000Z",
    now: "2026-06-04T07:00:00.000",
    nowUtc: "2026-06-03T23:00:00.000Z"
  });
  const db = new sqlite.DatabaseSync(path.join(root, "alice.sqlite"), { readOnly: true });

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM diary_entries").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sleep_boundaries").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sleep_preparation_boundaries").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM wake_boundaries").get().count, 1);
});

test("memorySqlStore_currentDiarySqlite_doesNotImportEntries", () => {
  const root = makeTempDir("memory-ignore-current-diary-sqlite");
  const diaryStore = createDiaryStore(path.join(root, "diary", "diary.sqlite"));
  diaryStore.upsertEntry({
    localDate: "2026-06-04",
    content: "diary\n",
    now: "2026-06-04T01:00:00.000",
    windowStartAt: "2026-06-03T20:00:00.000",
    windowEndAt: "2026-06-04T01:00:00.000"
  });
  diaryStore.recordSleepBoundary({
    occurredAt: "2026-06-04T01:00:00.000",
    occurredAtUtc: "2026-06-03T17:00:00.000Z",
    source: "sleep",
    now: "2026-06-04T01:00:00.000",
    nowUtc: "2026-06-03T17:00:00.000Z"
  });
  diaryStore.recordSleepPreparationBoundary({
    occurredAt: "2026-06-04T00:30:00.000",
    occurredAtUtc: "2026-06-03T16:30:00.000Z",
    now: "2026-06-04T01:00:00.000",
    nowUtc: "2026-06-03T17:00:00.000Z"
  });

  createMarkdownMemoryStore(root).ensure();
  const migratedStore = createMemoryDiaryStore(root);
  const db = new sqlite.DatabaseSync(path.join(root, "alice.sqlite"), { readOnly: true });

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM diary_entries").get().count, 0);
  assert.deepEqual(migratedStore.listSleepBoundaries().map((entry) => entry.occurredAt), []);
  assert.deepEqual(migratedStore.listSleepPreparationBoundaries().map((entry) => entry.occurredAt), []);
});

test("diaryStore_sleepPreparationBoundaries_listsRecordedBoundaries", () => {
  const root = makeTempDir("diary-sleep-preparation-boundaries");
  const store = createDiaryStore(path.join(root, "diary.sqlite"));

  const first = store.recordSleepPreparationBoundary({
    occurredAt: "2026-05-24T23:00:00.000",
    occurredAtUtc: "2026-05-24T15:00:00.000Z",
    now: "2026-05-24T23:00:00.000",
    nowUtc: "2026-05-24T15:00:00.000Z"
  });
  const second = store.recordSleepPreparationBoundary({
    occurredAt: "2026-05-25T01:00:00.000",
    occurredAtUtc: "2026-05-24T17:00:00.000Z",
    now: "2026-05-25T01:00:00.000",
    nowUtc: "2026-05-24T17:00:00.000Z"
  });

  assert.equal(store.latestSleepPreparationBoundary()?.id, second.id);
  assert.deepEqual(store.listSleepPreparationBoundaries().map((boundary) => boundary.id), [first.id, second.id]);
});

test("diaryStore_sleepPreparationBoundaries_deletesLatestBoundary", () => {
  const root = makeTempDir("diary-sleep-preparation-delete");
  const store = createDiaryStore(path.join(root, "diary.sqlite"));
  const first = store.recordSleepPreparationBoundary({
    occurredAt: "2026-05-24T23:00:00.000",
    occurredAtUtc: "2026-05-24T15:00:00.000Z",
    now: "2026-05-24T23:00:00.000",
    nowUtc: "2026-05-24T15:00:00.000Z"
  });
  const second = store.recordSleepPreparationBoundary({
    occurredAt: "2026-05-25T01:00:00.000",
    occurredAtUtc: "2026-05-24T17:00:00.000Z",
    now: "2026-05-25T01:00:00.000",
    nowUtc: "2026-05-24T17:00:00.000Z"
  });
  const deleted = store.deleteLatestSleepPreparationBoundary();

  assert.equal(deleted?.id, second.id);
  assert.equal(store.latestSleepPreparationBoundary()?.id, first.id);
  assert.deepEqual(store.listSleepPreparationBoundaries().map((boundary) => boundary.id), [first.id]);
});

test("diaryStore_wakeBoundaries_deduplicatesByOccurredAt", () => {
  const root = makeTempDir("diary-wake-boundaries");
  const store = createDiaryStore(path.join(root, "diary.sqlite"));

  const first = store.recordWakeBoundary({
    occurredAt: "2026-05-25T07:00:00.000",
    occurredAtUtc: "2026-05-24T23:00:00.000Z",
    now: "2026-05-25T07:00:00.000",
    nowUtc: "2026-05-24T23:00:00.000Z"
  });
  const duplicate = store.recordWakeBoundary({
    occurredAt: "2026-05-25T07:00:00.000",
    occurredAtUtc: "2026-05-24T23:00:00.000Z",
    now: "2026-05-25T07:01:00.000",
    nowUtc: "2026-05-24T23:01:00.000Z"
  });
  store.recordWakeBoundary({
    occurredAt: "2026-05-26T08:00:00.000",
    occurredAtUtc: "2026-05-26T00:00:00.000Z",
    now: "2026-05-26T08:00:00.000",
    nowUtc: "2026-05-26T00:00:00.000Z"
  });

  assert.equal(duplicate.id, first.id);
});

test("diaryStore_wakeBoundaries_listsLatestByOccurredAt", () => {
  const root = makeTempDir("diary-wake-boundaries-latest");
  const store = createDiaryStore(path.join(root, "diary.sqlite"));

  const first = store.recordWakeBoundary({
    occurredAt: "2026-05-25T07:00:00.000",
    occurredAtUtc: "2026-05-24T23:00:00.000Z",
    now: "2026-05-25T07:00:00.000",
    nowUtc: "2026-05-24T23:00:00.000Z"
  });
  const second = store.recordWakeBoundary({
    occurredAt: "2026-05-26T08:00:00.000",
    occurredAtUtc: "2026-05-26T00:00:00.000Z",
    now: "2026-05-26T08:00:00.000",
    nowUtc: "2026-05-26T00:00:00.000Z"
  });

  assert.equal(store.latestWakeBoundary()?.id, second.id);
  assert.deepEqual(store.listWakeBoundaries().map((boundary) => boundary.id), [first.id, second.id]);
});

test("diaryTarget_draftWrite_doesNotReplaceCommittedDiary", () => {
  const root = makeTempDir("memory-diary-draft");
  const memoryStore = createMarkdownMemoryStore(root);
  memoryStore.writeTarget("yesterdaySummary", "old diary\n", {
    now: "2026-05-23T06:00:00.000Z",
    localDate: "2026-05-23",
    windowEndAt: "2026-05-23T06:00:00.000Z"
  });

  const draftPath = memoryStore.createDiaryDraft();
  const draft = memoryStore.writeTarget("yesterdaySummary", "new diary\n", {
    diaryDraftPath: draftPath,
    now: "2026-05-24T06:00:00.000Z",
    localDate: "2026-05-24",
    windowEndAt: "2026-05-24T06:00:00.000Z"
  });

  assert.equal(draft, "new diary\n");
  assert.equal(fs.readFileSync(draftPath, "utf8"), "new diary\n");
  assert.equal(memoryStore.read().yesterdaySummary, "old diary\n");
});

test("diaryTarget_draftCommit_replacesCommittedDiary", () => {
  const root = makeTempDir("memory-diary-commit");
  const memoryStore = createMarkdownMemoryStore(root);
  memoryStore.writeTarget("yesterdaySummary", "old diary\n", {
    now: "2026-05-23T06:00:00.000Z",
    localDate: "2026-05-23",
    windowEndAt: "2026-05-23T06:00:00.000Z"
  });
  const draftPath = memoryStore.createDiaryDraft();
  memoryStore.writeTarget("yesterdaySummary", "new diary\n", {
    diaryDraftPath: draftPath,
    now: "2026-05-24T06:00:00.000Z",
    localDate: "2026-05-24",
    windowEndAt: "2026-05-24T06:00:00.000Z"
  });

  memoryStore.commitDiaryDraft(draftPath, {
    now: "2026-05-24T06:00:00.000Z",
    localDate: "2026-05-24",
    windowEndAt: "2026-05-24T06:00:00.000Z"
  });

  assert.equal(memoryStore.read().yesterdaySummary, "new diary\n");
  assert.equal(fs.existsSync(draftPath), false);
});

test("splitMessagesByLongGaps_gapOverFiveHours_splitsSegments", () => {
  const messages = [
    message("2026-05-24T00:00:00.000Z", "one"),
    message("2026-05-24T01:00:00.000Z", "two"),
    message("2026-05-24T07:01:00.000Z", "three")
  ];
  const segments = splitMessagesByLongGaps(messages);
  assert.deepEqual(segments.map((segment) => segment.map((entry) => entry.contentText)), [["one", "two"], ["three"]]);
});
