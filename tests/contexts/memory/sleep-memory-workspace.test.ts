import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  createMarkdownMemoryStore,
  createMemoryInductionPromptStore,
  runMemoryInductionForMessages
} from "../../../src/contexts/memory/src/memory.js";
import type { LLMChatInput } from "../../../src/contexts/llm-gateway/src/index.js";
import {
  addPatch,
  editSequenceClient,
  editToolClient,
  makeTempDir,
  memoryConfig,
  message,
  replacePatch
} from "./sleep-memory-helpers.js";

test("workspaceEdit_validPatch_updatesLongTermMemory", async () => {
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
  assert.equal(memoryStore.read().persistent, "new persistent\n");
});

test("workspaceEdit_exactMiss_leavesMemoryUnchanged", async () => {
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

test("workspaceEdit_markdownBullet_updatesLine", async () => {
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

test("workspaceEdit_multipleRegions_appliesAllEdits", async () => {
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

test("workspaceEdit_ambiguousMatch_keepsMemoryUnchanged", async () => {
  const root = makeTempDir("memory-patch-ambiguous-context");
  const memoryStore = createMarkdownMemoryStore(root);
  memoryStore.writeTarget("persistent", "item\nkeep\nitem\nkeep\n");

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
  assert.equal(result.results[0].toolCalls.some((call) => !call.ok), true);
  assert.equal(memoryStore.read().persistent, "item\nkeep\nitem\nkeep\n");
});

test("workspaceInduction_allTargetsCommitAfterCompletion", async () => {
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
  assert.deepEqual((seen[0].tools ?? []).map((tool) => tool.function.name).sort(), ["Edit", "Glob", "Grep", "Read", "self_talk"]);
  assert.equal(memoryStore.read().persistent, "new persistent\n");
  assert.equal(memoryStore.read().userPreferences, "new pref\n");
  assert.equal(memoryStore.read().yesterdaySummary, "new yesterday\n");
});

test("memorySelfTalk_validContent_returnsToolResult", async () => {
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
  assert.match(String(selfTalkResult?.content), /原样\n输出/);
});
