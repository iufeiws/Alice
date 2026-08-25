import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenAICompatibleClient } from "../../../src/contexts/llm-gateway/src/index.js";

test("openai stream client processes a final SSE frame without trailing newline", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        [
          'data: {"id":"chat_1","model":"test","choices":[{"delta":{"reasoning_content":"think "}}]}',
          'data: {"id":"chat_1","model":"test","choices":[{"delta":{"reasoning_content":"more"}}]}',
          'data: {"id":"chat_1","model":"test","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Chat","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}'
        ].join("\n\n")
      ));
      controller.close();
    }
  });
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(stream, { status: 200 });
  };
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    const result = await client.chatStream?.({
      messages: [{ role: "assistant", content: "", reasoningContent: "prior thinking" }],
      tools: [{
        type: "function",
        function: {
          name: "Chat",
          parameters: { type: "object" }
        }
      }]
    });
    assert.equal(result?.message.toolCalls?.[0].function.name, "Chat");
    assert.equal(result?.message.toolCalls?.[0].function.arguments, "{}");
    assert.equal(result?.message.reasoningContent, "think more");
    assert.equal(requestBody.messages[0].reasoning_content, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai stream client cancels failed streams on parse failure", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {not json}\n\n"));
    },
    cancel() {
      cancelled = true;
    }
  });
  globalThis.fetch = async () => new Response(stream, { status: 200 });
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    assert.ok(client.chatStream);
    await assert.rejects(() => client.chatStream!({ messages: [] }));
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai stream client cancels when reader.read throws", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => ({
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            throw new Error("read failed");
          },
          async cancel() {
            cancelled = true;
          }
        };
      }
    }
  }) as unknown as Response;
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    assert.ok(client.chatStream);
    await assert.rejects(() => client.chatStream!({ messages: [] }), /read failed/);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai stream client aborts requests at timeout", async () => {
  const originalFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new DOMException("aborted", "AbortError"));
    });
  });
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test",
      timeoutMs: 1
    });
    assert.ok(client.chatStream);
    await assert.rejects(() => client.chatStream!({ messages: [] }), /aborted|AbortError/);
    assert.equal(aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai stream client preserves parenthesized response content across chunks when disabled", async () => {
  const originalFetch = globalThis.fetch;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        [
          'data: {"id":"chat_1","model":"test","choices":[{"delta":{"action":"send","content":"喂（电话那头"}}]}',
          'data: {"id":"chat_1","model":"test","choices":[{"delta":{"action":"send","content":"沉默了一会儿，只有细微的呼吸声）我在。"}}]}',
          "data: [DONE]"
        ].join("\n\n")
      ));
      controller.close();
    }
  });
  globalThis.fetch = async () => new Response(stream, { status: 200 });
  const deltas: string[] = [];
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test",
      messageSanitization: {
        removeParenthesizedAssistantResponseContent: false
      }
    });
    const result = await client.chatStream?.({ messages: [] }, {
      onContentDelta(content) {
        deltas.push(content);
      }
    });
    assert.deepEqual(deltas, ["喂（电话那头", "沉默了一会儿，只有细微的呼吸声）我在。"]);
    assert.equal(result?.message.content, "喂（电话那头沉默了一会儿，只有细微的呼吸声）我在。");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai stream client removes parenthesized response content across chunks when enabled", async () => {
  const originalFetch = globalThis.fetch;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        [
          'data: {"id":"chat_1","model":"test","choices":[{"delta":{"action":"send","content":"喂（电话那头"}}]}',
          'data: {"id":"chat_1","model":"test","choices":[{"delta":{"action":"send","content":"沉默了一会儿，只有细微的呼吸声）我在。"}}]}',
          "data: [DONE]"
        ].join("\n\n")
      ));
      controller.close();
    }
  });
  globalThis.fetch = async () => new Response(stream, { status: 200 });
  const deltas: string[] = [];
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test",
      messageSanitization: {
        removeParenthesizedAssistantResponseContent: true
      }
    });
    const result = await client.chatStream?.({ messages: [] }, {
      onContentDelta(content) {
        deltas.push(content);
      }
    });
    assert.deepEqual(deltas, ["喂", "我在。"]);
    assert.equal(result?.message.content, "喂我在。");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai stream client preserves include_usage final usage chunk", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        [
          'data: {"id":"chat_1","model":"test","choices":[{"delta":{"action":"send","content":"answer"}}],"usage":null}',
          'data: {"id":"chat_1","model":"test","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14,"prompt_cache_hit_tokens":6,"prompt_cache_miss_tokens":4}}',
          "data: [DONE]"
        ].join("\n\n")
      ));
      controller.close();
    }
  });
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(stream, { status: 200 });
  };
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test",
      extraParams: {
        stream_options: {
          include_usage: true
        }
      }
    });
    const result = await client.chatStream?.({ messages: [] });
    assert.equal(requestBody.stream, true);
    assert.deepEqual(requestBody.stream_options, { include_usage: true });
    assert.equal(result?.message.content, "answer");
    assert.deepEqual(result?.usage, {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cacheHitTokens: 6,
      cacheMissTokens: 4
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
