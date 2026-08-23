import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";
import {
  buildMemoryPromptPreview,
  createMarkdownMemoryStore,
  createMemoryInductionPromptStore
} from "../../../src/contexts/memory/src/memory.js";
import { buildMemoryErrorMessages } from "../../../src/contexts/memory/src/prompt-build.js";
import { makeTempDir, message } from "./sleep-memory-helpers.js";

test("Memorize prompt uses one Layer for every target", () => {
  const root = makeTempDir("memorize-prompt-layer");
  const filePath = path.join(root, "prompts.json");
  const promptStore = createMemoryInductionPromptStore(filePath);
  const prompts = promptStore.save({
    meta: { owner: "memorize" },
    messages: [
      { meta: { title: "Prompt", enabled: true }, role: "user", content: "${{memorize/messages/content}}" },
      {
        meta: { title: "Tool call", enabled: true },
        role: "assistant",
        content: "",
        reasoningContent: "check",
        toolCalls: [{
          id: "memorize_test_call",
          type: "function",
          function: { name: "Read", arguments: "{\"path\":\"${{memorize/timezone}}\"}" }
        }]
      },
      { meta: { title: "Disabled", enabled: false }, role: "system", content: "hidden" }
    ]
  });
  const deps = {
    memoryStore: createMarkdownMemoryStore(root),
    prompts,
    messages: [message("2026-05-24T01:00:00.000Z", "hello")],
    windowEndAt: "2026-05-24T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    promptContextRuntime: testPromptRuntime()
  };

  const persistent = buildMemoryPromptPreview(deps, "persistent").request.messages;
  const preferences = buildMemoryPromptPreview(deps, "userPreferences").request.messages;
  const previewWithoutMaxTokens = buildMemoryPromptPreview(deps, "persistent");
  const previewWithMaxTokens = buildMemoryPromptPreview({ ...deps, config: { maxTokens: 4096 } }, "persistent");

  assert.equal(preferences.length, persistent.length);
  assert.deepEqual(preferences[0], persistent[0]);
  assert.deepEqual(preferences[1], persistent[1]);
  assert.equal(persistent.length, 3);
  assert.equal(previewWithoutMaxTokens.request.maxTokens, undefined);
  assert.equal(previewWithMaxTokens.request.maxTokens, 4096);
  assert.match(String(persistent[0]?.content), /hello/);
  assert.equal(persistent[1]?.toolCalls?.[0]?.id, "memorize_test_call");
  assert.match(String(persistent[2]?.content), /persistent-memory/);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), prompts);
  assert.equal(fs.readFileSync(filePath, "utf8").includes("persistentLayers"), false);
});

test("Memorize file-limit error keeps the built-in message protocol", () => {
  assert.deepEqual(buildMemoryErrorMessages("full dynamic detail"), [{
    role: "user",
    name: "Cheshire Cat",
    content: "<Error>\nfull dynamic detail\n</Error>"
  }]);
});
