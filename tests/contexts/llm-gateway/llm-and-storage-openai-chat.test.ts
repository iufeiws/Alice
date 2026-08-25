import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenAICompatibleClient } from "../../../src/contexts/llm-gateway/src/index.js";

test("openai-compatible client retries fetch errors once", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "retry ok" }, finish_reason: "stop" }]
    }), { headers: { "content-type": "application/json" } });
  };
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    const result = await client.chat({ messages: [] });
    assert.equal(result.message.content, "retry ok");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible client retries 503 once", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("busy", { status: 503, statusText: "Service Unavailable" });
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "retry ok" }, finish_reason: "stop" }]
    }), { headers: { "content-type": "application/json" } });
  };
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    const result = await client.chat({ messages: [] });
    assert.equal(result.message.content, "retry ok");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible client does not retry 500", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("server error", { status: 500, statusText: "Internal Server Error" });
  };
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    await assert.rejects(() => client.chat({ messages: [] }), /500 Internal Server Error/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible client sends empty reasoning content for tool request messages without reasoning", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" } }]
    }), { status: 200 });
  };
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    await client.chat({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call_missing",
            type: "function",
            function: {
              name: "Chat",
              arguments: "{\"action\":\"poll\"}"
            }
          }]
        }
      ]
    });
    assert.equal(requestBody.messages[0].reasoning_content, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible client preserves reasoning content for tool request messages", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" } }]
    }), { status: 200 });
  };
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    await client.chat({
      messages: [
        {
          role: "assistant",
          content: "",
          reasoningContent: "original thinking",
          toolCalls: [{
            id: "call_original",
            type: "function",
            function: {
              name: "Chat",
              arguments: "{\"action\":\"send\",\"content\":\"x\"}"
            }
          }]
        }
      ]
    });
    assert.equal(requestBody.messages[0].reasoning_content, "original thinking");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible client preserves parenthesized assistant response content when disabled", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "chat_1",
    model: "test",
    choices: [{
      message: {
        role: "assistant",
        content: "喂（电话那头沉默了一会儿，只有细微的呼吸声）我在。"
      },
      finish_reason: "stop"
    }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test",
      messageSanitization: {
        removeParenthesizedAssistantResponseContent: false
      }
    });
    const result = await client.chat({ messages: [] });
    assert.equal(result.message.content, "喂（电话那头沉默了一会儿，只有细微的呼吸声）我在。");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible client removes parenthesized assistant response content when enabled", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "chat_1",
    model: "test",
    choices: [{
      message: {
        role: "assistant",
        content: "喂（电话那头沉默了一会儿，只有细微的呼吸声）我在。"
      },
      finish_reason: "stop"
    }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test",
      messageSanitization: {
        removeParenthesizedAssistantResponseContent: true
      }
    });
    const result = await client.chat({ messages: [] });
    assert.equal(result.message.content, "喂我在。");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible client lets request extra params replace default extra params", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" } }]
    }), { status: 200 });
  };
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test",
      extraParams: {
        cache_prompt: true,
        stream_options: { include_usage: true }
      }
    });
    await client.chat({
      messages: [],
      extraParams: {
        cache_prompt: false
      }
    });
    assert.equal(requestBody.cache_prompt, false);
    assert.equal(requestBody.stream_options, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible client preserves preset max_tokens extra param when request omits maxTokens", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" } }]
    }), { status: 200 });
  };
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test",
      extraParams: {
        max_tokens: 123
      }
    });
    await client.chat({ messages: [] });
    assert.equal(requestBody.max_tokens, 123);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible client preserves non-stream reasoning content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "chat_1",
    model: "test",
    choices: [{
      message: {
        role: "assistant",
        content: "answer",
        reasoning_content: "private reasoning"
      },
      finish_reason: "stop"
    }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    const result = await client.chat({ messages: [] });
    assert.equal(result.message.content, "answer");
    assert.equal(result.message.reasoningContent, "private reasoning");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible client preserves token usage cache hit stats", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "chat_1",
    model: "test",
    choices: [{
      message: {
        role: "assistant",
        content: "answer"
      },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      prompt_cache_hit_tokens: 5,
      prompt_cache_miss_tokens: 6
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    const result = await client.chat({ messages: [] });
    assert.equal(result.usage?.cacheHitTokens, 5);
    assert.equal(result.usage?.cacheMissTokens, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible client reads OpenAI-style cached token details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "chat_1",
    model: "test",
    choices: [{
      message: {
        role: "assistant",
        content: "answer"
      },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 3,
      total_tokens: 23,
      prompt_tokens_details: {
        cached_tokens: 12
      }
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    const result = await client.chat({ messages: [] });
    assert.equal(result.usage?.cacheHitTokens, 12);
    assert.equal(result.usage?.cacheMissTokens, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
