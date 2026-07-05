import { test } from "node:test";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";
import assert from "node:assert/strict";
import path from "node:path";
import {
  createMarkdownMemoryStore,
  createMemoryInductionPromptStore,
  createSleepMemoryStateStore,
  runSleepMemoryInduction
} from "../../../src/contexts/memory/src/memory.js";
import { createDiaryStore } from "../../../src/platform/storage/src/diary-store.js";
import {
  addPatch,
  editToolClient,
  makeTempDir,
  memoryConfig,
  message
} from "./sleep-memory-helpers.js";

test("sleepInduction_closedBoundaryWindow_recordsCurrentTimestampBeforeQuery", async () => {
  const root = makeTempDir("memory-induction");
  const memoryStore = createMarkdownMemoryStore(root);
  const stateStore = createSleepMemoryStateStore(path.join(root, "state.json"));
  const diaryStore = createDiaryStore(path.join(root, "diary.sqlite"));
  diaryStore.recordSleepBoundary({ occurredAt: "2026-05-24T00:00:00.000", source: "sleep", now: "2026-05-24T00:00:00.000" });
  diaryStore.recordSleepBoundary({ occurredAt: "2026-05-24T06:00:00.000", source: "sleep", now: "2026-05-24T06:00:00.000" });
  stateStore.write({ lastInductionAt: "2026-05-24T00:00:00.000Z" });
  const calls: Array<{ start?: string; end: string }> = [];

  const ok = await runSleepMemoryInduction({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    promptContextRuntime: testPromptRuntime(),
    stateStore,
    diaryStore,
    messageStore: {
      listMessagesByCreatedAtRange(startAt, endAt) {
        calls.push({ start: startAt, end: endAt });
        assert.equal(stateStore.read().currentInductionAt, "2026-05-24T06:00:00.000Z");
        return [message("2026-05-24T01:00:00.000Z", "hello")];
      },
      listMessagesChronological() {
        return [];
      }
    },
    llm: editToolClient([], [
      addPatch("- fact\n"),
      addPatch("- pref\n"),
      addPatch("- summary\n")
    ]),
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    log() {}
  });

  assert.equal(ok, true);
  assert.deepEqual(calls, [{ start: "2026-05-24T00:00:00.000", end: "2026-05-24T06:00:00.000" }]);
  assert.equal(stateStore.read().lastInductionAt, "2026-05-24T06:00:00.000");
  assert.match(memoryStore.read().persistent, /fact/);
});

test("sleepInduction_latestBoundaryOnly_usesOpenStart", async () => {
  const root = makeTempDir("memory-induction-sleep-window");
  const memoryStore = createMarkdownMemoryStore(root);
  const stateStore = createSleepMemoryStateStore(path.join(root, "state.json"));
  const diaryStore = createDiaryStore(path.join(root, "diary.sqlite"));
  diaryStore.recordSleepBoundary({ occurredAt: "2026-05-24T14:00:00.000", source: "sleep", now: "2026-05-24T14:00:00.000" });
  stateStore.write({ lastInductionAt: "2026-05-23T20:00:00.000Z" });
  const calls: Array<{ start?: string; end: string }> = [];

  const ok = await runSleepMemoryInduction({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    promptContextRuntime: testPromptRuntime(),
    stateStore,
    diaryStore,
    messageStore: {
      listMessagesByCreatedAtRange(startAt, endAt) {
        calls.push({ start: startAt, end: endAt });
        return [
          message("2026-05-24T12:30:00.000Z", "after sleep cocoon")
        ];
      },
      listMessagesChronological() {
        return [];
      }
    },
    llm: editToolClient([], [
      addPatch("- fact\n"),
      addPatch("- pref\n"),
      addPatch("- summary\n")
    ]),
    config: memoryConfig(),
    nowIso: () => "2026-05-24T14:00:00.000Z",
    timezone: "Asia/Shanghai",
    log() {}
  });

  assert.equal(ok, true);
  assert.deepEqual(calls, [{ start: undefined, end: "2026-05-24T14:00:00.000" }]);
  assert.equal(stateStore.read().lastInductionAt, "2026-05-24T14:00:00.000");
});

test("sleepInduction_noEditCompletion_advancesCursorWithoutChangingMemory", async () => {
  const root = makeTempDir("memory-failure");
  const memoryStore = createMarkdownMemoryStore(root);
  memoryStore.write({ persistent: "old\n", userPreferences: "", yesterdaySummary: "" });
  const stateStore = createSleepMemoryStateStore(path.join(root, "state.json"));
  const diaryStore = createDiaryStore(path.join(root, "diary.sqlite"));
  diaryStore.recordSleepBoundary({ occurredAt: "2026-05-24T00:00:00.000", source: "sleep", now: "2026-05-24T00:00:00.000" });
  diaryStore.recordSleepBoundary({ occurredAt: "2026-05-24T06:00:00.000", source: "sleep", now: "2026-05-24T06:00:00.000" });
  stateStore.write({ lastInductionAt: "2026-05-24T00:00:00.000Z" });

  const ok = await runSleepMemoryInduction({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    promptContextRuntime: testPromptRuntime(),
    stateStore,
    diaryStore,
    messageStore: {
      listMessagesByCreatedAtRange() {
        return [message("2026-05-24T01:00:00.000Z", "hello")];
      },
      listMessagesChronological() {
        return [];
      }
    },
    llm: {
      async chat() {
        return { message: { role: "assistant", content: "plain text without tool" } };
      }
    },
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    log() {}
  });

  assert.equal(ok, true);
  assert.equal(stateStore.read().lastInductionAt, "2026-05-24T06:00:00.000");
  assert.equal(memoryStore.read().persistent, "old\n");
});
