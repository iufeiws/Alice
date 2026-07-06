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
import { makeMemorySandbox, makeTempDir, memoryConfig, message } from "./sleep-memory-helpers.js";

test("memorySelfTalk_validContent_returnsToolResult", async () => {
  const root = makeTempDir("memory-self-talk");
  const memoryStore = createMarkdownMemoryStore(root);
  const sandbox = makeMemorySandbox(root);
  const seen: LLMChatInput[] = [];
  let round = 0;

  const result = await runMemoryInductionForMessages({
    memoryStore,
    promptStore: createMemoryInductionPromptStore(path.join(root, "prompts.json")),
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
  assert.match(result.results[0]?.toolCalls.find((entry) => entry.name === "self_talk")?.output ?? "", /原样\n输出/);
});
