import test from "node:test";
import assert from "node:assert/strict";
import { createPiLLMRelay } from "../../../src/contexts/llm-gateway/src/pi-llm-relay.js";
import type { PiPresetSnapshot } from "../../../src/contexts/llm-gateway/src/pi-preset-adapter.js";
import { setOpenAICallObserver, setOpenAIStreamLoopObserver } from "../../../src/contexts/llm-gateway/src/llm-upstream-requester.js";
import { createApiKeyAuthorization, setActiveCredentialRuntime } from "../../../src/contexts/llm-gateway/src/index.js";

setActiveCredentialRuntime({ resolveAuthorization: () => createApiKeyAuthorization("upstream-secret") } as any);

const time = {
  timeZone: "Asia/Tokyo",
  now: () => ({ iso: "2026-08-05T12:00:00.000", date: new Date("2026-08-05T03:00:00.000Z"), epochMs: 1785898800000 })
} as any;
const preset: PiPresetSnapshot = {
  name: "local",
  protocol: "openai-chat-completions",
  credentialId: "credential-a",
  baseURL: "https://upstream.example/v1",
  model: "model-a",
  temperature: 0.2,
  timeoutMs: 10_000,
  stream: true,
  useProxy: false,
  supportsImage: false,
  extraParams: {}
};

test("relay forwards Pi tools and relies on the shared upstream completion seam", async (t) => {
  const requests: RequestInit[] = [];
  const calls: any[] = [];
  setOpenAICallObserver((event) => { calls.push(event); });
  t.after(() => setOpenAICallObserver(undefined));
  const relay = createPiLLMRelay({
    time,
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://upstream.example/v1/chat/completions");
      requests.push(init!);
      assert.equal(new Headers(init!.headers).get("authorization"), "Bearer upstream-secret");
      assert.deepEqual(JSON.parse(String(init!.body)), {
        model: "model-a",
        stream: true,
        temperature: 0.2,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
        tool_choice: "auto"
      });
      return new Response(JSON.stringify({ id: "r1", model: "resolved-model", choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const capability = relay.createCapability({ sandboxId: "sandbox-a", token: "token-a", preset });
  const response = await relay.handle(new Request("http://relay/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer token-a", "x-pi-session-id": "session-a" },
    body: JSON.stringify({
      model: "pi-selected-model",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
      tool_choice: "auto",
      authorization: "bad",
      metadata: { session_id: "pi-selected-session" },
      stream: false,
      temperature: 1.9,
      max_tokens: 1,
      reasoning_effort: "medium",
      thinking: { type: "disabled" }
    })
  }));
  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
  assert.deepEqual(calls, [{
    baseURL: "https://upstream.example/v1",
    agentId: "pi",
    requestedModel: "model-a",
    responseModel: "resolved-model",
    responseId: "r1",
    finishReason: undefined,
    usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7, cacheHitTokens: undefined, cacheMissTokens: undefined },
    rawUsage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
  }]);
});

test("relay rejects invalid capability but ignores Pi model", async () => {
  let calls = 0;
  const relay = createPiLLMRelay({ time, fetchImpl: async () => { calls += 1; return new Response(); } });
  const capability = relay.createCapability({ sandboxId: "sandbox-a", token: "token-a", preset });
  const invalid = await relay.handle(new Request("http://relay/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" }));
  assert.equal(invalid.status, 403);
  const model = await relay.handle(new Request("http://relay/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer token-a" }, body: JSON.stringify({ model: "other", messages: [] }) }));
  assert.equal(model.status, 200);
  assert.equal(calls, 1);
});

test("relay forwards native Responses requests only through the Responses route", async () => {
  let upstreamBody: Record<string, unknown> | undefined;
  const responsesPreset: PiPresetSnapshot = {
    ...preset,
    protocol: "openai-responses",
    baseURL: "https://api.x.ai/v1",
    model: "grok-4",
    maxTokens: 256,
    extraParams: { reasoning: { effort: "high" } }
  };
  const relay = createPiLLMRelay({
    time,
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.x.ai/v1/responses");
      upstreamBody = JSON.parse(String(init?.body));
      const stream = [
        { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call-1", name: "read", arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" },
        { type: "response.completed", response: { id: "resp-1", model: "grok-4", status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } }
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
  });
  relay.createCapability({ sandboxId: "sandbox-a", token: "token-a", preset: responsesPreset });
  const wrongRoute = await relay.handle(new Request("http://relay/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer token-a" },
    body: "{}"
  }));
  assert.equal(wrongRoute.status, 404);
  const response = await relay.handle(new Request("http://relay/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer token-a" },
    body: JSON.stringify({ model: "ignored", input: [{ role: "user", content: "hi" }], tools: [{ type: "function", name: "read" }], max_output_tokens: 1 })
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(upstreamBody, {
    reasoning: { effort: "high" },
    model: "grok-4",
    input: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", name: "read" }],
    max_output_tokens: 256,
    stream: true,
    temperature: 0.2
  });
  assert.match(await response.text(), /response\.function_call_arguments\.delta/);
});

test("relay applies the immutable preset sampling values", async () => {
  let body: Record<string, unknown> | undefined;
  const relay = createPiLLMRelay({
    time,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  relay.createCapability({ sandboxId: "sandbox-a", token: "token-a", preset: { ...preset, temperature: 0.7, extraParams: { top_p: 0.8 } } });
  const response = await relay.handle(new Request("http://relay/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer token-a" },
    body: JSON.stringify({ model: "model-a", stream: false, temperature: 0.1, top_p: 0.1, reasoning_effort: "medium", messages: [], tools: [] })
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(body, { model: "model-a", top_p: 0.8, stream: true, temperature: 0.7, messages: [], tools: [] });
});

test("relay records a successful call centrally even when upstream omits token counts", async (t) => {
  let authorization: string | null | undefined;
  const calls: any[] = [];
  setOpenAICallObserver((event) => { calls.push(event); });
  t.after(() => setOpenAICallObserver(undefined));
  const relay = createPiLLMRelay({
    time,
    fetchImpl: async (_url, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  relay.createCapability({ sandboxId: "sandbox-a", token: "token-a", preset });
  const response = await relay.handle(new Request("http://relay/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer token-a" },
    body: JSON.stringify({ model: "model-a", messages: [] })
  }));

  assert.equal(response.status, 200);
  assert.equal(authorization, "Bearer upstream-secret");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, "pi");
  assert.equal(calls[0].usage, undefined);
});

test("relay preserves SSE while the shared upstream seam observes its completion", async (t) => {
  const calls: any[] = [];
  setOpenAICallObserver((event) => { calls.push(event); });
  t.after(() => setOpenAICallObserver(undefined));
  const relay = createPiLLMRelay({
    time,
    fetchImpl: async () => new Response("data: {\"id\":\"r2\",\"model\":\"model-a\",\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: {\"id\":\"r2\",\"model\":\"model-a\",\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":6,\"total_tokens\":11},\"choices\":[{\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
  });
  relay.createCapability({ sandboxId: "sandbox-a", token: "token-a", preset });
  const response = await relay.handle(new Request("http://relay/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer token-a" }, body: JSON.stringify({ model: "model-a", messages: [], stream: true }) }));
  assert.equal(await response.text(), "data: {\"id\":\"r2\",\"model\":\"model-a\",\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: {\"id\":\"r2\",\"model\":\"model-a\",\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":6,\"total_tokens\":11},\"choices\":[{\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].usage.totalTokens, 11);
});

test("relay cuts a looping SSE at the shared upstream seam so Pi can retry", async (t) => {
  const loops: any[] = [];
  setOpenAIStreamLoopObserver((event) => { loops.push(event); });
  t.after(() => setOpenAIStreamLoopObserver(undefined));
  const relay = createPiLLMRelay({
    time,
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "我要".repeat(10) } }] })}`,
      "data: [DONE]",
      ""
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } })
  });
  relay.createCapability({ sandboxId: "sandbox-a", token: "token-a", preset });
  const response = await relay.handle(new Request("http://relay/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer token-a" },
    body: JSON.stringify({ model: "model-a", messages: [], stream: true })
  }));

  await assert.rejects(response.text(), /llm_stream_output_loop_detected/);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].agentId, "pi");
  assert.equal(loops[0].protocol, "openai-chat-completions");
  assert.equal(loops[0].phrase, "我要");
});

test("relay converts a non-stream preset JSON response into SSE for Pi", async () => {
  let upstreamBody: Record<string, unknown> | undefined;
  const relay = createPiLLMRelay({
    time,
    fetchImpl: async (_url, init) => {
      upstreamBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: "r-json",
        model: "model-a",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "json answer" },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  relay.createCapability({ sandboxId: "sandbox-a", token: "token-a", preset: { ...preset, stream: false } });
  const response = await relay.handle(new Request("http://relay/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer token-a", accept: "text/event-stream" },
    body: JSON.stringify({ model: "model-a", messages: [], stream: true })
  }));

  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(upstreamBody?.stream, false);
  assert.match(body, /data: \{"id":"r-json"/);
  assert.match(body, /"content":"json answer"/);
  assert.match(body, /"finish_reason":"stop"/);
  assert.match(body, /data: \[DONE\]/);
});

test("relay enforces maxConcurrency before establishing upstream requests", async () => {
  const started: string[] = [];
  let releaseFirst: () => void = () => {};
  const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstCreated = false;
  const relay = createPiLLMRelay({
    time,
    maxConcurrency: 1,
    fetchImpl: async () => {
      if (!firstCreated) {
        firstCreated = true;
        started.push("first");
        await firstDone;
        return new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      started.push("second");
      return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  relay.createCapability({ sandboxId: "sandbox-a", token: "token-a", preset });
  const first = relay.handle(new Request("http://relay/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer token-a" }, body: JSON.stringify({ model: "model-a", messages: [] }) }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await relay.handle(new Request("http://relay/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer token-a" }, body: JSON.stringify({ model: "model-a", messages: [] }) }));
  assert.equal(second.status, 429);
  releaseFirst();
  const firstResponse = await first;
  assert.equal(firstResponse.status, 200);
  const third = await relay.handle(new Request("http://relay/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer token-a" }, body: JSON.stringify({ model: "model-a", messages: [] }) }));
  assert.equal(third.status, 200);
  assert.deepEqual(started, ["first", "second"]);
});

test("relay http server returns 502 for gateway upstream failures instead of hanging", async () => {
  const relay = createPiLLMRelay({
    time,
    host: "127.0.0.1",
    port: 0,
    fetchImpl: async () => {
      throw new Error("upstream network failure");
    }
  });
  relay.createCapability({ sandboxId: "sandbox-a", token: "token-a", preset });
  const { port, close } = await relay.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer token-a", "content-type": "application/json" },
      body: JSON.stringify({ model: "model-a", messages: [] })
    });
    assert.equal(response.status, 502);
    const payload = await response.json() as { error?: { type?: string } };
    assert.equal(payload.error?.type, "pi_relay_upstream_failed");
  } finally {
    await close();
  }
});

test("relay forwards request bodies larger than 4 MiB", async () => {
  let upstreamBody: Record<string, any> | undefined;
  const relay = createPiLLMRelay({
    time,
    host: "127.0.0.1",
    port: 0,
    fetchImpl: async (_url, init) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, any>;
      return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const { token } = relay.createCapability({ sandboxId: "sandbox-a", token: "token-a", preset });
  const { port, close } = await relay.start();
  try {
    const largeContent = "x".repeat(4 * 1024 * 1024);
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "model-a", messages: [{ role: "user", content: largeContent }] })
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamBody?.messages?.[0]?.content, largeContent);
  } finally {
    await close();
  }
});

test("relay upstream timeout stays armed for the whole SSE stream and releases the slot", async () => {
  let aborted = false;
  const relay = createPiLLMRelay({
    time,
    maxConcurrency: 1,
    fetchImpl: async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            controller.error(new DOMException("aborted", "AbortError"));
          });
          controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"));
          // Never closes: a stalled upstream must be killed by the timeout.
        }
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
  });
  relay.createCapability({ sandboxId: "sandbox-a", token: "token-a", preset: { ...preset, timeoutMs: 50 } });
  const first = await relay.handle(new Request("http://relay/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer token-a" },
    body: JSON.stringify({ model: "model-a", messages: [], stream: true })
  }));
  const reader = first.body!.getReader();
  await reader.read();
  const deadline = Date.now() + 5_000;
  while (!aborted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(aborted, true, "stalled SSE upstream was aborted by the relay timeout");
  const second = await relay.handle(new Request("http://relay/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer token-a" },
    body: JSON.stringify({ model: "model-a", messages: [] })
  }));
  assert.equal(second.status, 200);
  await reader.cancel().catch(() => {});
});

test("client cancelling an SSE response aborts the upstream and releases the slot", async () => {
  let aborted = false;
  let upstreamStarted = false;
  const relay = createPiLLMRelay({
    time,
    maxConcurrency: 1,
    fetchImpl: async (_url, init) => {
      upstreamStarted = true;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            controller.error(new DOMException("aborted", "AbortError"));
          });
          controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"));
        }
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
  });
  relay.createCapability({ sandboxId: "sandbox-a", token: "token-a", preset: { ...preset, timeoutMs: 60_000 } });
  const first = await relay.handle(new Request("http://relay/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer token-a" },
    body: JSON.stringify({ model: "model-a", messages: [], stream: true })
  }));
  const reader = first.body!.getReader();
  await reader.read();
  await reader.cancel();
  const deadline = Date.now() + 5_000;
  while (!aborted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(aborted, true, "client cancel aborted the upstream transport");
  assert.equal(upstreamStarted, true);
  const second = await relay.handle(new Request("http://relay/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer token-a" },
    body: JSON.stringify({ model: "model-a", messages: [] })
  }));
  assert.equal(second.status, 200);
  await second.body?.cancel();
});
