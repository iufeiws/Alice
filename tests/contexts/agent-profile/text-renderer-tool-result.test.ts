import { test } from "node:test";
import assert from "node:assert/strict";
import { formatToolResultForLLM } from "../../../src/contexts/agent-profile/src/application/llm-text-renderer.js";

test("formatToolResultForLLM renders placeholders in string tool output", () => {
  assert.equal(formatToolResultForLLM({
    ok: true,
    output: "story for {{user}}"
  }, { user: "YY" }), "story for YY");
});

test("formatToolResultForLLM renders nested object output as valid JSON", () => {
  const rendered = formatToolResultForLLM({
    ok: true,
    output: {
      text: "{{user}}",
      nested: ["{{outfit/content}}"]
    }
  }, {
    user: 'A"B',
    outfit: { content: "dress" }
  });

  assert.deepEqual(JSON.parse(rendered), { text: 'A"B', nested: ["dress"] });
});
