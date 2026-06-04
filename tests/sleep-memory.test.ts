import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMarkdownMemoryStore,
  createMemoryInductionPromptStore,
  createSleepMemoryStateStore,
  enforceMemoryLimits,
  runMemoryInductionForMessages,
  runSleepMemoryInduction,
  splitMessagesByLongGaps
} from "../core/agent/src/memory.js";
import type { LLMChatInput, LLMClient } from "../core/llm/src/index.js";
import { createDiaryStore } from "../packages/storage/src/diary-store.js";
import type { StoredConversationMessage } from "../packages/storage/src/sqlite-store.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("memory store bootstraps files and enforces line and byte limits", () => {
  const root = makeTempDir("memory-store");
  const store = createMarkdownMemoryStore(root);
  store.ensure();

  assert.equal(fs.existsSync(path.join(root, "long-term-memory", "persistent-memory.md")), true);
  assert.equal(fs.existsSync(path.join(root, "long-term-memory", "user-preferences.md")), true);
  assert.equal(fs.existsSync(path.join(root, "long-term-memory", ".git")), true);
  assert.equal(fs.existsSync(path.join(root, "diary", "diary.sqlite")), true);

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

test("apply_patch normalizes configured fullwidth characters in written memory", async () => {
  const root = makeTempDir("memory-patch-normalize");
  const memoryStore = createMarkdownMemoryStore(root);
  memoryStore.writeTarget("persistent", "ＡＢＣ，测试（one）。\n未触碰：＃＠＆＊＋＝＜＞＿｜\n");

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: editToolClient([], [
      [
        "*** Begin Patch",
        "@@",
        "-ABC,测试(one).",
        "+新增：ａｂｃ１２３／路径＼名字－OK～",
        "*** End Patch"
      ].join("\n")
    ]),
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    userName: "Y",
    log() {}
  }, "persistent");

  assert.equal(result.ok, true);
  assert.equal(memoryStore.read().persistent, "新增:abc123/路径\\名字-OK~\n未触碰:#@&*+=<>_|\n");
});

test("apply_patch reports the concrete mismatch when a patch fails", async () => {
  const root = makeTempDir("memory-patch-error-detail");
  const memoryStore = createMarkdownMemoryStore(root);
  memoryStore.writeTarget("persistent", "old\n");

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: editToolClient([], [replacePatch("missing\n", "new\n")]),
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    userName: "Y",
    log() {}
  }, "persistent");

  assert.match(result.results[0].toolCalls[0].error ?? "", /patch line 3/);
  assert.match(result.results[0].toolCalls[0].error ?? "", /original line 1/);
  assert.match(result.results[0].toolCalls[0].error ?? "", /expected "missing", actual "old"/);
  assert.equal(memoryStore.read().persistent, "old\n");
});

test("apply_patch handles markdown bullet lines with explicit patch markers", async () => {
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

test("apply_patch uses Codex apply_patch chunks and searches by context after earlier edits", async () => {
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

  const patch = [
    "*** Begin Patch",
    "@@ alpha",
    "-beta",
    "+beta",
    "+inserted one",
    "+inserted two",
    "@@ epsilon",
    "-zeta",
    "+omega",
    "*** End Patch"
  ].join("\n");

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: editToolClient([], [patch]),
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

test("apply_patch fails instead of guessing when reduced context is ambiguous", async () => {
  const root = makeTempDir("memory-patch-ambiguous-context");
  const memoryStore = createMarkdownMemoryStore(root);
  memoryStore.writeTarget("persistent", [
    "item",
    "keep",
    "item",
    "keep"
  ].join("\n") + "\n");

  const patch = [
    "*** Begin Patch",
    "@@",
    "-item",
    "+changed",
    "*** End Patch"
  ].join("\n");

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: editToolClient([], [patch]),
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    userName: "Y",
    log() {}
  }, "persistent");

  assert.equal(result.results[0].toolCalls[0].ok, false);
  assert.match(result.results[0].toolCalls[0].error ?? "", /ambiguous/i);
  assert.equal(memoryStore.read().persistent, "item\nkeep\nitem\nkeep\n");
});

test("three-step induction uses fake read and fixed no-file tools", async () => {
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
  assert.equal(seen.length, 6);
  const targetRequests = [seen[0], seen[2], seen[4]];
  for (const input of targetRequests) {
    assert.doesNotMatch(input.messages.map((entry) => entry.content).join("\n"), /当前任务：/);
    assert.deepEqual(input.tools?.map((tool) => tool.function.name), ["read_memory", "self_talk", "apply_patch"]);
    assert.deepEqual(input.tools?.[0].function.parameters, { type: "object", properties: {}, additionalProperties: false });
    assert.deepEqual(Object.keys((input.tools?.[1].function.parameters?.properties as Record<string, unknown>) ?? {}), ["content"]);
    assert.deepEqual(Object.keys((input.tools?.[2].function.parameters?.properties as Record<string, unknown>) ?? {}), ["patch"]);
    const fakeReadIndex = input.messages.findIndex((entry) => entry.toolCalls?.[0]?.function.name === "read_memory");
    assert.notEqual(fakeReadIndex, -1);
    assert.equal(input.messages[fakeReadIndex].toolCalls?.[0].function.arguments, "{}");
    assert.equal(input.messages[fakeReadIndex + 1].role, "tool");
    assert.equal(input.messages[fakeReadIndex + 1].name, "read_memory");
    assert.match(input.messages.map((entry) => entry.content).join("\n"), /聊天记录：\n\[2026-05-24 09:00:00\]\nY:hello/);
  }
  const readResult = (input: LLMChatInput) => {
    const fakeReadIndexes = input.messages
      .map((entry, index) => entry.toolCalls?.[0]?.function.name === "read_memory" ? index : -1)
      .filter((index) => index >= 0);
    return input.messages[fakeReadIndexes.at(-1)! + 1].content;
  };
  assert.match(readResult(targetRequests[0]), /<persistent-memory>\nold persistent\n<\/persistent-memory>\n1 line\(s\), 15 byte\(s\)/);
  const userPreferencesPrompt = String(targetRequests[1].messages.at(-1)?.content ?? "");
  const diaryPrompt = String(targetRequests[2].messages.at(-1)?.content ?? "");
  assert.match(userPreferencesPrompt, /维护用户偏好文件/);
  assert.match(diaryPrompt, /维护 agent 日记/);
  assert.doesNotMatch(userPreferencesPrompt, /聊天记录：/);
  assert.doesNotMatch(diaryPrompt, /聊天记录：/);
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
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: `edit_${calls}`,
              type: "function",
              function: {
                name: "apply_patch",
                arguments: JSON.stringify({ patch: replacePatch("old persistent\n", "new persistent\n") })
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
  assert.equal(result.results[0].edited, true);
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
              id: "edit_1",
              type: "function",
              function: { name: "apply_patch", arguments: JSON.stringify({ patch: addPatch("memory\n") }) }
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

test("memorize retries a failed target before moving to the next target", async () => {
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
      if (target === "persistent" && attempts.filter((entry) => entry === "persistent").length === 1) {
        throw new Error("temporary persistent failure");
      }
      if (finished.has(target)) return { message: { role: "assistant", content: "done" } };
      finished.add(target);
      const patch = target === "persistent"
        ? addPatch("new persistent\n")
        : target === "userPreferences"
          ? addPatch("new pref\n")
          : addPatch("new yesterday\n");
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: `edit_${target}`,
            type: "function",
            function: { name: "apply_patch", arguments: JSON.stringify({ patch }) }
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
  assert.deepEqual(attempts, ["persistent", "persistent", "persistent", "userPreferences", "userPreferences", "yesterdaySummary", "yesterdaySummary"]);
  assert.match(memoryStore.read().persistent, /new persistent/);
  assert.match(memoryStore.read().userPreferences, /new pref/);
  assert.match(memoryStore.read().yesterdaySummary, /new yesterday/);
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

test("memory target-specific prompts append after common prompts", async () => {
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
  assert.deepEqual(contents.slice(0, 3), [
    "common system 100/10240 80/8192 20/2048",
    "record [2026-05-24 09:00:00]\nY:hello",
    "persistent append"
  ]);
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
              id: "edit_1",
              type: "function",
              function: {
                name: "apply_patch",
                arguments: JSON.stringify({ patch: addPatch("done\n") })
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
  let index = 0;
  let finishNext = false;
  return {
    async chat(input) {
      seen.push(input);
      if (finishNext) {
        finishNext = false;
        return { message: { role: "assistant", content: "done" } };
      }
      const patch = patches[index++] ?? addPatch("fallback\n");
      finishNext = true;
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: `edit_${index}`,
            type: "function",
            function: {
              name: "apply_patch",
              arguments: JSON.stringify({ patch })
            }
          }]
        }
      };
    }
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
  const dir = path.join("/tmp", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
