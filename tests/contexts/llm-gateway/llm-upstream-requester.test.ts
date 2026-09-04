import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOpenAIUpstreamRequester,
  setOpenAICallObserver,
  setOpenAIStreamLoopObserver
} from "../../../src/contexts/llm-gateway/src/llm-upstream-requester.js";
import { createApiKeyAuthorization, type RequestAuthorization } from "../../../src/contexts/llm-gateway/src/request-authorization.js";

test("LLM upstream replays one 401 with refreshed OAuth authorization", async () => {
  const headers: string[] = [];
  let refreshes = 0;
  const authorization: RequestAuthorization = {
    async authorization() { return "Bearer old"; },
    async retryAfterUnauthorized({ rejectedAuthorization }) {
      assert.equal(rejectedAuthorization, "Bearer old");
      refreshes += 1;
      return "Bearer new";
    }
  };
  const request = createOpenAIUpstreamRequester({
    baseURL: "https://api.x.ai/v1",
    authorization,
    useProxy: true,
    fetchImpl: async (_url, init) => {
      headers.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("{}", { status: headers.length === 1 ? 401 : 200 });
    }
  });
  const attempt = await request({ path: "/responses", init: { method: "POST" } });
  assert.equal(attempt.response.status, 200);
  assert.deepEqual(headers, ["Bearer old", "Bearer new"]);
  assert.equal(refreshes, 1);
  attempt.cleanup();
});

test("LLM upstream does not replay API key 401", async () => {
  let calls = 0;
  const request = createOpenAIUpstreamRequester({
    baseURL: "https://upstream.example/v1",
    authorization: createApiKeyAuthorization("key"),
    useProxy: true,
    fetchImpl: async () => { calls += 1; return new Response("unauthorized", { status: 401 }); }
  });
  const attempt = await request({ path: "/chat/completions", init: { method: "POST" } });
  assert.equal(attempt.response.status, 401);
  assert.equal(calls, 1);
  attempt.cleanup();
});

test("LLM upstream completion emits one normalized call event after the response is consumed", async () => {
  const events: any[] = [];
  setOpenAICallObserver((event) => { events.push(event); });
  try {
    const request = createOpenAIUpstreamRequester({
      baseURL: "https://upstream.example/v1",
      fetchImpl: async () => new Response(JSON.stringify({
        id: "response-1",
        model: "resolved-model",
        choices: [{ finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
      }), { status: 200, headers: { "content-type": "application/json" } })
    });

    const attempt = await request({
      path: "/chat/completions",
      init: { method: "POST", body: JSON.stringify({ model: "requested-model", messages: [] }) },
      callContext: { agentId: "any-agent" }
    });
    assert.equal(events.length, 0);
    await attempt.response.text();
    attempt.cleanup();

    assert.deepEqual(events, [{
      baseURL: "https://upstream.example/v1",
      agentId: "any-agent",
      requestedModel: "requested-model",
      responseModel: "resolved-model",
      responseId: "response-1",
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7, cacheHitTokens: undefined, cacheMissTokens: undefined },
      rawUsage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
    }]);
  } finally {
    setOpenAICallObserver(undefined);
  }
});

test("LLM upstream completion emits one call event for an SSE response", async () => {
  const events: any[] = [];
  setOpenAICallObserver((event) => { events.push(event); });
  try {
    const request = createOpenAIUpstreamRequester({
      baseURL: "https://stream.example/v1",
      fetchImpl: async () => new Response([
        'data: {"id":"stream-1","model":"stream-model","choices":[{"delta":{"content":"ok"}}]}',
        'data: {"id":"stream-1","model":"stream-model","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":6,"total_tokens":11}}',
        "data: [DONE]",
        ""
      ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } })
    });

    const attempt = await request({
      path: "/chat/completions",
      init: { method: "POST", body: JSON.stringify({ model: "requested-stream", stream: true }) },
      callContext: { agentId: "stream-agent" }
    });
    await attempt.response.text();
    attempt.cleanup();

    assert.deepEqual(events, [{
      baseURL: "https://stream.example/v1",
      agentId: "stream-agent",
      requestedModel: "requested-stream",
      responseModel: "stream-model",
      responseId: "stream-1",
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11, cacheHitTokens: undefined, cacheMissTokens: undefined },
      rawUsage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }
    }]);
  } finally {
    setOpenAICallObserver(undefined);
  }
});

test("LLM upstream completion still emits a call event when the successful body has no usage payload", async () => {
  const events: any[] = [];
  setOpenAICallObserver((event) => { events.push(event); });
  try {
    const request = createOpenAIUpstreamRequester({
      baseURL: "https://provider-specific.example/v1",
      fetchImpl: async () => new Response("provider-specific-success", { status: 200 })
    });
    const attempt = await request({
      path: "/chat/completions",
      init: { method: "POST", body: JSON.stringify({ model: "requested-model" }) },
      callContext: { agentId: "generic-agent" }
    });
    await attempt.response.text();
    attempt.cleanup();

    assert.deepEqual(events, [{
      baseURL: "https://provider-specific.example/v1",
      agentId: "generic-agent",
      requestedModel: "requested-model"
    }]);
  } finally {
    setOpenAICallObserver(undefined);
  }
});

test("LLM upstream completion normalizes input_tokens and output_tokens usage", async () => {
  const events: any[] = [];
  setOpenAICallObserver((event) => { events.push(event); });
  try {
    const request = createOpenAIUpstreamRequester({
      baseURL: "https://responses-style.example/v1",
      fetchImpl: async () => new Response(JSON.stringify({
        model: "model",
        choices: [],
        usage: { input_tokens: 3, output_tokens: 4, prompt_tokens: 30, completion_tokens: 40 }
      }), { status: 200, headers: { "content-type": "application/json" } })
    });
    const attempt = await request({
      path: "/chat/completions",
      init: { method: "POST", body: JSON.stringify({ model: "model" }) }
    });
    await attempt.response.text();
    attempt.cleanup();

    assert.deepEqual(events[0]?.usage, {
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
      cacheHitTokens: undefined,
      cacheMissTokens: undefined
    });
  } finally {
    setOpenAICallObserver(undefined);
  }
});

test("LLM upstream observation failure does not affect the response or repeat the upstream call", async () => {
  let calls = 0;
  setOpenAICallObserver(() => { throw new Error("usage database unavailable"); });
  try {
    const request = createOpenAIUpstreamRequester({
      baseURL: "https://upstream.example/v1",
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ model: "model", choices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const body = await request({
      path: "/chat/completions",
      init: { method: "POST", body: JSON.stringify({ model: "model" }) },
      consume: (response) => response.text()
    });
    assert.match(body, /model/);
    assert.equal(calls, 1);
  } finally {
    setOpenAICallObserver(undefined);
  }
});

test("LLM upstream requests bypass the process proxy by default", async () => {
  let requestInit: (RequestInit & { dispatcher?: unknown }) | undefined;
  const request = createOpenAIUpstreamRequester({
    baseURL: "https://upstream.example/v1",
    authorization: createApiKeyAuthorization("test"),
    fetchImpl: async (_url, init) => {
      requestInit = init as RequestInit & { dispatcher?: unknown };
      return new Response("{}", { status: 200 });
    }
  });

  const attempt = await request({ path: "/chat/completions", init: { method: "POST" } });
  attempt.cleanup();

  assert.equal((requestInit?.dispatcher as { constructor?: { name?: string } } | undefined)?.constructor?.name, "Agent");
});

test("LLM upstream requests use the process proxy when the preset enables it", async () => {
  let requestInit: (RequestInit & { dispatcher?: unknown }) | undefined;
  const request = createOpenAIUpstreamRequester({
    baseURL: "https://upstream.example/v1",
    authorization: createApiKeyAuthorization("test"),
    useProxy: true,
    fetchImpl: async (_url, init) => {
      requestInit = init as RequestInit & { dispatcher?: unknown };
      return new Response("{}", { status: 200 });
    }
  });

  const attempt = await request({ path: "/chat/completions", init: { method: "POST" } });
  attempt.cleanup();

  assert.equal(requestInit?.dispatcher, undefined);
});

test("LLM upstream retries a 503 before returning an attempt to Pi relay", async () => {
  let calls = 0;
  const request = createOpenAIUpstreamRequester({
    baseURL: "https://upstream.example/v1",
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? new Response("busy", { status: 503 }) : new Response("ok", { status: 200 });
    }
  });

  const attempt = await request({ path: "/chat/completions", init: { method: "POST" } });
  assert.equal(attempt.response.status, 200);
  assert.equal(calls, 2);
  attempt.cleanup();
});

test("LLM upstream cuts a looping consumed SSE response and retries once", async () => {
  let calls = 0;
  const loops: unknown[] = [];
  setOpenAIStreamLoopObserver((event) => { loops.push(event); });
  try {
    const request = createOpenAIUpstreamRequester({
      baseURL: "https://upstream.example/v1",
      useProxy: true,
      fetchImpl: async () => {
        calls += 1;
        const content = calls === 1 ? "我要".repeat(10) : "retry ok";
        return new Response([
          `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
          "data: [DONE]",
          ""
        ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
    });

    const body = await request({
      path: "/chat/completions",
      init: { method: "POST", body: JSON.stringify({ model: "model-a", stream: true }) },
      callContext: { agentId: "chat" },
      consume: (response) => response.text()
    });

    assert.match(body, /retry ok/);
    assert.equal(calls, 2);
    assert.deepEqual(loops, [{
      baseURL: "https://upstream.example/v1",
      agentId: "chat",
      protocol: "openai-chat-completions",
      requestedModel: "model-a",
      phrase: "我要",
      phraseCharacters: 2,
      repetitions: 10
    }]);
  } finally {
    setOpenAIStreamLoopObserver(undefined);
  }
});
