import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenAIResponsesRequest, createOpenAIResponsesClient } from "../../../src/contexts/llm-gateway/src/openai-responses-client.js";
import { createApiKeyAuthorization } from "../../../src/contexts/llm-gateway/src/request-authorization.js";

test("Responses request maps messages, images, tools, and tool outputs without chat-only fields", () => {
  const request = buildOpenAIResponsesRequest({
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", type: "function", function: { name: "weather", arguments: "{\"city\":\"Tokyo\"}" } }] },
      { role: "tool", toolCallId: "call-1", content: "sunny" }
    ],
    model: "grok-4",
    temperature: 0.3,
    maxTokens: 100,
    tools: [{ type: "function", function: { name: "weather", description: "Weather", parameters: { type: "object" } } }],
    extraParams: { stream_options: { include_usage: true }, max_tokens: 5 }
  }, { model: "default" });
  assert.equal(request.model, "grok-4");
  assert.equal(request.max_output_tokens, 100);
  assert.equal("messages" in request, false);
  assert.equal("max_tokens" in request, false);
  assert.equal("stream_options" in request, false);
  assert.deepEqual((request.tools as any[])[0], { type: "function", name: "weather", description: "Weather", parameters: { type: "object" } });
  assert.deepEqual((request.input as any[]).at(-1), { type: "function_call_output", call_id: "call-1", output: "sunny" });
});

test("Responses client normalizes text, reasoning, tool calls, and usage", async () => {
  const originalFetch = globalThis.fetch;
  let sent: any;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      id: "resp-1",
      model: "grok-4",
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "thought" }] },
        { type: "message", content: [{ type: "output_text", text: "answer" }] },
        { type: "function_call", call_id: "call-1", name: "weather", arguments: "{}" }
      ],
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = createOpenAIResponsesClient({ baseURL: "https://api.x.ai/v1", authorization: createApiKeyAuthorization("key"), model: "grok-4" });
    const result = await client.chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(sent.input[0].content[0].text, "hi");
    assert.equal(result.message.content, "answer");
    assert.equal(result.message.reasoningContent, "thought");
    assert.equal(result.message.toolCalls?.[0].function.name, "weather");
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14, cacheHitTokens: undefined, cacheMissTokens: undefined });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Responses request rejects unverified audio input", () => {
  assert.throws(() => buildOpenAIResponsesRequest({
    messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "AA==", format: "wav" } }] }]
  }, { model: "grok-4" }), /responses_audio_input_unsupported/);
});

test("Responses stream normalizes text, reasoning, tool deltas, and final usage", async () => {
  const originalFetch = globalThis.fetch;
  const deltas: string[] = [];
  const reasoning: string[] = [];
  const toolDeltas: any[] = [];
  globalThis.fetch = async () => new Response([
    { type: "response.output_text.delta", delta: "hello" },
    { type: "response.reasoning_summary_text.delta", delta: "think" },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "call-1", name: "weather", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: "{\"city\":" },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: "\"Tokyo\"}" },
    { type: "response.completed", response: { id: "resp-stream", model: "grok-4", status: "completed", output: [], usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 } } }
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
  try {
    const client = createOpenAIResponsesClient({ baseURL: "https://api.x.ai/v1", authorization: createApiKeyAuthorization("key"), model: "grok-4" });
    const result = await client.chatStream!({ messages: [{ role: "user", content: "hi" }] }, {
      onContentDelta: (value) => { deltas.push(value); },
      onReasoningDelta: (value) => { reasoning.push(value); },
      onToolCallDelta: (value) => { toolDeltas.push(value); }
    });
    assert.deepEqual(deltas, ["hello"]);
    assert.deepEqual(reasoning, ["think"]);
    assert.equal(toolDeltas.length, 3);
    assert.equal(result.message.content, "hello");
    assert.equal(result.message.reasoningContent, "think");
    assert.deepEqual(result.message.toolCalls?.[0], {
      id: "call-1",
      type: "function",
      function: { name: "weather", arguments: "{\"city\":\"Tokyo\"}" }
    });
    assert.equal(result.finishReason, "tool_calls");
    assert.equal(result.usage?.totalTokens, 13);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
