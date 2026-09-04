import test from "node:test";
import assert from "node:assert/strict";
import {
  createLLMStreamLoopDetector,
  guardOpenAIStreamLoop,
  LLMStreamLoopError
} from "../../../src/contexts/llm-gateway/src/llm-stream-loop-guard.js";

test("stream loop detector finds a 1-20 character phrase repeated ten times across deltas", () => {
  const detector = createLLMStreamLoopDetector();
  assert.equal(detector.push("开头我要我要我要"), undefined);
  assert.equal(detector.push("我要我要我要我要我要我要"), undefined);
  assert.deepEqual(detector.push("我要"), {
    phrase: "我要",
    phraseCharacters: 2,
    repetitions: 10
  });
});

test("stream loop detector counts Unicode code points instead of UTF-16 units", () => {
  const detector = createLLMStreamLoopDetector();
  assert.deepEqual(detector.push("🙂好".repeat(10)), {
    phrase: "🙂好",
    phraseCharacters: 2,
    repetitions: 10
  });
});

test("stream loop detector does not match a phrase longer than twenty characters", () => {
  const detector = createLLMStreamLoopDetector();
  const phrase = "abcdefghijklmnopqrstu";
  assert.equal(detector.push(phrase.repeat(10)), undefined);
});

test("raw Responses SSE guard ignores reasoning and cuts repeated visible output", async () => {
  const matches: unknown[] = [];
  const response = guardOpenAIStreamLoop(new Response([
    `data: ${JSON.stringify({ type: "response.reasoning_text.delta", delta: "想".repeat(10) })}`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "答案".repeat(10) })}`,
    ""
  ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }), "openai-responses", (match) => {
    matches.push(match);
  });

  await assert.rejects(response.text(), (error: unknown) => {
    assert.ok(error instanceof LLMStreamLoopError);
    return true;
  });
  assert.deepEqual(matches, [{ phrase: "答案", phraseCharacters: 2, repetitions: 10 }]);
});
