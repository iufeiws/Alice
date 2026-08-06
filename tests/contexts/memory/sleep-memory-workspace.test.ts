import { test } from "node:test";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";
import assert from "node:assert/strict";
import {
  createMarkdownMemoryStore,
  runMemoryInductionForMessages
} from "../../../src/contexts/memory/src/memory.js";
import type { LLMChatInput } from "../../../src/contexts/llm-gateway/src/index.js";
import { createTestMemoryPromptStore, makeMemorySandbox, makeTempDir, memoryConfig, message } from "./sleep-memory-helpers.js";

test("memoryReadTool_validContent_recordsPiAdapterToolCall", async () => {
  const root = makeTempDir("memory-pi-read");
  const memoryStore = createMarkdownMemoryStore(root);
  const sandbox = makeMemorySandbox(root);
  const seen: LLMChatInput[] = [];
  let round = 0;

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createTestMemoryPromptStore(root),
    promptContextRuntime: testPromptRuntime(),
    sandbox,
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
                id: "read_1",
                type: "function",
                function: {
                  name: "Read",
                  arguments: JSON.stringify({ path: "/home/alice/memory_organization/persistent-memory.md" })
                }
              }]
            }
          };
        }
        return { message: { role: "assistant", content: "done" } };
      }
    },
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    log() {}
  });

  assert.equal(result.ok, true);
  assert.equal(seen.length, 2);
  assert.equal(typeof result.results[0]?.toolCalls.find((entry) => entry.name === "Read")?.output, "string");
  assert.deepEqual(result.results[0]?.toolCalls.find((entry) => entry.name === "Read")?.input, { path: "/home/alice/memory_organization/persistent-memory.md" });
});

test("memoryReadTool_emptyDiary_usesPlaceholderWithoutPersistingIt", async () => {
  const root = makeTempDir("memory-pi-empty-diary");
  const memoryStore = createMarkdownMemoryStore(root);
  const sandbox = makeMemorySandbox(root);
  let round = 0;

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createTestMemoryPromptStore(root),
    promptContextRuntime: testPromptRuntime(),
    sandbox,
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowStartAt: "2026-05-24T00:00:00.000Z",
    windowEndAt: "2026-05-24T06:00:00.000Z",
    llm: {
      async chat() {
        round += 1;
        if (round === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{
                id: "read_diary_1",
                type: "function",
                function: {
                  name: "Read",
                  arguments: JSON.stringify({ path: "/home/alice/memory_organization/diary.md" })
                }
              }]
            }
          };
        }
        return { message: { role: "assistant", content: "done" } };
      }
    },
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    log() {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.results[2]?.edited, false);
  assert.equal(memoryStore.read().yesterdaySummary, "");
  assert.equal(result.results[2]?.toolCalls.find((entry) => entry.name === "Read")?.output, "# ___ 日记\n");
});
