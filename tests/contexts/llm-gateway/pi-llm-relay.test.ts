import test from "node:test";
import assert from "node:assert/strict";
import { createPiLLMRelay } from "../../../src/contexts/llm-gateway/src/pi-llm-relay.js";
import type { PiPresetSnapshot } from "../../../src/contexts/llm-gateway/src/pi-preset-adapter.js";

const time = {
  timeZone: "Asia/Tokyo",
  now: () => ({ iso: "2026-08-05T12:00:00.000", date: new Date("2026-08-05T03:00:00.000Z"), epochMs: 1785898800000 })
} as any;
const preset: PiPresetSnapshot = {
  name: "local",
  baseURL: "https://upstream.example/v1",
  apiKey: "upstream-secret",
  model: "model-a",
  temperature: 0.2,
  timeoutMs: 10_000,
  supportsImage: false,
  extraParams: {}
};

test("relay only forwards a bound model with the host-side key", async () => {
  const requests: RequestInit[] = [];
  const usage: any[] = [];
  const relay = createPiLLMRelay({
    time,
    recordTokenUsageEvent: (event) => usage.push(event),
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://upstream.example/v1/chat/completions");
      requests.push(init!);
      assert.equal(new Headers(init!.headers).get("authorization"), "Bearer upstream-secret");
      assert.deepEqual(JSON.parse(String(init!.body)), { model: "model-a", temperature: 0.2, messages: [{ role: "user", content: "hi" }] });
      return new Response(JSON.stringify({ id: "r1", model: "model-a", choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const capability = relay.createCapability({ sandboxId: "sandbox-a", token: "token-a" });
  relay.bindSession({ token: capability.token, sessionId: "session-a", preset });
  const response = await relay.handle(new Request("http://relay/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer token-a", "x-pi-session-id": "session-a" },
    body: JSON.stringify({ model: "model-a", messages: [{ role: "user", content: "hi" }], authorization: "bad" })
  }));
  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].agentId, "pi");
  assert.deepEqual(usage[0].result.usage, { inputTokens: 3, outputTokens: 4, totalTokens: 7, cacheHitTokens: undefined, cacheMissTokens: undefined });
});

test("relay rejects invalid capability, model and missing session without upstream access", async () => {
  let calls = 0;
  const relay = createPiLLMRelay({ time, recordTokenUsageEvent() {}, fetchImpl: async () => { calls += 1; return new Response(); } });
  const capability = relay.createCapability({ sandboxId: "sandbox-a", token: "token-a" });
  relay.bindSession({ token: capability.token, sessionId: "session-a", preset });
  const invalid = await relay.handle(new Request("http://relay/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer wrong", "x-pi-session-id": "session-a" }, body: "{}" }));
  assert.equal(invalid.status, 403);
  const model = await relay.handle(new Request("http://relay/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer token-a", "x-pi-session-id": "session-a" }, body: JSON.stringify({ model: "other", messages: [] }) }));
  assert.equal(model.status, 400);
  assert.equal(calls, 0);
});

test("relay applies the immutable preset sampling values", async () => {
  let body: Record<string, unknown> | undefined;
  const relay = createPiLLMRelay({
    time,
    recordTokenUsageEvent() {},
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const capability = relay.createCapability({ sandboxId: "sandbox-a", token: "token-a" });
  relay.bindSession({ token: capability.token, sessionId: "session-a", preset: { ...preset, temperature: 0.7, extraParams: { top_p: 0.8 } } });
  const response = await relay.handle(new Request("http://relay/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer token-a", "x-pi-session-id": "session-a" },
    body: JSON.stringify({ model: "model-a", temperature: 0.1, top_p: 0.1, messages: [] })
  }));
  assert.equal(response.status, 200);
  assert.equal(body?.temperature, 0.7);
  assert.equal(body?.top_p, 0.8);
});

test("relay preserves SSE and records only the usage-bearing chunk", async () => {
  const usage: any[] = [];
  const relay = createPiLLMRelay({
    time,
    recordTokenUsageEvent: (event) => usage.push(event),
    fetchImpl: async () => new Response("data: {\"id\":\"r2\",\"model\":\"model-a\",\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: {\"id\":\"r2\",\"model\":\"model-a\",\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":6,\"total_tokens\":11},\"choices\":[{\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
  });
  const capability = relay.createCapability({ sandboxId: "sandbox-a", token: "token-a" });
  relay.bindSession({ token: capability.token, sessionId: "session-a", preset });
  const response = await relay.handle(new Request("http://relay/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer token-a", "x-pi-session-id": "session-a" }, body: JSON.stringify({ model: "model-a", messages: [], stream: true }) }));
  assert.equal(await response.text(), "data: {\"id\":\"r2\",\"model\":\"model-a\",\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: {\"id\":\"r2\",\"model\":\"model-a\",\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":6,\"total_tokens\":11},\"choices\":[{\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(usage.length, 1);
  assert.equal(usage[0].result.usage.totalTokens, 11);
});
