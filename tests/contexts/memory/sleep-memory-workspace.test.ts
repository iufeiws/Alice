import { test } from "node:test";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";
import assert from "node:assert/strict";
import path from "node:path";
import {
  createMarkdownMemoryStore,
  createMemoryInductionPromptStore,
  runMemoryInductionForMessages
} from "../../../src/contexts/memory/src/memory.js";
import type { LLMChatInput } from "../../../src/contexts/llm-gateway/src/index.js";
import { makeTempDir, memoryConfig, message } from "./sleep-memory-helpers.js";

test("memorySelfTalk_validContent_returnsToolResult", async () => {
  const root = makeTempDir("memory-self-talk");
  const memoryStore = createMarkdownMemoryStore(root);
  const seen: LLMChatInput[] = [];
  let round = 0;

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
    promptContextRuntime: testPromptRuntime(),
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

  assert.equal(result.ok, false);
  assert.equal(seen.length, 0);
});
