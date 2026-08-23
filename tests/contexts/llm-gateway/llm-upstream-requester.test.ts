import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIUpstreamRequester } from "../../../src/contexts/llm-gateway/src/llm-upstream-requester.js";

test("LLM upstream requests bypass the process proxy by default", async () => {
  let requestInit: (RequestInit & { dispatcher?: unknown }) | undefined;
  const request = createOpenAIUpstreamRequester({
    baseURL: "https://upstream.example/v1",
    apiKey: "test",
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
    apiKey: "test",
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
