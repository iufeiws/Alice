import { test } from "node:test";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createMarkdownMemoryStore,
  createSleepMemoryStateStore,
  runSleepMemoryInduction
} from "../../../src/contexts/memory/src/memory.js";
import { createDiaryStore } from "../../../src/platform/storage/src/diary-store.js";
import {
  makeMemorySandbox,
  makeTempDir,
  createTestMemoryPromptStore,
  memoryConfig,
  message
} from "./sleep-memory-helpers.js";

test("sleepInduction_closedBoundaryWindow_recordsCurrentTimestampBeforeQuery", async () => {
  const root = makeTempDir("memory-induction");
  const memoryStore = createMarkdownMemoryStore(root);
  const stateStore = createSleepMemoryStateStore(path.join(root, "state.json"));
  const sandbox = makeMemorySandbox(root);
  const seen: string[] = [];
  const diaryStore = createDiaryStore(path.join(root, "diary.sqlite"));
  diaryStore.recordSleepBoundary({ occurredAt: "2026-05-24T00:00:00.000", source: "sleep", now: "2026-05-24T00:00:00.000" });
  diaryStore.recordSleepBoundary({ occurredAt: "2026-05-24T06:00:00.000", source: "sleep", now: "2026-05-24T06:00:00.000" });
  stateStore.write({ lastInductionAt: "2026-05-24T00:00:00.000Z" });
  const calls: Array<{ start?: string; end: string }> = [];
  const promptStore = createTestMemoryPromptStore(root);
  promptStore.save({
    meta: {},
    messages: [{
      meta: { title: "Files", enabled: true },
      role: "user",
      content: "{{memorize/files/persistent/filePath}}"
    }]
  });

  const ok = await runSleepMemoryInduction({
    memoryStore,
    promptStore,
    promptContextRuntime: testPromptRuntime(),
    sandbox,
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
    llm: {
      async chat(input) {
        seen.push(input.messages.map((entry) => entry.content ?? "").join("\n"));
        return { message: { role: "assistant", content: "done" } };
      }
    },
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    log() {}
  });

  assert.equal(ok, true);
  assert.deepEqual(calls, [{ start: "2026-05-24T00:00:00.000", end: "2026-05-24T06:00:00.000" }]);
  assert.equal(stateStore.read().lastInductionAt, "2026-05-24T06:00:00.000");
  assert.match(seen[0] ?? "", /\/home\/alice\/memory_organization\/persistent-memory\.md/);
  assert.equal(memoryStore.read().persistent, "");
  assert.equal(memoryStore.read().userPreferences, "");
  assert.equal(memoryStore.read().yesterdaySummary, "");
  assert.equal(fs.existsSync(path.join(sandbox.hostRoot, "memory_organization")), false);
});

test("sleepInduction_latestBoundaryOnly_usesOpenStart", async () => {
  const root = makeTempDir("memory-induction-sleep-window");
  const memoryStore = createMarkdownMemoryStore(root);
  const stateStore = createSleepMemoryStateStore(path.join(root, "state.json"));
  const sandbox = makeMemorySandbox(root);
  const diaryStore = createDiaryStore(path.join(root, "diary.sqlite"));
  diaryStore.recordSleepBoundary({ occurredAt: "2026-05-24T14:00:00.000", source: "sleep", now: "2026-05-24T14:00:00.000" });
  stateStore.write({ lastInductionAt: "2026-05-23T20:00:00.000Z" });
  const calls: Array<{ start?: string; end: string }> = [];

  const ok = await runSleepMemoryInduction({
    memoryStore,
    promptStore: createTestMemoryPromptStore(root),
    promptContextRuntime: testPromptRuntime(),
    sandbox,
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
    llm: {
      async chat() {
        return { message: { role: "assistant", content: "done" } };
      }
    },
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
  const sandbox = makeMemorySandbox(root);
  const diaryStore = createDiaryStore(path.join(root, "diary.sqlite"));
  diaryStore.recordSleepBoundary({ occurredAt: "2026-05-24T00:00:00.000", source: "sleep", now: "2026-05-24T00:00:00.000" });
  diaryStore.recordSleepBoundary({ occurredAt: "2026-05-24T06:00:00.000", source: "sleep", now: "2026-05-24T06:00:00.000" });
  stateStore.write({ lastInductionAt: "2026-05-24T00:00:00.000Z" });

  const ok = await runSleepMemoryInduction({
    memoryStore,
    promptStore: createTestMemoryPromptStore(root),
    promptContextRuntime: testPromptRuntime(),
    sandbox,
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
