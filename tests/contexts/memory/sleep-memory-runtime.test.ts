import { test } from "node:test";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";
import assert from "node:assert/strict";
import path from "node:path";
import {
  createMarkdownMemoryStore,
  createMemoryInductionPromptStore,
  runMemoryInductionForMessages
} from "../../../src/contexts/memory/src/memory.js";
import { makeMemorySandbox, makeTempDir, memoryConfig, message } from "./sleep-memory-helpers.js";

test("memorizeLoop_failedCompletion_doesNotCommitWorkspace", async () => {
  const root = makeTempDir("memory-long-term-stage");
  const memoryStore = createMarkdownMemoryStore(root);
  const sandbox = makeMemorySandbox(root);
  memoryStore.writeTarget("persistent", "old persistent\n");
  let calls = 0;

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
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
              id: `talk_${calls}`,
              type: "function",
              function: {
                name: "self_talk",
                arguments: JSON.stringify({ content: "still working" })
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
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
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
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
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
              function: { name: "self_talk", arguments: JSON.stringify({ content: "thinking" }) }
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
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
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

test("memorizeRetry_firstWorkspaceFailure_retriesSingleWorkspaceRun", async () => {
  const root = makeTempDir("memory-retry-workspace");
  const memoryStore = createMarkdownMemoryStore(root);
  const sandbox = makeMemorySandbox(root);
  const attempts: string[] = [];
  const finished = new Set<string>();

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
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
            function: { name: "self_talk", arguments: JSON.stringify({ content: target }) }
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
  assert.equal(attempts.length >= 2, true);
});
