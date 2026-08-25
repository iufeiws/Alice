import test from "node:test";
import assert from "node:assert/strict";
import { createPiWorkerHttpClient } from "../../../src/contexts/pi-worker/src/pi-worker-client.js";

function failedFetch(): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ error: "worker_failed" }), { status: 500 }));
}

test("Pi file tool requests expose a file tool error", async () => {
  const client = createPiWorkerHttpClient({ baseURL: "http://worker.test", fetchImpl: failedFetch as typeof fetch });
  await assert.rejects(
    client.executeTool({ requestId: "read-1", toolName: "read", input: {} }),
    /file_tool_request_failed:500:/
  );
});

test("Pi shell tool requests expose a shell tool error", async () => {
  const client = createPiWorkerHttpClient({ baseURL: "http://worker.test", fetchImpl: failedFetch as typeof fetch });
  await assert.rejects(
    client.executeTool({ requestId: "bash-1", toolName: "bash", input: {} }),
    /shell_tool_request_failed:500:/
  );
});

test("Pi worker config updates use the authenticated runtime config endpoint", async () => {
  let request: { url: string; method?: string; body?: string } | undefined;
  const client = createPiWorkerHttpClient({
    baseURL: "http://worker.test",
    fetchImpl: async (input, init) => {
      request = { url: String(input), method: init?.method, body: String(init?.body) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });

  await client.configure({
    relayUrl: "http://host.docker.internal:3411/v1",
    relayToken: "runtime-token"
  });

  assert.deepEqual(request, {
    url: "http://worker.test/config",
    method: "POST",
    body: JSON.stringify({ relayUrl: "http://host.docker.internal:3411/v1", relayToken: "runtime-token" })
  });
});

test("Pi worker result requests use the nickname route", async () => {
  let request: { url: string; method?: string; body?: string } | undefined;
  const client = createPiWorkerHttpClient({
    baseURL: "http://worker.test",
    fetchImpl: async (input, init) => {
      request = { url: String(input), method: init?.method, body: init?.body === undefined ? undefined : String(init.body) };
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    }
  });

  assert.deepEqual(await client.resultSession("pikachu"), { status: "running" });
  assert.deepEqual(request, {
    url: "http://worker.test/sessions/pikachu/result",
    method: "GET",
    body: undefined
  });
});

test("Pi worker watcher requests use the internal session-id route", async () => {
  let request: { url: string; method?: string; body?: string } | undefined;
  const client = createPiWorkerHttpClient({
    baseURL: "http://worker.test",
    fetchImpl: async (input, init) => {
      request = { url: String(input), method: init?.method, body: init?.body === undefined ? undefined : String(init.body) };
      return new Response(JSON.stringify({ sessionId: "session/1", idle: true }), { status: 200 });
    }
  });

  assert.deepEqual(await client.sessionStatusBySessionId("session/1"), { sessionId: "session/1", idle: true });
  assert.deepEqual(request, {
    url: "http://worker.test/sessions-by-id/session%2F1/snapshot",
    method: "GET",
    body: undefined
  });
});
