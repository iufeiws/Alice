import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createMarkdownMemoryStore,
  createMemoryInductionPromptStore,
  runMemoryInductionForMessages
} from "../../../src/contexts/memory/src/memory.js";
import {
  addPatch,
  editToolClient,
  findSessionFiles,
  makeTempDir,
  memoryConfig,
  message
} from "./sleep-memory-helpers.js";

test("memorizeLoop_failedCompletion_doesNotCommitStagedEdit", async () => {
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
                arguments: JSON.stringify({
                  file_path: "persistent-memory.md",
                  old_string: calls === 2 ? "old persistent\n" : "new persistent\n",
                  new_string: "new persistent\n"
                })
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

test("memorizeSender_streamEnabled_passesStreamFlag", async () => {
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

test("memorizeSender_followupRound_usesFollowupExtraParams", async () => {
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

test("memorizeLocalSender_streamEnabled_usesChatStream", async () => {
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

test("memorizeRetry_firstWorkspaceFailure_retriesBeforeCompletion", async () => {
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
  assert.equal(attempts.length, 3);
});

test("memorizeSession_completeRun_persistsMetadataAndTranscript", async () => {
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
  assert.deepEqual(lines[0].targets, ["persistent", "userPreferences", "yesterdaySummary"]);
  assert.equal(lines.some((entry) => entry.type === "request" || entry.type === "response"), false);
  assert.equal(lines.some((entry) => entry.role === "system"), true);
});
