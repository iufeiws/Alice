import { test } from "node:test";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createMarkdownMemoryStore,
  runMemoryInductionForMessages
} from "../../../src/contexts/memory/src/memory.js";
import { createTestMemoryPromptStore, makeMemorySandbox, makeTempDir, memoryConfig, message } from "./sleep-memory-helpers.js";

test("memorizeLoop_failedCompletion_doesNotCommitWorkspace", async () => {
  const root = makeTempDir("memory-long-term-stage");
  const memoryStore = createMarkdownMemoryStore(root);
  const sandbox = makeMemorySandbox(root);
  memoryStore.writeTarget("persistent", "old persistent\n");
  let calls = 0;

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createTestMemoryPromptStore(root),
    promptContextRuntime: testPromptRuntime(),
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
              id: `read_${calls}`,
              type: "function",
              function: {
                name: "Read",
                arguments: JSON.stringify({ path: "/alice/memory_organization/persistent-memory.md" })
              }
            }]
          }
        };
      }
    },
    sandbox,
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    log() {}
  }, "persistent");

  assert.equal(result.ok, false);
  assert.equal(memoryStore.read().persistent, "old persistent\n");
});

test("memorizeSender_streamEnabled_passesStreamFlag", async () => {
  const root = makeTempDir("memory-stream-sender");
  const memoryStore = createMarkdownMemoryStore(root);
  const sandbox = makeMemorySandbox(root);
  const streamFlags: unknown[] = [];

  await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createTestMemoryPromptStore(root),
    promptContextRuntime: testPromptRuntime(),
    sandbox,
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

  assert.deepEqual(streamFlags, [true]);
});

test("memorizeSender_followupRound_usesFollowupExtraParams", async () => {
  const root = makeTempDir("memory-followup-extra");
  const memoryStore = createMarkdownMemoryStore(root);
  const sandbox = makeMemorySandbox(root);
  const seen: unknown[] = [];

  await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createTestMemoryPromptStore(root),
    promptContextRuntime: testPromptRuntime(),
    sandbox,
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
              function: { name: "Read", arguments: JSON.stringify({ path: "/alice/memory_organization/persistent-memory.md" }) }
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

  assert.deepEqual(seen, [{ first: true }, { followup: true }]);
});

test("memorizeLocalSender_streamEnabled_usesChatStream", async () => {
  const root = makeTempDir("memory-local-stream");
  const memoryStore = createMarkdownMemoryStore(root);
  const sandbox = makeMemorySandbox(root);
  let chatCalls = 0;
  let streamCalls = 0;

  await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createTestMemoryPromptStore(root),
    promptContextRuntime: testPromptRuntime(),
    sandbox,
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

  assert.equal(chatCalls, 0);
  assert.equal(streamCalls, 1);
});

test("memorizeLoop_firstWorkspaceFailureDoesNotRetry", async () => {
  const root = makeTempDir("memory-no-retry-workspace");
  const memoryStore = createMarkdownMemoryStore(root);
  const sandbox = makeMemorySandbox(root);
  let attempts = 0;

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
        throw new Error("request sender should be used");
      }
    },
    llmRequestSender: async (input) => {
      assert.equal(input.metadata?.target, "persistent");
      attempts += 1;
      throw new Error("temporary workspace failure");
    },
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    log() {}
  });

  assert.equal(result.ok, false);
  assert.equal(attempts, 1);
  assert.deepEqual(result.results.map((entry) => entry.error), [
    "temporary workspace failure",
    "temporary workspace failure",
    "temporary workspace failure"
  ]);
});

test("memorizeLoop_oversizedWorkspaceFile_returnsErrorToModelBeforeCommit", async () => {
  const root = makeTempDir("memory-limit-error");
  const memoryStore = createMarkdownMemoryStore(root);
  const sandbox = makeMemorySandbox(root);
  const hostPersistentPath = path.join(sandbox.hostRoot, "memory_organization", "persistent-memory.md");
  const sandboxPersistentPath = "/alice/memory_organization/persistent-memory.md";
  let calls = 0;

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
        throw new Error("request sender should handle memorize calls");
      }
    },
    llmRequestSender: async (input) => {
      calls += 1;
      if (calls === 1) {
        fs.writeFileSync(hostPersistentPath, `${Array.from({ length: 101 }, (_, index) => `${index} ${"好".repeat(100)}`).join("\n")}\n`);
        return { message: { role: "assistant", content: "done" } };
      }

      const errorMessage = input.messages.find((entry) => entry.role === "user" && entry.name === "Cheshire Cat");
      assert.ok(errorMessage);
      const errorContent = errorMessage.content;
      if (typeof errorContent !== "string") throw new Error("expected text error message");
      assert.equal(errorContent, [
        "<Error>",
        `${sandboxPersistentPath}: lines=101 > 100, bytes=30695 > 10240`,
        "</Error>"
      ].join("\n"));
      fs.writeFileSync(hostPersistentPath, "fixed\n");
      return { message: { role: "assistant", content: "done" } };
    },
    config: memoryConfig(),
    nowIso: () => "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    log() {}
  }, "persistent");

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(memoryStore.read().persistent, "fixed\n");
});
