import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMarkdownMemoryStore,
  createMemoryDiaryStore,
  createMemoryInductionPromptStore,
  createSleepMemoryStateStore,
  enforceMemoryLimits,
  runMemoryInductionForMessages,
  runSleepMemoryInduction,
  splitMessagesByLongGaps
} from "../core/agent/src/memory.js";
import type { LLMChatInput, LLMClient } from "../core/llm/src/index.js";
import { createDiaryStore } from "../packages/storage/src/diary-store.js";
import * as sqlite from "../packages/storage/src/sqlite-compat.js";
import type { StoredConversationMessage } from "../packages/storage/src/sqlite-store.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("memory store bootstraps files and enforces line and byte limits", () => {
  const root = makeTempDir("memory-store");
  const store = createMarkdownMemoryStore(root);
  store.ensure();

  assert.equal(fs.existsSync(path.join(root, "long-term-memory", "long-term-memory.sqlite")), true);
  assert.equal(fs.existsSync(path.join(root, "tmp", "memory-workspaces")), true);

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

test("memory SQL store uses separate tables for memory, user memory, and diary", () => {
  const root = makeTempDir("memory-separate-sql-tables");
  const store = createMarkdownMemoryStore(root);
  store.writeTarget("persistent", "memory\n");
  store.writeTarget("userPreferences", "pref\n");
  store.writeTarget("yesterdaySummary", "diary\n", { localDate: "2026-06-04", now: "2026-06-04T08:00:00.000Z" });
  const db = new sqlite.DatabaseSync(path.join(root, "long-term-memory", "long-term-memory.sqlite"), { readOnly: true });

  assert.equal(db.prepare("SELECT content FROM persistent_memory_entries ORDER BY id DESC LIMIT 1").get().content, "memory\n");
  assert.equal(db.prepare("SELECT content FROM user_preferences_entries ORDER BY id DESC LIMIT 1").get().content, "pref\n");
  assert.equal(db.prepare("SELECT content FROM diary_entries ORDER BY id DESC LIMIT 1").get().content, "diary\n");
  assert.deepEqual(store.stats().map((entry) => entry.tableName), ["persistent_memory_entries", "user_preferences_entries", "diary_entries"]);
});

test("memory SQL store keeps sleep boundaries in separate tables", () => {
  const root = makeTempDir("memory-sleep-boundary-tables");
  const store = createMarkdownMemoryStore(root);
  store.ensure();
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
  const db = new sqlite.DatabaseSync(path.join(root, "long-term-memory", "long-term-memory.sqlite"), { readOnly: true });

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM diary_entries").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sleep_boundaries").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sleep_preparation_boundaries").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM wake_boundaries").get().count, 1);
});

test("memory SQL store does not import current diary sqlite entries", () => {
  const root = makeTempDir("memory-ignore-current-diary-sqlite");
  const legacyStore = createDiaryStore(path.join(root, "diary", "diary.sqlite"));
  legacyStore.upsertEntry({
    localDate: "2026-06-04",
    content: "legacy diary\n",
    now: "2026-06-04T01:00:00.000",
    windowStartAt: "2026-06-03T20:00:00.000",
    windowEndAt: "2026-06-04T01:00:00.000"
  });
  legacyStore.recordSleepBoundary({
    occurredAt: "2026-06-04T01:00:00.000",
    occurredAtUtc: "2026-06-03T17:00:00.000Z",
    source: "sleep",
    now: "2026-06-04T01:00:00.000",
    nowUtc: "2026-06-03T17:00:00.000Z"
  });
  legacyStore.recordSleepPreparationBoundary({
    occurredAt: "2026-06-04T00:30:00.000",
    occurredAtUtc: "2026-06-03T16:30:00.000Z",
    now: "2026-06-04T01:00:00.000",
    nowUtc: "2026-06-03T17:00:00.000Z"
  });

  createMarkdownMemoryStore(root).ensure();
  const migratedStore = createMemoryDiaryStore(root);
  const db = new sqlite.DatabaseSync(path.join(root, "long-term-memory", "long-term-memory.sqlite"), { readOnly: true });

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM diary_entries").get().count, 0);
  assert.deepEqual(migratedStore.listSleepBoundaries().map((entry) => entry.occurredAt), []);
  assert.deepEqual(migratedStore.listSleepPreparationBoundaries().map((entry) => entry.occurredAt), []);
});

test("diary store keeps sleep preparation boundaries as a stack", () => {
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

  const deleted = store.deleteLatestSleepPreparationBoundary();

  assert.equal(deleted?.id, second.id);
  assert.equal(store.latestSleepPreparationBoundary()?.id, first.id);
  assert.deepEqual(store.listSleepPreparationBoundaries().map((boundary) => boundary.id), [first.id]);
});

test("diary store records wake boundaries in a separate table", () => {
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
  const second = store.recordWakeBoundary({
    occurredAt: "2026-05-26T08:00:00.000",
    occurredAtUtc: "2026-05-26T00:00:00.000Z",
    now: "2026-05-26T08:00:00.000",
    nowUtc: "2026-05-26T00:00:00.000Z"
  });

  assert.equal(duplicate.id, first.id);
  assert.equal(store.latestWakeBoundary()?.id, second.id);
  assert.deepEqual(store.listWakeBoundaries().map((boundary) => boundary.id), [first.id, second.id]);
});

test("workspace Edit updates SQL-backed long-term memory", async () => {
  const root = makeTempDir("memory-patch-normalize");
  const memoryStore = createMarkdownMemoryStore(root);
  memoryStore.writeTarget("persistent", "old persistent\n");

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: editToolClient([], [replacePatch("old persistent\n", "new persistent\n")]),
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    userName: "Y",
    log() {}
  }, "persistent");

  assert.equal(result.ok, true);
  assert.equal(result.ok, true);
  assert.equal(memoryStore.read().persistent, "new persistent\n");
});

test("workspace Edit exact miss leaves SQL unchanged", async () => {
  const root = makeTempDir("memory-patch-error-detail");
  const memoryStore = createMarkdownMemoryStore(root);
  memoryStore.writeTarget("persistent", "old\n");

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: editSequenceClient([], [{ file: "persistent-memory.md", oldString: "missing\n", newString: "new\n" }]),
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    userName: "Y",
    log() {}
  }, "persistent");

  assert.equal(result.ok, true);
  assert.equal(memoryStore.read().persistent, "old\n");
});

test("workspace Edit handles markdown bullet lines", async () => {
  const root = makeTempDir("memory-patch-markdown-bullet");
  const memoryStore = createMarkdownMemoryStore(root);
  memoryStore.writeTarget("persistent", "## 知识\n- old bullet\n- keep bullet\n");

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: editToolClient([], [[
      "*** Begin Patch",
      "@@ ## 知识",
      "-- old bullet",
      "+- new bullet",
      " - keep bullet",
      "*** End Patch"
    ].join("\n")]),
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    userName: "Y",
    log() {}
  }, "persistent");

  assert.equal(result.ok, true);
  assert.equal(memoryStore.read().persistent, "## 知识\n- new bullet\n- keep bullet\n");
});

test("workspace Edit replaces multiple regions with exact strings", async () => {
  const root = makeTempDir("memory-patch-offset-search");
  const memoryStore = createMarkdownMemoryStore(root);
  memoryStore.writeTarget("persistent", [
    "alpha",
    "beta",
    "gamma",
    "delta",
    "epsilon",
    "zeta"
  ].join("\n") + "\n");

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: editSequenceClient([], [
      { file: "persistent-memory.md", oldString: "beta\n", newString: "beta\ninserted one\ninserted two\n" },
      { file: "persistent-memory.md", oldString: "zeta\n", newString: "omega\n" }
    ]),
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    userName: "Y",
    log() {}
  }, "persistent");

  assert.equal(result.ok, true);
  assert.equal(memoryStore.read().persistent, [
    "alpha",
    "beta",
    "inserted one",
    "inserted two",
    "gamma",
    "delta",
    "epsilon",
    "omega"
  ].join("\n") + "\n");
});

test("workspace Edit reports ambiguous exact matches without guessing", async () => {
  const root = makeTempDir("memory-patch-ambiguous-context");
  const memoryStore = createMarkdownMemoryStore(root);
  memoryStore.writeTarget("persistent", [
    "item",
    "keep",
    "item",
    "keep"
  ].join("\n") + "\n");

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: editSequenceClient([], [{ file: "persistent-memory.md", oldString: "item", newString: "changed" }]),
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    userName: "Y",
    log() {}
  }, "persistent");

  assert.equal(result.results[0].ok, true);
  assert.match(result.results[0].toolCalls.find((call) => !call.ok)?.error ?? "", /appears 2 times/i);
  assert.equal(memoryStore.read().persistent, "item\nkeep\nitem\nkeep\n");
});

test("workspace induction uses relative Read/Edit tools and commits all files at completion", async () => {
  const root = makeTempDir("memory-three-step");
  const memoryStore = createMarkdownMemoryStore(root);
  memoryStore.writeTarget("persistent", "old persistent\n");
  memoryStore.writeTarget("userPreferences", "old pref\n");
  memoryStore.writeTarget("yesterdaySummary", "old yesterday should not be read\n", {
    now: "2026-05-23T06:00:00.000Z",
    localDate: "2026-05-23",
    windowEndAt: "2026-05-23T06:00:00.000Z"
  });
  const seen: LLMChatInput[] = [];

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: editToolClient(seen, [
      replacePatch("old persistent\n", "new persistent\n"),
      replacePatch("old pref\n", "new pref\n"),
      addPatch("new yesterday\n")
    ]),
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    userName: "Y",
    log() {}
  });

  assert.equal(result.ok, true);
  assert.equal(seen.length, 7);
  const targetRequests = [seen[0]];
  for (const input of targetRequests) {
    assert.doesNotMatch(input.messages.map((entry) => entry.content).join("\n"), /当前任务：/);
    assert.deepEqual(input.tools?.map((tool) => tool.function.name), ["Read", "Edit", "Glob", "Grep", "self_talk"]);
    assert.deepEqual(Object.keys((input.tools?.[0].function.parameters?.properties as Record<string, unknown>) ?? {}), ["file_path", "offset", "limit"]);
    assert.deepEqual(Object.keys((input.tools?.[1].function.parameters?.properties as Record<string, unknown>) ?? {}), ["file_path", "old_string", "new_string", "replace_all"]);
    const promptText = input.messages.map((entry) => entry.content).join("\n");
    assert.match(promptText, /记忆 file_path=persistent-memory\.md/);
    assert.match(promptText, /用户记忆 file_path=user-preferences\.md/);
    assert.match(promptText, /日记 file_path=diary\.md/);
    const fakeReadIndex = input.messages.findIndex((entry) => entry.toolCalls?.[0]?.function.name === "Read");
    assert.notEqual(fakeReadIndex, -1);
    assert.equal(input.messages[fakeReadIndex].toolCalls?.[0].function.arguments, "{\"file_path\":\"persistent-memory.md\"}");
    assert.equal(input.messages[fakeReadIndex + 1].role, "tool");
    assert.equal(input.messages[fakeReadIndex + 1].name, "Read");
    assert.match(promptText, /聊天记录：\n\[2026-05-24 09:00:00\]\nY:hello/);
    assert.doesNotMatch(promptText, /[A-Z]:\\/);
  }
  const readResult = (input: LLMChatInput) => {
    const fakeReadIndexes = input.messages
      .map((entry, index) => entry.toolCalls?.[0]?.function.name === "Read" ? index : -1)
      .filter((index) => index >= 0);
    return input.messages[fakeReadIndexes.at(-1)! + 1].content;
  };
  assert.match(readResult(targetRequests[0]), /old persistent/);
  const userPreferencesPrompt = targetRequests[0].messages.map((entry) => entry.content ?? "").join("\n");
  const diaryPrompt = userPreferencesPrompt;
  assert.match(userPreferencesPrompt, /用户记忆：稳定偏好/);
  assert.match(diaryPrompt, /日记：只基于本次聊天记录/);
  assert.doesNotMatch(diaryPrompt, /old yesterday/);
  assert.equal(memoryStore.read().persistent, "new persistent\n");
  assert.equal(memoryStore.read().userPreferences, "new pref\n");
  assert.equal(memoryStore.read().yesterdaySummary, "new yesterday\n");
});

test("long-term memory edits commit only after memorize loop completes", async () => {
  const root = makeTempDir("memory-long-term-stage");
  const memoryStore = createMarkdownMemoryStore(root);
  memoryStore.writeTarget("persistent", "old persistent\n");
  let calls = 0;

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: {
      async chat() {
        calls += 1;
        if (calls === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{
                id: "read_1",
                type: "function",
                function: {
                  name: "Read",
                  arguments: JSON.stringify({ file_path: "persistent-memory.md" })
                }
              }]
            }
          };
        }
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: `edit_${calls}`,
              type: "function",
              function: {
                name: "Edit",
                arguments: JSON.stringify({ file_path: "persistent-memory.md", old_string: calls === 2 ? "old persistent\n" : "new persistent\n", new_string: "new persistent\n" })
              }
            }]
          }
        };
      }
    },
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    log() {}
  }, "persistent");

  assert.equal(result.ok, false);
  assert.equal(memoryStore.read().persistent, "old persistent\n");
});

test("memorize passes stream setting to injected request sender", async () => {
  const root = makeTempDir("memory-stream-sender");
  const memoryStore = createMarkdownMemoryStore(root);
  const streamFlags: unknown[] = [];

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: {
      async chat() {
        throw new Error("request sender should handle memorize calls");
      }
    },
    llmRequestSender: async (input) => {
      streamFlags.push(input.stream);
      return { message: { role: "assistant", content: "done" } };
    },
    config: { ...memoryConfig(), stream: true },
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    log() {}
  }, "persistent");

  assert.equal(result.ok, true);
  assert.deepEqual(streamFlags, [true]);
});

test("memorize uses follow-up extra params after first tool round", async () => {
  const root = makeTempDir("memory-followup-extra");
  const memoryStore = createMarkdownMemoryStore(root);
  const seen: unknown[] = [];

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: {
      async chat() {
        throw new Error("request sender should handle memorize calls");
      }
    },
    llmRequestSender: async (input) => {
      seen.push(input.extraParams);
      if (seen.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "read_1",
              type: "function",
              function: { name: "Read", arguments: JSON.stringify({ file_path: "persistent-memory.md" }) }
            }]
          }
        };
      }
      return { message: { role: "assistant", content: "done" } };
    },
    config: {
      ...memoryConfig(),
      extraParams: { first: true },
      followupExtraParams: { followup: true }
    },
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    log() {}
  }, "persistent");

  assert.equal(result.ok, true);
  assert.deepEqual(seen, [{ first: true }, { followup: true }]);
});

test("memorize local request sender uses chatStream when enabled", async () => {
  const root = makeTempDir("memory-local-stream");
  const memoryStore = createMarkdownMemoryStore(root);
  let chatCalls = 0;
  let streamCalls = 0;

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: {
      async chat() {
        chatCalls += 1;
        throw new Error("chat should not be used while memorize streaming is enabled");
      },
      async chatStream() {
        streamCalls += 1;
        return { message: { role: "assistant", content: "done" } };
      }
    },
    config: { ...memoryConfig(), stream: true },
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    log() {}
  }, "persistent");

  assert.equal(result.ok, true);
  assert.equal(chatCalls, 0);
  assert.equal(streamCalls, 1);
});

test("memorize retries a failed workspace run before committing", async () => {
  const root = makeTempDir("memory-retry-serial");
  const memoryStore = createMarkdownMemoryStore(root);
  const attempts: string[] = [];
  const finished = new Set<string>();

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: {
      async chat() {
        throw new Error("request sender should be used");
      }
    },
    llmRequestSender: async (input) => {
      const target = String(input.metadata?.target ?? "");
      attempts.push(target);
      if (attempts.length === 1) {
        throw new Error("temporary workspace failure");
      }
      if (finished.has(target)) return { message: { role: "assistant", content: "done" } };
      finished.add(target);
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: `read_${target}`,
            type: "function",
            function: { name: "Read", arguments: JSON.stringify({ file_path: "persistent-memory.md" }) }
          }]
        }
      };
    },
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    log() {}
  });

  assert.equal(result.ok, true);
  assert.deepEqual(attempts, ["workspace", "workspace", "workspace"]);
  assert.equal(result.ok, true);
});

test("memorize LLM session persists as metadata followed by transcript messages", async () => {
  const root = makeTempDir("memory-session-transcript");
  const memoryStore = createMarkdownMemoryStore(root);

  await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: editToolClient([], [
      addPatch("new persistent\n"),
      addPatch("new pref\n"),
      addPatch("new yesterday\n")
    ]),
    config: memoryConfig(),
    nowIso: () => "2026-05-24T14:00:00.000",
    timezone: "Asia/Shanghai",
    sessionRoot: path.join(root, "llm-sessions"),
    log() {}
  });

  const filePath = findSessionFiles(path.join(root, "llm-sessions", "memorize"))[0];
  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(path.relative(path.join(root, "llm-sessions"), filePath), path.join("memorize", "2026-05-24", "06-00-00-000.jsonl"));
  assert.equal(lines[0].type, "llm_session");
  assert.equal(lines[0].agent, "memorize");
  assert.equal(lines[0].sessionId, Date.parse("2026-05-24T06:00:00.000Z"));
  assert.equal(lines[0].sessionCreatedAtUtc, "2026-05-24T06:00:00.000Z");
  assert.equal(lines[0].startedAt, "2026-05-24T14:00:00.000");
  assert.deepEqual(lines[0].targets, ["persistent", "userPreferences", "yesterdaySummary"]);
  assert.equal(lines[0].clearedAt, "2026-05-24T14:00:00.000");
  assert.equal(lines[0].clearReason, "complete");
  assert.equal(lines[0].windowStartAt, "2026-05-24T00:00:00.000Z");
  assert.equal(lines[0].windowEndAt, "2026-05-24T06:00:00.000Z");
  assert.equal(lines[1].role, "system");
  assert.equal(lines.some((entry) => entry.type === "request" || entry.type === "response"), false);
});

test("memory induction uses only common prompt layers", async () => {
  const root = makeTempDir("memory-target-append");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(path.join(root, "prompts.json"));
  promptStore.save({
    commonLayers: [
      { id: "common_system", title: "system", role: "system", enabled: true, order: 10, content: "common system {{memory/persistent/limit/lines}}/{{memory/persistent/limit/bytes}} {{memory/userPreferences/limit/lines}}/{{memory/userPreferences/limit/bytes}} {{memory/yesterdaySummary/limit/lines}}/{{memory/yesterdaySummary/limit/bytes}}" },
      { id: "common_record", title: "record", role: "user", enabled: true, order: 40, content: "record {{memorize/messages/content}}" }
    ],
    persistentLayers: [
      { id: "persistent_append", title: "append", role: "user", enabled: true, order: 1, content: "persistent append" }
    ],
    userPreferencesLayers: [],
    yesterdaySummaryLayers: []
  });
  const seen: LLMChatInput[] = [];

  await runMemoryInductionForMessages({
    memoryStore,
    promptStore,
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: editToolClient(seen, [
      addPatch("new persistent\n"),
      addPatch("new pref\n"),
      addPatch("new yesterday\n")
    ]),
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    userName: "Y",
    log() {}
  });

  const contents = seen[0].messages.map((entry) => entry.content ?? "");
  assert.deepEqual(contents.slice(0, 2), [
    "common system 100/10240 80/8192 20/2048",
    "record [2026-05-24 09:00:00]\nY:hello"
  ]);
  assert.doesNotMatch(contents.join("\n"), /persistent append/);
});

test("memory self_talk echoes content in tool result", async () => {
  const root = makeTempDir("memory-self-talk");
  const memoryStore = createMarkdownMemoryStore(root);
  const seen: LLMChatInput[] = [];
  let round = 0;

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: {
      async chat(input) {
        seen.push(input);
        round += 1;
        if (round === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{
                id: "talk_1",
                type: "function",
                function: {
                  name: "self_talk",
                  arguments: JSON.stringify({ content: "原样\n输出" })
                }
              }]
            }
          };
        }
        if (round > 2) return { message: { role: "assistant", content: "done" } };
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "read_1",
              type: "function",
              function: {
                name: "Read",
                arguments: JSON.stringify({ file_path: "persistent-memory.md" })
              }
            }]
          }
        };
      }
    },
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    log() {}
  });

  assert.equal(result.ok, true);
  const selfTalkResult = seen[1].messages.find((entry) => entry.role === "tool" && entry.name === "self_talk");
  assert.equal(selfTalkResult?.content, "爱丽丝听到自己说:\n原样\n输出");
});

test("diary target writes tmp markdown before sqlite commit", () => {
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

  memoryStore.commitDiaryDraft(draftPath, {
    now: "2026-05-24T06:00:00.000Z",
    localDate: "2026-05-24",
    windowEndAt: "2026-05-24T06:00:00.000Z"
  });

  assert.equal(memoryStore.read().yesterdaySummary, "new diary\n");
  assert.equal(fs.existsSync(draftPath), false);
});

test("sleep induction records current timestamp first and advances after success", async () => {
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

test("sleep induction uses an open start when only the latest sleep boundary exists", async () => {
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

test("sleep induction treats no-edit completion as success and advances cursor", async () => {
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

test("splitMessagesByLongGaps splits gaps over five hours", () => {
  const messages = [
    message("2026-05-24T00:00:00.000Z", "one"),
    message("2026-05-24T01:00:00.000Z", "two"),
    message("2026-05-24T07:01:00.000Z", "three")
  ];
  const segments = splitMessagesByLongGaps(messages);
  assert.deepEqual(segments.map((segment) => segment.map((entry) => entry.contentText)), [["one", "two"], ["three"]]);
});

function memoryConfig() {
  return {
    enabled: true,
    baseURL: "https://api.deepseek.com",
    apiKey: "test",
    model: "deepseek-v4-pro",
    temperature: 0.8,
    timeoutMs: 120_000,
    stream: false,
    extraParams: {},
    followupExtraParams: {}
  };
}

function editToolClient(seen: LLMChatInput[], patches: string[]): LLMClient {
  const files = patches.length >= 3
    ? ["persistent-memory.md", "user-preferences.md", "diary.md"]
    : ["persistent-memory.md"];
  const edits = patches.map((patch, index) => ({ file: files[index] ?? "persistent-memory.md", ...patchToEdit(patch) }));
  return editSequenceClient(seen, edits);
}

function editSequenceClient(seen: LLMChatInput[], edits: Array<{ file: string; oldString: string; newString: string }>): LLMClient {
  let index = 0;
  let phase: "read" | "edit" | "done" = edits.length > 0 ? "read" : "done";
  return {
    async chat(input) {
      seen.push(input);
      if (phase === "done") {
        return { message: { role: "assistant", content: "done" } };
      }
      const edit = edits[index];
      if (phase === "read") {
        phase = "edit";
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: `read_${index + 1}`,
              type: "function",
              function: {
                name: "Read",
                arguments: JSON.stringify({ file_path: edit.file })
              }
            }]
          }
        };
      }
      index += 1;
      phase = index >= edits.length ? "done" : "read";
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: `edit_${index}`,
            type: "function",
            function: {
              name: "Edit",
              arguments: JSON.stringify({ file_path: edit.file, old_string: edit.oldString, new_string: edit.newString })
            }
          }]
        }
      };
    }
  };
}

function patchToEdit(patch: string): { oldString: string; newString: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("---")) continue;
    if (line.startsWith("--")) {
      oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
    }
  }
  return {
    oldString: oldLines.length ? `${oldLines.join("\n")}\n` : "",
    newString: newLines.length ? `${newLines.join("\n")}\n` : ""
  };
}

function addPatch(content: string): string {
  const lines = content.trimEnd().split("\n");
  return [
    "*** Begin Patch",
    "@@",
    ...lines.map((line) => `+${line}`),
    "*** End Patch"
  ].join("\n");
}

function replacePatch(from: string, to: string): string {
  const oldLines = from.trimEnd().split("\n");
  const newLines = to.trimEnd().split("\n");
  return [
    "*** Begin Patch",
    "@@",
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "*** End Patch"
  ].join("\n");
}

function message(createdAt: string, contentText: string): StoredConversationMessage {
  return {
    id: Number(createdAt.replace(/\D/g, "").slice(-8)),
    plugin: "feishu",
    conversationId: "session",
    direction: "inbound",
    senderRole: "user",
    contentType: "text",
    contentText,
    createdAt,
    status: "sent",
    isRead: false,
    isRecalled: false,
    reactionsJson: "{}",
    lastEventAt: createdAt
  };
}

function makeTempDir(name: string): string {
  const dir = path.join(process.cwd(), ".tmp-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function findSessionFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of (fs.readdirSync as any)(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...findSessionFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
  }
  return files.sort();
}
